import { describe, expect, it } from "vitest"
import { renderHandoff, type MergedHandoff } from "../src/index.js"

const base: MergedHandoff = { originalRequest: "Build X.\nStep 1 …", objective: "build X", remainingPlan: ["2. wire it"],
  unresolvedIssue: null, nextAction: "wire it", decisions: [{ decision: "sqlite", rationale: "no server" }],
  rejected: [{ approach: "redis", why: "needs a server" }], constraints: ["no timers"], artifacts: ["a.ts"],
  progress: ["wrote schema"], provenance: [{ agent: "claude-code", createdAt: "2026-09-21T10:00:00Z", contextId: "0xabc", compiledBy: "haiku" }] }

describe("renderHandoff", () => {
  it("leads with the request, then the remaining plan, and ends with provenance", () => {
    const text = renderHandoff(base)
    expect(text.startsWith("MIDA HANDOFF")).toBe(true)
    const order = ["ORIGINAL REQUEST", "Remaining plan:", "Next action:", "Objective:", "Progress:", "Saved by:"].map((h) => text.indexOf(h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain("0xabc")
    expect(text).toContain("sqlite — because: no server")
  })
  it("omits the request section when there is none", () => {
    expect(renderHandoff({ ...base, originalRequest: null })).not.toContain("ORIGINAL REQUEST")
  })
  it("past the limit, replaces the OLDEST progress with one count line and never trims the request", () => {
    const progress = Array.from({ length: 400 }, (_, i) => `progress entry number ${i} ${"x".repeat(60)}`)
    const text = renderHandoff({ ...base, progress })
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).toContain(base.originalRequest!)
    expect(text).toMatch(/\(\d+ earlier progress entries left out\)/)
    expect(text).toContain("progress entry number 399")
    expect(text).not.toContain("progress entry number 0 ")
  })
  it("says so plainly when nothing but progress could be cut and it still does not fit", () => {
    const text = renderHandoff({ ...base, originalRequest: "r".repeat(6000), decisions: Array.from({ length: 50 }, (_, i) => ({ decision: `d${i} ${"y".repeat(150)}`, rationale: "z".repeat(150) })) })
    expect(text).toContain("r".repeat(6000))
    expect(text).toContain("(handoff longer than the limit; nothing further was cut)")
  })
})
