import { describe, expect, it } from "vitest"
import { agoText, hookReply, sessionStartMessage, whatsNewMessage } from "@mida/midad"

const NOW = Date.parse("2026-09-21T12:00:00.000Z")

const reply = (message: string, context: string) =>
  JSON.parse(hookReply("SessionStart", message, context)) as {
    systemMessage: string
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }

describe("hookReply", () => {
  it("emits one JSON object with the systemMessage and the SessionStart context", () => {
    const out = reply("Mida: connected — nothing saved for this project yet", "CTX")
    expect(out.systemMessage).toBe("Mida: connected — nothing saved for this project yet")
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: "CTX" })
  })

  it("quotes, newlines and </script> inside the context survive the round-trip byte-for-byte", () => {
    const text = 'say "hi"\nsecond line\n</script><script>alert(1)</script>\n=== END MIDA HANDOFF DATA ==='
    const out = reply("Mida: handoff loaded — 1 checkpoint, 0 facts", text)
    expect(out.hookSpecificOutput.additionalContext).toBe(text)
  })
})

describe("agoText", () => {
  it("renders seconds, minutes, hours and days in plain words", () => {
    expect(agoText("2026-09-21T11:59:20.000Z", NOW)).toBe("40 s ago")
    expect(agoText("2026-09-21T11:57:00.000Z", NOW)).toBe("3 min ago")
    expect(agoText("2026-09-21T10:00:00.000Z", NOW)).toBe("2 h ago")
    expect(agoText("2026-09-17T12:00:00.000Z", NOW)).toBe("4 d ago")
  })

  it("a future or unparsable timestamp never produces a negative or NaN age", () => {
    expect(agoText("2026-09-21T13:00:00.000Z", NOW)).toBe("0 s ago")
    expect(agoText("not-a-date", NOW)).toBe("a while ago")
  })
})

