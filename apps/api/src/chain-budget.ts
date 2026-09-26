import type { Address, AgentRecord, Hex } from "@mida/protocol"
import { RECORDS_PER_MULTICALL, RegistryReader } from "./chain-views.js"
import type { CapabilityView, ContextRecordView } from "./chain-views.js"

/**
 * One chain read costs one platform subrequest. Cloudflare's Workers FREE plan allows 50 per
 * invocation (check the current Workers limits page), so a request's Monad budget is 30 — the rest
 * of the allowance covers D1, the rate-limit binding and logging inside the same invocation. The
 * same cap is enforced in the self-hosted app: a bounded request is a request that can be reasoned
 * about, whatever serves it.
 */
export const MAX_CHAIN_READS_PER_REQUEST = 30

/** Thrown the moment a request tries to spend one chain read more than its per-request budget. */
export class ChainReadBudgetExceeded extends Error {
  readonly code = "CHAIN_READ_BUDGET_EXHAUSTED" as const

  constructor(message = "this request needs more Monad reads than one invocation may spend — retry in a few seconds") {
    super(message)
    this.name = "ChainReadBudgetExceeded"
  }
}

export function isChainReadBudgetExceeded(value: unknown): value is ChainReadBudgetExceeded {
  return value instanceof ChainReadBudgetExceeded
}

/**
 * The counting wrapper built per request around the chain reader. Every method delegates to the
 * wrapped reader but spends one unit of budget first; the call that would exceed it throws instead
 * of running, so the platform's own subrequest ceiling is never reached. It extends RegistryReader
 * on purpose: the class has an ECMAScript private field, which makes it nominal in TypeScript — a
 * structural stand-in could never be passed where a RegistryReader is expected. Route code reads
 * `remaining` to size its own scan caps (pending re-checks, object lists) so this wrapper's throw
 * stays the last line of defence, not the control flow.
 */
export class BudgetedReader extends RegistryReader {
  readonly #inner: RegistryReader
  readonly #limit: number
  readonly #memo: Map<string, Promise<unknown>> | undefined
  #spent = 0
  #batchSize: number | undefined

  /**
   * `memo` is the operation-scope the request belongs to (in-9 R-5): when the caller carries a
   * read-scope token, the app hands every request of that operation the same map, so an identical
   * question a sibling request already asked — the six reads of `authorizeAgent` above all — is
   * answered once per operation, not once per request. A memo hit spends no budget: it is not a
   * chain read at all. A rejected call is evicted so one transient failure never poisons the
   * operation.
   */
  constructor(inner: RegistryReader, limit: number = MAX_CHAIN_READS_PER_REQUEST, memo?: Map<string, Promise<unknown>>) {
    super(inner.context)
    this.#inner = inner
    this.#limit = limit
    this.#memo = memo
  }

  /** Chain reads spent so far in this request. */
  get spent(): number {
    return this.#spent
  }

  /** Reads still available; route logic sizes its own caps from this before asking the chain. */
  get remaining(): number {
    return this.#limit - this.#spent
  }

  async #read<T>(key: string, call: () => Promise<T>): Promise<T> {
    const memo = this.#memo
    if (memo !== undefined) {
      const held = memo.get(key)
      if (held !== undefined) return held as Promise<T>
    }
    if (this.#spent >= this.#limit) throw new ChainReadBudgetExceeded()
    this.#spent += 1
    const pending = call()
    if (memo !== undefined) {
      memo.set(key, pending)
      pending.catch(() => {
        if (memo.get(key) === pending) memo.delete(key)
      })
    }
    return pending
  }

  override now(): Promise<bigint> {
    return this.#read("now:", () => this.#inner.now())
  }

  override agentIdOfSigner(signer: Address): Promise<Hex | null> {
    return this.#read(`agentIdOfSigner:${signer}`, () => this.#inner.agentIdOfSigner(signer))
  }

