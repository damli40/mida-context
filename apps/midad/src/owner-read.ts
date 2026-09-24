import { namespaceById } from "@mida/protocol"
import type { ContextPayload, Hex, RecordReference } from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, openContextObject } from "@mida/crypto"
import { contextRegistryAbi, getLogsChunked } from "@mida/chain"
import type { ContextRecordView } from "@mida/api"
import type { AbiEvent } from "viem"
import type { Runtime } from "./runtime.js"

/**
 * One record exactly as the source contract holds it (migrate B3): every field comes from the
 * chain's `ContextRecordView` — the on-chain commitment — except `payload` and `references`,
 * which exist only inside the encrypted object. The record is complete or it does not exist:
 * anything the owner cannot read back throws `owner-read-incomplete` instead of being dropped.
 */
export interface SourceRecord {
  contextId: Hex
  namespaceId: Hex
  namespace: string
  /** The chain's author: the owner marker for owner-authored records, the agentId for agent ones. */
  authorId: Hex
  recordType: number
  kind: number
  provenanceSource: number
  lineagePolicy: number
  lineageId: Hex
  parentId: Hex
  version: number
  readEpoch: bigint
  createdAt: bigint
  expiresAt: bigint
  /** The on-chain commitment to the stored object, not the object's claim about itself. */
  manifestHash: Hex
  /** Decrypted, held in memory only — never written anywhere by this module. */
  payload: ContextPayload
  /** `payload.provenance.references` — the only place record-to-record links exist. */
  references: RecordReference[]
}

interface ReadFailure {
  contextId: Hex
  reason: string
}

/**
 * A plain Error carrying `.code` and `.contextIds` — `owner-read-incomplete` is a midad-level
 * refusal, not a protocol code, so MidaError's closed union cannot carry it. The message leads
 * with the code, the way MidaError formats it, and names every contextId that could not be read.
 */
function ownerReadIncomplete(failures: readonly ReadFailure[]): Error & { code: string; contextIds: Hex[] } {
  const contextIds = [...new Set(failures.map((failure) => failure.contextId))]
  const detail = failures.map((failure) => `${failure.contextId} (${failure.reason})`).join("; ")
  return Object.assign(
    new Error(`owner-read-incomplete: ${failures.length} record(s) could not be read back completely: ${detail}`),
    { code: "owner-read-incomplete", contextIds },
  )
}

const CONTEXT_REGISTERED = contextRegistryAbi.find(
  (entry) => entry.type === "event" && entry.name === "ContextRegistered",
) as AbiEvent

/**
 * Every record the owner has on this contract, decrypted (migrate B3). Enumeration starts from
 * the owner's own `ContextRegistered` logs — the chain's complete index of registrations for this
 * owner — so the namespace set is whatever the logs contain, including namespaces no local agent
 * can read. Each namespace's objects come from an owner-signed `listObjects` (the store skips
 * agent authorization for the owner), each object is re-checked against the chain record, and the
 * payload is opened with a namespace/epoch key derived from the owner seed — the spike-2 path.
 *
 * Completeness is the point: a chain record with no object, a listed object with no chain record,
 * a failed decrypt, or a `partial` store list all throw `owner-read-incomplete` naming the
 * contextIds rather than silently shortening the universe. An owner with no records returns [].
 * Nothing is written anywhere.
 */
