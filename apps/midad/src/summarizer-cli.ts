/**
 * `mida summarizer` (UF-P2): shows who writes the summaries, switches the saved
 * choice, and probes each entry. Every outside thing — the clock, the terminal,
 * PATH lookups, the running service, the model probe — comes in through
 * SummarizerCliDeps so tests can fake all of it.
 *
 * The API key is never printed: writeSummarizer stores it under 0600 and no line
 * below ever mentions it.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs"
import { probeClaudeSafeMode, probeModel, resolveBinary, resolveSummarizer } from "@mida/compiler"
import type { ModelCommand, SummarizerSaved } from "@mida/compiler"
import type { MidaHome } from "./home.js"
import { SUMMARIZER_FILE, currentSummarizer, readSummarizer, writeSummarizer } from "./summarizer.js"
// USAGE and NEEDS_TERMINAL_LINE are declared in cli.ts; the import cycle is safe because
// both are only read inside functions, after every module has finished evaluating.
import { NEEDS_TERMINAL_LINE, USAGE } from "./cli.js"

export type ProbeResult = Awaited<ReturnType<typeof probeModel>>

export interface SummarizerCliDeps {
  home: MidaHome
  env: NodeJS.ProcessEnv
  print: (line: string) => void
  now?: () => number
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  prompt?: (question: string) => Promise<string>
  secretPrompt?: (question: string) => Promise<string>
  onPath?: (bin: string) => boolean
  claudeSafeMode?: () => boolean
  /** The async `claude --help` probe — only `test` runs it, and only when claude is on PATH. */
  probeSafeMode?: (binary: string) => Promise<boolean>
  /** Asks the running service for its /health reply; undefined when it does not answer. */
  health?: () => Promise<unknown>
  probe?: (command: ModelCommand) => Promise<ProbeResult>
}

