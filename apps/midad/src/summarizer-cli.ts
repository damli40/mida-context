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
import { callDaemon } from "./control.js"
import { resetSummarizerWaits } from "./drain.js"
import { SUMMARIZER_FILE, currentSummarizer, readSummarizer, writeSummarizer } from "./summarizer.js"
// USAGE and NEEDS_TERMINAL_LINE are declared in cli.ts; the import cycle is safe because
// both are only read inside functions, after every module has finished evaluating.
import { NEEDS_TERMINAL_LINE, USAGE } from "./cli.js"

export type ProbeResult = Awaited<ReturnType<typeof probeModel>>

/**
 * The hidden key prompt's keystrokes as a pure function (UF-P2R): `state` holds the raw bytes
 * kept so far plus `typing | done | abandoned`; each raw stdin chunk steps it forward. The
 * answer is `Buffer.from(state.bytes).toString("utf8")` once status is "done"; "abandoned"
 * means Ctrl-C, or Ctrl-D with nothing typed — the caller must treat it as "no answer".
 */
export interface SecretInputState {
  status: "typing" | "done" | "abandoned"
  /** the bytes kept so far — never a decoded string, so a half-typed UTF-8 char stays intact */
  bytes: number[]
  /**
   * Escape-sequence state carried between chunks: 1 = saw Esc; 2 = inside a CSI
   * sequence, skipping until its final byte; 3 = inside an OSC sequence, skipping
   * until BEL or Esc \; 4 = inside an Esc O sequence, skipping one byte;
   * 5 = inside an OSC sequence and just saw Esc.
   */
  escape: 0 | 1 | 2 | 3 | 4 | 5
  /**
   * Set when the Enter that ended the input was followed, in the same chunk, by
   * bytes other than more line breaks — the prompt caught the middle of a paste,
   * so the answer is only the part before the break.
   */
  trailing: boolean
}

export function secretInputStart(): SecretInputState {
  return { status: "typing", bytes: [], escape: 0, trailing: false }
}

export function secretInputStep(state: SecretInputState, chunk: Buffer): SecretInputState {
  if (state.status !== "typing") return state
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]!
    if (state.escape === 2) {
      // a CSI sequence (arrow keys, bracketed-paste markers) ends at the first byte in 0x40-0x7e
      if (byte >= 0x40 && byte <= 0x7e) state.escape = 0
      continue
    }
    if (state.escape === 3) {
      // an OSC sequence ends at BEL, or at the \ of an Esc \ pair
      if (byte === 0x07) state.escape = 0
      else if (byte === 0x1b) state.escape = 5
      continue
    }
    if (state.escape === 5) {
      // Esc inside an OSC: \ closes it, another Esc keeps waiting, anything else is payload
      state.escape = byte === 0x5c ? 0 : byte === 0x1b ? 5 : 3
      continue
    }
    if (state.escape === 4) {
      // Esc O <one byte> — a function key; all three bytes are dropped
      state.escape = 0
      continue
    }
    if (state.escape === 1) {
      if (byte === 0x5b) {
        state.escape = 2
        continue
      }
      if (byte === 0x4f) {
        state.escape = 4
        continue
      }
      if (byte === 0x5d) {
        state.escape = 3
        continue
      }
      // a lone Esc ignores only itself — the next byte is handled like any other,
      // so Esc then Enter still ends the input and Esc then a letter keeps the letter
      state.escape = 0
    }
    if (byte === 0x1b) {
      state.escape = 1
      continue
    }
    if (byte === 0x03) {
      state.status = "abandoned"
      return state
    }
    if (byte === 0x0d || byte === 0x0a) {
      // a break with nothing typed and more bytes in this chunk is the leading
      // line break of a paste, not an empty answer
      if (state.bytes.length === 0 && i < chunk.length - 1) continue
      state.status = "done"
      // bytes other than more line breaks after the Enter mean the paste kept
      // going — the answer caught the middle of it and is only part of a key
      for (let j = i + 1; j < chunk.length; j++) {
        const rest = chunk[j]!
        if (rest !== 0x0d && rest !== 0x0a) {
          state.trailing = true
          break
        }
      }
      return state
    }
    if (byte === 0x04) {
      // Ctrl-D ends an empty line the way a terminal ends input; with text typed it means nothing
      if (state.bytes.length === 0) {
        state.status = "abandoned"
        return state
      }
      continue
    }
    if (byte === 0x15) {
      state.bytes = []
      continue
    }
    if (byte === 0x7f || byte === 0x08) {
      // backspace removes the last whole character: any UTF-8 tail bytes, then its lead byte
      while (state.bytes.length > 0 && (state.bytes[state.bytes.length - 1]! & 0xc0) === 0x80) state.bytes.pop()
      state.bytes.pop()
      continue
    }
    if (byte < 0x20) continue
    state.bytes.push(byte)
  }
  return state
}

