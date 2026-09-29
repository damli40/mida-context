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

  it("a refused write raises PERMISSION_NARROWED alone — the provenance collapse is the same cause (in-32 X-3)", async () => {
    // goals.career declared READ-only with ALLOW_INFERENCE; asking READ|CREATE + inference loses
    // the write bit, which forces provenancePolicy to 0 as a CONSEQUENCE — one cause, one warning.
    const body = manifestBody({
      scopeDeclarations: [
        { purposeId: "career_coaching", namespace: "goals.career", permissions: ["READ"], provenancePolicies: ["ALLOW_INFERENCE"], reason: "Read goals" },
      ],
    })
    const advice = await advise([{ namespace: "goals.career", permissions: 3, provenancePolicy: 1 }], { body })
    expect(advice.recommended).toEqual([exact("goals.career", 1)])
    expect(codes(advice)).toContain("PERMISSION_NARROWED")
    expect(codes(advice)).not.toContain("PROVENANCE_POLICY_NARROWED")
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
