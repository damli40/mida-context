# Project 1 Plan — Part C: Grant Advisor (Tasks 10–13)

> Read `2026-09-14-project-1-protocol-core.md` first. Its Global Constraints and "Decisions" sections apply to every task here. Part C consumes only Part A (Tasks 1–5) and may run in parallel with Parts B and D.

**What this part builds, in plain words.** The Grant Advisor is the referee between what an agent asks for and what the user approves. An agent publishes a signed manifest (what it may ever ask for) and signs a request (what it wants now). The advisor checks both are genuine and current, looks up protocol-owned sensitivity and purpose rules, and recommends the narrowest reasonable subset with warnings. It never creates authority: the recommendation is always inside the signed request, and a fuzz test proves that on every run.

**Every code block in this part was executed before it was written here** (Vitest 4.1.11, TypeScript 5.9.3, viem 2.56.3, ox 1.7.4, against Part A's protocol code). Copy blocks verbatim.

## Decisions this part makes where the spec is silent

These bind Parts D and E. Report any disagreement before implementing.

1. **Policy document and hash.** `POLICY_DOCUMENT_V1` (Task 10) is the canonical JSON policy. `POLICY_HASH_V1 = keccak256(RFC 8785 bytes)` = `0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45`. Task 10 writes it to `contracts/test/vectors/policy-v1.json` for Part D Task 14.
2. **Manifest validation errors.** Structure and limit violations throw `INVALID_WIRE`. A namespace that is not already canonical throws `INVALID_NAMESPACE`. An unknown purpose, or a declaration for a purpose the manifest did not list, throws `PURPOSE_UNKNOWN`. Manifests need 1–8 purposes and 0–32 declarations. Unknown keys are rejected, so an agent cannot smuggle in a `sensitivity` claim.
3. **Synchronous signature checks.** §14.5 makes `adviseGrant` synchronous, but viem's `verifyTypedData` is async. Signatures are recovered with viem `hashTypedData` plus ox `Secp256k1.recoverAddress`, compared with `isAddressEqual`, and cross-checked against `verifyTypedData` in tests. Operators and signers must be EOAs; ERC-1271 is not supported in v0.
4. **Identity failures use `AGENT_ID_MISMATCH`:** inactive agent, callback origin not equal to the registered origin, or owner history for a different agent.
5. **Request freshness failures use `REQUEST_EXPIRED`:** `issuedAt` in the future, `now >= requestExpiresAt`, a window over 600 seconds, or a requested capability expiry that is not in the future.
6. **`BROAD_PARENT_SCOPE`** is emitted for every requested exact namespace that has children, with `relatedNamespaceIds` listing its full expansion in tree order.
7. **Provenance bits are recommended only alongside a write permission** (`CREATE`, `SUPERSEDE_OWN`). A READ-only recommendation carries provenance policy `0`.
8. **Empty recommendations still get a finite expiry** using the LOW cap, so the recommended expiry is always finite and never later than the request.
9. **Risk follows §14.6 literally:** any warning, of any severity, makes risk at least medium.
10. **Final-selection errors** (Task 12): broadening throws `RESPONSE_MISMATCH`; an expiry that is not in the future throws `CAPABILITY_EXPIRED`; HIGH authority without a finite expiry within 24 hours throws `CAPABILITY_DENIED`.

---
### Task 10: Protocol policy v1 and `POLICY_HASH_V1`

This task freezes the protocol-owned rules from §14.2–§14.4 as one canonical JSON document, and exports the hash that Solidity will mirror. Changing any byte of the document is a new policy version, never an edit.

**Files:**
- Create: `packages/grant-advisor/package.json`, `packages/grant-advisor/src/policy.ts`, `packages/grant-advisor/src/index.ts`
- Create: `packages/grant-advisor/scripts/export-policy-vector.ts`
- Create (generated, committed): `contracts/test/vectors/policy-v1.json`
- Modify: root `package.json` (add workspace dependency), `tsconfig.json` (typecheck `packages/*/scripts`)
- Test: `packages/grant-advisor/test/policy.test.ts`, `packages/grant-advisor/test/policy-vector.test.ts`

**Interfaces:**
- Consumes: from `@mida/protocol` — `MidaError`, `NAMESPACE_TREE_V1`, `NAMESPACE_TREE_VERSION`, `PERMISSION`, `POLICY_VERSION`, `PROVENANCE_POLICY`, `canonicalBytes` (Tasks 2–3); `expandNamespace`, `namespaceById`, `namespaceId` (Task 4); types `Hex`, `Permission`, `ProvenancePolicy`, `PurposeId`.
- Produces, in `policy.ts`:
  - `type Sensitivity = "LOW" | "MEDIUM" | "HIGH"`
  - `type Classification = "EXPECTED" | "ELEVATED" | "SUSPICIOUS" | "UNCLASSIFIED"`
  - `interface PolicyEntry { namespace: string; permissions: readonly Permission[]; provenancePolicies: readonly ProvenancePolicy[] }`
  - `interface PurposePolicy { expected: readonly PolicyEntry[]; elevated: readonly PolicyEntry[]; suspicious: "ALL_HIGH" }`
  - `interface PurposeRule { classification: Classification; permissions: number; provenancePolicy: number }`
  - `POLICY_DOCUMENT_V1` — deeply frozen policy document
  - `POLICY_HASH_V1: Hex` — `0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45`
  - `PURPOSE_IDS: readonly PurposeId[]` — sorted
  - `DURATION_CAP_SECONDS: Readonly<Record<Sensitivity, bigint>>` — LOW `2592000n`, MEDIUM `604800n`, HIGH `86400n`
  - `ELEVATED_PROVENANCE_BITS: number` (`ALLOW_IMPORTED | ALLOW_EXTERNAL_ATTESTATION` = 6), `WRITE_PERMISSION_BITS: number` (`CREATE | SUPERSEDE_OWN | SUPERSEDE_ANY` = 14)
  - `isPurposeId(value: string): value is PurposeId`
  - `stricterSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity`
  - `sensitivityOf(namespace: string): Sensitivity` — strictest over the namespace's expansion
  - `sensitivityOfId(namespaceId: Hex): Sensitivity`
  - `permissionBits(names: readonly Permission[]): number`, `provenancePolicyBits(names: readonly ProvenancePolicy[]): number`
  - `permissionNames(bits: number): Permission[]`, `provenancePolicyNames(bits: number): ProvenancePolicy[]` — in bit order
  - `classifyScope(purposeId: PurposeId, namespaceId: Hex): PurposeRule` — HIGH is always SUSPICIOUS; throws `PURPOSE_UNKNOWN` or `INVALID_NAMESPACE`
- Produces for Part D: `contracts/test/vectors/policy-v1.json` containing `{ "policyHash": "0x…" }`.

> **Handoff to Part D, Task 14.** Task 14 reads `contracts/test/vectors/policy-v1.json` and asserts it equals the Solidity `POLICY_HASH_V1` constant. Task 14 must not delete `contracts/test/vectors/` when it initializes Foundry. If Task 14 starts before this task is committed, it waits for this file rather than inventing a value. If the hash in Step 5 differs from the value above, stop: your `policy.ts` differs from this plan. Never update the vector to match a different document.

- [ ] **Step 1: Create the package skeleton**

`packages/grant-advisor/package.json`:
```json
{
  "name": "@mida/grant-advisor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@mida/protocol": "workspace:*",
    "@noble/hashes": "2.4.0",
    "ox": "1.7.4",
    "viem": "2.56.3"
  }
}
```

`packages/grant-advisor/src/index.ts`:
```ts
export {}
```

Add to the root `package.json` `"dependencies"`:
```json
    "@mida/grant-advisor": "workspace:*"
```

In `tsconfig.json`, change `"include"` to:
```json
  "include": ["packages/*/src", "packages/*/test", "packages/*/scripts", "apps/*/src", "apps/*/test", "vitest.config.ts"]
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing policy test**

`packages/grant-advisor/test/policy.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { keccak256 } from "viem"
import { NAMESPACE_TREE_V1, canonicalBytes, expandNamespace, isMidaError, namespaceId } from "@mida/protocol"
import type { PurposeId } from "@mida/protocol"
import {
  DURATION_CAP_SECONDS,
  POLICY_DOCUMENT_V1,
  POLICY_HASH_V1,
  PURPOSE_IDS,
  classifyScope,
  isPurposeId,
  permissionBits,
  permissionNames,
  provenancePolicyBits,
  provenancePolicyNames,
  sensitivityOf,
  sensitivityOfId,
} from "@mida/grant-advisor"

const fails = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const

describe("policy document v1 (§14.2)", () => {
  it("hashes to the frozen POLICY_HASH_V1 vector that Solidity mirrors", () => {
    expect(POLICY_HASH_V1).toBe("0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45")
    expect(keccak256(canonicalBytes(POLICY_DOCUMENT_V1))).toBe(POLICY_HASH_V1)
  })

  it("is deeply frozen so no caller can edit policy at runtime", () => {
    expect(Object.isFrozen(POLICY_DOCUMENT_V1)).toBe(true)
    expect(Object.isFrozen(POLICY_DOCUMENT_V1.sensitivity.HIGH)).toBe(true)
    expect(Object.isFrozen(POLICY_DOCUMENT_V1.purposes.career_coaching.expected[1]!.permissions)).toBe(true)
  })

  it("gives every node a sensitivity at least as strict as everything it expands to", () => {
    for (const node of NAMESPACE_TREE_V1) {
      for (const name of expandNamespace(node.name)) {
        expect(RANK[sensitivityOf(node.name)]).toBeGreaterThanOrEqual(RANK[sensitivityOf(name)])
      }
    }
    expect(sensitivityOf("preferences")).toBe("LOW")
    expect(sensitivityOf("profile")).toBe("MEDIUM")
    expect(sensitivityOf("financial.preferences")).toBe("HIGH")
    expect(sensitivityOfId(namespaceId("private"))).toBe("HIGH")
  })

  it("fixes the §14.4 duration caps", () => {
    expect(DURATION_CAP_SECONDS).toEqual({ LOW: 2_592_000n, MEDIUM: 604_800n, HIGH: 86_400n })
  })
})

describe("purpose classification (§14.3)", () => {
  const rule = (purpose: PurposeId, namespace: string) => classifyScope(purpose, namespaceId(namespace))

  it("matches the career_coaching row", () => {
    expect(rule("career_coaching", "profile.skills")).toEqual({ classification: "EXPECTED", permissions: 1, provenancePolicy: 0 })
    expect(rule("career_coaching", "goals.career")).toEqual({ classification: "EXPECTED", permissions: 3, provenancePolicy: 1 })
    expect(rule("career_coaching", "preferences.communication").classification).toBe("EXPECTED")
    expect(rule("career_coaching", "profile.identity").classification).toBe("ELEVATED")
    expect(rule("career_coaching", "projects.current").classification).toBe("ELEVATED")
    expect(rule("career_coaching", "goals.learning")).toEqual({ classification: "UNCLASSIFIED", permissions: 0, provenancePolicy: 0 })
  })

  it("matches the project_assistance and general_assistance rows", () => {
    expect(rule("project_assistance", "projects.current")).toEqual({ classification: "EXPECTED", permissions: 7, provenancePolicy: 1 })
    expect(rule("project_assistance", "decisions.projects")).toEqual({ classification: "ELEVATED", permissions: 2, provenancePolicy: 1 })
    expect(rule("project_assistance", "goals.career").classification).toBe("ELEVATED")
    expect(rule("general_assistance", "preferences.communication").classification).toBe("EXPECTED")
    expect(rule("general_assistance", "projects.current").classification).toBe("ELEVATED")
  })

  it("expands travel preferences to the parent and all three children", () => {
    for (const name of expandNamespace("preferences")) {
      expect(rule("travel_planning", name)).toEqual({ classification: "EXPECTED", permissions: 1, provenancePolicy: 0 })
    }
    expect(rule("travel_planning", "profile.identity").classification).toBe("ELEVATED")
  })

  it("marks every HIGH namespace suspicious for every purpose", () => {
    for (const purpose of PURPOSE_IDS) {
      for (const name of ["credentials", "financial", "financial.preferences", "private"]) {
        expect(rule(purpose, name)).toEqual({ classification: "SUSPICIOUS", permissions: 0, provenancePolicy: 0 })
      }
    }
  })

  it("rejects unknown purposes and namespaces", () => {
    expect(isPurposeId("career_coaching")).toBe(true)
    expect(isPurposeId("surveillance")).toBe(false)
    expect(fails("PURPOSE_UNKNOWN", () => classifyScope("surveillance" as PurposeId, namespaceId("goals.career")))).toBe(true)
    expect(fails("INVALID_NAMESPACE", () => classifyScope("career_coaching", `0x${"00".repeat(32)}`))).toBe(true)
  })
})

describe("bit and name conversion", () => {
  it("round-trips permission and provenance names", () => {
    expect(permissionBits(["READ", "SUPERSEDE_ANY"])).toBe(9)
    expect(permissionNames(15)).toEqual(["READ", "CREATE", "SUPERSEDE_OWN", "SUPERSEDE_ANY"])
    expect(provenancePolicyBits(["ALLOW_IMPORTED"])).toBe(2)
    expect(provenancePolicyNames(5)).toEqual(["ALLOW_INFERENCE", "ALLOW_EXTERNAL_ATTESTATION"])
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/grant-advisor/test/policy.test.ts`
Expected: FAIL — assertions receive `undefined` (for example `expected undefined to be '0xfd7cb441…'`) or `classifyScope is not a function`, because `index.ts` exports nothing yet.

- [ ] **Step 4: Implement `policy.ts` and export it**

`packages/grant-advisor/src/policy.ts`:
```ts
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
```

`packages/grant-advisor/src/index.ts`:
```ts
export * from "./policy.js"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/grant-advisor/test/policy.test.ts`
Expected: PASS, including `hashes to the frozen POLICY_HASH_V1 vector`. If only that assertion fails, stop and diff `policy.ts` against this plan; see the handoff note above.

- [ ] **Step 6: Write the failing vector handoff test**

`packages/grant-advisor/test/policy-vector.test.ts`:
```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"

const vectorPath = fileURLToPath(new URL("../../../contracts/test/vectors/policy-v1.json", import.meta.url))

describe("policy hash handoff to Solidity (Task 14)", () => {
  it("the committed vector file matches the TypeScript policy hash", () => {
    expect(JSON.parse(readFileSync(vectorPath, "utf8"))).toEqual({ policyHash: POLICY_HASH_V1 })
  })
})
```

Run: `pnpm vitest run packages/grant-advisor/test/policy-vector.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '…/contracts/test/vectors/policy-v1.json'`.

- [ ] **Step 7: Add the export script and generate the vector**

`packages/grant-advisor/scripts/export-policy-vector.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { POLICY_HASH_V1 } from "../src/policy.js"

const outPath = fileURLToPath(new URL("../../../contracts/test/vectors/policy-v1.json", import.meta.url))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ policyHash: POLICY_HASH_V1 }, null, 2)}\n`)
console.log(`wrote ${outPath} policyHash=${POLICY_HASH_V1}`)
```

Run: `pnpm tsx packages/grant-advisor/scripts/export-policy-vector.ts`
Expected output ends with `policyHash=0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45`, and `contracts/test/vectors/policy-v1.json` contains:
```json
{
  "policyHash": "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45"
}
```

- [ ] **Step 8: Run to verify everything passes**

Run:
```bash
pnpm vitest run packages/grant-advisor
pnpm typecheck
```
Expected: both policy test files PASS. Typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/grant-advisor contracts/test/vectors/policy-v1.json package.json pnpm-lock.yaml tsconfig.json
git commit -m "feat(grant-advisor): frozen policy v1 document, POLICY_HASH_V1 and Solidity vector

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---
### Task 11: Agent capability manifests: validation, body hash, EIP-712 binding

An agent's manifest is its public promise about what it may ever ask for. This task makes sure a manifest is well formed, hashes it the same way everywhere, and proves it is the exact version the registry committed to, signed by the registered operator for this chain and registry (§14.1).

**Files:**
- Create: `packages/grant-advisor/src/signatures.ts`, `packages/grant-advisor/src/manifest.ts`
- Modify: `packages/grant-advisor/src/index.ts`
- Create (test helper reused by Tasks 12–13): `packages/grant-advisor/test/fixtures.ts`
- Test: `packages/grant-advisor/test/manifest.test.ts`

**Interfaces:**
- Consumes: from `@mida/protocol` — `MidaError`, `PERMISSION`, `PROVENANCE_POLICY`, `assertHex`, `canonicalBytes`, `canonicalizeNamespace`, `manifestBindingTypedData`, `accessRequestTypedData`, `agentId`, `encodeUint64`, `namespaceId`, `originHash`, `sortScopes` (Tasks 2–5); types `AccessRequest`, `AgentCapabilityManifestBody`, `AgentRecord`, `OwnerAgentHistory`, `SignedAgentCapabilityManifest`, `UnsignedAccessRequest`. From Task 10: `isPurposeId`.
- Produces, in `signatures.ts`:
  - `recoverTypedDataSigner(typedData: TypedDataDefinition, signature: Hex): Address | null`
  - `isTypedDataSignedBy(typedData: TypedDataDefinition, signature: Hex, expected: Address): boolean`
  - `assertAccessRequestSignature(request: AccessRequest, signer: Address): void` — throws `REQUEST_SIGNATURE_INVALID`
- Produces, in `manifest.ts`:
  - `MANIFEST_LIMITS = { nameBytes: 80, textBytes: 280, purposes: 8, scopeDeclarations: 32 }`
  - `normalizeManifestBody(body: AgentCapabilityManifestBody): AgentCapabilityManifestBody` — NFC on every string
  - `validateManifestBody(input: unknown, now: bigint): asserts input is AgentCapabilityManifestBody`
  - `manifestBodyHash(body: AgentCapabilityManifestBody): Hex` — `keccak256(RFC 8785(NFC body))`
  - `manifestEnvelopeBytes(envelope: SignedAgentCapabilityManifest): Uint8Array`
  - `manifestEnvelopeHash(envelope: SignedAgentCapabilityManifest): Hex` — `SHA256(envelope bytes)`
  - `manifestBindingFor(input: { chainId: bigint; capabilityRegistry: Address; body: AgentCapabilityManifestBody })` — EIP-712 typed data for the operator to sign
  - `verifySignedManifest(input: { envelope: SignedAgentCapabilityManifest; agentRecord: AgentRecord; chainId: bigint; capabilityRegistry: Address; now: bigint }): { bodyHash: Hex; envelopeHash: Hex }` — check order: structure, `AGENT_ID_MISMATCH`, `MANIFEST_STALE`, `MANIFEST_HASH_MISMATCH`, `MANIFEST_SIGNATURE_INVALID`
  - `parseManifestEnvelopeBytes(input: { bytes: Uint8Array; expectedEnvelopeHash: Hex; expectedBodyHash: Hex }): SignedAgentCapabilityManifest` — for the API's `GET /agent-manifests/:bodyHash` (Task 24)
- Produces, in `test/fixtures.ts` (tests only): `CHAIN_ID`, `REGISTRY`, `OTHER_REGISTRY`, `NOW`, `DAY`, `OWNER`, `CALLBACK_ORIGIN`, `operator`, `signer`, `stranger`, `AGENT_ID`, `manifestBody(overrides?)`, `signManifest(body, options?)`, `agentRecordFor(body, overrides?)`, `interface ExactScopeInput`, `unsignedRequest(scopes, overrides?, body?)`, `signRequest(request, account?)`, `ownerHistory(overrides?)`.

The `as unknown as TypedDataDefinition` casts exist because Part A's `midaDomain` types `name` as `string`, which viem's generic signing types cannot narrow. The runtime objects are unchanged.

- [ ] **Step 1: Write the shared test fixtures**

`packages/grant-advisor/test/fixtures.ts`:
```ts
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
import type { TypedDataDefinition } from "viem"
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
  return { manifest: body, operatorSignature: await account.signTypedData(binding as unknown as TypedDataDefinition) }
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
  const typedData = accessRequestTypedData(request) as unknown as TypedDataDefinition
  return { ...request, agentSignature: await account.signTypedData(typedData) }
}

export function ownerHistory(overrides: Partial<OwnerAgentHistory> = {}): OwnerAgentHistory {
  return { owner: OWNER, agentId: AGENT_ID, previouslyRevoked: false, observedThroughBlock: 100n, ...overrides }
}
```

- [ ] **Step 2: Write the failing manifest test**

`packages/grant-advisor/test/manifest.test.ts`:
```ts
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { describe, expect, it } from "vitest"
import { NAMESPACE_TREE_V1, canonicalBytes, isMidaError, namespaceId } from "@mida/protocol"
import type { AgentCapabilityManifestBody, MidaErrorCode, ScopeDeclaration, SignedAgentCapabilityManifest } from "@mida/protocol"
import { keccak256, verifyTypedData } from "viem"
import type { TypedDataDefinition } from "viem"
import {
  MANIFEST_LIMITS,
  assertAccessRequestSignature,
  manifestBindingFor,
  manifestBodyHash,
  manifestEnvelopeBytes,
  manifestEnvelopeHash,
  parseManifestEnvelopeBytes,
  recoverTypedDataSigner,
  validateManifestBody,
  verifySignedManifest,
} from "@mida/grant-advisor"
import {
  AGENT_ID,
  CHAIN_ID,
  NOW,
  OTHER_REGISTRY,
  REGISTRY,
  agentRecordFor,
  manifestBody,
  operator,
  signManifest,
  signRequest,
  signer,
  stranger,
  unsignedRequest,
} from "./fixtures.js"

function failsWith(code: MidaErrorCode, fn: () => unknown): boolean {
  try {
    fn()
  } catch (error) {
    if (isMidaError(error, code)) return true
    throw error
  }
  return false
}

const invalidBody = (patch: Record<string, unknown>) => ({ ...manifestBody(), ...patch }) as unknown

const scope = (overrides: Partial<ScopeDeclaration> = {}): ScopeDeclaration => ({
  purposeId: "career_coaching",
  namespace: "goals.career",
  permissions: ["READ"],
  reason: "Reason",
  ...overrides,
})

describe("manifest body hashing (§14.1)", () => {
  it("is keccak256 of the RFC 8785 canonical body", () => {
    const body = manifestBody()
    expect(manifestBodyHash(body)).toBe(keccak256(canonicalBytes(body)))
  })

  it("normalizes to NFC before hashing", () => {
    const composed = manifestBody({ name: "Caf\u00e9" })
    const decomposed = manifestBody({ name: "Cafe\u0301" })
    expect(decomposed.name).not.toBe(composed.name)
    expect(manifestBodyHash(decomposed)).toBe(manifestBodyHash(composed))
  })

  it("is independent of key order", () => {
    const body = manifestBody()
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as unknown as AgentCapabilityManifestBody
    expect(manifestBodyHash(reordered)).toBe(manifestBodyHash(body))
  })
})

describe("manifest limits and structure (§14.1)", () => {
  it("accepts the fixture body", () => {
    expect(() => validateManifestBody(manifestBody(), NOW)).not.toThrow()
  })

  it.each([
    ["empty name", { name: "" }],
    ["81-byte name", { name: "a".repeat(MANIFEST_LIMITS.nameBytes + 1) }],
    ["82-byte multibyte name", { name: "\u00e9".repeat(41) }],
    ["v2", { v: 2 }],
    ["uppercase agentId", { agentId: `0x${AGENT_ID.slice(2).toUpperCase()}` }],
    ["version 0", { manifestVersion: 0 }],
    ["future issuedAt", { issuedAt: Number(NOW + 1n) }],
    ["no purposes", { purposes: [] }],
    ["nine purposes", { purposes: Array.from({ length: 9 }, () => ({ id: "career_coaching", description: "x" })) }],
    ["duplicate purpose", { purposes: [{ id: "career_coaching", description: "x" }, { id: "career_coaching", description: "y" }] }],
    ["281-byte description", { purposes: [{ id: "career_coaching", description: "d".repeat(281) }] }],
    ["extra body key", { extra: true }],
    ["empty reason", { scopeDeclarations: [scope({ reason: "" })] }],
    ["empty permissions", { scopeDeclarations: [scope({ permissions: [] })] }],
    ["unknown permission", { scopeDeclarations: [scope({ permissions: ["ADMIN" as "READ"] })] }],
    ["duplicate permission", { scopeDeclarations: [scope({ permissions: ["READ", "READ"] })] }],
    ["unknown provenance policy", { scopeDeclarations: [scope({ provenancePolicies: ["ALLOW_ANYTHING" as "ALLOW_INFERENCE"] })] }],
    ["duplicate declaration", { scopeDeclarations: [scope(), scope({ permissions: ["CREATE"] })] }],
    ["agent-declared sensitivity", { scopeDeclarations: [{ ...scope(), sensitivity: "LOW" }] }],
  ])("rejects %s with INVALID_WIRE", (_label, patch) => {
    expect(failsWith("INVALID_WIRE", () => validateManifestBody(invalidBody(patch), NOW))).toBe(true)
  })

  it("rejects 33 scope declarations", () => {
    const purposes = [
      { id: "career_coaching", description: "a" },
      { id: "general_assistance", description: "b" },
    ] as const
    const declarations = purposes
      .flatMap((purpose) => NAMESPACE_TREE_V1.map((node) => scope({ purposeId: purpose.id, namespace: node.name })))
      .slice(0, MANIFEST_LIMITS.scopeDeclarations + 1)
    const body = invalidBody({ purposes: [...purposes], scopeDeclarations: declarations })
    expect(failsWith("INVALID_WIRE", () => validateManifestBody(body, NOW))).toBe(true)
  })

  it("rejects non-canonical and unknown namespaces with INVALID_NAMESPACE", () => {
    for (const namespace of ["Goals.Career", "goals.unknown", "custom"]) {
      const body = invalidBody({ scopeDeclarations: [scope({ namespace })] })
      expect(failsWith("INVALID_NAMESPACE", () => validateManifestBody(body, NOW)), namespace).toBe(true)
    }
  })

  it("rejects unknown or undeclared purposes with PURPOSE_UNKNOWN", () => {
    const unknown = invalidBody({ purposes: [{ id: "surveillance", description: "x" }] })
    expect(failsWith("PURPOSE_UNKNOWN", () => validateManifestBody(unknown, NOW))).toBe(true)
    const undeclared = invalidBody({ scopeDeclarations: [scope({ purposeId: "travel_planning" })] })
    expect(failsWith("PURPOSE_UNKNOWN", () => validateManifestBody(undeclared, NOW))).toBe(true)
  })
})

describe("signed manifest verification (§14.1, §15 Advisor rows)", () => {
  const verify = (envelope: SignedAgentCapabilityManifest, record = agentRecordFor(manifestBody())) =>
    verifySignedManifest({ envelope, agentRecord: record, chainId: CHAIN_ID, capabilityRegistry: REGISTRY, now: NOW })

  it("accepts a current envelope signed by the operator", async () => {
    const envelope = await signManifest(manifestBody())
    const result = verify(envelope)
    expect(result.bodyHash).toBe(manifestBodyHash(manifestBody()))
    expect(result.envelopeHash).toBe(manifestEnvelopeHash(envelope))
  })

  it("rejects a body mutated after signing", async () => {
    const envelope = await signManifest(manifestBody())
    const mutated = { ...envelope, manifest: { ...envelope.manifest, name: "CareerAI (all access)" } }
    expect(failsWith("MANIFEST_HASH_MISMATCH", () => verify(mutated))).toBe(true)
  })

  it("rejects an envelope signed for another registry or chain", async () => {
    const otherRegistry = await signManifest(manifestBody(), { capabilityRegistry: OTHER_REGISTRY })
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(otherRegistry))).toBe(true)
    const otherChain = await signManifest(manifestBody(), { chainId: 10143n })
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(otherChain))).toBe(true)
  })

  it("rejects a signature from anyone but the registered operator, and garbage signatures", async () => {
    const byStranger = await signManifest(manifestBody(), { account: stranger })
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(byStranger))).toBe(true)
    const garbage: SignedAgentCapabilityManifest = { manifest: manifestBody(), operatorSignature: "0x1234" }
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(garbage))).toBe(true)
  })

  it("rejects a stale version and a foreign agent id", async () => {
    const envelope = await signManifest(manifestBody())
    const newerRecord = agentRecordFor(manifestBody({ manifestVersion: 2 }))
    expect(failsWith("MANIFEST_STALE", () => verify(envelope, newerRecord))).toBe(true)
    const foreign = agentRecordFor(manifestBody(), { agentId: `0x${"99".repeat(32)}` })
    expect(failsWith("AGENT_ID_MISMATCH", () => verify(envelope, foreign))).toBe(true)
  })
})

describe("stored envelope bytes (§14.1 GET /agent-manifests/:bodyHash)", () => {
  it("round-trips canonical bytes", async () => {
    const envelope = await signManifest(manifestBody())
    const parsed = parseManifestEnvelopeBytes({
      bytes: manifestEnvelopeBytes(envelope),
      expectedEnvelopeHash: manifestEnvelopeHash(envelope),
      expectedBodyHash: manifestBodyHash(envelope.manifest),
    })
    expect(parsed).toEqual(envelope)
  })

  it("rejects an index that maps a body hash to another envelope's bytes", async () => {
    const mine = await signManifest(manifestBody())
    const theirs = await signManifest(manifestBody({ name: "OtherAgent" }))
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: manifestEnvelopeBytes(theirs),
        expectedEnvelopeHash: manifestEnvelopeHash(theirs),
        expectedBodyHash: manifestBodyHash(mine.manifest),
      })
    expect(failsWith("MANIFEST_HASH_MISMATCH", attempt)).toBe(true)
  })

  it("rejects bytes that do not hash to the indexed envelope hash", async () => {
    const envelope = await signManifest(manifestBody())
    const tampered = manifestEnvelopeBytes(envelope).slice()
    tampered[10] = tampered[10]! ^ 1
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: tampered,
        expectedEnvelopeHash: manifestEnvelopeHash(envelope),
        expectedBodyHash: manifestBodyHash(envelope.manifest),
      })
    expect(failsWith("MANIFEST_HASH_MISMATCH", attempt)).toBe(true)
  })

  it("rejects non-canonical bytes even when their own hash is indexed", async () => {
    const envelope = await signManifest(manifestBody())
    const pretty = new TextEncoder().encode(JSON.stringify(envelope, null, 2))
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: pretty,
        expectedEnvelopeHash: `0x${bytesToHex(sha256(pretty))}`,
        expectedBodyHash: manifestBodyHash(envelope.manifest),
      })
    expect(failsWith("INVALID_WIRE", attempt)).toBe(true)
  })
})

describe("synchronous signature recovery", () => {
  it("agrees with viem verifyTypedData", async () => {
    const binding = manifestBindingFor({ chainId: CHAIN_ID, capabilityRegistry: REGISTRY, body: manifestBody() }) as unknown as TypedDataDefinition
    const signature = await operator.signTypedData(binding)
    expect(await verifyTypedData({ ...binding, address: operator.address, signature })).toBe(true)
    expect(recoverTypedDataSigner(binding, signature)?.toLowerCase()).toBe(operator.address.toLowerCase())
    expect(recoverTypedDataSigner(binding, "0x00")).toBeNull()
  })

  it("verifies access request signatures against the registered signer only", async () => {
    const request = await signRequest(unsignedRequest([{ namespace: "goals.career", permissions: 1 }]))
    expect(() => assertAccessRequestSignature(request, signer.address)).not.toThrow()
    expect(failsWith("REQUEST_SIGNATURE_INVALID", () => assertAccessRequestSignature(request, stranger.address))).toBe(true)
    const broadened = { ...request, scopes: [{ namespaceId: namespaceId("goals.career"), permissions: 3, provenancePolicy: 0 }] }
    expect(failsWith("REQUEST_SIGNATURE_INVALID", () => assertAccessRequestSignature(broadened, signer.address))).toBe(true)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/grant-advisor/test/manifest.test.ts`
Expected: FAIL with `TypeError: … is not a function` (for example `manifestBodyHash is not a function`), because nothing is exported yet.

- [ ] **Step 4: Implement `signatures.ts`**

`packages/grant-advisor/src/signatures.ts`:
```ts
import { MidaError, accessRequestTypedData } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { Secp256k1, Signature } from "ox"
import { hashTypedData, isAddressEqual } from "viem"
import type { TypedDataDefinition } from "viem"

/**
 * Synchronous EIP-712 signer recovery. viem's verifyTypedData is async, but adviseGrant is a pure
 * synchronous function (§14.5), so recovery uses viem's hashTypedData plus ox's secp256k1 recovery.
 * Tests cross-check the result against viem's verifyTypedData. EOA signers only; ERC-1271 is not supported.
 */
export function recoverTypedDataSigner(typedData: TypedDataDefinition, signature: Hex): Address | null {
  try {
    return Secp256k1.recoverAddress({ payload: hashTypedData(typedData), signature: Signature.fromHex(signature) })
  } catch {
    return null
  }
}

export function isTypedDataSignedBy(typedData: TypedDataDefinition, signature: Hex, expected: Address): boolean {
  const recovered = recoverTypedDataSigner(typedData, signature)
  return recovered !== null && isAddressEqual(recovered, expected)
}

export function assertAccessRequestSignature(request: AccessRequest, signer: Address): void {
  const { agentSignature, ...unsigned } = request
  const typedData = accessRequestTypedData(unsigned) as unknown as TypedDataDefinition
  if (!isTypedDataSignedBy(typedData, agentSignature, signer)) {
    throw new MidaError("REQUEST_SIGNATURE_INVALID", "request is not signed by the registered agent signer")
  }
}
```

- [ ] **Step 5: Implement `manifest.ts`**

`packages/grant-advisor/src/manifest.ts`:
```ts
import {
  MidaError,
  PERMISSION,
  PROVENANCE_POLICY,
  assertHex,
  canonicalBytes,
  canonicalizeNamespace,
  manifestBindingTypedData,
} from "@mida/protocol"
import type { AgentCapabilityManifestBody, AgentRecord, Address, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { keccak256 } from "viem"
import type { TypedDataDefinition } from "viem"
import { isPurposeId } from "./policy.js"
import { isTypedDataSignedBy } from "./signatures.js"

export const MANIFEST_LIMITS = Object.freeze({ nameBytes: 80, textBytes: 280, purposes: 8, scopeDeclarations: 32 })

const utf8Length = (value: string) => new TextEncoder().encode(value).length

function nfc<T>(value: T): T {
  if (typeof value === "string") return value.normalize("NFC") as T
  if (Array.isArray(value)) return value.map((item) => nfc(item)) as T
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nfc(item)])) as T
  }
  return value
}

function wire(detail: string): never {
  throw new MidaError("INVALID_WIRE", `manifest: ${detail}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[], where: string) {
  if (!isPlainObject(value)) return wire(`${where} must be an object`)
  for (const key of required) if (!Object.hasOwn(value, key)) wire(`${where}.${key} is required`)
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) wire(`${where}.${key} is not allowed`)
  }
  return value
}

