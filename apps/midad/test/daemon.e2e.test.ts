import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { privateKeyToAccount } from "viem/accounts"
import { createPublicClient, http } from "viem"
import { ContextApiClient, RegistryReader } from "@mida/api"
import { chainFor } from "@mida/chain"
import { bytesOf } from "@mida/crypto"
import { MidaAgent } from "@mida/sdk"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  FileAccessRequestStore, MidaHome, NAMESPACE, Runtime, approve, callDaemon, enqueue, init,
  isCapabilityLive, listJobs, loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets,
  requestAccess, saveCheckpoint, startDaemon, startPersistentApi, unwrapCheckpoint,
} from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000

describe("Network.storageUrl", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-storageurl-")))
    const runtime = await Runtime.open(home, network)
    try {
      await init(runtime, ["claude-code"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code")
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT * 3)

  afterAll(async () => {
    await env?.stop()
  })

  it("rejects a non-local http URL and an unparseable URL with bad-storage-url before taking the lock", async () => {
    for (const bad of ["http://169.254.169.254:80", "ftp://example.com/x", "not a url"]) {
      const runtime = Runtime.open(home, { ...network, storageUrl: bad })
      await expect(runtime).rejects.toMatchObject({ code: "bad-storage-url" })
      expect(home.has("midad.lock")).toBe(false)
    }
  })

  it("with a remote storage URL the runtime starts no local server and saves land in that server's folder", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mida-data-"))
    const server = await startPersistentApi({ rpcUrl: network.rpcUrl, deployment: network.deployment, dataDir: join(elsewhere, "data") })
    try {
      const before = readdirSync(home.path("data")).sort()
      const runtime = await Runtime.open(home, { ...network, storageUrl: server.baseUrl })
      try {
        expect(runtime.apiBaseUrl).toBe(server.baseUrl)
        await saveCheckpoint(runtime, "claude-code", {
          projectId: "proj-remote",
          sessionId: "s-remote",
          continuesSession: null,
          compiledBy: "test",
          checkpoint: sampleCheckpoint({ eventId: "cp-remote01", agent: "claude-code" }),
        })
      } finally {
        await runtime.close()
      }
      // the save went to the OTHER server's data folder; this home's data dir is untouched
      expect(readdirSync(join(elsewhere, "data")).length).toBeGreaterThan(0)
      expect(readdirSync(home.path("data")).sort()).toEqual(before)
    } finally {
      await server.close()
    }
  }, STEP_TIMEOUT)
})

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const DAEMON_MAIN = fileURLToPath(new URL("../src/daemon-main.ts", import.meta.url))

/**
 * The daemon end to end on local Anvil. One shared API server stands in for remote storage
 * (`network.storageUrl`), so the tests can read "through the server" while the daemon itself holds
 * `midad.lock` — no second Runtime.open is possible or needed.
 */
