// BatchAnchor Task 6: the batcher under a manual timer, an in-memory BatchStore and a scripted fake
// chain. What is proven here: the wait timer is a promise that never moves, the cap and flush run
// immediately, minGapMs is a hard floor between submissions, and every crash point the journal
// covers — between journal-write and submit, between submit and resolve — ends with correct row
// states after recover(). The fake chain mirrors the contract: it computes real leaf hashes and a
// real Merkle root over accepted saves, rejects like _checkAndApply (including ALREADY_ANCHORED for
// a contextId it has anchored before), and stores bytes32(0) as the root of an all-rejected batch.

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, zeroHash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { randomBytes } from "@noble/hashes/utils.js"
import { hexOf } from "@mida/crypto"
import {
  BATCH_REJECT,
  MidaError,
  batchContextId,
  batchLeafHash,
  batchSaveStructHash,
  merkleRoot,
  namespaceId,
  verifyMerkleProof,
} from "@mida/protocol"
import type { Address, BatchSaveMessage, Hex } from "@mida/protocol"
import { batchAnchorAbi } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { BatchRootMismatchError, Batcher, MemoryBatchJournal, createBatcherChain } from "../src/batcher.js"
import type { AnchoredLog, BatchJournal, BatcherChain, BatcherTimer, RejectedLog } from "../src/batcher.js"
import type { BatchedSaveWire } from "../src/client.js"
import type { BatchSaveRow, BatchStore } from "../src/batch-store.js"

const CHAIN_ID = 31337n
const BATCH_ANCHOR = "0x1111111111111111111111111111111111111aa5" as Address
const SUBMITTER = "0x9999999999999999999999999999999999999999" as Address
const OWNER = "0x2222222222222222222222222222222222222222" as Address
const SIGNER = "0x3333333333333333333333333333333333333333" as Address
const AGENT_ID = hexOf(randomBytes(32))
const NAMESPACE = namespaceId("goals.career")

interface SaveMeta {
  contextId: Hex
  agentId: Hex
  lineageId: Hex
  version: number
  structHash: Hex
}

/** objectNonce → what the contract would compute for this save. The fake chain resolves through it. */
const metas = new Map<string, SaveMeta>()

function makeSave(overrides: Partial<BatchSaveMessage> = {}): { wire: BatchedSaveWire; meta: SaveMeta } {
  const message: BatchSaveMessage = {
    owner: OWNER,
    namespaceId: NAMESPACE,
    objectNonce: hexOf(randomBytes(32)),
    lineageId: zeroHash,
    parentId: zeroHash,
    parentVersion: 0,
    rootAuthor: zeroHash,
    manifestHash: hexOf(randomBytes(32)),
    ciphertextCommitment: hexOf(randomBytes(32)),
    readEpoch: 1n,
    expiresAt: 0n,
    kind: 1,
    provenanceSource: 1,
    ...overrides,
  }
  const contextId = batchContextId({
    chainId: CHAIN_ID,
    batchAnchor: BATCH_ANCHOR,
    owner: message.owner,
    agentId: AGENT_ID,
    namespaceId: message.namespaceId,
    parentId: message.parentId,
    objectNonce: message.objectNonce,
  })
  const meta: SaveMeta = {
    contextId,
    agentId: AGENT_ID,
    // What BatchAnchor._checkAndApply derives: a new lineage roots itself at v1; a replacement
    // carries the signed lineageId at parentVersion+1.
    lineageId: message.parentId === zeroHash ? contextId : message.lineageId,
    version: message.parentId === zeroHash ? 1 : message.parentVersion + 1,
    structHash: batchSaveStructHash(message),
  }
  metas.set(message.objectNonce.toLowerCase(), meta)
  return {
    wire: {
      message: { ...message, readEpoch: message.readEpoch.toString(10), expiresAt: message.expiresAt.toString(10) },
      signature: `0x${"ab".repeat(65)}` as Hex,
      manifest: { contextId } as unknown as BatchedSaveWire["manifest"],
      ciphertext: "0xbeef" as Hex,
    },
    meta,
  }
}

const leafOf = (meta: SaveMeta): Hex =>
  batchLeafHash({ contextId: meta.contextId, agentId: meta.agentId, lineageId: meta.lineageId, version: meta.version, structHash: meta.structHash })

function queueRow(wire: BatchedSaveWire, contextId: Hex, receivedAt: number): BatchSaveRow {
  return {
    contextId,
    owner: OWNER,
    namespaceId: NAMESPACE,
    signer: SIGNER,
    save: wire,
    state: "QUEUED",
    reason: null,
    batchId: null,
    position: null,
    lineageId: null,
    version: null,
    proof: null,
    receivedAt,
    anchoredAt: null,
  }
}

const byAge = (a: BatchSaveRow, b: BatchSaveRow): number => a.receivedAt - b.receivedAt || a.contextId.localeCompare(b.contextId)

/** The BatchStore the batcher tests run against — same semantics as FsBatchStore, in a Map. */
class MemoryBatchStore implements BatchStore {
  readonly rows = new Map<string, BatchSaveRow>()
  sequence = 0n
  readonly flushes = new Map<string, number>()

  async insert(row: BatchSaveRow): Promise<"inserted" | "exists"> {
    const key = row.contextId.toLowerCase()
    if (this.rows.has(key)) return "exists"
    this.rows.set(key, { ...row })
    return "inserted"
  }

  async get(contextId: Hex): Promise<BatchSaveRow | null> {
    const row = this.rows.get(contextId.toLowerCase())
    return row === undefined ? null : { ...row }
  }

