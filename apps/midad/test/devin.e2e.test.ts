import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  DEVIN_DB_SCHEMA, MidaHome, Runtime, approve, callDaemon, enqueue, init, listJobs, requestAccess, startDaemon,
  startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, HandoffResult, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const HOOK_MAIN = fileURLToPath(new URL("../src/hook-main.ts", import.meta.url))
const INJECT_MAIN = fileURLToPath(new URL("../src/inject-main.ts", import.meta.url))
const PROJECT_ID = "proj-devin"
const SESSION = "bald-swordfish"

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

/**
 * The devin client end to end on local Anvil: a real spawned mida-hook writes a
 * fake-Devin-payload job, the real daemon drains it against a synthetic sessions.db,
 * and the saved checkpoint is authored by devin — then the handoff each side serves
 * names the other by its own identity.
 */
describe("devin hook -> drain -> save -> handoff, on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let daemon: DaemonHandle | undefined
  let workDir: string
  let hookHomeDir: string
  let dbPath: string

  const handoff = async (agent: string, cwd: string, sessionId?: string) =>
    (await callDaemon(home, "/handoff", { agent, cwd, sessionId }, { timeoutMs: STEP_TIMEOUT })).body as HandoffResult

  const drainLines = () =>
    home.has("logs/drain.jsonl") ? readFileSync(home.path("logs/drain.jsonl"), "utf8").split("\n") : []
  const savedFor = async (sessionId: string, ms = 30_000) => {
    const deadline = Date.now() + ms
    for (;;) {
      if (drainLines().some((line) => line.includes(`"sessionId":"${sessionId}"`) && line.includes('"outcome":"saved"'))) return
      if (drainLines().some((line) => line.includes(`"sessionId":"${sessionId}"`) && line.includes('"outcome":"bad"'))) {
        throw new Error(`${sessionId} went bad: ${drainLines().filter((l) => l.includes(sessionId)).join("\n")}`)
      }
      if (Date.now() > deadline) throw new Error(`${sessionId} never saved; drain log ${drainLines().join("\n")}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** A real spawned entry — exit code and output, never an in-process call. */
  const spawnEntry = (script: string, agent: string, payload: unknown, extraEnv: NodeJS.ProcessEnv) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // DEVIN_PROJECT_DIR is set ONLY when the test says so — an inherited one from a
      // shell that itself runs inside Devin would trip the foreign-client guard on the
      // claude-code spawn, exactly the leak D1 exists to catch
      const env: NodeJS.ProcessEnv = { ...process.env, MIDA_HOME: home.root, ...extraEnv }
      if (extraEnv.DEVIN_PROJECT_DIR === undefined) delete env.DEVIN_PROJECT_DIR
      const child = spawn(process.execPath, ["--import", "tsx", script, agent], {
        env,
        cwd: REPO_ROOT,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8") })
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8") })
      child.on("error", reject)
      child.stdin.on("error", () => {})
      child.on("exit", (code) => resolve({ status: code, stdout, stderr }))
      child.stdin.end(JSON.stringify(payload))
    })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-devin-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-devin-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-devin-work-"))
    mark(workDir, PROJECT_ID)
    hookHomeDir = mkdtempSync(join(tmpdir(), "mida-devin-home-"))

    // the synthetic sessions.db — the exact schema, never real Devin data
    const dbDir = join(hookHomeDir, ".local", "share", "devin", "cli")
    mkdirSync(dbDir, { recursive: true })
    dbPath = join(dbDir, "sessions.db")
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): { run(...params: unknown[]): void }
        close(): void
      }
    }
    const db = new DatabaseSync(dbPath)
    db.exec(DEVIN_DB_SCHEMA)
    db.prepare(
      `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at,
        last_activity_at, main_chain_id) VALUES (?, ?, 'devin', 'model-x', 'agent', 1, 2, ?)`,
    ).run(SESSION, workDir, 4)
    const node = db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    node.run(SESSION, 1, null, JSON.stringify({ role: "system", content: "you are devin" }), 1)
    node.run(SESSION, 2, 1, JSON.stringify({ role: "user", content: "port the tokenizer to a worker", metadata: { is_user_input: true } }), 2)
    node.run(SESSION, 3, 2, JSON.stringify({ role: "assistant", content: "moved the hot loop" }), 3)
    node.run(SESSION, 4, 3, JSON.stringify({ role: "assistant", content: "all tests green" }), 4)
    db.close()

    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["devin", "claude-code"])
      await requestAccess(runtime, "devin")
      await approve(runtime, "devin", workDir)
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
    } finally {
      await runtime.close()
    }

    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile: async (input) => ({
        ok: true as const,
        checkpoint: sampleCheckpoint({
          eventId: input.eventId,
          agent: input.agent,
          originalRequest: input.agent === "devin" ? "port the tokenizer to a worker" : "claude-code asked for the dashboard",
          objective: `${input.agent} checkpoint`,
          progress: [`${input.agent} work`],
        }),
        compiledBy: "test", droppedKeys: [], trimmed: [], attempts: 1, retried: 0,
        format: "devin-sqlite", messagesKept: 1, messagesTotal: 1, charsSent: 0, modelMs: 0,
      }),
      // the drain resolves the db the way the hook did — the override env, not the
      // default path under hookHomeDir
      drainDeps: { homeDir: hookHomeDir, env: { MIDA_DEVIN_DB: dbPath } },
      now: () => Date.now(),
      log: () => {},
      tickMs: 60_000,
    })
  }, 600_000)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  }, 120_000)

  it("(a) a fake Devin payload runs the real hook, drains against the db, and saves a checkpoint authored by devin", async () => {
    const res = await spawnEntry(HOOK_MAIN, "devin",
      { hook_event_name: "Stop", session_id: SESSION },
      { MIDA_DEVIN_DB: dbPath, DEVIN_PROJECT_DIR: workDir })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe("") // the hook never speaks to stdout

    const queued = listJobs(home)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ agent: "devin", event: "Stop", sessionId: SESSION, transcriptPath: dbPath, cwd: workDir })

    await callDaemon(home, "/kick", {}, { timeoutMs: STEP_TIMEOUT })
    await savedFor(SESSION)
    expect(listJobs(home)).toHaveLength(0)

    // the on-chain author is devin — a claude-code handoff in the same project names it
    const result = await handoff("claude-code", workDir)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain("- devin (on-chain author")
    expect(result.text).not.toContain("bald-swordfish\"")
  }, STEP_TIMEOUT * 2)

  it("(b) the reverse direction: a claude-code save shows up in a devin SessionStart handoff", async () => {
    // a claude-code session saves through the queue the hook writes — enqueued directly
    // rather than spawned, because the spawned hook pins the real ~/.claude/projects,
    // which a test must never write
    const claudeTranscriptDir = join(hookHomeDir, ".claude", "projects", "proj")
    mkdirSync(claudeTranscriptDir, { recursive: true })
    const transcript = join(claudeTranscriptDir, "sess-claude.jsonl")
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "build the dashboard" } }) + "\n")
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "sess-claude", transcriptPath: transcript, cwd: workDir, error: null })
    await callDaemon(home, "/kick", {}, { timeoutMs: STEP_TIMEOUT })
    await savedFor("sess-claude")

    // Devin starts a session in the same approved project: the inject entry answers
    // with the handoff naming claude-code — never flattened to "assistant"
    const out = await spawnEntry(INJECT_MAIN, "devin",
      { hook_event_name: "SessionStart", session_id: "calm-otter" },
      { DEVIN_PROJECT_DIR: workDir })
    expect(out.status).toBe(0)
    expect(out.stderr).toBe("")
    const reply = JSON.parse(out.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
    const context = reply.hookSpecificOutput?.additionalContext ?? ""
    expect(context).toContain("MIDA HANDOFF")
    expect(context).toContain("- claude-code (on-chain author")
    // the earlier devin checkpoint is one of the "other recent sessions" — named devin,
    // not flattened to assistant or claude-code
    expect(context).toContain("- devin checkpoint — devin, last saved")
    expect(context).not.toContain("- devin checkpoint — claude-code")
    expect(context).toContain("claude-code asked for the dashboard")
  }, STEP_TIMEOUT * 2)
})
