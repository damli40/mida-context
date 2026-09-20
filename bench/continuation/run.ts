// bench/continuation/run.ts — the real-agent continuation benchmark: a fresh
// Codex session, given only "Continue.", finishes the work a Claude Code
// session started. Port of spike/harness/run.mjs onto the real midad: the
// spike's toy store and toy hooks are gone. The "mida" condition wires the
// product's own entry points (hook-main.ts / inject-main.ts — the same files
// the installed mida-hook / mida-inject bins exec) against a real midad home
// provisioned on the local chain, with a real daemon holding the home while
// the agents run.
//
//   --condition none|raw|mida  --run <n>  [--a-seconds 240]
//   [--codex-auth <path>]  [--dry-run]  [--agent-a-cmd|--agent-b-cmd '<json>']
//
// The three conditions differ only in what agent B sees at session start:
//   none — nothing; B works from the files agent A left behind
//   raw  — a session-start hook prints the scrubbed tail of A's own transcript
//   mida — the real session-start hook prints midad's merged handoff
// Scoring reads the FINISHED FILES in the run folder (which steps got built,
// which rubric constraints appear in them, whether the task's checks pass),
// plus tokens and seconds from agent B's own output.
//
// --dry-run prints the folder layout, the exact file contents and commands it
// would use, then exits 0 — it creates nothing and starts nothing. Without
// --dry-run the script refuses unless MIDA_BENCH_REAL_AGENTS=1, because real
// agent CLIs cost real tokens. Safety rules (unchanged from the spike): an
// auth file is only ever SYMLINKED, never opened or copied; ANTHROPIC_* vars
// are stripped from every child; --dangerously-bypass-hook-trust is used only
// with a throwaway CODEX_HOME this script created; nothing is read from
// spike/runs or any committed transcript.

import { execFileSync, spawn, spawnSync } from "node:child_process"
import {
  appendFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs"
import os from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { localEnvironment } from "@mida/cli"
import { compileCheckpoint, scrubTranscript } from "../../packages/compiler/src/index.js"
import {
  MidaHome, Runtime, approve, init, requestAccess, startDaemon,
} from "../../apps/midad/src/index.js"
import type { DaemonHandle } from "../../apps/midad/src/index.js"
import type { ScenarioEnvironment } from "@mida/cli"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const TOY_TASK = join(REPO_ROOT, "bench", "fixtures", "toy-task")
const HOOK_MAIN = join(REPO_ROOT, "apps", "midad", "src", "hook-main.ts")
const INJECT_MAIN = join(REPO_ROOT, "apps", "midad", "src", "inject-main.ts")
const RUNS_ROOT = join(REPO_ROOT, "bench", "continuation", "runs")
const WATCH = "msUntilAvailable" // string in bucket.mjs that ends A's run early
const RAW_TAIL_CHARS = 8_000 // ~the handoff's own size budget, so raw competes fairly
const QUEUE_WAIT_CAP_MS = 150_000
const B_LIMIT_MS = 600_000

// ==================== AGENT COMMAND BLOCK ====================
// The exact argv arrays handed to each agent CLI. B's prompt is exactly
// "Continue." — that is the benchmark. Agent A gets no Mida tools: capture is
// the hooks' job, invisible to the model, exactly as in the real install.
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]

const agentAArgv = (prompt: string, settings?: string): string[] => [
  "claude", "-p", prompt,
  "--model", "sonnet",
  "--permission-mode", "acceptEdits",
  "--allowedTools", "Edit Write Read Glob Grep Bash(node *) Bash(npm test*) Bash(git *)",
  "--setting-sources", "project",
  "--strict-mcp-config",
  ...(settings !== undefined ? ["--settings", settings] : []),
  "--output-format", "stream-json",
  "--verbose",
]

// Codex silently skips hooks the user has not personally trusted (it hashes
// the command text). The bypass is acceptable ONLY because CODEX_HOME is a
// throwaway folder this script wrote — never the operator's real one.
const agentBArgv = (): string[] => [
  "codex", "exec", "--dangerously-bypass-hook-trust", "Continue.",
  "--skip-git-repo-check", "--sandbox", "workspace-write",
]
// =============================================================

// The hook command text runs the entry point directly — nothing installs the
// mida-* bins onto PATH inside a run, and this is the same file they exec.
const injectCmd = (agent: string) => `node --import tsx ${INJECT_MAIN} ${agent}`
const hookCmd = (agent: string) => `node --import tsx ${HOOK_MAIN} ${agent}`

