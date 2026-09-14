export const PERMISSION = { READ: 1, CREATE: 2, SUPERSEDE_OWN: 4, SUPERSEDE_ANY: 8 } as const
export type Permission = keyof typeof PERMISSION
export const KNOWN_PERMISSION_BITS = 15

export const PROVENANCE_POLICY = {
  ALLOW_INFERENCE: 1,
  ALLOW_IMPORTED: 2,
  ALLOW_EXTERNAL_ATTESTATION: 4,
} as const
export type ProvenancePolicy = keyof typeof PROVENANCE_POLICY
export const KNOWN_PROVENANCE_BITS = 7

export const RECORD_TYPE = { CONTEXT: 0, EVIDENCE: 1 } as const
export type RecordType = keyof typeof RECORD_TYPE

export const LINEAGE_POLICY = { STANDARD: 0, OWNER_CONTROLLED: 1 } as const
export type LineagePolicy = keyof typeof LINEAGE_POLICY

export const CONTEXT_KIND = {
  NONE: 0, FACT: 1, PREFERENCE: 2, GOAL: 3, DECISION: 4,
  EPISODE: 5, INFERENCE: 6, CREDENTIAL: 7, OPEN_LOOP: 8,
} as const
export type ContextKind = keyof typeof CONTEXT_KIND

export const PROVENANCE_SOURCE = {
  NONE: 0, USER_ASSERTED: 1, USER_CONFIRMED: 2, AGENT_INFERRED: 3,
  IMPORTED: 4, EXTERNAL_ATTESTATION: 5,
} as const
export type ProvenanceSource = keyof typeof PROVENANCE_SOURCE

export const RECORD_RELATION_CODE = { supports: 1, derived_from: 2, confirmed_from: 3 } as const
export type RecordRelation = keyof typeof RECORD_RELATION_CODE

export const POLICY_VERSION = "mida-grant-policy-v1" as const
export const NAMESPACE_TREE_VERSION = "mida-namespace-tree-v1" as const
export const CRYPTO_VERSION = "mida-crypto-v1" as const
export const MAX_PAYLOAD_BYTES = 65_536