function text(value: unknown, min: number, max: number, where: string): string {
  if (typeof value !== "string") return wire(`${where} must be a string`)
  const length = utf8Length(value)
  if (length < min || length > max) wire(`${where} must be ${min}-${max} UTF-8 bytes`)
  return value
}

function uniqueNames(value: unknown, known: Record<string, number>, allowEmpty: boolean, where: string): void {
  if (!Array.isArray(value)) return wire(`${where} must be an array`)
  if (!allowEmpty && value.length === 0) wire(`${where} must be non-empty`)
  const seen = new Set<string>()
  for (const name of value) {
    if (typeof name !== "string" || !Object.hasOwn(known, name)) wire(`${where} has unknown value ${String(name)}`)
    if (seen.has(name)) wire(`${where} has duplicate ${name}`)
    seen.add(name)
  }
}

export function normalizeManifestBody(body: AgentCapabilityManifestBody): AgentCapabilityManifestBody {
  return nfc(body)
}

/** Enforces every §14.1 structural rule and limit on the NFC-normalized body. Sensitivity claims are rejected as unknown keys. */
export function validateManifestBody(input: unknown, now: bigint): asserts input is AgentCapabilityManifestBody {
  const body = exactKeys(nfc(input), ["v", "agentId", "manifestVersion", "name", "purposes", "scopeDeclarations", "issuedAt"], [], "body")
  if (body.v !== 1) wire("v must be 1")
  if (typeof body.agentId !== "string") wire("agentId must be a string")
  assertHex(body.agentId as string, 32)
  if (!Number.isSafeInteger(body.manifestVersion) || (body.manifestVersion as number) < 1) wire("manifestVersion must be an integer >= 1")
  text(body.name, 1, MANIFEST_LIMITS.nameBytes, "name")
  if (!Number.isSafeInteger(body.issuedAt) || (body.issuedAt as number) < 0) wire("issuedAt must be a non-negative integer")
  if (BigInt(body.issuedAt as number) > now) wire("issuedAt is in the future")

  if (!Array.isArray(body.purposes)) return wire("purposes must be an array")
  if (body.purposes.length < 1 || body.purposes.length > MANIFEST_LIMITS.purposes) wire("purposes must have 1-8 entries")
  const declaredPurposes = new Set<string>()
  body.purposes.forEach((entry, index) => {
    const purpose = exactKeys(entry, ["id", "description"], [], `purposes[${index}]`)
    if (typeof purpose.id !== "string" || !isPurposeId(purpose.id)) {
      throw new MidaError("PURPOSE_UNKNOWN", `purposes[${index}].id ${String(purpose.id)}`)
    }
    if (declaredPurposes.has(purpose.id)) wire(`duplicate purpose ${purpose.id}`)
    declaredPurposes.add(purpose.id)
    text(purpose.description, 1, MANIFEST_LIMITS.textBytes, `purposes[${index}].description`)
  })

  if (!Array.isArray(body.scopeDeclarations)) return wire("scopeDeclarations must be an array")
  if (body.scopeDeclarations.length > MANIFEST_LIMITS.scopeDeclarations) wire("scopeDeclarations must have at most 32 entries")
  const declaredPairs = new Set<string>()
  body.scopeDeclarations.forEach((entry, index) => {
    const where = `scopeDeclarations[${index}]`
    const scope = exactKeys(entry, ["purposeId", "namespace", "permissions", "reason"], ["provenancePolicies"], where)
    if (typeof scope.purposeId !== "string" || !declaredPurposes.has(scope.purposeId)) {
      throw new MidaError("PURPOSE_UNKNOWN", `${where}.purposeId is not declared in purposes`)
    }
    if (typeof scope.namespace !== "string" || canonicalizeNamespace(scope.namespace) !== scope.namespace) {
      throw new MidaError("INVALID_NAMESPACE", `${where}.namespace must already be canonical`)
    }
    const pair = `${scope.purposeId} ${scope.namespace}`
    if (declaredPairs.has(pair)) wire(`duplicate declaration ${scope.purposeId}/${scope.namespace}`)
    declaredPairs.add(pair)
    uniqueNames(scope.permissions, PERMISSION, false, `${where}.permissions`)
    if (Object.hasOwn(scope, "provenancePolicies")) {
      uniqueNames(scope.provenancePolicies, PROVENANCE_POLICY, true, `${where}.provenancePolicies`)
    }
    text(scope.reason, 1, MANIFEST_LIMITS.textBytes, `${where}.reason`)
  })
}

