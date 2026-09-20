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

  it("carries the on-chain authorId into provenance and otherSessions (B11)", () => {
    const forged = stored({ at: "2026-09-21T10:00:00Z", agent: "claude-code", objective: "o", nextAction: "n", progress: ["did work"] })
    forged.authorId = "0xreal-author"
    const other = stored({ at: "2026-09-21T11:00:00Z", sessionId: "s2", objective: "side", nextAction: "n" })
    other.authorId = "0xother-author"
    const m = mergeCheckpoints([forged, other])!
    expect(m.provenance[0]!.authorId).toBe("0xreal-author")
    expect(m.provenance[0]!.agent).toBe("claude-code") // the claim is kept for contrast, not trusted
    expect(m.otherSessions[0]!.authorId).toBe("0xother-author")
  })

  it("keeps the first request word for word and, for an agent-tool delta, the latest non-empty objective, plan, issue and next step", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", originalRequest: "Build X in 5 steps", objective: "build X", nextAction: "step 1", remainingPlan: ["1", "2"], unresolvedIssue: "flaky test" }),
      stored({ at: "2026-09-21T10:05:00Z", source: "agent-tool", objective: "", nextAction: "step 2", remainingPlan: [], unresolvedIssue: null }),
    ])!
    expect(m.originalRequest).toBe("Build X in 5 steps")
    expect(m.objective).toBe("build X")          // empty later value does not erase it
    expect(m.nextAction).toBe("step 2")
    expect(m.remainingPlan).toEqual(["1", "2"])  // empty later list does not erase it
    expect(m.unresolvedIssue).toBe("flaky test") // null later value does not erase it
  })

  it("a later hook-compiler save is a full restatement: its empty fields clear the earlier ones (A10)", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", objective: "build X", nextAction: "step 1", remainingPlan: ["1", "2"], unresolvedIssue: "flaky test" }),
      stored({ at: "2026-09-21T10:05:00Z", objective: "build X", nextAction: "done", remainingPlan: [], unresolvedIssue: null }),
    ])!
    expect(m.unresolvedIssue).toBeNull() // a resolved issue must not come back
    expect(m.remainingPlan).toEqual([])  // a finished plan must clear
    expect(m.objective).toBe("build X")
    expect(m.nextAction).toBe("done")
  })

  it("an agent-tool save after the latest hook-compiler is a delta on top of it (A10)", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", objective: "build X", nextAction: "step 1", remainingPlan: ["1", "2"], unresolvedIssue: "flaky test" }),
      stored({ at: "2026-09-21T10:05:00Z", source: "agent-tool", nextAction: "step 2" }),
    ])!
    expect(m.objective).toBe("build X")
    expect(m.nextAction).toBe("step 2")
    expect(m.remainingPlan).toEqual(["1", "2"])
    expect(m.unresolvedIssue).toBe("flaky test")
  })

  it("sorts by createdAt, not by input order", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:05:00Z", nextAction: "later" }),
      stored({ at: "2026-09-21T10:00:00Z", nextAction: "earlier", originalRequest: "first" }),
    ])!
    expect(m.nextAction).toBe("later")
    expect(m.originalRequest).toBe("first")
  })

  it("unions decisions, rejected, constraints and artifacts without repeats, in first-seen order — the rule for a chain with no hook-compiler save", () => {
    const d = { decision: "use sqlite", rationale: "no server" }
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", source: "agent-tool", decisions: [d], constraints: ["no timers"], artifacts: ["a.ts"] }),
      stored({ at: "2026-09-21T10:05:00Z", source: "agent-tool", decisions: [d, { decision: "wal mode", rationale: "speed" }], constraints: ["no timers", "node 25"], artifacts: ["b.ts", "a.ts"] }),
    ])!
    expect(m.decisions).toEqual([d, { decision: "wal mode", rationale: "speed" }])
    expect(m.constraints).toEqual(["no timers", "node 25"])
    expect(m.artifacts).toEqual(["a.ts", "b.ts"])
  })

  it("a chain of hook-compiler saves takes its lists from the NEWEST save only — earlier restatements contribute nothing (C1)", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", decisions: [{ decision: "Use lazy refill", rationale: "v1" }], constraints: ["old c"], artifacts: ["a.ts"], progress: ["p1"] }),
      stored({ at: "2026-09-21T10:05:00Z", decisions: [{ decision: "Chose lazy refill", rationale: "v2" }], constraints: ["mid c"], artifacts: ["b.ts"], progress: ["p1", "p2"] }),
      stored({ at: "2026-09-21T10:10:00Z", decisions: [{ decision: "lazy refill on each call", rationale: "v3" }], constraints: ["new c"], artifacts: ["c.ts"], progress: ["p1", "p2", "p3"] }),
    ])!
    // the same decision restated three ways must not triple in the handoff
    expect(m.decisions).toEqual([{ decision: "lazy refill on each call", rationale: "v3" }])
    expect(m.constraints).toEqual(["new c"])
    expect(m.artifacts).toEqual(["c.ts"])
    expect(m.progress).toEqual(["p1", "p2", "p3"])
    expect(m.carriedForwardFromEarlierSave).toBe(false)
    expect(m.provenance).toHaveLength(3) // every checkpoint in scope is still named
  })

  it("an agent-tool save after the newest hook-compiler appends its entries, deduped (C1)", () => {
    const d = { decision: "lazy refill", rationale: "no timers" }
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", decisions: [d], constraints: ["c1"], artifacts: ["a.ts"], progress: ["p1"] }),
      stored({ at: "2026-09-21T10:05:00Z", source: "agent-tool", decisions: [{ decision: "wal mode", rationale: "speed" }, d], constraints: ["c2"], artifacts: ["b.ts"], progress: ["p2"] }),
    ])!
    expect(m.decisions).toEqual([d, { decision: "wal mode", rationale: "speed" }])
    expect(m.constraints).toEqual(["c1", "c2"])
    expect(m.artifacts).toEqual(["a.ts", "b.ts"])
    expect(m.progress).toEqual(["p1", "p2"])
    expect(m.carriedForwardFromEarlierSave).toBe(false)
  })

  it("a newest hook-compiler save that lost most of the earlier lists restores them and flags it (C1)", () => {
    const kept = [
      { decision: "d1", rationale: "r" },
      { decision: "d2", rationale: "r" },
      { decision: "d3", rationale: "r" },
    ]
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", decisions: kept, constraints: ["c1", "c2"], progress: ["p1", "p2"], artifacts: ["a.ts"] }),
      stored({ at: "2026-09-21T10:05:00Z", decisions: [{ decision: "d4", rationale: "r" }], progress: ["p3"] }),
    ])!
    // 1 decision+constraint against the earlier 5 is under half — the earlier lists are the base
    expect(m.decisions).toEqual([...kept, { decision: "d4", rationale: "r" }])
    expect(m.constraints).toEqual(["c1", "c2"])
    expect(m.progress).toEqual(["p1", "p2", "p3"])
    expect(m.artifacts).toEqual(["a.ts"])
    expect(m.carriedForwardFromEarlierSave).toBe(true)
  })

  it("the restore guard does not fire when the newest save keeps at least half (C1)", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", decisions: [{ decision: "d1", rationale: "r" }, { decision: "d2", rationale: "r" }], constraints: ["c1", "c2"] }),
      stored({ at: "2026-09-21T10:05:00Z", decisions: [{ decision: "d3", rationale: "r" }], constraints: ["c3"] }),
    ])!
    // 2 entries against 4 is exactly half — no restore; the newest save is the whole state
    expect(m.decisions).toEqual([{ decision: "d3", rationale: "r" }])
    expect(m.constraints).toEqual(["c3"])
    expect(m.carriedForwardFromEarlierSave).toBe(false)
  })

  it("dedupes objects by content, not key order (A13)", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", source: "agent-tool", decisions: [{ decision: "sqlite", rationale: "no server" }] }),
      stored({ at: "2026-09-21T10:05:00Z", source: "agent-tool", decisions: [{ rationale: "no server", decision: "sqlite" }] }),
    ])!
    expect(m.decisions).toEqual([{ decision: "sqlite", rationale: "no server" }])
  })

  it("keeps every progress entry in order, dropping only exact repeats — the union rule for agent-tool saves", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", source: "agent-tool", progress: ["wrote schema"] }),
      stored({ at: "2026-09-21T10:05:00Z", source: "agent-tool", progress: ["wrote schema", "wrote tests"] }),
    ])!
    expect(m.progress).toEqual(["wrote schema", "wrote tests"])
  })

  it("scopes to the most recent session plus the sessions it continues, and ignores unrelated older sessions", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "old-unrelated", at: "2026-09-20T09:00:00Z", originalRequest: "other job", constraints: ["stale rule"] }),
      stored({ sessionId: "A", at: "2026-09-21T10:00:00Z", originalRequest: "real job", constraints: ["no timers"] }),
      // the continuing session's save is a delta here: under C1 a hook-compiler
      // head would legitimately blank the base session's lists
      stored({ sessionId: "B", continuesSession: "A", source: "agent-tool", at: "2026-09-21T11:00:00Z", nextAction: "finish" }),
    ])!
    expect(m.originalRequest).toBe("real job")
    expect(m.constraints).toEqual(["no timers"])
    expect(m.provenance).toHaveLength(2)
  })

  it("a throwaway newer session does not replace the working session (A11)", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "work", at: "2026-09-21T10:00:00Z", originalRequest: "real job", objective: "build X", progress: ["did step 1"], remainingPlan: ["2"] }),
      stored({ sessionId: "throwaway", at: "2026-09-21T12:00:00Z", objective: "what time is it" }),
    ])!
    expect(m.objective).toBe("build X")
    expect(m.originalRequest).toBe("real job")
    expect(m.progress).toEqual(["did step 1"])
    expect(m.otherSessions).toHaveLength(1)
    expect(m.otherSessions[0]).toMatchObject({ sessionId: "throwaway", objective: "what time is it" })
  })

  it("two working chains: the newest wins, the older is listed in otherSessions (A11)", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "old-work", at: "2026-09-21T10:00:00Z", objective: "old job", progress: ["p1"] }),
      stored({ sessionId: "new-work", at: "2026-09-21T11:00:00Z", objective: "new job", progress: ["p2"] }),
    ])!
    expect(m.objective).toBe("new job")
    expect(m.otherSessions).toHaveLength(1)
    expect(m.otherSessions[0]).toMatchObject({ sessionId: "old-work", objective: "old job" })
  })

  it("equal timestamps give identical output regardless of input order (A11)", () => {
    const arr = [
      stored({ sessionId: "A", at: "2026-09-21T10:00:00Z", objective: "job A", progress: ["p"] }),
      stored({ sessionId: "B", at: "2026-09-21T10:00:00Z", objective: "job B", progress: ["p"] }),
    ]
    const fwd = mergeCheckpoints(arr)!
    const rev = mergeCheckpoints([...arr].reverse())!
    expect(fwd).toEqual(rev)
  })

  it("a continuesSession on a session's SECOND checkpoint is still followed (A11)", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "A", at: "2026-09-21T10:00:00Z", originalRequest: "real job", constraints: ["c1"], progress: ["p1"] }),
      // B's saves are agent-tool deltas so its list entries append to A's base
      stored({ sessionId: "B", source: "agent-tool", at: "2026-09-21T11:00:00Z", nextAction: "n" }),
      stored({ sessionId: "B", source: "agent-tool", continuesSession: "A", at: "2026-09-21T11:05:00Z", progress: ["p2"] }),
    ])!
    expect(m.provenance).toHaveLength(3)
    expect(m.constraints).toEqual(["c1"])
    expect(m.originalRequest).toBe("real job")
  })

  it("a continuation pointing at no stored checkpoint sets missingEarlierSession (A11)", () => {
    const m = mergeCheckpoints([
      stored({ sessionId: "B", continuesSession: "ghost", at: "2026-09-21T11:00:00Z", objective: "job", progress: ["p"] }),
    ])!
    expect(m.missingEarlierSession).toBe(true)
    expect(m.objective).toBe("job")
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
