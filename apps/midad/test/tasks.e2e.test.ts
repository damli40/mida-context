import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  approve,
  callDaemon,
  init,
  requestAccess,
  runDoctor,
  runHook,
  saveCheckpoint,
  startDaemon,
  startPersistentApi,
  writeFolderTask,
} from "@mida/midad"
import type { DaemonHandle, HandoffResult, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000

const SDK_MARKER = "SDK-EFFORT-UNIQUE-TEXT"
const GA_MARKER = "GRANT-EFFORT-UNIQUE-TEXT"
const MAIN_MARKER = "MAIN-EFFORT-UNIQUE-TEXT"

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true, mode: 0o700 })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }), { mode: 0o600 })
}

/**
 * tk-1 end to end on local Anvil: one project folder carrying three named tasks at once. A real
 * daemon answers the socket, the hook path stamps and pins tasks, and the drain saves them —
 * proving the pinned task, not a later folder default, is what each session's checkpoint carries.
 */
describe("named tasks on local Anvil (tk-1)", () => {
  let env: ScenarioEnvironment
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let daemon: DaemonHandle | undefined
  let workDir: string
  let hookHomeDir: string

  const handoff = async (agent: string, cwd: string, sessionId?: string, task?: string) =>
    (await callDaemon(home, "/handoff", { agent, cwd, sessionId, task }, { timeoutMs: STEP_TIMEOUT })).body as HandoffResult

  const cli = async (...argv: string[]) =>
    (await callDaemon(home, "/cli", { argv, cwd: workDir }, { timeoutMs: STEP_TIMEOUT })).body as { code: number; lines: string[] }

  beforeAll(async () => {
    env = await localEnvironment()
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-tasks-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-tasks-e2e-")))
    workDir = join(mkdtempSync(join(tmpdir(), "mida-tasks-work-")), "work")
    mark(workDir, "proj-tasks")
    hookHomeDir = mkdtempSync(join(tmpdir(), "mida-tasks-hook-"))

    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      // three checkpoints in ONE project, one per task — sdk and grant-app are named, the third
      // is an ordinary save with no task field (every record written before tasks exist)
      await saveCheckpoint(runtime, "claude-code", {
        projectId: "proj-tasks",
        sessionId: "sess-sdk",
        continuesSession: null,
        compiledBy: "test",
        task: "sdk",
        checkpoint: sampleCheckpoint({ eventId: "cp-tasks-sdk", objective: SDK_MARKER, progress: ["sdk progress line"] }),
      })
      await saveCheckpoint(runtime, "claude-code", {
        projectId: "proj-tasks",
        sessionId: "sess-ga",
        continuesSession: null,
        compiledBy: "test",
        task: "grant-app",
        checkpoint: sampleCheckpoint({ eventId: "cp-tasks-ga", objective: GA_MARKER, progress: ["grant progress line"] }),
      })
      await saveCheckpoint(runtime, "codex", {
        projectId: "proj-tasks",
        sessionId: "sess-main",
        continuesSession: null,
        compiledBy: "test",
        checkpoint: sampleCheckpoint({ eventId: "cp-tasks-main", objective: MAIN_MARKER, progress: ["main progress line"] }),
      })
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      // the compiled checkpoint names its session so a drain save can be told apart per task
      compile: async (input) => ({
        ok: true as const,
        checkpoint: sampleCheckpoint({
          eventId: input.eventId,
          agent: input.agent,
          objective: `objective-for-${input.sessionId ?? "none"}`,
        }),
        compiledBy: "test",
        droppedKeys: [],
        trimmed: [],
        attempts: 1,
        retried: 0,
        format: "claude-jsonl",
        messagesKept: 1,
        messagesTotal: 1,
        charsSent: 0,
        modelMs: 0,
      }),
      drainDeps: { homeDir: hookHomeDir },
      now: () => Date.now(),
      log: () => {},
      tickMs: 60_000,
    })
  }, STEP_TIMEOUT * 6)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  }, 120_000)

  it("(a) a grant-app handoff holds none of sdk's or main's text — and exactly one mention line each", async () => {
    const result = await handoff("codex", workDir, "sess-va", "grant-app")
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain(GA_MARKER)
    expect(result.text).not.toContain(SDK_MARKER)
    expect(result.text).not.toContain(MAIN_MARKER)
    const mentions = result.text.split("\n").filter((line) => /^- (sdk|main) — /.test(line))
    expect(mentions).toHaveLength(2)
    expect(mentions.some((line) => line.startsWith("- sdk — claude-code — "))).toBe(true)
    // the untasked save counts as the `main` task and gets its own mention
    expect(mentions.some((line) => line.startsWith("- main — codex — "))).toBe(true)
  }, STEP_TIMEOUT)

  it("(b) an untasked handoff sees only main's thread, with sdk and grant-app as mentions", async () => {
    const result = await handoff("codex", workDir, "sess-vb")
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain(MAIN_MARKER)
    expect(result.text).not.toContain(SDK_MARKER)
    expect(result.text).not.toContain(GA_MARKER)
    expect(result.text).toContain("Other active tasks in this project")
    const mentions = result.text.split("\n").filter((line) => /^- (sdk|grant-app) — /.test(line))
    expect(mentions).toHaveLength(2)
  }, STEP_TIMEOUT)

  it("(c) the concurrency regression: two live sessions keep the task they started under when the folder default moves", async () => {
    // session A starts under sdk, session B under grant-app — each through the real hook path,
    // which resolves + pins at enqueue (invariant 1)
    const transcriptFor = (sid: string) => {
      const p = join(hookHomeDir, ".claude", "projects", "proj", `${sid}.jsonl`)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
      return p
    }
    const fire = async (sid: string, envVars: NodeJS.ProcessEnv, event = "PostToolUse") =>
      runHook({
        agent: "claude-code",
        stdin: JSON.stringify({ hook_event_name: event, session_id: sid, transcript_path: transcriptFor(sid), cwd: workDir }),
        home,
        homeDir: hookHomeDir,
        env: envVars,
        parentBasename: () => undefined,
        spawnDrainer: () => {},
      })
    await fire("sess-a", { MIDA_TASK: "sdk" })
    await fire("sess-b", { MIDA_TASK: "grant-app" })
    // the folder default moves to a THIRD task while both sessions run — must not move either
    writeFolderTask(workDir, "third")
    // later events in the same sessions carry no env — the pin, not the new default, decides
    await fire("sess-a", {})
    await fire("sess-b", {})
    const drainLog = () => (home.has("logs/drain.jsonl") ? readFileSync(home.path("logs/drain.jsonl"), "utf8") : "")
    const deadline = Date.now() + 45_000
    for (;;) {
      const log = drainLog()
      const aSaved = log.split("\n").some((line) => line.includes('"sessionId":"sess-a"') && line.includes('"outcome":"saved"'))
      const bSaved = log.split("\n").some((line) => line.includes('"sessionId":"sess-b"') && line.includes('"outcome":"saved"'))
      if (aSaved && bSaved) break
      if (Date.now() > deadline) throw new Error(`sess-a/sess-b never saved; drain log:\n${log}`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const log = drainLog()
    expect(log).toContain('"sessionId":"sess-a"')
    const aLine = log.split("\n").find((line) => line.includes('"sessionId":"sess-a"') && line.includes('"outcome":"saved"'))!
    const bLine = log.split("\n").find((line) => line.includes('"sessionId":"sess-b"') && line.includes('"outcome":"saved"'))!
    expect(aLine).toContain('"task":"sdk"')
    expect(bLine).toContain('"task":"grant-app"')

    // and the saved checkpoints file under those tasks: the sdk handoff holds sess-a's compiled
    // objective, never sess-b's
    const sdkHandoff = await handoff("codex", workDir, "sess-check-a", "sdk")
    expect(sdkHandoff.kind).toBe("handoff")
    if (sdkHandoff.kind !== "handoff") return
    expect(sdkHandoff.text).toContain("objective-for-sess-a")
    expect(sdkHandoff.text).not.toContain("objective-for-sess-b")
  }, STEP_TIMEOUT * 2)

  it("(d) `mida task` sets the folder default, lists tasks, shows one task read-only, and clears", async () => {
    // set — through the daemon /cli route, exactly as the real binary reaches it
    const set = await cli("task", "sdk")
    expect(set.code).toBe(0)
    expect(set.lines.join("\n")).toContain("current task: sdk")
    expect(readFileSync(join(workDir, ".mida", "task.json"), "utf8")).toContain('"sdk"')

    // list — the tasks the project holds, newest activity first
    const list = await cli("task")
    expect(list.code).toBe(0)
    expect(list.lines[0]).toBe("current task: sdk (folder)")
    const taskLines = list.lines.filter((line) => /^  \S+ — /.test(line))
    expect(taskLines.some((line) => line.startsWith("  sdk — "))).toBe(true)
    expect(taskLines.some((line) => line.startsWith("  grant-app — "))).toBe(true)
    expect(taskLines.some((line) => line.startsWith("  main — "))).toBe(true)

    // show — the deliberate boundary crossing; a handoff for sdk and nothing else
    const before = {
      tasks: home.has("state/tasks") ? readdirSync(home.path("state/tasks")) : [],
      continues: home.has("state/continues") ? readdirSync(home.path("state/continues")) : [],
      lastseen: home.has("state/lastseen") ? readdirSync(home.path("state/lastseen")) : [],
    }
    const show = await cli("task", "show", "sdk")
    expect(show.code).toBe(0)
    // the read ran under an approved agent's identity and the output says which (in-18 N3)
    expect(show.lines[0]).toBe("(read as claude-code)")
    const shown = show.lines.join("\n")
    // the sdk thread — its newest chain is sess-a's drain save from (c); the named task's own
    // text only, nothing from grant-app or main
    expect(shown).toContain("objective-for-sess-a")
    expect(shown).not.toContain(GA_MARKER)
    expect(shown).not.toContain(MAIN_MARKER)
    expect(shown).not.toContain("objective-for-sess-b")
    // read-only: no pin, no continuation link, no seen-mark was written for it
    const after = {
      tasks: home.has("state/tasks") ? readdirSync(home.path("state/tasks")) : [],
      continues: home.has("state/continues") ? readdirSync(home.path("state/continues")) : [],
      lastseen: home.has("state/lastseen") ? readdirSync(home.path("state/lastseen")) : [],
    }
    expect(after).toEqual(before)

    // clear — back to main, file gone
    const cleared = await cli("task", "--clear")
    expect(cleared.code).toBe(0)
    expect(existsSync(join(workDir, ".mida", "task.json"))).toBe(false)
    const bare = await cli("task")
    expect(bare.lines[0]).toBe("current task: main (default)")
  }, STEP_TIMEOUT * 2)

  it("(e) a named-task handoff's continuation record carries the task for a resume", async () => {
    const result = await handoff("codex", workDir, "sess-resume", "sdk")
    expect(result.kind).toBe("handoff")
    const record = home.readJson<{ continues: string; projectId: string; task?: string }>("state/continues/sess-resume.json")
    expect(record?.projectId).toBe("proj-tasks")
    expect(record?.task).toBe("sdk")
    // and the pin was written — the same session's next events resolve without re-asking
    expect(home.readJson<{ task: string }>("state/tasks/sess-resume.json")?.task).toBe("sdk")
  }, STEP_TIMEOUT)

  it("(f) `mida doctor` prints the folder's current task", async () => {
    writeFolderTask(workDir, "sdk")
    const lines: string[] = []
    await runDoctor({ home, cwd: workDir, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 200 })
    expect(lines).toContain("ok: this folder's current task is sdk")
    await cli("task", "--clear")
  }, STEP_TIMEOUT)

  it("(g) invariant 2: a task is envelope content — both saves share the project's namespace and ordinary record ids", async () => {
    // proven at the chain level by construction: the saves in beforeAll used identical
    // project/namespace/session plumbing and only differed in the envelope's task field.
    // The readable proof here is that all three land in ONE project read.
    const result = await handoff("codex", workDir, "sess-inv")
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    // the current task's thread is main; the named tasks are mentions — one read, one project
    expect(result.text).toContain(MAIN_MARKER)
    expect(result.text).toContain("- sdk — claude-code — ")
    expect(result.text).toContain("- grant-app — claude-code — ")
  }, STEP_TIMEOUT)
})
