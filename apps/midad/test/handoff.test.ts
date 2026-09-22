import { describe, expect, it } from "vitest"
import { MidaError, PERMISSION, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { Checkpoint } from "@mida/checkpoint"
import type { StoredCheckpoint } from "@mida/checkpoint"
import { randomBytes } from "@noble/hashes/utils.js"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { ContextApiClient } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { NAMESPACE, buildHandoff, readCheckpoints } from "@mida/midad"
import type { HandoffDeps, MigrationEnvelope, ProjectCheck, Runtime } from "@mida/midad"
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
  namespaceId: `0x${"2".repeat(64)}`,
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
      return (over.read ?? (async () => ({ checkpoints: [], skipped: 0, milliseconds: 1, partial: false })))(r, n, p)
    },
    readFacts: async (r, n) => {
      calls.readFacts += 1
      return (over.readFacts ?? (async () => []))(r, n)
    },
    isRevoked: over.isRevoked ?? (() => false),
    limitMs: over.limitMs,
    now: over.now,
  }
  return { calls, d }
}

const input = { agent: "codex", cwd: "/tmp/work", authorNames: {} }

describe("buildHandoff", () => {
  it("checkProject runs first: every project refusal makes zero chain calls and zero reads", async () => {
    for (const reason of ["not-a-project", "not-approved", "folder-mismatch", "list-tampered", "list-unreadable", "check-failed"] as const) {
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

  it("not-approved plus the revoke marker answers revoked — the row is gone but the owner said why (R4-3)", async () => {
    const { calls, d } = deps({
      checkProject: async () => ({ ok: false, reason: "not-approved" }),
      isRevoked: () => true,
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "revoked",
      text: "Mida: codex's access was revoked by the owner. Nothing was shared.",
    })
    expect(calls).toEqual({ checkProject: 1, capability: 0, read: 0, readFacts: 0 })
  })

  it("the marker only rewrites not-approved — other project refusals keep their own reason", async () => {
    for (const reason of ["not-a-project", "folder-mismatch", "list-unreadable", "check-failed"] as const) {
      const { d } = deps({ checkProject: async () => ({ ok: false, reason }), isRevoked: () => true })
      const result = await buildHandoff(runtime, input, d)
      expect(result.kind).toBe("refused")
      expect((result as { reason: string }).reason).toBe(reason)
    }
  })

  it("a marker that throws while being read leaves the not-approved answer, never a crash", async () => {
    const { d } = deps({
      checkProject: async () => ({ ok: false, reason: "not-approved" }),
      isRevoked: () => {
        throw new Error("disk went away")
      },
    })
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

  it("a list that cannot be read gets the permissions line — never a signature claim", async () => {
    const { d } = deps({ checkProject: async () => ({ ok: false, reason: "list-unreadable" }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "list-unreadable",
      text: "Mida: the approved-projects list could not be read: check the file's permissions. Nothing was shared. Run `mida doctor`.",
    })
  })

  it("a check that fails inside gets the no-context line with check-failed, not a signature claim", async () => {
    const { d } = deps({ checkProject: async () => ({ ok: false, reason: "check-failed" }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toEqual({
      kind: "refused",
      reason: "check-failed",
      text: "Mida: no context available right now (check-failed).",
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
          setTimeout(() => resolve({ checkpoints: [stored()], skipped: 0, milliseconds: 200, partial: false }), 200),
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

  it("the checkpoint read and the facts read run concurrently — each waiting on the other still completes (R4-2)", async () => {
    // If the reads ran one after another, the first would block on a gate the second only opens
    // when IT starts — a sequential buildHandoff would hit the deadline and refuse read-slow.
    let openRead!: () => void
    let openFacts!: () => void
    const readGate = new Promise<void>((resolve) => (openRead = resolve))
    const factsGate = new Promise<void>((resolve) => (openFacts = resolve))
    const { d } = deps({
      limitMs: 2_000,
      read: async () => {
        openRead()
        await factsGate
        return { checkpoints: [stored()], skipped: 0, milliseconds: 1, partial: false }
      },
      readFacts: async () => {
        openFacts()
        await readGate
        return []
      },
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
  })

  it("owner facts render under the exact heading; a failed fact read degrades to facts: 0 with a stable code", async () => {
    const fact = { text: "answers in lowercase", contextId: `0x${"7".repeat(64)}` as `0x${string}`, namespace: "preferences.communication", assertedAt: "2026-09-21T10:00:00.000Z" }
    const withFacts = await buildHandoff(
      runtime,
      input,
      deps({ read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1, partial: false }), readFacts: async () => [fact] }).d,
    )
    expect(withFacts.kind).toBe("handoff")
    if (withFacts.kind !== "handoff") return
    expect(withFacts.facts).toBe(1)
    expect(withFacts.factsFailed).toBeNull()
    expect(withFacts.text).toContain("What you have told Mida about yourself")
    expect(withFacts.text).toContain("- stated by you: answers in lowercase")
    expect(withFacts.text).toContain(`(record ${fact.contextId})`)
    expect(withFacts.text).not.toContain("(Your saved preferences could not be read for this session.)")

    // a fact read that throws — other than "no grant" — never sinks the handoff (A14)
    const { d } = deps({
      read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1, partial: false }),
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
    // the failure is visible inside the fence — the agent must not silently see no facts
    const insideFence = result.text.split("=== BEGIN MIDA HANDOFF DATA ===")[1]!.split("=== END MIDA HANDOFF DATA ===")[0]!
    expect(insideFence).toContain("(Your saved preferences could not be read for this session.)")
  })

  it("a fact read slower than the limit degrades the same way — the line sits inside the fence", async () => {
    const { d } = deps({
      limitMs: 40,
      read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1, partial: false }),
      readFacts: () => new Promise(() => {}), // never resolves — the deadline fires
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.facts).toBe(0)
    expect(result.factsFailed).toBe("facts-read-slow")
    const insideFence = result.text.split("=== BEGIN MIDA HANDOFF DATA ===")[1]!.split("=== END MIDA HANDOFF DATA ===")[0]!
    expect(insideFence).toContain("(Your saved preferences could not be read for this session.)")
  })

  it("a fact read resolving to [] emits no failure line and no facts heading", async () => {
    const { d } = deps({
      read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1, partial: false }),
      readFacts: async () => [],
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.facts).toBe(0)
    expect(result.factsFailed).toBeNull()
    expect(result.text).not.toContain("(Your saved preferences could not be read for this session.)")
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
      seen: [],
      partial: false,
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
    const { d } = deps({ read: async () => ({ checkpoints: [first, second], skipped: 0, milliseconds: 3, partial: false }) })
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

  it("the covered set names the foreign contextIds — the session's own checkpoints never enter it", async () => {
    const own = stored(
      { eventId: "cp-own", agent: "codex", createdAt: "2026-09-21T10:00:00.000Z" },
      { sessionId: "s2", contextId: `0x${"d".repeat(64)}`, authorId: `0x${"e".repeat(64)}` },
    )
    const foreign = stored(
      { eventId: "cp-other", agent: "claude-code", createdAt: "2026-09-21T09:00:00.000Z" },
      { sessionId: "s1", contextId: `0x${"b".repeat(64)}`, authorId: `0x${"c".repeat(64)}` },
    )
    const { d } = deps({ read: async () => ({ checkpoints: [own, foreign], skipped: 0, milliseconds: 3, partial: false }) })
    const result = await buildHandoff(runtime, { ...input, sessionId: "s2" }, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.seen).toEqual([foreign.contextId])
  })

  it("an author id the runtime does not know renders as 'unknown agent', never undefined", async () => {
    const foreign = stored({}, { authorId: `0x${"f".repeat(64)}` })
    const { d } = deps({ read: async () => ({ checkpoints: [foreign], skipped: 0, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain("unknown agent")
    expect(result.text).not.toContain("undefined")
  })

  it("skipped non-checkpoint records do not block a render — they are filtered by design", async () => {
    // readCheckpoints counts decrypted records that are not v1 checkpoint envelopes; that number
    // is filtering, not corruption — an undecryptable record throws inside agent.read instead.
    const { d } = deps({ read: async () => ({ checkpoints: [stored()], skipped: 3, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
  })

  it("a handoff that needed trimming reports cut, the limit it was cut to, and its oversize state (R5-4)", async () => {
    const progress = Array.from({ length: 400 }, (_, i) => `progress entry number ${i} ${"x".repeat(60)}`)
    const { d } = deps({ read: async () => ({ checkpoints: [stored({ progress })], skipped: 0, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toMatchObject({ kind: "handoff", cut: true, limitChars: 8000, oversized: false })
    if (result.kind !== "handoff") return
    expect(result.text.length).toBeLessThanOrEqual(result.limitChars)
  })

  it("a handoff that could not fit reports oversized instead of cut — the truth, not a guess (R5-4)", async () => {
    const { d } = deps({
      read: async () => ({ checkpoints: [stored({ originalRequest: "r".repeat(9000) })], skipped: 0, milliseconds: 1, partial: false }),
    })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toMatchObject({ kind: "handoff", cut: false, oversized: true })
  })

  it("merge or render throwing is a generic refusal, never a partial handoff", async () => {
    const a = stored({}, { projectId: "p1" })
    const b = stored({}, { projectId: "p2" }) // two projects — mergeCheckpoints throws
    const { d } = deps({ read: async () => ({ checkpoints: [a, b], skipped: 0, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("refused")
    expect((result as { text: string }).text).toMatch(/^Mida: no context available right now \([a-z-]+\)\.$/)
  })

  it("a partial read still produces a handoff — flagged at the top of the model text and in the result (M3-D)", async () => {
    const { d } = deps({ read: async () => ({ checkpoints: [stored()], skipped: 0, milliseconds: 1, partial: true }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toMatchObject({ kind: "handoff", partial: true })
    if (result.kind !== "handoff") return
    // the checkpoint that DID load is still in the report — partial means "maybe more", not "discard"
    expect(result.text).toContain(stored().contextId)
    expect(result.text.startsWith("Some saved context could not be loaded yet; what follows may be incomplete.")).toBe(true)
  })

  it("a partial read with no usable checkpoints says the list may be incomplete — never 'nothing saved'", async () => {
    const { d } = deps({ read: async () => ({ checkpoints: [], skipped: 0, milliseconds: 1, partial: true }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result).toMatchObject({ kind: "empty", partial: true })
    expect(result.text).toContain("Some saved context could not be loaded yet; what follows may be incomplete.")
    expect(result.text).not.toContain("Nothing has been saved")
  })

  it("the flag travels end to end: a server partial through every retry marks the handoff text (M3-D)", async () => {
    // the REAL ContextApiClient against a fake server that answers x-mida-partial every time —
    // the client's own retries (1 + 3) are the only calls, and the flag must reach the text.
    let calls = 0
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account: privateKeyToAccount(generatePrivateKey()),
      chainId: 31337n,
      capabilityRegistry: `0x${"11".repeat(20)}` as Address,
      fetch: async () => {
        calls += 1
        return new Response(JSON.stringify({ objects: [] }), { status: 200, headers: { "x-mida-partial": "true" } })
      },
    })
    const owner = `0x${"33".repeat(20)}` as Address
    const agentId = `0x${"aa".repeat(32)}` as Hex
    const agent = new MidaAgent({
      agentId,
      callbackOrigin: "https://agent.example",
      encryptionPrivateKey: randomBytes(32),
      chain: {
        deployment: { chainId: 31337n, capabilityRegistry: `0x${"11".repeat(20)}` as Address, contextRegistry: `0x${"22".repeat(20)}` as Address, deploymentBlock: 0n },
        account: client.account,
        publicClient: { readContract: async () => { throw new Error("no chain read expected for an empty list") } },
      } as never,
      api: client,
      grants: [
        {
          owner,
          agentId,
          requestId: `0x${"99".repeat(32)}` as Hex,
          capabilities: [
            {
              capabilityId: `0x${"77".repeat(32)}` as Hex,
              namespaceId: namespaceId(NAMESPACE),
              permissions: PERMISSION.READ,
              provenancePolicy: 0,
              expiresAt: "0",
              transactionHash: `0x${"88".repeat(32)}` as Hex,
            },
          ],
        },
      ],
    })
    const rt = { owner, agent: () => agent } as unknown as Runtime
    const { d } = deps({ read: readCheckpoints })
    const result = await buildHandoff(rt, input, d)
    expect(calls).toBe(4) // the first list plus all three retries — still partial
    expect(result).toMatchObject({ kind: "empty", partial: true })
    expect(result.text).toContain("Some saved context could not be loaded yet; what follows may be incomplete.")
  })
})

/**
 * migrate B2: a checkpoint the migration moved keeps its original author and original save
 * time — the envelope's move date rides beside them in the saved-by line. Everything else in
 * the report is untouched, and a checkpoint with no envelope renders exactly as before.
 */
const MIGRATION: MigrationEnvelope = {
  version: 1,
  originalChainId: "10143",
  originalContract: "0x1111111111111111111111111111111111111111",
  originalRecordId: `0x${"22".repeat(32)}`,
  originalCommitment: `0x${"33".repeat(32)}`,
  originalAuthor: `0x${"44".repeat(32)}`,
  originalCreatedAt: "2026-09-18T10:00:00.000Z",
  migratedAt: "2026-09-25T10:00:00.000Z",
}

describe("migrated checkpoints in the handoff (migrate B2)", () => {
  it("the saved-by line shows the original author and time plus (moved on <date>)", async () => {
    const moved = stored(
      { agent: "codex", createdAt: "2026-09-18T10:00:00.000Z" },
      { contextId: `0x${"9".repeat(64)}`, authorId: `0x${"e".repeat(64)}`, migration: MIGRATION },
    )
    const { d } = deps({ read: async () => ({ checkpoints: [moved], skipped: 0, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, { ...input, authorNames: { [`0x${"e".repeat(64)}`]: "codex" } }, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    // original author, original time, then the move date — in that order
    expect(result.text).toContain("- codex (on-chain author")
    expect(result.text).toContain("at 2026-09-18T10:00:00.000Z (moved on 2026-09-25)")
    expect(result.text).toContain(`record ${moved.contextId}`)
    // the summary's saved-at field keeps the bare timestamp — the suffix belongs to the saved-by line
    expect(result.savedAt).toBe("2026-09-18T10:00:00.000Z")
  })

  it("a checkpoint with no envelope renders with no moved-on marker anywhere", async () => {
    const plain = stored({ createdAt: "2026-09-18T10:00:00.000Z" })
    const { d } = deps({ read: async () => ({ checkpoints: [plain], skipped: 0, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, input, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).not.toContain("moved on")
  })

  it("only the migrated checkpoint's line carries the marker when the read is mixed", async () => {
    const moved = stored(
      { eventId: "cp-moved", createdAt: "2026-09-18T10:00:00.000Z" },
      { sessionId: "s1", contextId: `0x${"8".repeat(64)}`, authorId: `0x${"e".repeat(64)}`, migration: MIGRATION },
    )
    const plain = stored(
      { eventId: "cp-plain", createdAt: "2026-09-18T11:00:00.000Z" },
      { sessionId: "s1", contextId: `0x${"7".repeat(64)}`, authorId: `0x${"e".repeat(64)}` },
    )
    const { d } = deps({ read: async () => ({ checkpoints: [moved, plain], skipped: 0, milliseconds: 1, partial: false }) })
    const result = await buildHandoff(runtime, { ...input, authorNames: { [`0x${"e".repeat(64)}`]: "codex" } }, d)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain("at 2026-09-18T10:00:00.000Z (moved on 2026-09-25)")
    expect(result.text).toContain("at 2026-09-18T11:00:00.000Z,")
    expect(result.text.match(/\(moved on /g)).toHaveLength(1)
  })
})
