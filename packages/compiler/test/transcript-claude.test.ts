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
  it("collects the cwd each line records — first-seen order, broken and cwd-less lines skipped", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", cwd: "/work/one", message: { content: "hi" } }),
      "not json{",
      JSON.stringify({ type: "assistant", cwd: "/work/two", message: { content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "user", cwd: "/work/one", message: { content: "again" } }),
      JSON.stringify({ type: "summary", summary: "no folder recorded here" }),
    ])
    const r = readConversation(t)
    expect(r.format).toBe("claude-jsonl")
    expect(r.cwds).toEqual(["/work/one", "/work/two"])
  })

  it("a transcript that records no folders answers an empty cwds list", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
    ])
    expect(readConversation(t).cwds).toEqual([])
    // and an unreadable-format file collects nothing either
    const weird = writeTranscript(dir, ["plain text, not json"])
    expect(readConversation(weird).cwds).toEqual([])
  })

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
    // ~300 B per line keeps the file inside the one-shot read window — this
    // case measures the maxChars budget, not file truncation.
    const body = (tag: string) => `${tag} ` + "m".repeat(200)
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

  it("a pinned first message bigger than maxChars is cut inside the budget (A9)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "REQUEST " + "r".repeat(2_000) } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "later reply" }] } }),
    ])
    const r = readConversation(t, { maxChars: 500 })
    expect(r.text.length).toBeLessThanOrEqual(500)
    expect(r.firstUserMessage).toBe("REQUEST " + "r".repeat(2_000))
  })

  it("a secret nested under a sensitive key name in tool_use input is redacted (A7)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { a: { b: { c: { password: "correct horse battery staple" } } } } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "wrote { apiKey: plainWordsHere42 }" }] }],
        },
      }),
    ])
    const r = readConversation(t, { maxChars: 40_000 })
    expect(r.text).not.toContain("correct horse battery staple")
    expect(r.text).toContain("[REDACTED]")
  })

  // F2: after /compact, Claude Code's own scaffolding arrives as user-role
  // lines ahead of the real request — none of it may become firstUserMessage,
  // and the pinned head block must be the line the pick came from.
  it("Claude Code scaffolding is never the user's request — tags, isMeta and isCompactSummary all skip", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "condensed summary of the earlier session" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>watch out</system-reminder>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Refactor the parser to stream input" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("Refactor the parser to stream input")
    // the pinned block is the same line firstUserMessage came from — L5, not
    // the first user-role block in the file
    expect(r.text.startsWith("L5 user:")).toBe(true)
  })

  it("the pin follows the picked line even when an earlier user block renders", () => {
    const dir = tmpdir()
    // A bare tool_result user line renders a block but carries no request text —
    // the pin must not land on it while firstUserMessage comes from a later line.
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "resumed tool output" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "the actual request" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ])
    const r = readConversation(t, { maxChars: 500 })
    expect(r.firstUserMessage).toBe("the actual request")
    expect(r.text.startsWith("L2 user:")).toBe(true)
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

  // F3: a transcript bigger than the head+tail budgets is never read whole —
  // the reader opens it once and touches at most 64 KiB + 60,000 bytes.
  it("a 5 MB transcript is read only through bounded head and tail windows", () => {
    const dir = tmpdir()
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "FIRST-REQUEST build the thing" } }),
    ]
    let size = lines[0]!.length + 1
    let i = 0
    while (size < 5 * 1024 * 1024) {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `middle-${i} ` + "m".repeat(1_500) }] },
      })
      lines.push(line)
      size += line.length + 1
      i += 1
    }
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "FINAL-TAIL end of session" }] } }))
    const t = writeTranscript(dir, lines)

    let bytesRead = 0
    const readFilePaths: unknown[] = []
    const origReadFileSync = fs.readFileSync
    const origReadSync = fs.readSync
    // @ts-expect-error deliberate measurement shim around the real reader
    fs.readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
      readFilePaths.push(args[0])
      return origReadFileSync(...args)
    }
    // @ts-expect-error deliberate measurement shim around the real reader
    fs.readSync = (...args: Parameters<typeof fs.readSync>) => {
      const n = origReadSync(...args)
      bytesRead += n
      return n
    }
    let r: ReturnType<typeof readConversation>
    try {
      r = readConversation(t)
    } finally {
      fs.readFileSync = origReadFileSync
      fs.readSync = origReadSync
    }

    expect(readFilePaths).not.toContain(t)
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024 + 60_000)
    expect(r.format).toBe("claude-jsonl")
    expect(r.firstUserMessage).toBe("FIRST-REQUEST build the thing")
    expect(r.text).toContain("FIRST-REQUEST")
    expect(r.text).toContain("FINAL-TAIL end of session")
    // the unread middle is flagged, never silently dropped
    expect(r.text).toContain("[… earlier messages omitted …]")
    // tail lines keep their content but are numbered relative to the window
    expect(r.text).toMatch(/L~\d+ assistant:\nFINAL-TAIL/)
  })

  it("a tail window that opens mid-line drops the partial line", () => {
    const dir = tmpdir()
    // One giant line straddles the tail window's start: the window opens
    // inside it, so the partial first segment must be dropped, not parsed.
    const giant = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "PADMARKER " + "p".repeat(200_000) }] },
    })
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "the request" } }),
      giant,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "CLOSING-LINE done" }] } }),
    ])
    const r = readConversation(t)
    expect(r.format).toBe("claude-jsonl")
    expect(r.firstUserMessage).toBe("the request")
    expect(r.text).toContain("CLOSING-LINE done")
    expect(r.text).not.toContain("PADMARKER")
  })

  it("a file inside the budgets is read once end to end — unchanged behaviour", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "small request" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "small reply" }] } }),
    ])
    let reads = 0
    const origReadSync = fs.readSync
    // @ts-expect-error deliberate measurement shim around the real reader
    fs.readSync = (...args: Parameters<typeof fs.readSync>) => {
      reads += 1
      return origReadSync(...args)
    }
    let r: ReturnType<typeof readConversation>
    try {
      r = readConversation(t)
    } finally {
      fs.readSync = origReadSync
    }
    expect(reads).toBe(1)
    expect(r.format).toBe("claude-jsonl")
    expect(r.messagesTotal).toBe(2)
    expect(r.firstUserMessage).toBe("small request")
    expect(r.text).toContain("L1 user:")
    expect(r.text).toContain("L2 assistant:")
    expect(r.text).not.toContain("omitted")
  })
})
