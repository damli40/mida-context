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
import { blockTimeCache, capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, recordPlacements, sendContract } from "@mida/chain"
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
   * Monad's own placement of the save — set only on records the chain has actually recorded.
   * `at` is the timestamp the chain stamped (the ContextRegistry row's createdAt for a direct
   * save, the anchor block's time for a batched one); `block` and `index` are its position in
   * the chain's order — the log index for a direct save, the batch's own position for a batched
   * one. Absent entirely when no chain fact places the record — a pending batched save above
   * all — and `block`/`index` are absent when only the stamp could be recovered. Whatever an
   * object claims inside its own payload never reaches this field.
   */
  chain?: { at: bigint; block?: bigint; index?: number }
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
 * The ContextRegistered log's placement inside a register receipt — the block and intra-block
 * index the chain recorded for exactly this contextId. A receipt that somehow carries no matching
 * log leaves the position absent; `at` (the record's chain-stored createdAt) is still set by the
 * caller.
 */
function receiptPlacement(receipt: TransactionReceipt, contextId: Hex): RecordPlacement | undefined {
  const log = parseEventLogs({ abi: contextRegistryAbi, eventName: "ContextRegistered", logs: receipt.logs }).find(
    (entry) => (entry.args as { contextId?: Hex }).contextId?.toLowerCase() === contextId.toLowerCase(),
  )
  return log === undefined || log.blockNumber === null ? undefined : { block: log.blockNumber, index: log.logIndex }
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
  async read(owner: Address, namespace: string): Promise<ContextObject[]> {
    const { objects, partial } = await this.readWithStatus(owner, namespace)
    if (partial) {
      throw new MidaError("PARTIAL_READ", `the store could not verify the whole ${namespace} list — try again in a moment`)
    }
    return objects
  }

  /** `read` plus the store's completeness flag, for callers that can surface it downstream (M3-D). */
  async readWithStatus(owner: Address, namespace: string): Promise<{ objects: ContextObject[]; partial: boolean }> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    const capability = this.#requireCapability(ownerAddress, namespaceId, PERMISSION.READ)
    const { deployment } = this.#chain
    const { objects, partial } = await this.#api.listObjects({ owner: ownerAddress, namespaceId, capabilityId: capability.capabilityId })
    // Monad's own placement of every record: `at` is already chain truth on the record itself
    // (the contract stores block.timestamp as createdAt); the block and log index come from one
    // owner-scoped ContextRegistered scan. A failed scan degrades only the same-second tie-break
    // — the stamp each object carries is still the contract's, never the writer's claim.
    const placements =
      objects.length === 0
        ? new Map<string, RecordPlacement>()
        : await recordPlacements({ client: this.#chain.publicClient, deployment, owner: ownerAddress, namespaceId }).catch(
            () => new Map<string, RecordPlacement>(),
          )
    const epochKeyFor = this.#epochKeyResolver(ownerAddress, namespaceId, capability.capabilityId)
    const readObject = async (object: AnchoredObject): Promise<ContextObject> => {
      const record = await this.#verifiedRecord(ownerAddress, namespaceId, object)
      const epochPrivateKey = await epochKeyFor(record.readEpoch)
      const payload = openContextObject({
        manifest: object.manifest,
        expectedManifestHash: record.manifestHash,
        ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
        epochPrivateKey,
        binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: record.contextId, namespaceId, readEpoch: record.readEpoch },
      })
      await this.#verifyReferences(ownerAddress, record, payload)
      return this.#toObject(record, name, payload, {
        at: record.createdAt,
        ...(placements.get(record.contextId.toLowerCase()) ?? {}),
      })
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
    pending: (ContextObject & { anchor: "PENDING_ANCHOR"; authorAgentId: Hex })[]
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
    const anchored: ContextObject[] = []
    const pending: (ContextObject & { anchor: "PENDING_ANCHOR"; authorAgentId: Hex })[] = []
    const skipped: { contextId: Hex; reason: string }[] = []
    for (const item of items) {
      const message = item.save.message
      // A row the store filed under the wrong owner or namespace is out of scope for this read:
      // skip it before verification or decryption ever run on it.
      if (message.owner.toLowerCase() !== ownerAddress || message.namespaceId.toLowerCase() !== namespaceId) {
        skipped.push({ contextId: item.contextId, reason: "wrong-scope" })
        continue
      }
      // The declared union matters: without it the ternary's inferred union collapses — the
      // anchored ok-member is a subtype of the pending one and TS discards it, taking the
      // anchorBlock verdict knew about with it.
      const verdict: BatchedVerdict | PendingVerdict =
        item.state === "ANCHORED"
          ? await verifyBatchedItem({ item, chainId: deployment.chainId, deployment, client: this.#chain.publicClient, requireLatest: true })
          : await verifyPendingItem({ item, chainId: deployment.chainId, deployment, client: this.#chain.publicClient })
      if (!verdict.ok) {
        skipped.push({ contextId: item.contextId, reason: verdict.reason })
        continue
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
        skipped.push({ contextId: item.contextId, reason: "decrypt" })
        continue
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
        payload,
      }
      if (item.state === "ANCHORED") {
        // lineageId and version passed through the Merkle proof, so they are contract values
        // here. `anchorBlock` came back inside the verdict — the same `batchOf` answer — and its
        // position inside the batch is the save's place in the chain's order.
        const chain =
          verdict.anchorBlock !== undefined
            ? { at: await blockTime(verdict.anchorBlock), block: verdict.anchorBlock, index: item.position }
            : undefined
        anchored.push({ ...base, lineageId: item.lineageId!, version: item.version!, ...(chain === undefined ? {} : { chain }) })
      } else {
        // Nothing is anchored yet: derive the would-be head fields from the signed message itself.
        pending.push({
          ...base,
          lineageId: message.parentId === zeroHash ? item.contextId : message.lineageId,
          version: message.parentVersion + 1,
          anchor: "PENDING_ANCHOR",
          authorAgentId: verdict.agentId,
        })
      }
    }
    return { anchored, pending, skipped, partial }
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
    const { receipt } = await this.#api.postBatchSave(wire)
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

  async #verifiedRecord(owner: Address, namespaceId: Hex, object: AnchoredObject): Promise<ContextRecordView> {
    const record = await this.#reader.getRecord(object.contextId)
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
  async #verifyReferences(owner: Address, record: ContextRecordView, payload: ContextPayload): Promise<void> {
    const references = payload.provenance.references ?? []
    const commitment = references.length === 0 ? zeroHash : evidenceCommitment(references)
    if (commitment !== record.evidenceCommitment) {
      throw new MidaError("COMMITMENT_MISMATCH", `references of ${record.contextId} do not match its evidence commitment`)
    }
    let evidenceTargets = 0
    let confirmedFrom = 0
    for (const reference of references) {
      const target = await this.#reader.getRecord(reference.recordId)
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
      ...(transactionHash === undefined ? {} : { transactionHash }),
      ...(chain === undefined ? {} : { chain }),
    }
  }
}
