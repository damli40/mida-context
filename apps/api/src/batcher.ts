// BatchAnchor Task 6: the batcher — the process that turns QUEUED rows into one submitBatch call.
// The contract is the only decider of validity; this module's job is narrower and more fragile than
// it looks: pick the oldest saves, send them once, then write back exactly what the chain reported —
// proofs only when the rebuilt Merkle root equals the on-chain batch root, rejections with the
// contract's reason names, and nothing at all when it cannot prove either.
//
// Three rules carry the design:
// - The wait timer is a promise to a queued save, not a suggestion: once set it is never moved.
// - A submission is journaled BEFORE it goes out (`journal.record` ahead of `chain.submit`), so a
//   crash between the two leaves a findable batchId and a recoverable row set — `recover()` on
//   startup replays every journaled batch against `batchOf` instead of trusting local memory.
// - `SaveRejected.index` is the index into the submitted array, so the ordered contextIds the
//   journal recorded are the only trustworthy map from an index back to a row.
//
// minGapMs is a second guard on top of the timer: no matter how often flush()/notify() fire, two
// submissions never go out less than minGapMs apart — a flush inside the gap schedules the run for
// lastSubmitAt + minGapMs instead of running it.

import { existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { bytesToHex, encodeAbiParameters, keccak256, zeroHash } from "viem"
import type { AbiEvent, LocalAccount } from "viem"
import { BATCH_REJECT, MidaError, batchLeafHash, batchSaveStructHash, decodeUint64, isMidaError, merkleProof, merkleRoot } from "@mida/protocol"
import type { Address, BatchSaveMessage, Hex } from "@mida/protocol"
import { batchAnchorAbi, createWriteContext, getLogsChunked, revertName, sendContract } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import type { BatchedSaveWire } from "./client.js"
import type { BatchSaveRow, BatchStore } from "./batch-store.js"
import { writeJsonAtomic } from "./secure-fs.js"

/** The batcher's view of time: whoever hosts it supplies the real clock source (setTimeout, a DO alarm). */
export interface BatcherTimer {
  set(atMs: number): Promise<void> | void
  clear(): Promise<void> | void
  pending(): Promise<boolean> | boolean
}

/** One SaveAnchored log the chain recorded for a batch — `position` is its slot in the accepted array. */
export interface AnchoredLog {
  contextId: Hex
  agentId: Hex
  position: number
  lineageId: Hex
  version: number
  leafHash: Hex
}

/** One SaveRejected log — `index` is the save's position in the submitted array, not the leaf array. */
export interface RejectedLog {
  index: number
  reason: number
}

/** Everything the batcher needs from Monad, and nothing more — fakes implement this in tests. */
export interface BatcherChain {
  /** Sends submitBatch; { exists: true } means the contract already holds this batchId (BatchExists). */
  submit(batchId: Hex, saves: BatchedSaveWire[]): Promise<{ transactionHash: Hex } | { exists: true }>
  anchoredLogs(batchId: Hex): Promise<AnchoredLog[]>
  rejectedLogs(batchId: Hex): Promise<RejectedLog[]>
  /** The BatchAnchored event for this batchId — who submitted it and how it split; null if none. */
  batchAnchored(batchId: Hex): Promise<{ submitter: Address; acceptedCount: number; rejectedCount: number } | null>
  batchOf(batchId: Hex): Promise<{ root: Hex; blockNumber: bigint; acceptedCount: number }>
  /** The batchId that anchored this contextId before, or null — used for ALREADY_ANCHORED rejects. */
  findAnchoring(contextId: Hex): Promise<Hex | null>
}

/**
 * The crash-recovery journal: which batchIds are in flight and, for each, the ordered contextIds of
 * the submitted array (the only map from SaveRejected.index back to a row). `record` is called with
 * an empty list BEFORE the rows are even taken, then again with the real list BEFORE submit — a
 * process that dies in either gap still leaves a discoverable batchId for `recover()` to requeue.
 */
export interface BatchJournal {
  /** Every recorded batchId not yet cleared. */
  list(): Promise<Hex[]>
  record(batchId: Hex, contextIds: Hex[]): Promise<void>
  contextIds(batchId: Hex): Promise<Hex[] | null>
  clear(batchId: Hex): Promise<void>
}

/** Journal for tests and embedded use — process memory only, so it cannot recover a real restart. */
export class MemoryBatchJournal implements BatchJournal {
  readonly batches = new Map<string, Hex[]>()
  async list(): Promise<Hex[]> {
    return [...this.batches.keys()] as Hex[]
  }
  async record(batchId: Hex, contextIds: Hex[]): Promise<void> {
    this.batches.set(batchId.toLowerCase(), [...contextIds])
  }
  async contextIds(batchId: Hex): Promise<Hex[] | null> {
    return this.batches.get(batchId.toLowerCase())?.slice() ?? null
  }
  async clear(batchId: Hex): Promise<void> {
    this.batches.delete(batchId.toLowerCase())
  }
}

/**
 * Journal for the Node side: one JSON file beside the batch store's directory (never inside it —
 * FsBatchStore reads every *.json under dataDir/batch/ as a row). Mutations serialize behind the same
 * in-process promise chain the store uses.
 */
export class FsBatchJournal implements BatchJournal {
  readonly #path: string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  #read(): Record<string, Hex[]> {
    if (!existsSync(this.#path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as { batches?: Record<string, Hex[]> }
      return parsed.batches ?? {}
    } catch {
      return {}
    }
  }

  #mutate<T>(fn: (batches: Record<string, Hex[]>) => T): Promise<T> {
    const run = this.#tail.then(() => {
      const batches = this.#read()
      const result = fn(batches)
      writeJsonAtomic(dirname(this.#path), this.#path, { batches })
      return result
    })
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async list(): Promise<Hex[]> {
    return Object.keys(this.#read()) as Hex[]
  }

  record(batchId: Hex, contextIds: Hex[]): Promise<void> {
    return this.#mutate((batches) => {
      batches[batchId.toLowerCase()] = [...contextIds]
    })
  }

  async contextIds(batchId: Hex): Promise<Hex[] | null> {
    return this.#read()[batchId.toLowerCase()]?.slice() ?? null
  }

  clear(batchId: Hex): Promise<void> {
    return this.#mutate((batches) => {
      delete batches[batchId.toLowerCase()]
    })
  }
}

