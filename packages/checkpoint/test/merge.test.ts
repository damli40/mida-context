import { describe, expect, it } from "vitest"
import { mergeCheckpoints, type StoredCheckpoint } from "../src/index.js"

let n = 0
function stored(over: Partial<StoredCheckpoint["checkpoint"]> & { sessionId?: string; continuesSession?: string | null; at: string }): StoredCheckpoint {
  n += 1
  const { sessionId = "s1", continuesSession = null, at, ...cp } = over
  return {
    projectId: "p", sessionId, continuesSession, compiledBy: "test", contextId: `0x${n.toString(16).padStart(64, "0")}`, authorId: "0xa",
    checkpoint: { eventId: `event-${n}xxxx`, agent: "claude-code", source: "hook-compiler", createdAt: at,
      objective: "", originalRequest: null, progress: [], decisions: [], rejected: [], constraints: [], artifacts: [],
      unresolvedIssue: null, nextAction: "", remainingPlan: [], evidence: [], ...cp },
  }
}

describe("mergeCheckpoints", () => {
  it("returns null for no checkpoints", () => expect(mergeCheckpoints([])).toBeNull())

  it("keeps the first request word for word and the latest non-empty objective, plan, issue and next step", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", originalRequest: "Build X in 5 steps", objective: "build X", nextAction: "step 1", remainingPlan: ["1", "2"], unresolvedIssue: "flaky test" }),
      stored({ at: "2026-09-21T10:05:00Z", objective: "", nextAction: "step 2", remainingPlan: [], unresolvedIssue: null }),
    ])!
    expect(m.originalRequest).toBe("Build X in 5 steps")
    expect(m.objective).toBe("build X")          // empty later value does not erase it
    expect(m.nextAction).toBe("step 2")
    expect(m.remainingPlan).toEqual(["1", "2"])  // empty later list does not erase it
    expect(m.unresolvedIssue).toBe("flaky test") // null later value does not erase it
  })

  it("sorts by createdAt, not by input order", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:05:00Z", nextAction: "later" }),
      stored({ at: "2026-09-21T10:00:00Z", nextAction: "earlier", originalRequest: "first" }),
    ])!
    expect(m.nextAction).toBe("later")
    expect(m.originalRequest).toBe("first")
  })

  it("unions decisions, rejected, constraints and artifacts without repeats, in first-seen order", () => {
    const d = { decision: "use sqlite", rationale: "no server" }
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", decisions: [d], constraints: ["no timers"], artifacts: ["a.ts"] }),
      stored({ at: "2026-09-21T10:05:00Z", decisions: [d, { decision: "wal mode", rationale: "speed" }], constraints: ["no timers", "node 25"], artifacts: ["b.ts", "a.ts"] }),
    ])!
    expect(m.decisions).toEqual([d, { decision: "wal mode", rationale: "speed" }])
    expect(m.constraints).toEqual(["no timers", "node 25"])
    expect(m.artifacts).toEqual(["a.ts", "b.ts"])
  })

  it("keeps every progress entry in order, dropping only exact repeats", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", progress: ["wrote schema"] }),
      stored({ at: "2026-09-21T10:05:00Z", progress: ["wrote schema", "wrote tests"] }),
    ])!
    expect(m.progress).toEqual(["wrote schema", "wrote tests"])
  })

  it("scopes to the most recent session plus the sessions it continues, and ignores unrelated older sessions", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "old-unrelated", at: "2026-09-20T09:00:00Z", originalRequest: "other job", constraints: ["stale rule"] }),
      stored({ sessionId: "A", at: "2026-09-21T10:00:00Z", originalRequest: "real job", constraints: ["no timers"] }),
      stored({ sessionId: "B", continuesSession: "A", at: "2026-09-21T11:00:00Z", nextAction: "finish" }),
    ])!
    expect(m.originalRequest).toBe("real job")
    expect(m.constraints).toEqual(["no timers"])
    expect(m.provenance).toHaveLength(2)
  })

  it("does not loop forever when continuesSession points in a circle", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "A", continuesSession: "B", at: "2026-09-21T10:00:00Z" }),
      stored({ sessionId: "B", continuesSession: "A", at: "2026-09-21T11:00:00Z", nextAction: "x" }),
    ])!
    expect(m.provenance).toHaveLength(2)
  })

  it("refuses to mix projects", () => {
    expect(() => mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z" }),
      { ...stored({ at: "2026-09-21T10:01:00Z" }), projectId: "other" },
    ])).toThrow(/one project/)
  })
})
