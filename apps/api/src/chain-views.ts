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
 * Every Monad read the Context API and SDK make. Nothing here is cached: each call reads current chain state, so no
 * local value can make Monad authorization true (§12, `currentlyAllowedByMonad`).
 */
export class RegistryReader {
  constructor(readonly context: ChainContext) {}

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
