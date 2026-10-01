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
    expect(e.checkpoint.evidence.at(-1)!.ref).toBe(big.evidence.at(-1)!.ref) // newest evidence kept
    const note = e.checkpoint.constraints.find((c) => c.startsWith("(Mida:"))
    expect(note).toContain("progress")
    expect(note).toContain("evidence")
    expect(note).toContain("left out")
    expect(e.checkpoint.originalRequest).toBe("keep me")
    expect(e.checkpoint.remainingPlan).toEqual(["1. a"])
  })
  // CAP-29: evidence names its target by position, so dropping the oldest progress used to leave
  // every evidence line pointing at a different progress entry than the one it was written for.
  it("evidence follows its entry when the oldest progress is dropped, and goes when its entry goes", () => {
    const big = sampleCheckpoint({
      progress: Array.from({ length: 40 }, (_, i) => `step-${i} ${"p".repeat(1980)}`),
      evidence: Array.from({ length: 40 }, (_, i) => ({ field: `progress[${i}]`, ref: `transcript:L${i}` })),
    })
    const e = wrap(big)
    const left = e.checkpoint.progress.length
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(40)                                           // some progress was dropped
    expect(e.checkpoint.evidence).toHaveLength(left)                        // evidence for dropped entries went with them
    for (const { field, ref } of e.checkpoint.evidence) {
      const at = Number(/^progress\[(\d+)\]$/.exec(field)![1])
      expect(e.checkpoint.progress[at]!.startsWith(`step-${ref.slice("transcript:L".length)} `), `${field} = ${ref}`).toBe(true)
    }
    const note = e.checkpoint.constraints.find((c) => c.startsWith("(Mida:"))
    expect(note).toContain(`left out ${40 - left} progress, ${40 - left} evidence`)
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
  // UF-K: the reviewed case. A compile already cut 51 constraints to 50 and wrote its trim note
  // onto a nearly-full unresolvedIssue; the envelope is still over the byte cap, so wrap appends
  // its own size note — pushing the field past 2,000 chars, which used to store a save that
  // unwrapCheckpoint could not read back at all (it returned null and the save was skipped).
  it("a save stays readable when wrap's size note lands on a nearly-full unresolvedIssue (UF-K)", () => {
    const compileNote = "(Mida: a list holds at most 50 entries. Left out: the 1 oldest constraint.)"
    const issue = `${"i".repeat(2000 - compileNote.length - 3)} | ${compileNote}` // exactly 2,000 chars
    const fat = sampleCheckpoint({
      constraints: Array.from({ length: 50 }, (_, i) => `constraint-${i} ${"c".repeat(1200)}`),
      unresolvedIssue: issue,
      progress: ["p".repeat(2000), "q".repeat(2000)],
    })
    const e = wrap(fat)
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    expect(e.checkpoint.constraints).toHaveLength(50)
    expect(e.checkpoint.constraints.every((c) => c.startsWith("constraint-"))).toBe(true)
    const stored = e.checkpoint.unresolvedIssue!
    expect(stored.length).toBeLessThanOrEqual(2000)
    expect(stored).toContain("(Mida: left out") // wrap's own note survived whole
    expect(stored).toContain(compileNote)       // and so did the note the compile wrote
    // the stored save must read back — a checkpoint wrap produced that fails validation is a
    // silent loss: the chain stores it, then every reader sees null
    const back = unwrapCheckpoint(JSON.parse(JSON.stringify(e)))
    expect(back).not.toBeNull()
    expect(back!.checkpoint.unresolvedIssue).toBe(stored)
  })
  // UF-L: the review's exact case — an unresolvedIssue holding an old "(Mida: …)" note followed
  // by long free text. The old joinIssueNote treated everything after the first " | (Mida:" as
  // notes, so the trailing text inflated the note tail past the string cap and the final
  // re-validation threw: the save was LOST after three compiles. Now every "(Mida: …)" segment is
  // kept whole and the free text takes the cut alone.
  it("an issue holding an old note followed by long text wraps without throwing and keeps every note whole (UF-L)", () => {
    const oldNote = "(Mida: a list holds at most 50 entries. Left out: the 2 oldest decisions.)"
    const fat = sampleCheckpoint({
      constraints: Array.from({ length: 50 }, (_, i) => `constraint-${i} ${"c".repeat(1200)}`),
      unresolvedIssue: `x | ${oldNote} ${"i".repeat(1900)}`,
      progress: ["p".repeat(2000), "q".repeat(2000)],
    })
    const e = wrap(fat) // must not throw — the old code's re-validation killed this save
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    const stored = e.checkpoint.unresolvedIssue!
    expect(stored.length).toBeLessThanOrEqual(2000)
    // every "(Mida:" segment in the field is a WHOLE note — none is sliced open by a cut
    const segments = stored.match(/\(Mida:[^)]*\)?/g) ?? []
    expect(segments.length).toBeGreaterThan(0)
    for (const s of segments) expect(s.endsWith(")"), s).toBe(true)
    expect(stored).toContain(oldNote)
    const back = unwrapCheckpoint(JSON.parse(JSON.stringify(e)))
    expect(back).not.toBeNull()
    expect(back!.checkpoint.unresolvedIssue).toBe(stored)
  })
  it("an issue of 1,000 chars plus the limit note keeps the note whole when the 300-char cut lands (UF-L)", () => {
    const limitNote = "(Mida: a list holds at most 50 entries. Older decisions were left out.)"
    const fat = sampleCheckpoint({
      objective: "fit",
      originalRequest: "r".repeat(6000),
      remainingPlan: Array.from({ length: 27 }, () => "p".repeat(2000)),
      nextAction: "n".repeat(1500),
      constraints: ["c".repeat(2000), "d".repeat(1500)],
      unresolvedIssue: `${"i".repeat(1000)} | ${limitNote}`,
    })
    const e = wrap(fat)
    const stored = e.checkpoint.unresolvedIssue!
    expect(stored.length).toBeLessThanOrEqual(2000)
    expect(stored.endsWith(` | ${limitNote}`)).toBe(true)  // the note survives the text cut
    expect(stored.startsWith(`${"i".repeat(300)}…`)).toBe(true) // and the text is what got cut
  })
  // UF-N: an unclosed "(Mida:" is ordinary TEXT, not a note — only a complete "(Mida: …)" with
  // its closing bracket counts. Under the old segment rule the unclosed opener swallowed the
  // whole rest of the string (and the size note behind it) into one "note".
  it("an unclosed `(Mida:` is ordinary text — the text is kept, shortened to fit, and the size note stays whole (UF-N)", () => {
    const fat = sampleCheckpoint({
      constraints: Array.from({ length: 50 }, (_, i) => `constraint-${i} ${"c".repeat(1200)}`),
      // 1,950 i's: the input just fits the 2,000-char string cap, but fused with the size note
      // the fake "note" the old code built overflows it — so the whole tail was dropped
      unresolvedIssue: `see | (Mida: never closed ${"i".repeat(1950)}`,
      progress: ["p".repeat(2000), "q".repeat(2000)],
    })
    const e = wrap(fat)
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_VALUE_BYTES)
    const stored = e.checkpoint.unresolvedIssue!
    expect(stored.length).toBeLessThanOrEqual(2000)
    // the unclosed opener is TEXT: it sits at the start of the kept text and its run of i's is
    // what took the cut — under the old code the unclosed tail became a fake "note" longer than
    // the string cap, so the whole field collapsed to just "see" and the size note vanished
    expect(stored.startsWith("see | (Mida: never closed")).toBe(true)
    expect(stored).not.toContain("i".repeat(2000))
    expect(stored).toContain("i".repeat(100))
    // the size note is its own complete " | "-separated segment at the end
    const last = stored.split(" | ").at(-1)!
    expect(last.startsWith("(Mida:")).toBe(true)
    expect(last).toMatch(/to fit the size limit\)$/)
    const back = unwrapCheckpoint(JSON.parse(JSON.stringify(e)))
    expect(back).not.toBeNull()
    expect(back!.checkpoint.unresolvedIssue).toBe(stored)
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
