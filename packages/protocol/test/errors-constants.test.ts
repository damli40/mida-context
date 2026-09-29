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
  displaySafeBlock,
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
    // A Persian ZWNJ (200C) name and an emoji held together by a ZWJ (200D) — the
    // non-joiner is ordinary Persian spelling. Neither forges a line nor hides inside one.
    expect(UNACCEPTABLE_REQUEST_CHARS.test("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(false)
    expect(UNACCEPTABLE_REQUEST_CHARS.test("👨\u200d💻 helper")).toBe(false)
  })

  it("displaySafeText folds each refused character to a single space — for fields that are shown, not refused", () => {
    const dirty = `line one${chr(0x0a)}line two${chr(0x2028)}${chr(0x2029)}${chr(0x200b)}bidi${chr(0x202a)}${chr(0x2067)}${chr(0xfeff)}`
    expect(displaySafeText(dirty)).toBe("line one line two   bidi   ")
  })

  it("displaySafeBlock keeps real line breaks but folds every other refused character — for text shown whole (in-40 L-4)", () => {
    // ESC opens an erase-screen sequence, 202E reverses the line's text order, 2028/2029 are
    // Unicode's hidden line separators, 200B hides inside a word — none may reach the terminal.
    const dirty = `first line${chr(0x1b)}[2J\nsecond${chr(0x202e)}line${chr(0x200b)}\tindented${chr(0x2028)}third${chr(0x2029)}done`
    expect(displaySafeBlock(dirty)).toBe("first line [2J\nsecond line \tindented\nthird\ndone")
  })

  it("displaySafeBlock collapses and trims nothing — and keeps the two joiners (in-40 L-4)", () => {
    const text = `  padded\u200cword\u200dend  \n\n`
    expect(displaySafeBlock(text)).toBe(text)
  })
})

