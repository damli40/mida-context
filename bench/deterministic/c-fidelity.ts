// Group C — fidelity. From docs/issue-register.md §3:
//   C1 the original user request reaches the injected context verbatim
//   C2 8-field rubric score — needs a real model to judge: skipped
//   C3 injected context <= 8,000 characters
//   C4 paraphrase duplicate rate <= 1.2
//   C5 the working chain wins selection even when a newer session exists
//   C6 a resolved issue stays resolved and a finished plan stays empty
//   C7 rejected saves are counted and the failing field names are logged
// The model is the stub; saves and reads go through the real chain. Every check
// gets its own approved project folder so merged scope never bleeds between checks.

import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { compileCheckpoint } from "../../packages/compiler/src/index.js"
import type { CompileInput } from "../../packages/compiler/src/index.js"
import type { Checkpoint } from "../../packages/checkpoint/src/index.js"
import {
  Runtime, approve, approveProject, authorNamesFor, buildHandoff, drainOnce, enqueue, init,
  readCheckpoints, requestAccess, saveCheckpoint,
} from "../../apps/midad/src/index.js"
import {
  STUB_MODEL, appendTranscript, assistantText, benchChain, benchDir, benchHome, fixtureJson,
  readFixture, sampleCheckpoint, userLine, writeTranscript,
} from "../lib/env.js"
import { needsRealModel, runGroup } from "../lib/checks.js"

const chain = await benchChain()
const dir = benchDir("c")
const home = benchHome("c")
const homeDir = join(dir, "user-home")
const runtime = await Runtime.open(home, chain.network)
await init(runtime, ["claude-code"])
await requestAccess(runtime, "claude-code")
await approve(runtime, "claude-code")

/** One owner-approved project folder per check — the merge never crosses project lines. */
async function project(tag: string): Promise<{ cwd: string; projectId: string }> {
  const cwd = join(dir, `work-${tag}`)
  mkdirSync(cwd, { recursive: true })
  const approval = await approveProject(runtime, { agent: "claude-code", cwd })
  return { cwd, projectId: approval.projectId }
}

const stub = (mode: string, capture?: string) => ({
  argv: [process.execPath, STUB_MODEL, mode, ...(capture === undefined ? [] : [capture])],
  label: `stub-${mode}`,
  timeoutMs: 15_000,
})

const handoffText = async (cwd: string): Promise<string> => {
  const hand = await buildHandoff(runtime, { agent: "claude-code", cwd, authorNames: authorNamesFor(runtime) })
  if (hand.kind !== "handoff") throw new Error(`handoff-${hand.kind}`)
  return hand.text
}

const T = (iso: string) => `2026-09-21T${iso}.000Z`
const save = (projectId: string, sessionId: string, checkpoint: Checkpoint, continuesSession: string | null = null) =>
  saveCheckpoint(runtime, "claude-code", { projectId, sessionId, continuesSession, compiledBy: "bench", checkpoint })

/** The bullets a rendered list section carries, counted from the injected text itself. */
function sectionBullets(text: string, title: string): string[] {
  const match = new RegExp(`${title}:\\n((?:- [^\\n]*\\n?)+)`).exec(text)
  return match === null ? [] : match[1].split("\n").filter((l) => l.startsWith("- "))
}

