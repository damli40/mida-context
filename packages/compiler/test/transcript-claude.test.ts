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

  // G1: a custom slash command records the real ask inside <command-args> —
  // `/brainstorm build a login page` must surface as that request, not be
  // dropped as command-echo scaffolding. The real echo puts <command-message>
  // FIRST: the parser must find <command-name> anywhere in the line.
  it("a slash command's arguments are the user's request (G1)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>brainstorm</command-message>\n<command-name>/brainstorm</command-name>\n<command-args>build a login page</command-args>" } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "You are a brainstorming assistant. The user wants: build a login page" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "here are ideas" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("/brainstorm build a login page")
    // the pinned first block renders the REQUEST text — the raw echo tags
    // never reach the model
    expect(r.text.startsWith("L1 user:\n/brainstorm build a login page")).toBe(true)
    expect(r.text).not.toContain("command-name")
  })

  // K5: the /compact summary is the extractor's best record of the earlier
  // session. It renders as its own labelled block, capped at 6,000 chars,
  // right after the pinned request and before the newer turns — and the
  // newest-first fill may never push it out.
  it("a /compact transcript pins its session summary beside the request (K5)", () => {
    const dir = tmpdir()
    const summary = "SUMMARY-START " + "s".repeat(15_000)
    const lines = [
      JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: summary } }),
    ]
    // ~42 KB of newer turns behind the summary
    for (let i = 0; i < 42; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `turn-${i} ` + "t".repeat(1_000) }] } }))
    }
    const t = writeTranscript(dir, lines)
    const r = readConversation(t)
    expect(r.text).toContain("Summary of the earlier session (from /compact)")
    expect(r.text).toContain("SUMMARY-START")
    expect(r.text.length).toBeLessThanOrEqual(40_000)
    // capped at 6,000 — the middle of the 15 KB summary never renders
    expect(r.text).not.toContain("s".repeat(7_000))
    // the newest turns still fit behind it, newest-first
    expect(r.text).toContain("turn-41")
    // and the summary sits ahead of them, not dropped or pushed to the tail
    expect(r.text.indexOf("Summary of the earlier session (from /compact)")).toBeLessThan(
      r.text.indexOf("turn-41"),
    )
  })

  // L6: the summary's newest state — pending tasks, the next step — sits at
  // its END, so a head-only cut lost exactly what a resumed session needs.
  // The cut keeps the first 2,000 and the last 4,000 chars with a marked gap.
  it("a long summary keeps both its start and its end across the cut (L6)", () => {
    const dir = tmpdir()
    const summary =
      "SUMMARY-OPEN the session began here\n" +
      "middle ".repeat(2_000) +
      "\nNEXT-STEP-MARKER wire the drain next"
    expect(summary.length).toBeGreaterThan(6_000) // genuinely over the cap
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "build the parser" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: summary } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "continuing" }] } }),
    ])
    const r = readConversation(t)
    expect(r.text).toContain("SUMMARY-OPEN")
    expect(r.text).toContain("NEXT-STEP-MARKER wire the drain next")
    expect(r.text).toContain("[… middle of the summary cut …]")
    // and the cut really happened — the joined head+tail is ~6 KB, not 15
    expect(r.text).not.toContain("middle ".repeat(1_500))
  })

  // G1 flip-side: built-in commands are never the request, args or not. The
  // real shape puts the caveat and the stdout on their OWN user lines —
  // neighbouring the echo, not inside it — and none of them carry isMeta.
  // Skipping is decided two ways: a <command-name> line within two lines of a
  // caveat/stdout line is local plumbing, and a name on Claude Code's built-in
  // list is skipped even with no plumbing in sight.
  it("a built-in command echo stays scaffolding — caveat/stdout commands are never the request", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      // caveat first, on its own user line, no isMeta — the real /compact shape
      JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>" } }),
      // the built-in echo carries args: "focus on parser" is still not the ask
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>focus on parser</command-args>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted 41 KB to 6 KB</local-command-stdout>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "context compacted, continuing" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "more work" }] } }),
      // >2 lines from any caveat/stdout — only the built-in NAME list can skip these
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/todos</command-name>\n<command-message>todos</command-message>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Refactor the parser to stream input" } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("Refactor the parser to stream input")
  })

  // K3: the plumbing check used to look ±2 lines out, so the PREVIOUS built-in's
  // caveat/stdout counted as the next echo's neighbour and a real custom command
  // right after /clear, /model or /compact vanished. The neighbour rule is exact:
  // caveat at i−1, stdout at i+1 or i+2.
  it("a real slash command after a built-in is still the request (L2)", () => {
    const builtins = [
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
      "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>",
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
    ]
    for (const builtin of builtins) {
      const dir = tmpdir()
      const t = writeTranscript(dir, [
        JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: builtin } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-stdout>done</local-command-stdout>" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>brainstorm</command-message>\n<command-name>/brainstorm</command-name>\n<command-args>redesign the login page</command-args>" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ideas" }] } }),
      ])
      expect(readConversation(t).firstUserMessage).toBe("/brainstorm redesign the login page")
    }
  })

  it("a built-in command echo alone still yields no request (L2)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>sonnet</command-args>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "model set" }] } }),
    ])
    expect(readConversation(t).firstUserMessage).toBeNull()
  })

  it("a line across the head/tail cut is never a neighbour — the tail's command echo is still judged (L2)", () => {
    const dir = tmpdir()
    // The last complete head line is a caveat; the tail opens inside one giant
    // line and its first real line is a custom command echo. The caveat sits at
    // entries[i−1] but a whole unread middle lies between them in the file.
    const caveat = JSON.stringify({
      type: "user",
      message: { role: "user", content: "<local-command-caveat>Caveat.</local-command-caveat>" },
    })
    const filler = (n: number) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `pad ${"p".repeat(n)}` }] } })
    const lines: string[] = []
    let size = 0
    while (size < 60_000) {
      lines.push(filler(1_000))
      size += lines.at(-1)!.length + 1
    }
    lines.push(caveat)
    // one giant line straddles the head boundary AND the tail boundary — the
    // head drops its unfinished tail end, the tail drops its leading fragment
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "G".repeat(300_000) }] } }))
    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "<command-message>brainstorm</command-message>\n<command-name>/brainstorm</command-name>\n<command-args>plan the migration</command-args>" },
      }),
    )
    const t = writeTranscript(dir, lines)
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("/brainstorm plan the migration")
    expect(r.text).toContain("L~1 user:\n/brainstorm plan the migration")
  })

  // L5: the head/tail windows never see the middle of a truncated file, so a
  // /compact that ran more than ~60 KB before the end used to lose its summary
  // entirely. The streamed scan finds it — and labels it with its REAL line
  // number, which the tail window could not have known.
  it("pins a /compact summary sitting in the unread middle of a large transcript (L5)", () => {
    const dir = tmpdir()
    const pad = "x".repeat(4_000)
    const lines: string[] = [
      JSON.stringify({ type: "user", message: { role: "user", content: "build the parser" } }),
    ]
    for (let i = 0; i < 35; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `step ${i} ${pad}` }] } }))
    }
    const summaryLineNo = lines.length + 1 // the next push is the summary's real line number
    lines.push(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "SUMMARY-MIDDLE-MARKER condensed history of the session" } }))
    for (let i = 0; i < 35; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `later ${i} ${pad}` }] } }))
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: `next ${i}` } }))
    }
    const t = writeTranscript(dir, lines)
    expect(fs.statSync(t).size).toBeGreaterThan(250_000) // genuinely truncated
    const r = readConversation(t)
    expect(r.text).toContain(`L${summaryLineNo} user — Summary of the earlier session (from /compact):`)
    expect(r.text).toContain("SUMMARY-MIDDLE-MARKER")
  })

  // L8: a custom slash command that is NOT the pinned request is still a user
  // turn — rendered "/name args" — while built-ins stay hidden. The echo's raw
  // tags never reach the model either way.
  it("a later custom slash command renders as a user turn; built-ins stay hidden (L8)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "build the parser" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "started" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>brainstorm</command-message>\n<command-name>/brainstorm</command-name>\n<command-args>the retry policy</command-args>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "brainstormed" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>sonnet</command-args>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "switched" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("build the parser")
    expect(r.text).toContain("user:\n/brainstorm the retry policy")
    expect(r.text).not.toContain("/model")
    expect(r.text).not.toContain("command-name")
  })

  // L8b: IDE-injected context blocks strip like every other scaffold — they
  // can precede the ask but can never BE it, and an absolute path from one
  // must never land in the saved request.
  it("IDE-injected file and selection blocks strip off the request (L8)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<ide_opened_file>/Users/x/proj/src/a.ts</ide_opened_file>\n<ide_selection>the retry loop</ide_selection>\nfix the flaky reconnect" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fixing" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("fix the flaky reconnect")
    expect(r.text).not.toContain("/Users/x/proj")
    // and a line that is ONLY an IDE block is plumbing, not the request
    const dir2 = tmpdir()
    const only = writeTranscript(dir2, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<ide_opened_file>/abs/secret-path.ts</ide_opened_file>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "the real ask" } }),
    ])
    const r2 = readConversation(only)
    expect(r2.firstUserMessage).toBe("the real ask")
    expect(r2.openedWithScaffolding).toBe(true)
  })

  // L4: a prompt that QUOTES the command tag in prose is not a command echo —
  // the tag has to open the line (after leading whitespace) for the line to be
  // plumbing. Otherwise the user's words would be replaced by the quoted name.
  it("a prompt quoting a command tag mid-sentence is the request, not an echo (L4)", () => {
    const dir = tmpdir()
    const prose = "when the transcript logs <command-name>/brainstorm</command-name> mid-line, is that an echo?"
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: prose } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "good question" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe(prose)
    // and a real echo still resolves after leading whitespace
    const dir2 = tmpdir()
    const indented = writeTranscript(dir2, [
      JSON.stringify({ type: "user", message: { role: "user", content: "   <command-message>review</command-message>\n<command-name>/review</command-name>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reviewing" }] } }),
    ])
    expect(readConversation(indented).firstUserMessage).toBe("/review")
  })

  it("a custom command without arguments still names itself as the request", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args></command-args>" } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "You are a code reviewer." } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reviewing" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("/review")
  })

  // K4: a real prompt may OPEN on an injected block — the reminder is
  // scaffolding but the words after it are the ask. Strip the leading blocks,
  // keep the rest, for the request pick and the rendered conversation alike.
  it("a prompt that opens on a reminder keeps the user's own words (K4)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>The user opened src/parser.ts in the editor.</system-reminder>\n\nRefactor the parser to stream input" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("Refactor the parser to stream input")
    expect(r.text).toContain("Refactor the parser")
    expect(r.text).not.toContain("system-reminder")
    expect(r.text).not.toContain("The user opened src/parser.ts")
  })

  it("a tool_result part next to a reminder still renders (K4)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>context note</system-reminder>" },
            { type: "tool_result", tool_use_id: "t1", content: "RESULT-KEPT output" },
          ],
        },
      }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBe("do the thing")
    expect(r.text).toContain("RESULT-KEPT output")
    expect(r.text).not.toContain("context note")
    expect(r.text).not.toContain("system-reminder")
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

  // G2: Claude Code's own injected lines are not conversation — the caveat,
  // command echoes and local-command output must never reach the model text.
  // Real shape: each lands on its OWN user line, none carrying isMeta.
  it("Claude Code scaffolding is dropped from the rendered conversation (G2)", () => {
    const dir = tmpdir()
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response.</local-command-caveat>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-stdout>compaction done</local-command-stdout>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>watch out</system-reminder>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "continuing the work" }] } }),
    ])
    const r = readConversation(t)
    expect(r.firstUserMessage).toBeNull()
    expect(r.text).not.toContain("Caveat")
    expect(r.text).not.toContain("DO NOT respond")
    expect(r.text).not.toContain("local-command")
    expect(r.text).not.toContain("system-reminder")
    expect(r.text).toContain("continuing the work")
  })

  // G2: when nothing in the transcript is a real request, NOTHING may be
  // pinned as one — the budget belongs to the newest messages, so a rendered
  // non-request block must not headline the text.
  it("no real request pins nothing — a tool_result block is not the headline (G2)", () => {
    const dir = tmpdir()
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "EARLY-RESULT resumed output" }] } }),
    ]
    for (let i = 0; i < 40; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `step-${i} ` + "w".repeat(200) }] },
        }),
      )
    }
    const t = writeTranscript(dir, lines)
    const r = readConversation(t, { maxChars: 2_000 })
    expect(r.firstUserMessage).toBeNull()
    // the pin fallback would headline "L1 user:" — a block that is not a
    // request; with no pick the newest messages get the budget instead
    expect(r.text.startsWith("L1 user:")).toBe(false)
    expect(r.text).toContain("step-39")
    expect(r.text).not.toContain("EARLY-RESULT")
  })

  // G10: thinking parts are scrubbed BEFORE the 1,000-char cut — a secret
  // straddling the boundary would otherwise lose enough characters to stop
  // matching the scrub patterns and leak a fragment.
  it("a secret straddling the thinking cut is scrubbed whole (G10)", () => {
    const dir = tmpdir()
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const t = writeTranscript(dir, [
      JSON.stringify({ type: "user", message: { role: "user", content: "the request" } }),
      // 951 chars of filler put the key across the 1,000-char thinking cut
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: `${"x".repeat(950)} ${key}` }] } }),
    ])
    const r = readConversation(t)
    expect(r.text).toContain("[REDACTED]")
    expect(r.text).not.toContain(key)
    // a fragment is a leak too — the cut must not split the key into a
    // string too short for the scrubber to recognise
    expect(r.text).not.toContain(key.slice(0, 20))
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
    let maxRead = 0
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
      maxRead = Math.max(maxRead, n)
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
    // the head+tail windows plus ONE streamed pass hunting the last /compact
    // summary — every read still bounded to a chunk, so memory stays flat
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024 + 60_000 + fs.statSync(t).size)
    expect(maxRead).toBeLessThanOrEqual(64 * 1024)
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
