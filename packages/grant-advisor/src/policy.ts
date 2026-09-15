import {
  MidaError,
  NAMESPACE_TREE_V1,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_POLICY,
  canonicalBytes,
  expandNamespace,
  namespaceById,
} from "@mida/protocol"
import type { Hex, Permission, ProvenancePolicy, PurposeId } from "@mida/protocol"
import { keccak256 } from "viem"

export type Sensitivity = "LOW" | "MEDIUM" | "HIGH"
export type Classification = "EXPECTED" | "ELEVATED" | "SUSPICIOUS" | "UNCLASSIFIED"

export interface PolicyEntry {
  readonly namespace: string
  readonly permissions: readonly Permission[]
  readonly provenancePolicies: readonly ProvenancePolicy[]
}

export interface PurposePolicy {
  readonly expected: readonly PolicyEntry[]
  readonly elevated: readonly PolicyEntry[]
  readonly suspicious: "ALL_HIGH"
}

export interface PurposeRule {
  classification: Classification
  permissions: number
  provenancePolicy: number
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

const read = (namespace: string): PolicyEntry => ({ namespace, permissions: ["READ"], provenancePolicies: [] })

/**
 * The canonical policy document for mida-grant-policy-v1 (§14.2–§14.4).
 * Its RFC 8785 keccak256 hash is POLICY_HASH_V1, which Solidity mirrors as a constant (Task 14).
 * Changing any byte here is a new policy version, never an edit.
 */
export const POLICY_DOCUMENT_V1 = deepFreeze({
  v: 1,
  policyVersion: POLICY_VERSION,
  namespaceTreeVersion: NAMESPACE_TREE_VERSION,
  sensitivity: {
    LOW: [
      "preferences",
      "preferences.communication",
      "preferences.tools",
      "preferences.work",
      "profile.skills",
      "projects.current",
    ],
    MEDIUM: [
      "profile",
      "profile.identity",
      "goals",
      "goals.career",
      "goals.learning",
      "goals.personal",
      "projects",
      "projects.past",
      "decisions",
      "decisions.career",
      "decisions.projects",
      "relationships",
    ],
    HIGH: ["credentials", "financial", "financial.preferences", "private"],
  },
  consent: {
    LOW: "normal_approval",
    MEDIUM: "explicit_justification",
    HIGH: "warning_and_individual_selection",
  },
  durationCapsSeconds: { LOW: 2_592_000, MEDIUM: 604_800, HIGH: 86_400 },
  purposes: {
    career_coaching: {
      expected: [
        read("profile.skills"),
        { namespace: "goals.career", permissions: ["READ", "CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] },
        read("preferences.communication"),
      ],
      elevated: [read("profile.identity"), read("projects.current")],
      suspicious: "ALL_HIGH",
    },
    general_assistance: {
      expected: [read("preferences.communication"), read("profile.skills")],
      elevated: [read("projects.current")],
      suspicious: "ALL_HIGH",
    },
    project_assistance: {
      expected: [
        read("profile.skills"),
        {
          namespace: "projects.current",
          permissions: ["READ", "CREATE", "SUPERSEDE_OWN"],
          provenancePolicies: ["ALLOW_INFERENCE"],
        },
        read("preferences.communication"),
      ],
      elevated: [
        { namespace: "decisions.projects", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] },
        read("goals.career"),
      ],
      suspicious: "ALL_HIGH",
    },
    travel_planning: {
      expected: [
        read("preferences"),
        read("preferences.communication"),
        read("preferences.tools"),
        read("preferences.work"),
      ],
      elevated: [read("profile.identity")],
      suspicious: "ALL_HIGH",
    },
  } satisfies Record<PurposeId, PurposePolicy>,
  rules: {
    neverDefault: ["ELEVATED", "SUSPICIOUS", "UNCLASSIFIED", "UNDECLARED", "HIGH", "SUPERSEDE_ANY"],
    elevatedProvenancePolicies: ["ALLOW_IMPORTED", "ALLOW_EXTERNAL_ATTESTATION"],
    inferenceRequiresManifestAndPurpose: true,
    provenanceRequiresWritePermission: true,
    broadParentScopeWarning: true,
    highFinalSelectionCapSeconds: 86_400,
    singleExpiryPerBatch: true,
    selectAllExcludesHigh: true,
  },
} as const)

export const POLICY_HASH_V1: Hex = keccak256(canonicalBytes(POLICY_DOCUMENT_V1))

export const PURPOSE_IDS: readonly PurposeId[] = Object.freeze(
  Object.keys(POLICY_DOCUMENT_V1.purposes).sort() as PurposeId[],
)

export const DURATION_CAP_SECONDS: Readonly<Record<Sensitivity, bigint>> = Object.freeze({
  LOW: BigInt(POLICY_DOCUMENT_V1.durationCapsSeconds.LOW),
  MEDIUM: BigInt(POLICY_DOCUMENT_V1.durationCapsSeconds.MEDIUM),
  HIGH: BigInt(POLICY_DOCUMENT_V1.durationCapsSeconds.HIGH),
})

const RANK: Readonly<Record<Sensitivity, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 }
const WRITE_BITS = PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN | PERMISSION.SUPERSEDE_ANY

export const ELEVATED_PROVENANCE_BITS =
  PROVENANCE_POLICY.ALLOW_IMPORTED | PROVENANCE_POLICY.ALLOW_EXTERNAL_ATTESTATION
export const WRITE_PERMISSION_BITS = WRITE_BITS

const OWN_SENSITIVITY = new Map<string, Sensitivity>()
for (const level of ["LOW", "MEDIUM", "HIGH"] as const) {
  for (const name of POLICY_DOCUMENT_V1.sensitivity[level]) {
    if (OWN_SENSITIVITY.has(name)) throw new Error(`policy v1: ${name} has two sensitivities`)
    OWN_SENSITIVITY.set(name, level)
  }
}
for (const node of NAMESPACE_TREE_V1) {
  if (!OWN_SENSITIVITY.has(node.name)) throw new Error(`policy v1: ${node.name} has no sensitivity`)
}
if (OWN_SENSITIVITY.size !== NAMESPACE_TREE_V1.length) throw new Error("policy v1: sensitivity names outside tree v1")

export function isPurposeId(value: string): value is PurposeId {
  return Object.hasOwn(POLICY_DOCUMENT_V1.purposes, value)
}

export function stricterSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK[a] >= RANK[b] ? a : b
}

