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
import { GAS_CEILINGS, batchAnchorAbi, createWriteContext, failedBeforeSend, getLogsChunked, revertName, sendContract } from "@mida/chain"
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
  /**
   * Sends submitBatch; { exists: true } means the contract already holds this batchId
   * (BatchExists). A real send reports the receipt's gasUsed — the measurement the batcher
   * re-sizes the next take from. { exists: true } carries no receipt, so it carries no number.
   */
  submit(batchId: Hex, saves: BatchedSaveWire[]): Promise<{ transactionHash: Hex; gasUsed: bigint } | { exists: true }>
  anchoredLogs(batchId: Hex): Promise<AnchoredLog[]>
  rejectedLogs(batchId: Hex): Promise<RejectedLog[]>
  /** The BatchAnchored event for this batchId — who submitted it and how it split; null if none. */
  batchAnchored(batchId: Hex): Promise<{ submitter: Address; acceptedCount: number; rejectedCount: number } | null>
  batchOf(batchId: Hex): Promise<{ root: Hex; blockNumber: bigint; acceptedCount: number }>
  /**
   * The batchIds that anchored these contextIds, in one historical scan for the whole set —
   * used for ALREADY_ANCHORED rejects. Map keys and values are lowercase; a contextId never
   * anchored is simply absent.
   */
  findAnchorings(contextIds: Hex[]): Promise<Map<string, Hex>>
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

