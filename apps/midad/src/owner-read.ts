import { LINEAGE_POLICY, RECORD_TYPE, decodeUint64, namespaceById } from "@mida/protocol"
import type { ContextPayload, Hex, RecordReference } from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, openContextObject } from "@mida/crypto"
import { batchAnchorAbi, contextRegistryAbi, getLogsChunked } from "@mida/chain"
import type { BatchedReadItem, ContextRecordView } from "@mida/api"
import { verifyBatchedItem } from "@mida/sdk"
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
  /**
   * Which lane anchored the record: "direct" is a ContextRegistry registration of its own,
   * "batched" is a save the BatchAnchor contract accepted inside a shared transaction. Optional
   * on the type so hand-built records in older tests still satisfy the shape — every record this
   * reader returns carries it.
   */
  lane?: "direct" | "batched"
  /** The batch a batched save anchored in — absent on direct records. */
  batchId?: Hex
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

const SAVE_ANCHORED = batchAnchorAbi.find(
  (entry) => entry.type === "event" && entry.name === "SaveAnchored",
) as AbiEvent

/** The fields of one `SaveAnchored` log this reader keeps — the contract's own attestation. */
interface AnchoredSave {
  contextId: Hex
  namespaceId: Hex
  lineageId: Hex
  version: number
  batchId: Hex
  author: Hex
  blockNumber: bigint
}

/**
 * The batched lane's half of the universe (BatchAnchor plan §7.3): the owner's `SaveAnchored`
 * logs are the chain's list of what the contract accepted inside shared transactions, and each
 * one's store row is verified through the §7.1 checks — commitments, signature→agent, Merkle
 * proof to the on-chain batch root — then opened with the owner-derived epoch key. The store's
 * word is trusted nowhere: a row the log never named, a log whose row is missing, a row that
 * disagrees with its log, and a list the store marks partial all land in `failures` rather than
 * shortening the universe quietly. `requireLatest` is off — history keeps superseded versions.
 */