  async listForReader(owner: Address, namespaceId: Hex): Promise<BatchSaveRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.state !== "REJECTED" && row.owner === owner.toLowerCase() && row.namespaceId === namespaceId.toLowerCase())
      .sort(byAge)
      .map((row) => ({ ...row }))
  }

  async takeQueued(limit: number, batchId: Hex): Promise<BatchSaveRow[]> {
    const taken = [...this.rows.values()]
      .filter((row) => row.state === "QUEUED")
      .sort(byAge)
      .slice(0, limit)
    for (const row of taken) {
      const stored = this.rows.get(row.contextId.toLowerCase())!
      stored.state = "SUBMITTED"
      stored.batchId = batchId.toLowerCase() as Hex
    }
    return taken.map((row) => ({ ...row, state: "SUBMITTED" as const, batchId: batchId.toLowerCase() as Hex }))
  }

  async markAnchored(
    contextId: Hex,
    fields: { batchId: Hex; position: number; lineageId: Hex; version: number; proof: Hex[]; anchoredAt: number },
  ): Promise<void> {
    const row = this.rows.get(contextId.toLowerCase())
    if (row === undefined || row.state === "ANCHORED") return
    row.state = "ANCHORED"
    row.batchId = fields.batchId.toLowerCase() as Hex
    row.position = fields.position
    row.lineageId = fields.lineageId.toLowerCase() as Hex
    row.version = fields.version
    row.proof = fields.proof
    row.anchoredAt = fields.anchoredAt
  }

  async markRejected(contextId: Hex, reason: string): Promise<void> {
    const row = this.rows.get(contextId.toLowerCase())
    if (row === undefined || row.state === "ANCHORED") return
    row.state = "REJECTED"
    row.reason = reason
  }

  async requeue(batchId: Hex): Promise<number> {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.state === "SUBMITTED" && row.batchId === batchId.toLowerCase()) {
        row.state = "QUEUED"
        row.batchId = null
        count++
      }
    }
    return count
  }

  async nextSequence(): Promise<bigint> {
    return ++this.sequence
  }

  async countQueued(): Promise<number> {
    return [...this.rows.values()].filter((row) => row.state === "QUEUED").length
  }

  async lastFlush(signer: Address): Promise<number | null> {
    return this.flushes.get(signer.toLowerCase()) ?? null
  }

  async setLastFlush(signer: Address, atMs: number): Promise<void> {
    this.flushes.set(signer.toLowerCase(), atMs)
  }
}

/** The timer a test drives by hand: `pendingAt` is the armed instant, `fire()` is the alarm going off. */
class ManualTimer implements BatcherTimer {
  pendingAt: number | null = null
  onFire: () => unknown = () => {}

  set(atMs: number): void {
    this.pendingAt = atMs
  }

  clear(): void {
    this.pendingAt = null
  }

  pending(): boolean {
    return this.pendingAt !== null
  }

  fire(): void {
    this.pendingAt = null
    this.onFire()
  }
}

interface RecordedBatch {
  anchored: AnchoredLog[]
  rejected: RejectedLog[]
  root: Hex
  blockNumber: bigint
  acceptedCount: number
  /** msg.sender as the contract would store it — the fake lets a test pose as anyone. */
  submitter: Address
}

const flipNibble = (hex: Hex): Hex => (hex.endsWith("0") ? `${hex.slice(0, -1)}1` : `${hex.slice(0, -1)}0`) as Hex

/**
 * The contract, faked faithfully: submitBatch computes real leaves over accepted saves and stores
 * the real Merkle root; a contextId already anchored anywhere is ALREADY_ANCHORED, and BatchExists
 * answers { exists: true } for a batchId it has seen. Knobs let a test lie on purpose (rootOverride,
 * tamperField) or break the world (failSubmit, afterRecord, failLogs) at exact crash points.
 */
class FakeChain implements BatcherChain {
  readonly batches = new Map<string, RecordedBatch>()
  readonly submissions: { batchId: Hex; count: number }[] = []
  readonly anchoredIn = new Map<string, Hex>()
  attempts = 0
  blockCounter = 100n
  now: () => number = () => 0
  readonly submitTimes: number[] = []
  /** Who the next submit() records as the batch's sender — flip it to pose as an attacker. */
  submitter: Address = SUBMITTER

  /** Per-save decision: return a BATCH_REJECT code to reject, null to accept. Runs after the auto-anchored check. */
  rejectWith: (wire: BatchedSaveWire, index: number) => number | null = () => null
  /** Return an error to throw before recording — sees the saves, so a test can refuse by batch size. */
  failSubmit: ((saves: BatchedSaveWire[]) => Error | null) | null = null
  /** Answer { exists: true } after recording — the batch landed, but its answer carries no receipt. */
  reportExists = false
  /**
   * The gasUsed the receipt reports — the measurement the batcher re-sizes its next take from.
   * Default is a flat 60k per save, near the sweep's ~61k asymptote for large batches.
   */
  gasUsedFor: (saves: BatchedSaveWire[]) => bigint = (saves) => 60_000n * BigInt(saves.length)
  /** Throw after recording: the send landed but its answer was lost. */
  afterRecord: (() => void) | null = null
  failLogs = false
  /**
   * A lagging log index: batchOf sees the landed batch but every event read answers empty/null —
   * the state a node can sit in right after the receipt. Missing answers, not wrong ones.
   */
  indexLag = false
  /** Drop the last N anchored logs — a log index that handed back a partial set for the batch. */
  anchoredDrop = 0
  rootOverride: Hex | null = null
  tamperField: "lineageId" | null = null

  async submit(batchId: Hex, saves: BatchedSaveWire[]): Promise<{ transactionHash: Hex; gasUsed: bigint } | { exists: true }> {
    this.attempts++
    this.submitTimes.push(this.now())
    const key = batchId.toLowerCase() as Hex
    if (this.batches.has(key)) return { exists: true }
    const failure = this.failSubmit?.(saves)
    if (failure != null) throw failure
    this.submissions.push({ batchId, count: saves.length })
    const anchored: AnchoredLog[] = []
    const rejected: RejectedLog[] = []
    saves.forEach((wire, index) => {
      const meta = metas.get(wire.message.objectNonce.toLowerCase())
      if (meta === undefined) throw new Error("test bug: the fake chain got an undescribed save")
      const prior = this.anchoredIn.get(meta.contextId.toLowerCase())
      const reason = prior !== undefined ? BATCH_REJECT.ALREADY_ANCHORED : this.rejectWith(wire, index)
      if (reason !== null) {
        rejected.push({ index, reason })
        return
      }
      anchored.push({
        contextId: meta.contextId,
        agentId: meta.agentId,
        position: anchored.length,
        lineageId: meta.lineageId,
        version: meta.version,
        leafHash: leafOf(meta),
      })
      this.anchoredIn.set(meta.contextId.toLowerCase(), key)
    })
    this.batches.set(key, {
      anchored,
      rejected,
      root: anchored.length === 0 ? zeroHash : merkleRoot(anchored.map((log) => log.leafHash)),
      blockNumber: this.blockCounter++,
      acceptedCount: anchored.length,
      submitter: this.submitter,
    })
    this.afterRecord?.()
    if (this.reportExists) return { exists: true }
    return { transactionHash: `0x${"ee".repeat(32)}` as Hex, gasUsed: this.gasUsedFor(saves) }
  }

  async anchoredLogs(batchId: Hex): Promise<AnchoredLog[]> {
    if (this.failLogs) throw new Error("log read failed")
    if (this.indexLag) return []
    const batch = this.batches.get(batchId.toLowerCase())
    if (batch === undefined) return []
    return batch.anchored
      .slice(0, Math.max(0, batch.anchored.length - this.anchoredDrop))
      .map((log) => (this.tamperField === "lineageId" ? { ...log, lineageId: flipNibble(log.lineageId) } : { ...log }))
  }

