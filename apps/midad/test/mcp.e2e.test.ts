import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  MidaHome,
  Runtime,
  approve,
  createMidaMcpServer,
  init,
  remember,
  requestAccess,
  revoke,
  saveCheckpoint,
  startDaemon,
  startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const SENTENCE = "Emergency state pulses the spacecraft and shows an EMERGENCY label; never red."
const PROJECT_ID = "proj-mcp-e2e"

/**
 * The MCP adapter end to end: a real midad on local Anvil behind a real MCP server and client
 * (the SDK's in-memory transport stands in for stdio). `claude-code` is the connected agent —
 * never `assistant`: `assistant` is `general_assistance`, which gets no project approval by
 * design (skeleton.ts), so it could never pass the folder gate this file is proving. `codex` is
 * provisioned but deliberately left unapproved for the refusal case.
 *
 * There is no `connectMcp` export: production wires stdio in mcp-main.ts, so the test wires the
 * same `createMidaMcpServer` the binary uses to an InMemoryTransport pair — the second pair in
 * test (c) is the plan's "a second server/client pair can be created" check.
 */
describe("mida-mcp against a real midad on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let workDir: string
  let daemon: DaemonHandle | undefined
  let checkpointId: string
  let mcp: { client: Client; close(): Promise<void> } | undefined

  /** A connected (client, server) pair over the SDK's in-memory transport — the test's connectMcp. */
  const connectMcp = async (agent: string) => {
    const server = createMidaMcpServer({
      home,
      agent,
      project: workDir,
      sessionId: `mcp-${agent}-e2e`,
      daemonUp: true,
    })
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

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-api-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-mcp-e2e-")))
    // the project marker exists before approve: the owner-signed list entry names this root
    workDir = mkdtempSync(join(tmpdir(), "mida-mcp-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))
    // init and approve run against the shared server from the start, so manifests, wraps and
    // grants live where the daemon will look for them. codex is provisioned and never approved —
    // the unapproved-refusal case needs an identity that exists but holds no grant.
    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      const saved = await saveCheckpoint(runtime, "claude-code", {
        projectId: PROJECT_ID,
        sessionId: "s-mcp-src",
        continuesSession: null,
        compiledBy: "test",
        checkpoint: sampleCheckpoint({ eventId: "cp-mcp-01", agent: "claude-code", objective: SENTENCE }),
      })
      checkpointId = saved.contextId
      // an owner fact the approved agent's READ scope covers — mida_read prints it verbatim
      await remember(runtime, SENTENCE)
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile,
      now: () => Date.now(),
      log: () => {},
      drainDeps: { homeDir: mkdtempSync(join(tmpdir(), "mida-userhome-")) },
      tickMs: 30_000, // no jobs are queued here; the tick is only the safety net
    })
    mcp = await connectMcp("claude-code")
  }, STEP_TIMEOUT * 4)

  afterAll(async () => {
    await mcp?.close()
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  })

  it("(a) mida_handoff returns the real handoff — the saved checkpoint's objective is in the text", async () => {
    const text = await callText(mcp!.client, "mida_handoff")
    expect(text).toContain(SENTENCE)
    // the handoff's covered ids seeded this session's seen set, so whats-new has nothing to add
    expect(await callText(mcp!.client, "mida_whats_new")).toBe("Mida: nothing new since the last check.")
  }, STEP_TIMEOUT)

  it("(b) mida_read prints what the daemon's own read prints — the checkpoint, then the owner fact", async () => {
    const projects = await callText(mcp!.client, "mida_read", { namespace: "projects.current" })
    expect(projects).toContain("projects.current: read 1 object(s)")
    expect(projects).toContain(checkpointId)
    const facts = await callText(mcp!.client, "mida_read", { namespace: "preferences.communication" })
    expect(facts).toContain("What you have told Mida about yourself")
    expect(facts).toContain(SENTENCE)
  }, STEP_TIMEOUT)

  it("(c) a second server/client pair for a provisioned-but-unapproved agent gets the not-approved line", async () => {
    const pair = await connectMcp("codex")
    try {
      expect(await callText(pair.client, "mida_handoff")).toBe(
        "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
      )
    } finally {
      await pair.close()
    }
  }, STEP_TIMEOUT)

  it("(d) revoking the agent mid-session turns the next call into the revoked line", async () => {
    // the owner command runs on its own runtime — the daemon holds midad.lock but Runtime.open
    // does not take it, which is exactly how `mida revoke` works while midad is up
    const ownerRuntime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await revoke(ownerRuntime, "claude-code")
    } finally {
      await ownerRuntime.close()
    }
    expect(await callText(mcp!.client, "mida_handoff")).toBe(
      "Mida: claude-code's access was revoked by the owner. Nothing was shared.",
    )
  }, STEP_TIMEOUT)

  it("(e) deleting the identity while the daemon runs answers the no-identity line on the next call", async () => {
    rmSync(join(home.root, "agents", "claude-code", "identity.json"))
    const expected = `Mida: no agent "claude-code" is set up in this Mida home (${home.root}). Nothing was shared.`
    // both read routes re-check the identity per call — handoff through checkAccess, read --as
    // through the /cli gate — so neither can keep serving a deleted identity
    expect(await callText(mcp!.client, "mida_handoff")).toBe(expected)
    expect(await callText(mcp!.client, "mida_read", { namespace: "projects.current" })).toBe(expected)
  }, STEP_TIMEOUT)
})