/**
 * The Node timer: `set` replaces the pending wakeup (the batcher itself only ever asks for one at a
 * time, or for the later gap-end instant); `unref` keeps a pending batch from holding the process open.
 */
export function createNodeTimer(fire: () => void): BatcherTimer {
  let handle: ReturnType<typeof setTimeout> | undefined
  return {
    set(atMs) {
      if (handle !== undefined) clearTimeout(handle)
      handle = setTimeout(() => {
        handle = undefined
        fire()
      }, Math.max(0, atMs - Date.now()))
      ;(handle as { unref?: () => void }).unref?.()
    },
    clear() {
      if (handle !== undefined) clearTimeout(handle)
      handle = undefined
    },
    pending: () => handle !== undefined,
  }
}

const REJECT_NAMES = new Map<number, string>(Object.entries(BATCH_REJECT).map(([name, code]) => [code, name]))

const rejectName = (reason: number): string => REJECT_NAMES.get(reason) ?? `UNKNOWN_${reason}`

/** Thrown when the logs a chain adapter returns cannot be the batch the contract recorded. */
export class BatchRootMismatchError extends Error {
  readonly code = "ROOT_MISMATCH" as const
  constructor(batchId: Hex, expected: Hex, rebuilt: Hex) {
    super(`ROOT_MISMATCH: rebuilt root ${rebuilt} for batch ${batchId} does not equal the on-chain root ${expected}`)
    this.name = "BatchRootMismatchError"
  }
}

export interface BatcherOptions {
  store: BatchStore
  chain: BatcherChain
  timer: BatcherTimer
  now: () => number
  cap: number
  waitMs: number
  /**
   * The batch submitter — one ingredient of the batchId and the identity resolve() proves a landed
   * batch belongs to: submitBatch has no caller check, so an id is never trusted on its own.
   */
  submitter: Address
  /**
   * The 32 random bytes inside each batchId — keccak(submitter, sequence, salt). The salt is what
   * makes the next id unpredictable: a derivable id can be pre-claimed by a foreign submitBatch,
   * which would hand that batcher's rows a stranger's outcomes. The journal records the id before
   * the submit goes out, so recover() never needs to recompute it. Injectable for tests that must
   * predict (or replay) an id; default is crypto.getRandomValues — present in Workers and Node.
   */
  salt?: () => Hex
  log?: (record: Record<string, unknown>) => void
  /** Minimum milliseconds between two real submissions; default 1000. */
  minGapMs?: number
  /**
   * Persistent record of in-flight batches — the only way `recover()` can find a batch a dead
   * process submitted. Without one, recovery sees only this process's own submissions.
   */
  journal?: BatchJournal
}