async function readBatchedUniverse(
  runtime: Runtime,
  failures: ReadFailure[],
  onProgress?: (done: number, total: number) => void,
): Promise<(SourceRecord & { lane: "batched" })[]> {
  const { deployment } = runtime.network
  const batchAnchor = deployment.batchAnchor
  if (batchAnchor === undefined) return []
  const logs = await getLogsChunked(runtime.ownerChain.publicClient, {
    address: batchAnchor,
    event: SAVE_ANCHORED,
    args: { owner: runtime.owner },
    // The anchor's own deployment block — a batched save cannot predate the contract.
    fromBlock: deployment.batchAnchorBlock ?? 0n,
  }, { maxRange: runtime.network.logBlockRange, onProgress })
  if (logs.length === 0) return []

  const byNamespace = new Map<Hex, AnchoredSave[]>()
  const anchoredIds = new Set<Hex>()
  for (const log of logs) {
    const args = log.args as { contextId: Hex; namespaceId: Hex; lineageId: Hex; version: number; batchId: Hex; author: Hex }
    const contextId = args.contextId.toLowerCase() as Hex
    anchoredIds.add(contextId)
    const namespaceId = args.namespaceId.toLowerCase() as Hex
    const list = byNamespace.get(namespaceId) ?? []
    list.push({
      contextId,
      namespaceId,
      lineageId: args.lineageId.toLowerCase() as Hex,
      version: args.version,
      batchId: args.batchId.toLowerCase() as Hex,
      author: args.author.toLowerCase() as Hex,
      blockNumber: log.blockNumber ?? 0n,
    })
    byNamespace.set(namespaceId, list)
  }

  const records: (SourceRecord & { lane: "batched" })[] = []
  // Anchoring block timestamps, fetched once per block — a batched record's createdAt is when the
  // chain recorded it, the same thing a direct record's createdAt means.
  const blockTimes = new Map<bigint, bigint>()
  for (const [nsId, nsLogs] of byNamespace) {
    let namespace: string
    try {
      namespace = namespaceById(nsId).name
    } catch {
      // An unknown namespace cannot be listed or decrypted — every save in it is unreadable.
      for (const save of nsLogs) failures.push({ contextId: save.contextId, reason: "namespace is not in the frozen tree" })
      continue
    }
    let items: BatchedReadItem[]
    let partial: boolean
    try {
      const listed = await runtime.ownerApi.listBatchSaves({ owner: runtime.owner, namespaceId: nsId })
      items = listed.items
      partial = listed.partial
    } catch {
      // The store could not serve this namespace's batch table — every logged save is unreadable.
      for (const save of nsLogs) failures.push({ contextId: save.contextId, reason: "the store's batch list could not be served" })
      continue
    }
    const rows = new Map<Hex, BatchedReadItem>()
    for (const item of items) {
      const contextId = item.contextId.toLowerCase() as Hex
      rows.set(contextId, item)
      // A row the store calls ANCHORED that the chain never logged for this owner: the two
      // sources disagree, so the record cannot be certified — named, never trusted.
      if (item.state === "ANCHORED" && !anchoredIds.has(contextId)) {
        failures.push({ contextId, reason: "anchored in the store's batch table but not in the owner's SaveAnchored logs" })
      }
    }
    const namespaceSecret = await runtime.vault.deriveNamespaceSecret(nsId)
    for (const save of nsLogs) {
      try {
        const item = rows.get(save.contextId)
        if (item === undefined) throw new Error("anchored on chain but not in the store's batch table")
        const verdict = await verifyBatchedItem({
          item,
          chainId: deployment.chainId,
          deployment,
          client: runtime.ownerChain.publicClient,
          requireLatest: false,
        })
        if (!verdict.ok) throw new Error(`verification failed: ${verdict.reason}`)
        // The row must be the row the log described — batch, lineage, version and author are the
        // chain's own emitted values, not the store's claim about them.
        if (
          item.batchId?.toLowerCase() !== save.batchId ||
          item.lineageId?.toLowerCase() !== save.lineageId ||
          item.version !== save.version ||
          verdict.agentId.toLowerCase() !== save.author
        ) {
          throw new Error("the store's batch row does not match its SaveAnchored log")
        }
        const message = item.save.message
        const readEpoch = decodeUint64(message.readEpoch)
        const epochKeys = deriveEpochKeyPair(namespaceSecret, readEpoch)
        const payload = openContextObject({
          manifest: item.save.manifest,
          expectedManifestHash: message.manifestHash.toLowerCase() as Hex,
          ciphertext: bytesOf(item.save.ciphertext, item.save.manifest.ciphertextSize),
          epochPrivateKey: epochKeys.privateKey,
          binding: {
            chainId: deployment.chainId,
            contextRegistry: deployment.contextRegistry,
            contextId: item.contextId,
            namespaceId: nsId,
            readEpoch,
          },
        })
        let createdAt = blockTimes.get(save.blockNumber)
        if (createdAt === undefined) {
          if (save.blockNumber === 0n) throw new Error("the SaveAnchored log carried no block number")
          createdAt = (await runtime.ownerChain.publicClient.getBlock({ blockNumber: save.blockNumber })).timestamp
          blockTimes.set(save.blockNumber, createdAt)
        }
        records.push({
          contextId: item.contextId,
          namespaceId: nsId,
          namespace,
          authorId: verdict.agentId,
          // Amendment A.5: the contract accepts CONTEXT records on STANDARD lineages only.
          recordType: RECORD_TYPE.CONTEXT,
          kind: message.kind,
          provenanceSource: message.provenanceSource,
          lineagePolicy: LINEAGE_POLICY.STANDARD,
          lineageId: save.lineageId,
          parentId: message.parentId,
          version: save.version,
          readEpoch,
          createdAt,
          expiresAt: decodeUint64(message.expiresAt),
          manifestHash: message.manifestHash.toLowerCase() as Hex,
          payload,
          references: payload.provenance.references ?? [],
          lane: "batched",
          batchId: save.batchId,
        })
      } catch (error) {
        failures.push({ contextId: save.contextId, reason: `failed to read back: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    // A partial batch list cannot certify the namespace — unexamined rows may hide anchored
    // saves, so every save the chain logged there is named.
    if (partial) {
      for (const save of nsLogs) failures.push({ contextId: save.contextId, reason: "the store's batch list was partial" })
    }
  }
  return records
}

/**
 * Every record the owner has on this contract, decrypted (migrate B3). Enumeration starts from
 * the owner's own `ContextRegistered` logs — the chain's complete index of registrations for this
 * owner — so the namespace set is whatever the logs contain, including namespaces no local agent
 * can read. Each namespace's objects come from an owner-signed `listObjects` (the store skips
 * agent authorization for the owner), each object is re-checked against the chain record, and the
 * payload is opened with a namespace/epoch key derived from the owner seed — the spike-2 path.
 * When the deployment carries a BatchAnchor its `SaveAnchored` logs add the batched half: same
 * completeness rules, verified through the §7.1 checks, marked `lane: "batched"`.
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

  const failures: ReadFailure[] = []
  const batched = await readBatchedUniverse(runtime, failures, options?.onProgress)
  if (logs.length === 0) {
    if (failures.length > 0) throw ownerReadIncomplete(failures)
    return batched
  }

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

  // Registration order — the chain's own ordering of the owner's history — then the batched
  // items in their SaveAnchored order: the two lanes come from different contracts, so each
  // lane keeps its own sequence rather than interleaving on block numbers that mean different
  // things on different tables.
  return [...ordered.map(({ contextId }) => ({ ...decrypted.get(contextId)!, lane: "direct" as const })), ...batched]
}
