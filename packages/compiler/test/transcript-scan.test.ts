// P-1 / PROV-09 — the streamed transcript scan. One bounded pass over the
// whole file finds the last /compact summary (unchanged) AND every line the
// user typed, each with its real 1-based line number. The parity tests are
// the spec's guard against the scan and the window read disagreeing: for a
// file small enough to fit the windows, the scan must classify exactly the
// typed lines the per-line classifier does — same numbers, same text.
//
// The exports under test do not exist until the implementation lands, so the
// imports are dynamic: a missing symbol fails the one test that needs it,
// never the whole file.

import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mida-scan-"))
}

// in-22 V-1: real JSONL files end with a newline — write it by default (the missing newline
// is what hid the false interrupted-ending bug in every fixture).
function writeTranscript(dir: string, lines: string[]) {
  const p = path.join(dir, "transcript.jsonl")
  fs.writeFileSync(p, lines.join("\n") + "\n")
  return p
}

const scanModule = () => import("../src/transcript-lines.js")
const claudeModule = () => import("../src/transcript-claude.js")
const codexModule = () => import("../src/transcript-codex.js")

describe("scanTranscript — the streamed typed-line pass (P-1)", () => {
  it("classifies the same typed lines the Claude window read does — same numbers, same text", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks, claudeTypedUserText, claudeCommandEchoNeighbour } = await claudeModule()
    const raw = [
      JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", text: "snapshot" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "build the parser" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "resumed output" }] } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "bookkeeping" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>watch out</system-reminder>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-stdout>done</local-command-stdout>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-message>brainstorm</command-message>\n<command-name>/brainstorm</command-name>\n<command-args>the retry policy</command-args>" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "condensed history" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "change it to violet" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    ]
    const t = writeTranscript(tmpdir(), raw)

    // The window side: the same per-line classifier the reader runs on every
    // parsed line, fed the same neighbour texts (caveat before, stdout after).
    const objs = raw.map((line) => {
      try {
        const obj: unknown = JSON.parse(line)
        return obj !== null && typeof obj === "object" ? obj : null
      } catch {
        return null
      }
    })
    const userTexts = raw.map((line) => claudeScanHooks!.userText(line))
    // byte offsets of each line's start — the scan reports them so the window
    // pairing can match on identity, never on position (in-18 R-2)
    const offsets: number[] = []
    let cursor = 0
    for (const line of raw) {
      offsets.push(cursor)
      cursor += Buffer.byteLength(line, "utf8") + 1
    }
    const expected = objs
      .map((obj, i) =>
        claudeTypedUserText!(
          obj,
          claudeCommandEchoNeighbour!(userTexts[i - 1] ?? "", [userTexts[i + 1] ?? "", userTexts[i + 2] ?? ""]),
        ),
      )
      .map((text, i) => (text === null ? null : { line: i + 1, offset: offsets[i]!, text }))
      .filter((entry) => entry !== null)

    const scan = scanTranscript!(t, claudeScanHooks!)
    expect(scan.typed).toEqual(expected)
    // the typed set really is: the request, the custom command, the change —
    // never the tool_result, isMeta, reminder or built-in echo lines
    expect(scan.typed.map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 2, text: "build the parser" },
      { line: 9, text: "/brainstorm the retry policy" },
      { line: 11, text: "change it to violet" },
    ])
    // and the same pass still finds the compact summary it was built for
    expect(scan.summary?.label).toBe("10")
  })

  it("classifies the same typed lines the Codex window read does — same numbers, same text", async () => {
    const { scanTranscript } = await scanModule()
    const { codexScanHooks } = await codexModule()
    const userItem = (text: string) =>
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      })
    const raw = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/toy" } }),
      userItem("<environment_context>cwd=/tmp/toy</environment_context>"),
      userItem("make emergencies pulse, not red"),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "ls" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "out" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "MIDA HANDOFF\nnote" }] } }),
      userItem("Mida: handoff loaded — 2 checkpoints"),
      userItem("now make it violet"),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [] } }),
      userItem("<mystery_tag>typed inside a tag</mystery_tag>"),
    ]
    const t = writeTranscript(tmpdir(), raw)

    const offsets: number[] = []
    let cursor = 0
    for (const line of raw) {
      offsets.push(cursor)
      cursor += Buffer.byteLength(line, "utf8") + 1
    }
    const expected = raw
      .map((line, i) => ({ line: i + 1, offset: offsets[i]!, text: codexScanHooks!.typedText(line, { prev: "", next: [] }) }))
      .filter((entry) => entry.text !== null) as { line: number; offset: number; text: string }[]

    const scan = scanTranscript!(t, codexScanHooks!)
    expect(scan.typed).toEqual(expected)
    // the whole-tag block (line 10) is never "typed" — it renders as a user
    // block but an injected <tag>…</tag> must not become the user's latest
    // instruction (in-18 R-6/S3)
    expect(scan.typed.map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 3, text: "make emergencies pulse, not red" },
      { line: 8, text: "now make it violet" },
    ])
  })

  it("a candidate line over the cap is counted, never parsed — the scan stays bounded", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const paste = `PASTE ${"p".repeat(300_000)}`
    const t = writeTranscript(tmpdir(), [
      JSON.stringify({ type: "user", message: { role: "user", content: "the request" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: paste } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a".repeat(500_000) }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "still here" } }),
    ])
    const scan = scanTranscript!(t, claudeScanHooks!)
    expect(scan.typed.map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 1, text: "the request" },
      { line: 4, text: "still here" },
    ])
    expect(scan.tooLong).toEqual([2])
    expect(scan.summary).toBeNull()
  })

  it("scans a 20 MB transcript in bounded memory — timing printed, not asserted", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const dir = tmpdir()
    const lines = [JSON.stringify({ type: "user", message: { role: "user", content: "the request" } })]
    let size = lines[0]!.length + 1
    let i = 0
    while (size < 20 * 1024 * 1024) {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `step ${i} ` + "x".repeat(2_000) }] },
      })
      lines.push(line)
      size += line.length + 1
      i += 1
      if (i % 500 === 0) {
        const typed = JSON.stringify({ type: "user", message: { role: "user", content: `typed checkpoint ${i}` } })
        lines.push(typed)
        size += typed.length + 1
      }
    }
    const t = writeTranscript(dir, lines)
    expect(fs.statSync(t).size).toBeGreaterThan(20 * 1024 * 1024)
    const started = performance.now()
    const scan = scanTranscript!(t, claudeScanHooks!)
    const ms = performance.now() - started
    // measured, never asserted — the report needs the number, not a gate
    console.log(`scanTranscript over ${(fs.statSync(t).size / 1024 / 1024).toFixed(1)} MB: ${ms.toFixed(1)} ms, ${scan.typed.length} typed lines`)
    expect(scan.typed.length).toBeGreaterThan(0)
  })
})

