import { describe, expect, it } from "vitest"
import { MAX_VALUE_BYTES, eventIdFor, unwrapCheckpoint, wrapCheckpoint } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

describe("checkpoint payload", () => {
  it("the save id changes when the transcript grows and is stable on a retry", () => {
    const a = eventIdFor({ projectId: "p", sessionId: "s", transcriptBytes: 80_000, lastLine: "x" })
    expect(eventIdFor({ projectId: "p", sessionId: "s", transcriptBytes: 80_000, lastLine: "x" })).toBe(a)
    expect(eventIdFor({ projectId: "p", sessionId: "s", transcriptBytes: 120_000, lastLine: "x" })).not.toBe(a)
    expect(eventIdFor({ projectId: "p", sessionId: "s", transcriptBytes: 80_000, lastLine: "y" })).not.toBe(a)
    expect(a).toMatch(/^cp-[0-9a-f]{40}$/)
  })
  it("a checkpoint over the cap is shrunk by dropping oldest progress, then oldest evidence, and says that it did", () => {
    const big = sampleCheckpoint({ originalRequest: "keep me", remainingPlan: ["1. a"], nextAction: "go",
      progress: Array.from({ length: 50 }, (_, i) => `${i} ${"p".repeat(1990)}`),
      evidence: Array.from({ length: 50 }, (_, i) => ({ field: `progress[${i}]`, ref: "transcript:L1" })) })
    const e = wrapCheckpoint({ projectId: "p", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint: big })
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(e.checkpoint.progress.at(-1)).toBe(big.progress.at(-1))          // newest kept
    expect(e.checkpoint.constraints.some((c) => /^\(Mida: \d+ progress and \d+ evidence entries were left out to fit the size limit\)$/.test(c))).toBe(true)
    expect(e.checkpoint.originalRequest).toBe("keep me")
    expect(e.checkpoint.remainingPlan).toEqual(["1. a"])
  })
  it("throws when it cannot fit even after shrinking", () => {
    const huge = sampleCheckpoint({ decisions: Array.from({ length: 50 }, () => ({ decision: "d".repeat(2000), rationale: "r".repeat(2000) })) })
    expect(() => wrapCheckpoint({ projectId: "p", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint: huge })).toThrow(/65,?536/)
  })
  it("unwrap returns null for a wrong type, a missing field, or an invalid checkpoint", () => {
    const good = wrapCheckpoint({ projectId: "p", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint: sampleCheckpoint({}) })
    expect(unwrapCheckpoint(good)).not.toBeNull()
    expect(unwrapCheckpoint({ ...good, type: "mida.checkpoint" })).toBeNull()
    const { sessionId: _drop, ...missing } = good
    expect(unwrapCheckpoint(missing)).toBeNull()
    expect(unwrapCheckpoint({ ...good, checkpoint: { objective: 5 } })).toBeNull()
    expect(unwrapCheckpoint(null)).toBeNull()
  })
  it("wrap rejects an empty projectId or sessionId", () => {
    const cp = sampleCheckpoint({})
    expect(() => wrapCheckpoint({ projectId: "", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint: cp })).toThrow()
    expect(() => wrapCheckpoint({ projectId: "p", sessionId: "", continuesSession: null, compiledBy: "t", checkpoint: cp })).toThrow()
  })
})