  async rejectedLogs(batchId: Hex): Promise<RejectedLog[]> {
    if (this.failLogs) throw new Error("log read failed")
    if (this.indexLag) return []
    return this.batches.get(batchId.toLowerCase())?.rejected.map((log) => ({ ...log })) ?? []
  }

  async batchAnchored(batchId: Hex): Promise<{ submitter: Address; acceptedCount: number; rejectedCount: number } | null> {
    if (this.failLogs) throw new Error("log read failed")
    if (this.indexLag) return null
    const batch = this.batches.get(batchId.toLowerCase())
    if (batch === undefined) return null
    return { submitter: batch.submitter, acceptedCount: batch.acceptedCount, rejectedCount: batch.rejected.length }
  }

  async batchOf(batchId: Hex): Promise<{ root: Hex; blockNumber: bigint; acceptedCount: number }> {
    const batch = this.batches.get(batchId.toLowerCase())
    if (batch === undefined) return { root: zeroHash, blockNumber: 0n, acceptedCount: 0 }
    return { root: this.rootOverride ?? batch.root, blockNumber: batch.blockNumber, acceptedCount: batch.acceptedCount }
  }

  async findAnchoring(contextId: Hex): Promise<Hex | null> {
    return this.anchoredIn.get(contextId.toLowerCase()) ?? null
  }
}

interface Rig {
  store: MemoryBatchStore
  chain: FakeChain
  journal: BatchJournal
  timer: ManualTimer
  batcher: Batcher
  setNow: (ms: number) => void
  events: Record<string, unknown>[]
  enqueue: (wire: BatchedSaveWire, contextId: Hex) => Promise<void>
}

function makeRig(
  input: {
    cap?: number
    waitMs?: number
    minGapMs?: number
    store?: MemoryBatchStore
    chain?: FakeChain
    journal?: BatchJournal
    /** Deterministic batchId salt — a test that must predict or replay an id supplies one. */
    salt?: () => Hex
    /** The gas budget the batcher sizes takes against; default is the "batch.submit" ceiling. */
    gasBudget?: bigint
    /** The per-save gas assumed before the first real receipt; default is the sweep's 66,264. */
    initialGasPerSave?: bigint
  } = {},
): Rig {
  const store = input.store ?? new MemoryBatchStore()
  const chain = input.chain ?? new FakeChain()
  const journal = input.journal ?? new MemoryBatchJournal()
  const timer = new ManualTimer()
  const events: Record<string, unknown>[] = []
  let nowMs = 0
  chain.now = () => nowMs
  const batcher = new Batcher({
    store,
    chain,
    timer,
    now: () => nowMs,
    cap: input.cap ?? 8,
    waitMs: input.waitMs ?? 2_000,
    minGapMs: input.minGapMs ?? 1_000,
    submitter: SUBMITTER,
    ...(input.salt === undefined ? {} : { salt: input.salt }),
    gasBudget: input.gasBudget,
    initialGasPerSave: input.initialGasPerSave,
    journal,
    log: (record) => events.push(record),
  })
  timer.onFire = () => void batcher.run()
  let received = 0
  return {
    store,
    chain,
    journal,
    timer,
    batcher,
    events,
    setNow: (ms) => {
      nowMs = ms
    },
    enqueue: async (wire, contextId) => {
      await store.insert(queueRow(wire, contextId, received++))
    },
  }
}

