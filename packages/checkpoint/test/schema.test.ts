import { describe, expect, it } from "vitest"
import * as schema from "../src/index.js"
import { repointEvidence, validateCheckpoint } from "../src/index.js"

// UF-K: every string cut goes through cutText — a plain slice can end on the first half of a
// surrogate pair and store a broken emoji.
describe("cutText", () => {
  const { cutText } = schema
  it("returns the text unchanged at or under max", () => {
    expect(cutText("hello", 5)).toBe("hello")
    expect(cutText("hi", 5)).toBe("hi")
    expect(cutText("x".repeat(2000), 2000)).toBe("x".repeat(2000))
  })
  it("cuts over-long text to max characters ending in the ellipsis", () => {
    const cut = cutText("x".repeat(2100), 2000)
    expect(cut).toBe("x".repeat(1999) + "…")
    expect(cut.length).toBe(2000)
  })
  it("never leaves a lone surrogate half at the cut — the emoji stays whole", () => {
    // the cut point lands between the two halves of the emoji: the head may not end
    // on a high surrogate
    const cut = cutText(`abc${"😀"}` + "z".repeat(2100), 5)
    const head = cut.slice(0, -1)
    expect(head).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut).toBe("abc…")
    // and a pair wholly inside the budget survives whole
    expect(cutText("ab" + "😀" + "z".repeat(2100), 6)).toBe("ab😀z…")
  })
  it("max at or below zero returns the empty string; max 1 is the ellipsis alone (UF-L)", () => {
    // the old code returned `text.slice(0, -1) + "…"` for max 0 — nearly the whole text
    expect(cutText("abc", 0)).toBe("")
    expect(cutText("abc", -7)).toBe("")
    expect(cutText("abc", 1)).toBe("…")
    expect(cutText("abc", 2)).toBe("a…")
    expect(cutText("x", 1)).toBe("x") // already fits — unchanged
  })
})

// UF-L: the 50-entry note names WHICH lists lost their oldest entries, never a count — a count
// can only go stale (a save that puts an entry back makes the number a lie) and a number inside
// note text could be forged upward. splitLimitNote strips every note-looking segment out of a
// checkpoint's text and recovers the lists a well-formed trailing note names.
describe("limitNote and splitLimitNote (UF-L)", () => {
  const { limitNote, splitLimitNote } = schema
  it("builds the exact wording for one, two and three lists, in the fixed order", () => {
    expect(limitNote(new Set(["constraints"]))).toBe(
      "(Mida: a list holds at most 50 entries. Older constraints were left out.)",
    )
    expect(limitNote(new Set(["decisions", "constraints"]))).toBe(
      "(Mida: a list holds at most 50 entries. Older constraints and decisions were left out.)",
    )
    expect(limitNote(new Set(["rejected", "constraints", "decisions"]))).toBe(
      "(Mida: a list holds at most 50 entries. Older constraints, decisions and rejected approaches were left out.)",
    )
    expect(limitNote(new Set(["rejected"]))).toBe(
      "(Mida: a list holds at most 50 entries. Older rejected approaches were left out.)",
    )
    expect(limitNote(new Set())).toBeNull()
  })
  it("round-trips the note — alone and after issue text", () => {
    const note = "(Mida: a list holds at most 50 entries. Older decisions were left out.)"
    const alone = splitLimitNote(note)
    expect(alone.text).toBe("")
    expect([...alone.lists]).toEqual(["decisions"])
    const joined = splitLimitNote(`still failing on CI | ${note}`)
    expect(joined.text).toBe("still failing on CI")
    expect([...joined.lists]).toEqual(["decisions"])
    const three = splitLimitNote(`stuck | ${limitNote(new Set(["rejected", "constraints", "decisions"]))!}`)
    expect(three.text).toBe("stuck")
    expect([...three.lists]).toEqual(["constraints", "decisions", "rejected"])
  })
  it("a note in the MIDDLE of the value names no lists but still leaves the text", () => {
    const s = splitLimitNote("a | (Mida: a list holds at most 50 entries. Older decisions were left out.) | b")
    expect(s.text).toBe("a | b")
    expect(s.lists.size).toBe(0)
  })
  it("a note nested inside another note leaves no (Mida: behind", () => {
    const s = splitLimitNote(
      "i | (Mida: a list holds at most (Mida: a list holds at most 50 entries. Older decisions were left out.)",
    )
    expect(s.text).toBe("i")
    expect(s.text).not.toContain("(Mida:")
  })
  it("a note cut off mid-way at the end of the string is removed", () => {
    const s = splitLimitNote("the deploy key rotation is waiting on ops | (Mida: a list holds at most 50 entries. Older dec")
    expect(s.text).toBe("the deploy key rotation is waiting on ops")
    expect(s.lists.size).toBe(0)
  })
  it("the old numbered wording leaves the text but names no list", () => {
    const s = splitLimitNote("x | (Mida: a list holds at most 50 entries. Left out: the 3 oldest decisions.)")
    expect(s.text).toBe("x")
    expect(s.lists.size).toBe(0)
  })
  it("null and a note-free string give empty text parts and no lists", () => {
    expect(splitLimitNote(null)).toEqual({ text: "", lists: new Set() })
    const s = splitLimitNote("flaky test")
    expect(s.text).toBe("flaky test")
    expect(s.lists.size).toBe(0)
  })
})