// The same three-line rule as ageText in handoff.ts — that one is private to the
// handoff note, so the rule is copied rather than shared.
function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return "under a minute"
  if (minutes < 120) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h`
}

const ORDINALS = ["1st", "2nd", "3rd", "4th"]
const ordinal = (index: number): string => ORDINALS[index] ?? `${index + 1}th`

const EMPTY_CHAIN_LINES = [
  "No model can write summaries right now, so Mida is not saving your sessions.",
  "Install Claude Code or Codex, or run: mida summarizer use key",
] as const

/** The failure reasons a drain line can carry that belong to the summariser. */
const SUMMARIZER_FAIL_REASONS = new Set(["model-failed", "no-json", "invalid-checkpoint", "summarizer-limit", "no-summarizer"])
const DAY_MS = 24 * 60 * 60 * 1000
const DRAIN_LOG_MAX = 2 * 1024 * 1024

interface DrainRecord {
  at?: number
  outcome?: string
  reason?: string
  /** Which writer produced the line: the brief's compiledBy, or the real log's model field. */
  compiledBy?: string
  model?: string
}

/** The last 2 MB of logs/drain.jsonl, parsed line by line; a bad line is skipped. */
function readDrainLog(home: MidaHome): DrainRecord[] | undefined {
  try {
    const file = home.path("logs/drain.jsonl")
    const size = statSync(file).size
    const fd = openSync(file, "r")
    let text: string
    try {
      const take = Math.min(size, DRAIN_LOG_MAX)
      const buf = Buffer.alloc(take)
      readSync(fd, buf, 0, take, size - take)
      text = buf.toString("utf8")
    } finally {
      closeSync(fd)
    }
    const records: DrainRecord[] = []
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN
        records.push({
          at,
          outcome: typeof parsed.outcome === "string" ? parsed.outcome : undefined,
          reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
          compiledBy: typeof parsed.compiledBy === "string" ? parsed.compiledBy : undefined,
          model: typeof parsed.model === "string" ? parsed.model : undefined,
        })
      } catch {
        // a line that will not parse is skipped
      }
    }
    return records
  } catch {
    return undefined
  }
}

/** The chain the service reports in its /health reply, when it answers. */
function remoteChain(reply: unknown): string[] | undefined {
  if (typeof reply !== "object" || reply === null) return undefined
  const summarizer = (reply as Record<string, unknown>).summarizer
  if (typeof summarizer !== "object" || summarizer === null) return undefined
  const chain = (summarizer as Record<string, unknown>).chain
  if (!Array.isArray(chain)) return undefined
  return chain.filter((label): label is string => typeof label === "string")
}

/** Everything `mida summarizer` with no arguments prints. Returns the show exit code. */
async function showSummarizer(deps: SummarizerCliDeps): Promise<number> {
  const { home, env, print } = deps
  const now = deps.now?.() ?? Date.now()
  const saved = readSummarizer(home)
  const choice = currentSummarizer(home, env, { onPath: deps.onPath, claudeSafeMode: deps.claudeSafeMode })
  const invalid = saved === "invalid"
  const display = choice.entries[0]?.display ?? "your endpoint"

  if (invalid) {
    print("Summaries are written by: nothing. The saved choice (summarizer.json) cannot be read.")
  } else if (choice.mode === "key") {
    print(`Summaries are written by: ${display}, with your own API key`)
  } else if (choice.mode === "environment") {
    print("Summaries are written by: the models your environment variables set")
  } else if (saved?.use === "agents") {
    print("Summaries are written by: your agents' small models")
  } else {
    print("Summaries are written by: your agents' small models (the default; you have not chosen yet)")
  }

  const drain = readDrainLog(home)
  const lastUse = new Map<string, number>()
  if (drain !== undefined) {
    for (const record of drain) {
      if (record.outcome !== "saved" || record.at === undefined || Number.isNaN(record.at)) continue
      const by = record.compiledBy ?? record.model
      if (by === undefined) continue
      lastUse.set(by, Math.max(lastUse.get(by) ?? 0, record.at))
    }
  }

  const width = Math.max(0, ...choice.entries.map((entry) => entry.display.length))
  choice.entries.forEach((entry, index) => {
    let status: string
    if (!entry.installed) {
      status = "not installed"
    } else {
      const used = lastUse.get(entry.label)
      status = used === undefined ? "ready, not used yet" : `working, used ${ageText(now - used)} ago`
    }
    print(`  ${ordinal(index)}  ${entry.display.padEnd(width)}   ${status}`)
  })

  if (choice.chain.length === 0) {
    for (const line of EMPTY_CHAIN_LINES) print(line)
  }

  if (drain !== undefined) {
    let written = 0
    let failed = 0
    for (const record of drain) {
      if (record.at === undefined || Number.isNaN(record.at) || now - record.at > DAY_MS) continue
      if (record.outcome === "saved") written++
      else if ((record.outcome === "failed" || record.outcome === "bad") && record.reason !== undefined && SUMMARIZER_FAIL_REASONS.has(record.reason)) {
        failed++
      }
    }
    print(`Last 24 hours: ${written} written, ${failed} failed`)
  }

  const running = remoteChain(await deps.health?.())
  const local = choice.chain.map((entry) => entry.label)
  if (running !== undefined && (running.length !== local.length || running.some((label, index) => label !== local[index]))) {
    const theirs = running.join(", ") || "none"
    const ours = local.join(", ") || "none"
    print(`Note: the running Mida service uses ${theirs}. This shell would use ${ours}. The service's answer is the one that counts.`)
  }

  print("")
  print("Change it: mida summarizer use agents | mida summarizer use key")
  print("Check it:  mida summarizer test")
  return invalid || choice.chain.length === 0 ? 1 : 0
}

