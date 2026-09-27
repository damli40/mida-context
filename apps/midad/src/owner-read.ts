import { LINEAGE_POLICY, RECORD_TYPE, decodeUint64, namespaceById } from "@mida/protocol"
import type { ContextPayload, Hex, ObjectManifest, RecordReference } from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, openContextObject } from "@mida/crypto"
import { batchAnchorAbi, contextRegistryAbi, getLogsChunked } from "@mida/chain"
import type { BatchedReadItem, ContextRecordView } from "@mida/api"
import { verifyBatchedItem } from "@mida/sdk"
import type { AbiEvent, Address } from "viem"
import { chainRefusalReason } from "./chain-busy.js"
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
  /**
   * Monad's own placement of the save — the same fields the handoff's merge orders by:
   * `at` is the chain's stamp, `block` the placing block, and `index` the save's position
   * within it (log index for a direct save, batch position for a batched one).
   */
  chain?: { at: bigint; block?: bigint; index?: number }
  /**
   * The store's own encrypted copy of this record, attached only when the caller asked for it
   * (`{ keepEncrypted: true }`). The manifest object and ciphertext bytes are exactly what the
   * store served — re-verified against the chain commitment before decryption, so what is kept
   * here is the bytes the chain actually committed to. A batched record also carries
   * `batchItem`: the store's whole row, which holds the signed save message, its signature and
   * the Merkle proof a verifier folds against `BatchAnchor.batchOf(batchId).root`. Absent by
   * default: callers that only need the plaintext (migrate) keep their memory footprint.
   */
  encrypted?: SourceEncrypted
}

/** What `keepEncrypted` keeps — the store's bytes, never anything decrypted or derived. */
export interface SourceEncrypted {
  manifest: ObjectManifest
  ciphertext: Uint8Array
  /** The store's batch row — present only on batched records. */
  batchItem?: BatchedReadItem
}

export interface ReadOwnerUniverseOptions {
  onProgress?: (done: number, total: number) => void
  /** When true, every returned record also carries the store's encrypted bytes under `encrypted`. */
  keepEncrypted?: boolean
  /**
   * Scan no further than this block — export reads the head first, then bounds every log scan
   * to it, so the block number it reports is a true upper bound on what the folder holds.
   * Absent means "to the chain's current head".
   */
  toBlock?: bigint
  /**
   * Receives the contextIds of saves the chain registered AFTER `toBlock` — whether found as
   * a store row the bounded scan predates or as a post-bound registration the store never
   * listed. They are newer than the read: excluded from the result and counted here, never
   * reported as inconsistencies. Only consulted when `toBlock` is set; a store row with no
   * registration anywhere still fails the read.
   */
  afterHead?: Set<Hex>
}

interface ReadFailure {
  /** Absent only when the gap is not one record — e.g. the store cannot serve the batch table at all. */
  contextId?: Hex
  /**
   * A short stable reason — either a fixed phrase this module mints or a machine-style code.
   * NEVER a wrapped error's own message: an RPC failure's message can carry the provider URL,
   * which may embed the API key, and this string is printed to the owner.
   */
  reason: string
}

/**
 * A plain Error carrying `.code`, `.contextIds` and `.reasons` — `owner-read-incomplete` is a
 * midad-level refusal, not a protocol code, so MidaError's closed union cannot carry it. The
 * caller builds the refusal line from the ids and reasons — the message is detail for logs.
 */
function ownerReadIncomplete(failures: readonly ReadFailure[]): Error & { code: string; contextIds: Hex[]; reasons: string[] } {
  const contextIds = [...new Set(failures.flatMap((failure) => (failure.contextId === undefined ? [] : [failure.contextId])))]
  const reasons = [...new Set(failures.map((failure) => failure.reason))]
  const detail = failures
    .map((failure) => (failure.contextId === undefined ? failure.reason : `${failure.contextId} (${failure.reason})`))
    .join("; ")
  return Object.assign(
    new Error(`owner-read-incomplete: ${failures.length} record(s) could not be read back completely: ${detail}`),
    { code: "owner-read-incomplete", contextIds, reasons },
  )
}

