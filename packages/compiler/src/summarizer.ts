// Who writes Mida's summaries (UF-P1). The summariser is a chain of the agent
// tools the user already has: Claude Code's small model first, Codex's small
// model next — or, when the owner saved a key provider, exactly that provider
// and nothing else. An agent CLI runs as an agentCli command: a fresh empty
// folder, MIDA_INNER set, and a usage limit named for what it is.

import { spawnSync } from "node:child_process"
import { accessSync, statSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import type { ModelCommand } from "./compile.js"

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
