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
  ContextKind,
  ContextPayload,
  GrantedCapability,
  Hex,
  PurposeId,
  RecordReference,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { bytesOf, hexOf, manifestHash, openContextObject, sealContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import { capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, sendContract } from "@mida/chain"
import type { LocalWriteContext } from "@mida/chain"
import { assertGrantResponseWithinRequest, expandScopeInputs } from "@mida/grant-advisor"
import type { ScopeInput } from "@mida/grant-advisor"
import { RegistryReader } from "@mida/api"
import type { AnchoredObject, ContextApiRoutes, ContextRecordView } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { parseEventLogs, zeroHash } from "viem"
import { MemoryAccessRequestStore } from "./request-store.js"
import type { AccessRequestStore } from "./request-store.js"

/** §13.2 allows up to 600 seconds; the SDK uses 300 so a request stays valid through a normal consent screen. */
export const REQUEST_LIFETIME_SECONDS = 300n

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
}

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
      this.#grants.push({ ...grant, owner: grant.owner.toLowerCase() as Address, agentId: this.agentId, capabilities: [...grant.capabilities] })
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

  /** §12.3 read: API objects are re-checked against Monad commitments, then decrypted with this agent's own epoch wraps. */
  async read(owner: Address, namespace: string): Promise<ContextObject[]> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    const capability = this.#requireCapability(ownerAddress, namespaceId, PERMISSION.READ)
    const { deployment } = this.#chain
    const objects = await this.#api.listObjects({ owner: ownerAddress, namespaceId, capabilityId: capability.capabilityId })
    const agent = await readAgentRecord(this.#chain, this.agentId)
    const epochKeys = new Map<bigint, Uint8Array>()
    const results: ContextObject[] = []
    for (const object of objects) {
      const record = await this.#verifiedRecord(ownerAddress, namespaceId, object)
      let epochPrivateKey = epochKeys.get(record.readEpoch)
      if (epochPrivateKey === undefined) {
        const wrap = await this.#api.getEpochWrap({
          owner: ownerAddress,
          namespaceId,
          readEpoch: record.readEpoch,
          agentId: this.agentId,
          agentKeyVersion: agent.encryptionKeyVersion,
          capabilityId: capability.capabilityId,
        })
        epochPrivateKey = unwrapEpochPrivateKey({
          wrap,
          agentEncryptionPrivateKey: this.#encryptionPrivateKey,
          binding: {
            chainId: deployment.chainId,
            capabilityRegistry: deployment.capabilityRegistry,
            owner: ownerAddress,
            namespaceId,
            readEpoch: record.readEpoch,
            agentId: this.agentId,
            agentKeyVersion: agent.encryptionKeyVersion,
          },
        })
        epochKeys.set(record.readEpoch, epochPrivateKey)
      }
      const payload = openContextObject({
        manifest: object.manifest,
        expectedManifestHash: record.manifestHash,
        ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
        epochPrivateKey,
        binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: record.contextId, namespaceId, readEpoch: record.readEpoch },
      })
      await this.#verifyReferences(ownerAddress, record, payload)
      results.push(this.#toObject(record, name, payload))
    }
    return results
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
    const receipt = await sendContract(this.#chain, {
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
    })
    const record = await this.#reader.getRecord(contextId)
    if (record === null) throw new MidaError("COMMITMENT_MISMATCH", "the registered record is missing after the transaction")
    return { ...this.#toObject(record, args.name, payload), transactionHash: receipt.transactionHash }
  }

  #toObject(record: ContextRecordView, name: string, payload: ContextPayload): ContextObject {
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
    }
  }
}
