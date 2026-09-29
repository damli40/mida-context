import {
  MidaError,
  PERMISSION,
  PROVENANCE_POLICY,
  batchContextId,
  batchLeafHash,
  batchSaveStructHash,
  batchSaveTypedData,
  decodeUint64,
  headCommit,
  verifyMerkleProof,
} from "@mida/protocol"
import type { Address, BatchSaveMessage, Hex } from "@mida/protocol"
import { ciphertextHash, manifestHash } from "@mida/crypto"
import { MULTICALL3_ADDRESS, batchAnchorAbi, capabilityRegistryAbi } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { hexToBytes, recoverTypedDataAddress, zeroHash } from "viem"
import type { LocalAccount, PublicClient } from "viem"
import { RECORDS_PER_MULTICALL } from "@mida/api"
import type { BatchedReadItem, BatchedSaveWire } from "@mida/api"

export type { BatchedItemState, BatchedReadItem, BatchedSaveWire, BatchReceipt } from "@mida/api"

/** Every way `verifyBatchedItem` can refuse, in the order the checks run. */
export type BatchedVerifyReason =
  | "ciphertext"
  | "manifest"
  | "signature"
  | "author"
  | "not-anchored"
  | "unknown-batch"
  | "proof"
  | "stale"

/** Every way `verifyPendingItem` can refuse, in the order the checks run. */
export type PendingVerifyReason = "not-pending" | "ciphertext" | "manifest" | "signature" | "author" | "no-authority"

/**
 * `anchorBlock` is the block `batchOf` reports for the save's batch — the block the anchor
 * transaction mined in, read from the contract during verification, never the store's word.
 */
export type BatchedVerdict = { ok: true; agentId: Hex; anchorBlock: bigint } | { ok: false; reason: BatchedVerifyReason }

// `anchorBlock?: never` keeps the pending ok-member from swallowing the anchored one: pending
// has no anchor block by definition, and without the marker `BatchedVerdict`'s ok-member is a
// subtype of this one — unions built from both would silently reduce the anchored member away.
export type PendingVerdict = { ok: true; agentId: Hex; anchorBlock?: never } | { ok: false; reason: PendingVerifyReason }

/**
 * §BatchAnchor write path: the agent signs one `MidaBatchSaveV1` typed message per save under the
 * BatchAnchor domain; the contract re-derives this digest, so the signature alone is the whole
 * authorization — no transaction leaves this call.
 */
export function signBatchSave(input: {
  account: LocalAccount
  chainId: bigint
  batchAnchor: Address
  message: BatchSaveMessage
}): Promise<Hex> {
  return input.account.signTypedData(batchSaveTypedData(input) as never)
}

const sameHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function wireMessage(message: BatchedSaveWire["message"]): BatchSaveMessage {
  return { ...message, readEpoch: decodeUint64(message.readEpoch), expiresAt: decodeUint64(message.expiresAt) }
}

function requireAnchor(deployment: Deployment): Address {
  const batchAnchor = deployment.batchAnchor
  if (batchAnchor === undefined) {
    throw new MidaError("INVALID_WIRE", "this deployment has no BatchAnchor — batched saves cannot be verified")
  }
  return batchAnchor
}

/**
 * The chain answers a batched read needs per distinct VALUE rather than per row (in-38 V-4):
 * every batch's `batchOf` ([root, anchor block]), every lineage's `headCommitOf`, and every
 * signer's `agentIdOfSigner`, fetched through Multicall3 before the row checks run. The maps live
 * for ONE `readBatchedWithStatus` call and nothing may outlive it — a lineage head or an
 * authority can move before the next read.
 */
export interface BatchedReadLookups {
  /** batchId (lowercased) → the `batchOf` answer: [root, blockNumber]. */
  readonly batches?: ReadonlyMap<Hex, readonly [Hex, bigint]>
  /** lineageId (lowercased) → the `headCommitOf` answer. */
  readonly heads?: ReadonlyMap<Hex, Hex>
  /** signer (lowercased) → the `agentIdOfSigner` answer. */
  readonly signers?: ReadonlyMap<Address, Hex>
}

const lowerAddress = (value: string): Address => value.toLowerCase() as Address

/**
 * Fetches the three distinct-value sets one batched read will consult, in aggregate calls of at
 * most RECORDS_PER_MULTICALL contract reads with `allowFailure: false` — a failed lookup fails
 * the read exactly as a failed `readContract` does today. Returns undefined where the chain
 * carries no Multicall3 (no code at the canonical address, or the getCode probe itself fails):
 * the verifiers then read per row, unchanged. Only rows that would reach a chain check spend a
 * lookup — wrong-scope rows and states that refuse before the signature check contribute nothing.
 */
