import { isMidaError } from "@mida/protocol"
import type { Address, AgentRecord, Hex } from "@mida/protocol"
import { capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, toMidaError } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { zeroHash } from "viem"

/** Spec §10.3 Capability, as read from CapabilityRegistry. */
export interface CapabilityView {
  owner: Address
  agentId: Hex
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  issuedAt: bigint
  expiresAt: bigint
  agentEpoch: bigint
  grantedAtReadEpoch: bigint
  revoked: boolean
}

/** Spec §11.3 ContextRecord, as read from ContextRegistry. */
export interface ContextRecordView {
  contextId: Hex
  owner: Address
  author: Hex
  namespaceId: Hex
  lineageId: Hex
  parentId: Hex
  manifestHash: Hex
  ciphertextCommitment: Hex
  evidenceCommitment: Hex
  readEpoch: bigint
  createdAt: bigint
  expiresAt: bigint
  version: number
  recordType: number
  lineagePolicy: number
  kind: number
  provenanceSource: number
}

const lower = <T extends string>(value: T) => value.toLowerCase() as T

/**
 * Canonical Multicall3 deployment — verified present on Monad testnet. One aggregate3 `eth_call`
 * answers a whole batch of `getRecord` checks; chains without it (local rigs, test chains) take the
 * per-row path unchanged.
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const

/** The most contextIds one batched `getRecords` asks about — one Multicall3 `eth_call` per batch. */
export const RECORDS_PER_MULTICALL = 200

/**
 * Every Monad read the Context API and SDK make. Nothing here is cached: each call reads current chain state, so no
 * local value can make Monad authorization true (§12, `currentlyAllowedByMonad`).
 */
export class RegistryReader {
  #recordBatchSize: number | undefined
  #recordBatchSizeProbe: Promise<number> | undefined

  constructor(readonly context: ChainContext) {}

  /**
   * The probed batch size once known, undefined while unprobed. Lets a BudgetedReader return a
   * cached answer without charging the request for a chain read that does not happen.
   */
  get knownRecordBatchSize(): number | undefined {
    return this.#recordBatchSize
  }

  /**
   * The most contextIds one `getRecords` call answers in a single chain read: RECORDS_PER_MULTICALL
   * when the chain carries Multicall3, 1 where it does not. Probed once per reader with `getCode`
   * and cached; a chain that cannot answer the probe cannot run a multicall either, so a failed
   * probe also resolves to 1 — the per-row path — rather than breaking reads on an RPC that does
   * not serve `eth_getCode`.
   */
  recordBatchSize(): Promise<number> {
    if (this.#recordBatchSize !== undefined) return Promise.resolve(this.#recordBatchSize)
    this.#recordBatchSizeProbe ??= this.context.publicClient
      .getCode({ address: MULTICALL3_ADDRESS })
      .then((code) => (this.#recordBatchSize = code === undefined || code === "0x" ? 1 : RECORDS_PER_MULTICALL))
      .catch(() => (this.#recordBatchSize = 1))
    return this.#recordBatchSizeProbe
  }

  now(): Promise<bigint> {
    return latestTimestamp(this.context)
  }

  async agentIdOfSigner(signer: Address): Promise<Hex | null> {
    const id = await this.#capability<Hex>("agentIdOfSigner", [signer])
    return id === zeroHash ? null : id
  }

  async getAgent(agentId: Hex): Promise<AgentRecord | null> {
    try {
      return await readAgentRecord(this.context, agentId)
    } catch (error) {
      if (isMidaError(error, "CAPABILITY_DENIED")) return null
      throw error
    }
  }

  async getCapability(capabilityId: Hex): Promise<CapabilityView | null> {
    try {
      const capability = await this.#capability<CapabilityView>("getCapability", [capabilityId])
      return { ...capability, owner: lower(capability.owner), agentId: lower(capability.agentId), namespaceId: lower(capability.namespaceId) }
    } catch (error) {
      if (isMidaError(error, "CAPABILITY_DENIED")) return null
      throw error
    }
  }

  agentEpoch(owner: Address, agentId: Hex): Promise<bigint> {
    return this.#capability("agentEpoch", [owner, agentId])
  }

  /** Capability IDs ever granted by this owner to this agent; revoked/expired entries linger until a grant compacts the list. */
  activeCapabilityIds(owner: Address, agentId: Hex): Promise<readonly Hex[]> {
    return this.#capability("activeCapabilityIds", [owner, agentId])
  }

  hasAuthority(owner: Address, agentId: Hex, namespaceId: Hex, permissions: number, provenanceBits: number): Promise<boolean> {
    return this.#capability("hasAuthority", [owner, agentId, namespaceId, permissions, provenanceBits])
  }

  requiredReadEpoch(owner: Address, namespaceId: Hex): Promise<bigint> {
    return this.#capability("requiredReadEpoch", [owner, namespaceId])
  }

  async epochPublicKey(owner: Address, namespaceId: Hex, epoch: bigint): Promise<Hex | null> {
    const key = await this.#capability<Hex>("epochPublicKey", [owner, namespaceId, epoch])
    return key === zeroHash ? null : key
  }

  isWriteEpochValid(owner: Address, namespaceId: Hex, epoch: bigint): Promise<boolean> {
    return this.#capability("isWriteEpochValid", [owner, namespaceId, epoch])
  }

  async ownerP256Key(owner: Address): Promise<{ qx: bigint; qy: bigint } | null> {
    const [qx, qy] = await this.#capability<readonly [bigint, bigint]>("ownerP256Key", [owner])
    return qx === 0n ? null : { qx, qy }
  }

  async getRecord(contextId: Hex): Promise<ContextRecordView | null> {
    try {
      const record = (await this.context.publicClient.readContract({
        address: this.context.deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "getRecord",
        args: [contextId],
      })) as ContextRecordView
      return { ...record, owner: lower(record.owner) }
    } catch (error) {
      const mapped = toMidaError(error)
      if (isMidaError(mapped, "NOT_FOUND")) return null
      throw mapped
    }
  }

  /**
   * `getRecord` for a batch of contextIds. With Multicall3 the batch is ONE `eth_call` — hundreds of
   * never-anchored uploads can no longer spend a request's read budget a row at a time. A reverted
   * item (the `ContextNotFound` of an orphaned upload) comes back as a null entry — "not anchored",
   * never an error. Chains without Multicall3 fall back to one `getRecord` per id, unchanged.
   * Callers pass at most `recordBatchSize()` ids per call, so each call costs exactly one unit of
   * read budget — or `contextIds.length` units on the per-row path, identical to `getRecord`.
   */
  async getRecords(contextIds: readonly Hex[]): Promise<(ContextRecordView | null)[]> {
    if (contextIds.length === 0) return []
    if ((await this.recordBatchSize()) === 1) {
      return Promise.all(contextIds.map((contextId) => this.getRecord(contextId)))
    }
    const results = await this.context.publicClient.multicall({
      // batchSize 0 disables viem's calldata chunking (default 1024 bytes): the whole batch is a
      // single aggregate3 eth_call, which is what one unit of read budget pays for.
      batchSize: 0,
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      contracts: contextIds.map((contextId) => ({
        address: this.context.deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "getRecord",
        args: [contextId],
      })),
    })
    return results.map((entry) => {
      if (entry.status !== "success") return null
      const record = entry.result as unknown as ContextRecordView
      return { ...record, owner: lower(record.owner) }
    })
  }

  async #capability<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    try {
      return (await this.context.publicClient.readContract({
        address: this.context.deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName,
        args,
      } as never)) as T
    } catch (error) {
      throw toMidaError(error)
    }
  }
}