export class Batcher {
  readonly #store: BatchStore
  readonly #chain: BatcherChain
  readonly #timer: BatcherTimer
  readonly #journal: BatchJournal | undefined
  readonly #now: () => number
  readonly #cap: number
  readonly #waitMs: number
  readonly #minGapMs: number
  readonly #submitter: Address
  readonly #salt: () => Hex
  readonly #log: ((record: Record<string, unknown>) => void) | undefined
  /** Ordered contextIds of batches this process submitted — the resolve mapping without a journal read. */
  readonly #submitted = new Map<string, Hex[]>()
  /**
   * The take size the next run uses. A GAS_CEILING_EXCEEDED refusal halves it (floor 1) — the batch
   * was too big to send, not malformed — and a successful submit restores the configured cap.
   */
  #effectiveCap: number
  #lastSubmitAt: number | null = null
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: BatcherOptions) {
    this.#store = options.store
    this.#chain = options.chain
    this.#timer = options.timer
    this.#journal = options.journal
    this.#now = options.now
    this.#cap = options.cap
    this.#waitMs = options.waitMs
    this.#minGapMs = options.minGapMs ?? 1000
    this.#submitter = options.submitter.toLowerCase() as Address
    this.#salt = options.salt ?? (() => bytesToHex(crypto.getRandomValues(new Uint8Array(32))))
    this.#effectiveCap = options.cap
    this.#log = options.log
  }

  /**
   * One new save arrived. At cap the batch goes now; below it the first save arms the wait window
   * and every later save in the window leaves the armed timer exactly where it is.
   */
  notify(): Promise<void> {
    return this.#serialize(async () => {
      if ((await this.#store.countQueued()) >= this.#cap) {
        await this.#runOnce()
      } else if (!(await this.#timer.pending())) {
        await this.#timer.set(this.#now() + this.#waitMs)
      }
    })
  }

  /** Flush pokes the queue awake: drop the pending wait and run — the gap rule still applies. */
  flush(): Promise<void> {
    return this.#serialize(async () => {
      await this.#timer.clear()
      await this.#runOnce()
    })
  }

  run(): Promise<{ batchId: Hex; accepted: number; rejected: number } | null> {
    return this.#serialize(() => this.#runOnce())
  }

  /** Re-resolve a batch against the chain — used by run() and by recover() for journaled batches. */
  resolve(batchId: Hex): Promise<void> {
    return this.#serialize(async () => {
      await this.#resolveOnce(batchId)
    })
  }

  /**
   * Startup recovery: every batch still recorded in the journal (plus any this process itself has
   * in flight) is checked against the chain — landed batches resolve their rows, batches the chain
   * never saw hand their rows back to the queue. Afterwards a non-empty queue arms the timer again.
   */
  recover(): Promise<void> {
    return this.#serialize(async () => {
      const batchIds = new Set<string>([...this.#submitted.keys(), ...((await this.#journal?.list()) ?? []).map((id) => id.toLowerCase())])
      for (const batchId of batchIds) {
        try {
          const { blockNumber } = await this.#chain.batchOf(batchId as Hex)
          if (blockNumber !== 0n) {
            await this.#resolveOnce(batchId as Hex)
          } else {
            const requeued = await this.#store.requeue(batchId as Hex)
            this.#log?.({ event: "batch.requeued", batchId, requeued })
          }
          await this.#journal?.clear(batchId as Hex)
          this.#submitted.delete(batchId)
        } catch (error) {
          // One bad batch must not starve the rest — log it loudly and keep going.
          this.#log?.({ event: "batch.recover-failed", batchId, error: String(error) })
        }
      }
      if ((await this.#store.countQueued()) > 0 && !(await this.#timer.pending())) {
        await this.#timer.set(this.#now() + this.#waitMs)
      }
    })
  }

  /** Serializes every state-changing path so two triggers can never submit or resolve in parallel. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const out = this.#tail.then(fn)
    this.#tail = out.then(
      () => undefined,
      () => undefined,
    )
    return out
  }

  async #runOnce(): Promise<{ batchId: Hex; accepted: number; rejected: number } | null> {
    const now = this.#now()
    const gapEnd = this.#lastSubmitAt === null ? Number.NEGATIVE_INFINITY : this.#lastSubmitAt + this.#minGapMs
    if (now < gapEnd) {
      // Inside the gap: the only legal move is a wakeup at the exact instant it ends — and only
      // when there is actually something queued to send then.
      if ((await this.#store.countQueued()) > 0) await this.#timer.set(gapEnd)
      return null
    }
    const sequence = await this.#store.nextSequence()
    const batchId = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [this.#submitter, sequence, this.#salt()],
      ),
    )
    // The batchId goes into the journal before a single row is marked SUBMITTED, so a crash between
    // the take and the full record still leaves recover() a batchId it can requeue by.
    await this.#journal?.record(batchId, [])
    const taken = await this.#store.takeQueued(this.#effectiveCap, batchId)
    if (taken.length === 0) {
      await this.#journal?.clear(batchId)
      await this.#timer.clear()
      return null
    }
    const contextIds = taken.map((row) => row.contextId)
    this.#submitted.set(batchId.toLowerCase(), contextIds)
    try {
      await this.#journal?.record(batchId, contextIds)
    } catch (error) {
      // The journal is the recovery path — without it these rows would be stranded as SUBMITTED.
      await this.#store.requeue(batchId)
      this.#submitted.delete(batchId.toLowerCase())
      this.#log?.({ event: "batch.journal-failed", batchId, error: String(error) })
      throw error
    }
    let result: { transactionHash: Hex } | { exists: true }
    try {
      result = await this.#chain.submit(batchId, taken.map((row) => row.save))
    } catch (error) {
      if (isMidaError(error, "GAS_CEILING_EXCEEDED")) {
        this.#submitted.delete(batchId.toLowerCase())
        await this.#journal?.clear(batchId)
        if (taken.length === 1) {
          // A batch of one that still exceeds the ceiling can never shrink — the row is rejected
          // on the store side so the queue moves on; readers see the plain reason.
          await this.#store.markRejected(taken[0]!.contextId, "TOO_LARGE")
          this.#log?.({ event: "batch.too-large", batchId, contextId: taken[0]!.contextId, rejected: "TOO_LARGE" })
        } else {
          // The batch was too big to send — a size refusal, not an ambiguous send. The rows go back
          // and the next take halves the cap, so the queue drains in smaller batches instead of
          // wedging behind one it can never push through.
          const requeued = await this.#store.requeue(batchId)
          this.#effectiveCap = Math.max(1, Math.floor(this.#effectiveCap / 2))
          this.#log?.({ event: "batch.too-large", batchId, requeued, cap: this.#effectiveCap })
        }
        if (!(await this.#timer.pending())) await this.#timer.set(this.#now() + this.#waitMs)
        return null
      }
      // The send failed ambiguously — the tx may or may not land. Requeue wholesale; if it did land,
      // the next batch's ALREADY_ANCHORED rejects heal the rows through findAnchoring.
      const requeued = await this.#store.requeue(batchId)
      this.#submitted.delete(batchId.toLowerCase())
      await this.#journal?.clear(batchId)
      this.#log?.({ event: "batch.submit-failed", batchId, requeued, error: String(error) })
      if (!(await this.#timer.pending())) await this.#timer.set(this.#now() + this.#waitMs)
      return null
    }
    this.#effectiveCap = this.#cap
    this.#lastSubmitAt = this.#now()
    this.#log?.({ event: "batch.submitted", batchId, saves: taken.length, exists: "exists" in result })
    try {
      const counts = await this.#resolveOnce(batchId)
      this.#submitted.delete(batchId.toLowerCase())
      await this.#journal?.clear(batchId)
      if ((await this.#store.countQueued()) > 0 && !(await this.#timer.pending())) {
        await this.#timer.set(this.#now() + this.#waitMs)
      }
      return { batchId, ...counts }
    } catch (error) {
      // A resolve failure leaves the batch in flight — the journal keeps it recoverable and the
      // timer gets the rest of the queue moving instead of waiting on this batch.
      this.#log?.({ event: "batch.resolve-failed", batchId, error: String(error) })
      if (!(await this.#timer.pending())) await this.#timer.set(this.#now() + this.#waitMs)
      throw error
    }
  }

  /**
   * Writes back exactly what the chain decided. The rebuilt root must equal `batchOf(batchId).root`
   * before any row moves — a chain adapter returning logs that do not recompute to the on-chain
   * root is lying or corrupt, and the rows stay SUBMITTED rather than take a false anchor.
   */
  async #resolveOnce(batchId: Hex): Promise<{ accepted: number; rejected: number }> {
    const batch = await this.#chain.batchOf(batchId)
    if (batch.blockNumber === 0n) throw new MidaError("NOT_FOUND", `batch ${batchId} has not landed on chain`)
    // Before any row moves the batch must prove it is THIS batcher's: submitBatch has no caller
    // check, so a batchId found on chain can be a foreign batch pre-claiming the id. Three facts
    // have to line up — the BatchAnchored event names our submitter, every anchored contextId is
    // one of the journaled rows, and the event's accepted+rejected count equals the row count.
    const order = this.#submitted.get(batchId.toLowerCase()) ?? (await this.#journal?.contextIds(batchId)) ?? null
    const anchored = (await this.#chain.anchoredLogs(batchId)).sort((a, b) => a.position - b.position)
    const rejected = await this.#chain.rejectedLogs(batchId)
    const event = await this.#chain.batchAnchored(batchId)
    const oursIds = new Set((order ?? []).map((contextId) => contextId.toLowerCase()))
    const ours =
      order !== null &&
      event !== null &&
      event.submitter.toLowerCase() === this.#submitter &&
      anchored.every((log) => oursIds.has(log.contextId.toLowerCase())) &&
      event.acceptedCount + event.rejectedCount === order.length
    if (!ours) {
      // Not ours: no row may take this batch's outcomes. The rows come back to QUEUED (a fresh id
      // next run), the journal entry is cleared and the one log line says exactly what happened.
      const requeued = await this.#store.requeue(batchId)
      this.#submitted.delete(batchId.toLowerCase())
      await this.#journal?.clear(batchId)
      this.#log?.({ event: "batch.not-ours", batchId, requeued, message: `batch ${batchId} is not ours — requeued` })
      return { accepted: 0, rejected: 0 }
    }
    // The log set must be exactly the batch the contract recorded — a hole in it rebuilds the wrong
    // root, and so does a missing tail the count comparison would otherwise wave through.
    if (anchored.length !== Number(batch.acceptedCount)) {
      this.#log?.({ event: "batch.root-mismatch", batchId, expected: batch.root, anchored: anchored.length, acceptedCount: Number(batch.acceptedCount) })
      throw new BatchRootMismatchError(batchId, batch.root, zeroHash)
    }
    const leaves = anchored.map((log) => log.leafHash)
    // The contract stores bytes32(0) as the root of an empty leaf set (a batch where every save was
    // rejected): matching it is the one case where there is no tree to rebuild.
    const rebuilt = leaves.length === 0 ? zeroHash : merkleRoot(leaves)
    if (rebuilt.toLowerCase() !== batch.root.toLowerCase()) {
      this.#log?.({ event: "batch.root-mismatch", batchId, expected: batch.root, rebuilt, anchored: anchored.length })
      throw new BatchRootMismatchError(batchId, batch.root, rebuilt)
    }
    const anchoredAt = this.#now()
    for (const log of anchored) {
      // The logged leaf must also be the leaf the stored save computes to — a root that matches but
      // a leaf bound to different fields would hand the row a proof a reader can never use.
      const row = await this.#store.get(log.contextId)
      if (row !== null) {
        const expected = leafForRow(log, row)
        if (expected !== log.leafHash.toLowerCase()) {
          this.#log?.({ event: "batch.leaf-mismatch", batchId, contextId: log.contextId, expected, logged: log.leafHash })
          throw new BatchRootMismatchError(batchId, expected, log.leafHash)
        }
      }
      await this.#store.markAnchored(log.contextId, {
        batchId,
        position: log.position,
        lineageId: log.lineageId,
        version: log.version,
        proof: merkleProof(leaves, log.position),
        anchoredAt,
      })
    }
    let unmapped = 0
    for (const rejection of rejected) {
      const contextId = order?.[rejection.index]
      if (contextId === undefined) {
        unmapped += 1
        continue
      }
      if (rejection.reason === BATCH_REJECT.ALREADY_ANCHORED) {
        const healed = await this.#anchorFromEarlierBatch(batchId, contextId, anchoredAt)
        if (!healed) await this.#store.markRejected(contextId, rejectName(rejection.reason))
      } else {
        await this.#store.markRejected(contextId, rejectName(rejection.reason))
      }
    }
    if (unmapped > 0) {
      // The submitted order is gone (no journal survived): anchored rows were still marked above,
      // and the unmapped ones stay SUBMITTED — visible in the status route, retriable when a
      // journal exists again. They are never guessed at.
      this.#log?.({ event: "batch.unmapped-rejections", batchId, unmapped })
    }
    this.#log?.({ event: "batch.resolved", batchId, accepted: anchored.length, rejected: rejected.length })
    return { accepted: anchored.length, rejected: rejected.length }
  }

  /**
   * A save the contract rejected as ALREADY_ANCHORED is not dead — an earlier batch holds its real
   * proof. Rebuild that batch's leaves under the same root-equality rule and anchor the row there.
   */
  async #anchorFromEarlierBatch(batchId: Hex, contextId: Hex, anchoredAt: number): Promise<boolean> {
    const earlier = await this.#chain.findAnchoring(contextId)
    if (earlier === null || earlier.toLowerCase() === batchId.toLowerCase()) return false
    const logs = (await this.#chain.anchoredLogs(earlier)).sort((a, b) => a.position - b.position)
    const leaves = logs.map((log) => log.leafHash)
    const prior = await this.#chain.batchOf(earlier)
    const rebuilt = leaves.length === 0 ? zeroHash : merkleRoot(leaves)
    if (rebuilt.toLowerCase() !== prior.root.toLowerCase()) {
      this.#log?.({ event: "batch.root-mismatch", batchId: earlier, expected: prior.root, rebuilt, contextId })
      throw new BatchRootMismatchError(earlier, prior.root, rebuilt)
    }
    const entry = logs.find((log) => log.contextId.toLowerCase() === contextId.toLowerCase())
    if (entry === undefined) return false
    await this.#store.markAnchored(contextId, {
      batchId: earlier,
      position: entry.position,
      lineageId: entry.lineageId,
      version: entry.version,
      proof: merkleProof(leaves, entry.position),
      anchoredAt,
    })
    return true
  }
}