/** The hook element shape install.ts writes into Claude Code's settings.json. */
const hookElement = (command: string) => ({ hooks: [{ type: "command", command }] })

interface Args {
  condition: "none" | "raw" | "mida"
  run: number
  aSeconds: number
  codexAuth?: string
  dryRun: boolean
  agentACmd?: string
  agentBCmd?: string
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> & { dryRun: boolean } = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === "--dry-run") args.dryRun = true
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
    else throw new Error(`unknown arg: ${a}`)
  }
  if (!["none", "raw", "mida"].includes(args.condition ?? "")) {
    throw new Error("--condition none|raw|mida is required")
  }
  if (args.run === undefined || !/^\d+$/.test(args.run)) throw new Error("--run <n> is required")
  const aSeconds = args["a-seconds"] !== undefined ? Number(args["a-seconds"]) : 240
  if (!Number.isFinite(aSeconds) || aSeconds <= 0) throw new Error("--a-seconds needs a positive number")
  return {
    condition: args.condition as Args["condition"],
    run: Number.parseInt(args.run, 10),
    aSeconds,
    codexAuth: args["codex-auth"],
    dryRun: args.dryRun,
    agentACmd: args["agent-a-cmd"],
    agentBCmd: args["agent-b-cmd"],
  }
}

/** Every child's environment: the parent's minus anything ANTHROPIC_*. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_")) delete env[key]
  return env
}

// ---------- the files a run writes (dry-run prints these; real mode writes them) ----------

function claudeSettings(): Record<string, unknown> {
  const capture = hookElement(hookCmd("claude-code"))
  return {
    hooks: {
      SessionStart: [hookElement(injectCmd("claude-code"))],
      PostToolUse: [capture],
      Stop: [capture],
      StopFailure: [capture],
      PreCompact: [capture],
      SessionEnd: [capture],
    },
  }
}

function codexToml(condition: Args["condition"], runDir: string): string | null {
  if (condition === "none") return null
  if (condition === "raw") {
    return (
      `[[hooks.SessionStart]]\nmatcher = "startup|resume|clear|compact"\n\n` +
      `[[hooks.SessionStart.hooks]]\ntype = "command"\n` +
      `command = ${JSON.stringify(`node ${join(runDir, "print-file.mjs")} ${join(runDir, "raw-tail.txt")}`)}\n`
    )
  }
  // the real managed block's shape, with this run's command text substituted
  return (
    `[[hooks.SessionStart]]\nmatcher = "startup|resume|clear|compact"\n\n` +
    `[[hooks.SessionStart.hooks]]\ntype = "command"\n` +
    `command = ${JSON.stringify(injectCmd("codex"))}\n\n` +
    `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\n` +
    `command = ${JSON.stringify(hookCmd("codex"))}\n`
  )
}

const PRINT_FILE_SRC =
  'import { readFileSync } from "node:fs"\n' +
  "try { process.stdout.write(readFileSync(process.argv[2], \"utf8\")) } catch {}\n"

interface PlannedFile {
  rel: string
  content: string
}

/** Files whose CONTENT is known at plan time. raw-tail.txt is written after A exits. */
function planFiles(args: Args, runDir: string): PlannedFile[] {
  const files: PlannedFile[] = []
  if (args.condition === "mida") {
    files.push({ rel: "claude-settings.json", content: `${JSON.stringify(claudeSettings(), null, 2)}\n` })
  }
  const toml = codexToml(args.condition, runDir)
  if (toml !== null) files.push({ rel: "codex-home/config.toml", content: toml })
  if (args.condition === "raw") files.push({ rel: "print-file.mjs", content: PRINT_FILE_SRC })
  return files
}

/** The tree dry-run prints — what a real run would create. */
function layoutLines(args: Args, runDir: string, codexAuth: string | undefined): string[] {
  const rel = (p: string) => `  ${p}`
  const lines = [`${runDir}/`]
  lines.push(rel("work/                  toy-task copy minus TASK.md + score.json, git-initialised"))
  if (args.condition === "mida") {
    lines.push(rel("mida-home/             MIDA_HOME — provisioned on a local anvil chain"))
    lines.push(rel("claude-settings.json   agent A's --settings: the real mida hook commands"))
    lines.push(rel("daemon.jsonl           the daemon's event log"))
  }
  lines.push(rel("codex-home/            throwaway CODEX_HOME for agent B"))
  if (codexToml(args.condition, runDir) !== null) {
    lines.push(rel("codex-home/config.toml session-start hook (raw: prints the tail; mida: real inject)"))
  }
  if (codexAuth !== undefined) {
    lines.push(rel(`codex-home/auth.json   symlink -> ${resolve(codexAuth)} (never opened or copied)`))
  }
  if (args.condition === "raw") {
    lines.push(rel("print-file.mjs         the raw condition's hook script"))
    lines.push(rel("raw-tail.txt           scrubbed tail of A's transcript — written after A exits"))
  }
  lines.push(rel("a-output.jsonl         agent A stream-json"))
  lines.push(rel("b-output.txt           agent B output"))
  lines.push(rel("a-final.diff           work/ diff after agent A"))
  lines.push(rel("b-final.diff           work/ diff after agent B"))
  lines.push(rel("run.json               result record"))
  return lines
}

