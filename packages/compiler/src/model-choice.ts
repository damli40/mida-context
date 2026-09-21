// Which model command compiles a checkpoint (R5-8). Kimi answers in about half
// of Haiku's wall-clock time on the same transcript, so it is the default
// whenever KIMI_API_KEY is present — with claude-haiku kept as the fallback for
// the rate-limited and down cases. MIDA_COMPILE_MODEL=kimi|haiku pins the
// choice; anything else follows the default rule.

import { fileURLToPath } from "node:url"
import { DEFAULT_MODEL } from "./compile.js"
import type { ModelCommand } from "./compile.js"

export const KIMI_DEFAULT_MODEL = "kimi-k2.7-code-highspeed"
const KIMI_SCRIPT = fileURLToPath(new URL("./kimi-model.mjs", import.meta.url))

/**
 * The spawned command for kimi-model.mjs. The API key is never part of argv —
 * `ps` must never show it; runModel passes the environment down instead. The
 * script's stderr is a controlled channel ("kimi http 429"), so stderrDetail
 * opts it into the failure detail while every other model's stderr stays
 * ignored.
 */
export function kimiModelCommand(env: NodeJS.ProcessEnv): ModelCommand {
  return {
    argv: [process.execPath, KIMI_SCRIPT],
    label: env.KIMI_MODEL ?? KIMI_DEFAULT_MODEL,
    timeoutMs: 120_000,
    stderrDetail: true,
  }
}

/**
 * Resolves { model, fallback } for one compile. `fallback` is set only on the
 * kimi path: a failed Kimi call (its account allows ~3 requests a minute, so
 * 429 is expected under two agents) retries the same attempt through Haiku —
 * compiledBy then names whichever model actually wrote the checkpoint.
 */
export function compileModelChoice(env: NodeJS.ProcessEnv): { model: ModelCommand; fallback?: ModelCommand } {
  const pick = env.MIDA_COMPILE_MODEL
  if (pick === "haiku") return { model: DEFAULT_MODEL }
  const kimi = pick === "kimi" || (env.KIMI_API_KEY !== undefined && env.KIMI_API_KEY !== "")
  return kimi ? { model: kimiModelCommand(env), fallback: DEFAULT_MODEL } : { model: DEFAULT_MODEL }
}