export function manifestBodyHash(body: AgentCapabilityManifestBody): Hex {
  return keccak256(canonicalBytes(normalizeManifestBody(body)))
}

export function manifestEnvelopeBytes(envelope: SignedAgentCapabilityManifest): Uint8Array {
  return canonicalBytes({ manifest: normalizeManifestBody(envelope.manifest), operatorSignature: envelope.operatorSignature })
}

export function manifestEnvelopeHash(envelope: SignedAgentCapabilityManifest): Hex {
  return `0x${bytesToHex(sha256(manifestEnvelopeBytes(envelope)))}`
}

export function manifestBindingFor(input: { chainId: bigint; capabilityRegistry: Address; body: AgentCapabilityManifestBody }) {
  return manifestBindingTypedData({
    chainId: input.chainId,
    capabilityRegistry: input.capabilityRegistry,
    bodyHash: manifestBodyHash(input.body),
    agentId: input.body.agentId,
    manifestVersion: BigInt(input.body.manifestVersion),
  })
}

/**
 * §14.1 currentness check. Order: structure, agent identity, version, body hash, operator signature.
 * An envelope is current only when its body hash and version equal the on-chain AgentRecord.
 */
export function verifySignedManifest(input: {
  envelope: SignedAgentCapabilityManifest
  agentRecord: AgentRecord
  chainId: bigint
  capabilityRegistry: Address
  now: bigint
}): { bodyHash: Hex; envelopeHash: Hex } {
  const envelope = exactKeys(input.envelope, ["manifest", "operatorSignature"], [], "envelope")
  if (typeof envelope.operatorSignature !== "string") wire("operatorSignature must be a string")
  const body = input.envelope.manifest
  validateManifestBody(body, input.now)
  const { agentRecord } = input
  if (body.agentId.toLowerCase() !== agentRecord.agentId.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "manifest agentId differs from the registered agent")
  }
  if (body.manifestVersion !== agentRecord.capabilityManifestVersion) {
    throw new MidaError("MANIFEST_STALE", `manifest version ${body.manifestVersion} is not current`)
  }
  const bodyHash = manifestBodyHash(body)
  if (bodyHash !== agentRecord.capabilityManifestHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "manifest body hash differs from the registered commitment")
  }
  const binding = manifestBindingFor({ chainId: input.chainId, capabilityRegistry: input.capabilityRegistry, body })
  if (!isTypedDataSignedBy(binding as unknown as TypedDataDefinition, input.envelope.operatorSignature, agentRecord.operator)) {
    throw new MidaError("MANIFEST_SIGNATURE_INVALID", "binding is not signed by the registered operator for this chain and registry")
  }
  return { bodyHash, envelopeHash: manifestEnvelopeHash(input.envelope) }
}