// CAP-29: evidence names its target by position ("decisions[3]"), so entries leaving the front of
// a list would leave every later evidence line vouching for a different entry.
describe("repointEvidence", () => {
  const evidence = [
    { field: "decisions[0]", ref: "a" },
    { field: "decisions[2]", ref: "b" },
    { field: "decisions[12].rationale", ref: "c" },
    { field: "progress[1]", ref: "d" },
    { field: "decisionsX[5]", ref: "e" },
    { field: "nextAction", ref: "f" },
  ]
  it("moves evidence down with its entry and removes evidence whose entry was dropped", () => {
    expect(repointEvidence(evidence, "decisions", 2)).toEqual([
      { field: "decisions[0]", ref: "b" },
      { field: "decisions[10].rationale", ref: "c" },
      { field: "progress[1]", ref: "d" },
      { field: "decisionsX[5]", ref: "e" },
      { field: "nextAction", ref: "f" },
    ])
  })
  it("changes nothing when nothing was dropped, and never changes its input", () => {
    const before = JSON.stringify(evidence)
    expect(repointEvidence(evidence, "decisions", 0)).toEqual(evidence)
    repointEvidence(evidence, "decisions", 2)
    expect(JSON.stringify(evidence)).toBe(before)
  })
  it("passes through entries that are not evidence objects — they are the validator's to reject", () => {
    const odd = [null, "decisions[0]", { field: 7, ref: "x" }, { field: "decisions[3]", ref: "y" }] as unknown as { field: string }[]
    expect(repointEvidence(odd, "decisions", 1)).toEqual([null, "decisions[0]", { field: 7, ref: "x" }, { field: "decisions[2]", ref: "y" }])
  })
})

function validCp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt-00000001",
    agent: "claude-code",
    source: "agent-tool",
    createdAt: "2026-09-21T10:00:00.000Z",
    objective: "Implement the TokenBucket rate limiter",
    progress: ["step 1 done"],
    decisions: [{ decision: "lazy refill", rationale: "no timers allowed" }],
    rejected: [{ approach: "setInterval refill", why: "violates no-timers constraint" }],
    constraints: ["no dependencies"],
    artifacts: ["src/bucket.mjs"],
    unresolvedIssue: null,
    nextAction: "implement step 2 (injectable clock)",
    remainingPlan: [],
    evidence: [{ field: "decisions[0]", ref: "transcript:L10-L12" }],
    ...overrides,
  }
}

