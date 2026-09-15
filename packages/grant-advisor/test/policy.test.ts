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