/**
 * The stable reason a read gap reports. Prefers a reason the throw site attached itself,
 * then a machine-style `error.code` (ENOENT, NOT_FOUND — a code, not a sentence), else a
 * generic marker — never `error.message`, which can carry an RPC URL with a key in its path.
 */
function gapReason(error: unknown): string {
  const marked = (error as { reason?: unknown }).reason
  if (typeof marked === "string" && marked !== "") return marked
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && /^[A-Za-z0-9_-]+$/.test(code)) return code
  return "read-back-failed"
}

/** A thrown error carrying the stable reason its read gap should report. */
function readGap(reason: string): Error {
  return Object.assign(new Error(reason), { reason })
}

/**
 * Rethrows the error unchanged when it is a chain/RPC failure — those carry their own
 * refusal names (chain-busy, rpc-auth, chain-misconfigured) and must surface as that
 * refusal, not be flattened into a per-record gap. Returns without throwing for everything
 * else, so a catch site can call it first and then record `gapReason(error)`.
 */
function rethrowChainError(error: unknown): void {
  if (chainRefusalReason(error) !== undefined) throw error
}

const CONTEXT_REGISTERED = contextRegistryAbi.find(
  (entry) => entry.type === "event" && entry.name === "ContextRegistered",
) as AbiEvent

const SAVE_ANCHORED = batchAnchorAbi.find(
  (entry) => entry.type === "event" && entry.name === "SaveAnchored",
) as AbiEvent

/**
 * The contextIds an event logs for this owner from `bound + 1` upward — one extra scan, run
 * lazily the first time a store row names a record the bounded scan never logged. A row whose
 * registration landed after the bound is newer than the read: excluded and counted, never an
 * inconsistency. A row the chain still has not registered anywhere stays a failure.
 */
async function idsLoggedAfter(
  runtime: Runtime,
  address: Address,
  event: AbiEvent,
  bound: bigint,
): Promise<Set<Hex>> {
  const logs = await getLogsChunked(runtime.ownerChain.publicClient, {
    address,
    event,
    args: { owner: runtime.owner },
    fromBlock: bound + 1n,
  }, { maxRange: runtime.network.logBlockRange })
  const ids = new Set<Hex>()
  for (const log of logs) ids.add((log.args as { contextId: Hex }).contextId.toLowerCase() as Hex)
  return ids
}

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
 * shortening the universe quietly. A store without the batch surface cannot even prove "nothing
 * to read" — `hasBatchedSaves(owner)` answers that instead, and any answer but a clean "none"
 * fails the read closed. `requireLatest` is off — history keeps superseded versions.
 */
