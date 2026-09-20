import { describe, expect, it } from "vitest"
import { MidaError } from "@mida/protocol"
import type { Checkpoint } from "@mida/checkpoint"
import type { StoredCheckpoint } from "@mida/checkpoint"
import { buildHandoff } from "@mida/midad"
import type { HandoffDeps, ProjectCheck, Runtime } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const runtime = {} as Runtime

const OK: ProjectCheck = {
  ok: true,
  approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" },
}

const stored = (cp: Partial<Checkpoint> = {}, over: Partial<StoredCheckpoint> = {}): StoredCheckpoint => ({
  checkpoint: sampleCheckpoint(cp),
  projectId: "p1",
  sessionId: "s1",
  continuesSession: null,
  compiledBy: "test",
  contextId: `0x${"1".repeat(64)}`,
  authorId: `0x${"a".repeat(64)}`,
  ...over,
})

/**
 * Every gate is injectable so the order they run in — and whether a refused gate stops the rest —
 * is observable. `read` resolves empty by default; tests override the one gate under test.
 */
function deps(over: Partial<HandoffDeps> = {}) {
  const calls = { checkProject: 0, capability: 0, read: 0, readFacts: 0 }
  const d: HandoffDeps = {
    checkProject: async (r, i) => {
      calls.checkProject += 1
      return (over.checkProject ?? (async () => OK))(r, i)
    },
    capability: async (r, a) => {
      calls.capability += 1
      return (over.capability ?? (async () => "live" as const))(r, a)
    },
    read: async (r, n, p) => {
      calls.read += 1
      return (over.read ?? (async () => ({ checkpoints: [], skipped: 0, milliseconds: 1 })))(r, n, p)
    },
    readFacts: async (r, n) => {
      calls.readFacts += 1
      return (over.readFacts ?? (async () => []))(r, n)
    },
    limitMs: over.limitMs,
    now: over.now,
  }
  return { calls, d }
}

const input = { agent: "codex", cwd: "/tmp/work", authorNames: {} }