describe("validateCheckpoint", () => {
  it("a valid checkpoint passes", () => {
    const r = validateCheckpoint(validCp())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.objective).toBe("Implement the TokenBucket rate limiter")
  })

  it("missing objective fails", () => {
    const cp = validCp()
    delete cp.objective
    const r = validateCheckpoint(cp)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes("objective"))).toBe(true)
  })

  it("unknown top-level key fails", () => {
    const r = validateCheckpoint(validCp({ extraField: "nope" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes("extraField"))).toBe(true)
  })

  it("oversize string fails", () => {
    const r = validateCheckpoint(validCp({ objective: "x".repeat(2001) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes("2000"))).toBe(true)
  })

  it("wrong types fail", () => {
    const r = validateCheckpoint(validCp({ progress: "not an array", nextAction: 42 }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("progress"))).toBe(true)
      expect(r.errors.some((e) => e.includes("nextAction"))).toBe(true)
    }
  })

  it("bad source fails", () => {
    const r = validateCheckpoint(validCp({ source: "mystery" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes("source"))).toBe(true)
  })

  it("malformed nested items fail", () => {
    const r = validateCheckpoint(validCp({ decisions: [{ decision: "x" }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes("rationale"))).toBe(true)
  })

  it("remainingPlan accepts a string list and defaults to [] (H2)", () => {
    const plan = ["4. KeyedLimiter with max keys + LRU eviction", "5. README usage section"]
    const r = validateCheckpoint(validCp({ remainingPlan: plan }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.remainingPlan).toEqual(plan)
    const r2 = validateCheckpoint(validCp())
    if (r2.ok) expect(r2.value.remainingPlan).toEqual([])
  })

  it("remainingPlan is capped like the other arrays (H2)", () => {
    expect(validateCheckpoint(validCp({ remainingPlan: Array(51).fill("x") })).ok).toBe(false)
    expect(validateCheckpoint(validCp({ remainingPlan: [42] })).ok).toBe(false)
  })

  it("originalRequest accepts null and a 3,000-char string", () => {
    expect(validateCheckpoint(validCp({ originalRequest: null })).ok).toBe(true)
    const r = validateCheckpoint(validCp({ originalRequest: "y".repeat(3_000) }))
    expect(r.ok).toBe(true)
  })

  it("originalRequest rejects over 6,000 chars and non-strings", () => {
    expect(validateCheckpoint(validCp({ originalRequest: "y".repeat(6_001) })).ok).toBe(false)
    expect(validateCheckpoint(validCp({ originalRequest: 42 })).ok).toBe(false)
  })

  it("fills defaults so a minimal checkpoint comes back complete", () => {
    const r = validateCheckpoint({ eventId: "abcdefgh", agent: "claude-code", source: "hook-compiler",
      createdAt: "2026-09-21T10:00:00.000Z", objective: "o", nextAction: "n" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatchObject({ originalRequest: null, progress: [], decisions: [], rejected: [],
      constraints: [], artifacts: [], unresolvedIssue: null, remainingPlan: [], evidence: [] })
  })

  it("rejects a createdAt that is not an ISO date", () => {
    const r = validateCheckpoint({ eventId: "abcdefgh", agent: "a", source: "hook-compiler",
      createdAt: "yesterday", objective: "o", nextAction: "n" })
    expect(r.ok).toBe(false)
  })

  it("rejects createdAt strings that Date.parse accepts but that are not ISO-8601 (A13)", () => {
    for (const createdAt of ["2026", "1", "March 3 2020"]) {
      expect(validateCheckpoint(validCp({ createdAt })).ok, createdAt).toBe(false)
    }
    for (const createdAt of ["2026-09-21T10:00:00Z", "2026-09-21T10:00:00.123Z", "2026-09-21T10:00:00+02:00"]) {
      expect(validateCheckpoint(validCp({ createdAt })).ok, createdAt).toBe(true)
    }
  })
})