// C1 — red if the first user message stops reaching the injected text verbatim
// (paraphrased, truncated, or replaced by the model's own wording).
async function c1() {
  const { cwd, projectId } = await project("c1")
  const REQUEST = "Port the session cache to a trie and keep the public API identical. Do not change any exported name."
  const lines = readFixture("transcripts/trie-session.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown)
  const t = writeTranscript(homeDir, "proj", "c1.jsonl", lines)
  const first = await compileCheckpoint({ transcriptPath: t, agent: "claude-code", eventId: "ev-c1-01", cwd, homeDir, model: stub("ok"), attempts: 1 })
  if (!first.ok) throw new Error("compile-1-failed")
  await save(projectId, "c1", first.checkpoint)
  // a later save in the same session still carries the same first message
  appendTranscript(t, assistantText("second save of the same session"))
  const second = await compileCheckpoint({ transcriptPath: t, agent: "claude-code", eventId: "ev-c1-02", cwd, homeDir, model: stub("ok"), attempts: 1, previous: first.checkpoint })
  if (!second.ok) throw new Error("compile-2-failed")
  await save(projectId, "c1", second.checkpoint)
  const read = await readCheckpoints(runtime, "claude-code", projectId)
  const records = read.checkpoints.filter((c) => c.sessionId === "c1")
  const stored = records.length === 2 && records.every((c) => c.checkpoint.originalRequest === REQUEST)
  const text = await handoffText(cwd)
  const injected = text.includes(`ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):\n${REQUEST}`)
  return { pass: stored && injected, value: { stored, injected, records: records.length }, limit: null }
}

// C3 — red if the injected block can grow past its 8,000-char budget: six
// agent-tool saves union into far more than 8k of progress, and the render
// must trim down to the cap rather than leak it all.
async function c3() {
  const { cwd, projectId } = await project("c3")
  for (let i = 0; i < 6; i += 1) {
    await save(
      projectId,
      "c3",
      sampleCheckpoint({
        eventId: `ev-c3-0${i}`,
        source: "agent-tool",
        createdAt: T(`1${i}:00:00`),
        objective: "fat union",
        progress: Array.from({ length: 15 }, (_, j) => `entry ${i}-${j} ${"p".repeat(380)}`),
        decisions: Array.from({ length: 5 }, (_, j) => ({ decision: `d${i}-${j} ${"d".repeat(60)}`, rationale: `r${"r".repeat(60)}` })),
      }),
    )
  }
  const text = await handoffText(cwd)
  return { pass: text.length <= 8_000, value: text.length, limit: 8_000, unit: "chars" }
}

// C4 — red if the merge unions paraphrased restatements: three hook-compiler
// saves carry the SAME decision in different words, and the injected text must
// show the newest wording once — not all three phrasings.
async function c4() {
  const { cwd, projectId } = await project("c4")
  const wording = fixtureJson<{ decisionVariants: { decision: string; rationale: string }[] }>("stub-wording.json")
  for (let i = 0; i < wording.decisionVariants.length; i += 1) {
    await save(
      projectId,
      "c4",
      sampleCheckpoint({
        eventId: `ev-c4-0${i}`,
        createdAt: T(`12:0${i}:00`),
        objective: "same decision, new words",
        decisions: [wording.decisionVariants[i]!],
        progress: [`variant save ${i}`],
      }),
    )
  }
  const text = await handoffText(cwd)
  const bullets = sectionBullets(text, "Decisions")
  const distinctGroundTruth = 1
  const rate = bullets.length / distinctGroundTruth
  return { pass: rate <= 1.2, value: rate, limit: 1.2, detail: { bullets: bullets.length, saves: wording.decisionVariants.length } }
}

// C5 — red if a newer session with no real work in it can displace the chain
// that is actually mid-task, or if the displaced chain stops being listed.
async function c5() {
  const { cwd, projectId } = await project("c5")
  await save(projectId, "c5-work", sampleCheckpoint({
    eventId: "ev-c5-w1", createdAt: T("10:00:00"), objective: "the real work",
    progress: ["step 6 done"], remainingPlan: ["finish step 7"], decisions: [{ decision: "lazy refill", rationale: "no timers" }],
  }))
  await save(projectId, "c5-work", sampleCheckpoint({
    eventId: "ev-c5-w2", createdAt: T("10:05:00"), objective: "the real work",
    progress: ["step 6 done", "step 7 started"], remainingPlan: ["finish step 7"],
  }))
  await save(projectId, "c5-cont", sampleCheckpoint({
    eventId: "ev-c5-c1", createdAt: T("10:10:00"), objective: "the real work",
    progress: ["step 7 almost done"], remainingPlan: ["finish step 7"],
  }), "c5-work")
  // newer than the working chain but carrying nothing — it must not win selection
  await save(projectId, "c5-fresh", sampleCheckpoint({
    eventId: "ev-c5-f1", createdAt: T("10:20:00"), objective: "a brand-new question",
    nextAction: "wait for the user",
  }))
  const text = await handoffText(cwd)
  const workWon = text.includes("finish step 7") && text.includes("step 7 almost done")
  const otherListed = text.includes("Other recent sessions") && text.includes("a brand-new question")
  return { pass: workWon && otherListed, value: { workWon, otherListed }, limit: null }
}

// C6 — red if a resolved issue resurrects or a finished plan regrows: the newest
// hook-compiler save's empty fields are authoritative, not missing data.
async function c6() {
  const { cwd, projectId } = await project("c6")
  const wording = fixtureJson<{ decisionVariants: { decision: string; rationale: string }[] }>("stub-wording.json")
  await save(projectId, "c6", sampleCheckpoint({
    eventId: "ev-c6-01", createdAt: T("13:00:00"), objective: "finish the limiter",
    unresolvedIssue: "bucket test flakes when two takes land in the same ms",
    remainingPlan: ["fix the flake"],
  }))
  await save(projectId, "c6", sampleCheckpoint({
    eventId: "ev-c6-02", createdAt: T("13:05:00"), objective: "finish the limiter",
    unresolvedIssue: null, remainingPlan: [],
  }))
  await save(projectId, "c6", sampleCheckpoint({
    eventId: "ev-c6-03", createdAt: T("13:10:00"), objective: "finish the limiter",
    unresolvedIssue: null, remainingPlan: [],
    decisions: [wording.decisionVariants[0]!],
  }))
  const text = await handoffText(cwd)
  const issueResolved = text.includes("Unresolved issue: none") && !text.includes("bucket test flakes")
  const planEmpty = text.includes("(nothing left in the original request")
  return { pass: issueResolved && planEmpty, value: { issueResolved, planEmpty }, limit: null }
}

// C7 — red if rejected saves stop being counted with their failing field names:
// an invalid checkpoint and an oversized one must both land in the drain log
// with a stable reason and the names of the fields that failed.
async function c7() {
  const { cwd, projectId } = await project("c7")
  const transcripts: Record<string, string> = {
    ok: writeTranscript(homeDir, "proj", "c7-ok.jsonl", [userLine("a good save")]),
    invalid: writeTranscript(homeDir, "proj", "c7-invalid.jsonl", [userLine("an invalid save")]),
    fat: writeTranscript(homeDir, "proj", "c7-fat.jsonl", [userLine("an oversized save")]),
  }
  const compile = async (input: CompileInput) =>
    compileCheckpoint({
      ...input,
      model: stub(Object.entries(transcripts).find(([, p]) => p === input.transcriptPath)![0]),
      attempts: 1,
    })
  const base = { home, runtime, compile, homeDir }
  enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "c7-ok", transcriptPath: transcripts.ok, cwd, error: null })
  enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "c7-invalid", transcriptPath: transcripts.invalid, cwd, error: null })
  enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "c7-fat", transcriptPath: transcripts.fat, cwd, error: null })
  // the invalid job is retried: drain it three times with the clock past each backoff
  const t0 = Date.now()
  const r1 = await drainOnce({ ...base, now: () => new Date(t0) })
  const r2 = await drainOnce({ ...base, now: () => new Date(t0 + 180_000) })
  const r3 = await drainOnce({ ...base, now: () => new Date(t0 + 480_000) })
  const saved = r1.saved + r2.saved + r3.saved
  const log = readFileSync(home.path("logs/drain.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const invalidLines = log.filter((l) => l.reason === "invalid-checkpoint")
  const tooLarge = log.some((l) => l.reason === "too-large" && l.outcome === "bad")
  const fieldsNamed = invalidLines.some((l) => Array.isArray(l.fields) && (l.fields as unknown[]).length > 0)
  const stored = await readCheckpoints(runtime, "claude-code", projectId)
  return {
    pass: invalidLines.length > 0 && fieldsNamed && tooLarge && saved === 1 && stored.checkpoints.length === 1,
    value: { rejected: 2, saved, fieldsNamed, tooLarge, stored: stored.checkpoints.length },
    limit: null,
  }
}

try {
  await runGroup([
    { id: "C1", run: c1 },
    needsRealModel("C2"),
    { id: "C3", run: c3 },
    { id: "C4", run: c4 },
    { id: "C5", run: c5 },
    { id: "C6", run: c6 },
    { id: "C7", run: c7 },
  ])
} finally {
  await runtime.close()
  await chain.env.stop()
}