/**
 * What the hidden key prompt hands back (UF-QB): the raw answer plus `trailing` —
 * set when the Enter that ended the prompt was followed by more input in the same
 * burst, meaning the answer is only the first line of a paste and must be refused.
 * A bare string is the old shape: the whole answer, never trailing.
 */
export interface SecretKeyAnswer {
  key: string
  trailing?: boolean
}
export type SecretPromptResult = string | SecretKeyAnswer | undefined

/** A real key is only printable ASCII — anything else is a paste slip, not a key. */
const PLAIN_KEY = /^[\x21-\x7e]+$/

/**
 * The key the prompt returned, cleaned: trimmed, then one pair of surrounding
 * quotes removed — people paste `"sk-…"` straight from a doc. `trailing` means
 * input followed the Enter that ended the prompt, so the key is partial.
 */
function keyFromAnswer(raw: SecretPromptResult): { key: string; trailing: boolean } | undefined {
  if (raw === undefined) return undefined
  const answer = typeof raw === "string" ? { key: raw, trailing: false } : { key: raw.key, trailing: raw.trailing === true }
  let key = answer.key.trim()
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1)
  }
  return { key, trailing: answer.trailing }
}

/** Whether the cleaned key must be refused: partial paste, or not only printable ASCII. */
function keyRefused(cleaned: { key: string; trailing: boolean }): boolean {
  return cleaned.trailing || (cleaned.key !== "" && !PLAIN_KEY.test(cleaned.key))
}

export interface SummarizerCliDeps {
  home: MidaHome
  env: NodeJS.ProcessEnv
  print: (line: string) => void
  now?: () => number
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  /** undefined means the prompt was abandoned (Ctrl-C, Ctrl-D, stdin ending) — save nothing */
  prompt?: (question: string) => Promise<string | undefined>
  secretPrompt?: (question: string) => Promise<SecretPromptResult>
  onPath?: (bin: string) => boolean
  claudeSafeMode?: () => boolean
  /** The async `claude --help` probe — only `test` runs it, and only when claude is on PATH. */
  probeSafeMode?: (binary: string) => Promise<boolean>
  /** Asks the running service for its /health reply; undefined when it does not answer. */
  health?: () => Promise<unknown>
  /** Asks the running service to run a drain pass now — the /kick call cli.ts makes after `mida batching`; best-effort. */
  kick?: () => unknown | Promise<unknown>
  probe?: (command: ModelCommand) => Promise<ProbeResult>
}

/**
 * After `use agents`/`use key` writes the new choice (UF-P3): sessions that were waiting on the
 * summary model get their waits cleared, the owner is told, and the running service is asked for
 * a pass the way `mida batching` does it — a silent /kick, best-effort, never an error here.
 */
