import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { privateKeyToAccount } from "viem/accounts"
import { ContextApiClient } from "@mida/api"
import { increaseLocalTime } from "@mida/chain"
import { bytesOf } from "@mida/crypto"
import { FakeVaultAuthority } from "@mida/fake-vault"
import { MidaAgent } from "@mida/sdk"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  FileAccessRequestStore, MidaHome, NAMESPACE, Runtime, approve, callDaemon, enqueue, init,
  loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets, requestAccess, saveCheckpoint,
  startDaemon, startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, HandoffResult, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const INJECT_MAIN = fileURLToPath(new URL("../src/inject-main.ts", import.meta.url))
const ORIGINAL_REQUEST = "Move the billing engine to worker threads"

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

/**
 * The handoff end to end on local Anvil: a real daemon owns the home and answers POST /handoff
 * over the socket, while the tests read "through the server" as named agents — the shared API
 * server (`network.storageUrl`) is what both sides see. doomed-agent exists only to be revoked,
 * so the revoke test never has to re-approve anyone.
 */
describe("POST /handoff on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let daemon: DaemonHandle | undefined
  const daemonLogs: object[] = []
  let workDir: string
  let emptyDir: string
  let movedDir: string
  let unapprovedDir: string
  let saved1: { contextId: string }
  let saved2: { contextId: string }

  let hookHomeDir: string

  const handoff = async (agent: string, cwd: string, sessionId?: string) =>
    (await callDaemon(home, "/handoff", { agent, cwd, sessionId }, { timeoutMs: STEP_TIMEOUT })).body as HandoffResult

  /** A real protocol read through the API server as a named agent — the daemon holds the lock. */
  const readThrough = async (name: string) => {
    const identity = loadAgentIdentity(home, name)!
    const signer = privateKeyToAccount(identity.signerPrivateKey)
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const agent = new MidaAgent({
      agentId: identity.agentId,
      callbackOrigin: identity.callbackOrigin,
      encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
      chain: env.writeContext(signer),
      api: new ContextApiClient({
        baseUrl: apiServer.baseUrl,
        account: signer,
        chainId: env.deployment.chainId,
        capabilityRegistry: env.deployment.capabilityRegistry,
      }),
      requests: new FileAccessRequestStore(home, name),
      grants: loadGrants(home, name),
    })
    return agent.read(owner, NAMESPACE)
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-handoff-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-handoff-e2e-")))
    const dir = mkdtempSync(join(tmpdir(), "mida-handoff-work-"))
    workDir = join(dir, "work")
    emptyDir = join(dir, "empty")
    movedDir = join(dir, "moved")
    unapprovedDir = join(dir, "lonely")
    mark(workDir, "proj-hand")
    mark(emptyDir, "proj-empty")
    mark(movedDir, "proj-hand") // same marker as workDir — a copied project folder
    mark(unapprovedDir, "proj-lonely")
    // a stand-in for the user's real home — transcripts the drain accepts live under it
    hookHomeDir = mkdtempSync(join(tmpdir(), "mida-hook-home-"))

    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex", "doomed-agent"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      await approve(runtime, "codex", emptyDir) // second folder: a list row, no new grant
      await requestAccess(runtime, "doomed-agent")
      await approve(runtime, "doomed-agent", workDir)
      // two sessions, two agents: codex's session continues claude-code's
      saved1 = await saveCheckpoint(runtime, "claude-code", {
        projectId: "proj-hand",
        sessionId: "sess-a",
        continuesSession: null,
        compiledBy: "test",
        checkpoint: sampleCheckpoint({
          eventId: "cp-hand-01",
          agent: "claude-code",
          originalRequest: ORIGINAL_REQUEST,
          objective: "Port the billing engine to workers",
          remainingPlan: ["extract the tokenizer loop"],
          nextAction: "Move the tokenizer",
          progress: ["mapped the hot paths"],
        }),
      })
      saved2 = await saveCheckpoint(runtime, "codex", {
        projectId: "proj-hand",
        sessionId: "sess-b",
        continuesSession: "sess-a",
        compiledBy: "test",
        checkpoint: sampleCheckpoint({
          eventId: "cp-hand-02",
          agent: "codex",
          createdAt: "2026-09-21T11:00:00.000Z",
          objective: "Finish the worker port",
          nextAction: "Wire the worker pool",
          progress: ["tokenizer moved"],
        }),
      })
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      // stands in for the model: the queued transcript compiles to this checkpoint
      compile: async (input) => ({
        ok: true as const,
        checkpoint: sampleCheckpoint({
          eventId: input.eventId, agent: input.agent, createdAt: "2026-09-21T12:00:00.000Z",
          objective: "Finish the worker port", nextAction: "Wire the worker pool", progress: ["sess-c work"],
        }),
        compiledBy: "test", droppedKeys: [], trimmed: [], attempts: 1,
        format: "claude-jsonl", messagesKept: 1, messagesTotal: 1, charsSent: 0, modelMs: 0,
      }),
      drainDeps: { homeDir: hookHomeDir },
      now: () => Date.now(),
      log: (entry) => daemonLogs.push(entry),
      tickMs: 60_000,
    })
  }, STEP_TIMEOUT * 6)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  })

  it("(a) an approved agent gets the merged handoff: the first session's request verbatim, then both record ids", async () => {
    const result = await handoff("codex", workDir)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.checkpoints).toBe(2)
    expect(result.facts).toBe(0)
    // the ORIGINAL REQUEST block is the first content inside the fence, word for word
    const afterBegin = result.text.split("=== BEGIN MIDA HANDOFF DATA ===\n\n")[1]!
    expect(
      afterBegin.startsWith(
        `ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):\n${ORIGINAL_REQUEST}`,
      ),
    ).toBe(true)
    expect(result.text).toContain(saved1.contextId)
    expect(result.text).toContain(saved2.contextId)
    expect(result.text).toContain("- claude-code (on-chain author")
    expect(result.text).toContain("- codex (on-chain author")
    // the daemon log line carries codes and counts — never the request or the handoff text
    const entry = daemonLogs.map((e) => e as Record<string, unknown>).find((e) => e.event === "handoff")!
    expect(entry).toMatchObject({ agent: "codex", kind: "handoff", checkpoints: 2, facts: 0 })
    expect(JSON.stringify(entry)).not.toContain("billing engine")
  }, STEP_TIMEOUT)

  it("(b) an approved project with nothing saved answers empty, not a refusal", async () => {
    const result = await handoff("codex", emptyDir)
    expect(result).toMatchObject({ kind: "empty", facts: 0 })
    expect((result as { text: string }).text).toBe("Mida: connected. Nothing has been saved for this project yet.")
  }, STEP_TIMEOUT)

  it("(c) a folder the agent was never approved for gets the not-approved line", async () => {
    const result = await handoff("claude-code", unapprovedDir)
    expect(result).toEqual({
      kind: "refused",
      reason: "not-approved",
      text: "Mida: claude-code is not approved for this project — run `mida approve claude-code` in this folder.",
    })
  }, STEP_TIMEOUT)

  it("(d) a copied project folder refuses folder-mismatch before any read", async () => {
    const result = await handoff("codex", movedDir)
    expect(result).toEqual({
      kind: "refused",
      reason: "folder-mismatch",
      text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
    })
    // the zero-reads guarantee is proven with spies in handoff.test.ts — the refusal is the e2e half
    const entry = daemonLogs.map((e) => e as Record<string, unknown>).filter((e) => e.event === "handoff").at(-1)!
    expect(entry).toMatchObject({ agent: "codex", kind: "refused", reason: "folder-mismatch", checkpoints: 0, facts: 0 })
  }, STEP_TIMEOUT)

  it("(e) inject-main prints the same handoff through the real socket, exit 0, empty stderr", async () => {
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", INJECT_MAIN, "codex"], {
        env: { ...process.env, MIDA_HOME: home.root },
        cwd: REPO_ROOT,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8") })
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8") })
      child.on("error", reject)
      child.stdin.on("error", () => {})
      child.on("exit", (code) => resolve({ status: code, stdout, stderr }))
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-b", cwd: workDir }))
    })
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toContain("MIDA HANDOFF")
    expect(res.stdout).toContain(ORIGINAL_REQUEST)
    expect(res.stdout).toContain(saved1.contextId)
    expect(res.stdout).toContain(saved2.contextId)
  }, 30_000)

  it("(f) a third session continues the chain: the served handoff becomes its continuesSession link", async () => {
    // the session-start hook carries the NEW session's id — the daemon records the chain head it served
    const served = await handoff("codex", workDir, "sess-c")
    expect(served.kind).toBe("handoff")
    expect(home.readJson("state/continues/sess-c.json")).toEqual({ continues: "sess-b", projectId: "proj-hand" })

    // that session's own save then goes through the real hook path: enqueue, kick, drain, chain write
    const transcript = join(hookHomeDir, ".claude", "projects", "proj", "sess-c.jsonl")
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "sess-c", transcriptPath: transcript, cwd: workDir, error: null })
    await callDaemon(home, "/kick", {}, { timeoutMs: STEP_TIMEOUT })
    const deadline = Date.now() + 20_000
    let merged: HandoffResult
    for (;;) {
      merged = await handoff("claude-code", workDir, "sess-d")
      if (merged.kind === "handoff" && merged.checkpoints === 3) break
      if (Date.now() > deadline) {
        const drainLog = home.has("logs/drain.jsonl") ? readFileSync(home.path("logs/drain.jsonl"), "utf8") : "(none)"
        throw new Error(`sess-c's checkpoint was never saved; last handoff ${JSON.stringify(merged)}; drain log ${drainLog}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // the merged chain leads with the FIRST session's request — a tool switch, not "Continue."
    if (merged!.kind !== "handoff") throw new Error("expected a handoff")
    const afterBegin = merged!.text.split("=== BEGIN MIDA HANDOFF DATA ===\n\n")[1]!
    expect(
      afterBegin.startsWith(
        `ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):\n${ORIGINAL_REQUEST}`,
      ),
    ).toBe(true)
    // and the head moved: the next session's record points at sess-c, the newest link in the chain
    expect(home.readJson("state/continues/sess-d.json")).toEqual({ continues: "sess-c", projectId: "proj-hand" })
  }, STEP_TIMEOUT)

  it("(g) an agent the chain shows revoked gets the revoked line — and the server refuses the read itself", async () => {
    // revoke on the chain only, leaving the approved-projects row in place: the check passes,
    // the chain's own capability record says revoked. (mida revoke would also drop the row, which
    // is the not-approved path — tested above.)
    const secrets = loadOrCreateOwnerSecrets(home)
    const ownerAccount = privateKeyToAccount(secrets.privateKey)
    const vault = new FakeVaultAuthority({
      seed: bytesOf(secrets.seed, 32),
      p256PrivateKey: secrets.p256PrivateKey,
      chain: env.writeContext(ownerAccount),
      api: new ContextApiClient({
        baseUrl: apiServer.baseUrl,
        account: ownerAccount,
        chainId: env.deployment.chainId,
        capabilityRegistry: env.deployment.capabilityRegistry,
      }),
    })
    await vault.approveRevocation({ kind: "agent", agentId: loadAgentIdentity(home, "doomed-agent")!.agentId })
    const result = await handoff("doomed-agent", workDir)
    expect(result).toEqual({
      kind: "refused",
      reason: "revoked",
      text: "Mida: doomed-agent's access was revoked by the owner. Nothing was shared.",
    })
    // the refusal is the server's word, not our message: the same read our builder skipped is
    // attempted here and the API answers CAPABILITY_REVOKED
    await expect(readThrough("doomed-agent")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
  }, STEP_TIMEOUT)

  it("(h) an expired grant answers not-approved (Anvil time travel)", async () => {
    // grants live 30 days — last test in the file: the moved clock must not leak into anything else
    await increaseLocalTime(env.rpcUrl, 33n * 24n * 60n * 60n)
    const result = await handoff("codex", workDir)
    expect(result).toEqual({
      kind: "refused",
      reason: "not-approved",
      text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
    })
  }, STEP_TIMEOUT)
})