// UF-C41B B2 — the same one streamed pass no longer renders steps at all. A
// middle line whose RAW text holds the record mark is only marked: its line
// number, byte offset and exact byte length, newest 4,096 kept plus a count of
// them all. The reader then re-reads each marked line whole and decides what
// the record really is — the scan itself never parses a middle line into rows,
// so a mark inside a non-assistant record only ever costs the reader a re-read.
describe("scanTranscript — the assistant's candidate lines in the unread middle (UF-C41B B2)", () => {
  const user = (content: unknown) =>
    JSON.stringify({ type: "user", message: { role: "user", content } })
  const asst = (parts: unknown[]) =>
    JSON.stringify({ type: "assistant", message: { content: parts } })
  // A real Claude record carries "type" AFTER the whole message object — the
  // mark sits at the line's far end, past any prefix a reader could cut.
  const asstReal = (parts: unknown[]) =>
    JSON.stringify({
      parentUuid: "p",
      isSidechain: false,
      userType: "external",
      cwd: "/w",
      sessionId: "s",
      version: "2.1.0",
      gitBranch: "main",
      message: { id: "msg_1", type: "message", role: "assistant", content: parts },
      requestId: "req_1",
      type: "assistant",
      uuid: "u",
      timestamp: "2026-10-01T00:00:00Z",
    })

  const offsets = (lines: string[]): number[] => {
    const offs: number[] = []
    let at = 0
    for (const line of lines) {
      offs.push(at)
      at += Buffer.byteLength(line, "utf8") + 1
    }
    return offs
  }

  it("marks every middle line whose raw text holds the mark, in either key order", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const raw = [
      user("build it"),
      asst([{ type: "tool_use", name: "Write", input: { file_path: "/p/a.ts", content: "code" } }]),
      asstReal([{ type: "text", text: "said it plainly" }]),
      user("tool output only"),
      user("the tail"),
    ]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    // middle = lines 2..4 — the request and the tail sit outside the range
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[4]! })
    expect(scan.stepCandidates).toEqual([
      { line: 2, offset: offs[1]!, byteLen: Buffer.byteLength(raw[1]!, "utf8") },
      { line: 3, offset: offs[2]!, byteLen: Buffer.byteLength(raw[2]!, "utf8") },
    ])
    expect(scan.stepsTotal).toBe(2)
  })

  it("a mark inside a record that is not an assistant one still marks the line — the reader decides", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    // a >256 KB user record with `"type":"assistant"` inside its toolUseResult
    const line = JSON.stringify({
      type: "user",
      toolUseResult: { messages: [{ type: "assistant" }] },
      message: { role: "user", content: "x".repeat(300_000) },
    })
    const raw = [user("req"), line, user("tail")]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[2]! })
    expect(scan.stepCandidates).toEqual([{ line: 2, offset: offs[1]!, byteLen: Buffer.byteLength(line, "utf8") }])
    expect(scan.stepsTotal).toBe(1)
    // and it is still counted too long to parse for the typed pass — unchanged
    expect(scan.tooLong).toEqual([2])
  })

  it("the mark at the far end of an over-cap line still counts — no kept prefix is ever trusted", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    // real key order puts `"type":"assistant"` ~500 KB into the line, past the
    // 4 KB prefix and past the line cap entirely
    const line = asstReal([{ type: "tool_use", name: "Write", input: { file_path: "/p/big.ts", content: "C".repeat(500_000) } }])
    const raw = [user("req"), line, user("tail")]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[2]! })
    expect(scan.stepCandidates).toEqual([{ line: 2, offset: offs[1]!, byteLen: Buffer.byteLength(line, "utf8") }])
    expect(scan.stepsTotal).toBe(1)
  })

  it("a middle line without the mark is never a candidate", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const raw = [user("req"), user(`PASTE ${"p".repeat(500_000)}`), user("tail")]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[2]! })
    expect(scan.stepCandidates).toEqual([])
    expect(scan.stepsTotal).toBe(0)
    // the typed-candidate path is unchanged: the over-cap user line still counts
    expect(scan.tooLong).toEqual([2])
  })

  it("a line outside the middle bounds is never a candidate; with no bounds nothing is marked", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const raw = [
      user("req"),
      asst([{ type: "tool_use", name: "Write", input: { file_path: "/p/a.ts", content: "c" } }]),
      asst([{ type: "tool_use", name: "Read", input: { file_path: "/p/b.md" } }]),
      asst([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
      user("tail"),
    ]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    // only lines 2-3 count as unread — line 4's call was "seen"
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[3]! })
    expect(scan.stepCandidates.map((c) => c.line)).toEqual([2, 3])
    expect(scan.stepsTotal).toBe(2)
    const none = scanTranscript!(t, claudeScanHooks!)
    expect(none.stepCandidates).toEqual([])
    expect(none.stepsTotal).toBe(0)
  })

  it("typed and queued user lines are never candidates — they still reach the scan as typed", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const raw = [
      user("req"),
      JSON.stringify({
        type: "attachment",
        attachment: { type: "queued_command", commandMode: "prompt", prompt: "QUEUED-MID change it", origin: { kind: "human" }, source_uuid: "sq-cap41" },
      }),
      user("TYPED-MID also this"),
      user("tail"),
    ]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[3]! })
    expect(scan.stepCandidates).toEqual([])
    expect(scan.stepsTotal).toBe(0)
    // they reach the scan as the user's own words instead — unchanged
    expect(scan.typed.map((e) => e.text)).toEqual(["req", "QUEUED-MID change it", "TYPED-MID also this", "tail"])
  })

  it("keeps only the newest 4,096 marks and counts every marked line", async () => {
    const { scanTranscript } = await scanModule()
    const { claudeScanHooks } = await claudeModule()
    const raw = [
      user("req"),
      ...Array.from({ length: 4_200 }, (_, i) => asstReal([{ type: "text", text: `s${i + 1}` }])),
      user("tail"),
    ]
    const offs = offsets(raw)
    const t = writeTranscript(tmpdir(), raw)
    const scan = scanTranscript!(t, claudeScanHooks!, undefined, { start: offs[1]!, end: offs[raw.length - 1]! })
    expect(scan.stepsTotal).toBe(4_200)
    expect(scan.stepCandidates).toHaveLength(4_096)
    // the kept marks are the newest: marked lines are 2..4201, so the kept
    // window is lines 106..4201
    expect(scan.stepCandidates[0]!.line).toBe(106)
    expect(scan.stepCandidates.at(-1)!.line).toBe(4_201)
  })
})