export async function prefetchBatchedLookups(input: {
  items: readonly BatchedReadItem[]
  owner: Address
  namespaceId: Hex
  chainId: bigint
  deployment: Deployment
  client: PublicClient
}): Promise<BatchedReadLookups | undefined> {
  const batchAnchor = input.deployment.batchAnchor
  if (batchAnchor === undefined) return undefined
  const code = await input.client.getCode({ address: MULTICALL3_ADDRESS }).catch(() => undefined)
  if (code === undefined || code === "0x") return undefined
  const owner = input.owner.toLowerCase()
  const namespaceId = input.namespaceId.toLowerCase()
  const batchIds = new Set<Hex>()
  const lineageIds = new Set<Hex>()
  const signers = new Set<Address>()
  for (const item of input.items) {
    const wire = item.save.message
    if (wire.owner.toLowerCase() !== owner || wire.namespaceId.toLowerCase() !== namespaceId) continue
    if (item.state === "ANCHORED") {
      if (item.batchId !== undefined) batchIds.add(item.batchId.toLowerCase() as Hex)
      if (item.lineageId !== undefined) lineageIds.add(item.lineageId.toLowerCase() as Hex)
    } else if (item.state !== "QUEUED" && item.state !== "SUBMITTED") {
      continue // verifyPendingItem refuses this state before the signature check — no lookup needed
    }
    try {
      signers.add(
        lowerAddress(
          await recoverTypedDataAddress({
            ...batchSaveTypedData({ chainId: input.chainId, batchAnchor, message: wireMessage(wire) }),
            signature: item.save.signature,
          } as never),
        ),
      )
    } catch {
      // an unrecoverable signature is skipped "signature" without ever needing the lookup
    }
  }
  const batchKeys = [...batchIds]
  const headKeys = [...lineageIds]
  const signerKeys = [...signers]
  const contracts = [
    ...batchKeys.map((batchId) => ({ address: batchAnchor, abi: batchAnchorAbi, functionName: "batchOf", args: [batchId] }) as const),
    ...headKeys.map((lineageId) => ({ address: batchAnchor, abi: batchAnchorAbi, functionName: "headCommitOf", args: [lineageId] }) as const),
    ...signerKeys.map(
      (signer) =>
        ({
          address: input.deployment.capabilityRegistry,
          abi: capabilityRegistryAbi,
          functionName: "agentIdOfSigner",
          args: [signer],
        }) as const,
    ),
  ]
  const results: unknown[] = []
  for (let offset = 0; offset < contracts.length; offset += RECORDS_PER_MULTICALL) {
    results.push(
      ...(await input.client.multicall({
        // batchSize 0 disables viem's calldata chunking: the chunk below is one aggregate3 call.
        batchSize: 0,
        multicallAddress: MULTICALL3_ADDRESS,
        allowFailure: false,
        contracts: contracts.slice(offset, offset + RECORDS_PER_MULTICALL),
      })),
    )
  }
  const batches = new Map<Hex, readonly [Hex, bigint]>()
  const heads = new Map<Hex, Hex>()
  const agents = new Map<Address, Hex>()
  results.forEach((result, index) => {
    if (index < batchKeys.length) {
      batches.set(batchKeys[index]!, result as readonly [Hex, bigint])
    } else if (index < batchKeys.length + headKeys.length) {
      heads.set(headKeys[index - batchKeys.length]!, result as Hex)
    } else {
      agents.set(signerKeys[index - batchKeys.length - headKeys.length]!, result as Hex)
    }
  })
  return { batches, heads, signers: agents }
}

/**
 * Checks 1–3 shared by both verifiers: the bytes match the signed commitments, the signature
 * recovers to an agent registered on CapabilityRegistry, and the item's contextId is the id the
 * contract itself derives for that signer — so a store cannot relabel one agent's save as
 * another's. Returns the message parsed to its on-wire bigints alongside the author agentId.
 */
async function checkSignedSave(input: {
  item: BatchedReadItem
  chainId: bigint
  batchAnchor: Address
  capabilityRegistry: Address
  client: PublicClient
  lookups?: BatchedReadLookups
}): Promise<{ ok: true; agentId: Hex; message: BatchSaveMessage } | { ok: false; reason: "ciphertext" | "manifest" | "signature" | "author" }> {
  const { item, chainId, batchAnchor, client } = input
  const message = wireMessage(item.save.message)
  let ciphertext: Uint8Array
  try {
    ciphertext = hexToBytes(item.save.ciphertext)
  } catch {
    return { ok: false, reason: "ciphertext" }
  }
  if (!sameHex(ciphertextHash(ciphertext), message.ciphertextCommitment)) return { ok: false, reason: "ciphertext" }
  try {
    if (
      !sameHex(manifestHash(item.save.manifest), message.manifestHash) ||
      !sameHex(item.save.manifest.ciphertextHash, message.ciphertextCommitment)
    ) {
      return { ok: false, reason: "manifest" }
    }
  } catch {
    // A manifest too malformed to even hash is a manifest failure, not a crash of the reader.
    return { ok: false, reason: "manifest" }
  }
  let signer: Address
  try {
    signer = await recoverTypedDataAddress({
      ...batchSaveTypedData({ chainId, batchAnchor, message }),
      signature: item.save.signature,
    } as never)
  } catch {
    return { ok: false, reason: "signature" }
  }
  // A lookup built for this read answers from its map; a signer absent from it (unrecoverable at
  // prefetch time is impossible here — this one just recovered) falls back to the chain, exactly
  // as a call without any lookup does.
  const agentId =
    input.lookups?.signers?.get(lowerAddress(signer)) ??
    (await client.readContract({
      address: input.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "agentIdOfSigner",
      args: [signer],
    }))
  if (agentId === zeroHash) return { ok: false, reason: "signature" }
  const expected = batchContextId({
    chainId,
    batchAnchor,
    owner: message.owner,
    agentId,
    namespaceId: message.namespaceId,
    parentId: message.parentId,
    objectNonce: message.objectNonce,
  })
  if (!sameHex(expected, item.contextId)) return { ok: false, reason: "author" }
  return { ok: true, agentId, message }
}

