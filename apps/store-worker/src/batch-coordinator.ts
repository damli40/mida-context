// BatchAnchor Task 6: the hosted batcher, as a Durable Object. One object — the Worker binds it
// under the name "batcher" — owns the queue end to end:
//
// - The Worker forwards every accepted save's wakeup (POST /notify) and every signed flush
//   (POST /flush) here, so there is exactly one process that ever reads the QUEUED table.
// - The wait timer is the storage alarm — `ctx.storage.setAlarm` survives the object being
//   evicted, which a setTimeout never would, and alarm() is the batcher's run().
// - The in-flight journal is ctx.storage: batchId → ordered contextIds, written BEFORE the
//   submit goes out. If the object dies mid-batch the next construction's recover() — run under
//   blockConcurrencyWhile so no request ever sees a half-recovered queue — finds it and either
//   finishes the writeback or hands the rows back to QUEUED.
//
// The object never looks at BATCHING_ENABLED: the flag gates admission in the routes, and what is
// already queued is owed a batch either way.

import { privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import type { Address, Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { Batcher, createBatcherChain } from "@mida/api"
import type { BatchAttempt, BatchJournal, BatcherChain, BatcherTimer, BatchStore } from "@mida/api"
import { D1BatchStore } from "./d1.js"
import type { D1Like } from "./d1.js"

/**
 * The slice of DurableObjectState.storage the batcher uses — alarms for the timer, get/put/delete/
 * list for the journal. Structural, so tests hand over a fake without the workerd types.
 */
export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike
  blockConcurrencyWhile(callback: () => Promise<void>): void
}

/** The environment the coordinator reads — a subset of WorkerEnv, kept structural for tests. */
export interface BatchCoordinatorEnv {
  DB: D1Like
  RPC_URL: string
  CHAIN_ID: string
  CAPABILITY_REGISTRY: string
  CONTEXT_REGISTRY: string
  DEPLOYMENT_BLOCK: string
  POLICY_HASH_V1: string
  VAULT_RP_ID: string
  VAULT_RP_ID_HASH: string
  BATCH_ANCHOR: string
  BATCHER_PRIVATE_KEY: string
  /**
   * Read only for the BATCH_ANCHOR_BLOCK check below: a malformed block value refuses the object
   * while the lane is on, but not after it goes off — workerd can rebuild the object on a stale
   * alarm, and a queue it owes a batch must not wedge on a placeholder string. The flag gates
   * nothing else here; admission is the routes' job.
   */
  BATCHING_ENABLED?: string
  /** The block BatchAnchor was deployed in — the floor for historical SaveAnchored scans. */
  BATCH_ANCHOR_BLOCK?: string
}

/**
 * The hard upper bound on saves per batch. Monad refuses any transaction over 30,000,000 gas
 * (docs.monad.xyz gas-pricing) and the "batch.submit" ceiling budgets 28,000,000 — at the sweep's
 * lowest measured per-save cost (61,457 gas; docs/evidence/batch-anchor-sweep-2026-09-24.json)
 * the bound is floor(28,000,000 × 0.95 / 61,457) = 432. That per-save figure is a ONE-OWNER
 * number: a batch of first-time owners runs ~166k gas per save on testnet
 * (docs/evidence/batch-anchor-multi-owner-2026-09-24.json), so a full 432 of those would not
 * fit — mixed/new-owner batches are kept inside the budget by the learned gas sizing and the
 * refusal shrink, not by this bound. 480 only LOOKED safe (~29.5M): it crosses the ceiling the
 * estimate is checked against. The batcher sizes each take by a learned gas budget below this
 * bound; the cap only guards a measurement that lies.
 */
const BATCH_CAP = 432
const BATCH_WAIT_MS = 2_000
const BATCH_MIN_GAP_MS = 1_000

const JOURNAL_PREFIX = "journal/"
const ATTEMPT_PREFIX = "journal-attempts/"

/**
 * The in-flight journal on ctx.storage: one key per in-flight batchId holding the submitted
 * array's ordered contextIds — the only map from a SaveRejected.index back to a row after a
 * restart, and the only list recover() has of batches a dead object left behind. Attempt records
 * live under a second prefix so the list/contextIds shape old entries already stored is unchanged.
 */
export class DurableObjectBatchJournal implements BatchJournal {
  constructor(readonly storage: DurableObjectStorageLike) {}

  async list(): Promise<Hex[]> {
    const entries = await this.storage.list({ prefix: JOURNAL_PREFIX })
    return [...entries.keys()].map((key) => key.slice(JOURNAL_PREFIX.length) as Hex)
  }

  async record(batchId: Hex, contextIds: Hex[]): Promise<void> {
    await this.storage.put(`${JOURNAL_PREFIX}${batchId.toLowerCase()}`, [...contextIds])
  }

  async contextIds(batchId: Hex): Promise<Hex[] | null> {
    return (await this.storage.get<Hex[]>(`${JOURNAL_PREFIX}${batchId.toLowerCase()}`)) ?? null
  }

  async attempt(batchId: Hex): Promise<BatchAttempt | null> {
    return (await this.storage.get<BatchAttempt>(`${ATTEMPT_PREFIX}${batchId.toLowerCase()}`)) ?? null
  }

  async noteAttempt(batchId: Hex, atMs: number): Promise<void> {
    const key = `${ATTEMPT_PREFIX}${batchId.toLowerCase()}`
    const prev = await this.storage.get<BatchAttempt>(key)
    await this.storage.put(key, { firstAt: prev?.firstAt ?? atMs, lastAt: atMs, count: (prev?.count ?? 0) + 1 })
  }

  async clear(batchId: Hex): Promise<void> {
    await this.storage.delete(`${JOURNAL_PREFIX}${batchId.toLowerCase()}`)
    await this.storage.delete(`${ATTEMPT_PREFIX}${batchId.toLowerCase()}`)
  }
}

/** The wait timer as the object's storage alarm: `pending` asks whether an alarm is armed. */
export function alarmTimer(storage: DurableObjectStorageLike): BatcherTimer {
  return {
    set: (atMs) => storage.setAlarm(atMs),
    clear: () => storage.deleteAlarm(),
    pending: async () => (await storage.getAlarm()) !== null,
  }
}

/** Test seam — the real chain and store can be swapped for fakes without touching the timer or journal wiring. */
export interface BatchCoordinatorOverrides {
  chain?: BatcherChain
  store?: BatchStore
  submitter?: Address
  cap?: number
  waitMs?: number
  minGapMs?: number
  now?: () => number
}

function coordinatorDeployment(env: BatchCoordinatorEnv): Deployment {
  const rawAnchorBlock = env.BATCH_ANCHOR_BLOCK
  const numeric = rawAnchorBlock !== undefined && /^(0|[1-9][0-9]*)$/.test(rawAnchorBlock)
  // A malformed value refuses construction only while the lane is enabled — the worker's own boot
  // check fails such an env before any notify reaches here. Disabled, the value is ignored: a
  // missing floor just means historical scans start at deploymentBlock, never below it.
  if (rawAnchorBlock !== undefined && rawAnchorBlock !== "" && !numeric) {
    if (env.BATCHING_ENABLED === "true") throw new Error("BATCH_ANCHOR_BLOCK must be a non-negative integer")
    console.log(JSON.stringify({ component: "batch-coordinator", event: "batch.anchor-block-ignored" }))
  }
  return {
    chainId: BigInt(env.CHAIN_ID),
    capabilityRegistry: env.CAPABILITY_REGISTRY as Address,
    contextRegistry: env.CONTEXT_REGISTRY as Address,
    deploymentBlock: BigInt(env.DEPLOYMENT_BLOCK),
    policyHashV1: env.POLICY_HASH_V1 as Hex,
    vaultRpId: env.VAULT_RP_ID,
    vaultRpIdHash: env.VAULT_RP_ID_HASH as Hex,
    batchAnchor: env.BATCH_ANCHOR.toLowerCase() as Address,
    // Without it, findAnchoring — the historical contextId scan — starts at the registries'
    // deployment block, thousands of blocks before the anchor existed. Per-batch resolve scans
    // never use this floor: they read only the batch's own block, taken from batchOf.
    batchAnchorBlock: numeric ? BigInt(rawAnchorBlock) : undefined,
  }
}

export class BatchCoordinator {
  readonly #batcher: Batcher
  readonly #storage: DurableObjectStorageLike

  constructor(ctx: DurableObjectStateLike, env: BatchCoordinatorEnv, overrides: BatchCoordinatorOverrides = {}) {
    // The worker validates the shared variables at boot; the batch key is the one this object owns,
    // so it gets checked here — a malformed one must fail the object, not the first submission.
    let account: LocalAccount | undefined
    if (overrides.chain === undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(env.BATCHER_PRIVATE_KEY)) {
        throw new Error("BATCHER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex")
      }
      account = privateKeyToAccount(env.BATCHER_PRIVATE_KEY as Hex)
    }
    this.#batcher = new Batcher({
      store: overrides.store ?? new D1BatchStore(env.DB),
      chain:
        overrides.chain ??
        createBatcherChain({ rpcUrl: env.RPC_URL, deployment: coordinatorDeployment(env), account: account as LocalAccount }),
      timer: alarmTimer(ctx.storage),
      now: overrides.now ?? (() => Date.now()),
      cap: overrides.cap ?? BATCH_CAP,
      waitMs: overrides.waitMs ?? BATCH_WAIT_MS,
      minGapMs: overrides.minGapMs ?? BATCH_MIN_GAP_MS,
      submitter: overrides.submitter ?? account?.address ?? ("0x0000000000000000000000000000000000000001" as Address),
      journal: new DurableObjectBatchJournal(ctx.storage),
      log: (record) => console.log(JSON.stringify({ component: "batch-coordinator", ...record })),
    })
    this.#storage = ctx.storage
    // Before any request or alarm runs: replay every journaled batch against the chain — a landed
    // one resolves its rows, one the chain never saw hands them back to the queue.
    ctx.blockConcurrencyWhile(async () => {
      await this.#batcher.recover()
    })
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/notify") {
      await this.#batcher.notify()
      return Response.json({ ok: true })
    }
    if (path === "/flush") {
      await this.#batcher.flush()
      return Response.json({ ok: true })
    }
    return new Response("not found", { status: 404 })
  }

  async alarm(): Promise<void> {
    // The alarm that fired is consumed before the run — workerd already reports it cleared, and a
    // run that re-arms (an in-gap wakeup, a requeued batch) must not be cancelled by a stale slot.
    await this.#storage.deleteAlarm()
    // A throw rethrows on purpose: workerd retries a failed alarm with backoff, which is the
    // cheapest retry a transient RPC failure can get. A permanent one is already loud through the
    // batcher's own log events.
    await this.#batcher.run()
  }
}