async function afterChoiceWritten(deps: SummarizerCliDeps): Promise<void> {
  const cleared = resetSummarizerWaits(deps.home)
  if (cleared > 0) deps.print("Saves that were waiting for a summary model will be tried again now.")
  const kick = deps.kick ?? (() => callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 }))
  await Promise.resolve(kick()).catch(() => {})
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
      if (record.outcome === "saved" && typeof record.model === "string") written++
      else if ((record.outcome === "failed" || record.outcome === "bad") && record.reason !== undefined && SUMMARIZER_FAIL_REASONS.has(record.reason)) {
        failed++
      }
    }
    print(`Last 24 hours: ${written} written, ${failed} failed tries`)
  }

  const healthReply = await deps.health?.()
  // a reply with no summarizer field is a service started by an older version — it never
  // read this home's choice, so name that instead of comparing chains
  const serviceIsOlder =
    typeof healthReply === "object" &&
    healthReply !== null &&
    (healthReply as Record<string, unknown>).ok === true &&
    !("summarizer" in healthReply)
  if (serviceIsOlder) {
    print("Note: the running Mida service is an older version and does not read this choice. Run mida doctor to restart it.")
  }
  const running = remoteChain(healthReply)
  const local = choice.chain.map((entry) => entry.label)
  if (!serviceIsOlder && running !== undefined && (running.length !== local.length || running.some((label, index) => label !== local[index]))) {
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
  prompt: (question: string) => Promise<string | undefined>
  secretPrompt: (question: string) => Promise<SecretPromptResult>
}): Promise<SummarizerSaved | undefined> {
  const { print, prompt, secretPrompt } = deps
  print("Which provider?")
  print("  1  DeepSeek")
  print("  2  Moonshot (Kimi)")
  print("  3  Another OpenAI-compatible endpoint")

  let badProvider = 0
  let provider: "deepseek" | "kimi" | "custom" | undefined
  while (provider === undefined) {
    const raw = await prompt("Choose 1, 2 or 3: ")
    if (raw === undefined) return undefined
    const answer = raw.trim()
    if (answer === "1") provider = "deepseek"
    else if (answer === "2") provider = "kimi"
    else if (answer === "3") provider = "custom"
    else {
      badProvider++
      if (badProvider >= 3) return undefined
    }
  }

  if (provider === "deepseek" || provider === "kimi") {
    let bad = 0
    for (;;) {
      const raw = await secretPrompt("API key (typing is hidden): ")
      const cleaned = keyFromAnswer(raw)
      if (cleaned === undefined) return undefined
      if (cleaned.key !== "" && !keyRefused(cleaned)) return { use: "key", provider, apiKey: cleaned.key }
      print(cleaned.key === "" && !cleaned.trailing ? "No key entered." : "That key has spaces or hidden characters in it. Paste it again.")
      bad++
      if (bad >= 3) return undefined
    }
  }

  let badUrl = 0
  let baseUrl: string | undefined
  while (baseUrl === undefined) {
    const raw = await prompt("Endpoint base URL (for OpenAI: https://api.openai.com/v1): ")
    if (raw === undefined) return undefined
    const checked = endpointChecked(raw.trim())
    if (checked.kind === "ok") {
      baseUrl = checked.url
    } else {
      print(checked.kind === "extras" ? 'Use the base address only: no username, no "?" and no "#".' : "That address must start with https:// (http:// only for this machine).")
      badUrl++
      if (badUrl >= 3) return undefined
    }
  }

  let emptyModel = 0
  let model: string | undefined
  while (model === undefined) {
    const raw = await prompt("Model name: ")
    if (raw === undefined) return undefined
    const answer = raw.trim()
    if (answer === "") {
      emptyModel++
      if (emptyModel >= 3) return undefined
    } else {
      model = answer
    }
  }

  let badKey = 0
  for (;;) {
    const raw = await secretPrompt("API key (typing is hidden; leave empty if your endpoint needs none): ")
    const cleaned = keyFromAnswer(raw)
    if (cleaned === undefined) return undefined
    if (!keyRefused(cleaned)) return { use: "key", provider: "custom", apiKey: cleaned.key, baseUrl, model }
    print("That key has spaces or hidden characters in it. Paste it again.")
    badKey++
    if (badKey >= 3) return undefined
  }
}

/**
 * The custom endpoint's base address. `https:` anywhere; `http:` only for this
 * machine. A username or password, a query, or a fragment is refused — the
 * address is the base the provider table appends its path to, so extras would
 * silently point elsewhere (or carry a credential). A trailing
 * `/chat/completions` and trailing slashes are stripped before the address is
 * saved — people paste the URL their endpoint's docs print.
 */
function endpointChecked(answer: string): { kind: "ok"; url: string } | { kind: "scheme" } | { kind: "extras" } {
  // the typed text itself is checked: the URL parser drops a bare trailing ? or # and
  // percent-encodes a space in the path, so url.search/url.hash alone would miss them
  if (/\s/.test(answer) || answer.includes("?") || answer.includes("#")) return { kind: "extras" }
  let url: URL
  try {
    url = new URL(answer)
  } catch {
    return { kind: "scheme" }
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return { kind: "extras" }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { kind: "scheme" }
  // origin + pathname, not the raw text: the scheme and host come back lower-cased
  let cleaned = url.origin + url.pathname
  while (cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1)
  if (cleaned.endsWith("/chat/completions")) {
    cleaned = cleaned.slice(0, cleaned.length - "/chat/completions".length)
    while (cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1)
  }
  return { kind: "ok", url: cleaned }
}

/** The choice block printed by `init` and `install` when nobody has picked a summariser yet (UF-P2b). */
export async function chooseSummarizer(deps: {
  home: MidaHome
  env: NodeJS.ProcessEnv
  print: (line: string) => void
  prompt: (question: string) => Promise<string | undefined>
  secretPrompt: (question: string) => Promise<SecretPromptResult>
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
    const raw = await prompt("Choose 1 or 2 [1]: ")
    if (raw === undefined) {
      print("Nothing saved. Mida uses your agents' small models until you choose: mida summarizer")
      return "skipped"
    }
    const answer = raw.trim()
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
    await afterChoiceWritten(deps)
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
    await afterChoiceWritten(deps)
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
      print(`Asking ${entry.display} for a test summary. This can take up to ${Math.max(1, Math.round((entry.command.timeoutMs ?? 90_000) / 1000))} s.`)
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