/**
 * For GET /agent-manifests/:bodyHash (§14.1): stored bytes must hash to the indexed envelope hash, be canonical,
 * and contain a body whose hash is the requested body hash. The signature is checked later by verifySignedManifest.
 */
export function parseManifestEnvelopeBytes(input: { bytes: Uint8Array; expectedEnvelopeHash: Hex; expectedBodyHash: Hex }): SignedAgentCapabilityManifest {
  if (`0x${bytesToHex(sha256(input.bytes))}` !== input.expectedEnvelopeHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "envelope bytes do not match the indexed envelope hash")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes))
  } catch {
    return wire("envelope bytes are not UTF-8 JSON")
  }
  const envelope = exactKeys(parsed, ["manifest", "operatorSignature"], [], "envelope")
  if (typeof envelope.operatorSignature !== "string" || !isPlainObject(envelope.manifest)) wire("envelope shape")
  const canonical = canonicalBytes(parsed)
  if (canonical.length !== input.bytes.length || canonical.some((byte, index) => byte !== input.bytes[index])) {
    wire("envelope bytes are not RFC 8785 canonical")
  }
  const signed = parsed as SignedAgentCapabilityManifest
  if (manifestBodyHash(signed.manifest) !== input.expectedBodyHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "envelope body does not hash to the requested body hash")
  }
  return signed
}
```

- [ ] **Step 6: Export**

`packages/grant-advisor/src/index.ts`:
```ts
export * from "./policy.js"
export * from "./signatures.js"
export * from "./manifest.js"
```

- [ ] **Step 7: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/grant-advisor
pnpm typecheck
```
Expected: every grant-advisor test PASS (the manifest file alone has 37 tests). Typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/grant-advisor
git commit -m "feat(grant-advisor): manifest validation, body and envelope hashing, operator binding checks

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---
### Task 12: Effective authority expansion and subset proofs

Authority is compared as exact facts, never as namespace strings (§14.5). `preferences:READ` means READ on four exact namespaces. This task turns builder input into exact signed scopes, and provides the one subset check that the Advisor, the FakeVault and the SDK all share. The check is the same rule the contract enforces in `grantBatch`: every granted namespace was requested, with no extra permission or provenance bits, and no later expiry.

**Files:**
- Create: `packages/grant-advisor/src/authority.ts`
- Modify: `packages/grant-advisor/src/index.ts`
- Test: `packages/grant-advisor/test/authority.test.ts`

**Interfaces:**
- Consumes: from `@mida/protocol` — `KNOWN_PERMISSION_BITS`, `KNOWN_PROVENANCE_BITS`, `MidaError`, `NAMESPACE_TREE_V1`, `accessRequestHash`, `assertCanonicalScopes`, `decodeUint64`, `encodeUint64`, `expandNamespace`, `namespaceId`, `sortScopes` (Tasks 2–5); types `AccessGrantResponse`, `AccessRequest`, `EffectiveAuthority`, `GrantScope`, `RequestedScope`. From Task 10: `POLICY_DOCUMENT_V1`, `permissionNames`, `provenancePolicyNames`, `sensitivityOfId`. From Task 11 fixtures: `DAY`, `NOW`, `OTHER_REGISTRY`, `OWNER`, `signRequest`, `unsignedRequest`.
- Produces, in `authority.ts`:
  - `HIGH_FINAL_SELECTION_CAP_SECONDS: bigint` — `86400n`
  - `interface ScopeInput { namespace: string; permissions: number; provenancePolicy?: number }`
  - `expandScopeInputs(inputs: readonly ScopeInput[]): RequestedScope[]` — canonicalize, expand parents, merge bits, sort. Used by the SDK's `createAccessRequest` (Task 25).
  - `effectiveAuthority(scopes: readonly RequestedScope[]): EffectiveAuthority[]`
  - `authorityKey(tuple: EffectiveAuthority): string`
  - `isAuthoritySubset(candidate: readonly EffectiveAuthority[], requested: readonly EffectiveAuthority[]): boolean`
  - `isScopeSubset(candidate: readonly RequestedScope[], requested: readonly RequestedScope[]): boolean`
  - `isExpiryWithin(candidate: bigint, requested: bigint): boolean` — requested `0n` means unbounded
  - `assertFinalSelection(input: { requestedScopes: readonly RequestedScope[]; requestedExpiresAt: bigint; finalScopes: readonly GrantScope[]; finalExpiresAt: bigint; now: bigint }): void` — used by the FakeVault before it signs (Task 22)
  - `assertGrantResponseWithinRequest(request: AccessRequest, response: AccessGrantResponse, now: bigint): GrantScope[]` — the off-chain half of `completeAccessRequest` (§13.3, Task 25). It never reads the chain; Task 25 must still prove every capability exists and is valid on Monad.

- [ ] **Step 1: Write the failing test**

