// Who writes Mida's summaries (UF-P1). The summariser is a chain of the agent
// tools the user already has: Claude Code's small model first, Codex's small
// model next — or, when the owner saved a key provider, exactly that provider
// and nothing else. An agent CLI runs as an agentCli command: a fresh empty
// folder, MIDA_INNER set, and a usage limit named for what it is.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { accessSync, statSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import type { ModelCommand } from "./compile.js"
import { COMPILE_PROVIDERS, compileModelChoice, providerHost, providerModelCommand } from "./model-choice.js"

export const CLAUDE_SUMMARY_MODEL_DEFAULT = "haiku"
export const CODEX_SUMMARY_MODEL_DEFAULT = "gpt-6-luna"

/**
 * Claude Code's own CLI as the summariser. Safe mode (--safe-mode --tools "")
 * runs the model with every tool off when the installed claude supports it;
 * without it the command keeps to the project settings + strict MCP shape the
 * default model already used.
 */
export function claudeSummaryCommand(env: NodeJS.ProcessEnv, safeMode: boolean): ModelCommand {
  const model = env.MIDA_CLAUDE_SUMMARY_MODEL !== undefined && env.MIDA_CLAUDE_SUMMARY_MODEL !== ""
    ? env.MIDA_CLAUDE_SUMMARY_MODEL
    : CLAUDE_SUMMARY_MODEL_DEFAULT
  return {
    argv: safeMode
      ? ["claude", "-p", "--model", model, "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]
      : ["claude", "-p", "--model", model, "--setting-sources", "project", "--strict-mcp-config"],
    label: `claude-${model}`,
    timeoutMs: 90_000,
    agentCli: true,
  }
}

/**
 * Codex's own CLI as the summariser: `codex exec` non-interactive, user config
 * and rules off, read-only sandbox — and no shell: a real run answered `ls /`,
 * so `features.shell_tool=false` and `web_search="disabled"` (the double quotes
 * are part of the value) close that off too. Prompt on stdin.
 */
export function codexSummaryCommand(env: NodeJS.ProcessEnv): ModelCommand {
  const model = env.MIDA_CODEX_SUMMARY_MODEL !== undefined && env.MIDA_CODEX_SUMMARY_MODEL !== ""
    ? env.MIDA_CODEX_SUMMARY_MODEL
    : CODEX_SUMMARY_MODEL_DEFAULT
  const short = model.replace(/^gpt-\d+-/, "")
  return {
    argv: ["codex", "exec", "--ignore-user-config", "--ignore-rules", "--disable", "hooks", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", "features.shell_tool=false", "-c", 'web_search="disabled"', "-m", model, "-"],
    label: `codex-${short}`,
    timeoutMs: 180_000,
    agentCli: true,
  }
}

const execFileAsync = promisify(execFile)

/**
 * The absolute path of the first regular, executable file called `name` in an
 * ABSOLUTE folder of `pathValue`; non-absolute PATH entries — the empty entry
 * included — are skipped: a relative folder would resolve against whatever cwd
 * the long-lived service happens to have. It never spawns the binary — install
 * checks must not run what they probe.
 */
export function resolveBinary(name: string, pathValue: string | undefined): string | undefined {
  if (pathValue === undefined || pathValue === "") return undefined
  for (const dir of pathValue.split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // absent, a folder of that name, or not executable by this user
    }
  }
  return undefined
}

/** True when some folder on PATH holds a regular, executable file called `name`. */
export function binaryOnPath(name: string, pathValue: string | undefined): boolean {
  return resolveBinary(name, pathValue) !== undefined
}

const SAFE_MODE_CACHE_MS = 10 * 60 * 1000
const SAFE_MODE_FAIL_CACHE_MS = 60 * 1000
interface SafeModeEntry {
  at: number
  ttl: number
  promise: Promise<boolean>
  answer?: boolean
}
let safeModeCache = new Map<string, SafeModeEntry>()

/** The mtime that keys a binary's remembered answer — 0 when the file cannot be stat'ed. */
const binaryMtime = (binary: string): number => {
  try {
    return statSync(binary).mtimeMs
  } catch {
    return 0
  }
}

/** The real `claude --help`: 3 s, SIGKILL on expiry, no ANTHROPIC_* names, MIDA_INNER set. */
const defaultSafeModeRun = async (binary: string): Promise<{ status: number | null; stdout: string }> => {
  const env: NodeJS.ProcessEnv = { ...process.env, MIDA_INNER: "1" }
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_")) delete env[key]
  }
  try {
    const { stdout } = await execFileAsync(binary, ["--help"], { timeout: 3000, killSignal: "SIGKILL", env, encoding: "utf8" })
    return { status: 0, stdout: stdout ?? "" }
  } catch (error) {
    // a non-zero exit carries its code; a timeout, signal or spawn failure is status null
    const e = error as { code?: unknown; stdout?: unknown }
    return { status: typeof e.code === "number" ? e.code : null, stdout: typeof e.stdout === "string" ? e.stdout : "" }
  }
}

