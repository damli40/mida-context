// BatchAnchor Task 5: the queued-save side of the batching lane. The row carries the whole signed
// save — message, signature, manifest and ciphertext (Amendment A.4: batched ciphertext never enters
// `objects`, so the objects sweep can never reclaim bytes a future batch still needs). The batcher
// (Task 6, injected through the routes) drives the state machine; nothing here decides validity —
// acceptance is the contract's job and is only ever reported back through markAnchored/markRejected.
//
// FsBatchStore is the Node implementation: one JSON file per row under `dataDir/batch/`, a `meta.json`
// beside them for the receipt sequence and the per-signer flush timestamps. Mutations run behind an
// in-process promise chain so `takeQueued`'s read-then-write cannot interleave with another mutation —
// two runs can never hand the same row to two batches. D1 does the same atomically in SQL instead
// (UPDATE ... RETURNING, see apps/store-worker/src/d1.ts).

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Address, Hex } from "@mida/protocol"
import { MidaError } from "@mida/protocol"
import type { BatchedItemState, BatchedReadItem, BatchedSaveWire } from "./client.js"
import { writeJsonAtomic } from "./secure-fs.js"

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

/**
 * QUEUED → SUBMITTED → ANCHORED | REJECTED, plus HELD — the in-3 state for a save whose author is
 * on the store's active deny list. A held row is off the send path (`takeQueued` never returns it)
 * but not dead: every batcher tick re-checks it — deny still active → stays HELD; the revoke
 * landed → REJECTED; the deny cleared and the grant still valid → back to QUEUED and sent.
 */
export type BatchSaveState = "QUEUED" | "SUBMITTED" | "ANCHORED" | "REJECTED" | "HELD"

export interface BatchSaveRow {
  contextId: Hex
  owner: Address
  namespaceId: Hex
  /** Request signer that submitted the save — may GET the row without a READ grant. */
  signer: Address
  /** The full signed save (message, signature, manifest, ciphertext hex). */
  save: BatchedSaveWire
  state: BatchSaveState
  /** Rejection reason name for REJECTED rows (BATCH_REJECT keys from the contract). */
  reason: string | null
  batchId: Hex | null
  position: number | null
  lineageId: Hex | null
  version: number | null
  proof: Hex[] | null
  /** ms since epoch when the save was accepted into the queue. */
  receivedAt: number
  /** ms since epoch when the anchor confirmed, null until then. */
  anchoredAt: number | null
}

export interface BatchStore {
  /** Returns "exists" when a row with this contextId is already stored — any state. */
  insert(row: BatchSaveRow): Promise<"inserted" | "exists">
  get(contextId: Hex): Promise<BatchSaveRow | null>
  /** QUEUED + SUBMITTED + ANCHORED + HELD for one owner/namespace, oldest first. REJECTED never lists. */
  listForReader(owner: Address, namespaceId: Hex): Promise<BatchSaveRow[]>
  /** Atomically moves up to `limit` QUEUED rows to SUBMITTED under `batchId`, oldest first. */
  takeQueued(limit: number, batchId: Hex): Promise<BatchSaveRow[]>
  markAnchored(
    contextId: Hex,
    fields: { batchId: Hex; position: number; lineageId: Hex; version: number; proof: Hex[]; anchoredAt: number },
  ): Promise<void>
  markRejected(contextId: Hex, reason: string): Promise<void>
  /** SUBMITTED rows of `batchId` go back to QUEUED (a failed submission retried whole). */
  requeue(batchId: Hex): Promise<number>
  /**
   * One SUBMITTED row goes back to QUEUED, its batch tag cleared — a row the take could not
   * check or could not hold retries on a later take instead of dying with its batch (in-11 R-2/R-9).
   */
  requeueRow(contextId: Hex): Promise<void>
  /** Every HELD row, oldest first — the batcher's per-tick deny re-check set. */
  listHeld(): Promise<BatchSaveRow[]>
  /** A QUEUED or SUBMITTED row goes HELD; the batch tag clears so a requeue-by-batch never revives it. */
  hold(contextId: Hex): Promise<void>
  /** A HELD row returns to QUEUED — the deny cleared and Monad still authorizes the save. */
  releaseHeld(contextId: Hex): Promise<void>
  /** Monotonic receipt sequence — counts every accepted save, never reused. */
  nextSequence(): Promise<bigint>
  countQueued(): Promise<number>
  /** ms since epoch of the signer's last accepted flush, or null. */
  lastFlush(signer: Address): Promise<number | null>
  setLastFlush(signer: Address, atMs: number): Promise<void>
}

