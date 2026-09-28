// buildExtractPrompt — C1. When the drainer still holds the session's last
// checkpoint, the model must see it as something to UPDATE, not a fresh task.
// M3-H: the checkpoint block moved BELOW the transcript so the prompt's head —
// RULES, the TRANSCRIPT line, the transcript itself — is a byte-exact prefix
// every compile of the session shares, which is what DeepSeek's and Kimi's
// automatic prompt caches key on. The first compile's prompt must stay exactly
// what it was before the move, and the second compile must literally begin
// with those bytes.

import { describe, expect, it } from "vitest"
import { CONTENT_FIELDS, type Checkpoint } from "@mida/checkpoint"
import { buildExtractPrompt, EXTRACT_PROMPT } from "../src/index.js"

const previous: Checkpoint = {
  eventId: "evt-prev0001",
  agent: "claude-code",
  source: "hook-compiler",
  createdAt: "2026-09-21T09:00:00.000Z",
  objective: "Implement the rate limiter",
  originalRequest: "Build a rate limiter in 3 steps",
  progress: ["skeleton written"],
  decisions: [{ decision: "lazy refill on each call", rationale: "timers are banned" }],
  rejected: [{ approach: "background interval refill", why: "no-timers constraint" }],
  constraints: ["no dependencies"],
  artifacts: ["src/a.ts"],
  unresolvedIssue: null,
  nextAction: "add tests",
  remainingPlan: ["2. add tests", "3. write README"],
  evidence: [{ field: "artifacts[0]", ref: "file:src/a.ts" }],
}

// The first-compile prompt as it stood before the reorder — the no-previous
// output must stay byte-identical to this, so it is written out in full rather
// than rebuilt from the constants it would then tautologically match.
const FIRST_COMPILE_PROMPT = `You are extracting a compact task checkpoint from an AI coding agent's transcript. Another agent will continue this work from your summary alone.

The transcript below is a list of blocks, each headed "L<n> <role>:" where <n> is the 1-based line number in the transcript file and <role> is "user" or "assistant". The FIRST block is the user's original request — it carries the objective and the constraints; read it first and weight it most. The blocks after it are the most recent messages; a line "[… N earlier messages omitted …]" marks messages dropped in between. A block headed "user — later messages you typed" lists, oldest first, messages the user typed later in the session that fall outside the recent messages. The user's words outrank the assistant's: when a later user message changes the goal or a requirement, the objective, nextAction and remainingPlan follow the user's LATEST instruction, and any decision it caused gives the user as its rationale ("the user asked …"), never the assistant's planning. A block "[interrupted here: …]" is not an instruction to stop or wait: nextAction is the work that was in progress. If the block names a tool call that was not approved, that call is undecided and the next agent must ask the user before running it.

Output ONLY a single JSON object — no prose, no code fence — with exactly these fields:

- "objective": string — what the task is trying to achieve (required)
- "progress": string[] — what is already done
- "decisions": [{"decision": string, "rationale": string}] — choices made and why
- "rejected": [{"approach": string, "why": string}] — approaches considered and dropped
- "constraints": string[] — rules the work must keep obeying
- "artifacts": string[] — file paths created or modified
- "unresolvedIssue": string | null — the current blocker or open question
- "nextAction": string — the single next thing to do (required)
- "remainingPlan": string[] — every step or requirement in the original request that is NOT finished yet, one entry each, in the request's own words including names of functions, classes and files. Do not summarise several steps into one. If the request lists numbered steps, keep the numbers.
- "evidence": [{"field": string, "ref": string}] — where each claim came from. Use the block's line number: {"field": "decisions[0]", "ref": "transcript:L12"} (or a range like "transcript:L12-L15"), or a file path like {"field": "artifacts[0]", "ref": "file:src/x.js"}

Rules:
- Cite an evidence ref for every non-obvious claim.
- Write null or empty arrays rather than inventing content. Never guess.
- Never copy secrets, tokens, keys, or long transcript passages. Summarize, do not quote.
- Keep every string under 500 characters. Be compact.

TRANSCRIPT (possibly truncated, secrets already redacted):

L1 user: do the thing`