/** The leaf the row's signed save produces for this anchored log — what a reader recomputes. */
function leafForRow(log: AnchoredLog, row: BatchSaveRow): Hex {
  const message = row.save.message
  const decoded: BatchSaveMessage = {
    ...message,
    readEpoch: decodeUint64(message.readEpoch),
    expiresAt: decodeUint64(message.expiresAt),
  }
  return batchLeafHash({ contextId: log.contextId, agentId: log.agentId, lineageId: log.lineageId, version: log.version, structHash: batchSaveStructHash(decoded) })
}

/**
 * The real chain adapter: viem clients over the deployment's RPC, submitBatch through sendContract.
 * The send runs under the "revoke.agent" ceiling (6M gas) — gas.ts has no batch-submit kind and was
 * outside this task's file list; at the measured ~90k gas per accepted save a batch of 60 still
 * fits, so the wiring caps batches below that rather than weaken the ceiling rule.
 */
export function createBatcherChain(input: { rpcUrl: string; deployment: Deployment; account: LocalAccount }): BatcherChain {
  const { deployment } = input
  const batchAnchor = deployment.batchAnchor
  if (batchAnchor === undefined) throw new MidaError("INVALID_WIRE", "this deployment has no BatchAnchor")
  const fromBlock = deployment.batchAnchorBlock ?? deployment.deploymentBlock
  const context = createWriteContext(input)
  const batchAnchoredEvent = batchAnchorAbi.find((item) => item.type === "event" && item.name === "BatchAnchored") as AbiEvent
  const saveAnchoredEvent = batchAnchorAbi.find((item) => item.type === "event" && item.name === "SaveAnchored") as AbiEvent
  const saveRejectedEvent = batchAnchorAbi.find((item) => item.type === "event" && item.name === "SaveRejected") as AbiEvent
  // The block a landed batch was recorded in — the only block its events can live in. A batchId
  // the chain never saw answers 0 and every per-batch read is empty without a log scan.
  const batchBlock = async (batchId: Hex): Promise<bigint> => {
    const [, blockNumber] = (await context.publicClient.readContract({
      address: batchAnchor,
      abi: batchAnchorAbi,
      functionName: "batchOf",
      args: [batchId],
    })) as [Hex, bigint, number]
    return BigInt(blockNumber)
  }

  return {
    async submit(batchId, saves) {
      const signed = saves.map((wire) => ({
        owner: wire.message.owner,
        namespaceId: wire.message.namespaceId,
        objectNonce: wire.message.objectNonce,
        lineageId: wire.message.lineageId,
        parentId: wire.message.parentId,
        parentVersion: wire.message.parentVersion,
        rootAuthor: wire.message.rootAuthor,
        manifestHash: wire.message.manifestHash,
        ciphertextCommitment: wire.message.ciphertextCommitment,
        readEpoch: decodeUint64(wire.message.readEpoch),
        expiresAt: decodeUint64(wire.message.expiresAt),
        kind: wire.message.kind,
        provenanceSource: wire.message.provenanceSource,
        signature: wire.signature,
      }))
      try {
        const receipt = await sendContract(
          context,
          { address: batchAnchor, abi: batchAnchorAbi, functionName: "submitBatch", args: [batchId, signed] },
          "revoke.agent",
        )
        return { transactionHash: receipt.transactionHash }
      } catch (error) {
        // BatchExists is the crash-recovery path: the earlier send did land. Anything else is a real
        // failure and must stay one — misclassifying it would strand the rows as SUBMITTED.
        if (revertName(error) === "BatchExists") return { exists: true }
        throw error
      }
    },
    async anchoredLogs(batchId) {
      const blockNumber = await batchBlock(batchId)
      if (blockNumber === 0n) return []
      const logs = await getLogsChunked(context.publicClient, {
        address: batchAnchor,
        event: saveAnchoredEvent,
        args: { batchId },
        fromBlock: blockNumber,
        toBlock: blockNumber,
      })
      return logs.map((log) => {
        const args = log.args as { contextId: Hex; author: Hex; position: number; lineageId: Hex; version: number; leafHash: Hex }
        return {
          contextId: args.contextId.toLowerCase() as Hex,
          agentId: args.author.toLowerCase() as Hex,
          position: Number(args.position),
          lineageId: args.lineageId.toLowerCase() as Hex,
          version: Number(args.version),
          leafHash: args.leafHash.toLowerCase() as Hex,
        }
      })
    },
    async rejectedLogs(batchId) {
      const blockNumber = await batchBlock(batchId)
      if (blockNumber === 0n) return []
      const logs = await getLogsChunked(context.publicClient, {
        address: batchAnchor,
        event: saveRejectedEvent,
        args: { batchId },
        fromBlock: blockNumber,
        toBlock: blockNumber,
      })
      return logs.map((log) => {
        const args = log.args as { index: number; reason: number }
        return { index: Number(args.index), reason: Number(args.reason) }
      })
    },
    async batchAnchored(batchId) {
      const blockNumber = await batchBlock(batchId)
      if (blockNumber === 0n) return null
      const logs = await getLogsChunked(context.publicClient, {
        address: batchAnchor,
        event: batchAnchoredEvent,
        args: { batchId },
        fromBlock: blockNumber,
        toBlock: blockNumber,
      })
      const first = logs[0]
      if (first === undefined) return null
      const args = first.args as { submitter: Address; acceptedCount: number; rejectedCount: number }
      return {
        submitter: args.submitter.toLowerCase() as Address,
        acceptedCount: Number(args.acceptedCount),
        rejectedCount: Number(args.rejectedCount),
      }
    },
    async batchOf(batchId) {
      const [root, blockNumber, acceptedCount] = (await context.publicClient.readContract({
        address: batchAnchor,
        abi: batchAnchorAbi,
        functionName: "batchOf",
        args: [batchId],
      })) as [Hex, bigint, number]
      return { root: root.toLowerCase() as Hex, blockNumber: BigInt(blockNumber), acceptedCount: Number(acceptedCount) }
    },
    async findAnchoring(contextId) {
      const logs = await getLogsChunked(context.publicClient, {
        address: batchAnchor,
        event: saveAnchoredEvent,
        args: { contextId },
        fromBlock,
      })
      const first = logs[0]
      if (first === undefined) return null
      return ((first.args as { batchId: Hex }).batchId).toLowerCase() as Hex
    },
  }
}
