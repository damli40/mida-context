import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaError, PERMISSION, PROVENANCE_POLICY } from "@mida/protocol"
import {
  CheckpointPayloadError,
  HOOK_CLIENTS,
  HOOK_COMMAND,
  MidaHome,
  buildMcpSave,
  expectedScopesFor,
  mcpSaveSessionId,
  purposeFor,
} from "@mida/midad"
import type { CheckpointEnvelope, McpSaveDeps, McpSaveResult, ServiceRuntime } from "@mida/midad"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-mcpsave-")))

const OWNER = "0x0000000000000000000000000000000000000001" as const
const AGENT_ID = "0x00000000000000000000000000000000000000aa" as const
const PID = "proj-mcpsave"
const CTX = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const TX = "0x2222222222222222222222222222222222222222222222222222222222222222" as const

const FIELDS = {
  objective: "ship the thing",
  nextAction: "open the PR",
  progress: ["wrote the module"],
  decisions: [{ decision: "reuse the drain path", rationale: "one save implementation" }],
  rejected: [{ approach: "sign in the adapter", why: "the adapter holds no keys" }],
  constraints: ["no contract changes"],
  artifacts: ["apps/midad/src/mcp-save.ts"],
  unresolvedIssue: null,
  remainingPlan: ["run the tests"],
  evidence: [{ field: "gate order", ref: "the brief's S2" }],
  originalRequest: "let MCP clients write",
}

/** A runtime with just the two fields buildMcpSave may touch when every dep is injected. */
const runtime = (dir: MidaHome = home()): ServiceRuntime => ({ home: dir, owner: OWNER }) as unknown as ServiceRuntime

const identity = () => ({ name: "claude-desktop", agentId: AGENT_ID })

/** Everything a fully-approved save needs; individual tests override single gates. */
const okDeps = (over: Partial<McpSaveDeps> = {}): McpSaveDeps => ({
  loadIdentity: () => identity() as never,
  checkProject: async () => ({ ok: true, approval: { agent: "claude-desktop", projectId: PID, root: "/r", approvedAt: "t" } }),
  hasAuthority: async () => true,
  capability: async () => "live",
  isRevoked: () => false,
  revokePending: () => undefined,
  save: async () => ({ contextId: CTX, transactionHash: TX, milliseconds: 1, duplicate: false, lane: "direct" }),
  now: () => 1_760_000_000_000,
  lastSaves: new Map(),
  ...over,
})

const call = async (deps: Partial<McpSaveDeps> = {}, body: Record<string, unknown> = {}, dir: MidaHome = home()): Promise<McpSaveResult> =>
  buildMcpSave(runtime(dir), { agent: "claude-desktop", cwd: "/work", fields: FIELDS, ...body }, okDeps(deps))

const captureSave = (sink: { input?: Omit<CheckpointEnvelope, "type"> }, result?: Record<string, unknown>) =>
  (async (_rt: ServiceRuntime, _name: string, input: Omit<CheckpointEnvelope, "type">) => {
    sink.input = input
    return { contextId: CTX, transactionHash: TX, milliseconds: 1, duplicate: false, lane: "direct" as const, ...result }
  }) as NonNullable<McpSaveDeps["save"]>

