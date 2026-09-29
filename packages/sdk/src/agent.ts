import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  accessRequestTypedData,
  assertCanonicalScopes,
  batchContextId,
  canonicalJson,
  canonicalizeNamespace,
  canonicalizeOrigin,
  contextId as deriveContextId,
  decodeUint64,
  encodeUint64,
  evidenceCommitment,
  isMidaError,
  namespaceById,
  namespaceId as toNamespaceId,
  originHash,
} from "@mida/protocol"
import type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  BatchSaveMessage,
  ContextKind,
  ContextPayload,
  GrantedCapability,
  Hex,
  LineagePolicy,
  ObjectManifest,
  PurposeId,
  RecordReference,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { bytesOf, hexOf, manifestHash, openContextObject, sealContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import { blockTimeCache, capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, recordPlacementsNear, sendContract } from "@mida/chain"
import type { LocalWriteContext, RecordPlacement } from "@mida/chain"
import { assertGrantResponseWithinRequest, expandScopeInputs } from "@mida/grant-advisor"
import type { ScopeInput } from "@mida/grant-advisor"
import { RegistryReader } from "@mida/api"
import type { AnchoredObject, BatchReceipt, BatchedSaveWire, ContextApiRoutes, ContextRecordView } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { parseEventLogs, zeroHash } from "viem"
import type { TransactionReceipt } from "viem"
import { MemoryAccessRequestStore } from "./request-store.js"
import type { AccessRequestStore } from "./request-store.js"
import { signBatchSave, verifyBatchedItem, verifyPendingItem } from "./batched.js"
import type { BatchedVerdict, PendingVerdict } from "./batched.js"

/** §13.2 allows up to 600 seconds; the SDK uses 300 so a request stays valid through a normal consent screen. */
export const REQUEST_LIFETIME_SECONDS = 300n

/**
 * Objects fetched at once inside `read` (R4-2). The public RPC allows about 25 requests a
 * second and one object can cost several requests (record, wrap, references), so the work is
 * bounded — never unbounded — while still overlapping the slow network waits.
 */
const READ_CONCURRENCY = 6

export interface AccessRequestInput {
  purposeId: PurposeId
  /** Builder-supplied scopes; parents are expanded through the frozen tree before signing. */
  scopes: readonly ScopeInput[]
  /** Requested grant expiry in Unix seconds; omitted or 0n means no expiry is requested. */
  capabilityExpiresAt?: bigint
}

export interface Grant {
  owner: Address
  agentId: Hex
  requestId: Hex
  capabilities: GrantedCapability[]
}

/** The only provenance an agent can write (§11.8). USER_ASSERTED and USER_CONFIRMED need the owner. */
export type AgentProvenanceSource = "AGENT_INFERRED" | "IMPORTED" | "EXTERNAL_ATTESTATION"

export interface CreateContextInput {
  value: ContextPayload["value"]
  kind: Exclude<ContextKind, "NONE">
  source: AgentProvenanceSource
  references?: RecordReference[]
  tags?: string[]
  note?: string
  extractionConfidence?: number
  expiresAt?: bigint
}

export type SupersedeContextInput = CreateContextInput

export interface ReadOptions {
  /**
   * `false` skips the same-second placement scan entirely — for a read that never orders its
   * objects (the save duplicate-check). Default: records stamped in the same second get one
   * bounded ±64-block log scan per disjoint window to recover (block, index).
   */
  placements?: boolean
}

export interface ProposalInput {
  value: ContextPayload["value"]
  kind?: Exclude<ContextKind, "NONE">
  references?: RecordReference[]
  tags?: string[]
  note?: string
  extractionConfidence?: number
}

/**
 * One record written exactly as given (migrate B1): the payload is sealed verbatim — every
 * provenance field `create` drops survives — and the record type, kind, lineage policy, expiry,
 * parent and nonce are all the caller's. The caller predicts the id with `predictContextId`.
 */
export interface ReplayInput {
  namespaceId: Hex
  payload: ContextPayload
  recordType: "CONTEXT" | "EVIDENCE"
  kind: ContextKind
  lineagePolicy: LineagePolicy
  expiresAt: bigint
  /** The parent record's contextId, or the zero hash for a root. */
  expectedParentId: Hex
  /** Prepared by the caller; what makes a re-run land on the same id instead of duplicating. */
  objectNonce: Hex
}

export interface ContextObject {
  contextId: Hex
  owner: Address
  namespace: string
  namespaceId: Hex
  authorId: Hex
  lineageId: Hex
  parentId: Hex
  version: number
  readEpoch: bigint
  recordType: "CONTEXT" | "EVIDENCE"
  payload: ContextPayload
  transactionHash?: Hex
  /**
   * The commitment the record's bytes were sealed under: the chain row's manifestHash for an
   * anchored record, the signed batch message's for a pending one. A reader verifies the
   * payload against it — it is never trusted on its own.
   */
  manifestHash?: Hex
  /**
   * Monad's own placement of the save — set only on records the chain has actually recorded.
   * `at` is the timestamp the chain stamped (the ContextRegistry row's createdAt for a direct
   * save, the anchor block's time for a batched one); `block`, `transaction` and `index` are
   * its position in the chain's order — the anchoring block, the anchoring transaction's index
   * inside it, then the save's own position inside the transaction (the log index for a direct
   * save, the batch's own position for a batched one). Absent entirely when no chain fact
   * places the record — a pending batched save above all — and `block`/`transaction`/`index`
   * are absent when only the stamp could be recovered. `batchId` names the one batch that
   * anchored a batched-lane save: two rows sharing it share one transaction, so their `index`
   * values are positions in the same ordering and comparable without asking the chain for the
   * transaction index (in-14 F-1). Whatever an object claims inside its own payload never
   * reaches this field.
   */
  chain?: { at: bigint; block?: bigint; transaction?: number; index?: number; batchId?: Hex }
}

/**
 * What `sealReplay` produces once and `sendSealed` may send any number of times (migrate B1b): the
 * exact ciphertext and manifest the store's same-manifest repeat upload accepts, plus every field
 * `register` needs. Ciphertext only — no plaintext — so a crash between upload and register
 * resends identical bytes instead of re-sealing (a fresh seal draws a fresh key and a different
 * manifestHash the store then refuses).
 */
export interface SealedRecord {
  contextId: Hex
  namespaceId: Hex
  readEpoch: bigint
  manifest: ObjectManifest
  manifestHash: Hex
  ciphertext: Uint8Array
  onChain: {
    recordType: "CONTEXT" | "EVIDENCE"
    kind: ContextKind
    lineagePolicy: LineagePolicy
    expiresAt: bigint
    expectedParentId: Hex
    evidenceCommitment: Hex
    objectNonce: Hex
    provenanceSource: number
  }
}

/**
 * What `sendSealed` can attest: the anchored record's view plus its transaction — `ContextObject`
 * minus `payload`, because a `SealedRecord` holds no plaintext to put in it (`replay` recomposes
 * the full object from its own input). `transactionHash` is absent when the identical record was
 * already anchored — a resend is done, not sent again.
 */
export type SentRecord = Omit<ContextObject, "payload">

export interface MidaAgentConfig {
  agentId: Hex
  callbackOrigin: string
  encryptionPrivateKey: Uint8Array
  /** Write context whose account is the agent's current registered signer. */
  chain: LocalWriteContext
  /** Context API client bound to the same signer. */
  api: ContextApiRoutes & { account: { address: Address } }
  requests?: AccessRequestStore
  /**
   * Grants this agent completed in an earlier process. They only tell the agent which capabilityId to present:
   * every read is still authorised by the API against Monad and every write by the contract, so a stale or forged
   * entry buys nothing.
   */
  grants?: readonly Grant[]
}

const AGENT_SOURCES: ReadonlySet<string> = new Set(["AGENT_INFERRED", "IMPORTED", "EXTERNAL_ATTESTATION"])

/**
 * The ContextRegistered log's placement inside a register receipt — the block, the
 * transaction's index inside it, and the log's intra-block index the chain recorded for
 * exactly this contextId. A receipt that somehow carries no matching log leaves the position
 * absent; `at` (the record's chain-stored createdAt) is still set by the caller.
 */
function receiptPlacement(receipt: TransactionReceipt, contextId: Hex): RecordPlacement | undefined {
  const log = parseEventLogs({ abi: contextRegistryAbi, eventName: "ContextRegistered", logs: receipt.logs }).find(
    (entry) => (entry.args as { contextId?: Hex }).contextId?.toLowerCase() === contextId.toLowerCase(),
  )
  return log === undefined || log.blockNumber === null
    ? undefined
    : {
        block: log.blockNumber,
        ...(typeof receipt.transactionIndex === "number" ? { transaction: receipt.transactionIndex } : {}),
        index: log.logIndex,
      }
}

/** §13.1 agent/server SDK. Every authority it relies on is re-read from Monad; nothing the API returns is trusted alone. */
export class MidaAgent {
  readonly agentId: Hex
  readonly #chain: LocalWriteContext
  readonly #api: MidaAgentConfig["api"]
  readonly #callbackOrigin: string
  readonly #encryptionPrivateKey: Uint8Array
  readonly #requests: AccessRequestStore
  readonly #reader: RegistryReader
  readonly #grants: Grant[] = []

  constructor(config: MidaAgentConfig) {
    if (config.api.account.address.toLowerCase() !== config.chain.account.address.toLowerCase()) {
      throw new MidaError("AUTH_INVALID", "the API client and the chain account must both be the agent's signer")
    }
    this.agentId = config.agentId.toLowerCase() as Hex
    this.#chain = config.chain
    this.#api = config.api
    this.#callbackOrigin = config.callbackOrigin
    this.#encryptionPrivateKey = Uint8Array.from(config.encryptionPrivateKey)
    this.#requests = config.requests ?? new MemoryAccessRequestStore()
    this.#reader = new RegistryReader(config.chain)
    for (const grant of config.grants ?? []) {
      if (grant.agentId.toLowerCase() !== this.agentId) {
        throw new MidaError("AUTH_INVALID", "a restored grant belongs to a different agent")
      }
      this.#grants.push({ ...grant, owner: grant.owner.toLowerCase() as Address, agentId: this.agentId, capabilities: grant.capabilities.map((capability) => ({ ...capability })) })
    }
  }

  get grants(): readonly Grant[] {
    return this.#grants.map((grant) => ({ ...grant, capabilities: [...grant.capabilities] }))
  }

  /** The chain's own record for one contextId — null when the registry holds none. */
  async chainRecord(contextId: Hex): Promise<ContextRecordView | null> {
    return this.#reader.getRecord(contextId.toLowerCase() as Hex)
  }

  /**
   * Whether Monad lists at least one currently-valid capability for this owner–agent pair —
   * the contract's `isCapabilityValid` answer per id, not the local grant copy.
   */
  async hasLiveCapability(owner: Address): Promise<boolean> {
    const ownerAddress = owner.toLowerCase() as Address
    for (const id of await this.#reader.activeCapabilityIds(ownerAddress, this.agentId)) {
      const live = (await this.#chain.publicClient.readContract({
        address: this.#chain.deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName: "isCapabilityValid",
        args: [id],
      } as never)) as boolean
      if (live) return true
    }
    return false
  }

  /** §13.2: canonical, parent-expanded, sorted exact scopes, signed by the agent's current signer and persisted. */
  async createAccessRequest(input: AccessRequestInput): Promise<AccessRequest> {
    const { deployment, account } = this.#chain
    const agent = await readAgentRecord(this.#chain, this.agentId)
    if (agent.signer !== account.address.toLowerCase()) {
      throw new MidaError("AGENT_ID_MISMATCH", "configured signer is not the agent's current registered signer")
    }
    const callbackOrigin = canonicalizeOrigin(this.#callbackOrigin, { allowLocalhost: true })
    if (originHash(callbackOrigin) !== agent.callbackOriginHash) {
      throw new MidaError("AGENT_ID_MISMATCH", "callback origin is not the agent's registered origin")
    }
    const scopes = expandScopeInputs(input.scopes)
    assertCanonicalScopes(scopes)
    const now = await latestTimestamp(this.#chain)
    const unsigned: UnsignedAccessRequest = {
      v: 1,
      chainId: encodeUint64(deployment.chainId),
      capabilityRegistry: deployment.capabilityRegistry,
      requestId: hexOf(randomBytes(32)),
      nonce: hexOf(randomBytes(32)),
      agentId: this.agentId,
      purposeId: input.purposeId,
      callbackOrigin,
      manifestHash: agent.capabilityManifestHash,
      manifestVersion: agent.capabilityManifestVersion,
      policyVersion: POLICY_VERSION,
      namespaceTreeVersion: NAMESPACE_TREE_VERSION,
      scopes,
      issuedAt: encodeUint64(now),
      requestExpiresAt: encodeUint64(now + REQUEST_LIFETIME_SECONDS),
      capabilityExpiresAt: encodeUint64(input.capabilityExpiresAt ?? 0n),
    }
    const request: AccessRequest = { ...unsigned, agentSignature: await account.signTypedData(accessRequestTypedData(unsigned) as never) }
    await this.#requests.save(request)
    return request
  }

  /**
   * §13.3: the response must match the stored original request, stay within its authority (Part C helper), and every
   * capability must exist on Monad with identical fields, be currently valid, and be emitted by the named transaction.
   * The chain proves a capability exists; the original request proves it is the one this agent asked for.
   */
  async completeAccessRequest(request: AccessRequest, response: AccessGrantResponse): Promise<Grant> {
    const stored = await this.#requests.load(response.requestId)
    if (stored === undefined) throw new MidaError("RESPONSE_MISMATCH", "no original request is stored for this requestId")
    if (stored.consumed) throw new MidaError("REQUEST_CONSUMED", "this requestId was already completed")
    if (canonicalJson(stored.request) !== canonicalJson(request)) {
      throw new MidaError("RESPONSE_MISMATCH", "the request differs from the stored original")
    }
    const original = stored.request
    assertGrantResponseWithinRequest(original, response, await latestTimestamp(this.#chain))

    const owner = response.owner.toLowerCase() as Address
    const registry = this.#chain.deployment.capabilityRegistry
    for (const granted of response.capabilities) {
      const capability = await this.#reader.getCapability(granted.capabilityId)
      if (
        capability === null ||
        capability.owner !== owner ||
        capability.agentId !== this.agentId ||
        capability.namespaceId !== granted.namespaceId.toLowerCase() ||
        capability.permissions !== granted.permissions ||
        capability.provenancePolicy !== granted.provenancePolicy ||
        capability.expiresAt !== decodeUint64(granted.expiresAt)
      ) {
        throw new MidaError("RESPONSE_MISMATCH", `capability ${granted.capabilityId} on Monad differs from the response`)
      }
      if (!(await this.#reader.hasAuthority(owner, this.agentId, capability.namespaceId, capability.permissions, capability.provenancePolicy))) {
        throw new MidaError("CAPABILITY_DENIED", `capability ${granted.capabilityId} is not currently valid on Monad`)
      }
      const receipt = await this.#chain.publicClient.getTransactionReceipt({ hash: granted.transactionHash }).catch(() => null)
      const emitted =
        receipt !== null &&
        receipt.status === "success" &&
        parseEventLogs({ abi: capabilityRegistryAbi, eventName: "CapabilityGranted", logs: receipt.logs }).some(
          (log) =>
            log.address.toLowerCase() === registry &&
            log.args.capabilityId === granted.capabilityId &&
            log.args.owner.toLowerCase() === owner &&
            log.args.agentId === this.agentId,
        )
      if (!emitted) throw new MidaError("RESPONSE_MISMATCH", `transaction ${granted.transactionHash} did not grant ${granted.capabilityId}`)
    }

    await this.#requests.markConsumed(original.requestId)
    const grant: Grant = { owner, agentId: this.agentId, requestId: original.requestId, capabilities: [...response.capabilities] }
    this.#grants.push(grant)
    return grant
  }

  /**
   * §12.3 read: API objects are re-checked against Monad commitments, then decrypted with this
   * agent's own epoch wraps. A list the store could not fully verify is never returned as if it
   * were complete — `read` refuses it outright; callers that can carry the flag use
   * `readWithStatus` instead.
   */
  async read(owner: Address, namespace: string, options?: ReadOptions): Promise<ContextObject[]> {
    const { objects, partial } = await this.readWithStatus(owner, namespace, options)
    if (partial) {
      throw new MidaError("PARTIAL_READ", `the store could not verify the whole ${namespace} list — try again in a moment`)
    }
    return objects
  }

  /**
   * `read` plus the store's completeness flag, for callers that can surface it downstream (M3-D).
   *
   * Placement policy (in-9 R-1): `chain.at` is already chain truth on every record — the
   * contract stores `block.timestamp` as createdAt — so no log scan runs for it. The event
   * log's (block, index) is needed ONLY to order records stamped in the same second, and only
   * then does the read scan: a bounded ±64-block window around the block that second implies,
   * one getLogs per disjoint window. `{ placements: false }` skips even that (the save
   * duplicate-check needs no ordering at all); a missed window falls back to the contextId
   * tie-break, never to a whole-history scan.
   */
  async readWithStatus(
    owner: Address,
    namespace: string,
    options?: ReadOptions,
  ): Promise<{ objects: ContextObject[]; partial: boolean }> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    const capability = this.#requireCapability(ownerAddress, namespaceId, PERMISSION.READ)
    const { deployment } = this.#chain
    const { objects, partial } = await this.#api.listObjects({ owner: ownerAddress, namespaceId, capabilityId: capability.capabilityId })
    const epochKeyFor = this.#epochKeyResolver(ownerAddress, namespaceId, capability.capabilityId)
    // One batched registry read fronts all the per-object work (in-35 R-1): the list used to
    // cost a getRecord per object — ~14 sequential rounds at six workers for an 83-checkpoint
    // project, past the handoff's 7.5 s read limit — plus a getRecord per reference even when
    // the target was another listed record. getRecords answers the whole list in one
    // Multicall3 call and the map serves both checks; only a reference outside the list still
    // costs a lone getRecord. If the batch call throws, the read fails exactly as a failing
    // getRecord failed it — no retry, no fallback path, and the map dies with this read.
    const listed = new Map<string, ContextRecordView | null>()
    const batched = await this.#reader.getRecords(objects.map((object) => object.contextId))
    for (const [index, record] of batched.entries()) {
      listed.set(objects[index]!.contextId.toLowerCase(), record)
    }
    const readObject = async (object: AnchoredObject): Promise<ContextObject> => {
      const record = await this.#verifiedRecord(ownerAddress, namespaceId, object, listed)
      const epochPrivateKey = await epochKeyFor(record.readEpoch)
      const payload = openContextObject({
        manifest: object.manifest,
        expectedManifestHash: record.manifestHash,
        ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
        epochPrivateKey,
        binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: record.contextId, namespaceId, readEpoch: record.readEpoch },
      })
      await this.#verifyReferences(ownerAddress, record, payload, listed)
      return this.#toObject(record, name, payload, { at: record.createdAt })
    }
    // Workers pull indexes in list order and results land by index, so the output order is
    // identical to the sequential loop; a failing object still fails the whole read.
    const results = new Array<ContextObject>(objects.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < objects.length) {
        const index = next
        next += 1
        results[index] = await readObject(objects[index]!)
      }
    }
    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(READ_CONCURRENCY, objects.length); i += 1) workers.push(worker())
    await Promise.all(workers)
    // Only a same-second tie needs the event log: group the returned records by their chain
    // stamp, and ask for placements of the seconds that genuinely tie. A failed or missed scan
    // degrades only the tie-break — the stamp each object carries is still the contract's.
    if (options?.placements !== false && results.length > 1) {
      const bySecond = new Map<bigint, Hex[]>()
      for (const object of results) {
        const at = object.chain?.at
        if (at === undefined) continue
        const list = bySecond.get(at)
        if (list === undefined) bySecond.set(at, [object.contextId])
        else list.push(object.contextId)
      }
      const tied = new Map([...bySecond].filter((entry) => entry[1].length > 1))
      if (tied.size > 0) {
        const placements = await recordPlacementsNear({
          client: this.#chain.publicClient,
          deployment,
          owner: ownerAddress,
          namespaceId,
          tied,
        }).catch(() => new Map<string, RecordPlacement>())
        for (const object of results) {
          const placement = placements.get(object.contextId.toLowerCase())
          if (placement !== undefined && object.chain !== undefined) object.chain = { ...object.chain, ...placement }
        }
      }
    }
    return { objects: results, partial }
  }

  /**
   * The batched counterpart of `readWithStatus` (Task 4): lists the store's batch rows and verifies
   * each one itself — an anchored row only survives if its proof reaches the on-chain batch root
   * and it is the lineage's current head; a queued/submitted row is checked for everything except
   * inclusion and comes back marked `PENDING_ANCHOR` with its author agentId. The store's word for
   * a row's state is never trusted; every authority check reads the contracts.
   */
  async readBatchedWithStatus(owner: Address, namespace: string): Promise<{
    anchored: ContextObject[]
    pending: (ContextObject & { anchor: "PENDING_ANCHOR"; authorAgentId: Hex; receivedAt: number })[]
    skipped: { contextId: Hex; reason: string }[]
    partial: boolean
  }> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    const capability = this.#requireCapability(ownerAddress, namespaceId, PERMISSION.READ)
    const { deployment } = this.#chain
    if (deployment.batchAnchor === undefined) {
      throw new MidaError("INVALID_WIRE", "this deployment has no BatchAnchor — use readWithStatus()")
    }
    const { items, partial } = await this.#api.listBatchSaves({
      owner: ownerAddress,
      namespaceId,
      capabilityId: capability.capabilityId,
    })
    const epochKeyFor = this.#epochKeyResolver(ownerAddress, namespaceId, capability.capabilityId)
    // The anchor transaction's block time is Monad's stamp for every save in that batch — one
    // block lookup per distinct batch, shared across the rows it anchored.
    const blockTime = blockTimeCache(this.#chain.publicClient)
    // Each row's verify+decrypt is independent — run them under the same bounded worker pool a
    // direct read uses (in-9 R-5), then partition the indexed results in list order so anchored,
    // pending and skipped keep exactly the order the serial loop produced.
    type RowOutcome =
      | { kind: "anchored"; object: ContextObject }
      | { kind: "pending"; object: ContextObject & { anchor: "PENDING_ANCHOR"; authorAgentId: Hex; receivedAt: number } }
      | { kind: "skipped"; skipped: { contextId: Hex; reason: string } }
    const processItem = async (item: (typeof items)[number]): Promise<RowOutcome> => {
      const message = item.save.message
      // A row the store filed under the wrong owner or namespace is out of scope for this read:
      // skip it before verification or decryption ever run on it.
      if (message.owner.toLowerCase() !== ownerAddress || message.namespaceId.toLowerCase() !== namespaceId) {
        return { kind: "skipped", skipped: { contextId: item.contextId, reason: "wrong-scope" } }
      }
      // The declared union matters: without it the ternary's inferred union collapses — the
      // anchored ok-member is a subtype of the pending one and TS discards it, taking the
      // anchorBlock verdict knew about with it.
      const verdict: BatchedVerdict | PendingVerdict =
        item.state === "ANCHORED"
          ? await verifyBatchedItem({ item, chainId: deployment.chainId, deployment, client: this.#chain.publicClient, requireLatest: true })
          : await verifyPendingItem({ item, chainId: deployment.chainId, deployment, client: this.#chain.publicClient })
      if (!verdict.ok) {
        return { kind: "skipped", skipped: { contextId: item.contextId, reason: verdict.reason } }
      }
      const readEpoch = decodeUint64(message.readEpoch)
      let payload: ContextPayload
      try {
        // The key fetch is inside the guard too: a row sealed under an epoch this agent has no wrap
        // for throws there, and must skip the row — not abort the whole batched read.
        const epochPrivateKey = await epochKeyFor(readEpoch)
        payload = openContextObject({
          manifest: item.save.manifest,
          expectedManifestHash: message.manifestHash.toLowerCase() as Hex,
          ciphertext: bytesOf(item.save.ciphertext, item.save.manifest.ciphertextSize),
          epochPrivateKey,
          binding: {
            chainId: deployment.chainId,
            contextRegistry: deployment.contextRegistry,
            contextId: item.contextId,
            namespaceId,
            readEpoch,
          },
        })
      } catch {
        // One row that will not open — sealed under a key this agent cannot unwrap, or bytes that
        // pass the commitments but fail the AAD — skips the row, not the whole read.
        return { kind: "skipped", skipped: { contextId: item.contextId, reason: "decrypt" } }
      }
      const base = {
        contextId: item.contextId,
        owner: ownerAddress,
        namespace: name,
        namespaceId,
        authorId: verdict.agentId,
        parentId: message.parentId,
        readEpoch,
        recordType: "CONTEXT" as const,
        manifestHash: message.manifestHash.toLowerCase() as Hex,
        payload,
      }
      if (item.state === "ANCHORED") {
        // lineageId and version passed through the Merkle proof, so they are contract values
        // here. `anchorBlock` came back inside the verdict — the same `batchOf` answer — and its
        // position inside the batch is the save's place in the chain's order. `batchId` rides
        // along so a same-batch tie orders on positions without a placement scan (in-14 F-1).
        const chain =
          verdict.anchorBlock !== undefined
            ? {
                at: await blockTime(verdict.anchorBlock),
                block: verdict.anchorBlock,
                index: item.position,
                ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
              }
            : undefined
        return { kind: "anchored", object: { ...base, lineageId: item.lineageId!, version: item.version!, ...(chain === undefined ? {} : { chain }) } }
      }
      // Nothing is anchored yet: derive the would-be head fields from the signed message itself.
      // receivedAt is the store's own stamp — the only honest "when" a not-yet-anchored row has.
      return {
        kind: "pending",
        object: {
          ...base,
          lineageId: message.parentId === zeroHash ? item.contextId : message.lineageId,
          version: message.parentVersion + 1,
          anchor: "PENDING_ANCHOR" as const,
          authorAgentId: verdict.agentId,
          receivedAt: item.receivedAt,
        },
      }
    }
    const outcomes = new Array<RowOutcome>(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next
        next += 1
        outcomes[index] = await processItem(items[index]!)
      }
    }
    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(READ_CONCURRENCY, items.length); i += 1) workers.push(worker())
    await Promise.all(workers)
    const anchored: ContextObject[] = []
    const pending: (ContextObject & { anchor: "PENDING_ANCHOR"; authorAgentId: Hex; receivedAt: number })[] = []
    const skipped: { contextId: Hex; reason: string }[] = []
    for (const outcome of outcomes) {
      if (outcome.kind === "anchored") anchored.push(outcome.object)
      else if (outcome.kind === "pending") pending.push(outcome.object)
      else skipped.push(outcome.skipped)
    }
    return { anchored, pending, skipped, partial }
  }

  /**
   * The duplicate check behind a save (in-12 N-6): whether this owner+namespace already holds a
   * record whose decrypted payload satisfies `match`. Opening a row is local work — the epoch
   * keys are fetched once per epoch and shared — so every listed row is opened and judged, and
   * chain verification runs ONLY on the (normally zero or one) rows whose payload claims the
   * match. That ordering is safe because a row the store invented cannot reach `match`: without
   * the epoch key it cannot produce ciphertext that opens under the contextId binding, so a
   * payload that opens was sealed honestly. A claimed match is then verified against Monad
   * exactly as the full reads verify it — the store's word never decides "duplicate" — and a
   * match whose record is not really there is skipped, not believed. A partial list still
   * refuses outright: an incomplete view can never answer "not a duplicate" honestly. Returns
   * the matching record's contextId, or undefined.
   */
  async findDuplicate(
    owner: Address,
    namespace: string,
    match: (value: unknown) => boolean,
    options?: { batched?: boolean },
  ): Promise<Hex | undefined> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    const capability = this.#requireCapability(ownerAddress, namespaceId, PERMISSION.READ)
    const { deployment } = this.#chain
    const epochKeyFor = this.#epochKeyResolver(ownerAddress, namespaceId, capability.capabilityId)

    // The anchored lane: open each object against its own manifest first, then verify only a
    // matching payload. A row that will not open fails the check the same way the full read's
    // commitment check failed it — loudly, so a corrupt row can never look like "no duplicate".
    const { objects, partial } = await this.#api.listObjects({ owner: ownerAddress, namespaceId, capabilityId: capability.capabilityId })
    if (partial) {
      throw new MidaError("PARTIAL_READ", `the store could not verify the whole ${name} list — try again in a moment`)
    }
    // Pass 1 is local work except the epoch-key fetches — workers let keys for DIFFERENT epochs
    // leave together so Multicall3 can fold them into one eth_call. Verdicts land by index, so the
    // candidate order stays the store's list order.
    const matched = new Array<boolean>(objects.length).fill(false)
    let nextObject = 0
    const openWorker = async (): Promise<void> => {
      while (nextObject < objects.length) {
        const index = nextObject
        nextObject += 1
        const object = objects[index]!
        const readEpoch = decodeUint64(object.manifest.readEpoch)
        const epochPrivateKey = await epochKeyFor(readEpoch)
        const payload = openContextObject({
          manifest: object.manifest,
          expectedManifestHash: object.manifestHash,
          ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
          epochPrivateKey,
          binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: object.contextId, namespaceId, readEpoch },
        })
        matched[index] = match(payload.value)
      }
    }
    const openWorkers: Promise<void>[] = []
    for (let i = 0; i < Math.min(READ_CONCURRENCY, objects.length); i += 1) openWorkers.push(openWorker())
    await Promise.all(openWorkers)
    const candidates = objects.filter((_, index) => matched[index])
    // Pass 2 is one batched chain read for every claimed match. A claimed match the chain never
    // anchored is not a duplicate — the bytes are genuine (they opened) but no save with them
    // landed, so the store cannot conjure a duplicate by replaying them. A record that IS there
    // but disagrees is the contradiction the same checks #verifiedRecord runs throw on.
    const records = await this.#reader.getRecords(candidates.map((object) => object.contextId))
    for (const [index, record] of records.entries()) {
      const object = candidates[index]!
      if (record === null) continue
      if (
        object.manifest.contextId !== object.contextId ||
        record.owner !== ownerAddress ||
        record.namespaceId !== namespaceId ||
        record.manifestHash !== manifestHash(object.manifest) ||
        record.ciphertextCommitment !== object.manifest.ciphertextHash
      ) {
        throw new MidaError("COMMITMENT_MISMATCH", `object ${object.contextId} does not match its Monad commitments`)
      }
      return object.contextId
    }

    if (options?.batched === true && deployment.batchAnchor !== undefined) {
      // Same denial tolerance as a direct read: an agent the store will not authorize for the
      // batch list has nothing to find there, and the save's own signature is what gets judged.
      try {
        const { items, partial: batchedPartial } = await this.#api.listBatchSaves({
          owner: ownerAddress,
          namespaceId,
          capabilityId: capability.capabilityId,
        })
        if (batchedPartial) {
          throw new MidaError("PARTIAL_READ", "the batched list was incomplete — refusing to risk a duplicate save")
        }
        // Same two passes as the anchored lane: opening is local work done by workers so the
        // epoch-key reads leave together; only a row whose decrypted payload claims the match is
        // worth a chain verification, and the matched rows' proofs are asked for together so
        // Multicall3 folds them. A row that will not open — sealed under an epoch this agent has
        // no wrap for, or bytes that fail the AAD — is skipped like the full batched read skips it.
        const batchedMatch = new Array<boolean>(items.length).fill(false)
        let nextItem = 0
        const batchedOpenWorker = async (): Promise<void> => {
          while (nextItem < items.length) {
            const index = nextItem
            nextItem += 1
            const item = items[index]!
            const message = item.save.message
            if (message.owner.toLowerCase() !== ownerAddress || message.namespaceId.toLowerCase() !== namespaceId) continue
            try {
              const readEpoch = decodeUint64(message.readEpoch)
              const epochPrivateKey = await epochKeyFor(readEpoch)
              const payload = openContextObject({
                manifest: item.save.manifest,
                expectedManifestHash: message.manifestHash.toLowerCase() as Hex,
                ciphertext: bytesOf(item.save.ciphertext, item.save.manifest.ciphertextSize),
                epochPrivateKey,
                binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: item.contextId, namespaceId, readEpoch },
              })
              batchedMatch[index] = match(payload.value)
            } catch {
              // unopenable — skipped
            }
          }
        }
        const batchedOpenWorkers: Promise<void>[] = []
        for (let i = 0; i < Math.min(READ_CONCURRENCY, items.length); i += 1) batchedOpenWorkers.push(batchedOpenWorker())
        await Promise.all(batchedOpenWorkers)
        const matchedItems = items.filter((_, index) => batchedMatch[index])
        const verdicts = await Promise.all(
          matchedItems.map((item) =>
            item.state === "ANCHORED"
              ? verifyBatchedItem({ item, chainId: deployment.chainId, deployment, client: this.#chain.publicClient, requireLatest: true })
              : item.state === "QUEUED" || item.state === "SUBMITTED"
                ? verifyPendingItem({ item, chainId: deployment.chainId, deployment, client: this.#chain.publicClient })
                : Promise.resolve(null),
          ),
        )
        for (const [index, verdict] of verdicts.entries()) {
          if (verdict !== null && verdict.ok) return matchedItems[index]!.contextId
        }
      } catch (error) {
        if (!isMidaError(error, "CAPABILITY_DENIED")) throw error
      }
    }
    return undefined
  }

  async create(owner: Address, namespace: string, input: CreateContextInput): Promise<ContextObject> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    return this.#write({
      owner: ownerAddress,
      name,
      namespaceId,
      expectedParentId: zeroHash,
      input,
      capability: this.#requireCapability(ownerAddress, namespaceId, PERMISSION.CREATE),
    })
  }

  /**
   * The BatchAnchor write path (Task 4): seals the same checkpoint shape as `create` — a new
   * STANDARD-lineage CONTEXT record, always AGENT_INFERRED — but signs it for the batch queue
   * instead of calling `contexts.register`. The signature is the whole authorization; no
   * transaction leaves this method.
   */
  async createBatched(
    owner: Address,
    namespace: string,
    input: CreateContextInput,
  ): Promise<{ contextId: Hex; state: "QUEUED"; receipt: BatchReceipt }> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    this.#requireCapability(ownerAddress, namespaceId, PERMISSION.CREATE)
    if (input.source !== "AGENT_INFERRED") {
      throw new MidaError("PROVENANCE_FORBIDDEN", "a batched save is the checkpoint shape — always AGENT_INFERRED")
    }
    if (!Object.hasOwn(CONTEXT_KIND, input.kind) || (input.kind as string) === "NONE") {
      throw new MidaError("INVALID_WIRE", `unknown context kind ${String(input.kind)}`)
    }
    const { deployment } = this.#chain
    const batchAnchor = deployment.batchAnchor
    if (batchAnchor === undefined) {
      throw new MidaError("INVALID_WIRE", "this deployment has no BatchAnchor — use create()")
    }
    const readEpoch = await this.#reader.requiredReadEpoch(ownerAddress, namespaceId)
    const epochPublicKey = await this.#reader.epochPublicKey(ownerAddress, namespaceId, readEpoch)
    if (epochPublicKey === null || !(await this.#reader.isWriteEpochValid(ownerAddress, namespaceId, readEpoch))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the current read epoch does not accept writes")
    }
    const objectNonce = hexOf(randomBytes(32))
    const contextId = batchContextId({
      chainId: deployment.chainId,
      batchAnchor,
      owner: ownerAddress,
      agentId: this.agentId,
      namespaceId,
      parentId: zeroHash,
      objectNonce,
    })
    const references = input.references ?? []
    const payload: ContextPayload = {
      v: 1,
      value: input.value,
      kind: input.kind,
      provenance: {
        source: input.source,
        ...(references.length === 0 ? {} : { references }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.extractionConfidence === undefined ? {} : { extractionConfidence: input.extractionConfidence }),
      },
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    }
    // CREATE needs only the public epoch key, exactly as #write.
    const sealed = sealContextObject({
      payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    const message: BatchSaveMessage = {
      owner: ownerAddress,
      namespaceId,
      objectNonce,
      lineageId: zeroHash,
      parentId: zeroHash,
      parentVersion: 0,
      rootAuthor: zeroHash,
      manifestHash: sealed.manifestHash,
      ciphertextCommitment: sealed.ciphertextCommitment,
      readEpoch,
      expiresAt: input.expiresAt ?? 0n,
      kind: CONTEXT_KIND[input.kind],
      provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
    }
    const signature = await signBatchSave({ account: this.#chain.account, chainId: deployment.chainId, batchAnchor, message })
    const wire: BatchedSaveWire = {
      message: { ...message, readEpoch: encodeUint64(readEpoch), expiresAt: encodeUint64(message.expiresAt) },
      signature,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
    }
    let receipt: BatchReceipt
    try {
      ;({ receipt } = await this.#api.postBatchSave(wire))
    } catch (error) {
      // ALREADY_QUEUED is the queued answer through the error channel: the store already holds
      // the save this POST attempted, but the 409 body does not echo which contextId that is.
      // The attempted id rides on the error so a resubmitting caller (the midad drain) can keep
      // following the save it already has instead of treating the answer as a refusal (in-13 M-4).
      if ((error as { code?: unknown }).code === "ALREADY_QUEUED") {
        ;(error as { contextId?: Hex }).contextId = contextId
      }
      throw error
    }
    return { contextId, state: "QUEUED", receipt }
  }

  /** §11.6: SUPERSEDE_ANY on another author's STANDARD lineage, SUPERSEDE_OWN (or ANY) on this agent's own lineage. */
  async supersede(owner: Address, parentId: Hex, input: SupersedeContextInput): Promise<ContextObject> {
    const ownerAddress = owner.toLowerCase() as Address
    const parent = await this.#reader.getRecord(parentId)
    if (parent === null || parent.owner !== ownerAddress || parent.recordType !== RECORD_TYPE.CONTEXT) {
      throw new MidaError("NOT_FOUND", "parent is not a context record of this owner")
    }
    if (parent.lineagePolicy === LINEAGE_POLICY.OWNER_CONTROLLED) {
      throw new MidaError("ANCHOR_OWNER_ONLY", "only the owner may supersede an owner-controlled lineage")
    }
    const ownLineage = (await this.#reader.getRecord(parent.lineageId))?.author === this.agentId
    const capability =
      this.#findCapability(ownerAddress, parent.namespaceId, PERMISSION.SUPERSEDE_ANY) ??
      (ownLineage ? this.#findCapability(ownerAddress, parent.namespaceId, PERMISSION.SUPERSEDE_OWN) : undefined)
    if (capability === undefined) throw new MidaError("CAPABILITY_DENIED", "no completed grant allows superseding this lineage")
    return this.#write({
      owner: ownerAddress,
      name: namespaceById(parent.namespaceId).name,
      namespaceId: parent.namespaceId,
      expectedParentId: parentId,
      input,
      capability,
    })
  }

  /** Always AGENT_INFERRED; the owner decides later whether to confirm it. */
  propose(owner: Address, namespace: string, input: ProposalInput): Promise<ContextObject> {
    return this.create(owner, namespace, { ...input, kind: input.kind ?? "INFERENCE", source: "AGENT_INFERRED" })
  }

  /** The contextId a `replay` with this nonce will produce — computed before sending. */
  predictContextId(owner: Address, namespaceId: Hex, objectNonce: Hex): Hex {
    const { deployment } = this.#chain
    return deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: owner.toLowerCase() as Address,
      authorId: this.agentId,
      namespaceId: namespaceId.toLowerCase() as Hex,
      objectNonce,
    })
  }

  /**
   * Writes one record exactly as given (migrate B1). Unlike `#write` it does not rebuild the
   * payload — `sourceHash`, `sourceUri`, `retrievedAt`, `note`, `extractionConfidence`,
   * `references` and `tags` all reach the seal — and it adds no provenance restriction of its
   * own: the ordinary capability and epoch checks apply, and the contract stays the authority.
   * Seal once, then send those bytes (migrate B1b).
   */
  async replay(owner: Address, input: ReplayInput): Promise<ContextObject> {
    const sealed = await this.sealReplay(owner, input)
    const sent = await this.sendSealed(owner, sealed)
    return { ...sent, payload: input.payload }
  }

  /**
   * Seals a replay exactly once and writes nothing (migrate B1b): the capability, epoch, id and
   * every byte `sendSealed` needs, frozen so a retry — including after a crash between upload and
   * register — resends identical bytes. The epoch is checked here and again at send: a seal that
   * outlives its epoch is refused, never silently resealed under a different epoch.
   */
  async sealReplay(owner: Address, input: ReplayInput): Promise<SealedRecord> {
    if (input.payload.kind !== input.kind) {
      throw new MidaError("INVALID_WIRE", "the payload kind and the record kind disagree")
    }
    const ownerAddress = owner.toLowerCase() as Address
    const namespaceId = input.namespaceId.toLowerCase() as Hex
    // Fail fast on the capability the send will need — keeping bytes for a write this agent cannot
    // make buys nothing.
    if (input.expectedParentId === zeroHash) {
      this.#requireCapability(ownerAddress, namespaceId, PERMISSION.CREATE)
    } else {
      await this.#supersedeCapability(ownerAddress, namespaceId, input.expectedParentId)
    }
    const { deployment } = this.#chain
    const readEpoch = await this.#reader.requiredReadEpoch(ownerAddress, namespaceId)
    const epochPublicKey = await this.#reader.epochPublicKey(ownerAddress, namespaceId, readEpoch)
    if (epochPublicKey === null || !(await this.#reader.isWriteEpochValid(ownerAddress, namespaceId, readEpoch))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the current read epoch does not accept writes")
    }
    const contextId = this.predictContextId(ownerAddress, namespaceId, input.objectNonce)
    const sealed = sealContextObject({
      payload: input.payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    const references = input.payload.provenance.references ?? []
    return {
      contextId,
      namespaceId,
      readEpoch,
      manifest: sealed.manifest,
      manifestHash: sealed.manifestHash,
      ciphertext: sealed.ciphertext,
      onChain: {
        recordType: input.recordType,
        kind: input.kind,
        lineagePolicy: input.lineagePolicy,
        expiresAt: input.expiresAt,
        expectedParentId: input.expectedParentId,
        evidenceCommitment: references.length === 0 ? zeroHash : evidenceCommitment(references),
        objectNonce: input.objectNonce,
        provenanceSource: PROVENANCE_SOURCE[input.payload.provenance.source],
      },
    }
  }

  /**
   * Sends the bytes `sealReplay` produced — the same bytes on every call (migrate B1b). The store
   * accepts a repeat upload only for an identical manifest, so a resend after an upload-only crash
   * lands; a record already anchored with this exact manifestHash is done, not sent again; a stale
   * epoch refuses `EPOCH_ROTATION_REQUIRED` before anything leaves this process.
   */
  async sendSealed(owner: Address, sealed: SealedRecord): Promise<SentRecord> {
    const ownerAddress = owner.toLowerCase() as Address
    const namespaceId = sealed.namespaceId.toLowerCase() as Hex
    const capability =
      sealed.onChain.expectedParentId === zeroHash
        ? this.#requireCapability(ownerAddress, namespaceId, PERMISSION.CREATE)
        : await this.#supersedeCapability(ownerAddress, namespaceId, sealed.onChain.expectedParentId)
    if (!(await this.#reader.isWriteEpochValid(ownerAddress, namespaceId, sealed.readEpoch))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the sealed record's read epoch no longer accepts writes")
    }
    await this.#api.putObject({
      owner: ownerAddress,
      namespaceId,
      objectNonce: sealed.onChain.objectNonce,
      expectedParentId: sealed.onChain.expectedParentId,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
      capabilityId: capability.capabilityId,
    })
    const { deployment } = this.#chain
    const anchored = await this.#reader.getRecord(sealed.contextId)
    if (anchored !== null && anchored.manifestHash === sealed.manifestHash) {
      // already on chain — the stamp is still the record's own; only the log position is unknown
      return this.#toSentObject(anchored, undefined, { at: anchored.createdAt })
    }
    // in-3 I6, same question as #write's: the upload is in, but a deny the owner staged since is
    // known only to the store — ask it before a register transaction exists. WRITE_DENIED is a
    // pending revoke (the sealed bytes stay sendable once it clears), CAPABILITY_REVOKED a landed one.
    await this.#api.writeAuthority({
      owner: ownerAddress,
      namespaceId,
      capabilityId: capability.capabilityId,
      expectedParentId: sealed.onChain.expectedParentId,
    })
    const receipt = await sendContract(
      this.#chain,
      {
        address: deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "register",
        args: [
          ownerAddress,
          [
            {
              contextId: sealed.contextId,
              objectNonce: sealed.onChain.objectNonce,
              namespaceId,
              expectedParentId: sealed.onChain.expectedParentId,
              manifestHash: sealed.manifestHash,
              ciphertextCommitment: sealed.manifest.ciphertextHash,
              evidenceCommitment: sealed.onChain.evidenceCommitment,
              readEpoch: sealed.readEpoch,
              expiresAt: sealed.onChain.expiresAt,
              recordType: RECORD_TYPE[sealed.onChain.recordType],
              lineagePolicy: LINEAGE_POLICY[sealed.onChain.lineagePolicy],
              kind: CONTEXT_KIND[sealed.onChain.kind],
              provenanceSource: sealed.onChain.provenanceSource,
            },
          ],
        ],
      },
      "context.register",
    )
    const record = await this.#reader.getRecord(sealed.contextId)
    if (record === null) throw new MidaError("COMMITMENT_MISMATCH", "the registered record is missing after the transaction")
    return this.#toSentObject(record, receipt.transactionHash, {
      at: record.createdAt,
      ...receiptPlacement(receipt, sealed.contextId),
    })
  }

  /** The grant that lets this agent write under an existing parent: SUPERSEDE_ANY, or SUPERSEDE_OWN on its own lineage. */
  async #supersedeCapability(owner: Address, namespaceId: Hex, parentId: Hex): Promise<GrantedCapability> {
    const any = this.#findCapability(owner, namespaceId, PERMISSION.SUPERSEDE_ANY)
    if (any !== undefined) return any
    const parent = await this.#reader.getRecord(parentId)
    if (parent !== null && (await this.#reader.getRecord(parent.lineageId))?.author === this.agentId) {
      const own = this.#findCapability(owner, namespaceId, PERMISSION.SUPERSEDE_OWN)
      if (own !== undefined) return own
    }
    throw new MidaError("CAPABILITY_DENIED", "no completed grant allows superseding this lineage")
  }

  #findCapability(owner: Address, namespaceId: Hex, permission: number): GrantedCapability | undefined {
    for (const grant of [...this.#grants].reverse()) {
      if (grant.owner !== owner) continue
      const match = grant.capabilities.find(
        (capability) => capability.namespaceId.toLowerCase() === namespaceId && (capability.permissions & permission) === permission,
      )
      if (match !== undefined) return match
    }
    return undefined
  }

  #requireCapability(owner: Address, namespaceId: Hex, permission: number): GrantedCapability {
    const capability = this.#findCapability(owner, namespaceId, permission)
    if (capability === undefined) throw new MidaError("CAPABILITY_DENIED", "no completed grant covers this owner, namespace and permission")
    return capability
  }

  /**
   * The epoch-key fetch `readWithStatus` and `readBatchedWithStatus` share. The agent record's key
   * version is needed only to unwrap an epoch key — and only a non-empty list has objects to open,
   * so an empty read spends no chain call here. Each distinct epoch key is fetched exactly once,
   * also under concurrency: the map holds the in-flight promise, so workers on the same epoch share
   * one call.
   */
  #epochKeyResolver(ownerAddress: Address, namespaceId: Hex, capabilityId: Hex): (readEpoch: bigint) => Promise<Uint8Array> {
    const { deployment } = this.#chain
    let agentRecord: Promise<Awaited<ReturnType<typeof readAgentRecord>>> | undefined
    const agent = () => (agentRecord ??= readAgentRecord(this.#chain, this.agentId))
    const epochKeys = new Map<bigint, Promise<Uint8Array>>()
    return (readEpoch: bigint): Promise<Uint8Array> => {
      let pending = epochKeys.get(readEpoch)
      if (pending === undefined) {
        pending = agent().then((record) =>
          this.#api
            .getEpochWrap({
              owner: ownerAddress,
              namespaceId,
              readEpoch,
              agentId: this.agentId,
              agentKeyVersion: record.encryptionKeyVersion,
              capabilityId,
            })
            .then((wrap) =>
              unwrapEpochPrivateKey({
                wrap,
                agentEncryptionPrivateKey: this.#encryptionPrivateKey,
                binding: {
                  chainId: deployment.chainId,
                  capabilityRegistry: deployment.capabilityRegistry,
                  owner: ownerAddress,
                  namespaceId,
                  readEpoch,
                  agentId: this.agentId,
                  agentKeyVersion: record.encryptionKeyVersion,
                },
              }),
            ),
        )
        epochKeys.set(readEpoch, pending)
      }
      return pending
    }
  }

  /**
   * The record the object claims plus every check that claim implies — the same set either way.
   * `listed` is the one-batch answer readWithStatus fetched: a key present in it (even a null,
   * the registry's "no such record") is used as-is; an id the batch somehow did not cover falls
   * back to a lone getRecord rather than skipping verification.
   */
  async #verifiedRecord(
    owner: Address,
    namespaceId: Hex,
    object: AnchoredObject,
    listed: ReadonlyMap<string, ContextRecordView | null>,
  ): Promise<ContextRecordView> {
    const id = object.contextId.toLowerCase()
    const record = listed.has(id) ? listed.get(id)! : await this.#reader.getRecord(object.contextId)
    if (
      record === null ||
      object.manifest.contextId !== object.contextId ||
      record.owner !== owner ||
      record.namespaceId !== namespaceId ||
      record.manifestHash !== manifestHash(object.manifest) ||
      record.ciphertextCommitment !== object.manifest.ciphertextHash
    ) {
      throw new MidaError("COMMITMENT_MISMATCH", `object ${object.contextId} does not match its Monad commitments`)
    }
    return record
  }

  /**
   * §11.8, relation-aware: references must recompute the committed value and name records that exist for this owner.
   * `supports`/`derived_from` claim evidentiary support, so their targets must be EVIDENCE records; `confirmed_from`
   * acknowledges an agent proposal, which is itself a CONTEXT record. USER_CONFIRMED then needs at least one
   * `confirmed_from` reference, and IMPORTED/EXTERNAL_ATTESTATION at least one evidence-record target.
   */
  async #verifyReferences(
    owner: Address,
    record: ContextRecordView,
    payload: ContextPayload,
    listed: ReadonlyMap<string, ContextRecordView | null>,
  ): Promise<void> {
    const references = payload.provenance.references ?? []
    const commitment = references.length === 0 ? zeroHash : evidenceCommitment(references)
    if (commitment !== record.evidenceCommitment) {
      throw new MidaError("COMMITMENT_MISMATCH", `references of ${record.contextId} do not match its evidence commitment`)
    }
    let evidenceTargets = 0
    let confirmedFrom = 0
    // The reference lookups are independent reads — asked together (in-9 R-5), then each judged
    // in order exactly as the serial loop did. A target that is itself a listed record is
    // already answered by the batch (in-35 R-1); only an outside id still costs a chain call.
    const targets = await Promise.all(
      references.map((reference) => {
        const id = reference.recordId.toLowerCase()
        return listed.has(id) ? listed.get(id)! : this.#reader.getRecord(reference.recordId)
      }),
    )
    for (const [index, reference] of references.entries()) {
      const target = targets[index]!
      if (target === null || target.owner !== owner) {
        throw new MidaError("COMMITMENT_MISMATCH", `referenced record ${reference.recordId} does not exist for this owner`)
      }
      if (target.recordType === RECORD_TYPE.EVIDENCE) {
        evidenceTargets += 1
      } else if (reference.relation !== "confirmed_from") {
        throw new MidaError("PROVENANCE_FORBIDDEN", `referenced record ${reference.recordId} is not an evidence record`)
      }
      if (reference.relation === "confirmed_from") confirmedFrom += 1
    }
    if (record.provenanceSource === PROVENANCE_SOURCE.USER_CONFIRMED && confirmedFrom === 0) {
      throw new MidaError("PROVENANCE_FORBIDDEN", `record ${record.contextId} claims USER_CONFIRMED without a confirmed_from reference`)
    }
    if (
      (record.provenanceSource === PROVENANCE_SOURCE.IMPORTED || record.provenanceSource === PROVENANCE_SOURCE.EXTERNAL_ATTESTATION) &&
      evidenceTargets === 0
    ) {
      throw new MidaError("PROVENANCE_FORBIDDEN", `record ${record.contextId} does not reveal a registered evidence-record ID`)
    }
  }

  async #write(args: {
    owner: Address
    name: string
    namespaceId: Hex
    expectedParentId: Hex
    input: CreateContextInput
    capability: GrantedCapability
  }): Promise<ContextObject> {
    const { input } = args
    if (!AGENT_SOURCES.has(input.source)) {
      throw new MidaError("PROVENANCE_FORBIDDEN", `an agent cannot write provenance ${String(input.source)}`)
    }
    const references = input.references ?? []
    if (input.source !== "AGENT_INFERRED" && references.length === 0) {
      throw new MidaError("PROVENANCE_FORBIDDEN", `${input.source} requires at least one evidence reference`)
    }
    if (!Object.hasOwn(CONTEXT_KIND, input.kind) || (input.kind as string) === "NONE") {
      throw new MidaError("INVALID_WIRE", `unknown context kind ${String(input.kind)}`)
    }
    const { deployment } = this.#chain
    const readEpoch = await this.#reader.requiredReadEpoch(args.owner, args.namespaceId)
    const epochPublicKey = await this.#reader.epochPublicKey(args.owner, args.namespaceId, readEpoch)
    if (epochPublicKey === null || !(await this.#reader.isWriteEpochValid(args.owner, args.namespaceId, readEpoch))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the current read epoch does not accept writes")
    }
    const objectNonce = hexOf(randomBytes(32))
    const contextId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: args.owner,
      authorId: this.agentId,
      namespaceId: args.namespaceId,
      objectNonce,
    })
    const payload: ContextPayload = {
      v: 1,
      value: input.value,
      kind: input.kind,
      provenance: {
        source: input.source,
        ...(references.length === 0 ? {} : { references }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.extractionConfidence === undefined ? {} : { extractionConfidence: input.extractionConfidence }),
      },
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    }
    // CREATE needs only the public epoch key: the agent can encrypt to the namespace without being able to read it.
    const sealed = sealContextObject({
      payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId: args.namespaceId, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    await this.#api.putObject({
      owner: args.owner,
      namespaceId: args.namespaceId,
      objectNonce,
      expectedParentId: args.expectedParentId,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
      capabilityId: args.capability.capabilityId,
    })
    // in-3 I6: the upload passed the store's gates, but a revoke the owner staged while the bytes
    // were in flight is invisible to the contract — only the store knows. The last question before
    // a transaction goes out is therefore the store's: WRITE_DENIED means the deny is still pending
    // (the write parks, the deny may yet clear); CAPABILITY_REVOKED means it landed (the write is
    // dead). Neither answer lets a register leave this process.
    await this.#api.writeAuthority({
      owner: args.owner,
      namespaceId: args.namespaceId,
      capabilityId: args.capability.capabilityId,
      expectedParentId: args.expectedParentId,
    })
    const receipt = await sendContract(
      this.#chain,
      {
        address: deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "register",
        args: [
          args.owner,
          [
            {
              contextId,
              objectNonce,
              namespaceId: args.namespaceId,
              expectedParentId: args.expectedParentId,
              manifestHash: sealed.manifestHash,
              ciphertextCommitment: sealed.ciphertextCommitment,
              evidenceCommitment: references.length === 0 ? zeroHash : evidenceCommitment(references),
              readEpoch,
              expiresAt: input.expiresAt ?? 0n,
              recordType: RECORD_TYPE.CONTEXT,
              lineagePolicy: LINEAGE_POLICY.STANDARD,
              kind: CONTEXT_KIND[input.kind],
              provenanceSource: PROVENANCE_SOURCE[input.source],
            },
          ],
        ],
      },
      "context.register",
    )
    const record = await this.#reader.getRecord(contextId)
    if (record === null) throw new MidaError("COMMITMENT_MISMATCH", "the registered record is missing after the transaction")
    return {
      ...this.#toObject(record, args.name, payload, { at: record.createdAt, ...receiptPlacement(receipt, contextId) }),
      transactionHash: receipt.transactionHash,
    }
  }

  #toObject(record: ContextRecordView, name: string, payload: ContextPayload, chain?: ContextObject["chain"]): ContextObject {
    return {
      contextId: record.contextId,
      owner: record.owner,
      namespace: name,
      namespaceId: record.namespaceId,
      authorId: record.author,
      lineageId: record.lineageId,
      parentId: record.parentId,
      version: record.version,
      readEpoch: record.readEpoch,
      recordType: record.recordType === RECORD_TYPE.EVIDENCE ? "EVIDENCE" : "CONTEXT",
      manifestHash: record.manifestHash,
      payload,
      ...(chain === undefined ? {} : { chain }),
    }
  }

  /** The on-chain view `sendSealed` returns — `ContextObject` minus the plaintext it cannot have. */
  #toSentObject(record: ContextRecordView, transactionHash?: Hex, chain?: ContextObject["chain"]): SentRecord {
    return {
      contextId: record.contextId,
      owner: record.owner,
      namespace: namespaceById(record.namespaceId).name,
      namespaceId: record.namespaceId,
      authorId: record.author,
      lineageId: record.lineageId,
      parentId: record.parentId,
      version: record.version,
      readEpoch: record.readEpoch,
      recordType: record.recordType === RECORD_TYPE.EVIDENCE ? "EVIDENCE" : "CONTEXT",
      manifestHash: record.manifestHash,
      ...(transactionHash === undefined ? {} : { transactionHash }),
      ...(chain === undefined ? {} : { chain }),
    }
  }
}