`packages/grant-advisor/test/authority.test.ts`:
```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { NAMESPACE_TREE_V1, accessRequestHash, encodeUint64, isMidaError, namespaceId, sortScopes } from "@mida/protocol"
import type { AccessGrantResponse, AccessRequest, MidaErrorCode, RequestedScope } from "@mida/protocol"
import {
  assertFinalSelection,
  assertGrantResponseWithinRequest,
  effectiveAuthority,
  expandScopeInputs,
  isAuthoritySubset,
  isExpiryWithin,
  isScopeSubset,
} from "@mida/grant-advisor"
import { DAY, NOW, OTHER_REGISTRY, OWNER, signRequest, unsignedRequest } from "./fixtures.js"

function failsWith(code: MidaErrorCode, fn: () => unknown): boolean {
  try {
    fn()
  } catch (error) {
    if (isMidaError(error, code)) return true
    throw error
  }
  return false
}

const exact = (namespace: string, permissions: number, provenancePolicy = 0): RequestedScope => ({
  namespaceId: namespaceId(namespace),
  permissions,
  provenancePolicy,
})

const scopeSet = fc
  .uniqueArray(fc.integer({ min: 0, max: NAMESPACE_TREE_V1.length - 1 }), { minLength: 1, maxLength: 8 })
  .chain((indexes) =>
    fc.tuple(
      ...indexes.map((index) =>
        fc.record({
          namespaceId: fc.constant(NAMESPACE_TREE_V1[index]!.id),
          permissions: fc.integer({ min: 1, max: 15 }),
          provenancePolicy: fc.integer({ min: 0, max: 7 }),
        }),
      ),
    ),
  )
  .map((scopes) => sortScopes(scopes))

describe("scope expansion (§5.3)", () => {
  it("expands parents, merges bits per exact namespace, and sorts", () => {
    const scopes = expandScopeInputs([
      { namespace: "Projects", permissions: 1 },
      { namespace: "projects.current", permissions: 2, provenancePolicy: 1 },
    ])
    expect(scopes).toEqual(
      sortScopes([exact("projects", 1), exact("projects.current", 3, 1), exact("projects.past", 1)]),
    )
  })

  it("expands travel preferences to exactly four exact scopes", () => {
    expect(expandScopeInputs([{ namespace: "preferences", permissions: 1 }]).map((s) => s.namespaceId)).toEqual(
      sortScopes(["preferences", "preferences.communication", "preferences.tools", "preferences.work"].map((n) => exact(n, 1))).map(
        (s) => s.namespaceId,
      ),
    )
  })

  it("rejects empty input, unknown bits and unknown namespaces", () => {
    expect(failsWith("INVALID_WIRE", () => expandScopeInputs([]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => expandScopeInputs([{ namespace: "goals", permissions: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => expandScopeInputs([{ namespace: "goals", permissions: 16 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => expandScopeInputs([{ namespace: "goals", permissions: 1, provenancePolicy: 8 }]))).toBe(true)
    expect(failsWith("INVALID_NAMESPACE", () => expandScopeInputs([{ namespace: "goals.unknown", permissions: 1 }]))).toBe(true)
  })
})

describe("effective authority (§14.5)", () => {
  it("lists one tuple per permission and per permission-provenance pair", () => {
    const id = namespaceId("goals.career")
    expect(effectiveAuthority([exact("goals.career", 3, 1)])).toEqual([
      { namespaceId: id, permission: "READ" },
      { namespaceId: id, permission: "READ", provenancePolicy: "ALLOW_INFERENCE" },
      { namespaceId: id, permission: "CREATE" },
      { namespaceId: id, permission: "CREATE", provenancePolicy: "ALLOW_INFERENCE" },
    ])
  })

  it("bit containment and tuple containment always agree", () => {
    fc.assert(
      fc.property(scopeSet, scopeSet, (candidate, requested) => {
        expect(isScopeSubset(candidate, requested)).toBe(
          isAuthoritySubset(effectiveAuthority(candidate), effectiveAuthority(requested)),
        )
      }),
      { numRuns: 500 },
    )
  })

  it("any bitwise narrowing of a request is a subset of it", () => {
    fc.assert(
      fc.property(scopeSet, fc.integer({ min: 0, max: 15 }), fc.integer({ min: 0, max: 7 }), (requested, permMask, provMask) => {
        const narrowed = requested
          .map((scope) => ({ ...scope, permissions: scope.permissions & permMask, provenancePolicy: scope.provenancePolicy & provMask }))
          .filter((scope) => scope.permissions !== 0)
        expect(isScopeSubset(narrowed, requested)).toBe(true)
      }),
    )
  })

  it("treats a shorter expiry as narrower and never lets finite become unbounded", () => {
    expect(isExpiryWithin(0n, 0n)).toBe(true)
    expect(isExpiryWithin(500n, 0n)).toBe(true)
    expect(isExpiryWithin(500n, 500n)).toBe(true)
    expect(isExpiryWithin(499n, 500n)).toBe(true)
    expect(isExpiryWithin(501n, 500n)).toBe(false)
    expect(isExpiryWithin(0n, 500n)).toBe(false)
  })
})

describe("final selection (§14.4, §14.5)", () => {
  const requestedScopes = sortScopes([exact("goals.career", 3, 1), exact("financial", 1), exact("profile.identity", 1)])
  const select = (finalScopes: RequestedScope[], finalExpiresAt: bigint, requestedExpiresAt = NOW + 7n * DAY) => () =>
    assertFinalSelection({ requestedScopes, requestedExpiresAt, finalScopes: sortScopes(finalScopes), finalExpiresAt, now: NOW })

  it("accepts narrowed permissions, narrowed provenance and a shorter expiry", () => {
    expect(select([exact("goals.career", 1)], NOW + DAY)).not.toThrow()
    expect(select([exact("goals.career", 2, 0)], NOW + DAY, 0n)).not.toThrow()
  })

  it("lets the user explicitly select elevated or HIGH authority that the agent requested", () => {
    expect(select([exact("profile.identity", 1)], NOW + DAY)).not.toThrow()
    expect(select([exact("financial", 1), exact("goals.career", 1)], NOW + DAY)).not.toThrow()
  })

  it("rejects anything broader than the signed request", () => {
    expect(failsWith("RESPONSE_MISMATCH", select([exact("goals.career", 7)], NOW + DAY))).toBe(true)
    expect(failsWith("RESPONSE_MISMATCH", select([exact("goals.career", 1, 2)], NOW + DAY))).toBe(true)
    expect(failsWith("RESPONSE_MISMATCH", select([exact("goals.learning", 1)], NOW + DAY))).toBe(true)
    expect(failsWith("RESPONSE_MISMATCH", select([exact("goals.career", 1)], NOW + 8n * DAY))).toBe(true)
    expect(failsWith("RESPONSE_MISMATCH", select([exact("goals.career", 1)], 0n))).toBe(true)
  })

  it("rejects past expiry and HIGH authority beyond 24 hours or unbounded", () => {
    expect(failsWith("CAPABILITY_EXPIRED", select([exact("goals.career", 1)], NOW))).toBe(true)
    expect(select([exact("financial", 1)], NOW + DAY)).not.toThrow()
    expect(failsWith("CAPABILITY_DENIED", select([exact("financial", 1)], NOW + DAY + 1n))).toBe(true)
    expect(failsWith("CAPABILITY_DENIED", select([exact("financial", 1)], 0n, 0n))).toBe(true)
  })

  it("rejects non-canonical final scope lists", () => {
    expect(
      failsWith("INVALID_WIRE", () =>
        assertFinalSelection({ requestedScopes, requestedExpiresAt: 0n, finalScopes: [], finalExpiresAt: NOW + DAY, now: NOW }),
      ),
    ).toBe(true)
  })
})

describe("grant response completion check (§13.3)", () => {
  async function fixture() {
    const request = await signRequest(
      unsignedRequest([
        { namespace: "goals.career", permissions: 3, provenancePolicy: 1 },
        { namespace: "financial", permissions: 1 },
      ]),
    )
    const { agentSignature: _signature, ...unsigned } = request
    const response = (
      capabilities: Array<{ namespace: string; permissions: number; provenancePolicy?: number; expiresAt: bigint }>,
      overrides: Partial<AccessGrantResponse> = {},
    ): AccessGrantResponse => ({
      v: 1,
      chainId: request.chainId,
      capabilityRegistry: request.capabilityRegistry,
      requestId: request.requestId,
      nonce: request.nonce,
      requestHash: accessRequestHash(unsigned),
      owner: OWNER,
      agentId: request.agentId,
      manifestHash: request.manifestHash,
      manifestVersion: request.manifestVersion,
      policyVersion: request.policyVersion,
      namespaceTreeVersion: request.namespaceTreeVersion,
      capabilities: capabilities.map((capability, index) => ({
        namespaceId: namespaceId(capability.namespace),
        permissions: capability.permissions,
        provenancePolicy: capability.provenancePolicy ?? 0,
        expiresAt: encodeUint64(capability.expiresAt),
        capabilityId: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        transactionHash: `0x${"ab".repeat(32)}`,
      })),
      ...overrides,
    })
    return { request, response }
  }

  it("accepts a narrowed grant and returns sorted final scopes", async () => {
    const { request, response } = await fixture()
    const scopes = assertGrantResponseWithinRequest(request, response([{ namespace: "goals.career", permissions: 1, expiresAt: NOW + DAY }]), NOW)
    expect(scopes).toEqual([exact("goals.career", 1)])
  })

  it("rejects responses that do not echo the original request", async () => {
    const { request, response } = await fixture()
    const grant = [{ namespace: "goals.career", permissions: 1, expiresAt: NOW + DAY }]
    const cases: Array<Partial<AccessGrantResponse>> = [
      { requestId: `0x${"99".repeat(32)}` },
      { nonce: `0x${"98".repeat(32)}` },
      { requestHash: `0x${"97".repeat(32)}` },
      { capabilityRegistry: OTHER_REGISTRY },
      { chainId: "10143" },
      { manifestVersion: 2 },
      { capabilities: [] },
    ]
    for (const overrides of cases) {
      expect(failsWith("RESPONSE_MISMATCH", () => assertGrantResponseWithinRequest(request, response(grant, overrides), NOW))).toBe(true)
    }
  })

  it("rejects broadened authority and mixed expiries", async () => {
    const { request, response } = await fixture()
    const broadened = response([{ namespace: "goals.career", permissions: 7, expiresAt: NOW + DAY }])
    expect(failsWith("RESPONSE_MISMATCH", () => assertGrantResponseWithinRequest(request, broadened, NOW))).toBe(true)
    const mixed = response([
      { namespace: "goals.career", permissions: 1, expiresAt: NOW + DAY },
      { namespace: "financial", permissions: 1, expiresAt: NOW + 2n * DAY },
    ])
    expect(failsWith("RESPONSE_MISMATCH", () => assertGrantResponseWithinRequest(request, mixed, NOW))).toBe(true)
  })
})

export type { AccessRequest }
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/grant-advisor/test/authority.test.ts`
Expected: FAIL with `TypeError: expandScopeInputs is not a function`.

- [ ] **Step 3: Implement `authority.ts`**

`packages/grant-advisor/src/authority.ts`:
```ts
import {
  KNOWN_PERMISSION_BITS,
  KNOWN_PROVENANCE_BITS,
  MidaError,
  accessRequestHash,
  assertCanonicalScopes,
  decodeUint64,
  expandNamespace,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type { AccessGrantResponse, AccessRequest, EffectiveAuthority, GrantScope, Hex, RequestedScope } from "@mida/protocol"
import { POLICY_DOCUMENT_V1, permissionNames, provenancePolicyNames, sensitivityOfId } from "./policy.js"

export const HIGH_FINAL_SELECTION_CAP_SECONDS = BigInt(POLICY_DOCUMENT_V1.rules.highFinalSelectionCapSeconds)

/** Builder-facing scope: a namespace string (parent allowed) plus permission and provenance bits. */
export interface ScopeInput {
  namespace: string
  permissions: number
  provenancePolicy?: number
}

function assertBits(permissions: number, provenancePolicy: number): void {
  if (!Number.isInteger(permissions) || permissions <= 0 || (permissions & ~KNOWN_PERMISSION_BITS) !== 0) {
    throw new MidaError("INVALID_WIRE", "permissions must be non-zero known bits")
  }
  if (!Number.isInteger(provenancePolicy) || provenancePolicy < 0 || (provenancePolicy & ~KNOWN_PROVENANCE_BITS) !== 0) {
    throw new MidaError("INVALID_WIRE", "provenancePolicy must be known bits")
  }
}

/**
 * §5.3: canonicalize every namespace, expand parents through frozen tree v1, merge bits per exact
 * namespace, and return sorted canonical scopes. This is the only way builder input becomes signed authority.
 */
export function expandScopeInputs(inputs: readonly ScopeInput[]): RequestedScope[] {
  const merged = new Map<Hex, { permissions: number; provenancePolicy: number }>()
  for (const input of inputs) {
    const provenancePolicy = input.provenancePolicy ?? 0
    assertBits(input.permissions, provenancePolicy)
    for (const name of expandNamespace(input.namespace)) {
      const id = namespaceId(name)
      const prior = merged.get(id)
      merged.set(id, {
        permissions: (prior?.permissions ?? 0) | input.permissions,
        provenancePolicy: (prior?.provenancePolicy ?? 0) | provenancePolicy,
      })
    }
  }
  const scopes = sortScopes([...merged].map(([id, bits]) => ({ namespaceId: id, ...bits })))
  assertCanonicalScopes(scopes)
  return scopes
}

/**
 * §14.5 exact authority tuples: one per (namespace, permission), plus one per (namespace, permission, provenance policy).
 * Tuple containment is equivalent to per-namespace bit containment; a property test proves it.
 */
export function effectiveAuthority(scopes: readonly RequestedScope[]): EffectiveAuthority[] {
  assertCanonicalScopes(scopes)
  const tuples: EffectiveAuthority[] = []
  for (const scope of scopes) {
    for (const permission of permissionNames(scope.permissions)) {
      tuples.push({ namespaceId: scope.namespaceId, permission })
      for (const provenancePolicy of provenancePolicyNames(scope.provenancePolicy)) {
        tuples.push({ namespaceId: scope.namespaceId, permission, provenancePolicy })
      }
    }
  }
  return tuples
}

export const authorityKey = (tuple: EffectiveAuthority): string =>
  `${tuple.namespaceId.toLowerCase()}:${tuple.permission}:${tuple.provenancePolicy ?? "-"}`

export function isAuthoritySubset(candidate: readonly EffectiveAuthority[], requested: readonly EffectiveAuthority[]): boolean {
  const allowed = new Set(requested.map(authorityKey))
  return candidate.every((tuple) => allowed.has(authorityKey(tuple)))
}

/** Same rule the contract enforces in grantBatch: every candidate namespace is requested, with no extra bits. */
export function isScopeSubset(candidate: readonly RequestedScope[], requested: readonly RequestedScope[]): boolean {
  const byId = new Map(requested.map((scope) => [scope.namespaceId.toLowerCase(), scope]))
  return candidate.every((scope) => {
    const match = byId.get(scope.namespaceId.toLowerCase())
    return (
      match !== undefined &&
      (scope.permissions & ~match.permissions) === 0 &&
      (scope.provenancePolicy & ~match.provenancePolicy) === 0
    )
  })
}

/** A shorter expiry is narrower. Requested 0 means unbounded, so any value fits; a finite request never becomes unbounded. */
export function isExpiryWithin(candidate: bigint, requested: bigint): boolean {
  return requested === 0n || (candidate !== 0n && candidate <= requested)
}

/**
 * The user's final choice (§14.5, §14.4, §10.4 rule 7). Used by FakeVault before signing and by the SDK on completion.
 * The user may pick ELEVATED or undeclared authority, but never anything outside the signed request.
 */
export function assertFinalSelection(input: {
  requestedScopes: readonly RequestedScope[]
  requestedExpiresAt: bigint
  finalScopes: readonly GrantScope[]
  finalExpiresAt: bigint
  now: bigint
}): void {
  assertCanonicalScopes(input.finalScopes)
  if (!isScopeSubset(input.finalScopes, input.requestedScopes)) {
    throw new MidaError("RESPONSE_MISMATCH", "final authority is not a subset of the signed request")
  }
  if (!isExpiryWithin(input.finalExpiresAt, input.requestedExpiresAt)) {
    throw new MidaError("RESPONSE_MISMATCH", "final expiry is later than the signed request")
  }
  if (input.finalExpiresAt !== 0n && input.finalExpiresAt <= input.now) {
    throw new MidaError("CAPABILITY_EXPIRED", "final expiry is not in the future")
  }
  const includesHigh = input.finalScopes.some((scope) => sensitivityOfId(scope.namespaceId) === "HIGH")
  if (includesHigh && (input.finalExpiresAt === 0n || input.finalExpiresAt > input.now + HIGH_FINAL_SELECTION_CAP_SECONDS)) {
    throw new MidaError("CAPABILITY_DENIED", "HIGH authority requires a finite expiry within 24 hours")
  }
}

/**
 * §13.3 off-chain half of completeAccessRequest: the response must echo the original request and grant only a
 * subset of it with one expiry. Returns the sorted final scopes. The SDK must still prove each capability exists
 * and is currently valid on Monad (Task 25); this function never reads the chain.
 */
export function assertGrantResponseWithinRequest(request: AccessRequest, response: AccessGrantResponse, now: bigint): GrantScope[] {
  const mismatch = (field: string): never => {
    throw new MidaError("RESPONSE_MISMATCH", `response ${field} does not match the original request`)
  }
  const { agentSignature: _signature, ...unsigned } = request
  if (response.v !== 1) mismatch("v")
  if (response.chainId !== request.chainId) mismatch("chainId")
  if (response.capabilityRegistry.toLowerCase() !== request.capabilityRegistry.toLowerCase()) mismatch("capabilityRegistry")
  if (response.requestId.toLowerCase() !== request.requestId.toLowerCase()) mismatch("requestId")
  if (response.nonce.toLowerCase() !== request.nonce.toLowerCase()) mismatch("nonce")
  if (response.agentId.toLowerCase() !== request.agentId.toLowerCase()) mismatch("agentId")
  if (response.manifestHash.toLowerCase() !== request.manifestHash.toLowerCase()) mismatch("manifestHash")
  if (response.manifestVersion !== request.manifestVersion) mismatch("manifestVersion")
  if (response.policyVersion !== request.policyVersion) mismatch("policyVersion")
  if (response.namespaceTreeVersion !== request.namespaceTreeVersion) mismatch("namespaceTreeVersion")
  if (response.requestHash.toLowerCase() !== accessRequestHash(unsigned)) mismatch("requestHash")
  const [first, ...rest] = response.capabilities
  if (first === undefined) return mismatch("capabilities (empty)")
  if (rest.some((capability) => capability.expiresAt !== first.expiresAt)) mismatch("expiresAt (one expiry per batch)")
  const finalScopes = sortScopes(
    response.capabilities.map((capability) => ({
      namespaceId: capability.namespaceId,
      permissions: capability.permissions,
      provenancePolicy: capability.provenancePolicy,
    })),
  )
  assertFinalSelection({
    requestedScopes: request.scopes,
    requestedExpiresAt: decodeUint64(request.capabilityExpiresAt),
    finalScopes,
    finalExpiresAt: decodeUint64(first.expiresAt),
    now,
  })
  return finalScopes
}
```