async function readBatchedUniverse(
  runtime: Runtime,
  failures: ReadFailure[],
  onProgress?: (done: number, total: number) => void,
  keepEncrypted = false,
  toBlock?: bigint,
  afterHead?: Set<Hex>,
): Promise<(SourceRecord & { lane: "batched" })[]> {
  const { deployment } = runtime.network
  const batchAnchor = deployment.batchAnchor
  if (batchAnchor === undefined) return []
  // Whether this store serves the batch table for THIS anchor at all — the same question the
  // /batch/status route answers for the agent-side reader. A store without the routes (a local
  // store, a pre-batch host) or one answering for another anchor cannot prove "nothing to read":
  // its silence says nothing about what the chain holds. Only the contract's own flag can — it
  // is set on the owner's first accepted batched save and no store outage clears it. The check
  // fails closed: a thrown read is "unknown", and unknown is never treated as "none".
  const status = await runtime.ownerApi.batchStatus().catch(() => null)
  if (typeof status?.batchAnchor !== "string" || status.batchAnchor.toLowerCase() !== batchAnchor.toLowerCase()) {
    let has: boolean
    try {
      has = (await runtime.ownerChain.publicClient.readContract({
        address: batchAnchor,
        abi: batchAnchorAbi,
        functionName: "hasBatchedSaves",
        args: [runtime.owner],
      } as never)) as boolean
    } catch (error) {
      // A chain/RPC failure keeps its own refusal name (chain-busy, rpc-auth …) — rethrown
      // so the printed line names that, never the provider's message.
      rethrowChainError(error)
      throw ownerReadIncomplete([{ reason: "the chain could not say whether batched saves exist" }])
    }
    if (has) {
      throw ownerReadIncomplete([{ reason: "batched saves exist on chain but this store serves none" }])
    }
    return []
  }
  const logs = await getLogsChunked(runtime.ownerChain.publicClient, {
    address: batchAnchor,
    event: SAVE_ANCHORED,
    args: { owner: runtime.owner },
    // The anchor's own deployment block — a batched save cannot predate the contract.
    fromBlock: deployment.batchAnchorBlock ?? 0n,
    ...(toBlock === undefined ? {} : { toBlock }),
  }, { maxRange: runtime.network.logBlockRange, onProgress })

  // SaveAnchored ids after the bound — scanned ONCE, lazily, at the freshest head the call
  // sees; every store row the bounded scan never logged is judged by the same answer, and the
  // same set counts the post-bound saves the store never listed. One range scan per read, not
  // one per missed row (ex-4 G-3).
  let postBoundScan: Promise<Set<Hex>> | undefined
  const anchoredAfterHead = (): Promise<Set<Hex>> =>
    (postBoundScan ??= toBlock === undefined
      ? Promise.resolve(new Set())
      : idsLoggedAfter(runtime, batchAnchor, SAVE_ANCHORED, toBlock))

  if (logs.length === 0) {
    for (const id of await anchoredAfterHead()) afterHead?.add(id)
    return []
  }

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
  // Anchored store rows the bounded log scan never named — judged once, after every namespace's
  // list is in, against the shared post-bound scan.
  const missedAnchored = new Set<Hex>()
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
    } catch (error) {
      rethrowChainError(error)
      // The store could not serve this namespace's batch table — every logged save is unreadable.
      for (const save of nsLogs) failures.push({ contextId: save.contextId, reason: "the store's batch list could not be served" })
      continue
    }
    const rows = new Map<Hex, BatchedReadItem>()
    for (const item of items) {
      const contextId = item.contextId.toLowerCase() as Hex
      rows.set(contextId, item)
      // A row the store calls ANCHORED that the chain never logged for this owner is judged
      // once every namespace's list is in, by the shared post-bound scan below: an anchor that
      // landed after the bound is newer than the read — counted through `afterHead` — and a
      // row the chain never anchored anywhere stays a refusal, named, never trusted.
      if (item.state === "ANCHORED" && !anchoredIds.has(contextId)) missedAnchored.add(contextId)
    }
    const namespaceSecret = await runtime.vault.deriveNamespaceSecret(nsId)
    for (const save of nsLogs) {
      try {
        const item = rows.get(save.contextId)
        if (item === undefined) throw readGap("not-in-batch-table")
        const verdict = await verifyBatchedItem({
          item,
          chainId: deployment.chainId,
          deployment,
          client: runtime.ownerChain.publicClient,
          requireLatest: false,
        })
        // verdict.reason is a fixed code (root-mismatch, bad-member-proof, …) — safe to carry.
        if (!verdict.ok) throw readGap(`batch-verify-${verdict.reason}`)
        // The row must be the row the log described — batch, lineage, version and author are the
        // chain's own emitted values, not the store's claim about them.
        if (
          item.batchId?.toLowerCase() !== save.batchId ||
          item.lineageId?.toLowerCase() !== save.lineageId ||
          item.version !== save.version ||
          verdict.agentId.toLowerCase() !== save.author
        ) {
          throw readGap("batch-row-mismatch")
        }
        const message = item.save.message
        const readEpoch = decodeUint64(message.readEpoch)
        const epochKeys = deriveEpochKeyPair(namespaceSecret, readEpoch)
        const ciphertext = bytesOf(item.save.ciphertext, item.save.manifest.ciphertextSize)
        const payload = openContextObject({
          manifest: item.save.manifest,
          expectedManifestHash: message.manifestHash.toLowerCase() as Hex,
          ciphertext,
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
          if (save.blockNumber === 0n) throw readGap("no-anchor-block")
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
          // The batch's position in the anchor order — block for the anchor block, index for
          // the save's position inside the batch (the merge's tiebreak fields).
          chain: { at: createdAt, block: save.blockNumber === 0n ? undefined : save.blockNumber, index: item.position },
          ...(keepEncrypted
            ? { encrypted: { manifest: item.save.manifest, ciphertext, batchItem: item } }
            : {}),
        })
      } catch (error) {
        rethrowChainError(error)
        failures.push({ contextId: save.contextId, reason: gapReason(error) })
      }
    }
    // A partial batch list cannot certify the namespace — unexamined rows may hide anchored
    // saves, so every save the chain logged there is named.
    if (partial) {
      for (const save of nsLogs) failures.push({ contextId: save.contextId, reason: "the store's batch list was partial" })
    }
  }
  // The one post-bound scan decides every missed store row and the after-head count: a row
  // the post-bound scan names anchored "landed after the read started" — left out and counted
  // — while a row the chain never anchored anywhere is the inconsistency it always was.
  const postBoundAnchors = await anchoredAfterHead()
  for (const contextId of missedAnchored) {
    if (!postBoundAnchors.has(contextId)) {
      failures.push({ contextId, reason: "anchored in the store's batch table but not in the owner's SaveAnchored logs" })
    }
  }
  for (const id of postBoundAnchors) afterHead?.add(id)
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
 * Completeness is the point: a chain record with no object, a listed object with no chain record
 * at or before the bound, a failed decrypt, or a `partial` store list all throw
 * `owner-read-incomplete` naming the contextIds rather than silently shortening the universe.
 * The exception is a store row the chain registered only after `toBlock`: that save is newer
 * than the read, so it is left out and reported through `afterHead` instead. An owner with no
 * records returns []. Nothing is written anywhere.
 */