describe("sessionStartMessage", () => {
  it("handoff: counts, the authoring agent's name and how long ago", () => {
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 2,
      facts: 1,
      savedBy: "claude-code",
      savedAt: "2026-09-21T11:57:00.000Z",
    }
    expect(sessionStartMessage(body, "codex", NOW)).toBe(
      "Mida: handoff loaded — 2 checkpoints, 1 fact (from claude-code, 3 min ago)",
    )
  })

  it("singular counts read naturally", () => {
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 1,
      facts: 0,
      savedBy: "codex",
      savedAt: "2026-09-21T11:59:20.000Z",
    }
    expect(sessionStartMessage(body, "codex", NOW)).toBe(
      "Mida: handoff loaded — 1 checkpoint, 0 facts (from codex, 40 s ago)",
    )
  })

  it("a cut handoff says so", () => {
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 1,
      facts: 0,
      savedBy: "codex",
      savedAt: "2026-09-21T11:59:20.000Z",
      cut: true,
    }
    expect(sessionStartMessage(body, "codex", NOW)).toContain("(shortened)")
  })

  it("an oversized handoff says so — it was not shortened, it is longer than the limit (R5-4)", () => {
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 1,
      facts: 0,
      savedBy: "codex",
      savedAt: "2026-09-21T11:59:20.000Z",
      oversized: true,
    }
    expect(sessionStartMessage(body, "codex", NOW)).toContain("(longer than the limit)")
    const both = { ...body, cut: true }
    expect(sessionStartMessage(both, "codex", NOW)).toContain("(shortened, longer than the limit)")
  })

  it("empty: the connected line", () => {
    expect(sessionStartMessage({ kind: "empty", text: "x" }, "codex", NOW)).toBe(
      "Mida: connected — nothing saved for this project yet",
    )
  })

  it("a partial handoff tells the owner the list may be incomplete (M3-D)", () => {
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 1,
      facts: 0,
      savedBy: "codex",
      savedAt: "2026-09-21T11:59:20.000Z",
      partial: true,
    }
    const line = sessionStartMessage(body, "codex", NOW)
    expect(line).toContain("(incomplete — try again in a moment)")
    expect(line).toContain("handoff loaded")
  })

  it("a partial empty read never claims 'nothing saved' — it asks for a retry instead (M3-D)", () => {
    const line = sessionStartMessage({ kind: "empty", text: "x", partial: true }, "codex", NOW)
    expect(line).toContain("(incomplete — try again in a moment)")
    expect(line).not.toContain("nothing saved")
  })

  it("refused revoked names the agent, the owner, and what revocation cannot undo (F9)", () => {
    // the disclosure sentence: a model this agent already read keeps what it saw — the line
    // must not imply revocation reaches into the past
    expect(sessionStartMessage({ kind: "refused", reason: "revoked", text: "x" }, "codex", NOW)).toBe(
      "Mida: codex has no access to this project (revoked by the owner). Revoking stops future reads; it cannot recall what this agent already read.",
    )
  })

  it("refused not-approved names the agent and the fix", () => {
    expect(sessionStartMessage({ kind: "refused", reason: "not-approved", text: "x" }, "claude-code", NOW)).toBe(
      "Mida: claude-code has no access to this project (not approved yet — run: mida request claude-code)",
    )
  })

  it("any other refusal or a missing body degrades with the short reason", () => {
    expect(sessionStartMessage({ kind: "refused", reason: "read-slow", text: "x" }, "codex", NOW)).toBe(
      "Mida: could not load context (read-slow) — working without it",
    )
    expect(sessionStartMessage(null, "codex", NOW)).toBe(
      "Mida: could not load context (no-answer) — working without it",
    )
    expect(sessionStartMessage({ kind: "handoff" }, "codex", NOW)).toBe(
      "Mida: could not load context (no-answer) — working without it",
    )
  })

  it("never carries a 40+ hex run, wherever it came from", () => {
    const hex = `0x${"ab".repeat(32)}`
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 1,
      facts: 0,
      savedBy: hex,
      savedAt: "2026-09-21T11:59:20.000Z",
    }
    const line = sessionStartMessage(body, "codex", NOW)
    expect(line).not.toContain(hex)
    expect(line).not.toMatch(/[0-9a-f]{40}/)
    expect(line).toContain("<hex>")
  })

  it("stays at or under 160 characters even with a huge author name", () => {
    const body = {
      kind: "handoff",
      text: "CTX",
      checkpoints: 1,
      facts: 0,
      savedBy: "a".repeat(300),
      savedAt: "2026-09-21T11:59:20.000Z",
    }
    const line = sessionStartMessage(body, "codex", NOW)
    expect(line.length).toBeLessThanOrEqual(160)
  })
})

describe("whatsNewMessage", () => {
  it("one updating agent names the agent and its checkpoint's age", () => {
    expect(
      whatsNewMessage([{ agent: "codex", savedAt: "2026-09-21T11:59:20.000Z" }], NOW),
    ).toBe("Mida: update from codex (40 s ago)")
  })

  it("several agents list them newest first", () => {
    const line = whatsNewMessage(
      [
        { agent: "codex", savedAt: "2026-09-21T11:59:20.000Z" },
        { agent: "claude-code", savedAt: "2026-09-21T11:57:00.000Z" },
      ],
      NOW,
    )
    expect(line).toBe("Mida: updates from codex (40 s ago), claude-code (3 min ago)")
  })

  it("a missing agent name or timestamp degrades to words, never blank", () => {
    const line = whatsNewMessage([{ agent: "", savedAt: "not-a-date" }], NOW)
    expect(line).toBe("Mida: update from another agent (a while ago)")
  })

  it("stays under 160 characters and carries no hex even with many agents", () => {
    const updates = Array.from({ length: 6 }, (_, i) => ({
      agent: `agent-${"x".repeat(40)}-${i}`,
      savedAt: "2026-09-21T11:59:20.000Z",
    }))
    const line = whatsNewMessage(updates, NOW)
    expect(line.length).toBeLessThanOrEqual(160)
    expect(line).not.toMatch(/[0-9a-f]{40}/)
  })
})
