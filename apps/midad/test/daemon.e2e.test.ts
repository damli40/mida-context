import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
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
  loadOwnerAddress, ownerOnlyLine, readOwnerFacts, requestAccess, revoke, saveCheckpoint, startDaemon,
  startPersistentApi, unwrapCheckpoint,
} from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"
import { ensureCurrentDaemon } from "../src/control.js"
import type { CodeIdentity } from "../src/code-identity.js"
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
  }, 600_000)

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
  let codexTranscriptPath: string
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
      retried: 0,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    }
  }

  const start = (over: { identity?: CodeIdentity; compile?: typeof compile } = {}) =>
    startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile: over.compile ?? compile,
      now: () => Date.now(),
      log: (entry) => daemonLogs.push(entry),
      drainDeps: { homeDir },
      tickMs: 30_000, // tests kick explicitly; the tick is only the safety net
      ...(over.identity === undefined ? {} : { identity: over.identity }),
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
  const cli = (argv: string[]) => callDaemon(home, "/cli", { argv, cwd: workDir }, { timeoutMs: STEP_TIMEOUT })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-api-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-daemon-e2e-")))
    // the project marker exists before approve: the owner-signed list entry names this root
    workDir = mkdtempSync(join(tmpdir(), "mida-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: "proj-daemon" }))
    // init and approve run against the shared server from the start, so manifests, wraps and
    // grants live where the daemon will look for them. `assistant` gets its READ-only grant at
    // init by design, so the owner revokes it here: test (a) needs an agent that can ask and must
    // never get an approval through the socket.
    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex", "assistant"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      await revoke(runtime, "assistant")
    } finally {
      await runtime.close()
    }
    // daemon-main reads storageUrl from network.json — the same file init wrote
    home.writeSecretJson("network.json", { ...(home.readJson("network.json") as Record<string, unknown>), storageUrl: apiServer.baseUrl })
    homeDir = mkdtempSync(join(tmpdir(), "mida-userhome-"))
    mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
    transcriptPath = join(homeDir, ".claude", "projects", "proj", "transcript.jsonl")
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "Build a thing" } }) + "\n")
    // codex keeps its grant through test (e)'s claude-code revocation — the jobs tests (f) and (g)
    // queue must belong to an agent the drain can still approve at that point
    mkdirSync(join(homeDir, ".codex", "sessions"), { recursive: true })
    codexTranscriptPath = join(homeDir, ".codex", "sessions", "rollout-test.jsonl")
    writeFileSync(codexTranscriptPath, JSON.stringify({ timestamp: "2026-09-21T10:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build a thing" }] } }) + "\n")
    daemon = await start()
  }, 600_000)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  })

  it("(a) /cli request for a revoked agent works — but /cli approve is refused and nothing is signed", async () => {
    // `request` is agent-signed and grants nothing by itself, so the socket may run it
    const requested = await cli(["request", "assistant"])
    expect(requested.body).toMatchObject({ code: 0 })
    expect(home.has("agents/assistant/pending-request.json")).toBe(true)
    // `approve` changes who has access — the daemon refuses it outright
    const approved = await cli(["approve", "assistant"])
    expect(approved.body).toEqual({ code: 2, lines: [ownerOnlyLine("approve")] })
    // the chain is the judge, not the reply text: nothing live for assistant — its init-time
    // grant was revoked in beforeAll and the socket's approve signed nothing
    const reader = new RegistryReader({
      publicClient: createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) }),
      deployment: env.deployment,
    })
    const owner = loadOwnerAddress(home)!
    const agentId = loadAgentIdentity(home, "assistant")!.agentId
    const ids = await reader.activeCapabilityIds(owner, agentId)
    for (const id of ids) {
      expect(await isCapabilityLive({ publicClient: createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) }), deployment: env.deployment }, id)).toBe(false)
    }
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
      // the index lives outside the queue now (CAP-25): every save this home has made is still
      // listed — s1, the two s2 saves and s-crash
      const savedIds = home.readJson<Record<string, string>>("state/saved-ids.json") ?? {}
      expect(Object.keys(savedIds)).toHaveLength(4)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  }, STEP_TIMEOUT * 2)

  it("(e) a revoked agent cannot re-approve itself through the socket — and the socket cannot revoke or remember either", async () => {
    // The attack the runtime split exists to stop: the owner revokes claude-code, and the agent —
    // which shares the OS user and can reach the socket — asks for access and then tries to grant
    // it to itself. The daemon holds no owner key, so the approve must be refused and nothing may
    // change on the chain or on disk.
    const reader = new RegistryReader({
      publicClient: createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) }),
      deployment: env.deployment,
    })
    const publicClient = createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) })
    const owner = loadOwnerAddress(home)!
    const ownerRuntime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await revoke(ownerRuntime, "claude-code")
      const projectsPath = home.path("approved-projects.json")
      const projectsBytes = readFileSync(projectsPath)
      const factsBefore = await readOwnerFacts(ownerRuntime, "codex")

      // the ask is agent-signed and allowed; every authority-changing call is refused
      expect((await cli(["request", "claude-code"])).body).toMatchObject({ code: 0 })
      expect((await cli(["approve", "claude-code"])).body).toEqual({ code: 2, lines: [ownerOnlyLine("approve")] })
      expect((await cli(["revoke", "codex"])).body).toEqual({ code: 2, lines: [ownerOnlyLine("revoke")] })
      expect((await cli(["remember", "the owner likes tabs"])).body).toEqual({ code: 2, lines: [ownerOnlyLine("remember")] })
      expect((await cli(["init"])).body).toEqual({ code: 2, lines: [ownerOnlyLine("init")] })

      // the chain is the judge: claude-code still has no live capability, codex still has its grant
      const claudeIds = await reader.activeCapabilityIds(owner, loadAgentIdentity(home, "claude-code")!.agentId)
      for (const id of claudeIds) {
        expect(await isCapabilityLive({ publicClient, deployment: env.deployment }, id)).toBe(false)
      }
      const codexIds = await reader.activeCapabilityIds(owner, loadAgentIdentity(home, "codex")!.agentId)
      expect(codexIds.length).toBeGreaterThan(0)
      expect((await Promise.all(codexIds.map((id) => isCapabilityLive({ publicClient, deployment: env.deployment }, id)))).some(Boolean)).toBe(true)

      // and nothing on disk moved: the revocation marker stands and the signed list is byte-identical
      expect(home.has("agents/claude-code/revoked.json")).toBe(true)
      expect(readFileSync(projectsPath)).toEqual(projectsBytes)
      // the remember never landed: codex sees exactly the facts that were there before
      expect(await readOwnerFacts(ownerRuntime, "codex")).toEqual(factsBefore)
    } finally {
      await ownerRuntime.close()
    }
  }, STEP_TIMEOUT)

  it("(f) H6: a service running other code is replaced — and no queued job is lost", async () => {
    // the shared daemon gives the home up, then an "old" daemon takes it — one that reports
    // code living at /a @ 1 while this command's code is /b @ 2
    await daemon?.close()
    daemon = undefined
    const stale = await start({ identity: { codeRoot: "/a", codeCommit: "1" } })
    expect(stale.alreadyRunning).toBe(false)
    expect((await callDaemon(home, "/health", undefined, { timeoutMs: 2_000 })).body).toMatchObject({ codeRoot: "/a", codeCommit: "1" })

    // codex jobs: claude-code was revoked on chain by test (e) and would be dropped pre-compile
    const j1 = job({ agent: "codex", sessionId: "s-h6-one", transcriptPath: codexTranscriptPath })
    const j2 = job({ agent: "codex", sessionId: "s-h6-two", transcriptPath: codexTranscriptPath })

    let spawned: Promise<DaemonHandle> | undefined
    const result = await ensureCurrentDaemon(
      home,
      () => {
        // the replacement starts the same way cli.ts's spawnDaemon would — from THIS code
        spawned = start({ identity: { codeRoot: "/b", codeCommit: "2" } })
      },
      { waitMs: STEP_TIMEOUT, self: { codeRoot: "/b", codeCommit: "2" } },
    )

    expect(result.up).toBe(true)
    expect(result.replaced).toMatchObject({ codeRoot: "/a", codeCommit: "1" })
    // the old service is gone: /health now answers with the replacement's identity
    const health = await callDaemon(home, "/health", undefined, { timeoutMs: 5_000 })
    expect(health.body).toMatchObject({ codeRoot: "/b", codeCommit: "2" })
    daemon = await spawned!

    // no job was lost in the handover: each is still queued, or was already saved
    const queuedIds = new Set(listJobs(home).map((j) => j.id))
    const savedSessions = new Set((await readThrough("codex", "proj-daemon")).map((e) => e.sessionId))
    for (const j of [j1, j2]) {
      expect(queuedIds.has(j.id) || savedSessions.has(j.sessionId)).toBe(true)
    }
  }, STEP_TIMEOUT)

  it("(g) POST /shutdown answers ok, waits for the save in flight, then stops answering", async () => {
    await daemon?.close()
    daemon = undefined
    // a compile the test holds open: the drain pass sits inside it until released
    let releaseCompile: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseCompile = resolve })
    let calls = 0
    const gatedCompile = async (input: CompileInput): Promise<CompileResult> => {
      calls += 1
      await gate
      return compile(input)
    }
    const held = await start({ compile: gatedCompile })
    try {
      job({ agent: "codex", sessionId: "s-shutdown", transcriptPath: codexTranscriptPath })
      const before = calls
      await kick()
      await poll(() => calls > before) // a pass is now in flight inside the gated compile

      const reply = await callDaemon(home, "/shutdown", {}, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toEqual({ ok: true })
      // the save is still in flight: the service keeps answering while close() waits for it
      expect((await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })).status).toBe(200)

      releaseCompile!()
      await poll(async () => (await callDaemon(home, "/health", undefined, { timeoutMs: 500 })).status === 0)
      // the in-flight save landed before the service went down — nothing was dropped
      await poll(async () => (await readThrough("codex", "proj-daemon")).some((e) => e.sessionId === "s-shutdown"))
      expect(listJobs(home).some((j) => j.sessionId === "s-shutdown")).toBe(false)
    } finally {
      releaseCompile?.()
      await held.close() // already closed by /shutdown — close() is idempotent
    }
  }, STEP_TIMEOUT)
})
