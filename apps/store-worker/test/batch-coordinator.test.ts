// BatchAnchor Task 6: the Durable Object half of the batcher. A fake DurableObjectState — a Map for
// storage plus an alarm slot — proves the real wiring: notify() arms the storage alarm exactly once
// and never moves it, flush() clears it and runs, alarm() is the batcher's run, the in-flight
// journal lives as keys in ctx.storage, and a freshly-constructed object replays whatever a dead
// one left there before it answers anything (blockConcurrencyWhile).

import { describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import { randomBytes } from "@noble/hashes/utils.js"
import { hexOf } from "@mida/crypto"
import { batchContextId, batchLeafHash, batchSaveStructHash, merkleRoot, namespaceId } from "@mida/protocol"
import type { Address, BatchSaveMessage, Hex } from "@mida/protocol"
import type { AnchoredLog, BatcherChain, BatchStore, RejectedLog } from "@mida/api"
import type { BatchedSaveWire } from "@mida/api"
import type { BatchSaveRow } from "@mida/api"
import { BatchCoordinator } from "../src/batch-coordinator.js"
import type { BatchCoordinatorEnv, DurableObjectStateLike, DurableObjectStorageLike } from "../src/batch-coordinator.js"

const CHAIN_ID = 31337n
const BATCH_ANCHOR = "0x1111111111111111111111111111111111111aa5" as Address
const SUBMITTER = "0x9999999999999999999999999999999999999999" as Address
const OWNER = "0x2222222222222222222222222222222222222222" as Address
const SIGNER = "0x3333333333333333333333333333333333333333" as Address
const AGENT_ID = hexOf(randomBytes(32))
const NAMESPACE = namespaceId("goals.career")

const env: BatchCoordinatorEnv = {
  DB: undefined as never, // never read — every test injects its own store
  RPC_URL: "http://127.0.0.1:8545",
  CHAIN_ID: CHAIN_ID.toString(10),
  CAPABILITY_REGISTRY: "0x4444444444444444444444444444444444444444",
  CONTEXT_REGISTRY: "0x5555555555555555555555555555555555555555",
  DEPLOYMENT_BLOCK: "0",
  POLICY_HASH_V1: `0x${"11".repeat(32)}`,
  VAULT_RP_ID: "vault.mida.xyz",
  VAULT_RP_ID_HASH: `0x${"22".repeat(32)}`,
  BATCH_ANCHOR,
  BATCHER_PRIVATE_KEY: "", // unread while a fake chain is injected
}

interface SaveMeta {
  contextId: Hex
  agentId: Hex
  lineageId: Hex
  version: number
  structHash: Hex
}

const metas = new Map<string, SaveMeta>()

function makeSave(): { wire: BatchedSaveWire; meta: SaveMeta } {
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
  }
  const contextId = batchContextId({
    chainId: CHAIN_ID,
    batchAnchor: BATCH_ANCHOR,
    owner: OWNER,
    agentId: AGENT_ID,
    namespaceId: NAMESPACE,
    parentId: zeroHash,
    objectNonce: message.objectNonce,
  })
  const meta: SaveMeta = {
    contextId,
    agentId: AGENT_ID,
    lineageId: contextId,
    version: 1,
    structHash: batchSaveStructHash(message),
  }
  metas.set(message.objectNonce.toLowerCase(), meta)
  return {
    wire: {
      message: { ...message, readEpoch: "1", expiresAt: "0" },
      signature: `0x${"ab".repeat(65)}` as Hex,
      manifest: { contextId } as unknown as BatchedSaveWire["manifest"],
      ciphertext: "0xbeef" as Hex,
    },
    meta,
  }
}

/** ctx.storage as a Map plus one alarm slot — the exact surface the coordinator is built on. */
class FakeStorage implements DurableObjectStorageLike {
  readonly data = new Map<string, unknown>()
  alarmAt: number | null = null

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key)
  }

  async list(options?: { prefix?: string }): Promise<Map<string, unknown>> {
    const prefix = options?.prefix ?? ""
    return new Map([...this.data.entries()].filter(([key]) => key.startsWith(prefix)))
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = typeof at === "number" ? at : at.getTime()
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null
  }
}

