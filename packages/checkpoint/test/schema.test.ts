import { describe, expect, it } from "vitest"
import { validateCheckpoint } from "../src/index.js"

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