/** The questions behind `use key` (UF-P2b): pick a provider, then give it what it needs. */
export async function askSummarizerKey(deps: {
  print: (line: string) => void
  prompt: (question: string) => Promise<string>
  secretPrompt: (question: string) => Promise<string>
}): Promise<SummarizerSaved | undefined> {
  const { print, prompt, secretPrompt } = deps
  print("Which provider?")
  print("  1  DeepSeek")
  print("  2  Moonshot (Kimi)")
  print("  3  Another OpenAI-compatible endpoint")

  let badProvider = 0
  let provider: "deepseek" | "kimi" | "custom" | undefined
  while (provider === undefined) {
    const answer = (await prompt("Choose 1, 2 or 3: ")).trim()
    if (answer === "1") provider = "deepseek"
    else if (answer === "2") provider = "kimi"
    else if (answer === "3") provider = "custom"
    else {
      badProvider++
      if (badProvider >= 3) return undefined
    }
  }

  if (provider === "deepseek" || provider === "kimi") {
    let empty = 0
    for (;;) {
      const apiKey = (await secretPrompt("API key (typing is hidden): ")).trim()
      if (apiKey !== "") return { use: "key", provider, apiKey }
      print("No key entered.")
      empty++
      if (empty >= 3) return undefined
    }
  }

  let badUrl = 0
  let baseUrl: string | undefined
  while (baseUrl === undefined) {
    const answer = (await prompt("Endpoint base URL (for OpenAI: https://api.openai.com/v1): ")).trim()
    if (endpointAllowed(answer)) {
      baseUrl = answer
    } else {
      print("That address must start with https:// (http:// only for this machine).")
      badUrl++
      if (badUrl >= 3) return undefined
    }
  }

  let emptyModel = 0
  let model: string | undefined
  while (model === undefined) {
    const answer = (await prompt("Model name: ")).trim()
    if (answer === "") {
      emptyModel++
      if (emptyModel >= 3) return undefined
    } else {
      model = answer
    }
  }

  const apiKey = (await secretPrompt("API key (typing is hidden; leave empty if your endpoint needs none): ")).trim()
  return { use: "key", provider: "custom", apiKey, baseUrl, model }
}

/** `https:` anywhere; `http:` only for this machine. */
function endpointAllowed(answer: string): boolean {
  let url: URL
  try {
    url = new URL(answer)
  } catch {
    return false
  }
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
}

/** The choice block printed by `init` and `install` when nobody has picked a summariser yet (UF-P2b). */
export async function chooseSummarizer(deps: {
  home: MidaHome
  env: NodeJS.ProcessEnv
  print: (line: string) => void
  prompt: (question: string) => Promise<string>
  secretPrompt: (question: string) => Promise<string>
  onPath: (bin: string) => boolean
  /** drops input already buffered on stdin, the way approve does before its "Type yes" */
  drain?: () => unknown | Promise<unknown>
}): Promise<"saved" | "skipped"> {
  const { home, env, print, prompt, secretPrompt, onPath, drain } = deps
  const claude = onPath("claude")
  const codex = onPath("codex")
  const a = claude && codex
    ? "Claude Code's haiku first, Codex's luna if Claude can't."
    : claude
      ? "Claude Code's haiku. Install Codex and its luna becomes the backup."
      : codex
        ? "Codex's luna."
        : "Neither Claude Code nor Codex is installed yet. Mida uses their small models once one is."
  const b = claude && codex ? "Anthropic or OpenAI" : claude ? "Anthropic" : codex ? "OpenAI" : "Anthropic or OpenAI"

  for (const line of [
    "How should Mida write its summaries?",
    "When a session ends, Mida turns the chat into a short",
    "record for your next agent. A model writes that record.",
    "",
    "  1  Your agents' small models (recommended)",
    `     ${a}`,
    `     Who reads the chat: ${b}, under your login.`,
    "     What it uses: your plan. It stops at your plan's limit.",
    "",
    "  2  Your own API key",
    "     Who reads the chat: the provider you choose.",
    "     What it uses: your key. Most providers charge under one cent a summary.",
    "",
  ]) {
    print(line)
  }

  // an Enter pressed while the command was starting is not an answer to this question
  await drain?.()
  let wrong = 0
  for (;;) {
    const answer = (await prompt("Choose 1 or 2 [1]: ")).trim()
    if (answer === "" || answer === "1") {
      const saved: SummarizerSaved = { use: "agents" }
      writeSummarizer(home, saved)
      print("Saved: your agents' small models write the summaries.")
      print("Change it later with: mida summarizer")
      return "saved"
    }
    if (answer === "2") {
      const saved = await askSummarizerKey({ print, prompt, secretPrompt })
      if (saved === undefined) {
        print("Nothing saved. Mida uses your agents' small models until you choose: mida summarizer")
        return "skipped"
      }
      writeSummarizer(home, saved)
      const display =
        resolveSummarizer({ saved, env, onPath, claudeSafeMode: false }).entries[0]?.display ?? "your endpoint"
      print(`Saved: ${display} writes the summaries, with your key.`)
      print("Change it later with: mida summarizer")
      return "saved"
    }
    wrong++
    if (wrong >= 3) {
      print("Nothing saved. Mida uses your agents' small models until you choose: mida summarizer")
      return "skipped"
    }
  }
}