/**
 * The object state. `storage` is a constructor parameter so a "restarted" object can sit on the
 * same storage as the dead one — which is what eviction actually preserves. blockConcurrencyWhile
 * is captured so the test can await construction recovery.
 */
class FakeState implements DurableObjectStateLike {
  ready: Promise<void> = Promise.resolve()

  constructor(readonly storage: FakeStorage = new FakeStorage()) {}

  blockConcurrencyWhile(callback: () => Promise<void>): void {
    this.ready = callback()
  }
}

const byAge = (a: BatchSaveRow, b: BatchSaveRow): number => a.receivedAt - b.receivedAt || a.contextId.localeCompare(b.contextId)

/** Minimal BatchStore — the same QUEUED → SUBMITTED → ANCHORED/REJECTED state machine as D1's. */
class FakeStore implements BatchStore {
  readonly rows = new Map<string, BatchSaveRow>()
  sequence = 0n
  readonly flushes = new Map<string, number>()
  private clock = 0

  async enqueue(wire: BatchedSaveWire, contextId: Hex): Promise<void> {
    await this.insert({
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
      receivedAt: this.clock++,
      anchoredAt: null,
    })
  }

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

/** The accept-everything contract: real leaf hashes and a real Merkle root, ALREADY_ANCHORED on a repeat. */
class FakeChain implements BatcherChain {
  readonly submissions: Hex[] = []
  private readonly anchoredIn = new Map<string, Hex>()
  private blockCounter = 100n
  private readonly recorded = new Map<
    string,
    { anchored: AnchoredLog[]; rejected: RejectedLog[]; root: Hex; blockNumber: bigint; acceptedCount: number; submitter: Address }
  >()
  /** Return a BATCH_REJECT code for a submitted-array index, or null to accept. */
  rejectAt: ((index: number) => number | null) | null = null
  /** Who submit() records as the batch sender — the real chain stores msg.sender. */
  submitter: Address = SUBMITTER
  failLogs = false

  async submit(batchId: Hex, saves: BatchedSaveWire[]): Promise<{ transactionHash: Hex; gasUsed: bigint } | { exists: true }> {
    const key = batchId.toLowerCase() as Hex
    if (this.recorded.has(key)) return { exists: true }
    this.submissions.push(batchId)
    const anchored: AnchoredLog[] = []
    const rejected: RejectedLog[] = []
    saves.forEach((wire, index) => {
      const meta = metas.get(wire.message.objectNonce.toLowerCase())
      if (meta === undefined) throw new Error("test bug: undescribed save")
      const reason = this.anchoredIn.has(meta.contextId.toLowerCase()) ? 6 : (this.rejectAt?.(index) ?? null)
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
        leafHash: batchLeafHash({ contextId: meta.contextId, agentId: meta.agentId, lineageId: meta.lineageId, version: meta.version, structHash: meta.structHash }),
      })
      this.anchoredIn.set(meta.contextId.toLowerCase(), key)
    })
    this.recorded.set(key, {
      anchored,
      rejected,
      root: anchored.length === 0 ? zeroHash : merkleRoot(anchored.map((log) => log.leafHash)),
      blockNumber: this.blockCounter++,
      acceptedCount: anchored.length,
      submitter: this.submitter,
    })
    return { transactionHash: `0x${"ee".repeat(32)}` as Hex, gasUsed: 60_000n * BigInt(saves.length) }
  }

  async anchoredLogs(batchId: Hex): Promise<AnchoredLog[]> {
    if (this.failLogs) throw new Error("log read failed")
    return this.recorded.get(batchId.toLowerCase())?.anchored ?? []
  }

  async rejectedLogs(batchId: Hex): Promise<RejectedLog[]> {
    if (this.failLogs) throw new Error("log read failed")
    return this.recorded.get(batchId.toLowerCase())?.rejected ?? []
  }

  async batchAnchored(batchId: Hex): Promise<{ submitter: Address; acceptedCount: number; rejectedCount: number } | null> {
    if (this.failLogs) throw new Error("log read failed")
    const batch = this.recorded.get(batchId.toLowerCase())
    if (batch === undefined) return null
    return { submitter: batch.submitter, acceptedCount: batch.acceptedCount, rejectedCount: batch.rejected.length }
  }

  async batchOf(batchId: Hex): Promise<{ root: Hex; blockNumber: bigint; acceptedCount: number }> {
    const batch = this.recorded.get(batchId.toLowerCase())
    if (batch === undefined) return { root: zeroHash, blockNumber: 0n, acceptedCount: 0 }
    return { root: batch.root, blockNumber: batch.blockNumber, acceptedCount: batch.acceptedCount }
  }

  async findAnchoring(contextId: Hex): Promise<Hex | null> {
    return this.anchoredIn.get(contextId.toLowerCase()) ?? null
  }
}

