// The saved summariser choice — `summarizer.json` inside the Mida home — and the
// one place the daemon and the drainer ask "who writes this summary". The file
// is read on EVERY save, never cached: a `mida summariser …` write between two
// saves must change the next compile without a restart.

import { lstatSync } from "node:fs"
import { binaryOnPath, claudeSafeModeKnown, probeClaudeSafeMode, resolveBinary, resolveSummarizer } from "@mida/compiler"
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
  // "Absent" means lstat finds NOTHING at the path. Anything that exists but is not
  // exactly one of the two shapes — a dangling symlink, a folder, an unreadable or
  // unparseable file — is "invalid": the service fails closed rather than fall back
  // to a vendor the owner never chose.
  try {
    lstatSync(home.path(SUMMARIZER_FILE))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "invalid"
  }
  let value: unknown
  try {
    value = home.readJson<unknown>(SUMMARIZER_FILE)
    if (value === undefined) return "invalid" // lstat saw it; it could not be read as a file
  } catch {
    return "invalid"
  }
  if (!isRecord(value)) return "invalid"
  // exactly these shapes — any other key in the object makes it invalid
  const keys = Object.keys(value)
  const exact = (...allowed: string[]) => keys.length === allowed.length && allowed.every((k) => keys.includes(k))
  if (value.use === "agents") return exact("use") ? { use: "agents" } : "invalid"
  if (value.use === "key") {
    const provider = value.provider
    if (provider === "deepseek" || provider === "kimi") {
      if (!exact("use", "provider", "apiKey", ...(value.model !== undefined ? ["model"] : []))) return "invalid"
      if (!isString(value.apiKey) || value.apiKey === "") return "invalid"
      if (value.model !== undefined && (!isString(value.model) || value.model === "")) return "invalid"
      return { use: "key", provider, apiKey: value.apiKey, baseUrl: undefined, model: value.model as string | undefined }
    }
    if (provider === "custom") {
      if (!exact("use", "provider", "apiKey", "baseUrl", "model")) return "invalid"
      if (!isString(value.apiKey) || !isString(value.baseUrl) || value.baseUrl === "" || !isString(value.model) || value.model === "") return "invalid"
      return { use: "key", provider, apiKey: value.apiKey, baseUrl: value.baseUrl, model: value.model }
    }
  }
  return "invalid"
}

/** Writes the choice through writeSecretJson — a key inside it is readable by its owner only. */
export function writeSummarizer(home: MidaHome, value: SummarizerSaved): void {
  home.writeSecretJson(SUMMARIZER_FILE, value)
}

/**
 * The summariser choice for THIS save. Synchronous and NEVER starts a process:
 * `claudeSafeMode` defaults to the remembered probe answer (`claudeSafeModeKnown`)
 * — absent or expired means false. Callers that are about to RUN the chain probe
 * first themselves; the display callers (/health, `mida summarizer`, init) never do.
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
    const binary = resolveBinary("claude", env.PATH)
    claudeSafeMode =
      deps?.claudeSafeMode?.() ?? (binary !== undefined ? (claudeSafeModeKnown(binary) ?? false) : false)
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
  deps?: {
    onPath?: (bin: string) => boolean
    claudeSafeMode?: () => boolean
    probeSafeMode?: (binary: string) => Promise<boolean>
  },
): (input: CompileInput) => Promise<CompileResult> {
  return async (input) => {
    // This caller is about to RUN the chain, so it may afford the one async probe:
    // when `claude` really resolves on PATH and the saved choice is not a key, the
    // answer is fetched (or shared) BEFORE the choice is compiled — the entry's
    // argv depends on it. A saved key or a missing binary never spawns a probe.
    let claudeSafeMode = deps?.claudeSafeMode?.()
    if (claudeSafeMode === undefined) {
      const saved = readSummarizer(home)
      if (saved !== "invalid" && saved?.use !== "key") {
        const binary = resolveBinary("claude", env.PATH)
        if (binary !== undefined) {
          claudeSafeMode = await (deps?.probeSafeMode ?? probeClaudeSafeMode)(binary)
        }
      }
    }
    const choice = currentSummarizer(home, env, {
      onPath: deps?.onPath,
      claudeSafeMode: claudeSafeMode === undefined ? undefined : () => claudeSafeMode,
    })
    const [first, ...rest] = choice.chain
    if (first === undefined) {
      return { ok: false, reason: "no-summarizer", detail: "no summary model is available", attempts: 0, retried: 0 }
    }
    return compile({ ...input, model: first.command, fallbackModels: rest.map((entry) => entry.command) })
  }
}
