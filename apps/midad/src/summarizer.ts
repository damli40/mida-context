// The saved summariser choice — `summarizer.json` inside the Mida home — and the
// one place the daemon and the drainer ask "who writes this summary". The file
// is read on EVERY save, never cached: a `mida summariser …` write between two
// saves must change the next compile without a restart.

import { binaryOnPath, claudeSupportsSafeMode, resolveSummarizer } from "@mida/compiler"
import type { CompileInput, CompileResult, SummarizerChoice, SummarizerSaved } from "@mida/compiler"
import type { compileCheckpoint } from "@mida/compiler"
import type { MidaHome } from "./home.js"

export const SUMMARIZER_FILE = "summarizer.json"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isString = (value: unknown): value is string => typeof value === "string"

/**
 * undefined when the file is absent; the saved value when it is exactly one of the two shapes;
 * "invalid" for anything else, including a file that will not parse. Never throws — a file that
 * cannot be read must never silently fall back to another vendor.
 */
export function readSummarizer(home: MidaHome): SummarizerSaved | "invalid" | undefined {
  let value: unknown
  try {
    if (!home.has(SUMMARIZER_FILE)) return undefined
    value = home.readJson<unknown>(SUMMARIZER_FILE)
  } catch {
    return "invalid"
  }
  if (!isRecord(value)) return "invalid"
  if (value.use === "agents") return { use: "agents" }
  if (value.use === "key") {
    const provider = value.provider
    if (provider !== "deepseek" && provider !== "kimi" && provider !== "custom") return "invalid"
    if (!isString(value.apiKey)) return "invalid"
    if (provider !== "custom" && value.apiKey === "") return "invalid"
    if (provider === "custom" && (!isString(value.baseUrl) || value.baseUrl === "" || !isString(value.model) || value.model === "")) return "invalid"
    if (value.baseUrl !== undefined && !isString(value.baseUrl)) return "invalid"
    if (value.model !== undefined && !isString(value.model)) return "invalid"
    return {
      use: "key",
      provider,
      apiKey: value.apiKey,
      baseUrl: value.baseUrl as string | undefined,
      model: value.model as string | undefined,
    }
  }
  return "invalid"
}

/** Writes the choice through writeSecretJson — a key inside it is readable by its owner only. */
export function writeSummarizer(home: MidaHome, value: SummarizerSaved): void {
  home.writeSecretJson(SUMMARIZER_FILE, value)
}

/**
 * The summariser choice for THIS save. `onPath` defaults to a real PATH lookup and
 * `claudeSafeMode` defaults to the cached `--help` probe — called only when `claude` is
 * actually on PATH, so a Codex-only install never spawns a probe for a binary it lacks.
 */
export function currentSummarizer(
  home: MidaHome,
  env: NodeJS.ProcessEnv,
  deps?: { onPath?: (bin: string) => boolean; claudeSafeMode?: () => boolean },
): SummarizerChoice & { invalid: boolean } {
  const saved = readSummarizer(home)
  if (saved === "invalid") {
    return { mode: "key", chosen: true, entries: [], chain: [], invalid: true }
  }
  const onPath = deps?.onPath ?? ((bin: string) => binaryOnPath(bin, env.PATH))
  let claudeSafeMode = false
  if (saved?.use !== "key" && onPath("claude")) {
    claudeSafeMode = deps?.claudeSafeMode?.() ?? claudeSupportsSafeMode()
  }
  return { ...resolveSummarizer({ saved, env, onPath, claudeSafeMode }), invalid: false }
}

/** What /health and the owner read: no commands, no argv, no keys — names and reachability only. */
export function summarizerSummary(choice: SummarizerChoice & { invalid?: boolean }): {
  mode: SummarizerChoice["mode"]
  chosen: boolean
  invalid: boolean
  entries: { id: string; label: string; display: string; host: string | undefined; installed: boolean }[]
  chain: string[]
} {
  return {
    mode: choice.mode,
    chosen: choice.chosen,
    invalid: choice.invalid === true,
    entries: choice.entries.map((e) => ({ id: e.id, label: e.label, display: e.display, host: e.host, installed: e.installed })),
    chain: choice.chain.map((e) => e.label),
  }
}

/**
 * The compile callback both entry points install. The saved choice is re-read on every call,
 * so a choice written between two saves takes effect without a restart. An empty chain — nothing
 * saved, no environment provider, no agent CLI on PATH — fails honestly as "no-summarizer" with
 * zero attempts and no model run rather than compiling with a model that was never chosen.
 */
export function compileWithSummarizer(
  home: MidaHome,
  env: NodeJS.ProcessEnv,
  compile: typeof compileCheckpoint,
  deps?: { onPath?: (bin: string) => boolean; claudeSafeMode?: () => boolean },
): (input: CompileInput) => Promise<CompileResult> {
  return async (input) => {
    const choice = currentSummarizer(home, env, deps)
    const [first, ...rest] = choice.chain
    if (first === undefined) {
      return { ok: false, reason: "no-summarizer", detail: "no summary model is available", attempts: 0, retried: 0 }
    }
    return compile({ ...input, model: first.command, fallbackModels: rest.map((entry) => entry.command) })
  }
}