const post = (path: string) => new Request(`https://batcher.internal${path}`, { method: "POST" })

describe("the batch coordinator Durable Object", () => {
  it("notify() arms the storage alarm once and never moves it; alarm() runs the batch", async () => {
    const ctx = new FakeState()
    const store = new FakeStore()
    const chain = new FakeChain()
    const coordinator = new BatchCoordinator(ctx, env, { store, chain, submitter: SUBMITTER, cap: 8, waitMs: 2_000, minGapMs: 1_000, now: () => 10_000 })
    await ctx.ready

    const { wire, meta } = makeSave()
    await store.enqueue(wire, meta.contextId)
    const response = await coordinator.fetch(post("/notify"))
    expect(response.status).toBe(200)
    expect(ctx.storage.alarmAt).toBe(12_000)

    // Two more saves, two more notifies: the armed alarm is a promise — it does not move.
    for (const _ of [0, 1]) {
      const save = makeSave()
      await store.enqueue(save.wire, save.meta.contextId)
      await coordinator.fetch(post("/notify"))
    }
    expect(ctx.storage.alarmAt).toBe(12_000)
    expect(chain.submissions).toHaveLength(0)

    await coordinator.alarm()
    expect(chain.submissions).toHaveLength(1)
    expect((await store.get(meta.contextId))!.state).toBe("ANCHORED")
    // After the drain the journal is gone and no alarm is left armed on an empty queue.
    expect([...(await ctx.storage.list({ prefix: "journal/" })).keys()]).toHaveLength(0)
    expect(ctx.storage.alarmAt).toBeNull()
  })

  it("flush() deletes the pending alarm and runs immediately", async () => {
    const ctx = new FakeState()
    const store = new FakeStore()
    const chain = new FakeChain()
    const coordinator = new BatchCoordinator(ctx, env, { store, chain, submitter: SUBMITTER, cap: 8 })
    await ctx.ready

    const { wire, meta } = makeSave()
    await store.enqueue(wire, meta.contextId)
    await coordinator.fetch(post("/notify"))
    expect(ctx.storage.alarmAt).not.toBeNull()

    const response = await coordinator.fetch(post("/flush"))
    expect(response.status).toBe(200)
    expect(ctx.storage.alarmAt).toBeNull()
    expect(chain.submissions).toHaveLength(1)
    expect((await store.get(meta.contextId))!.state).toBe("ANCHORED")
  })

  it("a fresh object replays the journal in storage before answering: a never-sent batch requeues", async () => {
    const ctx = new FakeState()
    const store = new FakeStore()
    const chain = new FakeChain()
    const { wire, meta } = makeSave()
    await store.enqueue(wire, meta.contextId)

    // The dead object's state, planted: the row was taken under a batchId and journaled to
    // ctx.storage, and the submit never reached the chain.
    const deadId = `0x${"dd".repeat(32)}` as Hex
    const taken = await store.takeQueued(8, deadId)
    await ctx.storage.put(`journal/${deadId}`, taken.map((row) => row.contextId))

    const coordinator = new BatchCoordinator(ctx, env, { store, chain, submitter: SUBMITTER, cap: 8 })
    await ctx.ready
    expect((await store.get(meta.contextId))!).toMatchObject({ state: "QUEUED", batchId: null })
    expect([...(await ctx.storage.list({ prefix: "journal/" })).keys()]).toHaveLength(0)
    // The queue coming back re-arms the wait alarm on the recovered object.
    expect(ctx.storage.alarmAt).not.toBeNull()
    await coordinator.alarm()
    expect(chain.submissions).toHaveLength(1)
  })

  it("a fresh object finishes a batch that landed before its predecessor died — rejections map by journal order", async () => {
    const store = new FakeStore()
    const chain = new FakeChain()
    chain.rejectAt = (index) => (index === 1 ? 7 : null)
    const dead = new FakeState()
    const deadCoordinator = new BatchCoordinator(dead, env, { store, chain, submitter: SUBMITTER, cap: 8 })
    await dead.ready
    const saves = [makeSave(), makeSave()]
    await store.enqueue(saves[0]!.wire, saves[0]!.meta.contextId)
    await store.enqueue(saves[1]!.wire, saves[1]!.meta.contextId)

    // The submit lands; the resolve's log reads fail; the object dies with the journal entry held.
    chain.failLogs = true
    await expect(deadCoordinator.fetch(post("/flush"))).rejects.toThrowError("log read failed")
    expect((await store.get(saves[0]!.meta.contextId))!.state).toBe("SUBMITTED")
    expect([...(await dead.storage.list({ prefix: "journal/" })).keys()]).toHaveLength(1)

    // A new object on the SAME storage (what eviction preserves) recovers the journaled batch and
    // finishes the writeback — the rejected index resolves through the journaled order, not memory.
    chain.failLogs = false
    const alive = new FakeState(dead.storage)
    const coordinator = new BatchCoordinator(alive, env, { store, chain, submitter: SUBMITTER, cap: 8 })
    await alive.ready

    expect((await store.get(saves[0]!.meta.contextId))!).toMatchObject({ state: "ANCHORED", batchId: chain.submissions[0]!.toLowerCase() })
    expect((await store.get(saves[1]!.meta.contextId))!).toMatchObject({ state: "REJECTED", reason: "STALE_PARENT" })
    expect([...(await alive.storage.list({ prefix: "journal/" })).keys()]).toHaveLength(0)
    expect(coordinator).toBeDefined()
  })

  it("BATCH_ANCHOR_BLOCK must be an integer — a non-numeric value fails the object's construction", async () => {
    // No chain override: the constructor builds the real adapter, which is where the env parse
    // lives — the deployment only assembles when BATCHER_PRIVATE_KEY is also valid.
    const keyedEnv: BatchCoordinatorEnv = { ...env, BATCHER_PRIVATE_KEY: `0x${"44".repeat(32)}` }
    expect(
      () => new BatchCoordinator(new FakeState(), { ...keyedEnv, BATCH_ANCHOR_BLOCK: "soon" }, { store: new FakeStore() }),
    ).toThrow("BATCH_ANCHOR_BLOCK")

    // A numeric value constructs: the coordinator's deployment carries it as batchAnchorBlock.
    const ctx = new FakeState()
    const coordinator = new BatchCoordinator(ctx, { ...keyedEnv, BATCH_ANCHOR_BLOCK: "4242" }, { store: new FakeStore() })
    await ctx.ready
    expect(coordinator).toBeDefined()
  })

  it("answers 404 on a path it does not own", async () => {
    const ctx = new FakeState()
    const coordinator = new BatchCoordinator(ctx, env, { store: new FakeStore(), chain: new FakeChain(), submitter: SUBMITTER })
    await ctx.ready
    expect((await coordinator.fetch(post("/healthz"))).status).toBe(404)
  })
})
