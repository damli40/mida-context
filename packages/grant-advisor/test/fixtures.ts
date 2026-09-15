import { accessRequestTypedData, agentId as deriveAgentId, encodeUint64, namespaceId, originHash, sortScopes } from "@mida/protocol"
import type {
  AccessRequest,
  AgentCapabilityManifestBody,
  AgentRecord,
  Address,
  Hex,
  OwnerAgentHistory,
  SignedAgentCapabilityManifest,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { privateKeyToAccount } from "viem/accounts"
import { manifestBindingFor, manifestBodyHash } from "@mida/grant-advisor"

export const CHAIN_ID = 31337n
export const REGISTRY: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
export const OTHER_REGISTRY: Address = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"
export const NOW = 1_800_000_000n
export const DAY = 86_400n
export const OWNER: Address = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
export const CALLBACK_ORIGIN = "https://career.example"

// Deterministic test-only keys. Never used outside tests.
export const operator = privateKeyToAccount(`0x${"01".repeat(32)}`)
export const signer = privateKeyToAccount(`0x${"02".repeat(32)}`)
export const stranger = privateKeyToAccount(`0x${"03".repeat(32)}`)

export const AGENT_ID: Hex = deriveAgentId({
  chainId: CHAIN_ID,
  capabilityRegistry: REGISTRY,
  operator: operator.address,
  agentSalt: `0x${"5a".repeat(32)}`,
})

export function manifestBody(overrides: Partial<AgentCapabilityManifestBody> = {}): AgentCapabilityManifestBody {
  return {
    v: 1,
    agentId: AGENT_ID,
    manifestVersion: 1,
    name: "CareerAI",
    purposes: [{ id: "career_coaching", description: "Career coaching" }],
    scopeDeclarations: [
      { purposeId: "career_coaching", namespace: "profile.skills", permissions: ["READ"], reason: "Tailor advice to skills" },
      {
        purposeId: "career_coaching",
        namespace: "goals.career",
        permissions: ["READ", "CREATE"],
        provenancePolicies: ["ALLOW_INFERENCE"],
        reason: "Track career goals",
      },
      { purposeId: "career_coaching", namespace: "preferences.communication", permissions: ["READ"], reason: "Match tone" },
      { purposeId: "career_coaching", namespace: "financial", permissions: ["READ"], reason: "Salary negotiation" },
    ],
    issuedAt: Number(NOW - DAY),
    ...overrides,
  }
}

export async function signManifest(
  body: AgentCapabilityManifestBody,
  options: { chainId?: bigint; capabilityRegistry?: Address; account?: typeof operator } = {},
): Promise<SignedAgentCapabilityManifest> {
  const account = options.account ?? operator
  const binding = manifestBindingFor({
    chainId: options.chainId ?? CHAIN_ID,
    capabilityRegistry: options.capabilityRegistry ?? REGISTRY,
    body,
  })
  return { manifest: body, operatorSignature: await account.signTypedData(binding) }
}

export function agentRecordFor(body: AgentCapabilityManifestBody, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: body.agentId,
    operator: operator.address,
    signer: signer.address,
    encryptionPublicKey: `0x${"e1".repeat(32)}`,
    encryptionKeyVersion: 1,
    callbackOriginHash: originHash(CALLBACK_ORIGIN),
    capabilityManifestHash: manifestBodyHash(body),
    capabilityManifestVersion: body.manifestVersion,
    active: true,
    ...overrides,
  }
}

export interface ExactScopeInput {
  namespace: string
  permissions: number
  provenancePolicy?: number
}

export function unsignedRequest(
  scopes: readonly ExactScopeInput[],
  overrides: Partial<UnsignedAccessRequest> = {},
  body: AgentCapabilityManifestBody = manifestBody(),
): UnsignedAccessRequest {
  return {
    v: 1,
    chainId: encodeUint64(CHAIN_ID),
    capabilityRegistry: REGISTRY,
    requestId: `0x${"11".repeat(32)}`,
    nonce: `0x${"22".repeat(32)}`,
    agentId: body.agentId,
    purposeId: "career_coaching",
    callbackOrigin: CALLBACK_ORIGIN,
    manifestHash: manifestBodyHash(body),
    manifestVersion: body.manifestVersion,
    policyVersion: "mida-grant-policy-v1",
    namespaceTreeVersion: "mida-namespace-tree-v1",
    scopes: sortScopes(
      scopes.map((scope) => ({
        namespaceId: namespaceId(scope.namespace),
        permissions: scope.permissions,
        provenancePolicy: scope.provenancePolicy ?? 0,
      })),
    ),
    issuedAt: encodeUint64(NOW - 10n),
    requestExpiresAt: encodeUint64(NOW + 300n),
    capabilityExpiresAt: encodeUint64(NOW + 7n * DAY),
    ...overrides,
  }
}

export async function signRequest(request: UnsignedAccessRequest, account = signer): Promise<AccessRequest> {
  const typedData = accessRequestTypedData(request)
  return { ...request, agentSignature: await account.signTypedData(typedData) }
}

export function ownerHistory(overrides: Partial<OwnerAgentHistory> = {}): OwnerAgentHistory {
  return { owner: OWNER, agentId: AGENT_ID, previouslyRevoked: false, observedThroughBlock: 100n, ...overrides }
}
