import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  MidaError,
  NAMESPACE_TREE_VERSION,
  OWNER_AUTHOR_ID,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  accessRequestHash,
  cancelFastRevokeDigest,
  canonicalizeNamespace,
  contextId as deriveContextId,
  decodeUint64,
  encodeUint64,
  grantDigest,
  hashString,
  namespaceById,
  namespaceId as toNamespaceId,
  originHash,
  sortScopes,
} from "@mida/protocol"
import type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  ContextPayload,
  GrantAdvice,
  GrantScope,
  GrantedCapability,
  Hex,
  LineagePolicy,
  SignedAgentCapabilityManifest,
  WebAuthnAuthStruct,
} from "@mida/protocol"
import {
  assertNonZeroKey,
  bytesOf,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  hexOf,
  sealContextObject,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { EpochKeyPair } from "@mida/crypto"
import {
  capabilityRegistryAbi,
  contextRegistryAbi,
  latestTimestamp,
  ownerHistory,
  readAgentRecord,
  sendContract,
  toMidaError,
} from "@mida/chain"
import type { WriteContext } from "@mida/chain"
import { POLICY_HASH_V1, adviseGrant, assertFinalSelection } from "@mida/grant-advisor"
import { randomBytes } from "@noble/hashes/utils.js"
import { parseEventLogs, zeroHash } from "viem"
import type { Abi, TransactionReceipt } from "viem"
import { fakePrfOutput } from "./prf.js"
import type { VaultContextApi } from "./ports.js"
import { assertionToWire, p256PublicKey, signVaultAssertion } from "./webauthn.js"
import type { WebAuthnAssertionWire } from "./webauthn.js"

/** §4.2 VaultAuthority. The Vault is the only component that derives passkey-controlled namespace secrets. */
export interface VaultAuthority {
  deriveNamespaceSecret(namespaceId: Hex): Promise<Uint8Array>
  approveGrant(request: GrantRequest): Promise<GrantApproval>
  approveRevocation(request: RevokeRequest): Promise<RevokeApproval>
}

export type GrantSelection = { kind: "recommended" } | { kind: "custom"; scopes: GrantScope[]; expiresAt: bigint }

export interface GrantRequest {
  accessRequest: AccessRequest
  manifest: SignedAgentCapabilityManifest
  selection: GrantSelection
}

/** Returned to the owner's app: advice, the grant receipt and gas. No key material. */
export interface GrantApproval {
  advice: GrantAdvice
  response: AccessGrantResponse
  gasUsed: bigint
}

export type RevokeRequest = { kind: "capability"; capabilityId: Hex } | { kind: "agent"; agentId: Hex }

export interface RevokeApproval {
  intentId: Hex
  transactionHash: Hex
  rotated: Array<{ namespaceId: Hex; readEpoch: bigint }>
}

export interface FakeVaultConfig {
  /** 32 non-zero test bytes standing in for the passkey's PRF secret. Never a production secret. */
  seed: Uint8Array
  /** Software P256 key standing in for the passkey credential. */
  p256PrivateKey: Hex
  /** Owner EOA write context; `account` is the owner. */
  chain: WriteContext
  api: VaultContextApi
  /** Defaults to https://<deployment.vaultRpId>. */
  origin?: string
}

interface CapabilityView {
  owner: Address
  agentId: Hex
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: bigint
  revoked: boolean
}

export function toAccessRequestStruct(request: AccessRequest) {
  return {
    requestId: request.requestId,
    nonce: request.nonce,
    agentId: request.agentId,
    purposeIdHash: hashString(request.purposeId),
    callbackOriginHash: originHash(request.callbackOrigin),
    manifestHash: request.manifestHash,
    manifestVersion: BigInt(request.manifestVersion),
    policyVersionHash: hashString(request.policyVersion),
    namespaceTreeVersionHash: hashString(request.namespaceTreeVersion),
    issuedAt: decodeUint64(request.issuedAt),
    requestExpiresAt: decodeUint64(request.requestExpiresAt),
    capabilityExpiresAt: decodeUint64(request.capabilityExpiresAt),
    scopes: request.scopes.map((scope) => ({
      namespaceId: scope.namespaceId,
      permissions: scope.permissions,
      provenancePolicy: scope.provenancePolicy,
    })),
    agentSignature: request.agentSignature,
  }
}

/**
 * Project 1 software Vault (§13.4). Secrets live in private fields and never cross its public surface except
 * through the §4.2 `deriveNamespaceSecret` boundary, which only owner-side code holds. Approvals, wraps and uploads
 * carry public keys, ciphertext and wrapped keys only.
 */
export class FakeVaultAuthority implements VaultAuthority {
  readonly owner: Address
  readonly #seed: Uint8Array
  readonly #p256PrivateKey: Hex
  readonly #chain: WriteContext
  readonly #api: VaultContextApi
  readonly #origin: string

  constructor(config: FakeVaultConfig) {
    if (config.chain.deployment.policyHashV1 !== POLICY_HASH_V1) {
      throw new MidaError("POLICY_VERSION_UNSUPPORTED", "deployed POLICY_HASH_V1 differs from this Vault's policy")
    }
    assertNonZeroKey(config.seed, "fake vault seed")
    this.#seed = Uint8Array.from(config.seed)
    this.#p256PrivateKey = config.p256PrivateKey
    this.#chain = config.chain
    this.#api = config.api
    this.#origin = config.origin ?? `https://${config.chain.deployment.vaultRpId}`
    this.owner = config.chain.account.address.toLowerCase() as Address
  }

  get p256PublicKey(): { qx: bigint; qy: bigint } {
    return p256PublicKey(this.#p256PrivateKey)
  }

  async deriveNamespaceSecret(namespaceId: Hex): Promise<Uint8Array> {
    const node = namespaceById(namespaceId)
    return deriveNamespaceSecret(fakePrfOutput(this.#seed, node.domain), node.id)
  }

  async registerOwnerKey(): Promise<Hex> {
    const { qx, qy } = this.p256PublicKey
    return (await this.#sendCapability("registerP256Key", [qx, qy])).transactionHash
  }

  async initializeNamespace(namespace: string): Promise<Hex> {
    const id = toNamespaceId(canonicalizeNamespace(namespace))
    const keys = await this.#epochKeys(id, 1n)
    return (await this.#sendCapability("initializeReadEpoch", [id, hexOf(keys.publicKey)])).transactionHash
  }

  async approveGrant(request: GrantRequest): Promise<GrantApproval> {
    const { accessRequest } = request
    const { deployment } = this.#chain
    // Part C handoff: the Advisor verifies signatures under the request's own domain, so the Vault pins the network.
    if (
      decodeUint64(accessRequest.chainId) !== deployment.chainId ||
      accessRequest.capabilityRegistry.toLowerCase() !== deployment.capabilityRegistry
    ) {
      throw new MidaError("INVALID_WIRE", "access request targets a different chain or registry than this Vault")
    }
    const agentRecord = await readAgentRecord(this.#chain, accessRequest.agentId)
    const history = await ownerHistory({
      client: this.#chain.publicClient,
      deployment,
      owner: this.owner,
      agentId: accessRequest.agentId,
    })
    const now = await latestTimestamp(this.#chain)
    const advice = adviseGrant({ request: accessRequest, manifest: request.manifest, agentRecord, ownerHistory: history, now })

    const selected =
      request.selection.kind === "recommended"
        ? { scopes: advice.recommended, expiresAt: decodeUint64(advice.recommendedExpiresAt) }
        : { scopes: sortScopes(request.selection.scopes), expiresAt: request.selection.expiresAt }
    if (selected.scopes.length === 0) throw new MidaError("CAPABILITY_DENIED", "nothing was selected to grant")
    assertFinalSelection({
      requestedScopes: accessRequest.scopes,
      requestedExpiresAt: decodeUint64(accessRequest.capabilityExpiresAt),
      finalScopes: selected.scopes,
      finalExpiresAt: selected.expiresAt,
      now,
    })

    const { agentSignature: _signature, ...unsigned } = accessRequest
    const requestHash = accessRequestHash(unsigned)
    const nonce = await this.#readCapability<bigint>("grantNonce", [this.owner])
    const challenge = grantDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner: this.owner,
      agentId: accessRequest.agentId,
      requestHash,
      manifestHash: accessRequest.manifestHash,
      manifestVersion: BigInt(accessRequest.manifestVersion),
      finalScopes: selected.scopes,
      expiresAt: selected.expiresAt,
      grantNonce: nonce,
    })
    const receipt = await this.#sendCapability("grantBatch", [
      toAccessRequestStruct(accessRequest),
      selected.scopes,
      selected.expiresAt,
      this.#assert(challenge),
    ])

    const capabilities: GrantedCapability[] = parseEventLogs({
      abi: capabilityRegistryAbi,
      eventName: "CapabilityGranted",
      logs: receipt.logs,
    }).map((log) => ({
      namespaceId: log.args.namespaceId,
      permissions: log.args.permissions,
      provenancePolicy: log.args.provenancePolicy,
      expiresAt: encodeUint64(log.args.expiresAt),
      capabilityId: log.args.capabilityId,
      transactionHash: receipt.transactionHash,
    }))
    const response: AccessGrantResponse = {
      v: 1,
      chainId: accessRequest.chainId,
      capabilityRegistry: accessRequest.capabilityRegistry,
      requestId: accessRequest.requestId,
      nonce: accessRequest.nonce,
      requestHash,
      owner: this.owner,
      agentId: accessRequest.agentId,
      manifestHash: accessRequest.manifestHash,
      manifestVersion: accessRequest.manifestVersion,
      policyVersion: POLICY_VERSION,
      namespaceTreeVersion: NAMESPACE_TREE_VERSION,
      capabilities,
    }
    // §13.4: wraps are published only now that the chain holds the READ capability.
    for (const capability of capabilities) {
      if ((capability.permissions & PERMISSION.READ) !== 0) {
        await this.publishReaderWraps({ agentId: accessRequest.agentId, namespaceId: capability.namespaceId })
      }
    }
    return { advice, response, gasUsed: receipt.gasUsed }
  }

  /** Publishes one wrap per registered epoch (current and historical, §10.3) for an agent that holds live exact READ. */
  async publishReaderWraps(input: { agentId: Hex; namespaceId: Hex }): Promise<bigint[]> {
    const { deployment } = this.#chain
    const authorized = await this.#readCapability<boolean>("hasAuthority", [
      this.owner,
      input.agentId,
      input.namespaceId,
      PERMISSION.READ,
      0,
    ])
    if (!authorized) throw new MidaError("CAPABILITY_DENIED", "agent has no live exact READ capability; no wrap published")
    const agent = await readAgentRecord(this.#chain, input.agentId)
    const required = await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, input.namespaceId])
    const createdAt = await latestTimestamp(this.#chain)
    const published: bigint[] = []
    for (let epoch = 1n; epoch <= required; epoch++) {
      const onChain = await this.#readCapability<Hex>("epochPublicKey", [this.owner, input.namespaceId, epoch])
      if (onChain === zeroHash) continue
      const keys = await this.#epochKeys(input.namespaceId, epoch, onChain)
      await this.#api.publishEpochWrap(
        wrapEpochPrivateKeyToAgent({
          epochPrivateKey: keys.privateKey,
          agentEncryptionPublicKey: bytesOf(agent.encryptionPublicKey, 32),
          binding: {
            chainId: deployment.chainId,
            capabilityRegistry: deployment.capabilityRegistry,
            owner: this.owner,
            namespaceId: input.namespaceId,
            readEpoch: epoch,
            agentId: input.agentId,
            agentKeyVersion: agent.encryptionKeyVersion,
          },
          createdAt,
        }),
      )
      published.push(epoch)
    }
    return published
  }

  /** §7.3 and §16 steps 13–14: the local deny is posted first, then one owner transaction revokes and rotates. */
  async approveRevocation(request: RevokeRequest): Promise<RevokeApproval> {
    if (request.kind === "capability") {
      const capability = await this.#readCapability<CapabilityView>("getCapability", [request.capabilityId])
      if (capability.owner.toLowerCase() !== this.owner) {
        throw new MidaError("CAPABILITY_DENIED", "capability belongs to another owner")
      }
      const live = await this.#readCapability<boolean>("isCapabilityValid", [request.capabilityId])
      const endsRead = live && (capability.permissions & PERMISSION.READ) !== 0
      const { intentId } = await this.#api.requestRevocationDeny({ capabilityId: request.capabilityId })
      if (!endsRead) {
        const receipt = await this.#sendCapability("revoke", [request.capabilityId])
        return { intentId, transactionHash: receipt.transactionHash, rotated: [] }
      }
      const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, capability.namespaceId])) + 1n
      const keys = await this.#epochKeys(capability.namespaceId, next)
      const receipt = await this.#sendCapability("revokeAndRotate", [request.capabilityId, hexOf(keys.publicKey)])
      return { intentId, transactionHash: receipt.transactionHash, rotated: [{ namespaceId: capability.namespaceId, readEpoch: next }] }
    }

    const ids = await this.#readCapability<readonly Hex[]>("activeCapabilityIds", [this.owner, request.agentId])
    const readNamespaces: Hex[] = []
    for (const id of ids) {
      const capability = await this.#readCapability<CapabilityView>("getCapability", [id])
      const live = await this.#readCapability<boolean>("isCapabilityValid", [id])
      if (live && (capability.permissions & PERMISSION.READ) !== 0 && !readNamespaces.includes(capability.namespaceId)) {
        readNamespaces.push(capability.namespaceId)
      }
    }
    const rotations: Array<{ namespaceId: Hex; newEpochPublicKey: Hex }> = []
    const rotated: RevokeApproval["rotated"] = []
    for (const namespaceId of readNamespaces) {
      const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])) + 1n
      rotations.push({ namespaceId, newEpochPublicKey: hexOf((await this.#epochKeys(namespaceId, next)).publicKey) })
      rotated.push({ namespaceId, readEpoch: next })
    }
    const { intentId } = await this.#api.requestRevocationDeny({ owner: this.owner, agentId: request.agentId })
    const receipt = await this.#sendCapability("revokeAgentAndRotate", [request.agentId, rotations])
    return { intentId, transactionHash: receipt.transactionHash, rotated }
  }

  /** §7.3 expiry: resumes writes after the earliest READ expiry closed the epoch. */
  async rotateExpiredEpoch(namespaceId: Hex): Promise<{ transactionHash: Hex; readEpoch: bigint }> {
    const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])) + 1n
    const keys = await this.#epochKeys(namespaceId, next)
    const receipt = await this.#sendCapability("rotateExpiredEpoch", [namespaceId, hexOf(keys.publicKey)])
    return { transactionHash: receipt.transactionHash, readEpoch: next }
  }

  /** §12.5 deny cancellation restores authority, so it needs a fresh passkey assertion with UV. */
  approveDenyCancellation(input: { revocationIntentId: Hex; apiCancellationNonce: bigint; expiresAt: bigint }): WebAuthnAssertionWire {
    const { deployment } = this.#chain
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner: this.owner,
      revocationIntentId: input.revocationIntentId,
      apiCancellationNonce: input.apiCancellationNonce,
      expiresAt: input.expiresAt,
    })
    return assertionToWire(this.#assert(challenge))
  }

  /** Owner-authored context (§11.5): ciphertext is uploaded as pending first, then the commitments are anchored. */
  async createOwnerContext(input: {
    namespace: string
    payload: ContextPayload
    lineagePolicy?: LineagePolicy
    expectedParentId?: Hex
    evidenceCommitment?: Hex
    expiresAt?: bigint
  }): Promise<{ contextId: Hex; readEpoch: bigint; manifestHash: Hex; transactionHash: Hex }> {
    const { deployment } = this.#chain
    const namespaceId = toNamespaceId(canonicalizeNamespace(input.namespace))
    const readEpoch = await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])
    const onChain = await this.#readCapability<Hex>("epochPublicKey", [this.owner, namespaceId, readEpoch])
    const keys = await this.#epochKeys(namespaceId, readEpoch, onChain)
    const objectNonce = hexOf(randomBytes(32))
    const contextId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: this.owner,
      authorId: OWNER_AUTHOR_ID,
      namespaceId,
      objectNonce,
    })
    const sealed = sealContextObject({
      payload: input.payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId, readEpoch },
      epochPublicKey: keys.publicKey,
    })
    const expectedParentId = input.expectedParentId ?? zeroHash
    await this.#api.putObject({
      owner: this.owner,
      namespaceId,
      objectNonce,
      expectedParentId,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
    })
    const receipt = await this.#send(contextRegistryAbi, deployment.contextRegistry, "register", [
      this.owner,
      [
        {
          contextId,
          objectNonce,
          namespaceId,
          expectedParentId,
          manifestHash: sealed.manifestHash,
          ciphertextCommitment: sealed.ciphertextCommitment,
          evidenceCommitment: input.evidenceCommitment ?? zeroHash,
          readEpoch,
          expiresAt: input.expiresAt ?? 0n,
          recordType: RECORD_TYPE.CONTEXT,
          lineagePolicy: LINEAGE_POLICY[input.lineagePolicy ?? "STANDARD"],
          kind: CONTEXT_KIND[input.payload.kind],
          provenanceSource: PROVENANCE_SOURCE[input.payload.provenance.source],
        },
      ],
    ])
    return { contextId, readEpoch, manifestHash: sealed.manifestHash, transactionHash: receipt.transactionHash }
  }

  async #epochKeys(namespaceId: Hex, epoch: bigint, expectedPublicKey?: Hex): Promise<EpochKeyPair> {
    const keys = deriveEpochKeyPair(await this.deriveNamespaceSecret(namespaceId), epoch)
    if (expectedPublicKey !== undefined && hexOf(keys.publicKey) !== expectedPublicKey.toLowerCase()) {
      // §11.1: the contract cannot prove key derivation; a mismatch means this seed is not the key's owner.
      throw new MidaError("COMMITMENT_MISMATCH", `derived epoch ${epoch} public key differs from the published key`)
    }
    return keys
  }

  #assert(challenge: Hex): WebAuthnAuthStruct {
    const rpId = this.#chain.deployment.vaultRpId
    return signVaultAssertion({ challenge, privateKey: this.#p256PrivateKey, rpId, origin: this.#origin })
  }

  async #readCapability<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    try {
      return (await this.#chain.publicClient.readContract({
        address: this.#chain.deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName,
        args,
      } as never)) as T
    } catch (error) {
      throw toMidaError(error)
    }
  }

  #sendCapability(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    return this.#send(capabilityRegistryAbi, this.#chain.deployment.capabilityRegistry, functionName, args)
  }

  #send(abi: Abi, address: Address, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    return sendContract(this.#chain, { address, abi, functionName, args })
  }
}
