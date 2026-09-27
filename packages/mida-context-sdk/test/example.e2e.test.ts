import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import { MidaHome, Runtime, approve, init, requestAccess, startDaemon } from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"

const STEP_TIMEOUT = 60_000
const PROJECT_ID = "proj-sdk-example"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const LOADER = join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")
const EXAMPLE = join(ROOT, "examples", "sdk-basic.ts")

interface ExampleRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * The example as an end user runs it: plain node, the repo's tsx loader, cwd = the project
 * folder. Async spawn, never spawnSync — the midad it talks to lives on this process's event
 * loop, and a sync spawn would freeze the daemon it is calling.
 */
const runExample = (env: Record<string, string | undefined>, cwd: string): Promise<ExampleRun> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", LOADER, EXAMPLE], {
      cwd,
      env: { ...process.env, ...env },
      timeout: STEP_TIMEOUT,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })

const compile = async (input: CompileInput): Promise<CompileResult> => ({
  ok: true,
  checkpoint: {
    eventId: input.eventId,
    agent: input.agent,
    source: "agent-tool",
    createdAt: new Date().toISOString(),
    objective: "stub",
    originalRequest: null,
    progress: [],
    decisions: [],
    rejected: [],
    constraints: [],
    artifacts: [],
    unresolvedIssue: null,
    nextAction: "stub",
    remainingPlan: [],
    evidence: [],
  },
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

/**
 * `examples/sdk-basic.ts` is a shipped document — the proof is that it runs unmodified against a
 * real midad on local Anvil, not that its lines are restated here. codex is approved; aider is
 * provisioned but never approved, so the same script takes the requestAccess path for it.
 */
describe("examples/sdk-basic.ts against a real midad on local Anvil", () => {
  let env: ScenarioEnvironment
  let home: MidaHome
  let workDir: string
  let daemon: DaemonHandle | undefined

  beforeAll(async () => {
    env = await localEnvironment()
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-example-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-example-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))

    const runtime = await Runtime.open(home, { ...network })
    try {
      await init(runtime, ["codex", "aider"])
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network,
      compile,
      now: () => Date.now(),
      log: () => {},
      drainDeps: { homeDir: mkdtempSync(join(tmpdir(), "mida-example-userhome-")) },
      tickMs: 30_000,
    })
  }, STEP_TIMEOUT * 4)

  afterAll(async () => {
    await daemon?.close()
    await env?.stop()
  })

  it("runs the seven-call walkthrough for an approved agent and exits 0", async () => {
    const out = await runExample({ MIDA_HOME: home.root, MIDA_AGENT: "codex" }, workDir)
    expect(out.stderr, `${out.stdout}\n${out.stderr}`).toBe("")
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0)
    // the same verdict line mida_status prints, then every call in order
    expect(out.stdout).toContain("codex: approved for this folder")
    expect(out.stdout).toMatch(/remembered 0x[0-9a-f]{64} \(anchored\)/)
    expect(out.stdout).toMatch(/context\(\) returned \d+ item\(s\)/)
    expect(out.stdout).toContain("verify: valid — commitment ok, author ok, grant-at-write ok")
    expect(out.stdout).toContain("handoff: ")
    expect(out.stdout).toContain("whatsNew: ")
  })

  it("a provisioned but unapproved agent takes the requestAccess path — and cannot approve itself", async () => {
    const out = await runExample({ MIDA_HOME: home.root, MIDA_AGENT: "aider" }, workDir)
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0)
    expect(out.stdout).toContain("aider: not approved for this folder")
    expect(out.stdout).toContain("access requested — run `mida approve aider` in a terminal")
    // the request really landed where the owner's `mida approve aider` looks for it
    expect(home.has("agents/aider/pending-request.json")).toBe(true)
  })

  it("says the service is down plainly and exits nonzero when midad is not running", async () => {
    const homeless = mkdtempSync(join(tmpdir(), "mida-example-nodaemon-"))
    const out = await runExample({ MIDA_HOME: homeless, MIDA_AGENT: "codex" }, workDir)
    expect(out.status).not.toBe(0)
    expect(out.stdout).toContain("midad: not answering")
    expect(out.stdout).toContain("run any `mida` command to start it")
  })
})
