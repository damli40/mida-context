import { describe, expect, it } from "vitest"
import { MAX_PAYLOAD_BYTES, canonicalBytes } from "@mida/protocol"
import type { ContextPayload } from "@mida/protocol"
import { MAX_VALUE_BYTES, eventIdFor, unwrapCheckpoint, wrapCheckpoint } from "@mida/midad"
import type { CheckpointEnvelope, MigrationEnvelope } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const wrap = (checkpoint: Parameters<typeof wrapCheckpoint>[0]["checkpoint"]): CheckpointEnvelope =>
  wrapCheckpoint({ projectId: "p", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint })

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
      progress: Array.from({ length: 10 }, (_, i) => `${i} ${"p".repeat(1990)}`),
      evidence: Array.from({ length: 50 }, (_, i) => ({ field: `progress[${i}]`, ref: `transcript:L${i} ${"r".repeat(1900)}` })) })
    const e = wrap(big)
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(e.checkpoint.progress).toHaveLength(0)                          // all progress went first
    expect(e.checkpoint.evidence.at(-1)).toEqual(big.evidence.at(-1))      // newest evidence kept
    const note = e.checkpoint.constraints.find((c) => c.startsWith("(Mida:"))
    expect(note).toContain("progress")
    expect(note).toContain("evidence")
    expect(note).toContain("left out")
    expect(e.checkpoint.originalRequest).toBe("keep me")
    expect(e.checkpoint.remainingPlan).toEqual(["1. a"])
  })
  it("the reviewer's case: decisions and rejected go before protected fields, and the note names them", () => {
    const reviewer = sampleCheckpoint({
      originalRequest: "r".repeat(6000),
      remainingPlan: Array.from({ length: 50 }, (_, i) => `${i} ${"p".repeat(400)}`),
      decisions: Array.from({ length: 50 }, () => ({ decision: "d".repeat(400), rationale: "w".repeat(400) })),
      rejected: Array.from({ length: 50 }, () => ({ approach: "a".repeat(400), why: "w".repeat(400) })),
    })
    const e = wrap(reviewer)
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(e.checkpoint.remainingPlan).toHaveLength(50)                     // protected: never dropped
    expect(e.checkpoint.originalRequest).toBe("r".repeat(6000))             // protected: never cut
    const note = e.checkpoint.constraints.find((c) => c.startsWith("(Mida:"))
    expect(note).toContain("decisions")
    expect(note).toContain("rejected")
  })
  it("when constraints already holds 50 real entries, the note lands on unresolvedIssue and no constraint is deleted", () => {
    const fat = sampleCheckpoint({
      constraints: Array.from({ length: 50 }, (_, i) => `constraint-${i}`),
      unresolvedIssue: "stuck on X",
      progress: Array.from({ length: 50 }, () => "p".repeat(2000)),
      evidence: Array.from({ length: 50 }, () => ({ field: "f", ref: "r".repeat(1500) })),
    })
    const e = wrap(fat)
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(e.checkpoint.constraints).toHaveLength(50)
    expect(e.checkpoint.constraints.every((c) => c.startsWith("constraint-"))).toBe(true)
    expect(e.checkpoint.unresolvedIssue).toContain("stuck on X")
    expect(e.checkpoint.unresolvedIssue).toContain("(Mida:")
    expect(e.checkpoint.unresolvedIssue).toContain("left out")
  })
  it("strings over 300 chars in unprotected fields are cut with an ellipsis when nothing is left to drop", () => {
    const fat = sampleCheckpoint({
      objective: "fit",
      originalRequest: "r".repeat(6000),
      remainingPlan: Array.from({ length: 27 }, () => "p".repeat(2000)),   // protected strings
      nextAction: "n".repeat(1500),                                        // protected string
      constraints: ["c".repeat(2000)],
      unresolvedIssue: "u".repeat(2000),
    })
    const e = wrap(fat)
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(e.checkpoint.constraints[0]).toBe("c".repeat(300) + "…")
    expect(e.checkpoint.unresolvedIssue).toBe("u".repeat(300) + "…")
    expect(e.checkpoint.nextAction).toBe("n".repeat(1500))
    expect(e.checkpoint.remainingPlan[0]).toBe("p".repeat(2000))
  })
  it("a checkpoint that can never fit throws too-large after shrinking — protected fields are never cut", () => {
    const huge = sampleCheckpoint({
      originalRequest: "r".repeat(6000),
      remainingPlan: Array.from({ length: 50 }, () => "p".repeat(2000)),
    })
    expect(() => wrap(huge)).toThrow(/too.large|65,?280|65,?536/i)
  })
  it("an envelope shrunk to the cap still encodes inside the real protocol payload", () => {
    // pad progress with schema-legal items until the envelope JSON sits just under
    // MAX_VALUE_BYTES, then measure the canonical ContextPayload the SDK actually seals —
    // the cap that matters on the wire
    const progress: string[] = []
    let padded = wrap(sampleCheckpoint({ progress }))
    while (Buffer.byteLength(JSON.stringify(padded)) + 2010 <= MAX_VALUE_BYTES) {
      progress.push("x".repeat(2000))
      padded = wrap(sampleCheckpoint({ progress }))
    }
    const tail = MAX_VALUE_BYTES - Buffer.byteLength(JSON.stringify(padded)) - 12
    if (tail > 0) {
      progress.push("x".repeat(tail))
      padded = wrap(sampleCheckpoint({ progress }))
    }
    expect(Buffer.byteLength(JSON.stringify(padded))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(Buffer.byteLength(JSON.stringify(padded))).toBeGreaterThan(MAX_VALUE_BYTES - 300)
    const payload: ContextPayload = {
      v: 1,
      value: { ...padded },
      kind: "EPISODE",
      provenance: { source: "AGENT_INFERRED" },
      tags: ["mida-checkpoint", padded.checkpoint.eventId],
    }
    expect(canonicalBytes(payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
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

/** The migration envelope a moved checkpoint carries beside `checkpoint` (migrate B2). */
const MIGRATION: MigrationEnvelope = {
  version: 1,
  originalChainId: "10143",
  originalContract: "0x1111111111111111111111111111111111111111",
  originalRecordId: `0x${"22".repeat(32)}`,
  originalCommitment: `0x${"33".repeat(32)}`,
  originalAuthor: `0x${"44".repeat(32)}`,
  originalCreatedAt: "2026-09-18T10:00:00.000Z",
  migratedAt: "2026-09-25T10:00:00.000Z",
}

const INPUT = { projectId: "p", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint: sampleCheckpoint({ eventId: "cp-snap-01" }) } as const

describe("migration envelope on checkpoints (migrate B2)", () => {
  it("an ordinary checkpoint serializes byte-identically to before the field existed — and carries no migration key", () => {
    const wrapped = wrapCheckpoint(INPUT)
    expect(JSON.stringify(wrapped)).toMatchInlineSnapshot(`"{"type":"mida.checkpoint.v1","projectId":"p","sessionId":"s","continuesSession":null,"compiledBy":"t","checkpoint":{"eventId":"cp-snap-01","agent":"claude-code","source":"hook-compiler","createdAt":"2026-09-21T10:00:00.000Z","objective":"o","nextAction":"n","originalRequest":null,"unresolvedIssue":null,"progress":[],"decisions":[],"rejected":[],"constraints":[],"artifacts":[],"remainingPlan":[],"evidence":[]}}"`)
    expect("migration" in wrapped).toBe(false)
    const unwrapped = unwrapCheckpoint({ ...wrapped })
    expect(unwrapped).not.toBeNull()
    expect("migration" in unwrapped!).toBe(false)
  })

  it("wrap and unwrap carry a migration envelope, and wrap(unwrap(x)) reproduces it value-for-value", () => {
    const wrapped = wrapCheckpoint({ ...INPUT, migration: MIGRATION })
    expect(wrapped.migration).toEqual(MIGRATION)
    expect(JSON.stringify(wrapped)).toContain('"migration"')
    const unwrapped = unwrapCheckpoint({ ...wrapped })
    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.migration).toEqual(MIGRATION)
    // the read → re-save shape migration relies on: unwrap, then wrap again — identical envelope
    expect(wrapCheckpoint(unwrapped!)).toEqual(wrapped)
    expect(JSON.stringify(wrapCheckpoint(unwrapped!))).toBe(JSON.stringify(wrapped))
  })

  it("an invalid migration envelope rejects the whole write with invalid-checkpoint naming the field", () => {
    const bad = { ...MIGRATION, originalContract: "not-hex" }
    let thrown: unknown
    try {
      wrapCheckpoint({ ...INPUT, migration: bad as MigrationEnvelope })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: "invalid-checkpoint" })
    expect((thrown as Error).message).toContain("originalContract")
    expect(unwrapCheckpoint({ ...wrapCheckpoint(INPUT), migration: bad })).toBeNull()
  })

  it("the envelope is inside the serialized bytes the value cap measures", () => {
    const delta =
      Buffer.byteLength(JSON.stringify(wrapCheckpoint({ ...INPUT, migration: MIGRATION }))) -
      Buffer.byteLength(JSON.stringify(wrapCheckpoint(INPUT)))
    // `,"migration":{…}` — the key plus the envelope itself, nothing else
    expect(delta).toBe(`,"migration":`.length + Buffer.byteLength(JSON.stringify(MIGRATION)))
  })

  it("the envelope counts toward the cap — its bytes force exactly one droppable entry out", () => {
    // measure the envelope's wire cost, then land the plain envelope strictly inside
    // (MAX_VALUE_BYTES - overhead, MAX_VALUE_BYTES] so one progress entry must go
    const overhead =
      Buffer.byteLength(JSON.stringify(wrapCheckpoint({ ...INPUT, migration: MIGRATION }))) -
      Buffer.byteLength(JSON.stringify(wrapCheckpoint(INPUT)))
    const progress: string[] = []
    let plain = wrapCheckpoint({ ...INPUT, checkpoint: sampleCheckpoint({ progress }) })
    while (Buffer.byteLength(JSON.stringify(plain)) + 2004 <= MAX_VALUE_BYTES) {
      progress.push("x".repeat(2000))
      plain = wrapCheckpoint({ ...INPUT, checkpoint: sampleCheckpoint({ progress }) })
    }
    const room = MAX_VALUE_BYTES - Buffer.byteLength(JSON.stringify(plain))
    const filler = Math.max(0, room - Math.ceil(overhead / 2))
    const checkpoint = sampleCheckpoint({ originalRequest: "r".repeat(filler), progress })
    plain = wrapCheckpoint({ ...INPUT, checkpoint })
    expect(plain.checkpoint.progress).toHaveLength(progress.length)
    const moved = wrapCheckpoint({ ...INPUT, checkpoint, migration: MIGRATION })
    expect(moved.migration).toEqual(MIGRATION)
    expect(Buffer.byteLength(JSON.stringify(moved))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(moved.checkpoint.progress).toHaveLength(progress.length - 1)
  })
})
