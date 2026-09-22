// Which model compiles a checkpoint (M3-D5). One OpenAI-compatible command
// (openai-compatible-model.mjs) serves three providers picked by argv; a fourth
// provider — claude-haiku through the `claude` CLI — is always the chain's end.
//
// Unpinned order, by which keys are present: deepseek → kimi → haiku.
// MIDA_COMPILE_MODEL pins deepseek | kimi | haiku | custom; anything else
// follows the unpinned rule. On a failed call (429, 5xx, timeout, no-JSON) the
// compile walks to the next provider in the chain — each provider is tried at
// most once and `compiledBy` names whoever actually wrote the checkpoint.
//
// `custom` is the bring-your-own-endpoint provider: a user who pointed Mida at
// a local or private model chose privacy, so a pinned custom has NO fallback
// unless MIDA_COMPILE_FALLBACK=1 explicitly opts back into the vendor order.
// Nothing may silently send that transcript to a vendor.
//
// The provider table mirrors the one inside openai-compatible-model.mjs — the
// .mjs cannot import this module, so the two must be kept in step by hand.

import { fileURLToPath } from "node:url"
import { DEFAULT_MODEL } from "./compile.js"
import type { ModelCommand } from "./compile.js"

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash"
export const KIMI_DEFAULT_MODEL = "kimi-k2.7-code-highspeed"
const MODEL_SCRIPT = fileURLToPath(new URL("./openai-compatible-model.mjs", import.meta.url))

export type CompileProvider = "deepseek" | "kimi" | "custom" | "haiku"

/** The env vars each provider reads — the .mjs carries the same table. */
export const COMPILE_PROVIDERS = {
  deepseek: {
    keyVar: "DEEPSEEK_API_KEY",
    baseVar: "DEEPSEEK_BASE_URL",
    baseDefault: "https://api.deepseek.com",
    modelVar: "DEEPSEEK_MODEL",
    modelDefault: DEEPSEEK_DEFAULT_MODEL,
    timeoutVar: "DEEPSEEK_TIMEOUT_MS",
  },
  kimi: {
    keyVar: "KIMI_API_KEY",
    baseVar: "KIMI_BASE_URL",
    baseDefault: "https://api.moonshot.ai",
    modelVar: "KIMI_MODEL",
    modelDefault: KIMI_DEFAULT_MODEL,
    timeoutVar: "KIMI_TIMEOUT_MS",
  },
  custom: {
    keyVar: "MIDA_COMPILE_API_KEY", // optional — a local server may need none
    baseVar: "MIDA_COMPILE_BASE_URL", // required
    modelVar: "MIDA_COMPILE_MODEL_ID", // required
    timeoutVar: "MIDA_COMPILE_TIMEOUT_MS",
  },
} as const

type NamedProvider = keyof typeof COMPILE_PROVIDERS

const hasKey = (env: NodeJS.ProcessEnv, provider: "deepseek" | "kimi"): boolean =>
  env[COMPILE_PROVIDERS[provider].keyVar] !== undefined && env[COMPILE_PROVIDERS[provider].keyVar] !== ""

/** The host a provider's request goes to — undefined when the base URL is missing or unparseable. */
export function providerHost(env: NodeJS.ProcessEnv, provider: NamedProvider): string | undefined {
  const table = COMPILE_PROVIDERS[provider]
  const base = env[table.baseVar] ?? ("baseDefault" in table ? table.baseDefault : undefined)
  if (base === undefined) return undefined
  try {
    return new URL(base).host
  } catch {
    return undefined
  }
}

/**
 * The spawned command for one OpenAI-compatible provider. The API key is never
 * part of argv — `ps` must never show it; runModel passes the environment down
 * instead. The script's stderr is a controlled channel ("deepseek http 429"),
 * so stderrDetail opts it into the failure detail while every other model's
 * stderr stays ignored.
 */
export function providerModelCommand(env: NodeJS.ProcessEnv, provider: NamedProvider): ModelCommand {
  const table = COMPILE_PROVIDERS[provider]
  const timeout = Number(env[table.timeoutVar])
  return {
    argv: [process.execPath, MODEL_SCRIPT, provider],
    label: env[table.modelVar] ?? ("modelDefault" in table ? table.modelDefault : "custom"),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    stderrDetail: true,
  }
}

/** Kept for callers that built the kimi command by name — now just the generic command with provider "kimi". */
export function kimiModelCommand(env: NodeJS.ProcessEnv): ModelCommand {
  return providerModelCommand(env, "kimi")
}

/**
 * Resolves the compile chain: `model` runs first, `fallbacks` follow in order —
 * each provider is tried at most once, inside the same attempt. `chain` is the
 * same list in descriptor form ({ provider, label, host }) for doctor to render
 * where the session's text actually goes.
 */
export function compileModelChoice(env: NodeJS.ProcessEnv): {
  model: ModelCommand
  fallbacks: ModelCommand[]
  chain: { provider: CompileProvider; label: string; host: string | undefined }[]
} {
  const entry = (provider: CompileProvider, command: ModelCommand): { provider: CompileProvider; label: string; host: string | undefined } => ({
    provider,
    label: command.label,
    host: provider === "haiku" ? "api.anthropic.com" : providerHost(env, provider),
  })

  // The vendor order — providers whose key is present, haiku always last. Used as
  // the unpinned chain and as the opt-in fallbacks behind a pinned custom.
  const vendorCommands = (): ModelCommand[] => {
    const order: ModelCommand[] = []
    if (hasKey(env, "deepseek")) order.push(providerModelCommand(env, "deepseek"))
    if (hasKey(env, "kimi")) order.push(providerModelCommand(env, "kimi"))
    order.push(DEFAULT_MODEL)
    return order
  }

  let commands: ModelCommand[]
  const pick = env.MIDA_COMPILE_MODEL
  if (pick === "custom") {
    const custom = providerModelCommand(env, "custom")
    // privacy by default: a pinned custom never falls back unless the owner opts in —
    // MIDA_COMPILE_FALLBACK=1 sends a failed custom call on to the vendor order
    commands = env.MIDA_COMPILE_FALLBACK === "1" ? [custom, ...vendorCommands()] : [custom]
  } else if (pick === "deepseek" || pick === "kimi") {
    // the pin leads, key or no key (a missing key fails fast and the chain does the
    // work); its fallbacks are only what follows it in the order — a provider EARLIER
    // in the order is never a fallback for a later pin
    const pinAt = CANONICAL_ORDER.indexOf(pick)
    commands = [providerModelCommand(env, pick), ...vendorCommands().filter((c) => CANONICAL_ORDER.indexOf(argvProvider(c)) > pinAt)]
  } else if (pick === "haiku") {
    commands = [DEFAULT_MODEL]
  } else {
    commands = vendorCommands()
  }
  const [model, ...fallbacks] = commands as [ModelCommand, ...ModelCommand[]]
  return { model, fallbacks, chain: commands.map((command) => entry(argvProvider(command), command)) }
}

/** Canonical vendor order — custom is never in it; it is reachable only by pinning. */
const CANONICAL_ORDER: readonly CompileProvider[] = ["deepseek", "kimi", "haiku"]

/** The provider a command was built for — argv's last element for the generic script, "haiku" for the CLI. */
function argvProvider(command: ModelCommand): CompileProvider {
  const arg = command.argv[command.argv.length - 1]
  return arg === "deepseek" || arg === "kimi" || arg === "custom" ? arg : "haiku"
}
