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
})