export async function readOwnerUniverse(
  runtime: Runtime,
  options?: { onProgress?: (done: number, total: number) => void },
): Promise<SourceRecord[]> {
  const { deployment } = runtime.network
  const logs = await getLogsChunked(runtime.ownerChain.publicClient, {
    address: deployment.contextRegistry,
    event: CONTEXT_REGISTERED,
    args: { owner: runtime.owner },
    // The home's recorded first block (loadOwnerStartBlock, resolved at Runtime.open); a brand-new
    // owner's record cannot predate it, and the value never sits below the deployment block.
    fromBlock: runtime.ownerStartBlock,
  }, { maxRange: runtime.network.logBlockRange, onProgress: options?.onProgress })
  if (logs.length === 0) return []

  // The chain-side universe, in registration order: every contextId the log attributes to this
  // owner, and the record tuple the registry emitted with it.
  const ordered: { contextId: Hex; record: ContextRecordView }[] = []
  const chainRecords = new Map<Hex, ContextRecordView>()
  const byNamespace = new Map<Hex, Set<Hex>>()
  for (const log of logs) {
    const args = log.args as unknown as { contextId: Hex; record: ContextRecordView }
    const contextId = args.contextId.toLowerCase() as Hex
    if (chainRecords.has(contextId)) continue
    const record = args.record
    chainRecords.set(contextId, record)
    ordered.push({ contextId, record })
    const namespaceId = record.namespaceId.toLowerCase() as Hex
    let ids = byNamespace.get(namespaceId)
    if (ids === undefined) byNamespace.set(namespaceId, (ids = new Set()))
    ids.add(contextId)
  }

  const failures: ReadFailure[] = []
  const decrypted = new Map<Hex, SourceRecord>()

  for (const [nsId, chainIds] of byNamespace) {
    let namespace: string
    try {
      namespace = namespaceById(nsId).name
    } catch {
      // An unknown namespace cannot be listed or decrypted — every record in it is unreadable.
      for (const contextId of chainIds) failures.push({ contextId, reason: "namespace is not in the frozen tree" })
      continue
    }
    let objects: Awaited<ReturnType<typeof runtime.ownerApi.listObjects>>["objects"]
    let partial: boolean
    try {
      const listed = await runtime.ownerApi.listObjects({ owner: runtime.owner, namespaceId: nsId })
      objects = listed.objects
      partial = listed.partial
    } catch {
      // The store could not serve this namespace at all — every record in it is unreadable.
      for (const contextId of chainIds) failures.push({ contextId, reason: "the store's object list could not be served" })
      continue
    }
    const namespaceSecret = await runtime.vault.deriveNamespaceSecret(nsId)
    const seen = new Set<Hex>()
    for (const object of objects) {
      const contextId = object.contextId.toLowerCase() as Hex
      seen.add(contextId)
      if (!chainRecords.has(contextId)) {
        failures.push({ contextId, reason: "in the store but not in the owner's ContextRegistered logs" })
        continue
      }
      if (!chainIds.has(contextId)) {
        failures.push({ contextId, reason: "filed in the store under a different namespace than its chain record" })
        continue
      }
      try {
        // The chain record is the authority: owner, namespace and the manifest commitment are
        // re-read live rather than trusted from the store row or the log alone.
        const record = await runtime.reader.getRecord(object.contextId)
        if (
          record === null ||
          record.owner !== runtime.owner ||
          record.namespaceId.toLowerCase() !== nsId ||
          record.manifestHash.toLowerCase() !== object.manifestHash.toLowerCase()
        ) {
          throw new Error("the store object does not match its chain record")
        }
        const epochKeys = deriveEpochKeyPair(namespaceSecret, record.readEpoch)
        const payload = openContextObject({
          manifest: object.manifest,
          expectedManifestHash: record.manifestHash,
          ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
          epochPrivateKey: epochKeys.privateKey,
          binding: {
            chainId: deployment.chainId,
            contextRegistry: deployment.contextRegistry,
            contextId: object.contextId,
            namespaceId: nsId,
            readEpoch: record.readEpoch,
          },
        })
        decrypted.set(contextId, {
          contextId: object.contextId,
          namespaceId: nsId,
          namespace,
          authorId: record.author,
          recordType: record.recordType,
          kind: record.kind,
          provenanceSource: record.provenanceSource,
          lineagePolicy: record.lineagePolicy,
          lineageId: record.lineageId,
          parentId: record.parentId,
          version: record.version,
          readEpoch: record.readEpoch,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          manifestHash: record.manifestHash,
          payload,
          references: payload.provenance.references ?? [],
        })
      } catch (error) {
        failures.push({ contextId, reason: `failed to read back: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    for (const contextId of chainIds) {
      if (!seen.has(contextId)) failures.push({ contextId, reason: "on chain but no object in the store" })
    }
    // A partial list cannot certify the namespace complete: unexamined rows may hide objects, so
    // every record the chain expects there is named — the read cannot vouch for any of them.
    if (partial) {
      for (const contextId of chainIds) failures.push({ contextId, reason: "the store's object list was partial" })
    }
  }

  if (failures.length > 0) throw ownerReadIncomplete(failures)

  // Registration order — the chain's own ordering of the owner's history.
  return ordered.map(({ contextId }) => decrypted.get(contextId)!)
}