describe("buildMcpSave — the daemon's mida_save route", () => {
  it("a fully-approved client saves through the shared path, stamped and signed as itself", async () => {
    const sink: { input?: Omit<CheckpointEnvelope, "type"> } = {}
    const result = await call({ save: captureSave(sink) })
    expect(result.kind).toBe("saved")
    if (result.kind !== "saved") return
    expect(result.contextId).toBe(CTX)
    expect(result.transactionHash).toBe(TX)
    const cp = sink.input!.checkpoint
    // every identity field is the daemon's — never what the model sent
    expect(cp.agent).toBe("claude-desktop")
    expect(cp.source).toBe("agent-tool")
    expect(cp.eventId.startsWith("cp-")).toBe(true)
    expect(new Date(cp.createdAt).getTime()).not.toBeNaN()
    expect(cp.objective).toBe("ship the thing")
    expect(sink.input!.projectId).toBe(PID)
    expect(sink.input!.compiledBy).toBe("claude-desktop")
    // one stable session per identity + project — the merge treats them as one history
    expect(sink.input!.sessionId).toBe(mcpSaveSessionId("claude-desktop", PID))
    expect(sink.input!.continuesSession).toBeNull()
  })

  it("the save session id is stable per identity + project and different across either", () => {
    const a = mcpSaveSessionId("claude-desktop", PID)
    expect(mcpSaveSessionId("claude-desktop", PID)).toBe(a)
    expect(mcpSaveSessionId("claude-desktop", "other-project")).not.toBe(a)
    expect(mcpSaveSessionId("cursor", PID)).not.toBe(a)
    expect(a.startsWith("mcp-")).toBe(true)
  })

  it("a non-MCP identity is refused before anything else runs — the route signs for clients only", async () => {
    let projectAsked = false
    let saved = false
    const result = await call(
      {
        checkProject: async () => {
          projectAsked = true
          return { ok: false, reason: "not-a-project" }
        },
        save: async () => {
          saved = true
          throw new Error("unreachable")
        },
      },
      { agent: "codex" },
    )
    expect(result).toMatchObject({ kind: "refused", reason: "not-an-mcp-client" })
    // AUTH-17: the refusal says where this agent's saves go instead
    expect((result as { text?: string }).text).toBe(
      "Mida: codex saves only through its Mida hooks. mida_save signs only for claude-desktop and cursor, so this call saved nothing.",
    )
    expect(projectAsked).toBe(false)
    expect(saved).toBe(false)
  })

  it("an identity with no Mida hooks is never told it saves through hooks (AUTH-17 review)", async () => {
    for (const agent of ["windsurf", "nosuch"]) {
      const result = await call({ save: async () => { throw new Error("unreachable") } }, { agent })
      expect(result).toMatchObject({ kind: "refused", reason: "not-an-mcp-client" })
      expect((result as { text?: string }).text).toBe("Mida: mida_save signs only for claude-desktop and cursor, so this call saved nothing.")
    }
  })

  it("the hook-client list is exactly the tools install writes hooks for", () => {
    expect([...HOOK_CLIENTS].sort()).toEqual(Object.keys(HOOK_COMMAND).sort())
  })

  it("an unknown or unreadable identity refuses without a folder check", async () => {
    let projectAsked = false
    const deps: Partial<McpSaveDeps> = {
      checkProject: async () => {
        projectAsked = true
        return { ok: false, reason: "not-a-project" }
      },
    }
    const missing = await call({ ...deps, loadIdentity: () => undefined })
    expect(missing).toMatchObject({ kind: "refused", reason: "no-identity" })
    // a file that exists but will not load is "identity-unreadable" — never "no agent is set up":
    // statSync decides absent-vs-broken, the same split checkAccess makes on the read side
    const dir = home()
    mkdirSync(join(dir.root, "agents", "claude-desktop"), { recursive: true })
    writeFileSync(join(dir.root, "agents", "claude-desktop", "identity.json"), "{corrupt")
    const broken = await call(
      {
        ...deps,
        loadIdentity: () => {
          throw new Error("corrupt")
        },
      },
      {},
      dir,
    )
    expect(broken).toMatchObject({ kind: "refused", reason: "identity-unreadable" })
    expect(projectAsked).toBe(false)
  })

  it("an unapproved folder is refused by the same check the reads use", async () => {
    let authorityAsked = false
    const result = await call({
      checkProject: async () => ({ ok: false, reason: "not-approved" }),
      hasAuthority: async () => {
        authorityAsked = true
        return true
      },
    })
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
    if (result.kind === "refused") expect(result.text).toContain("mida approve claude-desktop")
    expect(authorityAsked).toBe(false)
  })

  it("a READ-only grant gets the actionable write-access line", async () => {
    const result = await call({ hasAuthority: async (_id, permission) => permission !== PERMISSION.CREATE })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.text).toBe(
        "claude-desktop can read but not write here — run `mida request claude-desktop` and `mida approve claude-desktop` to add write access",
      )
    }
  })

  it("no authority at all is not-approved, never the read-only line", async () => {
    const result = await call({ hasAuthority: async () => false })
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
  })

  it("a revoked client is refused even while the chain still shows CREATE", async () => {
    const result = await call({ isRevoked: () => true })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.reason).toBe("revoked")
      expect(result.text).toContain("revoked")
    }
  })

  it("a revoke in flight (deny staged, chain still live) refuses the save", async () => {
    const result = await call({ revokePending: () => ({ intentId: null, userOpHash: null, at: "2026-09-25T10:00:00Z" }) })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.reason).toBe("revoke-pending")
  })

  it("a chain verdict of revoked inside the CREATE gate refuses as revoked, not read-only", async () => {
    const result = await call({ hasAuthority: async () => false, capability: async () => "revoked" })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.reason).toBe("revoked")
  })

  it("an authority check that cannot be answered refuses rather than admits", async () => {
    const result = await call({
      hasAuthority: async () => {
        throw new Error("rpc down")
      },
    })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.reason).toBe("check-failed")
  })

  it("unknown field names are refused and named", async () => {
    const result = await call({}, { fields: { ...FIELDS, surprise: "x" } })
    expect(result).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    if (result.kind === "refused") {
      expect(result.fields).toContain("surprise")
      expect(result.text).toContain("surprise")
    }
  })

  it("identity fields the model must not set are refused as unknown keys — no forged createdAt, agent, eventId or source", async () => {
    for (const forged of ["createdAt", "agent", "eventId", "source", "sessionId", "projectId", "contextId"]) {
      const result = await call({}, { fields: { ...FIELDS, [forged]: "2099-01-01T00:00:00.000Z" } })
      expect(result.kind, forged).toBe("refused")
      if (result.kind === "refused") {
        expect(result.fields, forged).toContain(forged)
      }
    }
  })

  it("a missing or mistyped required field is refused and named", async () => {
    const noObjective = await call({}, { fields: { nextAction: "n" } })
    expect(noObjective.kind).toBe("refused")
    if (noObjective.kind === "refused") expect(noObjective.fields).toContain("objective")
    const badType = await call({}, { fields: { ...FIELDS, progress: "not-an-array" } })
    expect(badType.kind).toBe("refused")
    if (badType.kind === "refused") expect(badType.fields).toContain("progress")
  })

  // UF-J: when the ONLY thing wrong is lists over the schema's 50-entry cap, the refusal
  // names the limit and each submitted count — "invalid fields" alone would not tell the
  // model what to fix.
  it("a list over the 50-entry cap refuses by naming the limit and the count (UF-J)", async () => {
    const decisions = Array.from({ length: 51 }, (_, i) => ({ decision: `d${i}`, rationale: "r" }))
    const result = await call({}, { fields: { ...FIELDS, decisions } })
    expect(result).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    if (result.kind === "refused") {
      expect(result.text).toBe("Mida: a list holds at most 50 entries (decisions has 51). Nothing was saved.")
      expect(result.fields).toEqual(["decisions"])
    }
  })

  it("several over-long lists name every count inside one refusal (UF-J)", async () => {
    const decisions = Array.from({ length: 51 }, (_, i) => ({ decision: `d${i}`, rationale: "r" }))
    const constraints = Array.from({ length: 60 }, (_, i) => `c${i}`)
    const result = await call({}, { fields: { ...FIELDS, decisions, constraints } })
    expect(result).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    if (result.kind === "refused") {
      // the validator's own error order: constraints is checked before decisions
      expect(result.text).toBe(
        "Mida: a list holds at most 50 entries (constraints has 60, decisions has 51). Nothing was saved.",
      )
    }
  })

  it("an over-long list mixed with another kind of error keeps the generic refusal (UF-J)", async () => {
    const decisions = Array.from({ length: 51 }, (_, i) => ({ decision: `d${i}`, rationale: "r" }))
    const result = await call({}, { fields: { ...FIELDS, decisions, progress: "not-an-array" } })
    expect(result).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    if (result.kind === "refused") {
      expect(result.text).toBe("Mida: invalid checkpoint fields: progress, decisions — nothing was saved.")
    }
  })

  it("secrets in the checkpoint are scrubbed with the compiler scrubber before sealing", async () => {
    const sink: { input?: Omit<CheckpointEnvelope, "type"> } = {}
    const secret = "AKIAIOSFODNN7EXAMPLE"
    const result = await call(
      { save: captureSave(sink) },
      { fields: { ...FIELDS, progress: [`the aws key ${secret} leaked in`], objective: `uses ${secret}` } },
    )
    expect(result.kind).toBe("saved")
    const cp = sink.input!.checkpoint
    expect(JSON.stringify(cp)).not.toContain(secret)
    expect(cp.objective).toContain("[REDACTED]")
  })

  it("one save per minute per identity + project — the refusal says when the next is allowed", async () => {
    const lastSaves = new Map<string, number>()
    const projects: Record<string, string> = { "/work": PID, "/other": "proj-other" }
    const deps: Partial<McpSaveDeps> = {
      lastSaves,
      checkProject: async (_rt, input) => ({
        ok: true,
        approval: { agent: "claude-desktop", projectId: projects[input.cwd] ?? PID, root: "/r", approvedAt: "t" },
      }),
    }
    const first = await call(deps)
    expect(first.kind).toBe("saved")
    const second = await call(deps)
    expect(second.kind).toBe("refused")
    if (second.kind === "refused") {
      expect(second.reason).toBe("rate-limited")
      expect(second.nextAllowedAt).toBe(new Date(1_760_000_000_000 + 60_000).toISOString())
      expect(second.text).toContain("60")
    }
    // a different approved project is a different slot
    const other = await call(deps, { cwd: "/other" })
    expect(other.kind).toBe("saved")
  })

  it("the minute slot frees when the clock moves — a later save lands", async () => {
    const lastSaves = new Map<string, number>()
    let now = 1_760_000_000_000
    expect((await call({ lastSaves, now: () => now })).kind).toBe("saved")
    now += 61_000
    expect((await call({ lastSaves, now: () => now })).kind).toBe("saved")
  })

  it("an identical resubmission carries the same eventId — the save path's dedup answers it", async () => {
    const sink: { input?: Omit<CheckpointEnvelope, "type"> } = {}
    let now = 1_760_000_000_000
    const lastSaves = new Map<string, number>()
    await call({ lastSaves, now: () => now, save: captureSave(sink) })
    const firstId = sink.input!.checkpoint.eventId
    now += 61_000
    await call({ lastSaves, now: () => now, save: captureSave(sink, { duplicate: true }) })
    expect(sink.input!.checkpoint.eventId).toBe(firstId)
    now += 61_000
    await call({ lastSaves, now: () => now, save: captureSave(sink) }, { fields: { ...FIELDS, objective: "different" } })
    expect(sink.input!.checkpoint.eventId).not.toBe(firstId)
  })

  it("chain answers during the save map onto the same refusal lines the gates print", async () => {
    const saveError = (code: string) => async () => {
      throw new MidaError(code as never, "from the chain")
    }
    const revoked = await call({ save: saveError("CAPABILITY_REVOKED") as never })
    expect(revoked.kind).toBe("refused")
    if (revoked.kind === "refused") expect(revoked.reason).toBe("revoked")
    const denied = await call({ save: saveError("WRITE_DENIED") as never })
    expect(denied.kind).toBe("refused")
    if (denied.kind === "refused") expect(denied.reason).toBe("revoke-pending")
    const noGrant = await call({ save: saveError("CAPABILITY_DENIED") as never })
    expect(noGrant.kind).toBe("refused")
    if (noGrant.kind === "refused") expect(noGrant.reason).toBe("not-approved")
    const badPayload = await call({
      save: (async () => {
        throw new CheckpointPayloadError("too-large", "checkpoint envelope exceeds the cap")
      }) as never,
    })
    expect(badPayload.kind).toBe("refused")
    if (badPayload.kind === "refused") expect(badPayload.reason).toBe("too-large")
  })

  it("a refused call never reaches the injected save", async () => {
    let saved = false
    await call({
      save: async () => {
        saved = true
        throw new Error("unreachable")
      },
      checkProject: async () => ({ ok: false, reason: "not-approved" }),
    })
    expect(saved).toBe(false)
  })
})

describe("the MCP client's own grant covers writes (S2 scope pin)", () => {
  it("the project_assistance request already asks READ | CREATE | SUPERSEDE_OWN on projects.current", () => {
    // both MCP clients take purposeFor → project_assistance; this is where their scopes are defined
    for (const client of ["claude-desktop", "cursor"]) {
      expect(purposeFor(client)).toBe("project_assistance")
    }
    const projectScope = expectedScopesFor("project_assistance").find((s) => s.namespace === "projects.current")
    expect(projectScope).toBeDefined()
    const want = PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN
    expect(projectScope!.permissions & want).toBe(want)
    expect(projectScope!.provenancePolicy! & PROVENANCE_POLICY.ALLOW_INFERENCE).toBe(PROVENANCE_POLICY.ALLOW_INFERENCE)
  })
})
