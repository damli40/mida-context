import { isMidaError } from "@mida/protocol"
import type { Address, AgentRecord, Hex } from "@mida/protocol"
import { capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, toMidaError } from "@mida/chain"
import { MULTICALL3_ADDRESS } from "@mida/chain"
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

// The canonical Multicall3 address is the shared constant exported from @mida/chain — the same
// one rpcChain declares on Monad testnet clients (in-13 M-2). One aggregate3 `eth_call` answers a
// whole batch of `getRecord` checks; chains without it (local rigs, test chains) take the per-row
// path unchanged.

/** The most contextIds one batched `getRecords` asks about — one Multicall3 `eth_call` per batch. */
export const RECORDS_PER_MULTICALL = 200

/**
 * Successful Multicall3 `getCode` probes shared by every reader in the process (in-38 V-3): the
 * daemon builds a reader per operation, so a per-reader cache re-probed the chain on every one.
 * Keyed by chain id and the Multicall3 address; `size` is set the moment the probe answers so a
 * later reader can expose the known size synchronously. Only a SUCCESS is ever kept — a rejected
 * probe is evicted, so the next reader asks the chain again rather than inheriting "no Multicall3"
 * from one flaky RPC call.
 */
const multicall3Probes = new Map<string, { size: number | undefined; probe: Promise<number> }>()

function multicall3ProbeEntry(context: ChainContext): { size: number | undefined; probe: Promise<number> } {
  const key = `${context.deployment.chainId}:${MULTICALL3_ADDRESS}`
  const held = multicall3Probes.get(key)
  if (held !== undefined) return held
  const entry: { size: number | undefined; probe: Promise<number> } = {
    size: undefined,
    // Promise.resolve().then(...) so a client without getCode — a custom transport, a test rig —
    // throws INSIDE the chain and lands on the same eviction as an RPC that refuses the call.
    probe: Promise.resolve()
      .then(() => context.publicClient.getCode({ address: MULTICALL3_ADDRESS }))
      .then((code) => (entry.size = code === undefined || code === "0x" ? 1 : RECORDS_PER_MULTICALL)),
  }
  entry.probe.catch(() => {
    if (multicall3Probes.get(key) === entry) multicall3Probes.delete(key)
  })
  multicall3Probes.set(key, entry)
  return entry
}

/**
 * The process-wide Multicall3 probe for readers that are not a RegistryReader — the SDK's
 * batched-lookup prefetch (in-39 nit 3). Resolves to this chain's record batch size
 * (RECORDS_PER_MULTICALL where Multicall3 answers, 1 where it does not), asking the chain's
 * `getCode` at most once per process and chain; a rejected probe is evicted and rejects here
 * too, so the caller falls back to per-row reads and the next call asks the chain again.
 */
export function sharedMulticall3Probe(context: ChainContext): Promise<number> {
  return multicall3ProbeEntry(context).probe
}

/**
 * Forget one cached probe answer. Production chains never change whether they carry Multicall3;
 * a test rig or a rebuilt dev chain can install the runtime mid-process (anvil_setCode), and
 * then the next reader must ask the chain again rather than trust a stale "not here".
 */
export function evictMulticall3Probe(chainId: bigint): void {
  multicall3Probes.delete(`${chainId}:${MULTICALL3_ADDRESS}`)
}

/**
 * Every Monad read the Context API and SDK make. Nothing here is cached: each call reads current chain state, so no
 * local value can make Monad authorization true (§12, `currentlyAllowedByMonad`).
 */
export class RegistryReader {
  #recordBatchSize: number | undefined
  #recordBatchSizeProbe: Promise<number> | undefined

  constructor(readonly context: ChainContext) {}

  /**
   * The probed batch size once known, undefined while unprobed. Lets a BudgetedReader answer
   * without charging the request — but "unprobed" does not mean "no read": on a cold cache
   * `multicall3ProbeEntry` starts the `getCode` probe right here, the chain answers it in the
   * background, and the getter reports undefined until that answer lands (in-38 V-3).
   */
  get knownRecordBatchSize(): number | undefined {
    return this.#recordBatchSize ?? multicall3ProbeEntry(this.context).size
  }

  /**
   * The most contextIds one `getRecords` call answers in a single chain read: RECORDS_PER_MULTICALL
   * when the chain carries Multicall3, 1 where it does not. Probed once per PROCESS with `getCode`
   * — see `multicall3Probes` — and cached per reader once answered; a chain that cannot answer the
   * probe cannot run a multicall either, so a failed probe resolves to 1 — the per-row path —
   * rather than breaking reads on an RPC that does not serve `eth_getCode`.
   */
  recordBatchSize(): Promise<number> {
    if (this.#recordBatchSize !== undefined) return Promise.resolve(this.#recordBatchSize)
    this.#recordBatchSizeProbe ??= multicall3ProbeEntry(this.context).probe
      .then((size) => (this.#recordBatchSize = size))
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
   * `getRecord` for a batch of contextIds. With Multicall3 each `recordBatchSize()`-sized chunk of
   * the ids is ONE `eth_call` — hundreds of never-anchored uploads can no longer spend a request's
   * read budget a row at a time. The `ContextNotFound` revert of an orphaned upload comes back as
   * a null entry — "not anchored", never an error — and it is the ONLY failure that does: an
   * out-of-gas, an undecodable result or any other revert throws exactly as `getRecord` throws, so
   * a caller can never read a list that silently dropped a real record. Chains without Multicall3
   * fall back to one `getRecord` per id, unchanged.
   * Chunks run in order and a failing chunk fails the whole call. Callers that pass more than
   * `recordBatchSize()` ids pay one aggregate call per chunk — the budgeted wrapper slices to the
   * batch size itself, so inside a request each call still costs exactly one unit of read budget
   * (or `contextIds.length` units on the per-row path, identical to `getRecord`).
   */
  async getRecords(contextIds: readonly Hex[]): Promise<(ContextRecordView | null)[]> {
    if (contextIds.length === 0) return []
    const batchSize = await this.recordBatchSize()
    if (batchSize === 1) {
      return Promise.all(contextIds.map((contextId) => this.getRecord(contextId)))
    }
    const records: (ContextRecordView | null)[] = []
    for (let offset = 0; offset < contextIds.length; offset += batchSize) {
      const results = await this.context.publicClient.multicall({
        // batchSize 0 disables viem's calldata chunking (default 1024 bytes): the whole batch is a
        // single aggregate3 eth_call, which is what one unit of read budget pays for.
        batchSize: 0,
        multicallAddress: MULTICALL3_ADDRESS,
        allowFailure: true,
        contracts: contextIds.slice(offset, offset + batchSize).map((contextId) => ({
          address: this.context.deployment.contextRegistry,
          abi: contextRegistryAbi,
          functionName: "getRecord",
          args: [contextId],
        })),
      })
      for (const entry of results) {
        if (entry.status === "success") {
          const record = entry.result as unknown as ContextRecordView
          records.push({ ...record, owner: lower(record.owner) })
          continue
        }
        // ContextNotFound is the one failure that means "not anchored". Anything else — an unknown
        // selector, an empty out-of-gas revert, a decode failure — fails the request the same way a
        // single `getRecord` would, never returning a shortened list.
        const mapped = toMidaError(entry.error)
        if (isMidaError(mapped, "NOT_FOUND")) {
          records.push(null)
          continue
        }
        throw mapped
      }
    }
    return records
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