export async function readOwnerUniverse(
  runtime: Runtime,
  options?: ReadOwnerUniverseOptions,
): Promise<SourceRecord[]> {
  const { deployment } = runtime.network
  const logs = await getLogsChunked(runtime.ownerChain.publicClient, {
    address: deployment.contextRegistry,
    event: CONTEXT_REGISTERED,
    args: { owner: runtime.owner },
    // The home's recorded first block (loadOwnerStartBlock, resolved at Runtime.open); a brand-new
    // owner's record cannot predate it, and the value never sits below the deployment block.
    fromBlock: runtime.ownerStartBlock,
    ...(options?.toBlock === undefined ? {} : { toBlock: options.toBlock }),
  }, { maxRange: runtime.network.logBlockRange, onProgress: options?.onProgress })

  const keepEncrypted = options?.keepEncrypted === true
  const failures: ReadFailure[] = []

  // ContextRegistered ids after the bound — scanned ONCE, lazily, at the freshest head the
  // call sees; every store row the bounded scan never logged is judged by the same answer,
  // and the same set counts the post-bound registrations the store never listed. One range
  // scan per read, not one per missed row (ex-4 G-3).
  let postBoundScan: Promise<Set<Hex>> | undefined
  const registeredAfterHead = (): Promise<Set<Hex>> =>
    (postBoundScan ??= options?.toBlock === undefined
      ? Promise.resolve(new Set())
      : idsLoggedAfter(runtime, deployment.contextRegistry, CONTEXT_REGISTERED, options.toBlock))

  const batched = await readBatchedUniverse(runtime, failures, options?.onProgress, keepEncrypted, options?.toBlock, options?.afterHead)
  if (logs.length === 0) {
    for (const id of await registeredAfterHead()) options?.afterHead?.add(id)
    if (failures.length > 0) throw ownerReadIncomplete(failures)
    return batched
  }

  // The chain-side universe, in registration order: every contextId the log attributes to this
  // owner, the record tuple the registry emitted with it, and the log's own placement — the
  // block and index the handoff's merge orders by.
  const ordered: { contextId: Hex; record: ContextRecordView }[] = []
  const chainRecords = new Map<Hex, ContextRecordView>()
  const placements = new Map<Hex, { block?: bigint; index?: number }>()
  const byNamespace = new Map<Hex, Set<Hex>>()
  for (const log of logs) {
    const args = log.args as unknown as { contextId: Hex; record: ContextRecordView }
    const contextId = args.contextId.toLowerCase() as Hex
    if (chainRecords.has(contextId)) continue
    const record = args.record
    chainRecords.set(contextId, record)
    placements.set(contextId, { block: log.blockNumber ?? undefined, index: log.logIndex ?? undefined })
    ordered.push({ contextId, record })
    const namespaceId = record.namespaceId.toLowerCase() as Hex
    let ids = byNamespace.get(namespaceId)
    if (ids === undefined) byNamespace.set(namespaceId, (ids = new Set()))
    ids.add(contextId)
  }

  const decrypted = new Map<Hex, SourceRecord>()
  // Store rows the bounded log scan never named — judged once, after every namespace's list
  // is in, against the shared post-bound scan.
  const missedRows = new Set<Hex>()

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
    } catch (error) {
      rethrowChainError(error)
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
        // Registered after the bound? — judged once every namespace's list is in, by the
        // shared post-bound scan below: the save is newer than this read, not an
        // inconsistency. The chain saying nothing anywhere stays a refusal.
        missedRows.add(contextId)
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
          throw readGap("chain-row-mismatch")
        }
        const epochKeys = deriveEpochKeyPair(namespaceSecret, record.readEpoch)
        const ciphertext = bytesOf(object.ciphertext, object.manifest.ciphertextSize)
        const payload = openContextObject({
          manifest: object.manifest,
          expectedManifestHash: record.manifestHash,
          ciphertext,
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
          lane: "direct",
          // The registration log's own placement — the merge's tiebreak fields.
          chain: { at: record.createdAt, ...placements.get(contextId) },
          ...(keepEncrypted ? { encrypted: { manifest: object.manifest, ciphertext } } : {}),
        })
      } catch (error) {
        rethrowChainError(error)
        failures.push({ contextId, reason: gapReason(error) })
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

  // The one post-bound scan decides every missed store row and the after-head count: a row
  // the scan names registered "landed after the read started" — left out and counted — while
  // a row the chain never registered anywhere is the inconsistency it always was.
  const postBound = await registeredAfterHead()
  for (const contextId of missedRows) {
    if (postBound.has(contextId)) options?.afterHead?.add(contextId)
    else failures.push({ contextId, reason: "in the store but not in the owner's ContextRegistered logs" })
  }

  if (failures.length > 0) throw ownerReadIncomplete(failures)

  // Post-bound registrations the store never showed still count as "landed after the bound".
  for (const id of postBound) options?.afterHead?.add(id)

  // Registration order — the chain's own ordering of the owner's history — then the batched
  // items in their SaveAnchored order: the two lanes come from different contracts, so each
  // lane keeps its own sequence rather than interleaving on block numbers that mean different
  // things on different tables.
  return [...ordered.map(({ contextId }) => ({ ...decrypted.get(contextId)!, lane: "direct" as const })), ...batched]
}
