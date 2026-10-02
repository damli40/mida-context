// bench/continuation/run.ts — the real-agent continuation benchmark: a fresh
// Codex session, given only "Continue.", finishes the work a Claude Code
// session started. Port of spike/harness/run.mjs onto the real midad: the
// spike's toy store and toy hooks are gone. The "mida" condition wires the
// product's own entry points (hook-main.ts / inject-main.ts — the same files
// the installed mida-hook / mida-inject bins exec) against a real midad home
// provisioned on the local chain, with a real daemon holding the home while
// the agents run.
//
//   --condition none|raw|mida  --run <n>  [--a-seconds 240]  [--stop-at <text>]
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
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync,
  closeSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs"
import os from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { localEnvironment } from "@mida/cli"
import {
  compileCheckpoint, readConversation, scrubTranscript,
} from "../../packages/compiler/src/index.js"
import {
  MidaHome, Runtime, approve, init, requestAccess, startDaemon,
} from "../../apps/midad/src/index.js"
import type { DaemonHandle } from "../../apps/midad/src/index.js"
import type { ScenarioEnvironment } from "@mida/cli"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
// The September task the runner was written for: five steps built in order,
// with WATCH (below) appearing in step 3, so agent A is stopped mid-task and
// agent B has real work to continue. bench/fixtures/toy-task is a different,
// older task where the watch string never appears.
const TOY_TASK = join(REPO_ROOT, "bench", "fixtures", "continuation-task")
const HOOK_MAIN = join(REPO_ROOT, "apps", "midad", "src", "hook-main.ts")
const INJECT_MAIN = join(REPO_ROOT, "apps", "midad", "src", "inject-main.ts")
export const RUNS_ROOT = join(REPO_ROOT, "bench", "continuation", "runs")
// Default text the poll looks for in src/bucket.mjs to stop agent A early.
// Overridden by --stop-at: today's Claude Code writes several steps in one
// edit, so the point where A is stopped is a setting, not a constant.
const WATCH = "msUntilAvailable"
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
// tsx is named by its absolute loader path: the work folder lives outside the
// repo while the agents run, so "--import tsx" alone would not resolve there.
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")
export const injectCmd = (agent: string) => `node --import ${TSX_LOADER} ${INJECT_MAIN} ${agent}`
export const hookCmd = (agent: string) => `node --import ${TSX_LOADER} ${HOOK_MAIN} ${agent}`

/** The hook element shape install.ts writes into Claude Code's settings.json. */
const hookElement = (command: string) => ({ hooks: [{ type: "command", command }] })

interface Args {
  condition: "none" | "raw" | "mida"
  run: number
  aSeconds: number
  /** the text in src/bucket.mjs that stops agent A; default WATCH */
  stopAt: string
  codexAuth?: string
  dryRun: boolean
  agentACmd?: string
  agentBCmd?: string
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> & { dryRun: boolean } = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === "--dry-run") args.dryRun = true
    else if (a.startsWith("--")) {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      args[a.slice(2)] = v
    } else throw new Error(`unknown arg: ${a}`)
  }
  if (!["none", "raw", "mida"].includes(args.condition ?? "")) {
    throw new Error("--condition none|raw|mida is required")
  }
  if (args.run === undefined || !/^\d+$/.test(args.run)) throw new Error("--run <n> is required")
  const aSeconds = args["a-seconds"] !== undefined ? Number(args["a-seconds"]) : 240
  if (!Number.isFinite(aSeconds) || aSeconds <= 0) throw new Error("--a-seconds needs a positive number")
  const stopAt = args["stop-at"] ?? WATCH
  if (args["stop-at"] !== undefined && (args["stop-at"] === "" || args["stop-at"].startsWith("--"))) {
    throw new Error("--stop-at needs a non-empty string")
  }
  return {
    condition: args.condition as Args["condition"],
    run: Number.parseInt(args.run, 10),
    aSeconds,
    stopAt,
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
  lines.push(rel("work/                  a temp folder outside the repo while the agents run (task copy minus TASK.md + score.json, git-initialised); copied here at the end"))
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

/** The session id Claude Code printed in its stream-json output: the first line that parses as
 *  JSON and carries a non-empty string `session_id`. Null when there is none. */
export function sessionIdOf(aOutputText: string): string | null {
  for (const line of aOutputText.split("\n")) {
    let body: unknown
    try {
      body = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof body !== "object" || body === null) continue
    const id = (body as Record<string, unknown>).session_id
    if (typeof id !== "string" || id === "") continue
    // only letters, digits and "-" make an id; anything else could be a path
    return /^[A-Za-z0-9-]+$/.test(id) ? id : null
  }
  return null
}

/** The path of `<projectsRoot>/<any one folder>/<sessionId>.jsonl`, or null when no folder under
 *  projectsRoot holds that file (or projectsRoot cannot be read). Never looks at any other file. */
export function transcriptOfSession(projectsRoot: string, sessionId: string): string | null {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsRoot)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* not in this folder */ }
  }
  return null
}

