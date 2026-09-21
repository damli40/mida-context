import type { Address, AgentRecord, Hex } from "@mida/protocol"
import { RegistryReader } from "./chain-views.js"
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
  #spent = 0

  constructor(inner: RegistryReader, limit: number = MAX_CHAIN_READS_PER_REQUEST) {
    super(inner.context)
    this.#inner = inner
    this.#limit = limit
  }

  /** Chain reads spent so far in this request. */
  get spent(): number {
    return this.#spent
  }

  /** Reads still available; route logic sizes its own caps from this before asking the chain. */
  get remaining(): number {
    return this.#limit - this.#spent
  }

  async #read<T>(call: () => Promise<T>): Promise<T> {
    if (this.#spent >= this.#limit) throw new ChainReadBudgetExceeded()
    this.#spent += 1
    return call()
  }

  override now(): Promise<bigint> {
    return this.#read(() => this.#inner.now())
  }

  override agentIdOfSigner(signer: Address): Promise<Hex | null> {
    return this.#read(() => this.#inner.agentIdOfSigner(signer))
  }

  override getAgent(agentId: Hex): Promise<AgentRecord | null> {
    return this.#read(() => this.#inner.getAgent(agentId))
  }

  override getCapability(capabilityId: Hex): Promise<CapabilityView | null> {
    return this.#read(() => this.#inner.getCapability(capabilityId))
  }

  override agentEpoch(owner: Address, agentId: Hex): Promise<bigint> {
    return this.#read(() => this.#inner.agentEpoch(owner, agentId))
  }

  override activeCapabilityIds(owner: Address, agentId: Hex): Promise<readonly Hex[]> {
    return this.#read(() => this.#inner.activeCapabilityIds(owner, agentId))
  }

  override hasAuthority(owner: Address, agentId: Hex, namespaceId: Hex, permissions: number, provenanceBits: number): Promise<boolean> {
    return this.#read(() => this.#inner.hasAuthority(owner, agentId, namespaceId, permissions, provenanceBits))
  }

  override requiredReadEpoch(owner: Address, namespaceId: Hex): Promise<bigint> {
    return this.#read(() => this.#inner.requiredReadEpoch(owner, namespaceId))
  }

  override epochPublicKey(owner: Address, namespaceId: Hex, epoch: bigint): Promise<Hex | null> {
    return this.#read(() => this.#inner.epochPublicKey(owner, namespaceId, epoch))
  }

  override isWriteEpochValid(owner: Address, namespaceId: Hex, epoch: bigint): Promise<boolean> {
    return this.#read(() => this.#inner.isWriteEpochValid(owner, namespaceId, epoch))
  }

  override ownerP256Key(owner: Address): Promise<{ qx: bigint; qy: bigint } | null> {
    return this.#read(() => this.#inner.ownerP256Key(owner))
  }

  override getRecord(contextId: Hex): Promise<ContextRecordView | null> {
    return this.#read(() => this.#inner.getRecord(contextId))
  }
}