// ---------- real-mode helpers ----------

const git = (cwd: string, argv: string[]) => execFileSync("git", argv, { cwd, encoding: "utf8" })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Spawn a child with a hard lifetime cap; SIGTERM then SIGKILL after 5 s. */
function runChild(
  argv: readonly string[],
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdoutFd: number
    limitMs: number
    abortSignal?: AbortSignal
    stderrToStdout?: boolean
  },
): Promise<{ exitCode: number | null; seconds: number; reason: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, [...argv.slice(1)], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", opts.stdoutFd, opts.stderrToStdout === true ? opts.stdoutFd : "inherit"],
    })
    const started = Date.now()
    let reason = "exit"
    const stop = (why: string) => {
      reason = why
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref()
    }
    const timer = setTimeout(() => stop("timeout"), opts.limitMs)
    opts.abortSignal?.addEventListener("abort", () => stop(String(opts.abortSignal?.reason ?? "aborted")), { once: true })
    const done = (exitCode: number | null) => {
      clearTimeout(timer)
      resolvePromise({ exitCode, seconds: Math.round((Date.now() - started) / 1_000), reason })
    }
    child.on("exit", done)
    child.on("error", () => {
      reason = "spawn-error"
      done(null)
    })
  })
}

function snapshotDiff(work: string, outFile: string): void {
  writeFileSync(
    outFile,
    `=== git status ===\n${git(work, ["status", "--porcelain"])}\n=== git diff ===\n${git(work, ["diff", "HEAD"])}`,
  )
}

/** The newest Claude transcript touched since `sinceMs` — agent A's own session file. */
function newestTranscript(sinceMs: number): string | null {
  const root = join(os.homedir(), ".claude", "projects")
  let best: { path: string; mtime: number } | null = null
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(join(root, dir))) {
        if (!name.endsWith(".jsonl")) continue
        const file = join(root, dir, name)
        const mtime = statSync(file).mtimeMs
        if (mtime >= sinceMs && (best === null || mtime > best.mtime)) best = { path: file, mtime }
      }
    } catch { /* unreadable project dir — not ours */ }
  }
  return best?.path ?? null
}

/** Wait until the daemon has drained every queued job (bounded), mirroring the spike's inflight wait. */
async function waitQueueEmpty(midaHomePath: string, capMs: number): Promise<{ waitMs: number; left: number }> {
  const t0 = Date.now()
  const left = (): number => {
    try {
      return readdirSync(join(midaHomePath, "queue")).filter((n) => n.endsWith(".json")).length
    } catch {
      return 0
    }
  }
  while (left() > 0 && Date.now() - t0 < capMs) await sleep(500)
  return { waitMs: Date.now() - t0, left: left() }
}

/** Every file under work/, minus .git and node_modules — the finished state the score reads. */
function workFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(root)
  return out
}

interface Score {
  steps: string[]
  constraints: string[]
  checks: string[]
}

// ---------- dry-run ----------