/** The wire-facing read shape of a row — anchor fields only on ANCHORED rows. */
export function batchReadItem(row: BatchSaveRow): BatchedReadItem {
  if (row.state === "REJECTED") {
    // A rejected row is a status answer ({ state, reason }), never a readable save — surfacing it as
    // an item would let a dead save leak into a reader's context as if it were live.
    throw new MidaError("INVALID_WIRE", "rejected batch rows are never served as read items")
  }
  const item: BatchedReadItem = {
    state: row.state as BatchedItemState,
    save: row.save,
    contextId: row.contextId,
    receivedAt: row.receivedAt,
  }
  if (row.state === "ANCHORED") {
    item.batchId = row.batchId ?? undefined
    item.position = row.position ?? undefined
    item.lineageId = row.lineageId ?? undefined
    item.version = row.version ?? undefined
    item.proof = row.proof ?? undefined
  }
  return item
}

interface BatchMeta {
  sequence: string
  flush: Record<string, number>
}

function normalizeRow(row: BatchSaveRow): BatchSaveRow {
  return {
    ...row,
    contextId: row.contextId.toLowerCase() as Hex,
    owner: row.owner.toLowerCase() as Address,
    namespaceId: row.namespaceId.toLowerCase() as Hex,
    signer: row.signer.toLowerCase() as Address,
    reason: row.reason ?? null,
    batchId: row.batchId == null ? null : (row.batchId.toLowerCase() as Hex),
    position: row.position ?? null,
    lineageId: row.lineageId == null ? null : (row.lineageId.toLowerCase() as Hex),
    version: row.version ?? null,
    proof: row.proof ?? null,
    anchoredAt: row.anchoredAt ?? null,
  }
}

function byAge(a: BatchSaveRow, b: BatchSaveRow): number {
  return a.receivedAt - b.receivedAt || a.contextId.localeCompare(b.contextId)
}

export class FsBatchStore implements BatchStore {
  readonly #dir: string
  #tail: Promise<unknown> = Promise.resolve()

  /** Rows live at `dataDir/batch/<contextId>.json`; sequence and flush marks in `dataDir/batch/meta.json`. */
  constructor(dataDir: string) {
    this.#dir = join(dataDir, "batch")
  }

  /** Serializes mutations: read-modify-write sequences stay indivisible inside one process. */
  #mutate<T>(fn: () => T): Promise<T> {
    const run = this.#tail.then(fn)
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #rowPath(contextId: Hex): string {
    return join(this.#dir, `${contextId.toLowerCase()}.json`)
  }

  #metaPath(): string {
    return join(this.#dir, "meta.json")
  }

  #readRow(contextId: Hex): BatchSaveRow | undefined {
    const row = readJson<BatchSaveRow>(this.#rowPath(contextId))
    return row === undefined ? undefined : normalizeRow(row)
  }

  #writeRow(row: BatchSaveRow): void {
    writeJsonAtomic(this.#dir, this.#rowPath(row.contextId), row)
  }