export async function runSummarizer(argv: string[], deps: SummarizerCliDeps): Promise<number> {
  const { home, env, print } = deps
  const onPath = deps.onPath ?? (() => false)
  const prompt = deps.prompt ?? (async () => "")
  const secretPrompt = deps.secretPrompt ?? (async () => "")

  if (argv.length === 1) return showSummarizer(deps)

  if (argv.length === 3 && argv[1] === "use" && argv[2] === "agents") {
    const saved: SummarizerSaved = { use: "agents" }
    writeSummarizer(home, saved)
    print("Saved: your agents' small models write the summaries.")
    // the write landed — the display that follows never changes that answer
    await showSummarizer(deps)
    return 0
  }

  if (argv.length === 3 && argv[1] === "use" && argv[2] === "key") {
    if (!(deps.stdinIsTTY === true && deps.stdoutIsTTY === true)) {
      print(NEEDS_TERMINAL_LINE)
      return 2
    }
    const saved = await askSummarizerKey({ print, prompt, secretPrompt })
    if (saved === undefined) {
      print("Nothing saved.")
      return 1
    }
    writeSummarizer(home, saved)
    const display =
      resolveSummarizer({ saved, env, onPath, claudeSafeMode: deps.claudeSafeMode?.() ?? false }).entries[0]?.display ?? "your endpoint"
    print(`Saved: ${display} writes the summaries, with your key.`)
    print(`Saved in ${home.path(SUMMARIZER_FILE)}, readable only by you.`)
    await showSummarizer(deps)
    return 0
  }

  if (argv.length === 2 && argv[1] === "test") {
    let choice = currentSummarizer(home, env, { onPath: deps.onPath, claudeSafeMode: deps.claudeSafeMode })
    // `test` is about to RUN the entries, so it may afford the one async probe the
    // display paths never start: a runnable claude entry's argv depends on it.
    if (deps.claudeSafeMode === undefined && choice.chain.some((entry) => entry.id === "claude")) {
      const binary = resolveBinary("claude", env.PATH)
      if (binary !== undefined) {
        const safe = await (deps.probeSafeMode ?? probeClaudeSafeMode)(binary)
        choice = currentSummarizer(home, env, { onPath: deps.onPath, claudeSafeMode: () => safe })
      }
    }
    if (choice.entries.length === 0) {
      for (const line of EMPTY_CHAIN_LINES) print(line)
      return 1
    }
    const probe = deps.probe ?? probeModel
    for (const entry of choice.entries) {
      if (!entry.installed) {
        print(`${entry.display} could not write it: its command is not installed.`)
        continue
      }
      const r = await probe(entry.command)
      if (r.ok) {
        print(`Wrote one test summary with ${entry.display} in ${Math.max(1, Math.round(r.ms / 1000))} s.`)
        return 0
      }
      if (r.why === "missing") {
        print(`${entry.display} could not write it: its command is not installed.`)
      } else if (r.why === "limit") {
        print(`${entry.display} could not write it: it hit its usage limit.`)
      } else if (r.why === "timeout") {
        print(`${entry.display} could not write it: it gave no answer in ${Math.max(1, Math.round(r.ms / 1000))} s.`)
      } else {
        print(`${entry.display} could not write it: ${r.detail}.`)
      }
    }
    print("No model could write a test summary. Mida cannot save your sessions until one can.")
    return 1
  }

  print(USAGE)
  return 2
}
