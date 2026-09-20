// Port of the readConversation ("reader") cases of
// spike/test/original-request.test.mjs — same inputs, same expectations.
// The spike file's schema cases were ported to @mida/checkpoint's
// schema.test.ts in Task 1; its four capture-worker end-to-end cases belong
// to Task 4's compileCheckpoint and are covered there, not here.
//
// H1: every checkpoint carries the user's original request verbatim, taken
// from the transcript's first real user message — never from the model,
// because a summariser compresses away the remaining steps.

import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readConversation } from "../src/index.js"

// The request names the remaining work (KeyedLimiter, README) that the
// summarised objective compressed away in the real handoff.
const REQUEST =
  "Implement a rate limiter in src/bucket.mjs in 5 steps: " +
  "1) TokenBucket(capacity, refillPerSec) with tryTake(n); " +
  "2) an injectable clock so tests never sleep; " +
  "3) msUntilAvailable(n); " +
  "4) a KeyedLimiter with a max number of keys and LRU eviction; " +
  "5) a README usage section. No timers, no dependencies, synchronous API."

const SECRET = "sk-test-abc123def456ghi789"

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mida-compiler-"))
}

function writeTranscript(dir: string, lines: string[]) {
  const p = path.join(dir, "transcript.jsonl")
  fs.writeFileSync(p, lines.join("\n"))
  return p
}

const userLine = (content: unknown) =>
  JSON.stringify({ type: "user", message: { role: "user", content } })
const assistantLine = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })

describe("readConversation firstUserMessage", () => {
  it("is the user's first message, verbatim", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", text: "noise" } }),
      userLine(REQUEST),
      assistantLine("working on it"),
    ])
    const r = readConversation(t)
    expect(r.format).toBe("claude-jsonl")
    expect(r.firstUserMessage).toBe(REQUEST)
  })

  it("a first user line holding only a tool_result is skipped", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      userLine([{ type: "tool_result", tool_use_id: "t1", content: "resumed output" }]),
      userLine([{ type: "text", text: REQUEST }]),
      assistantLine("ok"),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe(REQUEST)
  })

  it("a secret inside the first user message is redacted", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      userLine(`build the limiter; my key is ${SECRET} in case you need it`),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toContain("[REDACTED]")
    expect(r.firstUserMessage).not.toContain(SECRET)
  })

  it("a 9,000-char first message is cut to 6,000 chars with …", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [userLine("x".repeat(9_000))])
    const r = readConversation(t)
    expect(r.firstUserMessage).toHaveLength(6_000)
    expect(r.firstUserMessage!.endsWith("…")).toBe(true)
  })

  it("unknown-tail transcripts get firstUserMessage null", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, ["not json at all", JSON.stringify({ type: "system" })])
    const r = readConversation(t)
    expect(r.format).toBe("unknown-tail")
    expect(r.firstUserMessage).toBeNull()
  })
})