/** A namespace's effective sensitivity is at least that of everything it expands to (§14.2). */
export function sensitivityOf(namespace: string): Sensitivity {
  return expandNamespace(namespace)
    .map((name) => OWN_SENSITIVITY.get(name)!)
    .reduce(stricterSensitivity)
}

export function sensitivityOfId(namespaceId: Hex): Sensitivity {
  return sensitivityOf(namespaceById(namespaceId).name)
}

export function permissionBits(names: readonly Permission[]): number {
  return names.reduce((bits, name) => bits | PERMISSION[name], 0)
}

export function provenancePolicyBits(names: readonly ProvenancePolicy[]): number {
  return names.reduce((bits, name) => bits | PROVENANCE_POLICY[name], 0)
}

export function permissionNames(bits: number): Permission[] {
  return (Object.keys(PERMISSION) as Permission[]).filter((name) => (bits & PERMISSION[name]) !== 0)
}

export function provenancePolicyNames(bits: number): ProvenancePolicy[] {
  return (Object.keys(PROVENANCE_POLICY) as ProvenancePolicy[]).filter(
    (name) => (bits & PROVENANCE_POLICY[name]) !== 0,
  )
}

function ruleFrom(classification: Classification, entry: PolicyEntry | undefined): PurposeRule {
  return {
    classification,
    permissions: entry === undefined ? 0 : permissionBits(entry.permissions),
    provenancePolicy: entry === undefined ? 0 : provenancePolicyBits(entry.provenancePolicies),
  }
}

/** Exact (purpose, namespace) classification under §14.3. HIGH is always SUSPICIOUS. */
export function classifyScope(purposeId: PurposeId, namespaceId: Hex): PurposeRule {
  const node = namespaceById(namespaceId)
  if (!isPurposeId(purposeId)) throw new MidaError("PURPOSE_UNKNOWN", String(purposeId))
  if (sensitivityOf(node.name) === "HIGH") return ruleFrom("SUSPICIOUS", undefined)
  const purpose: PurposePolicy = POLICY_DOCUMENT_V1.purposes[purposeId]
  const expected = purpose.expected.find((entry) => entry.namespace === node.name)
  if (expected !== undefined) return ruleFrom("EXPECTED", expected)
  const elevated = purpose.elevated.find((entry) => entry.namespace === node.name)
  if (elevated !== undefined) return ruleFrom("ELEVATED", elevated)
  return ruleFrom("UNCLASSIFIED", undefined)
}
