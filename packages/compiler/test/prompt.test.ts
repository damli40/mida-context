// buildExtractPrompt — C1. When the drainer still holds the session's last
// checkpoint, the model must see it as something to UPDATE, not a fresh task:
// its ten content fields land in the prompt before the TRANSCRIPT line, and
// nothing else (ids, dates, the user's own words) goes back to the model.

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

describe("buildExtractPrompt", () => {
  it("without a previous checkpoint the prompt is the extract prompt plus the transcript", () => {
    const prompt = buildExtractPrompt("L1 user: do the thing")
    expect(prompt).toBe(`${EXTRACT_PROMPT}\nL1 user: do the thing`)
    expect(prompt).not.toContain("PREVIOUS CHECKPOINT")
  })

  it("with a previous checkpoint the prompt carries its ten content fields before the TRANSCRIPT line", () => {
    const prompt = buildExtractPrompt("L1 user: do the thing", previous)
    const prevAt = prompt.indexOf("PREVIOUS CHECKPOINT")
    const transcriptAt = prompt.indexOf("TRANSCRIPT (possibly truncated")
    expect(prevAt).toBeGreaterThanOrEqual(0)
    expect(transcriptAt).toBeGreaterThan(prevAt)

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

  it("a secret sitting in the previous checkpoint is scrubbed before it reaches the model", () => {
    const leaky = { ...previous, progress: ["set sk-live-abcdefgh12345678 in env"] }
    const prompt = buildExtractPrompt("text", leaky)
    expect(prompt).not.toContain("sk-live-abcdefgh12345678")
    expect(prompt).toContain("[REDACTED]")
  })
})