/**
 * Whether this `claude` binary accepts --safe-mode --tools "". Probed by
 * `claude --help`, ASYNC — a slow help must never freeze the service it runs
 * inside. The answer is remembered under the key `<binary>:<mtime>` — a binary
 * that changed on disk is a different binary — for ten minutes when the run
 * exited 0 and only one minute when it failed or timed out (a transient
 * failure must not pin a binary as unsafe for ten minutes), and calls made
 * while one probe is in flight share its promise.
 */
export function probeClaudeSafeMode(
  binary: string,
  run?: (binary: string) => Promise<{ status: number | null; stdout: string }>,
): Promise<boolean> {
  const key = `${binary}:${binaryMtime(binary)}`
  const hit = safeModeCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < hit.ttl) return hit.promise
  const entry: SafeModeEntry = {
    at: Date.now(),
    ttl: SAFE_MODE_CACHE_MS,
    promise: (run ?? defaultSafeModeRun)(binary).then(
      (out) => {
        entry.ttl = out.status === 0 ? SAFE_MODE_CACHE_MS : SAFE_MODE_FAIL_CACHE_MS
        entry.at = Date.now()
        // all three flags the safe-mode command passes — a binary that only knows some of
        // them would still fail when invoked with the full argv
        return (
          out.status === 0 &&
          out.stdout.includes("--safe-mode") &&
          out.stdout.includes("--tools") &&
          out.stdout.includes("--no-session-persistence")
        )
      },
      () => {
        entry.ttl = SAFE_MODE_FAIL_CACHE_MS
        entry.at = Date.now()
        return false
      },
    ),
  }
  entry.promise.then((answer) => {
    entry.answer = answer
  })
  safeModeCache.set(key, entry)
  return entry.promise
}

/**
 * The remembered safe-mode answer for this binary, read synchronously — undefined
 * when there is none or it expired. It never starts a process: the readers that
 * only DISPLAY the choice (/health, `mida summarizer`, init's line) use this.
 */
export function claudeSafeModeKnown(binary: string): boolean | undefined {
  const entry = safeModeCache.get(`${binary}:${binaryMtime(binary)}`)
  if (entry === undefined || Date.now() - entry.at >= entry.ttl) return undefined
  return entry.answer
}

/** Tests only: forget every remembered safe-mode answer so a new probe runs. */
export function resetClaudeSafeModeCache(): void {
  safeModeCache = new Map()
}

/** What the owner saved as their summariser choice (summarizer.json in the Mida home). */
export type SummarizerSaved =
  | { use: "agents" }
  | { use: "key"; provider: "deepseek" | "kimi" | "custom"; apiKey: string; baseUrl?: string; model?: string }

export interface SummarizerEntry {
  id: "claude" | "codex" | "deepseek" | "kimi" | "custom"
  /** Becomes compiledBy. */
  label: string
  /** What the user reads. */
  display: string
  /** Where the session text goes. */
  host: string | undefined
  /** An agent tool: its command is on PATH. A key provider: always true. */
  installed: boolean
  command: ModelCommand
}

export interface SummarizerChoice {
  mode: "agents" | "key" | "environment"
  /** False only when nothing is saved and no environment variable decides. */
  chosen: boolean
  /** Everything the mode names, in order, installed or not. */
  entries: SummarizerEntry[]
  /** The entries that can run, in order: entries.filter((e) => e.installed). */
  chain: SummarizerEntry[]
}

const PROVIDER_NAME = { deepseek: "DeepSeek", kimi: "Moonshot", custom: "your endpoint" } as const

const claudeModel = (env: NodeJS.ProcessEnv): string =>
  env.MIDA_CLAUDE_SUMMARY_MODEL !== undefined && env.MIDA_CLAUDE_SUMMARY_MODEL !== ""
    ? env.MIDA_CLAUDE_SUMMARY_MODEL
    : CLAUDE_SUMMARY_MODEL_DEFAULT

const codexModel = (env: NodeJS.ProcessEnv): string =>
  env.MIDA_CODEX_SUMMARY_MODEL !== undefined && env.MIDA_CODEX_SUMMARY_MODEL !== ""
    ? env.MIDA_CODEX_SUMMARY_MODEL
    : CODEX_SUMMARY_MODEL_DEFAULT

const codexShort = (env: NodeJS.ProcessEnv): string => codexModel(env).replace(/^gpt-\d+-/, "")

/**
 * The summariser chain for one save, in this order:
 *  1. a saved key provider — exactly it, no fallback;
 *  2. a saved "agents" choice — Claude's small model, then Codex's;
 *  3. the environment (MIDA_COMPILE_MODEL or a provider key) — compileModelChoice's order,
 *     its haiku tail replaced by the Claude agent command, Codex appended behind it;
 *  4. nothing saved or set — the two agent entries again, but chosen: false.
 */