  #rows(): BatchSaveRow[] {
    let names: string[]
    try {
      names = readdirSync(this.#dir)
    } catch {
      return []
    }
    const rows: BatchSaveRow[] = []
    for (const name of names) {
      if (!name.endsWith(".json") || name === "meta.json") continue
      const row = readJson<BatchSaveRow>(join(this.#dir, name))
      if (row !== undefined) rows.push(normalizeRow(row))
    }
    return rows
  }

  #meta(): BatchMeta {
    const meta = readJson<BatchMeta>(this.#metaPath())
    return { sequence: meta?.sequence ?? "0", flush: meta?.flush ?? {} }
  }

  #writeMeta(meta: BatchMeta): void {
    writeJsonAtomic(this.#dir, this.#metaPath(), meta)
  }

  insert(row: BatchSaveRow): Promise<"inserted" | "exists"> {
    return this.#mutate(() => {
      if (existsSync(this.#rowPath(row.contextId))) return "exists"
      this.#writeRow(normalizeRow(row))
      return "inserted"
    })
  }

  get(contextId: Hex): Promise<BatchSaveRow | null> {
    return Promise.resolve(this.#readRow(contextId) ?? null)
  }

  listForReader(owner: Address, namespaceId: Hex): Promise<BatchSaveRow[]> {
    const wantedOwner = owner.toLowerCase()
    const wantedNamespace = namespaceId.toLowerCase()
    return Promise.resolve(
      this.#rows()
        .filter((row) => row.state !== "REJECTED" && row.owner === wantedOwner && row.namespaceId === wantedNamespace)
        .sort(byAge),
    )
  }

  takeQueued(limit: number, batchId: Hex): Promise<BatchSaveRow[]> {
    return this.#mutate(() => {
      const taken = this.#rows()
        .filter((row) => row.state === "QUEUED")
        .sort(byAge)
        .slice(0, limit)
      for (const row of taken) {
        row.state = "SUBMITTED"
        row.batchId = batchId.toLowerCase() as Hex
        this.#writeRow(row)
      }
      return taken
    })
  }

  markAnchored(
    contextId: Hex,
    fields: { batchId: Hex; position: number; lineageId: Hex; version: number; proof: Hex[]; anchoredAt: number },
  ): Promise<void> {
    return this.#mutate(() => {
      const row = this.#readRow(contextId)
      if (row === undefined || row.state === "ANCHORED") return
      row.state = "ANCHORED"
      row.batchId = fields.batchId.toLowerCase() as Hex
      row.position = fields.position
      row.lineageId = fields.lineageId.toLowerCase() as Hex
      row.version = fields.version
      row.proof = fields.proof
      row.anchoredAt = fields.anchoredAt
      this.#writeRow(row)
    })
  }

  markRejected(contextId: Hex, reason: string): Promise<void> {
    return this.#mutate(() => {
      const row = this.#readRow(contextId)
      if (row === undefined || row.state === "ANCHORED") return
      row.state = "REJECTED"
      row.reason = reason
      this.#writeRow(row)
    })
  }

  requeue(batchId: Hex): Promise<number> {
    return this.#mutate(() => {
      let count = 0
      for (const row of this.#rows()) {
        if (row.state === "SUBMITTED" && row.batchId === batchId.toLowerCase()) {
          row.state = "QUEUED"
          row.batchId = null
          this.#writeRow(row)
          count++
        }
      }
      return count
    })
  }

  requeueRow(contextId: Hex): Promise<void> {
    return this.#mutate(() => {
      const row = this.#readRow(contextId)
      if (row === undefined || row.state !== "SUBMITTED") return
      row.state = "QUEUED"
      row.batchId = null
      this.#writeRow(row)
    })
  }

  listHeld(): Promise<BatchSaveRow[]> {
    return Promise.resolve(
      this.#rows()
        .filter((row) => row.state === "HELD")
        .sort(byAge),
    )
  }

  hold(contextId: Hex): Promise<void> {
    return this.#mutate(() => {
      const row = this.#readRow(contextId)
      if (row === undefined || row.state === "ANCHORED" || row.state === "REJECTED") return
      row.state = "HELD"
      row.batchId = null
      this.#writeRow(row)
    })
  }

  releaseHeld(contextId: Hex): Promise<void> {
    return this.#mutate(() => {
      const row = this.#readRow(contextId)
      if (row === undefined || row.state !== "HELD") return
      row.state = "QUEUED"
      this.#writeRow(row)
    })
  }

  nextSequence(): Promise<bigint> {
    return this.#mutate(() => {
      const meta = this.#meta()
      const sequence = BigInt(meta.sequence) + 1n
      meta.sequence = sequence.toString(10)
      this.#writeMeta(meta)
      return sequence
    })
  }

  countQueued(): Promise<number> {
    return Promise.resolve(this.#rows().filter((row) => row.state === "QUEUED").length)
  }

  lastFlush(signer: Address): Promise<number | null> {
    return Promise.resolve(this.#meta().flush[signer.toLowerCase()] ?? null)
  }

  setLastFlush(signer: Address, atMs: number): Promise<void> {
    return this.#mutate(() => {
      const meta = this.#meta()
      meta.flush[signer.toLowerCase()] = atMs
      this.#writeMeta(meta)
    })
  }
}