/** The token count in agent B's output: "tokens used: 1,234" or the two-line
 *  layout codex prints today ("tokens used" then the number on the next line). */
export function tokensUsedOf(bOutputText: string): number | null {
  const m = /tokens used:?\s*([\d,]+)/i.exec(bOutputText)
  return m === null ? null : Number(m[1]!.replaceAll(",", ""))
}

/** Whether agent B ran at all: a clean exit, or at least 60 seconds of work
 *  (a B that worked until the harness's time limit did run). */
export function bRanOf(exitCode: number | null, seconds: number): boolean {
  return exitCode === 0 || seconds >= 60
}

/** What the `raw` condition pastes: the readable text of agent A's Claude Code session (the same
 *  text Mida's summary step reads), scrubbed, cut to its last `chars` characters. */
export function rawPasteOf(transcriptPath: string, chars: number): { text: string; fullChars: number } {
  const scrubbed = scrubTranscript(readConversation(transcriptPath).text)
  return { text: scrubbed.slice(-chars), fullChars: scrubbed.length }
}

const HARNESS_MARKERS = ["TASK.md", "score.json", "a-output", "raw-tail"]

/** Which harness artefacts appear in agent B's output: run-folder files one
 *  level up from the work folder, or the repo root path itself. A record for
 *  the person reading the results — the summary does not use it. */
export function harnessMarkersIn(bOutputText: string, repoRoot: string): string[] {
  const found = new Set(HARNESS_MARKERS.filter((m) => bOutputText.includes(m)))
  if (bOutputText.includes(repoRoot)) found.add(repoRoot)
  return [...found].sort()
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

/** One thing the finished files must show (present) or must not show (absent). */
export interface Probe {
  name: string
  /** one file, relative to the work folder */
  file?: string
  /** every regular file under this folder, relative to the work folder, recursively */
  under?: string
  /** a regular expression that must match at least one of the texts */
  present?: string
  /** a regular expression that must match none of the texts */
  absent?: string
  /** regular-expression flags, for example "im" */
  flags?: string
}

export interface Score {
  steps: Probe[]
  constraints: Probe[]
  /** each check is one command as a list of words, run in the work folder */
  checks: string[][]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

/** Reads and validates a score.json; throws an Error prefixed "score.json: ". */
export function loadScore(path: string): Score {
  const fail = (why: string): never => {
    throw new Error(`score.json: ${why}`)
  }
  const body: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(body)) return fail("not an object")
  if (!Array.isArray(body.steps) || body.steps.length === 0) return fail("steps is not a non-empty array")
  if (!Array.isArray(body.constraints)) return fail("constraints is not an array")
  if (!Array.isArray(body.checks)) return fail("checks is not an array")
  const probe = (v: unknown): v is Probe => {
    if (!isRecord(v) || typeof v.name !== "string") return false
    const targets = [v.file, v.under].filter((t) => typeof t === "string").length
    const patterns = [v.present, v.absent].filter((t) => typeof t === "string").length
    return targets === 1 && patterns === 1 && (v.flags === undefined || typeof v.flags === "string")
  }
  if (!body.steps.every(probe)) return fail("a step needs a string name, exactly one of file/under, exactly one of present/absent")
  if (!body.constraints.every(probe)) return fail("a constraint needs a string name, exactly one of file/under, exactly one of present/absent")
  const check = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string")
  if (!body.checks.every(check)) return fail("a check is not a non-empty array of strings")
  return body as unknown as Score
}

/** The texts a probe reads: one file's content, or every regular file under a folder. */
function probeTexts(work: string, probe: Probe): string[] {
  const texts: string[] = []
  const read = (p: string) => {
    try {
      texts.push(readFileSync(p, "utf8"))
    } catch { /* unreadable file gives no text */ }
  }
  if (probe.file !== undefined) {
    read(join(work, probe.file))
    return texts
  }
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) read(p)
    }
  }
  try {
    walk(join(work, probe.under!))
  } catch { /* missing folder gives no text */ }
  return texts
}

