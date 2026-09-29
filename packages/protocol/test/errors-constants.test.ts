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
  isAcceptableAgentName,
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
    expect(UNACCEPTABLE_REQUEST_CHARS.test("می‌خواهم")).toBe(false)
    expect(UNACCEPTABLE_REQUEST_CHARS.test("👨‍💻 helper")).toBe(false)
  })

  it("displaySafeText folds each refused character to a single space — for fields that are shown, not refused", () => {
    const dirty = `line one${chr(0x0a)}line two${chr(0x2028)}${chr(0x2029)}${chr(0x200b)}bidi${chr(0x202a)}${chr(0x2067)}${chr(0xfeff)}`
    expect(displaySafeText(dirty)).toBe("line one line two   bidi   ")
  })
})

/**
 * The one agent-name rule, shared by the manifest validator, the owner-link parser and /me —
 * an ALLOW-LIST, not a deny-list (in-34): letters in any script, combining marks, numbers,
 * space, dot, underscore, hyphen and the two joiners — the first character a letter, mark or
 * number. Every quote shape (including the fifteen look-alikes in-32's ban list missed),
 * every bracket, colon, apostrophe, symbol, control and format character is refused simply
 * by not being listed — the in-33 probe's U+05F4 shape can no longer slip through.
 */
describe("isAcceptableAgentName (in-34: allow-list)", () => {
  // fromCodePoint, not fromCharCode — the tag characters live above the BMP.
  const chr = (cp: number) => String.fromCodePoint(cp)

  it("accepts the names real agents carry — hyphenated ids, spaced names, dots, underscores, CJK", () => {
    for (const name of ["claude-code", "codex", "claude-desktop", "Claude Code", "agent v2.1_beta", "中文字符"]) {
      expect(isAcceptableAgentName(name), name).toBe(true)
    }
  })

  it("accepts the joiners and combining marks — Persian ZWNJ spelling, Indic marks (in-31 V-3)", () => {
    // می‌خواهم is می + ZWNJ (200C) + خواهم — the non-joiner is ordinary Persian spelling —
    // and हिन्दी needs Devanagari's combining marks (ि Mc, ् Mn, ी Mc). Both stay legal.
    expect(isAcceptableAgentName("می‌خواهم")).toBe(true)
    expect(isAcceptableAgentName("हिन्दी एजेंट")).toBe(true)
  })

  it.each([
    ["control", chr(0x0a)],
    ["DEL", chr(0x7f)],
    ["line separator", chr(0x2028)],
    ["paragraph separator", chr(0x2029)],
    ["bidi control — Arabic letter mark", chr(0x061c)],
    ["bidi control — embedding", chr(0x202a)],
    ["zero-width space", chr(0x200b)],
    ["left-to-right mark", chr(0x200e)],
    ["right-to-left mark", chr(0x200f)],
    ["invisible operator — word joiner", chr(0x2060)],
    ["invisible operator — invisible plus", chr(0x2064)],
    ["byte order mark", chr(0xfeff)],
    ["tag character", chr(0xe0020)],
    ["straight double quote", chr(0x22)],
    ["straight single quote / apostrophe", chr(0x27)],
    ["look-alike quote U+201C", chr(0x201c)],
    ["look-alike quote U+201D", chr(0x201d)],
    ["look-alike quote U+201E", chr(0x201e)],
    ["look-alike quote U+201F", chr(0x201f)],
    ["look-alike quote U+2033", chr(0x2033)],
    ["look-alike quote U+2036", chr(0x2036)],
    ["look-alike quote U+FF02", chr(0xff02)],
    ["look-alike quote U+301D", chr(0x301d)],
    ["look-alike quote U+301E", chr(0x301e)],
    ["look-alike quote U+301F", chr(0x301f)],
    // The double-quote look-alikes in-32's ban list missed and in-33's probe found. Under an
    // allow-list they need no entries of their own — they stay pinned anyway. Two of the
    // fifteen, U+02BA and U+02EE, are \p{Lm} letters, so the letter class honestly admits
    // them — they are modifier letters, not punctuation, and cannot close a quote run.
    ["Hebrew gershayim U+05F4", chr(0x05f4)],
    ["double acute U+02DD", chr(0x02dd)],
    ["modifier middle double acute U+02F5", chr(0x02f5)],
    ["modifier middle double grave U+02F6", chr(0x02f6)],
    ["Vedic sign U+1CD3", chr(0x1cd3)],
    ["heavy double comma ornament U+275D", chr(0x275d)],
    ["heavy double ornament U+275E", chr(0x275e)],
    ["heavy low comma ornament U+275F", chr(0x275f)],
    ["heavy low ornament U+2760", chr(0x2760)],
    ["double low-reversed-9 U+2E42", chr(0x2e42)],
    ["sans-serif double quote U+1F676", chr(0x1f676)],
    ["sans-serif heavy double quote U+1F677", chr(0x1f677)],
    ["sans-serif low double quote U+1F678", chr(0x1f678)],
  ])("refuses a name carrying %s", (_label, char) => {
    expect(isAcceptableAgentName(`a${char}b`)).toBe(false)
  })

  it("refuses the review's attack names — colons, brackets and quote look-alikes alike (in-34)", () => {
    for (const name of [
      "x״ Advisor", // U+05F4 — the shape in-32's deny-list missed
      "Advisor: low risk.",
      `x" (run by`,
      "a)b",
      "a(b",
      "a[b",
      "a'b",
    ]) {
      expect(isAcceptableAgentName(name), name).toBe(false)
    }
  })

  it("refuses symbols the deny-list used to accept — emoji, check marks, dashes beyond the hyphen (in-34)", () => {
    // 👨‍💻 helper passed the deny-list because no emoji was banned; an emoji is a symbol,
    // not a letter or mark, so the allow-list refuses it. Same for the em dash and ✓.
    expect(isAcceptableAgentName("👨‍💻 helper")).toBe(false)
    expect(isAcceptableAgentName("claude — agent")).toBe(false)
    expect(isAcceptableAgentName("agent ✓")).toBe(false)
  })

  it("refuses a name that is nothing but whitespace and joiners — it would render as `Agent \"\"`", () => {
    expect(isAcceptableAgentName("  \t ")).toBe(false)
    expect(isAcceptableAgentName(" ‌‍")).toBe(false)
    // A name cannot open with a space or a joiner either — the first character is a letter,
    // mark or number.
    expect(isAcceptableAgentName(" codex")).toBe(false)
    expect(isAcceptableAgentName("‌codex")).toBe(false)
  })

  it("refuses the rest of the format characters too — an invisible-only name cannot be built (in-33)", () => {
    // \p{Cf} minus the joiners: the soft hyphen, the Mongolian vowel separator, the Arabic
    // number signs, the deprecated formatters, the interlinear marks and the above-BMP format
    // controls all render as nothing inside `Agent "…"`.
    for (const cp of [0x00ad, 0x180e, 0x0600, 0x06dd, 0x070f, 0x08e2, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x110bd, 0x13430, 0x1bca0, 0x1d173, 0xe0001]) {
      expect(isAcceptableAgentName(`a${chr(cp)}b`), `U+${cp.toString(16)} inside a name`).toBe(false)
      expect(isAcceptableAgentName(chr(cp)), `U+${cp.toString(16)} as the whole name`).toBe(false)
    }
    // The carve-out: the joiners stay legal inside a name — Persian spelling and Indic
    // conjuncts depend on them (in-31 V-3).
    expect(isAcceptableAgentName("می‌خواهم")).toBe(true)
    expect(isAcceptableAgentName("क्‍षकार")).toBe(true)
  })
})