describe("buildExtractPrompt", () => {
  it("without a previous checkpoint the prompt is byte-identical to what it was before the reorder", () => {
    const prompt = buildExtractPrompt("L1 user: do the thing")
    expect(prompt).toBe(FIRST_COMPILE_PROMPT)
    expect(prompt).not.toContain("PREVIOUS CHECKPOINT")
  })

  it("a second compile's prompt starts with the first compile's exact bytes — the cacheable prefix", () => {
    const transcript = "L1 user: do the thing"
    const firstCompile = buildExtractPrompt(transcript)
    const secondCompile = buildExtractPrompt(transcript, previous)
    expect(secondCompile.startsWith(firstCompile)).toBe(true)
    expect(secondCompile.length).toBeGreaterThan(firstCompile.length)
  })

  it("with a previous checkpoint the prompt carries its ten content fields after the transcript", () => {
    const prompt = buildExtractPrompt("L1 user: do the thing", previous)
    const prevAt = prompt.indexOf("PREVIOUS CHECKPOINT")
    const transcriptAt = prompt.indexOf("TRANSCRIPT (possibly truncated")
    expect(prevAt).toBeGreaterThanOrEqual(0)
    expect(transcriptAt).toBeGreaterThanOrEqual(0)
    // the cacheable prefix ends only where the transcript does — the
    // ever-changing checkpoint block sits after it
    expect(prevAt).toBeGreaterThan(transcriptAt + "L1 user: do the thing".length)

    // the line after the instruction is the checkpoint's JSON, holding exactly
    // the ten model-writable fields in their existing wording
    const lines = prompt.split("\n")
    const json = JSON.parse(lines[lines.findIndex((l) => l.startsWith("PREVIOUS CHECKPOINT")) + 1]!) as Record<string, unknown>
    expect([...Object.keys(json)].sort()).toEqual([...CONTENT_FIELDS].sort())
    expect(json.decisions).toEqual(previous.decisions)
    expect(json.remainingPlan).toEqual(previous.remainingPlan)

    // ids, dates, the source tag and the user's verbatim request never go back to the model
    expect(json.eventId).toBeUndefined()
    expect(json.createdAt).toBeUndefined()
    expect(json.agent).toBeUndefined()
    expect(json.source).toBeUndefined()
    expect(json.originalRequest).toBeUndefined()
  })

  // K5: a transcript that opened on scaffolding and yielded no request must
  // not be described as having one — the model infers the task instead.
  it("when no original request was captured the prompt says so — it never calls the first block one", () => {
    const prompt = buildExtractPrompt("L1 user: keep going", undefined, false)
    expect(prompt).toContain("No original request was captured")
    expect(prompt).toContain("infer the task from the conversation and the summary")
    expect(prompt).not.toContain("The FIRST block is the user's original request")
    expect(prompt).not.toContain("PREVIOUS CHECKPOINT")
  })

  // P-1: the pinned group of later typed messages is part of the transcript
  // contract — both request variants must say what it is and that the user's
  // own words outrank the assistant's when the goal changed mid-session.
  it("both prompt variants describe the typed-messages group and who wins", () => {
    const group = `A block headed "user — later messages you typed" lists, oldest first, messages the user typed later in the session that fall outside the recent messages.`
    const outrank = `the objective, nextAction and remainingPlan follow the user's LATEST instruction`
    expect(buildExtractPrompt("L1 user: keep going", undefined, true)).toContain(group)
    expect(buildExtractPrompt("L1 user: keep going", undefined, true)).toContain(outrank)
    expect(buildExtractPrompt("L1 user: keep going", undefined, false)).toContain(group)
    expect(buildExtractPrompt("L1 user: keep going", undefined, false)).toContain(outrank)
  })

  // in-20 T-2, reworded in in-21 U-1: a transcript can end on "[interrupted
  // here: …]". Both variants must say it is bookkeeping, not a "stop and wait"
  // instruction, and that a named-but-unapproved call is undecided — asking the
  // user, never re-running it on the next agent's own authority.
  it("both variants explain the interrupted-here block is not an instruction", () => {
    const sentence = `A block "[interrupted here: …]" is not an instruction to stop or wait: nextAction is the work that was in progress. If the block names a tool call that was not approved, that call is undecided and the next agent must ask the user before running it.`
    expect(buildExtractPrompt("L1 user: keep going", undefined, true)).toContain(sentence)
    expect(buildExtractPrompt("L1 user: keep going", undefined, false)).toContain(sentence)
    expect(buildExtractPrompt("L1 user: keep going", undefined, true)).not.toContain("did not run")
  })

  it("a secret sitting in the previous checkpoint is scrubbed before it reaches the model", () => {
    const leaky = { ...previous, progress: ["set sk-live-abcdefgh12345678 in env"] }
    const prompt = buildExtractPrompt("text", leaky)
    expect(prompt).not.toContain("sk-live-abcdefgh12345678")
    expect(prompt).toContain("[REDACTED]")
  })
})
