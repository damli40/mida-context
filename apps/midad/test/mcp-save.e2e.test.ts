import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import { PERMISSION, PROVENANCE_POLICY } from "@mida/protocol"
import {
  MidaHome,
  NAMESPACE,
  PURPOSE_ID,
  Runtime,
  approve,
  approveProject,
  authorNamesFor,
  buildHandoff,
  callDaemon,
  createMidaMcpServer,
  init,
  loadAgentIdentity,
  mcpSaveSessionId,
  readCheckpoints,
  requestAccess,
  revoke,
  saveGrants,
  startDaemon,
  startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, McpSaveResult, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const PROJECT_ID = "proj-mcpsave-e2e"

const SAVE_FIELDS = {
  objective: "write the launch checklist",
  nextAction: "run the checklist past the owner",
  progress: ["drafted section one"],
  decisions: [],
  rejected: [],
  constraints: [],
  artifacts: [],
  unresolvedIssue: null,
  remainingPlan: ["sections two and three"],
  evidence: [],
  originalRequest: "keep a note of where we are",
}

/** The reply body the daemon's /save route answers with. */
const saveReply = async (home: MidaHome, body: Record<string, unknown>): Promise<McpSaveResult> => {
  const reply = await callDaemon(home, "/save", body, { timeoutMs: 45_000 })
  expect(reply.status).toBe(200)
  return reply.body as McpSaveResult
}

/**
 * The MCP save route end to end: a real midad on local Anvil serving POST /save, with a real MCP
 * server/client pair for `claude-desktop` (the SDK's in-memory transport stands in for stdio).
 * `codex` is the reader that proves the checkpoint landed where a handoff would see it; `cursor`
 * holds a deliberately READ-only grant; `assistant` and non-MCP names cover the identity gate.
 * `fakeNow` drives the daemon's clock so the once-a-minute slot frees without waiting.
 */
describe("mida_save against a real midad on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let workDir: string
  let otherDir: string
  let daemon: DaemonHandle | undefined
  let fakeNow = 1_760_000_000_000
  let mcp: { client: Client; close(): Promise<void> } | undefined
  let claudeDesktopId: string

  const connectMcp = async (agent: string, project = workDir) => {
    const server = createMidaMcpServer({ home, agent, project, sessionId: `mcp-${agent}-save-e2e`, daemonUp: true })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: `mcp-e2e-${agent}`, version: "0" })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  const callText = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const res = await client.callTool({ name, arguments: args })
    const content = res.content as { type: string; text?: string }[]
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe("text")
    return content[0]!.text!
  }

  /** The daemon needs a compile dep even though this suite queues no jobs. */
  const compile = async (input: CompileInput): Promise<CompileResult> => ({
    ok: true,
    checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
    compiledBy: "stub",
    droppedKeys: [],
    trimmed: [],
    attempts: 1,
    retried: 0,
    format: "claude-jsonl",
    messagesKept: 1,
    messagesTotal: 1,
    charsSent: 0,
    modelMs: 0,
  })

  /** A fresh owner-side session for reads/owner commands — never takes midad.lock (storageUrl set). */
  const ownerRuntime = () => Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-api-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-mcpsave-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-mcpsave-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))
    // a second marked project nobody is approved for — the unapproved-folder refusal
    otherDir = mkdtempSync(join(tmpdir(), "mida-mcpsave-other-"))
    mkdirSync(join(otherDir, ".mida"))
    writeFileSync(join(otherDir, ".mida", "project.json"), JSON.stringify({ projectId: "proj-mcpsave-other" }))

    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-desktop", "codex", "cursor"])
      // claude-desktop and codex get the full policy grant plus this folder's list row
      for (const name of ["claude-desktop", "codex"]) {
        await requestAccess(runtime, name)
        await approve(runtime, name, workDir)
      }
      // cursor gets ONLY READ on projects.current plus the folder row — the approved-for-read-but-
      // not-write case, minted straight through the vault like a home approved before writes existed
      const cursorAgent = runtime.agent("cursor")
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60)
      const request = await cursorAgent.createAccessRequest({
        purposeId: PURPOSE_ID,
        scopes: [{ namespace: NAMESPACE, permissions: PERMISSION.READ, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
        capabilityExpiresAt: expiresAt,
      })
      const approval = await runtime.vault.approveGrant({
        accessRequest: request,
        manifest: loadAgentIdentity(home, "cursor")!.manifest,
        selection: { kind: "custom", scopes: request.scopes, expiresAt },
      })
      await cursorAgent.completeAccessRequest(request, approval.response)
      saveGrants(home, "cursor", [...cursorAgent.grants])
      await approveProject(runtime, { agent: "cursor", cwd: workDir })
      claudeDesktopId = loadAgentIdentity(home, "claude-desktop")!.agentId
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile,
      now: () => fakeNow,
      log: () => {},
      drainDeps: { homeDir: mkdtempSync(join(tmpdir(), "mida-userhome-")) },
      tickMs: 30_000,
    })
    mcp = await connectMcp("claude-desktop")
  }, 600_000)

  afterAll(async () => {
    await mcp?.close()
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  })

  it("(a) claude-desktop saves through mida_save; codex's handoff shows it, authored by claude-desktop", async () => {
    const text = await callText(mcp!.client, "mida_save", SAVE_FIELDS)
    expect(text).toContain("saved")

    const runtime = await ownerRuntime()
    try {
      const read = await readCheckpoints(runtime, "codex", PROJECT_ID)
      const record = read.checkpoints.find((cp) => cp.checkpoint.objective === SAVE_FIELDS.objective)
      expect(record).toBeDefined()
      // the author is the signer the chain recorded — the MCP client's own identity, never a shared one
      expect(record!.authorId.toLowerCase()).toBe(claudeDesktopId.toLowerCase())
      expect(record!.checkpoint.agent).toBe("claude-desktop")
      expect(record!.checkpoint.source).toBe("agent-tool")
      // one stable session per identity + project — the merge treats every save as one history
      expect(record!.sessionId).toBe(mcpSaveSessionId("claude-desktop", PROJECT_ID))
      const handoff = await buildHandoff(runtime, { agent: "codex", cwd: workDir, authorNames: authorNamesFor(runtime) })
      expect(handoff.kind).not.toBe("refused")
      if (handoff.kind !== "refused") {
        expect(handoff.text).toContain(SAVE_FIELDS.objective)
        expect(handoff.text).toContain("claude-desktop")
      }
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("(b) the second save inside a minute is refused naming when the next is allowed — then the freed slot saves", async () => {
    const refused = await callText(mcp!.client, "mida_save", { ...SAVE_FIELDS, objective: "too soon" })
    expect(refused).toContain("once per minute")
    // nothing landed for the refused save
    const runtime = await ownerRuntime()
    try {
      const read = await readCheckpoints(runtime, "codex", PROJECT_ID)
      expect(read.checkpoints.some((cp) => cp.checkpoint.objective === "too soon")).toBe(false)
    } finally {
      await runtime.close()
    }
    fakeNow += 61_000
    const later = await callText(mcp!.client, "mida_save", { ...SAVE_FIELDS, objective: "after the minute" })
    expect(later).toContain("saved")
    const runtime2 = await ownerRuntime()
    try {
      const read = await readCheckpoints(runtime2, "codex", PROJECT_ID)
      const later2 = read.checkpoints.find((cp) => cp.checkpoint.objective === "after the minute")
      expect(later2).toBeDefined()
      // same stable session as the first save — handoff merging sees one history
      expect(later2!.sessionId).toBe(mcpSaveSessionId("claude-desktop", PROJECT_ID))
    } finally {
      await runtime2.close()
    }
  }, STEP_TIMEOUT)

  it("(c) an invalid shape is refused and the bad fields are named — forged identity fields included", async () => {
    const unknown = await saveReply(home, { agent: "claude-desktop", cwd: workDir, fields: { ...SAVE_FIELDS, surprise: "x" } })
    expect(unknown).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    if (unknown.kind === "refused") expect(unknown.fields).toContain("surprise")
    const missing = await saveReply(home, { agent: "claude-desktop", cwd: workDir, fields: { nextAction: "n" } })
    expect(missing.kind).toBe("refused")
    if (missing.kind === "refused") expect(missing.fields).toContain("objective")
    // the fields a model may not stamp are unknown keys to the validator — named, never honored
    for (const forged of ["createdAt", "agent", "eventId", "source", "sessionId", "projectId"]) {
      const result = await saveReply(home, { agent: "claude-desktop", cwd: workDir, fields: { ...SAVE_FIELDS, [forged]: "2099-01-01T00:00:00.000Z" } })
      expect(result.kind, forged).toBe("refused")
      if (result.kind === "refused") expect(result.fields, forged).toContain(forged)
    }
    // a non-object fields record, a missing cwd and a junk agent name are each a clean refusal
    expect((await saveReply(home, { agent: "claude-desktop", cwd: workDir, fields: "nope" })).kind).toBe("refused")
    expect((await saveReply(home, { agent: "claude-desktop", fields: SAVE_FIELDS })).kind).toBe("refused")
    expect((await saveReply(home, { agent: "../owner", cwd: workDir, fields: SAVE_FIELDS })).kind).toBe("refused")
  }, STEP_TIMEOUT)

  it("(d) a coding-agent identity cannot use the MCP save route — it signs for MCP clients only", async () => {
    const result = await saveReply(home, { agent: "codex", cwd: workDir, fields: SAVE_FIELDS })
    expect(result).toMatchObject({ kind: "refused", reason: "not-an-mcp-client" })
  }, STEP_TIMEOUT)

  it("(e) an approved client in an unapproved folder is refused by the same check the reads use", async () => {
    const result = await saveReply(home, { agent: "claude-desktop", cwd: otherDir, fields: SAVE_FIELDS })
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
    if (result.kind === "refused") expect(result.text).toContain("mida approve claude-desktop")
  }, STEP_TIMEOUT)

  it("(f) a READ-only grant gets the write-access line — request, then approve", async () => {
    const result = await saveReply(home, { agent: "cursor", cwd: workDir, fields: SAVE_FIELDS })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.text).toBe(
        "cursor can read but not write here — run `mida request cursor` and `mida approve cursor` to add write access",
      )
    }
  }, STEP_TIMEOUT)

  it("(g) a secret in a field is scrubbed with the compiler scrubber before the checkpoint is sealed", async () => {
    fakeNow += 61_000
    const secret = "AKIAIOSFODNN7EXAMPLE"
    const text = await callText(mcp!.client, "mida_save", { ...SAVE_FIELDS, objective: `the key ${secret} leaked` })
    expect(text).toContain("saved")
    const runtime = await ownerRuntime()
    try {
      const read = await readCheckpoints(runtime, "codex", PROJECT_ID)
      const record = read.checkpoints.find((cp) => cp.checkpoint.objective.includes("leaked"))
      expect(record).toBeDefined()
      expect(record!.checkpoint.objective).toContain("[REDACTED]")
      expect(JSON.stringify(record!.checkpoint)).not.toContain(secret)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("(h) a revoked client is refused even while its project row and keys still sit in the home", async () => {
    const runtime = await ownerRuntime()
    try {
      await revoke(runtime, "claude-desktop")
    } finally {
      await runtime.close()
    }
    const result = await saveReply(home, { agent: "claude-desktop", cwd: workDir, fields: SAVE_FIELDS })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") {
      expect(result.reason).toBe("revoked")
      expect(result.text).toContain("revoked")
    }
  }, STEP_TIMEOUT)
})