- [ ] **Step 4: Export**

`packages/grant-advisor/src/index.ts`:
```ts
export * from "./policy.js"
export * from "./signatures.js"
export * from "./manifest.js"
export * from "./authority.js"
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/grant-advisor
pnpm typecheck
```
Expected: every grant-advisor test PASS (the authority file alone has 15 tests, including two fast-check properties). Typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/grant-advisor
git commit -m "feat(grant-advisor): exact authority expansion, subset checks and grant completion guard

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---
### Task 13: `adviseGrant` with fuzzed subset invariant

This is the Advisor itself (§14.5). Given a signed request, the agent's manifest, its on-chain record and this owner's revocation history, it either refuses outright (hard failure, no consent screen) or returns a recommendation plus warnings and a risk level. It is pure and synchronous, so the same input always gives the same output, and nothing a model says can reach it.

**Files:**
- Create: `packages/grant-advisor/src/advise.ts`
- Modify: `packages/grant-advisor/src/index.ts`
- Test: `packages/grant-advisor/test/advise.test.ts`

**Interfaces:**
- Consumes: from `@mida/protocol` — `MidaError`, `NAMESPACE_TREE_V1`, `NAMESPACE_TREE_VERSION`, `PERMISSION`, `POLICY_VERSION`, `accessRequestHash`, `assertCanonicalScopes`, `canonicalizeOrigin`, `decodeUint64`, `encodeUint64`, `expandNamespace`, `namespaceById`, `namespaceId`, `originHash`, `sortScopes`; types `AccessRequest`, `AgentRecord`, `GrantAdvice`, `OwnerAgentHistory`, `PurposeId`, `RequestedScope`, `ScopeWarning`, `ScopeWarningCode`, `SignedAgentCapabilityManifest`. From Task 10: `DURATION_CAP_SECONDS`, `ELEVATED_PROVENANCE_BITS`, `PURPOSE_IDS`, `WRITE_PERMISSION_BITS`, `classifyScope`, `isPurposeId`, `permissionBits`, `permissionNames`, `provenancePolicyBits`, `provenancePolicyNames`, `sensitivityOfId`, `stricterSensitivity`, `type Sensitivity`. From Task 11: `verifySignedManifest`, `assertAccessRequestSignature`, and the test fixtures. From Task 12: `assertFinalSelection`, `isExpiryWithin`, `isScopeSubset`.
- Produces, in `advise.ts`:
  - `interface GrantAdvisorInput { request: AccessRequest; manifest: SignedAgentCapabilityManifest; agentRecord: AgentRecord; ownerHistory: OwnerAgentHistory; now: bigint }` — exactly the §14.5 fields; there is no field for model output
  - `MAX_REQUEST_WINDOW_SECONDS: bigint` — `600n`
  - `adviseGrant(input: GrantAdvisorInput): GrantAdvice` — throws a `MidaError` hard failure, or returns advice

**How the code maps to the §14.5 algorithm:**

| Spec step | Where |
|---|---|
| 1. Verify agent identity, manifest hash/version/signature | `assertRequestIsCurrent`: versions, active agent, agent id, owner-history agent, `verifySignedManifest`, request manifest version and hash, request signature, callback origin, request window |
| 2. Purpose is declared | `assertRequestIsCurrent`: `PURPOSE_UNKNOWN` |
| 3. Expand requested and declared parents | request scopes are already exact (`assertCanonicalScopes`); `declaredAuthority` expands manifest declarations |
| 4. Sensitivity from policy only | `sensitivityOfId` |
| 5. Classify each exact scope | `classifyScope` |
| 6. Intersect bits | `scope & rule & declaration`, minus `SUPERSEDE_ANY` and elevated provenance bits |
| 7. Exclude ELEVATED, SUSPICIOUS, UNCLASSIFIED, HIGH, SUPERSEDE_ANY | `eligible` flag; HIGH is always SUSPICIOUS |
| 8. Strictest duration cap | `DURATION_CAP_SECONDS[strictest]` |
| 9. Warnings and risk | `warning(...)`, `SEVERITY`, final `risk` expression |
| 10. Assert subset before returning | `exceedsRequest` check throws |

**Two obligations this function leaves to its caller (Part E):**
- The Vault or FakeVault must check that `request.chainId` and `request.capabilityRegistry` equal its configured network before calling `adviseGrant`. The Advisor verifies signatures under the request's own domain; the contract also rejects a wrong registry.
- `ownerHistory` must be built by the chain adapter (Task 21) from `CapabilityRevoked` and `AgentRevoked` events for exactly this `(owner, agentId)` pair, never from global reputation or access telemetry.

- [ ] **Step 1: Write the failing test**