export function resolveSummarizer(input: {
  saved: SummarizerSaved | undefined
  env: NodeJS.ProcessEnv
  onPath: (bin: string) => boolean
  claudeSafeMode: boolean
}): SummarizerChoice {
  const { saved, env, onPath, claudeSafeMode } = input

  const claudeEntry = (): SummarizerEntry => ({
    id: "claude",
    command: claudeSummaryCommand(env, claudeSafeMode),
    label: `claude-${claudeModel(env)}`,
    display: `Claude Code (${claudeModel(env)})`,
    host: "api.anthropic.com",
    installed: onPath("claude"),
  })
  const codexEntry = (): SummarizerEntry => ({
    id: "codex",
    command: codexSummaryCommand(env),
    label: `codex-${codexShort(env)}`,
    display: `Codex (${codexShort(env)})`,
    host: "api.openai.com",
    installed: onPath("codex"),
  })
  const agentEntries = (): SummarizerEntry[] => [claudeEntry(), codexEntry()]
  const choice = (mode: SummarizerChoice["mode"], chosen: boolean, entries: SummarizerEntry[]): SummarizerChoice => ({
    mode,
    chosen,
    entries,
    chain: entries.filter((e) => e.installed),
  })

  // 1. A saved key provider is the whole chain — one entry, no fallback, the key
  // rides on the command's env and never into argv, label or display. Every value
  // the model script can read is PINNED here: a stray DEEPSEEK_BASE_URL or
  // MIDA_COMPILE_API_KEY in the daemon's environment must never redirect a saved
  // choice (or lend it a key the owner did not save).
  if (saved?.use === "key") {
    const provider = saved.provider
    const extra: Record<string, string> =
      provider === "deepseek"
        ? {
            DEEPSEEK_API_KEY: saved.apiKey,
            DEEPSEEK_BASE_URL: COMPILE_PROVIDERS.deepseek.baseDefault,
            DEEPSEEK_MODEL: saved.model ?? COMPILE_PROVIDERS.deepseek.modelDefault,
          }
        : provider === "kimi"
          ? {
              KIMI_API_KEY: saved.apiKey,
              KIMI_BASE_URL: COMPILE_PROVIDERS.kimi.baseDefault,
              KIMI_MODEL: saved.model ?? COMPILE_PROVIDERS.kimi.modelDefault,
            }
          : {
              MIDA_COMPILE_BASE_URL: saved.baseUrl ?? "",
              MIDA_COMPILE_MODEL_ID: saved.model ?? "",
              // the saved key ALWAYS — the empty string included, so an inherited
              // MIDA_COMPILE_API_KEY can never ride to the owner's own endpoint
              MIDA_COMPILE_API_KEY: saved.apiKey,
            }
    // the timeout is pinned too: a stray DEEPSEEK_TIMEOUT_MS=1 in the daemon's
    // environment must not make every summary of a saved choice time out
    extra[COMPILE_PROVIDERS[provider].timeoutVar] = "120000"
    const withExtra = { ...env, ...extra }
    const command = providerModelCommand(withExtra, provider)
    command.env = extra
    command.timeoutMs = 120_000
    const entry: SummarizerEntry = {
      id: provider,
      command,
      label: command.label,
      display: `${PROVIDER_NAME[provider]} (${command.label})`,
      host: providerHost(withExtra, provider),
      installed: true,
    }
    return choice("key", true, [entry])
  }

  // 2. The saved "agents" choice: both agent CLIs, installed or not.
  if (saved?.use === "agents") return choice("agents", true, agentEntries())

  // 3. The environment decides: compileModelChoice's order, haiku becomes the
  // Claude agent entry, and a Codex entry follows a Claude tail — unless haiku
  // was pinned, in which case Claude alone is what the pin asked for.
  const pin = env.MIDA_COMPILE_MODEL
  const envDecides =
    pin === "deepseek" || pin === "kimi" || pin === "haiku" || pin === "custom" ||
    (env.DEEPSEEK_API_KEY !== undefined && env.DEEPSEEK_API_KEY !== "") ||
    (env.KIMI_API_KEY !== undefined && env.KIMI_API_KEY !== "")
  if (envDecides) {
    const resolved = compileModelChoice(env)
    const commands = [resolved.model, ...resolved.fallbacks]
    const entries = commands.map((command, i): SummarizerEntry => {
      const provider = resolved.chain[i]!.provider
      if (provider === "haiku") return claudeEntry()
      return {
        id: provider,
        command,
        label: command.label,
        display: `${PROVIDER_NAME[provider]} (${command.label})`,
        host: resolved.chain[i]!.host,
        installed: true,
      }
    })
    if (entries[entries.length - 1]?.id === "claude" && pin !== "haiku" && pin !== "custom") entries.push(codexEntry())
    return choice("environment", true, entries)
  }

  // 4. Nothing saved, nothing set: the agents are named but the choice is not made.
  return choice("agents", false, agentEntries())
}