describe("the long-running midad", () => {
  let env: ScenarioEnvironment
  let network: Network
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let homeDir: string
  let workDir: string
  let transcriptPath: string
  let daemon: DaemonHandle | undefined
  let compileCalls: CompileInput[] = []
  let duringPass: (() => void) | undefined
  const daemonLogs: object[] = []

  const compile = async (input: CompileInput): Promise<CompileResult> => {
    compileCalls.push(input)
    duringPass?.()
    return {
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    }
  }

  const start = () =>
    startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile,
      now: () => Date.now(),
      log: (entry) => daemonLogs.push(entry),
      drainDeps: { homeDir },
      tickMs: 30_000, // tests kick explicitly; the tick is only the safety net
    })

  const poll = async (check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("poll timed out")
  }

  const job = (over: Record<string, unknown> = {}) =>
    enqueue(home, {
      agent: "claude-code",
      event: "Stop",
      sessionId: "s1",
      transcriptPath,
      cwd: workDir,
      error: null,
      ...over,
    } as Parameters<typeof enqueue>[1])

  /** A real protocol read through the API server as a named agent — the daemon holds the lock, so this builds the agent by hand. */
  const readThrough = async (name: string, projectId: string) => {
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
    const objects = await agent.read(owner, NAMESPACE)
    return objects.flatMap((object) => {
      const envelope = unwrapCheckpoint(object.payload.value)
      return envelope !== null && envelope.projectId === projectId ? [envelope] : []
    })
  }

  const kick = () => callDaemon(home, "/kick", {}, { timeoutMs: 2_000 })
  const cli = (argv: string[]) => callDaemon(home, "/cli", { argv }, { timeoutMs: STEP_TIMEOUT })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-api-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-daemon-e2e-")))
    // init and approve run against the shared server from the start, so manifests, wraps and
    // grants live where the daemon will look for them
    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code")
    } finally {
      await runtime.close()
    }
    // daemon-main reads storageUrl from network.json — the same file init wrote
    home.writeSecretJson("network.json", { ...(home.readJson("network.json") as Record<string, unknown>), storageUrl: apiServer.baseUrl })
    workDir = mkdtempSync(join(tmpdir(), "mida-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: "proj-daemon" }))
    homeDir = mkdtempSync(join(tmpdir(), "mida-userhome-"))
    mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
    transcriptPath = join(homeDir, ".claude", "projects", "proj", "transcript.jsonl")
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "Build a thing" } }) + "\n")
    daemon = await start()
  }, STEP_TIMEOUT * 4)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  })

  it("(a) /cli request + approve for codex run inside the daemon; the chain shows the capability live", async () => {
    const requested = await cli(["request", "codex"])
    expect(requested.body).toMatchObject({ code: 0 })
    const approved = await cli(["approve", "codex"])
    expect(approved.body).toMatchObject({ code: 0 })
    // the chain is the judge, not the reply text
    const reader = new RegistryReader({
      publicClient: createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) }),
      deployment: env.deployment,
    })
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const agentId = loadAgentIdentity(home, "codex")!.agentId
    const ids = await reader.activeCapabilityIds(owner, agentId)
    expect(ids.length).toBeGreaterThan(0)
    const lives = await Promise.all(ids.map((id) => isCapabilityLive({ publicClient: createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) }), deployment: env.deployment }, id)))
    expect(lives.some(Boolean)).toBe(true)
  }, STEP_TIMEOUT)

  it("(b) /kick drains a queued Stop job; the record reads back through the server as codex", async () => {
    job()
    const reply = await kick()
    expect(reply.body).toEqual({ ok: true })
    // the record lands on the server a beat before the pass finishes removing the job file
    await poll(async () => (await readThrough("codex", "proj-daemon")).length >= 1 && listJobs(home).length === 0)
    expect(compileCalls.length).toBeGreaterThan(0)
    const found = await readThrough("codex", "proj-daemon")
    expect(found).toHaveLength(1)
    expect(found[0]!.sessionId).toBe("s1")
  }, STEP_TIMEOUT)

  it("(c) a job that lands mid-pass is saved without another kick", async () => {
    // while the first compile runs, the session grows and its Stop job lands — the pass already
    // listed the queue, so only the post-pass re-list can catch it
    duringPass = () => {
      appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mid-pass work" }] } }) + "\n")
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s2", transcriptPath, cwd: workDir, error: null })
      duringPass = undefined
    }
    job({ sessionId: "s2" })
    await kick()
    await poll(async () => (await readThrough("codex", "proj-daemon")).length >= 3 && listJobs(home).length === 0)
  }, STEP_TIMEOUT)

  it("(d) SIGKILL mid-run: the next startDaemon takes over lock and socket and saves the queued job once", async () => {
    // the shared in-process daemon must give the home up before the child can own it
    await daemon?.close()
    daemon = undefined
    const child = spawn(process.execPath, ["--import", "tsx", DAEMON_MAIN], {
      env: { ...process.env, MIDA_HOME: home.root },
      cwd: REPO_ROOT,
      stdio: "ignore",
    })
    try {
      await poll(async () => {
        const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
        return reply.status === 200 && (reply.body as { pid?: number }).pid === child.pid
      })
      // queue a job, then kill before the child's first 15 s tick can reach it
      job({ sessionId: "s-crash" })
      process.kill(child.pid!, "SIGKILL")
      await new Promise((resolve) => child.once("exit", resolve))

      const takeover = await start()
      daemon = takeover
      expect(takeover.alreadyRunning).toBe(false)
      const health = await callDaemon(home, "/health", undefined, { timeoutMs: 2_000 })
      expect((health.body as { pid?: number }).pid).toBe(process.pid)

      await kick()
      // the job saves exactly once: one s-crash record on the server, and the queue drained
      await poll(async () => (await readThrough("codex", "proj-daemon")).some((e) => e.sessionId === "s-crash") && listJobs(home).length === 0)
      // every listJobs sweeps an unparseable queue/*.json into queue/bad — including the
      // saved-ids index — so after a settled pass the index sits there with the last save's entry
      const savedIds = home.readJson<Record<string, string>>("queue/bad/saved-ids.json") ?? home.readJson<Record<string, string>>("queue/saved-ids.json") ?? {}
      expect(Object.keys(savedIds)).toHaveLength(1)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  }, STEP_TIMEOUT * 2)
})