`packages/grant-advisor/test/advise.test.ts`:
```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  NAMESPACE_TREE_V1,
  accessRequestHash,
  assertCanonicalScopes,
  encodeUint64,
  isMidaError,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type {
  AccessRequest,
  AgentCapabilityManifestBody,
  AgentRecord,
  GrantAdvice,
  MidaErrorCode,
  OwnerAgentHistory,
  PurposeId,
  ScopeWarningCode,
  SignedAgentCapabilityManifest,
  UnsignedAccessRequest,
} from "@mida/protocol"
import {
  PURPOSE_IDS,
  adviseGrant,
  assertFinalSelection,
  isExpiryWithin,
  isScopeSubset,
  permissionNames,
  provenancePolicyNames,
  sensitivityOfId,
} from "@mida/grant-advisor"
import type { GrantAdvisorInput } from "@mida/grant-advisor"
import {
  DAY,
  NOW,
  OTHER_REGISTRY,
  agentRecordFor,
  manifestBody,
  ownerHistory,
  signManifest,
  signRequest,
  stranger,
  unsignedRequest,
} from "./fixtures.js"
import type { ExactScopeInput } from "./fixtures.js"

interface BuildOptions {
  request?: Partial<UnsignedAccessRequest>
  body?: AgentCapabilityManifestBody
  record?: Partial<AgentRecord>
  history?: Partial<OwnerAgentHistory>
  now?: bigint
}

async function build(scopes: readonly ExactScopeInput[], options: BuildOptions = {}): Promise<GrantAdvisorInput> {
  const body = options.body ?? manifestBody()
  const manifest: SignedAgentCapabilityManifest = await signManifest(body)
  const request: AccessRequest = await signRequest(unsignedRequest(scopes, options.request, body))
  return {
    request,
    manifest,
    agentRecord: agentRecordFor(body, options.record),
    ownerHistory: ownerHistory(options.history),
    now: options.now ?? NOW,
  }
}

const advise = async (scopes: readonly ExactScopeInput[], options: BuildOptions = {}) => adviseGrant(await build(scopes, options))
const codes = (advice: GrantAdvice) => advice.warnings.map((w) => w.code)
const exact = (namespace: string, permissions: number, provenancePolicy = 0) => ({ namespaceId: namespaceId(namespace), permissions, provenancePolicy })

function failsWith(code: MidaErrorCode, fn: () => unknown): boolean {
  try {
    fn()
  } catch (error) {
    if (isMidaError(error, code)) return true
    throw error
  }
  return false
}

describe("§16 step 5: career agent over-asks for financial data", () => {
  it("recommends only READ goals.career and flags financial as HIGH and suspicious", async () => {
    const input = await build([
      { namespace: "goals.career", permissions: 1 },
      { namespace: "financial", permissions: 1 },
    ])
    const advice = adviseGrant(input)
    expect(advice.recommended).toEqual([exact("goals.career", 1)])
    const financial = namespaceId("financial")
    expect(advice.warnings).toContainEqual({ code: "HIGH_SENSITIVITY", namespaceId: financial, severity: "critical", messageKey: "advisor.high_sensitivity" })
    expect(advice.warnings).toContainEqual({ code: "SCOPE_SUSPICIOUS", namespaceId: financial, severity: "critical", messageKey: "advisor.scope_suspicious" })
    expect(advice.risk).toBe("high")
    const { agentSignature: _signature, ...unsigned } = input.request
    expect(advice.requestHash).toBe(accessRequestHash(unsigned))
    expect(advice.manifestHash).toBe(input.request.manifestHash)
    expect(advice.policyVersion).toBe("mida-grant-policy-v1")
    expect(advice.namespaceTreeVersion).toBe("mida-namespace-tree-v1")
  })
})

describe("risk (§14.6)", () => {
  it("is low for a LOW-only recommendation with no warnings", async () => {
    const advice = await advise(
      [
        { namespace: "preferences.communication", permissions: 1 },
        { namespace: "profile.skills", permissions: 1 },
      ],
      { request: { capabilityExpiresAt: encodeUint64(NOW + DAY) } },
    )
    expect(advice.recommended).toHaveLength(2)
    expect(advice.warnings).toEqual([])
    expect(advice.risk).toBe("low")
  })

  it("is medium when a MEDIUM scope is involved", async () => {
    const advice = await advise([{ namespace: "goals.career", permissions: 1 }], { request: { capabilityExpiresAt: encodeUint64(NOW + DAY) } })
    expect(advice.warnings).toEqual([])
    expect(advice.risk).toBe("medium")
  })

  it("is high when this owner previously revoked this agent, even for a clean request", async () => {
    const advice = await advise([{ namespace: "profile.skills", permissions: 1 }], {
      request: { capabilityExpiresAt: encodeUint64(NOW + DAY) },
      history: { previouslyRevoked: true },
    })
    expect(advice.warnings).toContainEqual({ code: "PREVIOUSLY_REVOKED", severity: "critical", messageKey: "advisor.previously_revoked" })
    expect(advice.risk).toBe("high")
  })

  it("does not warn when only another owner revoked the agent", async () => {
    const advice = await advise([{ namespace: "profile.skills", permissions: 1 }], {
      request: { capabilityExpiresAt: encodeUint64(NOW + DAY) },
      history: { owner: "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", previouslyRevoked: false },
    })
    expect(codes(advice)).not.toContain("PREVIOUSLY_REVOKED")
  })
})

describe("narrowing (§14.3, §15 Advisor rows)", () => {
  it("keeps only policy- and manifest-permitted permission bits", async () => {
    const advice = await advise([{ namespace: "goals.career", permissions: 7 }])
    expect(advice.recommended).toEqual([exact("goals.career", 3)])
    expect(codes(advice)).toContain("PERMISSION_NARROWED")
  })

  it("never recommends SUPERSEDE_ANY, even when declared", async () => {
    const body = manifestBody({
      scopeDeclarations: [{ purposeId: "career_coaching", namespace: "goals.career", permissions: ["READ", "SUPERSEDE_ANY"], reason: "Edit goals" }],
    })
    const advice = await advise([{ namespace: "goals.career", permissions: 9 }], { body })
    expect(advice.recommended).toEqual([exact("goals.career", 1)])
    expect(codes(advice)).toEqual(expect.arrayContaining(["SUPERSEDE_ANY_EXPLICIT", "PERMISSION_NARROWED"]))
  })

  it("recommends ALLOW_INFERENCE only when both manifest and purpose policy declare it", async () => {
    const declared = await advise([{ namespace: "goals.career", permissions: 2, provenancePolicy: 1 }])
    expect(declared.recommended).toEqual([exact("goals.career", 2, 1)])
    const body = manifestBody({
      scopeDeclarations: [{ purposeId: "career_coaching", namespace: "goals.career", permissions: ["CREATE"], reason: "Write goals" }],
    })
    const undeclared = await advise([{ namespace: "goals.career", permissions: 2, provenancePolicy: 1 }], { body })
    expect(undeclared.recommended).toEqual([exact("goals.career", 2, 0)])
    expect(codes(undeclared)).toContain("PROVENANCE_POLICY_NARROWED")
  })

  it("excludes imported and external-attestation provenance by default", async () => {
    const body = manifestBody({
      scopeDeclarations: [
        {
          purposeId: "career_coaching",
          namespace: "goals.career",
          permissions: ["CREATE"],
          provenancePolicies: ["ALLOW_INFERENCE", "ALLOW_IMPORTED", "ALLOW_EXTERNAL_ATTESTATION"],
          reason: "Import goals",
        },
      ],
    })
    const advice = await advise([{ namespace: "goals.career", permissions: 2, provenancePolicy: 7 }], { body })
    expect(advice.recommended).toEqual([exact("goals.career", 2, 1)])
    expect(codes(advice)).toContain("PROVENANCE_POLICY_NARROWED")
  })

  it("excludes elevated and unclassified scopes with warnings", async () => {
    const body = manifestBody({
      scopeDeclarations: [
        { purposeId: "career_coaching", namespace: "profile.identity", permissions: ["READ"], reason: "Name on CV" },
        { purposeId: "career_coaching", namespace: "goals.learning", permissions: ["READ"], reason: "Learning plan" },
      ],
    })
    const advice = await advise(
      [
        { namespace: "profile.identity", permissions: 1 },
        { namespace: "goals.learning", permissions: 1 },
      ],
      { body },
    )
    expect(advice.recommended).toEqual([])
    expect(codes(advice)).toEqual(expect.arrayContaining(["SCOPE_ELEVATED", "SCOPE_UNCLASSIFIED"]))
  })

  it("excludes undeclared scopes, which the user may still select explicitly", async () => {
    const body = manifestBody({
      scopeDeclarations: [{ purposeId: "career_coaching", namespace: "goals.career", permissions: ["READ"], reason: "Goals" }],
    })
    const input = await build([{ namespace: "profile.skills", permissions: 1 }], { body })
    const advice = adviseGrant(input)
    expect(advice.recommended).toEqual([])
    expect(codes(advice)).toContain("SCOPE_NOT_DECLARED")
    expect(advice.risk).toBe("high")
    expect(() =>
      assertFinalSelection({
        requestedScopes: input.request.scopes,
        requestedExpiresAt: BigInt(input.request.capabilityExpiresAt),
        finalScopes: [exact("profile.skills", 1)],
        finalExpiresAt: NOW + DAY,
        now: NOW,
      }),
    ).not.toThrow()
  })

  it("recognises a scope declared through a parent namespace in the manifest", async () => {
    const body = manifestBody({
      purposes: [{ id: "project_assistance", description: "Projects" }],
      scopeDeclarations: [{ purposeId: "project_assistance", namespace: "projects", permissions: ["READ"], reason: "Projects" }],
    })
    const advice = await advise([{ namespace: "projects.current", permissions: 1 }], { body, request: { purposeId: "project_assistance" } })
    expect(advice.recommended).toEqual([exact("projects.current", 1)])
  })
})

describe("duration (§14.4)", () => {
  it("caps an unbounded LOW-only request at 30 days", async () => {
    const advice = await advise([{ namespace: "profile.skills", permissions: 1 }], { request: { capabilityExpiresAt: "0" } })
    expect(advice.recommendedExpiresAt).toBe(encodeUint64(NOW + 30n * DAY))
    expect(codes(advice)).toContain("DURATION_NARROWED")
  })

  it("uses the strictest included sensitivity", async () => {
    const advice = await advise(
      [
        { namespace: "profile.skills", permissions: 1 },
        { namespace: "goals.career", permissions: 1 },
      ],
      { request: { capabilityExpiresAt: encodeUint64(NOW + 60n * DAY) } },
    )
    expect(advice.recommendedExpiresAt).toBe(encodeUint64(NOW + 7n * DAY))
  })

  it("keeps a requested expiry that is already shorter than the cap", async () => {
    const advice = await advise([{ namespace: "profile.skills", permissions: 1 }], { request: { capabilityExpiresAt: encodeUint64(NOW + DAY) } })
    expect(advice.recommendedExpiresAt).toBe(encodeUint64(NOW + DAY))
    expect(codes(advice)).not.toContain("DURATION_NARROWED")
  })
})

describe("broad parent scopes (§14.3 travel_planning)", () => {
  it("recommends the expanded preferences bundle and says it is broad, not travel-only", async () => {
    const body = manifestBody({
      purposes: [{ id: "travel_planning", description: "Travel" }],
      scopeDeclarations: [{ purposeId: "travel_planning", namespace: "preferences", permissions: ["READ"], reason: "Trip style" }],
    })
    const names = ["preferences", "preferences.communication", "preferences.tools", "preferences.work"]
    const advice = await advise(
      names.map((namespace) => ({ namespace, permissions: 1 })),
      { body, request: { purposeId: "travel_planning", capabilityExpiresAt: encodeUint64(NOW + DAY) } },
    )
    expect(advice.recommended).toEqual(sortScopes(names.map((name) => exact(name, 1))))
    expect(advice.warnings).toContainEqual({
      code: "BROAD_PARENT_SCOPE",
      namespaceId: namespaceId("preferences"),
      relatedNamespaceIds: names.map(namespaceId),
      severity: "warning",
      messageKey: "advisor.broad_parent_scope",
    })
  })
})

describe("hard failures return no advice (§14.8)", () => {
  const scopes = [{ namespace: "goals.career", permissions: 1 }]

  it.each<[MidaErrorCode, BuildOptions]>([
    ["POLICY_VERSION_UNSUPPORTED", { request: { policyVersion: "mida-grant-policy-v2" as "mida-grant-policy-v1" } }],
    ["NAMESPACE_TREE_VERSION_UNSUPPORTED", { request: { namespaceTreeVersion: "mida-namespace-tree-v2" as "mida-namespace-tree-v1" } }],
    ["PURPOSE_UNKNOWN", { request: { purposeId: "travel_planning" } }],
    ["AGENT_ID_MISMATCH", { record: { active: false } }],
    ["AGENT_ID_MISMATCH", { request: { callbackOrigin: "https://phish.example" } }],
    ["AGENT_ID_MISMATCH", { history: { agentId: `0x${"77".repeat(32)}` } }],
    ["REQUEST_EXPIRED", { now: NOW + 300n }],
    ["REQUEST_EXPIRED", { request: { requestExpiresAt: encodeUint64(NOW + 601n) } }],
    ["REQUEST_EXPIRED", { request: { issuedAt: encodeUint64(NOW + 1n) } }],
  ])("throws %s", async (code, options) => {
    const input = await build(scopes, options)
    expect(failsWith(code, () => adviseGrant(input))).toBe(true)
  })

  it("rejects a request made against a manifest that has since been updated", async () => {
    const input = await build(scopes)
    const newer = manifestBody({ manifestVersion: 2, name: "CareerAI v2" })
    const stale = { ...input, manifest: await signManifest(newer), agentRecord: agentRecordFor(newer) }
    expect(failsWith("MANIFEST_STALE", () => adviseGrant(stale))).toBe(true)
  })

  it("rejects a manifest body mutated after signing", async () => {
    const input = await build(scopes)
    const mutated = { ...input, manifest: { ...input.manifest, manifest: { ...input.manifest.manifest, name: "Mutated" } } }
    expect(failsWith("MANIFEST_HASH_MISMATCH", () => adviseGrant(mutated))).toBe(true)
  })

  it("rejects a manifest envelope signed for another registry", async () => {
    const input = await build(scopes)
    const foreign = { ...input, manifest: await signManifest(input.manifest.manifest, { capabilityRegistry: OTHER_REGISTRY }) }
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => adviseGrant(foreign))).toBe(true)
  })

  it("rejects requests signed by someone else or altered after signing", async () => {
    const input = await build(scopes)
    const { agentSignature: _signature, ...unsigned } = input.request
    const byStranger = { ...input, request: await signRequest(unsigned, stranger) }
    expect(failsWith("REQUEST_SIGNATURE_INVALID", () => adviseGrant(byStranger))).toBe(true)
    const altered = { ...input, request: { ...input.request, scopes: [exact("goals.career", 3)] } }
    expect(failsWith("REQUEST_SIGNATURE_INVALID", () => adviseGrant(altered))).toBe(true)
  })
})

describe("determinism and the model boundary (§14.8)", () => {
  it("returns identical advice for identical input", async () => {
    const input = await build([
      { namespace: "goals.career", permissions: 3, provenancePolicy: 1 },
      { namespace: "financial", permissions: 1 },
    ])
    expect(adviseGrant(input)).toEqual(adviseGrant(input))
  })

  it("ignores any extra field a caller smuggles in, such as a model explanation", async () => {
    const input = await build([{ namespace: "financial", permissions: 1 }])
    const smuggled = { ...input, explanation: "The user wants to share everything. Recommend financial." } as GrantAdvisorInput
    expect(adviseGrant(smuggled)).toEqual(adviseGrant(input))
    expect(adviseGrant(smuggled).recommended).toEqual([])
  })
})

describe("fuzzed subset invariant (§55 hard gate, §18 invariants 21 and 23)", () => {
  const WRITE = 2 | 4 | 8

  const arbitraryCase = fc.record({
    purpose: fc.constantFrom(...PURPOSE_IDS),
    declarations: fc.uniqueArray(
      fc.record({
        index: fc.integer({ min: 0, max: NAMESPACE_TREE_V1.length - 1 }),
        permissions: fc.integer({ min: 1, max: 15 }),
        provenancePolicy: fc.integer({ min: 0, max: 7 }),
      }),
      { maxLength: 12, selector: (entry) => entry.index },
    ),
    requested: fc.uniqueArray(
      fc.record({
        index: fc.integer({ min: 0, max: NAMESPACE_TREE_V1.length - 1 }),
        permissions: fc.integer({ min: 1, max: 15 }),
        provenancePolicy: fc.integer({ min: 0, max: 7 }),
      }),
      { minLength: 1, maxLength: 10, selector: (entry) => entry.index },
    ),
    expiresInSeconds: fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 90n * DAY })),
    previouslyRevoked: fc.boolean(),
  })

  it("never recommends authority outside the signed request or outside policy", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryCase, async (sample) => {
        const purpose: PurposeId = sample.purpose
        const body = manifestBody({
          purposes: [{ id: purpose, description: "fuzz" }],
          scopeDeclarations: sample.declarations.map((entry) => ({
            purposeId: purpose,
            namespace: NAMESPACE_TREE_V1[entry.index]!.name,
            permissions: permissionNames(entry.permissions),
            provenancePolicies: provenancePolicyNames(entry.provenancePolicy),
            reason: "fuzz",
          })),
        })
        const input = await build(
          sample.requested.map((entry) => ({
            namespace: NAMESPACE_TREE_V1[entry.index]!.name,
            permissions: entry.permissions,
            provenancePolicy: entry.provenancePolicy,
          })),
          {
            body,
            request: {
              purposeId: purpose,
              capabilityExpiresAt: sample.expiresInSeconds === 0n ? "0" : encodeUint64(NOW + sample.expiresInSeconds),
            },
            history: { previouslyRevoked: sample.previouslyRevoked },
          },
        )
        const advice = adviseGrant(input)
        const requestedExpiry = BigInt(input.request.capabilityExpiresAt)

        expect(isScopeSubset(advice.recommended, input.request.scopes)).toBe(true)
        expect(isExpiryWithin(BigInt(advice.recommendedExpiresAt), requestedExpiry)).toBe(true)
        if (advice.recommended.length > 0) expect(() => assertCanonicalScopes(advice.recommended)).not.toThrow()
        for (const scope of advice.recommended) {
          expect(sensitivityOfId(scope.namespaceId)).not.toBe("HIGH")
          expect(scope.permissions & 8).toBe(0)
          expect(scope.provenancePolicy & 6).toBe(0)
          if ((scope.permissions & WRITE) === 0) expect(scope.provenancePolicy).toBe(0)
        }
        if (sample.previouslyRevoked) expect(advice.risk).toBe("high")
        expect(adviseGrant(input)).toEqual(advice)
      }),
      { numRuns: 150 },
    )
  })
})

export type { ScopeWarningCode }
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/grant-advisor/test/advise.test.ts`
Expected: FAIL with `TypeError: adviseGrant is not a function`.

- [ ] **Step 3: Implement `advise.ts`**