/**
 * The five-check anchored read. Chain state is the only authority: the signer→agent lookup, the
 * batch root, and the lineage head all come from the contracts through `client`; the store supplies
 * only the bytes being checked. A non-ANCHORED item can never pass — pending saves go through
 * `verifyPendingItem` instead.
 */
export async function verifyBatchedItem(input: {
  item: BatchedReadItem
  chainId: bigint
  deployment: Deployment
  client: PublicClient
  requireLatest: boolean
  lookups?: BatchedReadLookups
}): Promise<BatchedVerdict> {
  const { item, chainId, deployment, client } = input
  const batchAnchor = requireAnchor(deployment)
  const checked = await checkSignedSave({ item, chainId, batchAnchor, capabilityRegistry: deployment.capabilityRegistry, client, lookups: input.lookups })
  if (!checked.ok) return checked
  const { message, agentId } = checked
  if (item.state !== "ANCHORED") return { ok: false, reason: "not-anchored" }
  if (item.batchId === undefined) return { ok: false, reason: "unknown-batch" }
  const [root, blockNumber] =
    input.lookups?.batches?.get(item.batchId.toLowerCase() as Hex) ??
    (await client.readContract({
      address: batchAnchor,
      abi: batchAnchorAbi,
      functionName: "batchOf",
      args: [item.batchId],
    }))
  if (blockNumber === 0n) return { ok: false, reason: "unknown-batch" }
  if (item.lineageId === undefined || item.version === undefined || item.proof === undefined) {
    return { ok: false, reason: "proof" }
  }
  const leaf = batchLeafHash({
    contextId: item.contextId,
    agentId,
    lineageId: item.lineageId,
    version: item.version,
    structHash: batchSaveStructHash(message),
  })
  if (!verifyMerkleProof(leaf, item.proof, root)) return { ok: false, reason: "proof" }
  if (input.requireLatest) {
    const head =
      input.lookups?.heads?.get(item.lineageId.toLowerCase() as Hex) ??
      (await client.readContract({
        address: batchAnchor,
        abi: batchAnchorAbi,
        functionName: "headCommitOf",
        args: [item.lineageId],
      }))
    const expected = headCommit({
      contextId: item.contextId,
      owner: message.owner,
      namespaceId: message.namespaceId,
      rootAuthor: item.version === 1 ? agentId : message.rootAuthor,
      version: item.version,
    })
    if (!sameHex(head, expected)) return { ok: false, reason: "stale" }
  }
  return { ok: true, agentId, anchorBlock: blockNumber }
}

/**
 * Amendment B.2 pending read: everything checkable without anchor inclusion — bytes, signature,
 * registered author, contextId — plus the one live check that matters most for a not-yet-anchored
 * save: the author's current authority, chosen exactly as `BatchAnchor._checkAndApply` chooses it.
 * A new lineage needs CREATE+INFERENCE; a replacement needs SUPERSEDE_OWN when the signer authored
 * the lineage root, SUPERSEDE_ANY otherwise — a save queued before a revocation must not survive
 * this. Inclusion and freshness are deliberately unchecked: the contract will run them at anchor
 * time.
 */
export async function verifyPendingItem(input: {
  item: BatchedReadItem
  chainId: bigint
  deployment: Deployment
  client: PublicClient
  lookups?: BatchedReadLookups
}): Promise<PendingVerdict> {
  const { item, chainId, deployment, client } = input
  const batchAnchor = requireAnchor(deployment)
  if (item.state !== "QUEUED" && item.state !== "SUBMITTED") return { ok: false, reason: "not-pending" }
  const checked = await checkSignedSave({ item, chainId, batchAnchor, capabilityRegistry: deployment.capabilityRegistry, client, lookups: input.lookups })
  if (!checked.ok) return checked
  const { message, agentId } = checked
  const hasAuthority = (permission: number): Promise<boolean> =>
    client.readContract({
      address: deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "hasAuthority",
      args: [message.owner, agentId, message.namespaceId, permission, PROVENANCE_POLICY.ALLOW_INFERENCE],
    })
  const allowed =
    message.parentId === zeroHash
      ? await hasAuthority(PERMISSION.CREATE)
      : (sameHex(message.rootAuthor, agentId) && (await hasAuthority(PERMISSION.SUPERSEDE_OWN))) ||
        (await hasAuthority(PERMISSION.SUPERSEDE_ANY))
  if (!allowed) return { ok: false, reason: "no-authority" }
  return { ok: true, agentId }
}