describe("buildHandoff", () => {
  it("checkProject runs first: every project refusal makes zero chain calls and zero reads", async () => {
    for (const reason of ["not-a-project", "not-approved", "folder-mismatch", "list-tampered"] as const) {
      const { calls, d } = deps({ checkProject: async () => ({ ok: false, reason }) })
      const result = await buildHandoff(runtime, input, d)
      expect(result.kind).toBe("refused")
      expect(calls).toEqual({ checkProject: 1, capability: 0, read: 0, readFacts: 0 })
    }
  })

  it("a folder the owner never approved gets the not-approved line, word for word", async () => {
    const { d } = deps({ checkProject: async () => ({ ok: false, reason: "not-approved" }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "not-approved",
      text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
    })
  })

  it("not-a-project and folder-mismatch refuse with the same not-approved line", async () => {
    for (const reason of ["not-a-project", "folder-mismatch"] as const) {
      const { d } = deps({ checkProject: async () => ({ ok: false, reason }) })
      const result = await buildHandoff(runtime, input, d)
      expect(result).toEqual({
        kind: "refused",
        reason,
        text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
      })
    }
  })

  it("a list that fails its signature check gets the tampered line, not the approve line", async () => {
    const { d } = deps({ checkProject: async () => ({ ok: false, reason: "list-tampered" }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "list-tampered",
      text: "Mida: the approved-projects list failed its signature check. Nothing was shared. Run `mida doctor`.",
    })
  })

  it("an unsafe agent name is refused before checkProject and never interpolated", async () => {
    for (const agent of ["../agents", "..", "a b", "", "x".repeat(129)]) {
      const { calls, d } = deps()
      const result = await buildHandoff(runtime, { ...input, agent }, d)
      expect(result).toEqual({
        kind: "refused",
        reason: "bad-agent",
        text: "Mida: no context available right now (bad-agent).",
      })
      expect(calls.checkProject).toBe(0)
    }
  })

  it("a cwd that is not an absolute path is refused before checkProject", async () => {
    for (const cwd of ["relative/dir", ""]) {
      const { calls, d } = deps()
      const result = await buildHandoff(runtime, { ...input, cwd }, d)
      expect(result).toEqual({
        kind: "refused",
        reason: "bad-input",
        text: "Mida: no context available right now (bad-input).",
      })
      expect(calls.checkProject).toBe(0)
    }
  })

  it("an approved agent whose chain grant is gone gets the not-approved line", async () => {
    const { calls, d } = deps({ capability: async () => "none" })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "not-approved",
      text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
    })
    expect(calls.read).toBe(0)
  })

  it("an agent the chain shows revoked gets the revoked line, and no read is attempted", async () => {
    const { calls, d } = deps({ capability: async () => "revoked" })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "revoked",
      text: "Mida: codex's access was revoked by the owner. Nothing was shared.",
    })
    expect(calls.read).toBe(0)
  })

  it("a server-side CAPABILITY_REVOKED on the read gets the revoked line too", async () => {
    const { d } = deps({
      read: async () => {
        throw new MidaError("CAPABILITY_REVOKED", "capability is revoked")
      },
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "revoked",
      text: "Mida: codex's access was revoked by the owner. Nothing was shared.",
    })
  })

  it("server-side CAPABILITY_DENIED and CAPABILITY_EXPIRED on the read get the not-approved line", async () => {
    for (const code of ["CAPABILITY_DENIED", "CAPABILITY_EXPIRED"] as const) {
      const { d } = deps({
        read: async () => {
          throw new MidaError(code, "refused")
        },
      })
      const result = await buildHandoff(runtime, input, d)
      expect(result).toEqual({
        kind: "refused",
        reason: "not-approved",
        text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
      })
    }
  })

  it("any other read failure is the no-context line with read-failed, never a partial handoff", async () => {
    const { d } = deps({
      read: async () => {
        throw new Error("socket hang up")
      },
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "read-failed",
      text: "Mida: no context available right now (read-failed).",
    })
  })

  it("a read slower than the limit is refused read-slow and the late result is discarded", async () => {
    const { d } = deps({
      limitMs: 40,
      read: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ checkpoints: [stored()], skipped: 0, milliseconds: 200 }), 200),
        ),
    })
    const started = Date.now()
    const result = await buildHandoff(runtime, input, d)
    expect(Date.now() - started).toBeLessThan(150)
    expect(result).toEqual({
      kind: "refused",
      reason: "read-slow",
      text: "Mida: no context available right now (read-slow).",
    })
    // the 200 ms read resolves later — its checkpoints must never appear anywhere
    await new Promise((resolve) => setTimeout(resolve, 250))
  })

  it("a late read rejection after the timeout cannot crash the daemon", async () => {
    const { d } = deps({
      limitMs: 40,
      read: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("too late")), 200)),
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toMatchObject({ kind: "refused", reason: "read-slow" })
    await new Promise((resolve) => setTimeout(resolve, 250))
  })

  it("owner facts render under the exact heading; a failed fact read degrades to facts: 0 with a stable code", async () => {
    const fact = { text: "answers in lowercase", contextId: `0x${"7".repeat(64)}` as `0x${string}`, namespace: "preferences.communication", assertedAt: "2026-09-21T10:00:00.000Z" }
    const withFacts = await buildHandoff(
      runtime,
      input,
      deps({ read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1 }), readFacts: async () => [fact] }).d,
    )
    expect(withFacts.kind).toBe("handoff")
    if (withFacts.kind !== "handoff") return
    expect(withFacts.facts).toBe(1)
    expect(withFacts.factsFailed).toBeNull()
    expect(withFacts.text).toContain("What you have told Mida about yourself")
    expect(withFacts.text).toContain("- answers in lowercase")

    // a fact read that throws — other than "no grant" — never sinks the handoff (A14)
    const { d } = deps({
      read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1 }),
      readFacts: async () => {
        throw new Error("server went away")
      },
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.facts).toBe(0)
    expect(result.factsFailed).toBe("facts-read-failed")
    expect(result.text).not.toContain("What you have told Mida about yourself")
  })
  it("an approved agent with nothing saved gets the empty line — not a refusal", async () => {
    const { d } = deps()
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "empty",
      text: "Mida: connected. Nothing has been saved for this project yet.",
      facts: 0,
      factsFailed: null,
      readMs: expect.any(Number),
    })
  })

  it("a check that throws is a generic refusal, not a crash", async () => {
    const { d } = deps({
      checkProject: async () => {
        throw new Error("disk went away")
      },
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("refused")
    expect((result as { text: string }).text).toMatch(/^Mida: no context available right now \([a-z-]+\)\.$/)
  })

  it("two chained sessions render the first session's request verbatim and both record ids", async () => {
    const first = stored(
      { eventId: "cp-1", agent: "claude-code", originalRequest: "Port the billing engine to worker threads", createdAt: "2026-09-21T09:00:00.000Z" },
      { sessionId: "s1", contextId: `0x${"b".repeat(64)}`, authorId: `0x${"c".repeat(64)}` },
    )
    const second = stored(
      { eventId: "cp-2", agent: "codex", createdAt: "2026-09-21T10:00:00.000Z", objective: "Finish the port" },
      { sessionId: "s2", continuesSession: "s1", contextId: `0x${"d".repeat(64)}`, authorId: `0x${"e".repeat(64)}` },
    )
    const { d } = deps({ read: async () => ({ checkpoints: [first, second], skipped: 0, milliseconds: 3 }) })
    const result = await buildHandoff(runtime, {
      ...input,
      authorNames: { [`0x${"c".repeat(64)}`]: "claude-code", [`0x${"e".repeat(64)}`]: "codex" },
    }, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.checkpoints).toBe(2)
    expect(result.facts).toBe(0)
    // the ORIGINAL REQUEST block is the first content after the BEGIN fence, verbatim
    const afterBegin = result.text.split("=== BEGIN MIDA HANDOFF DATA ===\n\n")[1]!
    expect(afterBegin.startsWith("ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):\nPort the billing engine to worker threads")).toBe(true)
    expect(result.text).toContain(first.contextId)
    expect(result.text).toContain(second.contextId)
    expect(result.text).toContain("- claude-code (on-chain author")
    expect(result.text).toContain("- codex (on-chain author")
  })

  it("an author id the runtime does not know renders as 'unknown agent', never undefined", async () => {
    const foreign = stored({}, { authorId: `0x${"f".repeat(64)}` })
    const { d } = deps({ read: async () => ({ checkpoints: [foreign], skipped: 0, milliseconds: 1 }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain("unknown agent")
    expect(result.text).not.toContain("undefined")
  })

  it("skipped non-checkpoint records do not block a render — they are filtered by design", async () => {
    // readCheckpoints counts decrypted records that are not v1 checkpoint envelopes; that number
    // is filtering, not corruption — an undecryptable record throws inside agent.read instead.
    const { d } = deps({ read: async () => ({ checkpoints: [stored()], skipped: 3, milliseconds: 1 }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
  })

  it("merge or render throwing is a generic refusal, never a partial handoff", async () => {
    const a = stored({}, { projectId: "p1" })
    const b = stored({}, { projectId: "p2" }) // two projects — mergeCheckpoints throws
    const { d } = deps({ read: async () => ({ checkpoints: [a, b], skipped: 0, milliseconds: 1 }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("refused")
    expect((result as { text: string }).text).toMatch(/^Mida: no context available right now \([a-z-]+\)\.$/)
  })
})