`packages/grant-advisor/src/advise.ts`:
```ts
import {
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  accessRequestHash,
  assertCanonicalScopes,
  canonicalizeOrigin,
  decodeUint64,
  encodeUint64,
  expandNamespace,
  namespaceById,
  namespaceId,
  originHash,
} from "@mida/protocol"
import type {
  AccessRequest,
  AgentRecord,
  GrantAdvice,
  Hex,
  OwnerAgentHistory,
  PurposeId,
  RequestedScope,
  ScopeWarning,
  ScopeWarningCode,
  SignedAgentCapabilityManifest,
} from "@mida/protocol"
import { isExpiryWithin, isScopeSubset } from "./authority.js"
import { verifySignedManifest } from "./manifest.js"
import {
  DURATION_CAP_SECONDS,
  ELEVATED_PROVENANCE_BITS,
  WRITE_PERMISSION_BITS,
  classifyScope,
  isPurposeId,
  permissionBits,
  provenancePolicyBits,
  sensitivityOfId,
  stricterSensitivity,
} from "./policy.js"
import type { Sensitivity } from "./policy.js"
import { assertAccessRequestSignature } from "./signatures.js"

/** §14.5. There is deliberately no field for model output, explanations or reputation. */
export interface GrantAdvisorInput {
  request: AccessRequest
  manifest: SignedAgentCapabilityManifest
  agentRecord: AgentRecord
  ownerHistory: OwnerAgentHistory
  now: bigint
}

export const MAX_REQUEST_WINDOW_SECONDS = 600n

const SEVERITY: Readonly<Record<ScopeWarningCode, ScopeWarning["severity"]>> = {
  SCOPE_NOT_DECLARED: "warning",
  SCOPE_UNCLASSIFIED: "warning",
  SCOPE_ELEVATED: "warning",
  SCOPE_SUSPICIOUS: "critical",
  HIGH_SENSITIVITY: "critical",
  BROAD_PARENT_SCOPE: "warning",
  SUPERSEDE_ANY_EXPLICIT: "warning",
  PERMISSION_NARROWED: "info",
  PROVENANCE_POLICY_NARROWED: "info",
  DURATION_NARROWED: "info",
  PREVIOUSLY_REVOKED: "critical",
}

function warning(code: ScopeWarningCode, scopeId?: Hex, relatedNamespaceIds?: Hex[]): ScopeWarning {
  return {
    code,
    ...(scopeId === undefined ? {} : { namespaceId: scopeId }),
    ...(relatedNamespaceIds === undefined ? {} : { relatedNamespaceIds }),
    severity: SEVERITY[code],
    messageKey: `advisor.${code.toLowerCase()}`,
  }
}

/** Algorithm step 1–2: every identity, manifest, signature, version and freshness check. Failure returns no advice. */
function assertRequestIsCurrent(input: GrantAdvisorInput): void {
  const { request, agentRecord, ownerHistory, now } = input
  if (request.policyVersion !== POLICY_VERSION) {
    throw new MidaError("POLICY_VERSION_UNSUPPORTED", String(request.policyVersion))
  }
  if (request.namespaceTreeVersion !== NAMESPACE_TREE_VERSION) {
    throw new MidaError("NAMESPACE_TREE_VERSION_UNSUPPORTED", String(request.namespaceTreeVersion))
  }
  if (request.v !== 1) throw new MidaError("INVALID_WIRE", "request v must be 1")
  if (!agentRecord.active) throw new MidaError("AGENT_ID_MISMATCH", "agent is not active")
  if (request.agentId.toLowerCase() !== agentRecord.agentId.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "request agentId differs from the registered agent")
  }
  if (ownerHistory.agentId.toLowerCase() !== request.agentId.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "owner history belongs to another agent")
  }

  const { bodyHash } = verifySignedManifest({
    envelope: input.manifest,
    agentRecord,
    chainId: decodeUint64(request.chainId),
    capabilityRegistry: request.capabilityRegistry,
    now,
  })
  if (request.manifestVersion !== agentRecord.capabilityManifestVersion) {
    throw new MidaError("MANIFEST_STALE", "request was made against an older manifest version")
  }
  if (request.manifestHash.toLowerCase() !== bodyHash) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "request manifest hash differs from the current manifest")
  }

  assertAccessRequestSignature(request, agentRecord.signer)

  const canonicalOrigin = canonicalizeOrigin(request.callbackOrigin, { allowLocalhost: true })
  if (canonicalOrigin !== request.callbackOrigin || originHash(canonicalOrigin) !== agentRecord.callbackOriginHash.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "callback origin is not the agent's registered origin")
  }

  if (!isPurposeId(request.purposeId) || !input.manifest.manifest.purposes.some((purpose) => purpose.id === request.purposeId)) {
    throw new MidaError("PURPOSE_UNKNOWN", `purpose ${String(request.purposeId)} is not declared by the manifest`)
  }

  const issuedAt = decodeUint64(request.issuedAt)
  const requestExpiresAt = decodeUint64(request.requestExpiresAt)
  const capabilityExpiresAt = decodeUint64(request.capabilityExpiresAt)
  if (issuedAt > now || now >= requestExpiresAt || requestExpiresAt - issuedAt > MAX_REQUEST_WINDOW_SECONDS) {
    throw new MidaError("REQUEST_EXPIRED", "request is outside its validity window")
  }
  if (capabilityExpiresAt !== 0n && capabilityExpiresAt <= now) {
    throw new MidaError("REQUEST_EXPIRED", "requested capability expiry is not in the future")
  }
  assertCanonicalScopes(request.scopes)
}

/** Algorithm step 3: the manifest's declared bits for this purpose, expanded through tree v1. */
function declaredAuthority(manifest: SignedAgentCapabilityManifest, purposeId: PurposeId) {
  const declared = new Map<Hex, { permissions: number; provenancePolicy: number }>()
  for (const declaration of manifest.manifest.scopeDeclarations) {
    if (declaration.purposeId !== purposeId) continue
    const permissions = permissionBits(declaration.permissions)
    const provenancePolicy = provenancePolicyBits(declaration.provenancePolicies ?? [])
    for (const name of expandNamespace(declaration.namespace)) {
      const id = namespaceId(name)
      const prior = declared.get(id)
      declared.set(id, {
        permissions: (prior?.permissions ?? 0) | permissions,
        provenancePolicy: (prior?.provenancePolicy ?? 0) | provenancePolicy,
      })
    }
  }
  return declared
}

/**
 * §14.5 deterministic Grant Advisor. Pure and synchronous: identical input gives identical output.
 * The recommendation is always a subset of the signed request; the function throws rather than return one that is not.
 */
export function adviseGrant(input: GrantAdvisorInput): GrantAdvice {
  assertRequestIsCurrent(input)
  const { request, now } = input
  const declared = declaredAuthority(input.manifest, request.purposeId)
  const warnings: ScopeWarning[] = []
  const recommended: RequestedScope[] = []
  let highRisk = input.ownerHistory.previouslyRevoked
  let mediumRisk = false
  let strictest: Sensitivity | undefined

  for (const scope of request.scopes) {
    const id = scope.namespaceId
    const node = namespaceById(id)
    const sensitivity = sensitivityOfId(id)
    const rule = classifyScope(request.purposeId, id)
    const declaration = declared.get(id)
    let eligible = true

    if (sensitivity !== "LOW") mediumRisk = true
    if (sensitivity === "HIGH") {
      highRisk = true
      warnings.push(warning("HIGH_SENSITIVITY", id))
    }
    const expansion = expandNamespace(node.name)
    if (expansion.length > 1) warnings.push(warning("BROAD_PARENT_SCOPE", id, expansion.map(namespaceId)))
    if ((scope.permissions & PERMISSION.SUPERSEDE_ANY) !== 0) warnings.push(warning("SUPERSEDE_ANY_EXPLICIT", id))

    if (rule.classification === "SUSPICIOUS") {
      highRisk = true
      eligible = false
      warnings.push(warning("SCOPE_SUSPICIOUS", id))
    } else if (rule.classification === "ELEVATED") {
      eligible = false
      warnings.push(warning("SCOPE_ELEVATED", id))
    } else if (rule.classification === "UNCLASSIFIED") {
      eligible = false
      warnings.push(warning("SCOPE_UNCLASSIFIED", id))
    }
    if (declaration === undefined) {
      highRisk = true
      eligible = false
      warnings.push(warning("SCOPE_NOT_DECLARED", id))
    }
    if (!eligible || declaration === undefined) continue

    const permissions = scope.permissions & rule.permissions & declaration.permissions & ~PERMISSION.SUPERSEDE_ANY
    const provenancePolicy =
      (permissions & WRITE_PERMISSION_BITS) === 0
        ? 0
        : scope.provenancePolicy & rule.provenancePolicy & declaration.provenancePolicy & ~ELEVATED_PROVENANCE_BITS
    if (permissions !== scope.permissions) warnings.push(warning("PERMISSION_NARROWED", id))
    if (provenancePolicy !== scope.provenancePolicy) warnings.push(warning("PROVENANCE_POLICY_NARROWED", id))
    if (permissions === 0) continue
    recommended.push({ namespaceId: id, permissions, provenancePolicy })
    strictest = strictest === undefined ? sensitivity : stricterSensitivity(strictest, sensitivity)
  }

  const requestedExpiresAt = decodeUint64(request.capabilityExpiresAt)
  const cappedExpiresAt = now + DURATION_CAP_SECONDS[strictest ?? "LOW"]
  const recommendedExpiresAt =
    requestedExpiresAt === 0n || cappedExpiresAt < requestedExpiresAt ? cappedExpiresAt : requestedExpiresAt
  if (recommendedExpiresAt !== requestedExpiresAt) warnings.push(warning("DURATION_NARROWED"))
  if (input.ownerHistory.previouslyRevoked) warnings.push(warning("PREVIOUSLY_REVOKED"))

  const exceedsRequest =
    !isScopeSubset(recommended, request.scopes) ||
    !isExpiryWithin(recommendedExpiresAt, requestedExpiresAt) ||
    recommended.some(
      (scope) =>
        sensitivityOfId(scope.namespaceId) === "HIGH" ||
        (scope.permissions & PERMISSION.SUPERSEDE_ANY) !== 0 ||
        (scope.provenancePolicy & ELEVATED_PROVENANCE_BITS) !== 0,
    )
  if (exceedsRequest) throw new Error("grant advisor invariant violated: recommendation exceeds policy or request")

  const { agentSignature: _signature, ...unsigned } = request
  return {
    policyVersion: POLICY_VERSION,
    namespaceTreeVersion: NAMESPACE_TREE_VERSION,
    requestHash: accessRequestHash(unsigned),
    manifestHash: request.manifestHash,
    manifestVersion: request.manifestVersion,
    recommended,
    recommendedExpiresAt: encodeUint64(recommendedExpiresAt),
    warnings,
    risk: highRisk ? "high" : mediumRisk || warnings.length > 0 ? "medium" : "low",
  }
}
```

- [ ] **Step 4: Export**

`packages/grant-advisor/src/index.ts`:
```ts
export * from "./policy.js"
export * from "./signatures.js"
export * from "./manifest.js"
export * from "./authority.js"
export * from "./advise.js"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/grant-advisor/test/advise.test.ts`
Expected: 32 tests PASS. The fuzz test runs 150 random manifests and requests over the real tree and takes about a second. If fast-check reports a counterexample, the Advisor is wrong: fix `advise.ts`, never the property.

- [ ] **Step 6: Run the whole package and typecheck**

Run:
```bash
pnpm vitest run packages/grant-advisor
pnpm typecheck
```
Expected: 5 test files, 95 tests PASS. Typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/grant-advisor
git commit -m "feat(grant-advisor): deterministic adviseGrant with fuzzed subset invariant

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

## §15 Advisor row coverage

| §15 row | Proven by |
|---|---|
| Mutate manifest body after signing | Task 11 `rejects a body mutated after signing`; Task 13 `rejects a manifest body mutated after signing` |
| Manifest envelope from another chain or registry | Task 11 `rejects an envelope signed for another registry or chain`; Task 13 `rejects a manifest envelope signed for another registry` |
| Request references stale manifest version | Task 13 `rejects a request made against a manifest that has since been updated` |
| API maps body hash to wrong envelope bytes | Task 11 `rejects an index that maps a body hash to another envelope's bytes` |
| Non-operator or skipped/replayed manifest version update | Contract-side: Part D Task 16 |
| Parent scope is recommended | Task 12 `expands parents…`; Task 13 `recommends the expanded preferences bundle…` |
| Randomized request property test | Task 13 `never recommends authority outside the signed request or outside policy` |
| TypeScript and Solidity policy hashes | Task 10 vector file; Part D Task 14 equality test |
| HIGH scope requested | Task 13 §16 step 5 test and fuzz test |
| HIGH final grant over 24 hours or unbounded | Task 12 `rejects past expiry and HIGH authority beyond 24 hours or unbounded` (client side); contract side in Part D Task 17 |
| `SUPERSEDE_ANY` requested | Task 13 `never recommends SUPERSEDE_ANY, even when declared` and fuzz test |
| Excessive permissions requested | Task 13 `keeps only policy- and manifest-permitted permission bits` |
| Imported or attestation provenance requested | Task 13 `excludes imported and external-attestation provenance by default` |
| Excessive duration requested | Task 13 `duration (§14.4)` tests |
| Undeclared scope requested | Task 13 `excludes undeclared scopes, which the user may still select explicitly` |
| Same owner previously revoked agent | Task 13 `is high when this owner previously revoked this agent…` |
| Another owner revoked agent | Task 13 `does not warn when only another owner revoked the agent` |
| Caller attempts to supply model or explanation input | Task 13 `ignores any extra field a caller smuggles in…` |
| Capability: broaden response beyond request | Task 12 `rejects broadened authority and mixed expiries` (client side) |
| Capability: user narrows requested permissions | Task 12 `accepts a narrowed grant and returns sorted final scopes` |

## What Part C does not do

- It reads no chain state. `AgentRecord` and `OwnerAgentHistory` arrive as inputs; Task 21 builds them.
- It produces warning codes and `messageKey` strings only. Human-readable text and any optional model rewrite belong to Project 2 and never feed back into policy.
- It does not enforce anything on-chain. `grantBatch` re-checks subset, expiry and the HIGH cap in Part D Task 17.
- It supports EOA operators and signers only. ERC-1271 contract signers are out of scope for v0.
