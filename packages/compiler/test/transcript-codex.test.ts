// Task 6 — the Codex rollout reader. A Codex session file is one JSON object
// per line shaped {timestamp, type, payload}; the conversation lives in
// `response_item` records. readCodexConversation returns the same
// Conversation shape as the Claude reader, format "codex-jsonl", and
// readTranscriptFor picks the reader by the job's recorded agent.

import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readCodexConversation, readTranscriptFor } from "../src/index.js"

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe("readCodexConversation", () => {
  it("finds the human's first request, skipping Codex and Mida scaffolding, scrubbed", () => {
    const c = readCodexConversation(fx("codex-rollout-synthetic.jsonl"))
    expect(c.format).toBe("codex-jsonl")
    expect(c.firstUserMessage).toMatch(/^Make emergencies pulse, not red\./)
    expect(c.firstUserMessage).not.toContain("sk-live-abcdefghijklmnop")
  })

  it("renders user, tool and assistant lines with real line numbers, drops reasoning and events", () => {
    const c = readCodexConversation(fx("codex-rollout-synthetic.jsonl"))
    expect(c.text).toContain("L7 user:")
    expect(c.text).toContain("L9 tool:")
    expect(c.text).toContain("L10 tool-result:")
    expect(c.text).toContain("L11 assistant:")
    for (const gone of ["thinking", "token_count", "Mida: handoff", "<environment_context>", "AGENTS.md", "sk-live-abcdefghijklmnop"]) {
      expect(c.text).not.toContain(gone)
    }
    expect(c.messagesKept).toBe(4)
  })

  it("collects cwds from session_meta and turn_context", () => {
    expect(readCodexConversation(fx("codex-rollout-synthetic.jsonl")).cwds).toEqual(["/tmp/toy"])
  })

  it("answers unknown-tail for a file with no Codex records (e.g. a Claude transcript)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cx-")), "t.jsonl")
    writeFileSync(p, `{"type":"user","message":{"content":"hi"}}\n`)
    const c = readCodexConversation(p)
    expect(c.format).toBe("unknown-tail")
    expect(c.firstUserMessage).toBeNull()
  })

  it("reads the real rollout captured in spike S2", () => {
    const c = readCodexConversation(fx("codex-rollout-real.jsonl"))
    expect(c.format).toBe("codex-jsonl")
    expect(c.firstUserMessage).toMatch(/spike S2 was here/)
    expect(c.text).toContain("tool:")
    expect(c.text).not.toContain("MIDA HANDOFF")
    expect(c.text).not.toContain("recommended_plugins")
  })

  it("dispatches by agent and refuses unknown agents", () => {
    expect(readTranscriptFor("codex", fx("codex-rollout-synthetic.jsonl"))?.format).toBe("codex-jsonl")
    expect(readTranscriptFor("gemini", fx("codex-rollout-synthetic.jsonl"))).toBeNull()
  })

  // F1: a part is scrubbed whole BEFORE the 600-char cut — a secret that starts
  // inside the cut and ends past it must never leave a prefix fragment behind.
  it("a secret straddling the 600-char cut is scrubbed whole, not truncated first", () => {
    const key = "ab".repeat(32)
    // 539 filler chars + a space put the key's first hex char at index 540 — its
    // last four sit past the 600-char cut the old order applied before scrubbing.
    const output = `${"x".repeat(539)} ${key}`
    const p = join(mkdtempSync(join(tmpdir(), "cx-")), "t.jsonl")
    writeFileSync(
      p,
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", output },
      }) + "\n",
    )
    const c = readCodexConversation(p)
    expect(c.text).not.toMatch(/[0-9a-f]{16,}/)
    expect(c.text).toContain("[REDACTED]")
  })

  // F5 helpers: one user-role response_item line holding the given text.
  const userLine = (text: string) =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    })
  const rollout = (...texts: string[]) => {
    const p = join(mkdtempSync(join(tmpdir(), "cx-")), "t.jsonl")
    writeFileSync(p, texts.map(userLine).join("\n") + "\n")
    return p
  }

  it.each(["<user_shell_command>", "<turn_aborted>"])("%s output is scaffolding, not the request", (tag) => {
    const c = readCodexConversation(rollout(`${tag}\nrunning a thing\n</${tag.slice(1)}`, "the real ask"))
    expect(c.firstUserMessage).toBe("the real ask")
    expect(c.text).not.toContain("running a thing")
  })

  // G9: the whole-tag rule governs the REQUEST PICK only — a prompt the human
  // wrote as a tag is still a prompt, so it stays in the rendered conversation.
  // Only the named Codex/Mida scaffolding is dropped from rendering entirely.
  it("an unknown <tag>…</tag> block is never the request but still renders", () => {
    const c = readCodexConversation(rollout("<future_scaffolding>\ninjected by a later Codex\n</future_scaffolding>", "the real ask"))
    expect(c.firstUserMessage).toBe("the real ask")
    expect(c.text).toContain("injected by a later Codex")
    // it is not pinned either — it carries no request
    expect(c.text.startsWith("L1 user:")).toBe(false)
    expect(c.text.startsWith("L2 user:")).toBe(true)
  })

  it("Mida's own injected lines are skipped, but a human prompt opening 'Mida:' is kept", () => {
    const c = readCodexConversation(
      rollout(
        "Mida: handoff loaded — 2 checkpoints from claude-code",
        "Mida update since you last checked:\n- codex: did the thing",
        "Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):\n- codex: did another thing",
        "MIDA HANDOFF\nobjective: earlier work",
        "Mida: please refactor the parser",
      ),
    )
    expect(c.firstUserMessage).toBe("Mida: please refactor the parser")
    expect(c.text).not.toContain("handoff loaded")
    expect(c.text).not.toContain("update since you last checked")
  })

  it("a <tag> opener with no matching close is kept — only complete blocks are scaffolding", () => {
    const c = readCodexConversation(rollout("<note> do not forget the parser edge case", "second ask"))
    expect(c.firstUserMessage).toBe("<note> do not forget the parser edge case")
  })
})