function dryRun(args: Args): void {
  const runDir = join(RUNS_ROOT, args.condition, String(args.run))
  const work = join(runDir, "work")
  const codexHome = join(runDir, "codex-home")
  const midaHome = join(runDir, "mida-home")
  const taskText = readFileSync(join(TOY_TASK, "TASK.md"), "utf8")

  console.log("# run folder it would create")
  for (const line of layoutLines(args, runDir, args.codexAuth)) console.log(line)

  console.log("\n# files it would write (exact contents)")
  for (const f of planFiles(args, runDir)) {
    console.log(`--- ${join(runDir, f.rel)} ---`)
    process.stdout.write(f.content)
  }

  if (args.condition === "mida") {
    console.log("\n# provisioning it would run (in-process, local anvil chain)")
    console.log("  localEnvironment()                      fresh anvil + contract deploy")
    console.log("  Runtime.open(mida-home)                 home lock + embedded storage server")
    console.log("  init(runtime, [claude-code, codex])     owner keys + network.json")
    console.log("  requestAccess + approve claude-code     chain grant + project list row for work/")
    console.log("  requestAccess + approve codex           same, for agent B")
    console.log("  runtime.close() then startDaemon()      the daemon holds the home while agents run")
  }

  const commands = [
    {
      agent: "A",
      cwd: work,
      env: args.condition === "mida" ? { MIDA_HOME: midaHome } : {},
      argv: args.agentACmd !== undefined
        ? JSON.parse(args.agentACmd)
        : agentAArgv(taskText, args.condition === "mida" ? join(runDir, "claude-settings.json") : undefined),
    },
    {
      agent: "B",
      cwd: work,
      env: {
        CODEX_HOME: codexHome,
        ...(args.condition === "mida" ? { MIDA_HOME: midaHome } : {}),
      },
      argv: args.agentBCmd !== undefined ? JSON.parse(args.agentBCmd) : agentBArgv(),
    },
  ]
  console.log("\n# agent commands it would run (env shows additions only — every child gets the parent env minus ANTHROPIC_*)")
  for (const c of commands) console.log(JSON.stringify(c))
  console.log("\n# nothing was created and nothing was started")
}

// ---------- real run ----------