/**
 * The one agent-name rule, shared by the manifest validator, the owner-link parser and /me —
 * an ALLOW-LIST, not a deny-list (in-34; tightened in-37): letters in any script, combining
 * marks, numbers, space, dot, underscore, hyphen and the two joiners — the first character
 * now a letter or number, never a combining mark, which would strike the page's own quote.
 * in-37 also refuses by name the eight letter-class look-alikes that imitate the `"` or the
 * `:`, and five or more combining marks in a row as a Zalgo stack. Every other quote shape
 * (including the fifteen look-alikes in-32's ban list missed), every bracket, colon,
 * apostrophe, symbol, control and format character is refused simply by not being listed —
 * the in-33 probe's U+05F4 shape can no longer slip through.
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
    // A Persian name whose ZWNJ (200C) is ordinary spelling — and a Devanagari name that
    // needs its combining marks (U+093F Mc, U+094D Mn, U+0940 Mc). Both stay legal.
    expect(isAcceptableAgentName("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(true)
    expect(isAcceptableAgentName("\u0939\u093f\u0928\u094d\u0926\u0940 \u090f\u091c\u0947\u0902\u091f")).toBe(true)
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
    // fifteen, U+02BA and U+02EE, are \p{Lm} letters the letter class alone would admit —
    // in-37 refuses them by name, with six more, in the tests below.
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
      "x\u05f4 Advisor", // U+05F4 — the shape in-32's deny-list missed
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
    // The emoji name passed the deny-list because no emoji was banned; an emoji is a symbol,
    // not a letter or mark, so the allow-list refuses it. Same for the em dash and ✓.
    expect(isAcceptableAgentName("👨\u200d💻 helper")).toBe(false)
    expect(isAcceptableAgentName("claude — agent")).toBe(false)
    expect(isAcceptableAgentName("agent ✓")).toBe(false)
  })

  it("refuses a name that is nothing but whitespace and joiners — it would render as `Agent \"\"`", () => {
    expect(isAcceptableAgentName("  \t ")).toBe(false)
    expect(isAcceptableAgentName(" \u200c\u200d")).toBe(false)
    // A name cannot open with a space or a joiner either — the first character is a letter,
    // mark or number.
    expect(isAcceptableAgentName(" codex")).toBe(false)
    expect(isAcceptableAgentName("\u200ccodex")).toBe(false)
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
    expect(isAcceptableAgentName("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(true)
    expect(isAcceptableAgentName("\u0915\u094d\u200d\u0937\u0915\u093e\u0930")).toBe(true)
  })

  it("refuses a first character that is a combining mark — it would strike the page's own quote (in-37)", () => {
    // U+0336 on the `"` of `Agent "…"` draws the strike through the quote itself; under
    // in-34's rule a mark could open a name. A space or a joiner still refuses too.
    expect(isAcceptableAgentName("\u0336codex")).toBe(false)
    expect(isAcceptableAgentName(" claude-code")).toBe(false)
  })

  it("refuses the review's forged name — the verdict planted inside the Agent line (in-37)", () => {
    // Review 3.2: the look-alikes a character class cannot exclude — U+02BA imitates
    // the `"` inside the summary's `Agent "…"` frame and U+A4FD reads as a colon.
    expect(isAcceptableAgentName("Claude Code\u02ba Advisor\ua4fd low risk. Agent \u02baClaude Code")).toBe(false)
  })

  it("refuses each of the eight letter-class look-alikes the class cannot exclude (in-37)", () => {
    // U+02B9, U+02BA, U+02D0, U+02D1 and U+02EE are raised ticks; U+0374 is the Greek
    // numeral sign; U+A4FA and U+A4FD are the Lisu letters that read as a colon. All are
    // \p{L} letters, so only a named list catches them — anywhere in the name.
    for (const cp of [0x02b9, 0x02ba, 0x02d0, 0x02d1, 0x02ee, 0x0374, 0xa4fa, 0xa4fd]) {
      expect(isAcceptableAgentName(`a${chr(cp)}b`), `U+${cp.toString(16)} inside`).toBe(false)
      expect(isAcceptableAgentName(`${chr(cp)}a`), `U+${cp.toString(16)} first`).toBe(false)
    }
    // The five apostrophe-like letters the review kept on purpose still pass.
    for (const cp of [0x02bb, 0x02bc, 0x02bd, 0x02c8, 0xa78c]) {
      expect(isAcceptableAgentName(`a${chr(cp)}b`), `U+${cp.toString(16)} kept`).toBe(true)
    }
  })

  it("refuses five or more combining marks in a row — a Zalgo stack paints over the lines above (in-37)", () => {
    // A browser piles a combining-mark run vertically without a limit; review 3.1 pins
    // five as the refusal and keeps four legal — real scripts stack at most three.
    expect(isAcceptableAgentName("a" + "\u030d".repeat(5))).toBe(false)
    expect(isAcceptableAgentName("a" + "\u030d".repeat(4))).toBe(true)
  })

  it("keeps every name the review's probe G showed is legitimate (in-37)", () => {
    // Letters, marks and digits in any script — none of the in-37 tightenings touches a
    // real name: no leading mark, no five-mark run, none of the eight look-alike letters.
    for (const name of [
      "claude-code",
      "Claude Code",
      "gpt-4o",
      "Nguy\u1ec5n Bot",
      "Hawai\u02bbi helper",
      "\u65e5\u672c\u8a9e\u30fc", // Japanese, with the ー long-vowel mark the probe kept
      "\u0915\u094d\u200d\u0937\u0915\u093e\u0930", // the Indic conjunct ZWJ name
      "\u0939\u093f\u0928\u094d\u0926\u0940 \u090f\u091c\u0947\u0902\u091f", // Devanagari
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", // Persian ZWNJ
      "\u0f56\u0f66\u0f92\u0fb2\u0f74\u0f56\u0f66", // Tibetan, three stacked marks
      "\u05e2\u05b4\u05d1\u05b0\u05e8\u05b4\u05d9\u05ea", // Hebrew
      "\u0e44\u0e17\u0e22", // Thai
      "\u0645\u064f\u062d\u064e\u0645\u064e\u0651\u062f", // Arabic with vowel marks
      "\ua4e1\ua4f2\ua4e2\ua4f4", // the Lisu name the probe kept
    ]) {
      expect(isAcceptableAgentName(name), name).toBe(true)
    }
  })
})
