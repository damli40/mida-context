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
  UNACCEPTABLE_REQUEST_CHARS,
  displaySafeText,
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

/**
 * The refused set the owner pages enforce (in-30 T-3): not just the C0 controls and DEL — every
 * class that can forge a rendered line or hide inside one. Control characters, the Unicode line
 * and paragraph separators, zero-width marks, the bidirectional controls and the BOM.
 */
describe("UNACCEPTABLE_REQUEST_CHARS (in-30 T-3)", () => {
  const chr = (cp: number) => String.fromCharCode(cp)

  it.each([
    ["C0 control", chr(0x0a)],
    ["DEL", chr(0x7f)],
    ["C1 control", chr(0x85)],
    ["line separator", chr(0x2028)],
    ["paragraph separator", chr(0x2029)],
    ["zero-width space", chr(0x200b)],
    ["left-to-right mark", chr(0x200e)],
    ["right-to-left mark", chr(0x200f)],
    ["bidi embedding", chr(0x202a)],
    ["bidi isolate", chr(0x2067)],
    ["byte order mark", chr(0xfeff)],
  ])("refuses %s", (_label, char) => {
    expect(UNACCEPTABLE_REQUEST_CHARS.test(`a${char}b`)).toBe(true)
  })

  it("still accepts ordinary text — plain words, dashes, emoji and CJK", () => {
    expect(UNACCEPTABLE_REQUEST_CHARS.test("claude-code — plain text 中文字符 ✓")).toBe(false)
  })

  it("accepts the joiners — a ZWNJ inside a Persian name, a ZWJ inside an emoji sequence (in-31 V-3)", () => {
    // می‌خواهم is می + ZWNJ (200C) + خواهم — the non-joiner is ordinary Persian spelling.
    // 👨‍💻 is held together by a ZWJ (200D). Neither forges a line nor hides inside one.
    expect(UNACCEPTABLE_REQUEST_CHARS.test("می\u200cخواهم")).toBe(false)
    expect(UNACCEPTABLE_REQUEST_CHARS.test("👨\u200d💻 helper")).toBe(false)
  })

  it("displaySafeText folds each refused character to a single space — for fields that are shown, not refused", () => {
    const dirty = `line one${chr(0x0a)}line two${chr(0x2028)}${chr(0x2029)}${chr(0x200b)}bidi${chr(0x202a)}${chr(0x2067)}${chr(0xfeff)}`
    expect(displaySafeText(dirty)).toBe("line one line two   bidi   ")
  })
})