/** Integer division that rounds up — a per-save gas cost must never round a fraction away. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

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
  /**
   * The hard upper bound on saves per batch — never exceeded no matter what the gas math says.
   * The take a run actually uses is usually smaller: the number of saves that fit the gas budget
   * at the per-save cost learned so far.
   */
  cap: number
  /**
   * The gas budget each take is sized against; default is the "batch.submit" ceiling. Takes are
   * planned at 95% of it so estimate drift between sizing and sending does not turn a legal take
   * into a refusal.
   */
  gasBudget?: bigint
  /**
   * The per-save gas the first take assumes; default 66,264, the Sep 24 testnet sweep's measured
   * 60-save figure (docs/evidence/batch-anchor-sweep-2026-09-24.json). The first real receipt
   * replaces it.
   */
  initialGasPerSave?: bigint
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
  readonly #gasBudget: bigint
  readonly #waitMs: number
  readonly #minGapMs: number
  readonly #submitter: Address
  readonly #salt: () => Hex
  readonly #log: ((record: Record<string, unknown>) => void) | undefined
  /** Ordered contextIds of batches this process submitted — the resolve mapping without a journal read. */
  readonly #submitted = new Map<string, Hex[]>()
  /**
   * The take size the next run uses — the number of saves that fit the gas budget at the per-save
   * cost learned so far, clamped to [1, cap]. A successful submit re-learns it from the receipt's
   * gasUsed; a GAS_CEILING_EXCEEDED refusal re-sizes it from the estimate the refusal carried, or
   * halves the refused take (floor 1) when the refusal carried none — the batch was too big to
   * send, not malformed. Any other pre-send failure halves the refused take the same way.
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
    this.#gasBudget = options.gasBudget ?? GAS_CEILINGS["batch.submit"]
    this.#waitMs = options.waitMs
    this.#minGapMs = options.minGapMs ?? 1000
    this.#submitter = options.submitter.toLowerCase() as Address
    this.#salt = options.salt ?? (() => bytesToHex(crypto.getRandomValues(new Uint8Array(32))))
    this.#effectiveCap = this.#fitFor(options.initialGasPerSave ?? 66_264n)
    this.#log = options.log
  }

  /**
   * How many saves fit the gas budget at a per-save cost: floor(gasBudget × 95% / gasPerSave),
   * clamped to [1, cap]. The 5% margin absorbs drift between the estimate a take was sized from
   * and the one the send is actually priced at; the cap is the bound a lying measurement cannot
   * cross. A non-positive per-save figure carries no information — the hard cap is the answer.
   */
  #fitFor(gasPerSave: bigint): number {
    if (gasPerSave <= 0n) return this.#cap
    const fit = (this.#gasBudget * 95n) / 100n / gasPerSave
    return Math.min(this.#cap, Math.max(1, Number(fit)))
  }

  /**
   * One new save arrived. At the learned cap the batch goes now; below it the first save arms the
   * wait window and every later save in the window leaves the armed timer exactly where it is.
   */
  notify(): Promise<void> {
    return this.#serialize(async () => {
      if ((await this.#store.countQueued()) >= this.#effectiveCap) {
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
    let result: { transactionHash: Hex; gasUsed: bigint } | { exists: true }
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
          // and the next take shrinks to what the refusal's estimate says would have fit: divided
          // by this take's size it gives the per-save cost the node computed, and fitFor turns that
          // into the largest legal take. A refusal with no estimate — or one whose implied fit
          // would not shrink the take — halves the TAKE that was refused, so the queue drains in
          // smaller batches instead of wedging behind one it can never push through.
          const requeued = await this.#store.requeue(batchId)
          const implied =
            error.estimate === undefined ? null : this.#fitFor(ceilDiv(error.estimate, BigInt(taken.length)))
          this.#effectiveCap =
            implied !== null && implied < taken.length ? implied : Math.max(1, Math.floor(taken.length / 2))
          this.#log?.({ event: "batch.too-large", batchId, requeued, cap: this.#effectiveCap })
        }
        if (!(await this.#timer.pending())) await this.#timer.set(this.#now() + this.#waitMs)
        return null
      }
      if (failedBeforeSend(error)) {
        // A failure before anything was sent — simulation, estimate, fee or balance guard — is a
        // size or availability signal, never an ambiguous send: no transaction exists to land
        // later. The rows requeue and the next take is half of the one just refused — the TAKE is
        // halved, not the learned cap, so a refusal at 8 rows yields a take of 4 even when the cap
        // still says 400. A batch of one requeues untouched: a lone pre-send failure is more likely
        // an RPC outage than an oversized save, and only a measured ceiling refusal earns TOO_LARGE.
        this.#submitted.delete(batchId.toLowerCase())
        await this.#journal?.clear(batchId)
        const requeued = await this.#store.requeue(batchId)
        if (taken.length > 1) this.#effectiveCap = Math.max(1, Math.floor(taken.length / 2))
        this.#log?.({ event: "batch.presend-failed", batchId, requeued, cap: this.#effectiveCap, error: String(error) })
        if (!(await this.#timer.pending())) await this.#timer.set(this.#now() + this.#waitMs)
        return null
      }
      // The send failed ambiguously — the tx may or may not land. Requeue wholesale; if it did land,
      // the next batch's ALREADY_ANCHORED rejects heal the PARENT-LESS rows through findAnchorings.
      // A parented save resubmitted after its first copy landed comes back STALE_PARENT instead —
      // the lineage head moved to that very copy — and nothing heals it; the rejection loop below
      // logs that case as batch.stale-after-requeue.
      const requeued = await this.#store.requeue(batchId)
      this.#submitted.delete(batchId.toLowerCase())
      await this.#journal?.clear(batchId)
      this.#log?.({ event: "batch.submit-failed", batchId, requeued, error: String(error) })
      if (!(await this.#timer.pending())) await this.#timer.set(this.#now() + this.#waitMs)
      return null
    }
    // { exists: true } is the BatchExists answer: our batchId was already taken on chain. The id is
    // visible inside the pending transaction, so anyone can land a batch under it first — Monad then
    // bills the reverted send's full gas limit. Not an ambiguous send and not a generic failure: the
    // resolve below proves whose batch it is, and repeated id-taken lines are the attack's signature.
    if ("exists" in result) this.#log?.({ event: "batch.id-taken", batchId })
    // A real receipt re-teaches the per-save cost, so the next take fits the gas the chain actually
    // charged. { exists: true } carries no receipt — the learned cap stays where the last real
    // measurement put it. gasPerSave is logged as a number: bigint would break JSON.stringify.
    const gasPerSave = "exists" in result ? null : ceilDiv(result.gasUsed, BigInt(taken.length))
    if (gasPerSave !== null) this.#effectiveCap = this.#fitFor(gasPerSave)
    this.#lastSubmitAt = this.#now()
    this.#log?.({
      event: "batch.submitted",
      batchId,
      saves: taken.length,
      exists: "exists" in result,
      cap: this.#effectiveCap,
      gasPerSave: gasPerSave === null ? null : Number(gasPerSave),
    })
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
    // check, so a batchId found on chain can be a foreign batch pre-claiming the id. "Not ours"
    // is a claim that needs positive evidence — one of three facts: the BatchAnchored event names
    // a different submitter, an anchored contextId is not one of the journaled rows, or the
    // event's accepted+rejected count is not the row count. A MISSING answer is never evidence:
    // right after the receipt, batchOf can see the batch while the RPC's log index still lags,
    // and calling that lag "foreign" would re-send our own landed batch — gas paid twice, and a
    // parented save comes back STALE_PARENT with nothing to heal it.
    const order = this.#submitted.get(batchId.toLowerCase()) ?? (await this.#journal?.contextIds(batchId)) ?? null
    const anchored = (await this.#chain.anchoredLogs(batchId)).sort((a, b) => a.position - b.position)
    const rejected = await this.#chain.rejectedLogs(batchId)
    const event = await this.#chain.batchAnchored(batchId)
    const oursIds = new Set((order ?? []).map((contextId) => contextId.toLowerCase()))
    const foreign =
      (event !== null && event.submitter.toLowerCase() !== this.#submitter) ||
      (order !== null && anchored.some((log) => !oursIds.has(log.contextId.toLowerCase()))) ||
      (event !== null && order !== null && event.acceptedCount + event.rejectedCount !== order.length)
    if (foreign) {
      // Not ours: no row may take this batch's outcomes. The rows come back to QUEUED (a fresh id
      // next run), the journal entry is cleared and the one log line says exactly what happened.
      const requeued = await this.#store.requeue(batchId)
      this.#submitted.delete(batchId.toLowerCase())
      await this.#journal?.clear(batchId)
      this.#log?.({ event: "batch.not-ours", batchId, requeued, message: `batch ${batchId} is not ours — requeued` })
      return { accepted: 0, rejected: 0 }
    }
    // Missing pieces — the BatchAnchored event the index has not caught up to, or a journaled
    // order that is gone — prove nothing either way. Throw instead of resolving or requeueing:
    // the rows stay SUBMITTED and the journal stays, so a later resolve()/recover() retries —
    // the same fail-safe the count check below has always had.
    if (event === null || order === null) {
      this.#log?.({
        event: "batch.unproven",
        batchId,
        eventSeen: event !== null,
        orderSeen: order !== null,
        message: `batch ${batchId} landed but cannot be proven ours or foreign — resolve retries when the log index catches up`,
      })
      throw new MidaError("PARTIAL_READ", `batch ${batchId} cannot be proven ours — the batch's events or journaled order are not all visible yet`)
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
    // Every ALREADY_ANCHORED row is found in ONE historical scan for the whole batch — the per-row
    // alternative paid a full deploy-block-to-head log scan for each rejected row.
    const needsHeal = rejected
      .filter((rejection) => rejection.reason === BATCH_REJECT.ALREADY_ANCHORED)
      .map((rejection) => order[rejection.index])
      .filter((contextId): contextId is Hex => contextId !== undefined)
    const anchorings = needsHeal.length === 0 ? new Map<string, Hex>() : await this.#chain.findAnchorings(needsHeal)
    for (const rejection of rejected) {
      const contextId = order[rejection.index]
      if (contextId === undefined) {
        unmapped += 1
        continue
      }
      if (rejection.reason === BATCH_REJECT.ALREADY_ANCHORED) {
        const healed = await this.#anchorFromEarlierBatch(batchId, contextId, anchoredAt, anchorings)
        if (!healed) await this.#store.markRejected(contextId, rejectName(rejection.reason))
      } else {
        if (rejection.reason === BATCH_REJECT.STALE_PARENT) {
          // A parented save whose lineage head moved before it landed has no heal — ALREADY_ANCHORED's
          // earlier-batch proof only exists for a parent-less save whose own contextId anchored. The
          // row is REJECTED; the event keeps this known unhealed case visible rather than silent.
          this.#log?.({ event: "batch.stale-after-requeue", batchId, contextId })
        }
        await this.#store.markRejected(contextId, rejectName(rejection.reason))
      }
    }
    if (unmapped > 0) {
      // order is proven non-null above, so reaching here means a SaveRejected index pointed past
      // the journaled order — event data that does not line up with the batch this batcher sent.
      // Those rows stay SUBMITTED (visible in the status route); an index is never guessed at.
      this.#log?.({ event: "batch.unmapped-rejections", batchId, unmapped })
    }
    this.#log?.({ event: "batch.resolved", batchId, accepted: anchored.length, rejected: rejected.length })
    return { accepted: anchored.length, rejected: rejected.length }
  }

  /**
   * A save the contract rejected as ALREADY_ANCHORED is not dead — an earlier batch holds its real
   * proof. Rebuild that batch's leaves under the same root-equality rule and anchor the row there.
   */
  async #anchorFromEarlierBatch(batchId: Hex, contextId: Hex, anchoredAt: number, anchorings: Map<string, Hex>): Promise<boolean> {
    const earlier = anchorings.get(contextId.toLowerCase())
    if (earlier === undefined || earlier.toLowerCase() === batchId.toLowerCase()) return false
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
 * The send runs under the "batch.submit" ceiling (28M gas) — sized under Monad's 30M
 * per-transaction limit rather than the 6M "revoke.agent" ceiling a batch used to borrow — and
 * reports the receipt's gasUsed so the batcher can size the next take from the real per-save cost.
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
          "batch.submit",
        )
        return { transactionHash: receipt.transactionHash, gasUsed: receipt.gasUsed }
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
    async findAnchorings(contextIds) {
      const found = new Map<string, Hex>()
      if (contextIds.length === 0) return found
      // contextId is an indexed SaveAnchored arg — viem encodes the array as topic alternatives,
      // so one chunked scan answers for the whole set.
      const logs = await getLogsChunked(context.publicClient, {
        address: batchAnchor,
        event: saveAnchoredEvent,
        args: { contextId: contextIds },
        fromBlock,
      })
      for (const log of logs) {
        const args = log.args as { contextId: Hex; batchId: Hex }
        const key = args.contextId.toLowerCase()
        // Logs arrive in block order — the first hit for a contextId is its earliest anchoring.
        if (!found.has(key)) found.set(key, args.batchId.toLowerCase() as Hex)
      }
      return found
    },
  }
}
