import { describe, expect, it } from "vitest"
import {
  CONTEXT_KIND,
  CRYPTO_VERSION,
  KNOWN_PERMISSION_BITS,
  KNOWN_PROVENANCE_BITS,
  LINEAGE_POLICY,
  MAX_PAYLOAD_BYTES,
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_RELATION_CODE,
  RECORD_TYPE,
  isMidaError,
} from "@mida/protocol"

describe("MidaError", () => {
  it("carries a typed code and is detectable", () => {
    const error = new MidaError("STALE_PARENT", "lineage advanced")
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("STALE_PARENT")
    expect(error.message).toBe("STALE_PARENT: lineage advanced")
    expect(isMidaError(error)).toBe(true)
    expect(isMidaError(error, "STALE_PARENT")).toBe(true)
    expect(isMidaError(error, "CAPABILITY_DENIED")).toBe(false)
    expect(isMidaError(new Error("x"))).toBe(false)
  })
})

describe("protocol constants (§10.2, §11.2, §11.8)", () => {
  it("fixes permission and provenance bits", () => {
    expect(PERMISSION).toEqual({ READ: 1, CREATE: 2, SUPERSEDE_OWN: 4, SUPERSEDE_ANY: 8 })
    expect(PROVENANCE_POLICY).toEqual({ ALLOW_INFERENCE: 1, ALLOW_IMPORTED: 2, ALLOW_EXTERNAL_ATTESTATION: 4 })
    expect(KNOWN_PERMISSION_BITS).toBe(15)
    expect(KNOWN_PROVENANCE_BITS).toBe(7)
  })

  it("fixes enum ordinals that Solidity must mirror", () => {
    expect(RECORD_TYPE).toEqual({ CONTEXT: 0, EVIDENCE: 1 })
    expect(LINEAGE_POLICY).toEqual({ STANDARD: 0, OWNER_CONTROLLED: 1 })
    expect(CONTEXT_KIND).toEqual({
      NONE: 0, FACT: 1, PREFERENCE: 2, GOAL: 3, DECISION: 4,
      EPISODE: 5, INFERENCE: 6, CREDENTIAL: 7, OPEN_LOOP: 8,
    })
    expect(PROVENANCE_SOURCE).toEqual({
      NONE: 0, USER_ASSERTED: 1, USER_CONFIRMED: 2, AGENT_INFERRED: 3,
      IMPORTED: 4, EXTERNAL_ATTESTATION: 5,
    })
    expect(RECORD_RELATION_CODE).toEqual({ supports: 1, derived_from: 2, confirmed_from: 3 })
  })

  it("fixes version strings and payload cap", () => {
    expect(POLICY_VERSION).toBe("mida-grant-policy-v1")
    expect(NAMESPACE_TREE_VERSION).toBe("mida-namespace-tree-v1")
    expect(CRYPTO_VERSION).toBe("mida-crypto-v1")
    expect(MAX_PAYLOAD_BYTES).toBe(65_536)
  })
})
