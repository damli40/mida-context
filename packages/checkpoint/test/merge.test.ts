import { describe, expect, it } from "vitest"
import { mergeCheckpoints, type StoredCheckpoint } from "../src/index.js"

let n = 0
function stored(
  over: Partial<StoredCheckpoint["checkpoint"]> & {
    sessionId?: string
    continuesSession?: string | null
    at: string
    /** Monad's own placement of the save — what the SDK's reads carry on `ContextObject.chain`. */
    chain?: { at: bigint; block?: bigint; index?: number }
  },
): StoredCheckpoint {
  n += 1
  const { sessionId = "s1", continuesSession = null, at, chain, ...cp } = over
  return {
    projectId: "p", sessionId, continuesSession, compiledBy: "test", contextId: `0x${n.toString(16).padStart(64, "0")}`, authorId: "0xa", namespaceId: `0x${"c".repeat(64)}`,
    ...(chain === undefined ? {} : { chain }),
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

  it("Monad's stamp decides 'newest', not the checkpoint's claim — an earlier save dated 2099 loses", () => {
    // The saver's own createdAt is untrusted content: this checkpoint landed FIRST on chain yet
    // claims 2099. Ordering by the claim would let it displace the save Monad recorded later.
    const m = mergeCheckpoints([
      stored({ sessionId: "old-on-chain", at: "2099-01-01T00:00:00.000Z", objective: "earlier save, forged clock", progress: ["p"], chain: { at: 1_000n, block: 5n, index: 0 } }),
      stored({ sessionId: "new-on-chain", at: "2026-09-21T10:00:00.000Z", objective: "truly latest save", progress: ["p"], chain: { at: 2_000n, block: 9n, index: 0 } }),
    ])!
    expect(m.objective).toBe("truly latest save")
    expect(m.otherSessions[0]).toMatchObject({ sessionId: "old-on-chain" })
    // provenance's stamp is Monad's too — the claim stays only inside the checkpoint payload
    expect(m.provenance.at(-1)!.createdAt).toBe("1970-01-01T00:33:20.000Z")
  })

  it("same-second saves order by chain order — block, then log index — never the contextId", () => {
    // Both landed in the same second; the contextIds are arranged so the old contextId tie-break
    // picks the chain-EARLIER save. Chain order must win either way the ids fall.
    const earlier = stored({ sessionId: "s-earlier", at: "2026-09-21T10:00:00.000Z", objective: "chain-earlier", progress: ["p"], chain: { at: 1_700_000_000n, block: 5n, index: 1 } })
    earlier.contextId = `0x${"1".repeat(64)}`
    const later = stored({ sessionId: "s-later", at: "2026-09-21T10:00:00.000Z", objective: "chain-later", progress: ["p"], chain: { at: 1_700_000_000n, block: 5n, index: 4 } })
    later.contextId = `0x${"f".repeat(64)}`
    expect(mergeCheckpoints([earlier, later])!.objective).toBe("chain-later")

    // and the same within one session — member order follows (block, index) too
    const first = stored({ at: "2026-09-21T10:00:00.000Z", nextAction: "chain-earlier action", chain: { at: 1_700_000_000n, block: 5n, index: 1 } })
    first.contextId = `0x${"f".repeat(64)}`
    const second = stored({ at: "2026-09-21T10:00:00.000Z", nextAction: "chain-later action", chain: { at: 1_700_000_000n, block: 5n, index: 4 } })
    second.contextId = `0x${"1".repeat(64)}`
    const same = mergeCheckpoints([first, second])!
    expect(same.nextAction).toBe("chain-later action")
    expect(same.provenance.map((row) => row.contextId)).toEqual([first.contextId, second.contextId])
  })

  it("a save carrying an older claim that landed LATER on chain is the current one (in-12 N-1)", () => {
    // A real compile stamps the writer's clock before the write is sent — a queued hook save
    // drained late, or a machine clock a minute slow, carries an honest claim that predates
    // its own anchor. Ordering on the claim would crown the save that landed EARLIER; the
    // chain's own stamp is the only clock that decides.
    const landedFirst = stored({
      sessionId: "s-first", at: "2026-09-21T14:15:00.000Z", objective: "landed first", progress: ["p"],
      chain: { at: 1_790_000_100n, block: 100n, index: 0 },
    })
    const landedLast = stored({
      // written 5 seconds earlier than it reports? no — CLAIMS two minutes earlier, lands LATER
      sessionId: "s-last", at: "2026-09-21T14:13:00.000Z", objective: "landed last — the current save", progress: ["p"],
      chain: { at: 1_790_000_105n, block: 110n, index: 0 },
    })
    for (const order of [[landedFirst, landedLast], [landedLast, landedFirst]] as const) {
      const m = mergeCheckpoints([...order])!
      expect(m.objective).toBe("landed last — the current save")
      expect(m.otherSessions[0]).toMatchObject({ sessionId: "s-first" })
    }
    // and the header reports the chain stamp, not either writer's clock
    expect(mergeCheckpoints([landedFirst, landedLast])!.savedAt).toBe(new Date(1_790_000_105_000).toISOString())
  })

  it("a migration envelope dated 2099 cannot make its save the session's newest (I0)", () => {
    // The envelope is encrypted content the saver controls — the same untrusted channel as
    // checkpoint.createdAt. A save replayed at Monad's time S may CLAIM its original record is
    // far newer; the ordering stamp is min(envelope original, S), so a forged envelope can only
    // age the save that carries it — the chain-later save stays the session's newest.
    const forged = stored({
      sessionId: "s-1", at: "2026-09-21T10:00:00.000Z", objective: "forged-envelope save", progress: ["p"],
      chain: { at: 1_700_000_000n, block: 5n, index: 0 },
    })
    forged.migration = {
      version: 1,
      originalChainId: "31337",
      originalContract: `0x${"1".repeat(40)}`,
      originalRecordId: `0x${"2".repeat(64)}`,
      originalCommitment: `0x${"3".repeat(64)}`,
      originalAuthor: `0x${"4".repeat(64)}`,
      originalCreatedAt: "2099-01-01T00:00:00.000Z",
      migratedAt: "2026-09-21T12:00:00.000Z",
    }
    const honest = stored({
      sessionId: "s-1", at: "2026-09-21T11:00:00.000Z", objective: "chain-latest save", progress: ["p"],
      chain: { at: 1_700_000_100n, block: 9n, index: 0 },
    })
    const m = mergeCheckpoints([forged, honest])!
    expect(m.objective).toBe("chain-latest save")
    // provenance keeps the chain's own order: the forged save is the earlier record
    expect(m.provenance.map((p) => p.contextId)).toEqual([forged.contextId, honest.contextId])
  })

  it("a moved save whose original predates its replay keeps its original position (I0)", () => {
    // The honest direction of the same rule: the replay mined AFTER an unrelated newer save,
    // but the record itself is older — its ordering stamp is the original time, not the replay's.
    const moved = stored({
      sessionId: "s-moved", at: "2026-09-21T12:00:00.000Z", objective: "moved older record", progress: ["p"],
      chain: { at: 1_700_000_200n, block: 9n, index: 0 },
    })
    moved.migration = {
      version: 1,
      originalChainId: "31337",
      originalContract: `0x${"1".repeat(40)}`,
      originalRecordId: `0x${"2".repeat(64)}`,
      originalCommitment: `0x${"3".repeat(64)}`,
      originalAuthor: `0x${"4".repeat(64)}`,
      originalCreatedAt: "2023-10-01T00:00:00.000Z", // the record's real age — long before its replay
      migratedAt: "2023-11-14T22:13:20.000Z",
    }
    const honest = stored({
      sessionId: "s-honest", at: "2026-09-21T11:00:00.000Z", objective: "honest later save", progress: ["p"],
      chain: { at: 1_700_000_100n, block: 7n, index: 0 },
    })
    // The replay landed AFTER the honest save on chain — chain time alone would crown the move.
    expect(moved.chain!.at > honest.chain!.at).toBe(true)
    const m = mergeCheckpoints([moved, honest])!
    expect(m.objective).toBe("honest later save")
    expect(m.otherSessions[0]).toMatchObject({ sessionId: "s-moved" })
  })

  it("moved records replayed in the same chain second keep their original order (I0)", () => {
    // Two moved records, one replay second and block: original order survives, whether it is
    // carried by the envelopes or by the chain's own (block, index) replay placement.
    const older = stored({
      sessionId: "s-first-written", at: "2026-09-21T10:00:00.000Z", objective: "originally-older save", progress: ["p"],
      chain: { at: 1_700_000_000n, block: 5n, index: 0 },
    })
    older.migration = {
      version: 1,
      originalChainId: "31337",
      originalContract: `0x${"1".repeat(40)}`,
      originalRecordId: `0x${"2".repeat(64)}`,
      originalCommitment: `0x${"3".repeat(64)}`,
      originalAuthor: `0x${"4".repeat(64)}`,
      originalCreatedAt: "2023-10-01T00:00:00.000Z",
      migratedAt: "2023-11-14T22:13:20.000Z",
    }
    const newer = stored({
      sessionId: "s-second-written", at: "2026-09-21T10:30:00.000Z", objective: "originally-newer save", progress: ["p"],
      chain: { at: 1_700_000_000n, block: 5n, index: 1 },
    })
    newer.migration = {
      version: 1,
      originalChainId: "31337",
      originalContract: `0x${"1".repeat(40)}`,
      originalRecordId: `0x${"5".repeat(64)}`,
      originalCommitment: `0x${"6".repeat(64)}`,
      originalAuthor: `0x${"4".repeat(64)}`,
      originalCreatedAt: "2023-10-02T00:00:00.000Z",
      migratedAt: "2023-11-14T22:13:20.000Z",
    }
    const m = mergeCheckpoints([older, newer])!
    expect(m.objective).toBe("originally-newer save")
    expect(m.otherSessions[0]).toMatchObject({ sessionId: "s-first-written" })
  })

  it("same-second saves in different blocks order by block number", () => {
    const block5 = stored({ sessionId: "s-5", at: "2026-09-21T10:00:00.000Z", objective: "block-5 save", progress: ["p"], chain: { at: 1_700_000_000n, block: 5n, index: 0 } })
    block5.contextId = `0x${"1".repeat(64)}`
    const block9 = stored({ sessionId: "s-9", at: "2026-09-21T10:00:00.000Z", objective: "block-9 save", progress: ["p"], chain: { at: 1_700_000_000n, block: 9n, index: 0 } })
    block9.contextId = `0x${"f".repeat(64)}`
    expect(mergeCheckpoints([block5, block9])!.objective).toBe("block-9 save")
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

  it("savedAt is the newest merged record's chain stamp — the writer's own createdAt never fills it (in-8 H1)", () => {
    const m = mergeCheckpoints([
      stored({ at: "2026-09-21T10:00:00Z", objective: "old", chain: { at: 1_000n } }),
      stored({ at: "2026-09-21T11:00:00Z", objective: "new", chain: { at: 2_000n } }),
    ])!
    // 2_000 seconds after the epoch — Monad's own placement of the newest record, not either
    // checkpoint's self-reported createdAt
    expect(m.savedAt).toBe(new Date(2_000_000).toISOString())
  })

  it("savedAt is null when no merged record carries a chain placement", () => {
    expect(mergeCheckpoints([stored({ at: "2026-09-21T10:00:00Z" })])!.savedAt).toBeNull()
  })

  // in-11 R-10 — every displayed time is the same effective instant the ordering already uses:
  // min(originalCreatedAt, chain stamp). Since the owner migrated live on Sep 24, the raw stamp
  // would print the MOVE day on every older fact; the effective instant prints the write day.
  const envelope = (originalCreatedAt: string): StoredCheckpoint["migration"] => ({
    version: 1,
    originalChainId: "31337",
    originalContract: `0x${"1".repeat(40)}`,
    originalRecordId: `0x${"2".repeat(64)}`,
    originalCommitment: `0x${"3".repeat(64)}`,
    originalAuthor: `0x${"4".repeat(64)}`,
    originalCreatedAt,
    migratedAt: "2026-09-24T12:00:00.000Z",
  })

  it("a moved record's provenance reports when it was written, not the replay day (R-10)", () => {
    const moved = stored({
      sessionId: "s-moved", at: "2026-09-24T10:00:00.000Z", objective: "moved save", progress: ["p"],
      chain: { at: 1_800_000_000n, block: 9n, index: 0 },
    })
    moved.migration = envelope("2026-09-21T10:00:00.000Z")
    const m = mergeCheckpoints([moved])!
    expect(m.provenance[0]!.createdAt).toBe("2026-09-21T10:00:00.000Z")
    // and the header's "saved" line reports the same original instant, not the replay stamp
    expect(m.savedAt).toBe("2026-09-21T10:00:00.000Z")
  })

  it("an unmoved record beside a moved one shows its chain stamp — only the moved time is lowered by the envelope (R-10 + N-1)", () => {
    const moved = stored({
      sessionId: "s-moved", at: "2026-09-24T10:00:00.000Z", objective: "moved save", progress: ["p"],
      chain: { at: 1_800_000_000n, block: 9n, index: 0 },
    })
    moved.migration = envelope("2026-09-21T10:00:00.000Z")
    const honest = stored({
      sessionId: "s-honest", at: "2026-09-24T11:00:00.000Z", objective: "honest save", progress: ["p"],
      chain: { at: 1_800_000_100n, block: 10n, index: 0 },
    })
    const m = mergeCheckpoints([moved, honest])!
    // the honest save is newer: header + its row show Monad's own stamp — the writer's claim
    // never enters an unmoved record's time — while the moved save's row shows its original
    // write day instead
    expect(m.savedAt).toBe(new Date(1_800_000_100_000).toISOString())
    expect(m.provenance.at(-1)!.createdAt).toBe(new Date(1_800_000_100_000).toISOString())
    expect(m.otherSessions[0]!.sessionId).toBe("s-moved")
    expect(m.otherSessions[0]!.lastSavedAt).toBe("2026-09-21T10:00:00.000Z")
  })

  it("a forged-future envelope cannot make a moved record look newer than its replay (R-10)", () => {
    const moved = stored({
      sessionId: "s-moved", at: "2026-09-24T10:00:00.000Z", objective: "moved save", progress: ["p"],
      chain: { at: 1_800_000_000n, block: 9n, index: 0 },
    })
    moved.migration = envelope("2099-01-01T00:00:00.000Z")
    const m = mergeCheckpoints([moved])!
    // the envelope may only AGE its record — the 2099 claim collapses to the replay's own
    // chain stamp, and nothing is displayed past it
    expect(m.provenance[0]!.createdAt).toBe(new Date(1_800_000_000_000).toISOString())
    expect(m.savedAt).toBe(new Date(1_800_000_000_000).toISOString())
  })

  it("a checkpoint's own forged-future createdAt collapses to the chain stamp (R-10)", () => {
    // The writer's claim never enters an unmoved record's time at all (N-1): a save stamped
    // Jan 2027 that claims 2099 displays Monad's stamp — never the claim.
    const forged = stored({
      sessionId: "s-forged", at: "2099-01-01T00:00:00.000Z", objective: "forged clock", progress: ["p"],
      chain: { at: 1_800_000_000n, block: 9n, index: 0 },
    })
    const m = mergeCheckpoints([forged])!
    expect(m.provenance[0]!.createdAt).toBe(new Date(1_800_000_000_000).toISOString())
    expect(m.savedAt).toBe(new Date(1_800_000_000_000).toISOString())
  })
})