describe("the batcher", () => {
  it("the first queued save arms the wait timer once; ten more saves inside the window never move it", async () => {
    const rig = makeRig({ cap: 20, waitMs: 2_000 })
    for (let i = 0; i < 11; i++) {
      const { wire, meta } = makeSave()
      await rig.enqueue(wire, meta.contextId)
      await rig.batcher.notify()
      expect(rig.timer.pendingAt).toBe(2_000)
    }
    expect(rig.chain.submissions).toHaveLength(0)

    rig.setNow(2_000)
    rig.timer.fire()
    await rig.batcher.run() // the fired wakeup is async through the serializer; run() joins it
    // ...and the actual submission is observable:
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.chain.submissions[0]!.count).toBe(11)
    expect(await rig.store.countQueued()).toBe(0)
    for (const row of rig.store.rows.values()) expect(row.state).toBe("ANCHORED")
  })

  it("the cap runs the batch immediately — the third save of a cap-3 rig submits without the timer firing", async () => {
    const rig = makeRig({ cap: 3 })
    for (let i = 0; i < 3; i++) {
      const { wire, meta } = makeSave()
      await rig.enqueue(wire, meta.contextId)
      await rig.batcher.notify()
    }
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.chain.submissions[0]!.count).toBe(3)
    for (const row of rig.store.rows.values()) expect(row.state).toBe("ANCHORED")
  })

  it("flush() runs immediately with a single queued save and drops the pending wait", async () => {
    const rig = makeRig()
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    await rig.batcher.notify()
    expect(rig.timer.pendingAt).toBe(2_000)

    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.timer.pending()).toBe(false)
    expect((await rig.store.get(meta.contextId))!.state).toBe("ANCHORED")
  })

  it("minGapMs is a hard floor: a flush inside the gap schedules at lastSubmitAt + minGapMs instead of running", async () => {
    const rig = makeRig({ minGapMs: 1_000, waitMs: 60_000 })
    const first = makeSave()
    await rig.enqueue(first.wire, first.meta.contextId)
    await rig.batcher.flush()
    expect(rig.chain.submitTimes).toEqual([0])

    // A flush on an empty queue inside the gap does not even arm the timer.
    rig.setNow(300)
    await rig.batcher.flush()
    expect(rig.timer.pending()).toBe(false)

    const second = makeSave()
    await rig.enqueue(second.wire, second.meta.contextId)
    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.timer.pendingAt).toBe(1_000)

    rig.setNow(999)
    rig.timer.fire()
    await rig.batcher.run() // whatever ran re-arms inside the still-open gap
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.timer.pendingAt).toBe(1_000)

    rig.setNow(1_000)
    rig.timer.fire()
    await rig.batcher.run()
    expect(rig.chain.submissions).toHaveLength(2)
    expect(rig.chain.submitTimes[1]! - rig.chain.submitTimes[0]!).toBeGreaterThanOrEqual(1_000)
    expect((await rig.store.get(second.meta.contextId))!.state).toBe("ANCHORED")
  })

  it("a transient submit failure requeues every row, clears the journal and re-arms the timer", async () => {
    const rig = makeRig()
    const chain = rig.chain
    chain.failSubmit = () => new Error("rpc timeout")
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)

    await rig.batcher.flush()
    expect(chain.batches.size).toBe(0)
    expect((await rig.store.get(meta.contextId))!.state).toBe("QUEUED")
    expect((await rig.store.get(meta.contextId))!.batchId).toBeNull()
    expect(await rig.journal.list()).toEqual([])
    expect(rig.timer.pending()).toBe(true)

    chain.failSubmit = null
    await rig.batcher.flush()
    expect(chain.submissions).toHaveLength(1)
    expect((await rig.store.get(meta.contextId))!.state).toBe("ANCHORED")
  })

  it("a gas-ceiling refusal halves the next take until the batch fits — the queue never wedges", async () => {
    const rig = makeRig({ cap: 8 })
    const saves = [makeSave(), makeSave(), makeSave()]
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    // The node refuses any batch above two saves on the gas ceiling — a local policy error, not a
    // dropped connection.
    rig.chain.failSubmit = (batch) =>
      batch.length > 2 ? new MidaError("GAS_CEILING_EXCEEDED", "submitBatch: estimate exceeds the ceiling") : null

    // cap 8 → take 3, refused: all rows requeue and the next take is capped at 4.
    await rig.batcher.flush()
    expect(rig.chain.batches.size).toBe(0)
    for (const { meta } of saves) expect((await rig.store.get(meta.contextId))!).toMatchObject({ state: "QUEUED", batchId: null })
    expect(await rig.journal.list()).toEqual([])
    expect(rig.events.find((entry) => entry["event"] === "batch.too-large")).toMatchObject({ requeued: 3, cap: 4 })

    // take min(4, 3) = 3 — still refused, cap halves again to 2. Refusals don't touch the submit
    // gap, so the next flush runs at once.
    await rig.batcher.flush()
    expect(rig.chain.batches.size).toBe(0)
    expect(rig.events.filter((entry) => entry["event"] === "batch.too-large").at(-1)).toMatchObject({ requeued: 3, cap: 2 })

    // take 2 — fits. The two rows anchor and the cap returns to the configured 8.
    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.chain.submissions[0]!.count).toBe(2)
    for (const { meta } of saves.slice(0, 2)) expect((await rig.store.get(meta.contextId))!.state).toBe("ANCHORED")

    // The leftover save goes in a fresh batch — past minGapMs for the successful submit first.
    rig.setNow(1_000)
    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(2)
    expect(rig.chain.submissions[1]!.count).toBe(1)
    expect((await rig.store.get(saves[2]!.meta.contextId))!.state).toBe("ANCHORED")
  })

  it("a singleton batch that still exceeds the gas ceiling is REJECTED TOO_LARGE and the queue moves on", async () => {
    const rig = makeRig({ cap: 8 })
    const huge = makeSave()
    const fine = makeSave()
    await rig.enqueue(huge.wire, huge.meta.contextId)
    await rig.enqueue(fine.wire, fine.meta.contextId)

    // The node refuses any batch containing the oversized save — it alone cannot fit the ceiling.
    rig.chain.failSubmit = (batch) =>
      batch.some((save) => save.message.objectNonce === huge.wire.message.objectNonce)
        ? new MidaError("GAS_CEILING_EXCEEDED", "submitBatch: estimate exceeds the ceiling")
        : null

    // take 2 → refused → cap 4; take 2 → refused → cap 2; take 2 → refused → cap 1.
    for (const cap of [4, 2, 1]) {
      await rig.batcher.flush()
      expect(rig.events.filter((entry) => entry["event"] === "batch.too-large").at(-1)).toMatchObject({ requeued: 2, cap })
    }
    // take 1 — the oversized save alone, still refused: rejected store-side, not requeued.
    await rig.batcher.flush()
    expect((await rig.store.get(huge.meta.contextId))!).toMatchObject({ state: "REJECTED", reason: "TOO_LARGE" })
    expect(await rig.journal.list()).toEqual([])

    // The save behind it drains in the very next run.
    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.chain.submissions[0]!.count).toBe(1)
    expect((await rig.store.get(fine.meta.contextId))!).toMatchObject({ state: "ANCHORED" })
  })

  it("sizes the first take by the gas budget — 401 saves at the sweep's measured 66,264 per save, not the 480 hard cap", async () => {
    const rig = makeRig({ cap: 480 })
    const saves = Array.from({ length: 450 }, () => makeSave())
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    await rig.batcher.flush()
    // floor(28,000,000 × 0.95 / 66,264) = 401 — the budget fit, below the configured cap.
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.chain.submissions[0]!.count).toBe(401)
  })

  it("a submit's real gasUsed re-sizes the next take — 100,000 per save fits 266 — and the log carries both numbers", async () => {
    const rig = makeRig({ cap: 480 })
    rig.chain.gasUsedFor = (batch) => 100_000n * BigInt(batch.length)
    const saves = Array.from({ length: 700 }, () => makeSave())
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    await rig.batcher.flush()
    expect(rig.chain.submissions[0]!.count).toBe(401)
    expect(rig.events.filter((entry) => entry["event"] === "batch.submitted").at(-1)).toMatchObject({
      saves: 401,
      cap: 266,
      gasPerSave: 100_000,
    })

    rig.setNow(1_000)
    await rig.batcher.flush()
    // floor(26,600,000 / 100,000) = 266 — what the first batch's receipt taught, not the cap.
    expect(rig.chain.submissions[1]!.count).toBe(266)
  })

  it("a lighter measured save never grows a take past the hard cap", async () => {
    const rig = makeRig({ cap: 50 })
    rig.chain.gasUsedFor = (batch) => 1_000n * BigInt(batch.length) // a suspiciously light receipt — fit ≈ 26,600
    const saves = Array.from({ length: 120 }, () => makeSave())
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    await rig.batcher.flush()
    expect(rig.chain.submissions[0]!.count).toBe(50)
    rig.setNow(1_000)
    await rig.batcher.flush()
    // The learned fit clamps back to the hard cap — a lying measurement can't widen a batch.
    expect(rig.chain.submissions[1]!.count).toBe(50)
  })

  it("notify() runs the batch the moment the queue reaches the learned cap, not the hard cap", async () => {
    // initialGasPerSave 1,000,000 seeds a learned cap of floor(26,600,000 / 1,000,000) = 26.
    const rig = makeRig({ cap: 100, initialGasPerSave: 1_000_000n })
    for (let i = 0; i < 25; i++) {
      const { wire, meta } = makeSave()
      await rig.enqueue(wire, meta.contextId)
      await rig.batcher.notify()
    }
    // 25 < the learned 26 — the batch still waits on the timer even though the hard cap is 100.
    expect(rig.chain.submissions).toHaveLength(0)
    expect(rig.timer.pendingAt).toBe(2_000)

    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    await rig.batcher.notify()
    expect(rig.chain.submissions).toHaveLength(1)
    expect(rig.chain.submissions[0]!.count).toBe(26)
  })

  it("a gas refusal still halves when it carries no estimate, and the next success re-learns from gasUsed instead of jumping back to cap", async () => {
    const rig = makeRig({ cap: 480 })
    const saves = Array.from({ length: 401 }, () => makeSave())
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    // Refuse anything above ten saves without attaching the node's estimate — the halving fallback.
    rig.chain.failSubmit = (batch) =>
      batch.length > 10 ? new MidaError("GAS_CEILING_EXCEEDED", "submitBatch: estimate exceeds the ceiling") : null
    await rig.batcher.flush()
    expect(rig.events.filter((entry) => entry["event"] === "batch.too-large").at(-1)).toMatchObject({ requeued: 401, cap: 200 })
    await rig.batcher.flush()
    expect(rig.events.filter((entry) => entry["event"] === "batch.too-large").at(-1)).toMatchObject({ requeued: 200, cap: 100 })

    rig.chain.failSubmit = null
    rig.chain.gasUsedFor = (batch) => 200_000n * BigInt(batch.length)
    await rig.batcher.flush()
    expect(rig.chain.submissions[0]!.count).toBe(100)

    // floor(26,600,000 / 200,000) = 133 — the receipt's answer, not the halved 100 and not cap 480.
    rig.setNow(1_000)
    await rig.batcher.flush()
    expect(rig.chain.submissions[1]!.count).toBe(133)
  })

  it("an { exists: true } answer leaves the learned cap where the last receipt put it", async () => {
    const rig = makeRig({ cap: 480 })
    rig.chain.gasUsedFor = (batch) => 100_000n * BigInt(batch.length)
    const first = Array.from({ length: 401 }, () => makeSave())
    for (const { wire, meta } of first) await rig.enqueue(wire, meta.contextId)
    await rig.batcher.flush()
    expect(rig.chain.submissions[0]!.count).toBe(401) // the receipt taught cap = 266

    // The next batch lands as a resubmit — the fake records it (the send DID land) but answers
    // exists:true, which carries no receipt to re-size from.
    rig.chain.reportExists = true
    rig.setNow(1_000)
    const second = Array.from({ length: 300 }, () => makeSave())
    for (const { wire, meta } of second) await rig.enqueue(wire, meta.contextId)
    await rig.batcher.flush()
    expect(rig.chain.batches.size).toBe(2)
    expect(rig.events.filter((entry) => entry["event"] === "batch.submitted").at(-1)).toMatchObject({
      exists: true,
      cap: 266,
      gasPerSave: null,
    })

    rig.chain.reportExists = false
    rig.setNow(2_000)
    const third = Array.from({ length: 300 }, () => makeSave())
    for (const { wire, meta } of third) await rig.enqueue(wire, meta.contextId)
    await rig.batcher.flush()
    // 266 again — the learned cap survived the receipt-less answer; it did not reset to 480.
    expect(rig.chain.submissions.at(-1)!.count).toBe(266)
  })

  it("a gas refusal carrying the node's estimate shrinks to the implied fit — 400 at twice the budget takes 190, not a halving's 200 or a blind retry's 400", async () => {
    const rig = makeRig({ cap: 480 })
    const saves = Array.from({ length: 400 }, () => makeSave())
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    // The refusal carries what checked() attached: this take would have cost 2× the budget —
    // 140,000 per save — so the next take is floor(26,600,000 / 140,000) = 190 exactly.
    rig.chain.failSubmit = () => {
      const error = new MidaError("GAS_CEILING_EXCEEDED", "batch.submit: estimate 56000000 exceeds ceiling 28000000")
      error.estimate = 56_000_000n
      error.ceiling = 28_000_000n
      return error
    }
    await rig.batcher.flush()
    expect(rig.events.filter((entry) => entry["event"] === "batch.too-large").at(-1)).toMatchObject({ requeued: 400, cap: 190 })

    rig.chain.failSubmit = null
    await rig.batcher.flush()
    expect(rig.chain.submissions[0]!.count).toBe(190)
  })

  it("a refusal whose estimate cannot shrink the take still halves — the next take is always smaller", async () => {
    const rig = makeRig({ cap: 480 })
    const saves = Array.from({ length: 300 }, () => makeSave())
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    // An estimate too small to be this batch's real one implies a fit above the take itself —
    // the batcher halves rather than trusting a number that would not make progress.
    rig.chain.failSubmit = () => {
      const error = new MidaError("GAS_CEILING_EXCEEDED", "batch.submit: estimate exceeds ceiling")
      error.estimate = 100n
      error.ceiling = 28_000_000n
      return error
    }
    await rig.batcher.flush()
    expect(rig.events.filter((entry) => entry["event"] === "batch.too-large").at(-1)).toMatchObject({ requeued: 300, cap: 200 })
  })

  it("an ambiguous send — recorded, then its answer lost — heals through the next batch's ALREADY_ANCHORED", async () => {
    const rig = makeRig()
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    rig.chain.afterRecord = () => {
      throw new Error("the response never arrived")
    }

    await rig.batcher.flush()
    // The batch landed (the fake recorded it) but the batcher saw only a failure: rows requeued.
    expect(rig.chain.batches.size).toBe(1)
    expect((await rig.store.get(meta.contextId))!.state).toBe("QUEUED")

    rig.chain.afterRecord = null
    await rig.batcher.flush()
    // The resubmission is a NEW batchId; the contract rejects the save ALREADY_ANCHORED, and
    // resolve() heals the row onto the earlier batch's proof — batchId stays the first batch's.
    expect(rig.chain.submissions).toHaveLength(2)
    const row = (await rig.store.get(meta.contextId))!
    const firstBatchId = rig.chain.submissions[0]!.batchId.toLowerCase()
    expect(row.state).toBe("ANCHORED")
    expect(row.batchId).toBe(firstBatchId)
    expect(row.position).toBe(0)
    const earlier = await rig.chain.batchOf(firstBatchId as Hex)
    expect(verifyMerkleProof(leafOf(meta), row.proof!, earlier.root)).toBe(true)
    expect(await rig.journal.list()).toEqual([])
  })

  it("a resubmitted batchId resolves the existing batch instead of sending again", async () => {
    // A fixed salt makes the id derivable on purpose: sequence 1 under salt A is the same batchId
    // twice — the state a crash after nextSequence but before its meta write would leave behind.
    const salts = [`0x${"aa".repeat(32)}` as Hex, `0x${"aa".repeat(32)}` as Hex, `0x${"bb".repeat(32)}` as Hex]
    let saltCall = 0
    const rig = makeRig({ salt: () => salts[saltCall++]! })
    const first = makeSave()
    await rig.enqueue(first.wire, first.meta.contextId)
    await rig.batcher.flush()
    expect(rig.chain.batches.size).toBe(1)
    const batchId = rig.chain.submissions[0]!.batchId

    rig.store.sequence = 0n
    rig.setNow(1_000)
    const second = makeSave()
    await rig.enqueue(second.wire, second.meta.contextId)
    await rig.batcher.flush()

    expect(rig.chain.attempts).toBe(2)
    expect(rig.chain.batches.size).toBe(1)
    // The batch the contract holds names different saves than the fresh journal entry — the journal
    // cannot prove the batch belongs to these rows, so the new row comes back QUEUED rather than
    // staying SUBMITTED forever (the first row was already anchored by the first run).
    expect((await rig.store.get(first.meta.contextId))!).toMatchObject({ state: "ANCHORED", batchId })
    expect((await rig.store.get(second.meta.contextId))!).toMatchObject({ state: "QUEUED", batchId: null })
    expect(await rig.journal.list()).toEqual([])

    // The next run picks a fresh id (salt B) and anchors the requeued row — past minGapMs first.
    rig.setNow(2_000)
    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(2)
    expect(rig.chain.submissions[1]!.batchId).not.toBe(batchId)
    expect((await rig.store.get(second.meta.contextId))!).toMatchObject({ state: "ANCHORED" })
  })

  it("a foreign batch that pre-claimed the id is not ours — no row takes its outcomes, all requeue and anchor under a fresh id", async () => {
    const salts = [`0x${"aa".repeat(32)}` as Hex, `0x${"bb".repeat(32)}` as Hex]
    let saltCall = 0
    const rig = makeRig({ salt: () => salts[saltCall++]! })
    const first = makeSave()
    const second = makeSave()
    await rig.enqueue(first.wire, first.meta.contextId)
    await rig.enqueue(second.wire, second.meta.contextId)

    // The attack: the id for (submitter, sequence 1, salt A) is computable ahead of time, and the
    // contract's submitBatch has no caller check — an attacker lands a junk batch under it first.
    const ATTACKER = "0x7777777777777777777777777777777777777777" as Address
    const predictedId = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [SUBMITTER, 1n, salts[0]!]),
    )
    const junk = makeSave()
    rig.chain.submitter = ATTACKER
    rig.chain.rejectWith = () => BATCH_REJECT.BAD_SIGNER // the attacker's save fails on chain
    await rig.chain.submit(predictedId, [junk.wire])
    rig.chain.submitter = SUBMITTER
    rig.chain.rejectWith = () => null

    // Our run hits BatchExists → resolves against THEIR batch — and must take none of its outcomes.
    const result = await rig.batcher.run()
    expect(result).toMatchObject({ batchId: predictedId, accepted: 0, rejected: 0 })
    expect(rig.chain.batches.size).toBe(1) // still only the attacker's
    for (const { meta } of [first, second]) {
      expect((await rig.store.get(meta.contextId))!).toMatchObject({ state: "QUEUED", batchId: null, reason: null })
    }
    expect(await rig.journal.list()).toEqual([])
    const event = rig.events.find((entry) => entry["event"] === "batch.not-ours")
    expect(event).toMatchObject({ batchId: predictedId, requeued: 2, message: `batch ${predictedId} is not ours — requeued` })

    // The next run picks a fresh (unsalted-by-the-attacker) id and anchors both rows under it —
    // past minGapMs first, or the flush only schedules a wakeup.
    rig.setNow(1_000)
    await rig.batcher.flush()
    expect(rig.chain.submissions).toHaveLength(2)
    const ours = rig.chain.submissions[1]!.batchId
    expect(ours).not.toBe(predictedId)
    for (const { meta } of [first, second]) {
      expect((await rig.store.get(meta.contextId))!).toMatchObject({ state: "ANCHORED", batchId: ours.toLowerCase() })
    }
  })

  it("a landed batch whose event the log index has not caught up to is unproven, not foreign — resolve throws, keeps rows SUBMITTED and the journal, and a later resolve anchors", async () => {
    const rig = makeRig()
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    // The lag window the bug lived in: batchOf already answers for the batch while the index
    // still returns nothing for its events. The old rule read that as "not ours" and requeued —
    // paying for a second send of a batch that had already landed.
    rig.chain.indexLag = true

    await expect(rig.batcher.run()).rejects.toThrowError(/PARTIAL_READ|cannot be proven/)
    expect((await rig.store.get(meta.contextId))!.state).toBe("SUBMITTED")
    expect(await rig.journal.list()).toHaveLength(1)
    expect(rig.events.some((entry) => entry["event"] === "batch.not-ours")).toBe(false)
    expect(rig.events.some((entry) => entry["event"] === "batch.unproven")).toBe(true)

    // When the index catches up, the journaled batch resolves the row on the very next recover().
    rig.chain.indexLag = false
    const batchId = rig.chain.submissions[0]!.batchId
    await rig.batcher.recover()
    expect((await rig.store.get(meta.contextId))!).toMatchObject({ state: "ANCHORED", batchId: batchId.toLowerCase() })
    expect(await rig.journal.list()).toEqual([])
  })

  it("an anchored-log set shorter than the batch's acceptedCount throws — a hole in the read is not proof the batch is foreign", async () => {
    const rig = makeRig()
    const saves = [makeSave(), makeSave()]
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)
    rig.chain.anchoredDrop = 1 // the index hands back one of the batch's two SaveAnchored logs

    await expect(rig.batcher.run()).rejects.toThrowError(BatchRootMismatchError)
    for (const { meta } of saves) expect((await rig.store.get(meta.contextId))!.state).toBe("SUBMITTED")
    expect(await rig.journal.list()).toHaveLength(1)
    expect(rig.events.some((entry) => entry["event"] === "batch.not-ours")).toBe(false)
  })

  it("a partial batch anchors accepted rows with verifying proofs and names the rejected rows' reasons", async () => {
    const rig = makeRig()
    rig.chain.rejectWith = (_wire, index) => (index === 1 ? BATCH_REJECT.STALE_PARENT : index === 3 ? BATCH_REJECT.NO_AUTHORITY : null)
    const saves = [makeSave(), makeSave(), makeSave(), makeSave()]
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    const result = await rig.batcher.run()
    expect(result).toMatchObject({ accepted: 2, rejected: 2 })
    const batchId = result!.batchId
    const batch = await rig.chain.batchOf(batchId)

    const anchoredPositions = [0, 1]
    for (const [i, acceptedIndex] of [0, 2].entries()) {
      const row = (await rig.store.get(saves[acceptedIndex]!.meta.contextId))!
      expect(row).toMatchObject({ state: "ANCHORED", batchId, position: anchoredPositions[i], lineageId: saves[acceptedIndex]!.meta.lineageId, version: 1 })
      expect(verifyMerkleProof(leafOf(saves[acceptedIndex]!.meta), row.proof!, batch.root)).toBe(true)
    }
    expect((await rig.store.get(saves[1]!.meta.contextId))!).toMatchObject({ state: "REJECTED", reason: "STALE_PARENT" })
    expect((await rig.store.get(saves[3]!.meta.contextId))!).toMatchObject({ state: "REJECTED", reason: "NO_AUTHORITY" })
  })

  it("a batch where every save is rejected still resolves — the empty leaf set's root is zero", async () => {
    const rig = makeRig()
    rig.chain.rejectWith = () => BATCH_REJECT.BAD_EPOCH
    const saves = [makeSave(), makeSave()]
    for (const { wire, meta } of saves) await rig.enqueue(wire, meta.contextId)

    const result = await rig.batcher.run()
    expect(result).toMatchObject({ accepted: 0, rejected: 2 })
    expect((await rig.chain.batchOf(result!.batchId)).root).toBe(zeroHash)
    for (const { meta } of saves) {
      expect((await rig.store.get(meta.contextId))!).toMatchObject({ state: "REJECTED", reason: "BAD_EPOCH" })
    }
    expect(await rig.journal.list()).toEqual([])
  })

  it("logs that do not rebuild to the on-chain root are ROOT_MISMATCH — rows stay SUBMITTED and recoverable", async () => {
    const rig = makeRig()
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    rig.chain.rootOverride = `0x${"ff".repeat(32)}` as Hex

    await expect(rig.batcher.run()).rejects.toThrowError(BatchRootMismatchError)
    expect((await rig.store.get(meta.contextId))!.state).toBe("SUBMITTED")
    expect(await rig.journal.list()).toHaveLength(1)
    expect(rig.events.some((event) => event["event"] === "batch.root-mismatch")).toBe(true)

    // Once the chain answers honestly again, the journaled batch resolves on the next recover().
    rig.chain.rootOverride = null
    const recovered = makeRig({ store: rig.store, chain: rig.chain, journal: rig.journal })
    await recovered.batcher.recover()
    expect((await rig.store.get(meta.contextId))!.state).toBe("ANCHORED")
    expect(await rig.journal.list()).toEqual([])
  })

  it("a logged leaf that contradicts the stored save is a root mismatch, not an anchor", async () => {
    const rig = makeRig()
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    // The root still rebuilds (leafHash bytes are intact) but the leaf the row recomputes —
    // with the log's tampered lineageId — does not match it.
    rig.chain.tamperField = "lineageId"

    await expect(rig.batcher.run()).rejects.toThrowError(BatchRootMismatchError)
    expect((await rig.store.get(meta.contextId))!.state).toBe("SUBMITTED")
    expect(rig.events.some((event) => event["event"] === "batch.leaf-mismatch")).toBe(true)
  })

  it("recover() hands a journaled batch the chain never recorded back to the queue", async () => {
    const rig = makeRig()
    const { wire, meta } = makeSave()
    await rig.enqueue(wire, meta.contextId)
    // The crash state, made by hand: the row was taken under a batchId and journaled, the send
    // never went out — the chain has no trace of it.
    const batchId = `0x${"cc".repeat(32)}` as Hex
    const taken = await rig.store.takeQueued(8, batchId)
    await rig.journal.record(batchId, taken.map((row) => row.contextId))

    await rig.batcher.recover()
    expect((await rig.store.get(meta.contextId))!).toMatchObject({ state: "QUEUED", batchId: null })
    expect(await rig.journal.list()).toEqual([])
    // A queue that came back arms the wait timer again.
    expect(rig.timer.pending()).toBe(true)
  })

  it("a restart between journal-write and submit ends with the rows queued and then anchored", async () => {
    const store = new MemoryBatchStore()
    const journal = new MemoryBatchJournal()
    const chain = new FakeChain()
    const { wire, meta } = makeSave()
    await store.insert(queueRow(wire, meta.contextId, 0))

    // The dead process took the row and journaled it; chain.submit never ran.
    const deadId = `0x${"dd".repeat(32)}` as Hex
    const taken = await store.takeQueued(8, deadId)
    await journal.record(deadId, taken.map((row) => row.contextId))

    const rig = makeRig({ store, journal, chain })
    await rig.batcher.recover()
    expect((await store.get(meta.contextId))!).toMatchObject({ state: "QUEUED", batchId: null })
    expect(chain.batches.size).toBe(0)

    await rig.batcher.flush()
    expect(chain.batches.size).toBe(1)
    expect((await store.get(meta.contextId))!.state).toBe("ANCHORED")
  })

  it("a restart between submit and resolve finishes the writeback — rejections map through the journal", async () => {
    const store = new MemoryBatchStore()
    const journal = new MemoryBatchJournal()
    const chain = new FakeChain()
    chain.rejectWith = (_wire, index) => (index === 1 ? BATCH_REJECT.STALE_PARENT : null)
    const saves = [makeSave(), makeSave(), makeSave()]
    for (let i = 0; i < saves.length; i++) await store.insert(queueRow(saves[i]!.wire, saves[i]!.meta.contextId, i))

    // The dead process: submit landed, the resolve's log reads failed, the object died holding
    // only the journal.
    chain.failLogs = true
    const dead = makeRig({ store, journal, chain })
    await expect(dead.batcher.run()).rejects.toThrowError("log read failed")
    for (const { meta } of saves) expect((await store.get(meta.contextId))!.state).toBe("SUBMITTED")
    expect(await journal.list()).toHaveLength(1)

    // The new process knows nothing in memory — the journal is the only map from index to row.
    chain.failLogs = false
    const alive = makeRig({ store, journal, chain })
    await alive.batcher.recover()

    const batchId = chain.submissions[0]!.batchId
    const batch = await chain.batchOf(batchId)
    for (const index of [0, 2]) {
      const row = (await store.get(saves[index]!.meta.contextId))!
      expect(row).toMatchObject({ state: "ANCHORED", batchId })
      expect(verifyMerkleProof(leafOf(saves[index]!.meta), row.proof!, batch.root)).toBe(true)
    }
    expect((await store.get(saves[1]!.meta.contextId))!).toMatchObject({ state: "REJECTED", reason: "STALE_PARENT" })
    expect(await journal.list()).toEqual([])
  })

  it("resolve() on a batchId the chain never saw refuses with NOT_FOUND", async () => {
    const rig = makeRig()
    await expect(rig.batcher.resolve(`0x${"00".repeat(32)}` as Hex)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

/**
 * B2: the windows the real adapter opens. A stub JSON-RPC server stands in for the BatchAnchor
 * contract — it answers batchOf and returns properly-encoded event logs — and records the
 * fromBlock/toBlock of every eth_getLogs, so the test sees exactly which blocks were scanned.
 */
describe("createBatcherChain's log windows", () => {
  const BATCH_BLOCK = 4_242n
  const ANCHOR_BLOCK = 3_000n // the anchor's own deploy block, later than the registries'
  const DEPLOY_BLOCK = 100n
  const HEAD = 5_000n

  it("resolve scans only the batch's own block; findAnchoring still scans from the anchor's deploy block", async () => {
    const { wire, meta } = makeSave()
    const batchId = hexOf(randomBytes(32))
    const leaf = leafOf(meta)
    const root = merkleRoot([leaf])

    const eventTopic = (name: "BatchAnchored" | "SaveAnchored" | "SaveRejected"): Hex =>
      encodeEventTopics({ abi: batchAnchorAbi, eventName: name })[0] as Hex
    const anchoredTopic = eventTopic("SaveAnchored")
    const batchTopic = eventTopic("BatchAnchored")
    const logEntry = (topics: Hex[], data: Hex): Record<string, unknown> => ({
      address: BATCH_ANCHOR,
      blockHash: `0x${"44".repeat(32)}`,
      blockNumber: `0x${BATCH_BLOCK.toString(16)}`,
      data,
      logIndex: "0x0",
      removed: false,
      topics,
      transactionHash: `0x${"ee".repeat(32)}`,
      transactionIndex: "0x0",
    })
    // SaveAnchored(owner, contextId, batchId indexed; namespaceId, lineageId, version, author,
    // position, leafHash in data) — the real encodings, so viem's strict decode sees real args.
    const saveAnchoredLog = logEntry(
      encodeEventTopics({ abi: batchAnchorAbi, eventName: "SaveAnchored", args: { owner: OWNER, contextId: meta.contextId, batchId } }) as Hex[],
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }],
        [NAMESPACE, meta.lineageId, meta.version, meta.agentId, 0, leaf],
      ),
    )
    const batchAnchoredLog = logEntry(
      encodeEventTopics({ abi: batchAnchorAbi, eventName: "BatchAnchored", args: { batchId } }) as Hex[],
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "address" }],
        [root, 1, 0, SUBMITTER],
      ),
    )

    const scans: { fromBlock: bigint; toBlock: bigint; topics: Hex[] }[] = []
    const server: Server = createServer((req, res) => {
      let raw = ""
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
      req.on("end", () => {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown[] }
        const reply = (result: unknown) => {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
        }
        if (method === "eth_chainId") return reply(`0x${CHAIN_ID.toString(16)}`)
        if (method === "eth_blockNumber") return reply(`0x${HEAD.toString(16)}`)
        if (method === "eth_getLogs") {
          const [filter] = params as [{ address: string; topics: Hex[]; fromBlock: Hex; toBlock: Hex }]
          scans.push({ fromBlock: BigInt(filter.fromBlock), toBlock: BigInt(filter.toBlock), topics: filter.topics })
          if (filter.topics[0] === anchoredTopic) return reply([saveAnchoredLog])
          if (filter.topics[0] === batchTopic) return reply([batchAnchoredLog])
          return reply([])
        }
        if (method === "eth_call") {
          const [{ data }] = params as [{ data: Hex }]
          try {
            const call = decodeFunctionData({ abi: batchAnchorAbi, data })
            if (call.functionName === "batchOf") {
              const queried = (call.args as [Hex])[0]
              const answer: [Hex, bigint, number] =
                queried.toLowerCase() === batchId.toLowerCase() ? [root, BATCH_BLOCK, 1] : [zeroHash, 0n, 0]
              return reply(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "uint32" }], answer))
            }
          } catch {
            // falls through to unhandled — an undecodable call is an error response, not a crash
          }
        }
        return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled ${method}` } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = (server.address() as AddressInfo)

    try {
      const rpcDeployment: Deployment = {
        chainId: CHAIN_ID,
        capabilityRegistry: "0x4444444444444444444444444444444444444444",
        contextRegistry: "0x5555555555555555555555555555555555555555",
        deploymentBlock: DEPLOY_BLOCK,
        policyHashV1: `0x${"11".repeat(32)}`,
        vaultRpId: "vault.mida.xyz",
        vaultRpIdHash: `0x${"22".repeat(32)}`,
        batchAnchor: BATCH_ANCHOR,
        batchAnchorBlock: ANCHOR_BLOCK,
      }
      const chain = createBatcherChain({
        rpcUrl: `http://127.0.0.1:${port}`,
        deployment: rpcDeployment,
        account: privateKeyToAccount(`0x${"33".repeat(32)}`),
      })
      const store = new MemoryBatchStore()
      const journal = new MemoryBatchJournal()
      // The state resolve() runs against: one SUBMITTED row under the batchId and the journal's
      // ordered contextIds — what a landed batch leaves behind after a restart.
      await store.insert({ ...queueRow(wire, meta.contextId, 0), state: "SUBMITTED", batchId: batchId.toLowerCase() as Hex })
      await journal.record(batchId, [meta.contextId])
      const batcher = new Batcher({ store, chain, timer: new ManualTimer(), now: () => 0, cap: 8, waitMs: 2_000, submitter: SUBMITTER, journal })

      await batcher.resolve(batchId)
      expect((await store.get(meta.contextId))!.state).toBe("ANCHORED")
      // SaveAnchored + SaveRejected + BatchAnchored: three scans, each exactly the batch's block —
      // never from DEPLOY_BLOCK or ANCHOR_BLOCK, which is what made every resolve a full-history scan.
      expect(scans).toHaveLength(3)
      for (const scan of scans) expect(scan).toMatchObject({ fromBlock: BATCH_BLOCK, toBlock: BATCH_BLOCK })

      // A batchId the chain never recorded answers blockNumber 0 — no log request is even made.
      const unknownId = `0x${"99".repeat(32)}` as Hex
      expect(await chain.anchoredLogs(unknownId)).toEqual([])
      expect(await chain.rejectedLogs(unknownId)).toEqual([])
      expect(await chain.batchAnchored(unknownId)).toBeNull()
      expect(scans).toHaveLength(3)

      // findAnchoring is the historical search for a contextId — it keeps the anchor's deploy
      // block as its floor and reaches chain head (chunked at MAX_LOG_BLOCK_RANGE = 1000).
      expect(await chain.findAnchoring(meta.contextId)).toBe(batchId.toLowerCase())
      expect(scans.slice(3)).toEqual([
        expect.objectContaining({ fromBlock: ANCHOR_BLOCK, toBlock: ANCHOR_BLOCK + 999n }),
        expect.objectContaining({ fromBlock: ANCHOR_BLOCK + 1000n, toBlock: ANCHOR_BLOCK + 1999n }),
        expect.objectContaining({ fromBlock: ANCHOR_BLOCK + 2000n, toBlock: HEAD }),
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