  override getAgent(agentId: Hex): Promise<AgentRecord | null> {
    return this.#read(`getAgent:${agentId}`, () => this.#inner.getAgent(agentId))
  }

  override getCapability(capabilityId: Hex): Promise<CapabilityView | null> {
    return this.#read(`getCapability:${capabilityId}`, () => this.#inner.getCapability(capabilityId))
  }

  override agentEpoch(owner: Address, agentId: Hex): Promise<bigint> {
    return this.#read(`agentEpoch:${owner}:${agentId}`, () => this.#inner.agentEpoch(owner, agentId))
  }

  override activeCapabilityIds(owner: Address, agentId: Hex): Promise<readonly Hex[]> {
    return this.#read(`activeCapabilityIds:${owner}:${agentId}`, () => this.#inner.activeCapabilityIds(owner, agentId))
  }

  override hasAuthority(owner: Address, agentId: Hex, namespaceId: Hex, permissions: number, provenanceBits: number): Promise<boolean> {
    return this.#read(`hasAuthority:${owner}:${agentId}:${namespaceId}:${permissions}:${provenanceBits}`, () =>
      this.#inner.hasAuthority(owner, agentId, namespaceId, permissions, provenanceBits),
    )
  }

  override requiredReadEpoch(owner: Address, namespaceId: Hex): Promise<bigint> {
    return this.#read(`requiredReadEpoch:${owner}:${namespaceId}`, () => this.#inner.requiredReadEpoch(owner, namespaceId))
  }

  override epochPublicKey(owner: Address, namespaceId: Hex, epoch: bigint): Promise<Hex | null> {
    return this.#read(`epochPublicKey:${owner}:${namespaceId}:${epoch}`, () => this.#inner.epochPublicKey(owner, namespaceId, epoch))
  }

  override isWriteEpochValid(owner: Address, namespaceId: Hex, epoch: bigint): Promise<boolean> {
    return this.#read(`isWriteEpochValid:${owner}:${namespaceId}:${epoch}`, () => this.#inner.isWriteEpochValid(owner, namespaceId, epoch))
  }

  override ownerP256Key(owner: Address): Promise<{ qx: bigint; qy: bigint } | null> {
    return this.#read(`ownerP256Key:${owner}`, () => this.#inner.ownerP256Key(owner))
  }

  override getRecord(contextId: Hex): Promise<ContextRecordView | null> {
    return this.#read(`getRecord:${contextId}`, () => this.#inner.getRecord(contextId))
  }

  override recordBatchSize(): Promise<number> {
    if (this.#batchSize !== undefined) return Promise.resolve(this.#batchSize)
    // Stand-in readers in tests implement only what a test needs: one with no `getRecords` checks
    // rows one read at a time; one with `getRecords` but no `recordBatchSize` batches the full 200.
    if (typeof this.#inner.recordBatchSize !== "function") {
      this.#batchSize = typeof this.#inner.getRecords === "function" ? RECORDS_PER_MULTICALL : 1
      return Promise.resolve(this.#batchSize)
    }
    // The probe's getCode is itself a chain read — charged once, to the request that triggers it.
    // Once the inner reader has the answer cached it costs this request nothing.
    if (this.#inner.knownRecordBatchSize !== undefined) {
      this.#batchSize = this.#inner.knownRecordBatchSize
      return Promise.resolve(this.#batchSize)
    }
    return this.#read("recordBatchSize:", async () => (this.#batchSize = await this.#inner.recordBatchSize()))
  }

  override getRecords(contextIds: readonly Hex[]): Promise<(ContextRecordView | null)[]> {
    // A stand-in with no `getRecords` pays one read per row — accounting identical to `getRecord`.
    if (typeof this.#inner.getRecords !== "function") {
      return Promise.all(contextIds.map((contextId) => this.getRecord(contextId)))
    }
    return this.#read(`getRecords:${contextIds.join(",")}`, () => this.#inner.getRecords(contextIds))
  }
}
