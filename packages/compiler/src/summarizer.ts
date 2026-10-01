// Who writes Mida's summaries (UF-P1). The summariser is a chain of the agent
// tools the user already has: Claude Code's small model first, Codex's small
// model next — or, when the owner saved a key provider, exactly that provider
// and nothing else. An agent CLI runs as an agentCli command: a fresh empty
// folder, MIDA_INNER set, and a usage limit named for what it is.

import { spawnSync } from "node:child_process"
import { accessSync, statSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import type { ModelCommand } from "./compile.js"
import { compileModelChoice, providerHost, providerModelCommand } from "./model-choice.js"

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
 * and rules off, read-only sandbox, prompt on stdin.
 */
export function codexSummaryCommand(env: NodeJS.ProcessEnv): ModelCommand {
  const model = env.MIDA_CODEX_SUMMARY_MODEL !== undefined && env.MIDA_CODEX_SUMMARY_MODEL !== ""
    ? env.MIDA_CODEX_SUMMARY_MODEL
    : CODEX_SUMMARY_MODEL_DEFAULT
  const short = model.replace(/^gpt-\d+-/, "")
  return {
    argv: ["codex", "exec", "--ignore-user-config", "--ignore-rules", "--disable", "hooks", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-m", model, "-"],
    label: `codex-${short}`,
    timeoutMs: 180_000,
    agentCli: true,
  }
}

/**
 * True when some folder on PATH holds a regular, executable file called `name`.
 * It never spawns the binary — install checks must not run what they probe.
 */
export function binaryOnPath(name: string, pathValue: string | undefined): boolean {
  if (pathValue === undefined || pathValue === "") return false
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return true
    } catch {
      // absent, a folder of that name, or not executable by this user
    }
  }
  return false
}

const SAFE_MODE_CACHE_MS = 10 * 60 * 1000
let safeModeCache: { answer: boolean; at: number } | undefined

/**
 * Whether the installed `claude` accepts --safe-mode --tools "". Probed once by
 * `claude --help`, remembered for ten minutes per process — every save asks.
 */
export function claudeSupportsSafeMode(run?: () => { status: number | null; stdout: string }): boolean {
  if (safeModeCache !== undefined && Date.now() - safeModeCache.at < SAFE_MODE_CACHE_MS) {
    return safeModeCache.answer
  }
  const probe =
    run ??
    (() => {
      const env: NodeJS.ProcessEnv = { ...process.env, MIDA_INNER: "1" }
      for (const key of Object.keys(env)) {
        if (key.startsWith("ANTHROPIC_")) delete env[key]
      }
      const r = spawnSync("claude", ["--help"], { encoding: "utf8", timeout: 3000, env })
      return { status: r.status, stdout: r.stdout ?? "" }
    })
  let answer = false
  try {
    const out = probe()
    answer = out.status === 0 && out.stdout.includes("--safe-mode") && out.stdout.includes("--tools")
  } catch {
    answer = false
  }
  safeModeCache = { answer, at: Date.now() }
  return answer
}

/** Tests only: forget the remembered safe-mode answer so a new probe runs. */
export function resetClaudeSafeModeCache(): void {
  safeModeCache = undefined
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
  // rides on the command's env and never into argv, label or display.
  if (saved?.use === "key") {
    const provider = saved.provider
    const extra: Record<string, string> =
      provider === "deepseek"
        ? { DEEPSEEK_API_KEY: saved.apiKey, ...(saved.model !== undefined ? { DEEPSEEK_MODEL: saved.model } : {}) }
        : provider === "kimi"
          ? { KIMI_API_KEY: saved.apiKey, ...(saved.model !== undefined ? { KIMI_MODEL: saved.model } : {}) }
          : {
              MIDA_COMPILE_BASE_URL: saved.baseUrl ?? "",
              MIDA_COMPILE_MODEL_ID: saved.model ?? "",
              ...(saved.apiKey !== "" ? { MIDA_COMPILE_API_KEY: saved.apiKey } : {}),
            }
    const withExtra = { ...env, ...extra }
    const command = providerModelCommand(withExtra, provider)
    command.env = extra
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
    if (entries[entries.length - 1]?.id === "claude" && pin !== "haiku") entries.push(codexEntry())
    return choice("environment", true, entries)
  }

  // 4. Nothing saved, nothing set: the agents are named but the choice is not made.
  return choice("agents", false, agentEntries())
}
