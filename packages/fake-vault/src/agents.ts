import {
  NAMESPACE_TREE_VERSION,
  POLICY_VERSION,
  accessRequestTypedData,
  canonicalizeNamespace,
  agentId as deriveAgentId,
  encodeUint64,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type {
  AccessRequest,
  Address,
  Hex,
  Permission,
  ProvenancePolicy,
  PurposeId,
  SignedAgentCapabilityManifest,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { generateX25519KeyPair, hexOf, x25519PublicKey } from "@mida/crypto"
import type { X25519KeyPair } from "@mida/crypto"
import { latestTimestamp, registerAgent } from "@mida/chain"
import type { ChainContext, Deployment, LocalWriteContext } from "@mida/chain"
import { manifestBindingFor, manifestBodyHash } from "@mida/grant-advisor"
import { randomBytes } from "@noble/hashes/utils.js"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

export interface AgentDeclaration {
  namespace: string
  permissions: Permission[]
  provenancePolicies?: ProvenancePolicy[]
  reason?: string
}

export interface ProvisionedAgent {
  agentId: Hex
  signer: LocalAccount
  encryptionPrivateKey: Uint8Array
  encryptionPublicKey: Hex
  callbackOrigin: string
  purposeId: PurposeId
  manifest: SignedAgentCapabilityManifest
  manifestHash: Hex
}

/**
 * Test and demo tooling: an operator signs a manifest body, a fresh signer accepts registration, and the agent is
 * registered with its X25519 key. Private keys stay in memory; nothing here is persisted.
 */
export async function provisionAgent(input: {
  operator: LocalWriteContext
  name: string
  purposeId: PurposeId
  declarations: readonly AgentDeclaration[]
  callbackOrigin: string
  signer?: LocalAccount
  /** Prepared salt (migrate B1); absent = a fresh random one, exactly as before. */
  agentSalt?: Hex
  /** Prepared X25519 encryption pair (migrate B1); absent = a fresh generated pair. */
  encryption?: X25519KeyPair
}): Promise<ProvisionedAgent> {
  const { deployment } = input.operator
  const agentSalt = input.agentSalt ?? hexOf(randomBytes(32))
  const agentId = predictAgentId({ deployment, operator: input.operator.account.address, agentSalt })
  const now = await latestTimestamp(input.operator)
  const body = {
    v: 1 as const,
    agentId,
    manifestVersion: 1,
    name: input.name,
    purposes: [{ id: input.purposeId, description: `${input.name} ${input.purposeId}` }],
    scopeDeclarations: input.declarations.map((declaration) => ({
      purposeId: input.purposeId,
      namespace: declaration.namespace,
      permissions: declaration.permissions,
      ...(declaration.provenancePolicies === undefined ? {} : { provenancePolicies: declaration.provenancePolicies }),
      reason: declaration.reason ?? `Needed for ${input.purposeId}`,
    })),
    issuedAt: Number(now) - 60,
  }
  const manifestHash = manifestBodyHash(body)
  const operatorSignature = await input.operator.account.signTypedData(
    manifestBindingFor({ chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, body }) as never,
  )
  const signer = input.signer ?? privateKeyToAccount(generatePrivateKey())
  const encryption = input.encryption ?? generateX25519KeyPair()
  if (input.encryption !== undefined && hexOf(x25519PublicKey(encryption.privateKey)) !== hexOf(encryption.publicKey)) {
    throw new Error("the prepared encryption pair's public key does not match its private key")
  }
  const registered = await registerAgent(input.operator, {
    agentSalt,
    signer,
    encryptionPublicKey: hexOf(encryption.publicKey),
    callbackOrigin: input.callbackOrigin,
    capabilityManifestHash: manifestHash,
  })
  if (registered.agentId !== agentId) throw new Error("registered agentId differs from the derived agentId")
  return {
    agentId,
    signer,
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: hexOf(encryption.publicKey),
    callbackOrigin: input.callbackOrigin,
    purposeId: input.purposeId,
    manifest: { manifest: body, operatorSignature },
    manifestHash,
  }
}

/** The agentId a `provisionAgent` call with this salt will register — computed before sending (migrate B1). */
export function predictAgentId(input: { deployment: Deployment; operator: Address; agentSalt: Hex }): Hex {
  return deriveAgentId({
    chainId: input.deployment.chainId,
    capabilityRegistry: input.deployment.capabilityRegistry,
    operator: input.operator,
    agentSalt: input.agentSalt,
  })
}

/**
 * Test fixture for Tasks 22–24, before the SDK exists: an exact, sorted, agent-signed request valid for five minutes
 * from the latest block. Task 25's MidaAgent.createAccessRequest is the production path.
 */
export async function buildSignedAccessRequest(input: {
  chain: ChainContext
  agent: ProvisionedAgent
  scopes: ReadonlyArray<{ namespace: string; permissions: number; provenancePolicy?: number }>
  overrides?: Partial<UnsignedAccessRequest>
}): Promise<AccessRequest> {
  const { deployment } = input.chain
  const now = await latestTimestamp(input.chain)
  const unsigned: UnsignedAccessRequest = {
    v: 1,
    chainId: encodeUint64(deployment.chainId),
    capabilityRegistry: deployment.capabilityRegistry,
    requestId: hexOf(randomBytes(32)),
    nonce: hexOf(randomBytes(32)),
    agentId: input.agent.agentId,
    purposeId: input.agent.purposeId,
    callbackOrigin: input.agent.callbackOrigin,
    manifestHash: input.agent.manifestHash,
    manifestVersion: input.agent.manifest.manifest.manifestVersion,
    policyVersion: POLICY_VERSION,
    namespaceTreeVersion: NAMESPACE_TREE_VERSION,
    scopes: sortScopes(
      input.scopes.map((scope) => ({
        namespaceId: namespaceId(canonicalizeNamespace(scope.namespace)),
        permissions: scope.permissions,
        provenancePolicy: scope.provenancePolicy ?? 0,
      })),
    ),
    issuedAt: encodeUint64(now),
    requestExpiresAt: encodeUint64(now + 300n),
    capabilityExpiresAt: "0",
    ...input.overrides,
  }
  return { ...unsigned, agentSignature: await input.agent.signer.signTypedData(accessRequestTypedData(unsigned) as never) }
}
