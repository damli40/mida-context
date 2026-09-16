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

  it("never lets an out-of-range bit value pass a subset check", () => {
    const requested = [exact("goals.career", 15, 7)]
    const widePermissions = { ...exact("goals.career", 1), permissions: 2 ** 32 + 1 }
    const wideProvenance = { ...exact("goals.career", 1), provenancePolicy: 2 ** 32 }
    expect(isScopeSubset([widePermissions], requested)).toBe(false)
    expect(isScopeSubset([wideProvenance], requested)).toBe(false)
    expect(isScopeSubset([exact("goals.career", 1)], [widePermissions])).toBe(false)
    expect(failsWith("INVALID_WIRE", () => expandScopeInputs([{ namespace: "goals", permissions: 2 ** 32 + 1 }]))).toBe(true)
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
