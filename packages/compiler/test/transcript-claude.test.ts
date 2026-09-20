// Port of spike/test/transcript-claude.test.mjs — the five readConversation
// cases, same inputs, same expectations. The sixth spike case ("worker sends
// the conversation, not the bookkeeping") runs end to end through the capture
// worker, which is Task 4's compileCheckpoint — it is covered there, not here.

import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readConversation } from "../src/index.js"

// All fixtures are built with JSON.stringify — never hand-escaped.

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mida-compiler-"))
}

function writeTranscript(dir: string, lines: string[]) {
  const p = path.join(dir, "transcript.jsonl")
  fs.writeFileSync(p, lines.join("\n"))
  return p
}

// A transcript shaped like the measured real one: a huge prompt_snapshot
// attachment (~75% of bytes), other bookkeeping lines, and a small real
// conversation carrying a constraint in the FIRST user message.
function measuredShape(dir: string) {
  let payload = ""
  for (let i = 0; payload.length < 120_000; i++) payload += `snapshot-row-${i}-pad `
  const p = writeTranscript(dir, [
    JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", text: payload } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Build a TokenBucket rate limiter. Hard constraint: no timers anywhere." } }),
    JSON.stringify({ type: "attachment", attachment: { type: "skill_listing", text: "many skills listed" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "planning the steps" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/bucket.mjs", content: "code" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file written ok" }] } }),
    JSON.stringify({ type: "system", subtype: "init", data: "bookkeeping" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done — all three tests pass." }] } }),
  ])
  return { path: p, payload }
}

describe("readConversation", () => {
  it("bookkeeping is skipped, constraint + final answer kept (G1)", () => {
    const dir = tmpdir()
    const { path: t, payload } = measuredShape(dir)
    const r = readConversation(t, { maxChars: 40_000 })

    expect(r.format).toBe("claude-jsonl")
    expect(r.text).toContain("no timers anywhere")
    expect(r.text).toContain("Done — all three tests pass.")
    for (const off of [0, 60_000, payload.length - 40]) {
      expect(r.text).not.toContain(payload.slice(off, off + 40))
    }
    expect(r.text.length).toBeLessThanOrEqual(40_000)
    expect(r.messagesTotal).toBe(5) // user + user(tool_result) + 3 assistant lines
    expect(r.omitted).toBe(0)
  })

  it("first user message pinned, middle omitted with marker (G1)", () => {
    const dir = tmpdir()
    const body = (tag: string) => `${tag} ` + "m".repeat(500)
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: body("FIRST-REQUEST") } }),
    ]
    for (let i = 1; i < 300; i++) {
      const role = i % 2 ? "assistant" : "user"
      lines.push(JSON.stringify({ type: role, message: { role, content: body(`MSG-${i}`) } }))
    }
    const t = writeTranscript(dir, lines)
    const r = readConversation(t, { maxChars: 40_000 })

    expect(r.messagesTotal).toBe(300)
    expect(r.text).toContain("FIRST-REQUEST")
    expect(r.text).toContain("MSG-299")
    expect(r.text.length).toBeLessThanOrEqual(40_000)
    expect(r.omitted).toBeGreaterThan(0)
    expect(r.omitted).toBe(r.messagesTotal - r.messagesKept)
    expect(r.text).toContain(`[… ${r.omitted} earlier messages omitted …]`)
  })

  it("long tool_result and tool_use input are cut with … (G1)", () => {
    const dir = tmpdir()
    const bigResult = "R".repeat(20_000)
    const bigInput = { code: "x".repeat(5_000) }
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: bigInput }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: bigResult }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "final" }] } }),
    ])
    const r = readConversation(t, { maxChars: 40_000 })

    expect(r.text).not.toContain(bigResult)
    expect(r.text).not.toContain("x".repeat(5_000))
    expect(r.text).toContain("[result] " + "R".repeat(600) + "…")
    expect(r.text.split("\n").some((l) => l.startsWith("[tool Write]") && l.endsWith("…"))).toBe(true)
  })

  it("secrets inside tool_result are redacted; L<n> are real line numbers (G1)", () => {
    const dir = tmpdir()
    const secret = "sk-test-abc123def456ghi789"
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "attachment", attachment: { type: "environment", text: "noise" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "date", text: "noise" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "please fix the flaky test" } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `token is ${secret}` }] } }),
    ])
    const r = readConversation(t, { maxChars: 40_000 })

    expect(r.text.startsWith("L3 user:")).toBe(true)
    expect(r.text).toContain("L4 user:")
    expect(r.text).toContain("[REDACTED]")
    expect(r.text).not.toContain(secret)
  })

  it("no user/assistant lines → unknown-tail fallback (G1)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "attachment", attachment: { text: "tail-content-marker" } }),
      "not json at all",
      JSON.stringify({ type: "system", subtype: "init" }),
    ])
    const r = readConversation(t, { maxChars: 40_000 })

    expect(r.format).toBe("unknown-tail")
    expect(r.text).toContain("tail-content-marker")
    expect(r.messagesTotal).toBe(0)
  })
})