// P-1 / PROV-09 — same hole as the Claude reader: a rollout over
// HEAD_BYTES + TAIL_BYTES was read only at both ends, so a typed message in
// the unread middle never reached the compile. The streamed scan finds it
// with its real line number.
describe("the user's later typed messages are never lost (P-1)", () => {
  const userItem = (text: string) =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    })
  const toolOut = (i: number) =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", output: `out-${i} ` + "o".repeat(1_400) },
    })

  it("a typed change sitting in the unread middle of a large rollout is pinned with its real line number", () => {
    const change = "Change the rollout: provenance edges render in violet."
    const lines = [userItem("Build the handoff demo. Constraint: no animations anywhere.")]
    let size = lines[0]!.length + 1
    let i = 0
    while (size < 70_000) {
      lines.push(toolOut(i++))
      size += lines.at(-1)!.length + 1
    }
    const changeLine = lines.length + 1
    lines.push(userItem(change))
    size += lines.at(-1)!.length + 1
    while (size < 200_000) {
      lines.push(toolOut(i++))
      size += lines.at(-1)!.length + 1
    }
    const p = join(mkdtempSync(join(tmpdir(), "cx-")), "t.jsonl")
    writeFileSync(p, lines.join("\n") + "\n")
    const c = readCodexConversation(p)
    expect(c.format).toBe("codex-jsonl")
    expect(c.text).toContain("user — later messages you typed, oldest first (outside the recent messages below):")
    expect(c.text).toContain(`L${changeLine}: ${change}`)
    expect(c.firstUserMessage).toBe("Build the handoff demo. Constraint: no animations anywhere.")
    expect(c.text.length).toBeLessThanOrEqual(40_000)
  })

  it("injected user text never joins the group — scaffolding is not typed", () => {
    const lines = [userItem("build the demo")]
    let size = lines[0]!.length + 1
    let i = 0
    while (size < 70_000) {
      lines.push(toolOut(i++))
      size += lines.at(-1)!.length + 1
    }
    lines.push(userItem("<environment_context>MID-INJECTED-MARKER cwd=/tmp</environment_context>"))
    lines.push(userItem("MIDA HANDOFF\nMID-HANDOFF-MARKER must stay unread"))
    lines.push(userItem("now show provenance edges in violet"))
    let bytes = lines.map((l) => l.length + 1).reduce((a, b) => a + b, 0)
    while (bytes < 200_000) {
      lines.push(toolOut(i++))
      bytes += lines.at(-1)!.length + 1
    }
    const p = join(mkdtempSync(join(tmpdir(), "cx-")), "t.jsonl")
    writeFileSync(p, lines.join("\n") + "\n")
    const c = readCodexConversation(p)
    expect(c.text).toContain("now show provenance edges in violet")
    expect(c.text).not.toContain("MID-INJECTED-MARKER")
    expect(c.text).not.toContain("MID-HANDOFF-MARKER")
  })
})