export function probeHolds(work: string, probe: Probe): boolean {
  const re = new RegExp(probe.present ?? probe.absent!, probe.flags ?? "")
  const anyMatch = probeTexts(work, probe).some((t) => re.test(t))
  return probe.present !== undefined ? anyMatch : !anyMatch
}

export function scoreFiles(work: string, score: Score): {
  steps: { file: string; built: boolean }[]
  constraints: { constraint: string; kept: boolean }[]
} {
  return {
    steps: score.steps.map((probe) => ({ file: probe.name, built: probeHolds(work, probe) })),
    constraints: score.constraints.map((probe) => ({ constraint: probe.name, kept: probeHolds(work, probe) })),
  }
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
  console.log(`\n# agent A is stopped when the text ${JSON.stringify(args.stopAt)} appears in src/bucket.mjs`)
  console.log("\n# nothing was created and nothing was started")
}

// ---------- real run ----------

async function realRun(args: Args): Promise<number> {
  // The hook commands resolve tsx by absolute path; without the file they
  // would fail only after an agent had been paid for.
  if (!existsSync(TSX_LOADER)) {
    throw new Error(`harness: ${TSX_LOADER} is missing; run pnpm install`)
  }
  // The rubric loads before anything is created or started: a broken score.json
  // must fail here, not after an agent has been paid for.
  const score = loadScore(join(TOY_TASK, "score.json"))
  const runDir = join(RUNS_ROOT, args.condition, String(args.run))
  const codexHome = join(runDir, "codex-home")
  const midaHomePath = join(runDir, "mida-home")

  rmSync(runDir, { recursive: true, force: true })
  // The work folder lives outside the repo while the agents run: agent B's ".."
  // must not reach a-output.jsonl, raw-tail.txt, TASK.md or score.json. realpathSync
  // because macOS reaches the temp folder through a symlink — Mida's project
  // approval and the hooks must see the same path. Copied into the run folder
  // at the end (see finally).
  const workParent = realpathSync(mkdtempSync(join(os.tmpdir(), "mida-bench-")))
  const work = join(workParent, "work")
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
        if (readFileSync(join(work, "src", "bucket.mjs"), "utf8").includes(args.stopAt)) {
          abort.abort(`${args.stopAt} appeared in src/bucket.mjs`)
        }
      } catch { /* file not written yet */ }
    }, 250)
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

    let aOutputText = ""
    try {
      aOutputText = readFileSync(join(runDir, "a-output.jsonl"), "utf8")
    } catch { /* no output file */ }
    let aTurns = 0
    for (const line of aOutputText.split("\n")) {
      if (line === "") continue
      try {
        if ((JSON.parse(line) as { type?: string }).type === "assistant") aTurns += 1
      } catch { /* partial line */ }
    }
    // Agent A's own session id, recorded for every condition — the raw
    // condition needs it to find A's transcript rather than whatever session
    // file happens to be newest on this machine.
    const aSessionId = sessionIdOf(aOutputText)
    if (aTurns === 0) {
      console.error("*** WARNING: Agent A produced no assistant output — treat this run as invalid ***")
    }
    snapshotDiff(work, join(runDir, "a-final.diff"))

    // What did A leave for B? A run where every step is already built is not
    // a continuation test — B could type "Continue." into a finished job.
    const handover = scoreFiles(work, score)
    const stepsAtHandover = handover.steps
    const aLeftWork = stepsAtHandover.some((s) => !s.built)
    if (!aLeftWork) {
      console.error("*** NOTE: agent A had already built every step before it was stopped; this run has nothing to continue ***")
    }

    // mida: the daemon drains queued jobs through the real compile; wait for
    // the queue to empty so B's handoff reflects A's whole session.
    let queueWaitMs = 0
    let queueLeft = 0
    if (args.condition === "mida") {
      const waited = await waitQueueEmpty(midaHomePath, QUEUE_WAIT_CAP_MS)
      queueWaitMs = waited.waitMs
      queueLeft = waited.left
    }

    // raw: the readable tail of A's OWN session, scrubbed, is all B is allowed
    // to see — the same conversation text Mida's summary step reads, not a
    // slice of the session file's encoded bytes. If that file cannot be found
    // there is nothing fair to paste, so the run fails here — before agent B
    // is started — and no run.json is written.
    let rawTailChars = 0
    let rawFullChars: number | null = null
    if (args.condition === "raw") {
      const transcript = aSessionId === null
        ? null
        : transcriptOfSession(join(os.homedir(), ".claude", "projects"), aSessionId)
      if (transcript === null) {
        throw new Error("raw: agent A's own session file was not found, so agent B was not started")
      }
      const paste = rawPasteOf(transcript, RAW_TAIL_CHARS)
      writeFileSync(join(runDir, "raw-tail.txt"), paste.text)
      rawTailChars = paste.text.length
      rawFullChars = paste.fullChars
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
    const { steps, constraints } = scoreFiles(work, score)
    const checks = score.checks.map((argv) => ({
      command: argv.join(" "),
      pass: spawnSync(argv[0]!, argv.slice(1), { cwd: work, env: childEnv(), timeout: 120_000 }).status === 0,
    }))
    const bOutput = readFileSync(join(runDir, "b-output.txt"), "utf8")

    const run = {
      condition: args.condition,
      run: args.run,
      stopAt: args.stopAt,
      aStopReason: a.reason,
      aSeconds: a.seconds,
      aTurns,
      aProducedOutput: aTurns > 0,
      aSessionId,
      apiKeyVarsStripped,
      queueWaitMs,
      queueLeft,
      rawTailChars,
      rawFullChars,
      rawTranscriptFound: args.condition === "raw" ? true : null,
      bSeconds: b.seconds,
      bExitCode: b.exitCode,
      bRan: bRanOf(b.exitCode, b.seconds),
      bTokensUsed: tokensUsedOf(bOutput),
      bSawHarnessFiles: harnessMarkersIn(bOutput, REPO_ROOT),
      workRanIn: "temp-outside-repo",
      stepsBuilt: steps.filter((s) => s.built).length,
      stepsAtHandover,
      aLeftWork,
      steps,
      constraints,
      checks,
    }
    writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
    console.log(JSON.stringify(run))
    return 0
  } finally {
    // Bring the finished work folder back into the run folder, then drop the
    // temp parent. Neither step may throw: a failed copy must not hide the
    // run's own error.
    try {
      if (existsSync(work)) cpSync(work, join(runDir, "work"), { recursive: true })
    } catch { /* the run's own error, if any, still surfaces */ }
    try {
      rmSync(workParent, { recursive: true, force: true })
    } catch { /* temp litter, not a run failure */ }
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

// run only when this file is the entry point — summary.ts imports RUNS_ROOT,
// and without the guard that import would parse summary.ts's own argv here
const invokedAs = process.argv[1] !== undefined ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (invokedAs) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      // the error's own message — `harness: Error` for a missing --condition named nothing (R4-8)
      console.error(`harness: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