async function realRun(args: Args): Promise<number> {
  const runDir = join(RUNS_ROOT, args.condition, String(args.run))
  const work = join(runDir, "work")
  const codexHome = join(runDir, "codex-home")
  const midaHomePath = join(runDir, "mida-home")
  const startedMs = Date.now()

  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  cpSync(TOY_TASK, work, {
    recursive: true,
    // TASK.md stays out: a baseline B could otherwise read the objective from
    // disk. score.json stays out too — it is the rubric, not task material.
    filter: (src) => basename(src) !== "TASK.md" && basename(src) !== "score.json",
  })
  git(work, ["init", "-q"])
  git(work, ["add", "-A"])
  git(work, ["-c", "user.email=bench@local", "-c", "user.name=mida-bench", "commit", "-qm", "initial"])

  for (const f of planFiles(args, runDir)) {
    const p = join(runDir, f.rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, f.content)
  }
  if (args.codexAuth !== undefined) {
    symlinkSync(resolve(args.codexAuth), join(codexHome, "auth.json"))
  }

  // mida: provision a real home on the local chain, then hand it to a daemon.
  let chain: ScenarioEnvironment | null = null
  let daemon: DaemonHandle | null = null
  try {
  if (args.condition === "mida") {
    chain = await localEnvironment()
    const midaHome = new MidaHome(midaHomePath)
    const runtime = await Runtime.open(midaHome, {
      rpcUrl: chain.rpcUrl,
      deployment: chain.deployment,
      fund: chain.fund,
    })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", work)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", work)
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home: midaHome,
      network: {
        rpcUrl: chain.rpcUrl,
        deployment: chain.deployment,
        // the daemon holds agent keys only — funding is the owner CLI's job
        fund: async () => { throw new Error("the daemon cannot fund accounts") },
      },
      compile: compileCheckpoint,
      now: () => Date.now(),
      log: (entry) => appendFileSync(join(runDir, "daemon.jsonl"), `${JSON.stringify(entry)}\n`),
    })
  }

    // --- Agent A ---
    const aEnv = childEnv(args.condition === "mida" ? { MIDA_HOME: midaHomePath } : {})
    const apiKeyVarsStripped = API_KEY_VARS.some((k) => process.env[k] !== undefined)
    const aOut = openSync(join(runDir, "a-output.jsonl"), "w")
    const abort = new AbortController()
    const poll = setInterval(() => {
      try {
        if (readFileSync(join(work, "src", "bucket.mjs"), "utf8").includes(WATCH)) {
          abort.abort("msUntilAvailable implemented")
        }
      } catch { /* file not written yet */ }
    }, 2_000)
    const aArgv = args.agentACmd !== undefined
      ? (JSON.parse(args.agentACmd) as string[])
      : agentAArgv(
          readFileSync(join(TOY_TASK, "TASK.md"), "utf8"),
          args.condition === "mida" ? join(runDir, "claude-settings.json") : undefined,
        )
    const a = await runChild(aArgv, {
      cwd: work, env: aEnv, stdoutFd: aOut, limitMs: args.aSeconds * 1_000, abortSignal: abort.signal,
    })
    clearInterval(poll)
    closeSync(aOut)

    let aTurns = 0
    try {
      for (const line of readFileSync(join(runDir, "a-output.jsonl"), "utf8").split("\n")) {
        if (line === "") continue
        try {
          if ((JSON.parse(line) as { type?: string }).type === "assistant") aTurns += 1
        } catch { /* partial line */ }
      }
    } catch { /* no output file */ }
    if (aTurns === 0) {
      console.error("*** WARNING: Agent A produced no assistant output — treat this run as invalid ***")
    }
    snapshotDiff(work, join(runDir, "a-final.diff"))

    // mida: the daemon drains queued jobs through the real compile; wait for
    // the queue to empty so B's handoff reflects A's whole session.
    let queueWaitMs = 0
    let queueLeft = 0
    if (args.condition === "mida") {
      const waited = await waitQueueEmpty(midaHomePath, QUEUE_WAIT_CAP_MS)
      queueWaitMs = waited.waitMs
      queueLeft = waited.left
    }

    // raw: the tail of A's own transcript, scrubbed, is all B is allowed to see.
    let rawTailChars = 0
    if (args.condition === "raw") {
      const transcript = newestTranscript(startedMs)
      const text = transcript === null ? "" : scrubTranscript(readFileSync(transcript, "utf8"))
      const tail = text.slice(-RAW_TAIL_CHARS)
      writeFileSync(join(runDir, "raw-tail.txt"), tail)
      rawTailChars = tail.length
    }

    // --- Agent B ---
    const bOut = openSync(join(runDir, "b-output.txt"), "w")
    const bArgv = args.agentBCmd !== undefined ? (JSON.parse(args.agentBCmd) as string[]) : agentBArgv()
    const b = await runChild(bArgv, {
      cwd: work,
      env: childEnv({
        CODEX_HOME: codexHome,
        ...(args.condition === "mida" ? { MIDA_HOME: midaHomePath } : {}),
      }),
      stdoutFd: bOut,
      stderrToStdout: true,
      limitMs: B_LIMIT_MS,
    })
    closeSync(bOut)
    snapshotDiff(work, join(runDir, "b-final.diff"))

    // --- scoring: finished files, rubric constraints, the task's own checks ---
    const score = JSON.parse(readFileSync(join(TOY_TASK, "score.json"), "utf8")) as Score
    const files = workFiles(work)
    const fileText = files.map((f) => {
      try {
        return readFileSync(f, "utf8")
      } catch {
        return ""
      }
    })
    const steps = score.steps.map((rel) => {
      const p = join(work, rel)
      return { file: rel, built: existsSync(p) && statSync(p).size > 0 }
    })
    const constraints = score.constraints.map((s) => ({ constraint: s, literalInSource: fileText.some((t) => t.includes(s)) }))
    const checks = score.checks.map((cmd) => ({
      command: cmd,
      pass: spawnSync(cmd, { cwd: work, shell: true, env: childEnv() }).status === 0,
    }))
    const bOutput = readFileSync(join(runDir, "b-output.txt"), "utf8")
    const tokenMatch = /tokens used:\s*([\d,]+)/i.exec(bOutput)

    const run = {
      condition: args.condition,
      run: args.run,
      aStopReason: a.reason,
      aSeconds: a.seconds,
      aTurns,
      aProducedOutput: aTurns > 0,
      apiKeyVarsStripped,
      queueWaitMs,
      queueLeft,
      rawTailChars,
      bSeconds: b.seconds,
      bExitCode: b.exitCode,
      bTokensUsed: tokenMatch === null ? null : Number(tokenMatch[1]!.replaceAll(",", "")),
      stepsBuilt: steps.filter((s) => s.built).length,
      steps,
      constraints,
      checks,
    }
    writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
    console.log(JSON.stringify(run))
    return 0
  } finally {
    if (daemon !== null) await daemon.close()
    if (chain !== null) await chain.stop()
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    dryRun(args)
    return 0
  }
  if (process.env.MIDA_BENCH_REAL_AGENTS !== "1") {
    process.stderr.write(
      "refused: this runs real agent CLIs and real models. Pass --dry-run to see the plan, or set MIDA_BENCH_REAL_AGENTS=1 to run for real.\n",
    )
    return 2
  }
  return realRun(args)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    // stable code only — a message can carry paths or values
    const code = error instanceof Error ? error.name : "error"
    console.error(`harness: ${code}`)
    process.exitCode = 1
  })
