// Turn a transcript into a validated checkpoint through a swappable model
// command. Ported from spike/hooks/capture-worker.mjs with three changes:
// the model runs through async spawn (the drainer must stay responsive), a
// failed call is retried with backoff, and the checkpoint is returned to the
// caller instead of stored — the drainer owns storage.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path, { join } from "node:path"
import { CONTENT_FIELDS, LIMITS, cutText, limitNote, repointEvidence, splitLimitNote, validateCheckpoint, type Checkpoint, type LimitList } from "@mida/checkpoint"
import { extractJsonObject } from "./extract-json.js"
import { buildExtractPrompt } from "./prompt.js"
import { scrubSecrets, scrubValue } from "./scrub.js"
import { stripLeadingScaffolds } from "./transcript-claude.js"
import type { Conversation } from "./transcript-claude.js"
import { readTranscriptFor } from "./transcript-codex.js"

export interface ModelCommand {
  argv: readonly string[]
  label: string // becomes compiledBy
  timeoutMs?: number
  /**
   * Opt-in: this command's stderr is a controlled channel (kimi-model.mjs prints only
   * "kimi http <status>"-style lines), so its first line may join the failure detail.
   * Without the flag stderr stays ignored — an arbitrary model's stderr is never loggable.
   */
  stderrDetail?: boolean
  /**
   * Extra environment for the child process, applied AFTER the ANTHROPIC_* names are
   * stripped — and an ANTHROPIC_* name inside this map is ignored too, so a command
   * can never smuggle a redirected endpoint or key back in.
   */
  env?: Readonly<Record<string, string>>
  /**
   * This command is an AI agent's own command-line tool (claude -p, codex exec). It
   * runs in a fresh empty folder — never the user's project — keeps its stderr piped
   * only to spot a usage limit (never into the failure detail), and a non-zero exit
   * whose output names a usage limit is reported with `limit: true`.
   */
  agentCli?: boolean
}

/**
 * The text shape of an agent CLI's "you are out of plan" answer — a usage/session/
 * weekly/N-hour limit near a reaching verb, in either order, or one of the API
 * providers' own phrases. "rate" is deliberately absent: a passing API rate-limit
 * error is worth the retry this guard would skip. Disk quota is not a plan limit.
 */
export const USAGE_LIMIT_PATTERN =
  /\b(?:usage|session|weekly|\d+-hour)[ -]limits?\b[^\n]{0,60}\b(?:reached|exceeded|hit)\b|\b(?:hit|reached|exceeded)\b[^\n]{0,60}\b(?:usage|session|weekly|\d+-hour)[ -]limits?\b|\bhit your limit\b|\binsufficient_quota\b|(?<!disk )\bquota exceeded\b|credit balance is too low/i

/**
 * Did the tool's OWN output name a usage limit? Codex prints the prompt back on
 * stderr before its answer, so a user request that merely mentions "rate limiter"
 * or "quota" must not make an unrelated failure look like a plan limit. Neither
 * tool echoes the prompt on stdout, so every non-empty line of the kept head of
 * stdout is examined. On stderr the echo is cut instead: when a trimmed line of
 * the kept tail equals the prompt's last non-empty line, everything up to and
 * including the last such line is the echo and only what follows is examined;
 * otherwise every line is. (The old per-line "occurs in the prompt" rule dropped
 * the real limit line when the session itself had ended on that limit — the
 * transcript carried the sentence, so the prompt did too. UF-QD.)
 */
export function limitHit(prompt: string, stdout: string, stderrTail: string): boolean {
  for (const raw of stdout.slice(0, 4096).split("\n")) {
    const line = raw.trim()
    if (line !== "" && USAGE_LIMIT_PATTERN.test(line)) return true
  }
  let lines = stderrTail.split("\n")
  const promptLines = prompt.split("\n")
  let last: string | undefined
  for (let i = promptLines.length - 1; i >= 0 && last === undefined; i--) {
    const trimmed = promptLines[i]!.trim()
    if (trimmed !== "") last = trimmed
  }
  if (last !== undefined) {
    let cut = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === last) cut = i
    }
    if (cut >= 0) lines = lines.slice(cut + 1)
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line !== "" && USAGE_LIMIT_PATTERN.test(line)) return true
  }
  return false
}

export const DEFAULT_MODEL: ModelCommand = {
  argv: ["claude", "-p", "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config"],
  label: "claude-haiku",
  timeoutMs: 90_000,
}

export interface CompileInput {
  transcriptPath: string
  agent: string
  /** The hook payload's session id — the devin reader picks its rows out of the sessions database by it. */
  sessionId?: string
  eventId: string
  cwd: string
  homeDir: string
  model?: ModelCommand
  /**
   * The ordered fallback chain (M3-D5): providers tried inside the same attempt when the
   * current command itself fails (non-zero exit — a provider's "http 429"/5xx lands here —
   * spawn error, timeout) OR answers output that holds no usable JSON — a provider that
   * cannot produce the checkpoint shape is a fallback trigger too. Each entry runs at most
   * once per compile; `compiledBy` names whichever model actually wrote the checkpoint.
   */
  fallbackModels?: readonly ModelCommand[]
  /** The session's last saved checkpoint — the model updates it rather than restating from nothing. */
  previous?: Checkpoint
  attempts?: number
  backoffMs?: readonly number[]
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** Test seam: how the agent-CLI working folder is made — so a test can make it fail. */
  makeTempDir?: () => string
}

export type CompileResult =
  | {
      ok: true
      checkpoint: Checkpoint
      compiledBy: string
      droppedKeys: string[]
      trimmed: string[]
      attempts: number
      format: Conversation["format"]
      messagesKept: number
      messagesTotal: number
      charsSent: number
      modelMs: number
      /** Present when the fallback ran: which model failed, which took over, and the failure that triggered it. */
      fellBack?: { from: string; to: string; reason: string }
      /**
       * Whether the primary provider was re-asked once after a bad SHAPE (invalid/no-json) —
       * 0 or 1, never more: a transport failure and any fallback provider walk at once.
       */
      retried: number
      /**
       * Prompt-cache counters the provider reported for the call that wrote the checkpoint —
       * only ever present for a model whose stderr is a controlled channel (stderrDetail) and
       * only when the provider reported both numbers. Absent means unknown, not zero.
       */
      cacheHitTokens?: number
      cacheMissTokens?: number
      /**
       * Total prompt/completion tokens the provider reported for the call that wrote the
       * checkpoint — the same usage object the cache counters come from, under the same rule:
       * controlled stderr only, both numbers or neither. Absent means unknown, not zero.
       */
      inputTokens?: number
      outputTokens?: number
    }
  | {
      ok: false
      reason: "model-failed" | "no-json" | "invalid" | "summarizer-limit" | "no-summarizer"
      detail: string
      attempts: number
      /** 1 when the primary was re-asked once after a bad shape before the chain walked; else 0. */
      retried: number
      /** Leading field paths from the validator when reason is "invalid" — names only, safe for logs. */
      fields?: string[]
      /**
       * The first SAMPLE_CHARS of the LAST provider's raw answer, secret-scrubbed — present when
       * the terminal failure had an answer to show (no-json/invalid), so a failed drain log can
       * show what an unusable answer looked like without quoting the whole output.
       */
      sample?: string
      /** Present when the fallback ran (and lost too): which model failed and the reason that triggered it. */
      fellBack?: { from: string; to: string; reason: string }
    }

const MAX_STDOUT = 8 * 1024 * 1024
/** How much of a failed provider's answer a failure result may quote — scrubbed first, then cut. */
const SAMPLE_CHARS = 200
const DEFAULT_TIMEOUT_MS = 90_000
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type ModelRun =
  | {
      ok: true
      stdout: string
      ms: number
      cacheHitTokens?: number
      cacheMissTokens?: number
      inputTokens?: number
      outputTokens?: number
    }
  | { ok: false; detail: string; ms: number; limit?: boolean }

// One bad field must not cost the whole save. Strings over the schema limit
// are cut to it ending in "…"; arrays over the item limit keep 50 entries —
// the LAST 50 (the newest) for every list except the plan. The model carries
// the earlier checkpoint forward and adds what is new at the end, so keeping
// the front meant the 51st decision could never be saved, and the next agent
// kept following a decision the user had since changed (CAP-29). The plan
// keeps its FIRST 50: its front is what comes next. Evidence names its target
// by position ("decisions[3]"), so after a front cut it is re-pointed, and
// removed when its entry went. Each cut is named in `trimmed` ("progress[3]",
// "decisions", "decisions[3].rationale" — positions as the model wrote them).
const KEEPS_FRONT: ReadonlySet<string> = new Set(["remainingPlan"])
function trimFields(picked: Record<string, unknown>, trimmed: string[], previousIssue: string | null | undefined): void {
  const cutStr = (v: unknown, path: string): unknown => {
    if (typeof v !== "string" || v.length <= LIMITS.maxString) return v
    trimmed.push(path)
    return cutText(v, LIMITS.maxString)
  }
  // unresolvedIssue is handled at the end, once the per-list cut counts are known — its
  // note work needs them, and the general string cap runs on the issue text only, never on a note
  for (const field of ["objective", "nextAction"]) {
    picked[field] = cutStr(picked[field], field)
  }
  // how many entries left the front of each list — what evidence has to follow
  const cutFromFront = new Map<string, number>()
  const cap = (field: string, arr: unknown[]): void => {
    if (arr.length <= LIMITS.maxArray) return
    trimmed.push(field)
    if (KEEPS_FRONT.has(field)) {
      picked[field] = arr.slice(0, LIMITS.maxArray)
      return
    }
    cutFromFront.set(field, arr.length - LIMITS.maxArray)
    picked[field] = arr.slice(-LIMITS.maxArray)
  }
  for (const field of ["progress", "constraints", "artifacts", "remainingPlan"]) {
    const arr = picked[field]
    if (!Array.isArray(arr)) continue
    for (let i = 0; i < arr.length; i++) arr[i] = cutStr(arr[i], `${field}[${i}]`)
    cap(field, arr)
  }
  for (const field of ["decisions", "rejected", "evidence"]) {
    let arr = picked[field]
    if (!Array.isArray(arr)) continue
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue
      for (const k of Object.keys(item)) {
        ;(item as Record<string, unknown>)[k] = cutStr(
          (item as Record<string, unknown>)[k],
          `${field}[${i}].${k}`,
        )
      }
    }
    if (field === "evidence") {
      // evidence comes last in this loop, so every other list's cut is known by now
      for (const [list, dropped] of cutFromFront) arr = repointEvidence(arr as unknown[], list, dropped)
      picked[field] = arr
    }
    cap(field, arr as unknown[])
  }
  // UF-L: a front cut on a rule list drops the user's OLDEST entries, and the save must say
  // WHICH lists lost some — a count went stale the moment a later save put an entry back (and a
  // count inside note text could be forged upward). The note names lists, never numbers, and is
  // CUMULATIVE over the session: the lists the previous checkpoint's note named union with
  // whatever this compile cut, so a save that changes nothing still carries the loss forward.
  // Only constraints, decisions and rejected earn one — progress, artifacts, evidence and
  // plan cuts stay silent.
  const lists = new Set<LimitList>(splitLimitNote(typeof previousIssue === "string" ? previousIssue : null).lists)
  for (const field of ["constraints", "decisions", "rejected"] as const) {
    if (cutFromFront.has(field)) lists.add(field)
  }
  const rawIssue = picked.unresolvedIssue
  if (rawIssue === null || rawIssue === undefined || typeof rawIssue === "string") {
    // Every note-shaped segment leaves the model's text BEFORE the length cut — but only an
    // EXACT note leaves it (UF-QA): an unclosed note — one a length cut cut off mid-note, say —
    // is left in the text as it is, because anything that is not a real Mida note is the model's
    // own text. The lists a note the MODEL wrote claims are stripped with it and never trusted
    // (UF-L): the note is rebuilt only from this compile's own cuts and the previous note.
    const issue = cutStr(
      typeof rawIssue === "string" ? splitLimitNote(rawIssue).text : "",
      "unresolvedIssue",
    ) as string
    const note = limitNote(lists)
    if (note === null) {
      picked.unresolvedIssue = issue === "" ? null : issue
    } else {
      // the note stays whole — when it would push the field past the string cap, the
      // model's own text is what shortens, ending in "…"
      const head = cutText(issue, LIMITS.maxString - " | ".length - note.length)
      picked.unresolvedIssue = head === "" ? note : `${head} | ${note}`
    }
  }
  // a non-string unresolvedIssue is left for the validator to flag
}

// One model call: the prompt goes on stdin, stdout is captured up to
// MAX_STDOUT, and the child is killed at the timeout. Never throws — every
// failure mode (spawn error, timeout, non-zero exit) becomes ok:false.
// Failure details carry exit codes and signals only, never model output.
//
// The child runs detached (its own process group) so the timeout can kill
// every process the model spawned — not just the direct child. The attempt
// settles on 'exit' or the timeout, never on 'close' alone: a grandchild
// that inherited the stdout pipe keeps it open after the model dies, and
// 'close' would then never come.
function runModel(model: ModelCommand, prompt: string, makeTempDir?: () => string): Promise<ModelRun> {
  const t0 = Date.now()
  const timeoutMs = model.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    // An agent's own CLI runs in a fresh empty folder: its hooks and project
    // files must not fire inside a user's repo. The folder goes away on every
    // settle path — success, failure, timeout, spawn error.
    let workDir = os.tmpdir()
    if (model.agentCli === true) {
      try {
        workDir = makeTempDir?.() ?? mkdtempSync(join(os.tmpdir(), "mida-sum-"))
      } catch (err) {
        // the error CODE only ("temp folder: EACCES") — the message can carry
        // a path, and a path in a log line leaks the local layout
        const code = (err as NodeJS.ErrnoException).code ?? "unknown"
        resolve({ ok: false, detail: `temp folder: ${code}`, ms: Date.now() - t0 })
        return
      }
    }
    const cleanup = (): void => {
      if (model.agentCli !== true) return
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // a folder that will not go away is no reason to fail the compile
      }
    }
    const done = (
      r:
        | {
            ok: true
            stdout: string
            cacheHitTokens?: number
            cacheMissTokens?: number
            inputTokens?: number
            outputTokens?: number
          }
        | { ok: false; detail: string; limit?: boolean },
    ) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ...r, ms: Date.now() - t0 })
    }

    // A shell-exported Anthropic variable would silently override the model's
    // normal login (spike bug G2: an exported key produced an empty,
    // successful-looking run) — and ANTHROPIC_BASE_URL or ANTHROPIC_CUSTOM_HEADERS
    // would redirect the transcript text to another server outright. The default
    // command authenticates through the CLI's stored login and needs none of
    // them, so every ANTHROPIC_* name is stripped — values are never logged.
    // MIDA_INNER marks the subprocess so the capture hook ignores it: the real
    // model command is itself an agent run and would otherwise be captured as a
    // session of its own, forever.
    const env: NodeJS.ProcessEnv = { ...process.env, MIDA_INNER: "1" }
    for (const key of Object.keys(env)) {
      if (key.startsWith("ANTHROPIC_")) delete env[key]
    }
    // The command's own additions come last — and an ANTHROPIC_* name inside
    // them is dropped with the rest, by the same rule as the inherited ones.
    if (model.env !== undefined) {
      for (const [key, value] of Object.entries(model.env)) {
        if (!key.startsWith("ANTHROPIC_")) env[key] = value
      }
    }

    let child
    try {
      child = spawn(model.argv[0] ?? "", [...model.argv.slice(1)], {
        cwd: workDir,
        env,
        // stderr is piped for commands whose stderr is a controlled channel (stderrDetail)
        // and for agent CLIs, whose output is checked for a usage limit. An arbitrary
        // model's stderr is ignored, never captured into a log line — and an agent
        // CLI's never reaches the detail either.
        stdio: ["pipe", "pipe", model.stderrDetail === true || model.agentCli === true ? "pipe" : "ignore"],
        detached: true,
      })
    } catch (err) {
      done({ ok: false, detail: `spawn: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let closeGrace: NodeJS.Timeout | undefined

    // A controlled stderr's first non-empty line may annotate a failure ("kimi http 429"):
    // printable characters only, one line, 160 characters — the channel is trusted to be
    // safe, the shape is still bounded.
    const stderrNote = (): string => {
      const line = stderr.split("\n").find((entry) => entry.trim() !== "")
      if (line === undefined) return ""
      return ` — ${line.replace(/[^\x20-\x7e]/g, "?").slice(0, 160)}`
    }

    // The controlled channel's second contract (M3-H): a successful provider may report its
    // prompt-cache counters as "cache hit=<n> miss=<m>" and its total token usage as
    // "tokens in=<p> out=<c>". Only a stderrDetail command's stderr is even piped, and only
    // a line in exactly one of those shapes counts — anything else is ignored.
    const reportedUsage = (): {
      cacheHitTokens?: number
      cacheMissTokens?: number
      inputTokens?: number
      outputTokens?: number
    } => {
      const usage: { cacheHitTokens?: number; cacheMissTokens?: number; inputTokens?: number; outputTokens?: number } = {}
      if (model.stderrDetail !== true) return usage
      for (const line of stderr.split("\n")) {
        const trimmed = line.trim()
        const cache = /^cache hit=(\d+) miss=(\d+)$/.exec(trimmed)
        if (cache !== null) {
          usage.cacheHitTokens = Number(cache[1])
          usage.cacheMissTokens = Number(cache[2])
          continue
        }
        const tokens = /^tokens in=(\d+) out=(\d+)$/.exec(trimmed)
        if (tokens !== null) {
          usage.inputTokens = Number(tokens[1])
          usage.outputTokens = Number(tokens[2])
        }
      }
      return usage
    }

    const settle = () => {
      clearTimeout(timer)
      if (timedOut || exited === null) return
      if (exited.code !== 0) {
        if (model.agentCli === true) {
          // The limit check reads the tool's OWN lines — the head of stdout plus
          // the kept tail of stderr, minus anything that is just the echoed prompt
          // — but the detail carries only the marker, never a word of the output.
          const limit = limitHit(prompt, stdout, stderr)
          done({
            ok: false,
            detail: `exit ${exited.code} signal ${exited.signal}${limit ? " (usage limit)" : ""}`,
            ...(limit ? { limit: true } : {}),
          })
          return
        }
        done({ ok: false, detail: `exit ${exited.code} signal ${exited.signal}${stderrNote()}` })
      } else done({ ok: true, stdout, ...reportedUsage() })
    }

    const timer = setTimeout(() => {
      timedOut = true
      // Negative pid = the child's whole process group (detached made it the
      // leader); grandchildren die with the model instead of outliving it.
      try {
        process.kill(-(child.pid as number), "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
      // Held-open pipes (a surviving writer would stall 'close') must not
      // stall the attempt: drop our end and settle now.
      child.stdout!.destroy()
      child.stderr?.destroy()
      child.stdin!.destroy()
      done({ ok: false, detail: `timeout after ${timeoutMs} ms` })
    }, timeoutMs)

    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (c: string) => {
      if (stdout.length < MAX_STDOUT) stdout += c.slice(0, MAX_STDOUT - stdout.length)
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (c: string) => {
      if (model.agentCli === true) {
        // a rolling TAIL: an agent CLI prints the prompt back on stderr first —
        // the head is mostly that echo, and a real limit line comes LAST
        stderr = (stderr + c).slice(-4096)
      } else if (stderr.length < 4096) stderr += c.slice(0, 4096 - stderr.length)
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      done({ ok: false, detail: `spawn: ${err.message}` })
    })
    child.on("exit", (code, signal) => {
      exited = { code, signal }
      // 'close' normally follows at once with the last stdout bytes. If a
      // surviving grandchild still holds the pipe it never comes — give it
      // a short grace, then take what we have.
      closeGrace = setTimeout(() => {
        child.stdout!.destroy()
        child.stderr?.destroy()
        settle()
      }, 1_000)
      closeGrace.unref()
    })
    child.on("close", () => {
      if (closeGrace !== undefined) clearTimeout(closeGrace)
      settle()
    })
    child.stdin!.on("error", () => {}) // the child may exit before reading the prompt
    child.stdin!.end(prompt)
  })
}

export async function compileCheckpoint(input: CompileInput): Promise<CompileResult> {
  const model = input.model ?? DEFAULT_MODEL
  const attempts = input.attempts ?? 3
  const backoff = input.backoffMs ?? [2000, 8000]
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep

  // A saved earlier request rides into the read so the READER can render it as
  // the first block when the file's own pick is a continuation — the prompt
  // calls the first block "the user's original request", so the request it
  // names must actually sit there (M1). The kept value is itself re-checked
  // with the reader's scaffolding test first: a .last.json saved before the
  // test existed can hold caveat or command-echo text, and keeping it would
  // lock the bad pick into every later save (L3).
  const earlier = input.previous?.originalRequest
  const kept = typeof earlier === "string" && stripLeadingScaffolds(earlier) !== "" ? earlier : null
  // The reader matches the agent that wrote the transcript. The drain refuses agents with
  // no reader before this is ever called; a direct caller naming one is refused here too —
  // never quietly parsed through another agent's format. The code is the drain's own
  // permanent "unknown-transcript-format" reason, so a thrown refusal maps to it.
  const convo = readTranscriptFor(input.agent, input.transcriptPath, { preferRequest: kept, sessionId: input.sessionId })
  if (convo === null) {
    const error = new Error(`no transcript reader for agent "${input.agent}"`) as Error & { code: string }
    error.code = "unknown-transcript-format"
    throw error
  }
  // The request this compile pins, decided once so the prompt wording, the
  // rendered first block and the saved field can never disagree. A transcript
  // that opened on scaffolding (post-compact, a /clear, a resumed tool_result)
  // yields a CONTINUATION line, not the session's ask — a kept earlier request
  // beats it. With no earlier request the continuation pick is still the best
  // verbatim record — it lands rather than null.
  const fresh = convo.openedWithScaffolding ? null : convo.firstUserMessage
  const pinnedRequest = fresh ?? kept ?? convo.firstUserMessage

  // "No original request was captured" is the honest wording only when NOTHING
  // is pinned — a /clear or /model opener followed by a real prompt still pins
  // that prompt, and a valid earlier request pins too (L7). Saying it anyway
  // was the lie that taught the model to answer in prose and fail no-json.
  const prompt = buildExtractPrompt(convo.text, input.previous, pinnedRequest !== null)

  // Stored paths must not leak the local folder layout: a path under the
  // project cwd becomes relative; a path still absolute under the user's
  // home becomes "~/…". homeDir "/" is left alone (home.length > 1).
  const rel = (p: string): string => {
    if (input.cwd && p.startsWith(input.cwd + "/")) return p.slice(input.cwd.length + 1)
    if (path.isAbsolute(p) && input.homeDir.length > 1 && (p === input.homeDir || p.startsWith(input.homeDir + "/")))
      return "~" + p.slice(input.homeDir.length)
    return p
  }

  let modelMs = 0
  // Every provider hop this compile took, in order — { the provider that failed, who took
  // over, the failure that triggered the hop }. fellBack reported to the caller is derived
  // from these, so the drain log always names the real writer, not just "a fallback ran".
  const hops: { from: string; to: string; reason: string }[] = []
  const fellBack = (): { from: string; to: string; reason: string } | undefined =>
    hops.length === 0
      ? undefined
      : { from: hops[0]!.from, to: hops[hops.length - 1]!.to, reason: hops.map((h) => h.reason).join("; ") }
  let lastFail: { reason: "model-failed" | "no-json" | "invalid"; detail: string; sample?: string } = {
    reason: "model-failed",
    detail: "no attempt ran",
  }
  // The unspent fallback providers, kept as positions in the full chain so each
  // command's MOST RECENT failure can be remembered by index: a compile is a
  // "summarizer-limit" when every command has run at least once and each one's
  // last failure was a limit — on ANY attempt, not only the first. A later
  // attempt re-runs the primary (index 0), never the chain.
  const chain = [model, ...(input.fallbackModels ?? [])]
  const queue = chain.map((_, i) => i).slice(1)
  const lastRunWasLimit = new Map<number, boolean>()
  // The primary's one same-provider shape retry (M3-H) — a compile-level flag, so the
  // worst case any compile can add is exactly one call, across every attempt combined.
  let retried = 0

  // Turn one candidate object into a checkpoint: pick the model-writable fields, set the
  // code-owned ones, relativize paths, trim, validate. A bad shape is a per-provider
  // failure now (the chain can still walk, and the primary gets one retry), so this runs
  // per model run — once per attempt no longer suffices.
  const shapeOf = (
    obj: Record<string, unknown>,
  ):
    | { ok: true; checkpoint: Checkpoint; droppedKeys: string[]; trimmed: string[] }
    | { ok: false; detail: string; fields: string[] } => {
    // Only the model-writable fields are taken; every other key NAME is
    // reported in droppedKeys (never its value) so validation stays
    // strict on what remains. originalRequest is absent from
    // CONTENT_FIELDS on purpose — a model that returns it gets it
    // dropped and named like any unknown key (spike bug H1).
    // The model's own output is scrubbed too: it was told never to copy
    // secrets, but what it returns is untrusted text and a leaked key in
    // a progress line would be stored verbatim otherwise.
    const picked: Record<string, unknown> = {}
    const droppedKeys: string[] = []
    for (const k of Object.keys(obj)) {
      if ((CONTENT_FIELDS as readonly string[]).includes(k)) picked[k] = scrubValue(obj[k])
      else droppedKeys.push(k)
    }

    // Fields the model may not write are set by code: the id, the agent
    // name, the source tag, the timestamp — and the user's own words,
    // copied verbatim from the transcript, never summarised by a model.
    picked.eventId = input.eventId
    picked.agent = input.agent
    picked.source = "hook-compiler"
    picked.createdAt = now().toISOString()
    // The request decided before the prompt was built — fresh pick, kept
    // earlier request, or the transcript's continuation line, in that order.
    picked.originalRequest = pinnedRequest

    if (Array.isArray(picked.artifacts)) {
      picked.artifacts = picked.artifacts.map((a) => (typeof a === "string" ? rel(a) : a))
    }
    if (Array.isArray(picked.evidence)) {
      picked.evidence = picked.evidence.map((e) => {
        if (e === null || typeof e !== "object") return e
        const ref = (e as { ref?: unknown }).ref
        return typeof ref === "string" && ref.startsWith("file:")
          ? { ...(e as Record<string, unknown>), ref: "file:" + rel(ref.slice(5)) }
          : e
      })
    }

    const trimmed: string[] = []
    trimFields(picked, trimmed, input.previous?.unresolvedIssue)

    const v = validateCheckpoint(picked)
    if (!v.ok) {
      // the drainer may log field NAMES ("decisions[3].rationale") — never
      // the validator's messages, which can echo the value that failed
      const fields = [...new Set(v.errors.map((e) => e.split(":")[0]!))]
      return { ok: false, detail: v.errors.join("; "), fields }
    }
    return { ok: true, checkpoint: v.value, droppedKeys, trimmed }
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let current = model
    let label = model.label
    // This attempt's failure trail ("<label>: <detail>") — the detail of a chain that
    // failed end-to-end names every provider it tried, in order.
    const trail: string[] = []
    // Walk the provider chain inside this attempt: a command failure (exit, spawn error,
    // timeout — a provider's "http 429"/5xx lands as the first), output holding no usable
    // JSON, or a JSON shape that fails validation all move to the next unspent provider —
    // except that a bad SHAPE from the primary earns one same-provider retry first: the
    // repeated prompt is a provider-cache hit, so the second opinion is nearly free.
    let parsed: { checkpoint: Checkpoint; droppedKeys: string[]; trimmed: string[] } | undefined
    // the usage counters of the run that produced `parsed` — the WRITER's numbers,
    // never an earlier provider's that failed on the way
    let usage: { cacheHitTokens?: number; cacheMissTokens?: number; inputTokens?: number; outputTokens?: number } = {}
    // the field names of the LAST invalid failure — kept for the terminal report only
    let invalidFields: string[] | undefined
    for (;;) {
      const run = await runModel(current, prompt, input.makeTempDir)
      lastRunWasLimit.set(chain.indexOf(current), run.ok === true ? false : run.limit === true)
      modelMs += run.ms
      let fail: { reason: "model-failed" | "no-json" | "invalid"; detail: string; sample?: string }
      if (run.ok) {
        // the answer arrived but was unusable — quote a bounded, scrubbed prefix of it on the
        // failure so a no-json/invalid drain log shows what the provider actually said. Scrub
        // the whole answer BEFORE the cut (F1's rule): a secret straddling char 200 must never
        // leave a fragment in the log.
        const sample = scrubSecrets(run.stdout).slice(0, SAMPLE_CHARS)
        const obj = extractJsonObject(run.stdout)
        // An object holding none of the ten content fields (a "reasoning" object like
        // {"thinking": "…"}) counts as no output at all — and since a provider that
        // produces unusable output is a fallback trigger, no-JSON walks the chain too.
        const hasContent =
          obj !== undefined &&
          Object.keys(obj as Record<string, unknown>).some((k) =>
            (CONTENT_FIELDS as readonly string[]).includes(k),
          )
        if (hasContent) {
          const checked = shapeOf(obj as Record<string, unknown>)
          if (checked.ok) {
            parsed = checked
            usage = {
              ...(run.cacheHitTokens !== undefined && run.cacheMissTokens !== undefined
                ? { cacheHitTokens: run.cacheHitTokens, cacheMissTokens: run.cacheMissTokens }
                : {}),
              ...(run.inputTokens !== undefined && run.outputTokens !== undefined
                ? { inputTokens: run.inputTokens, outputTokens: run.outputTokens }
                : {}),
            }
            break
          }
          fail = { reason: "invalid", detail: checked.detail, sample }
          invalidFields = checked.fields
        } else {
          fail = { reason: "no-json", detail: obj === undefined ? "model output held no JSON object" : "first JSON object held no checkpoint fields", sample }
        }
      } else {
        fail = { reason: "model-failed", detail: run.detail }
      }
      trail.push(`${current.label}: ${fail.detail}`)
      // One same-provider retry on a bad SHAPE — never on a transport failure — and only
      // the primary earns it: a fallback's bad answer walks at once. Once per compile, so
      // the worst case adds exactly one call (M3-H).
      if ((fail.reason === "invalid" || fail.reason === "no-json") && current === model && retried === 0) {
        retried = 1
        continue
      }
      const nextIndex = queue.shift()
      if (nextIndex === undefined) {
        lastFail = { reason: fail.reason, detail: trail.join("; "), ...(fail.sample !== undefined ? { sample: fail.sample } : {}) }
        break
      }
      const next = chain[nextIndex]!
      hops.push({ from: current.label, to: next.label, reason: `${current.label}: ${fail.detail}` })
      current = next
      label = current.label
    }
    if (parsed === undefined) {
      // A chain that ended on a bad SHAPE is terminal: every provider already had its say
      // on this transcript, and the outer attempts would only re-ask the same question.
      if (lastFail.reason === "invalid") {
        const fb = fellBack()
        return {
          ok: false,
          reason: "invalid",
          detail: lastFail.detail,
          attempts: attempt,
          retried,
          ...(invalidFields !== undefined ? { fields: invalidFields } : {}),
          ...(lastFail.sample !== undefined ? { sample: lastFail.sample } : {}),
          ...(fb !== undefined ? { fellBack: fb } : {}),
        }
      }
      // every command ran at least once in this compile and each one's most
      // recent failure was a limit — a retry would hit the same walls, so stop
      if (lastRunWasLimit.size === chain.length && [...lastRunWasLimit.values()].every(Boolean)) {
        const fb = fellBack()
        return {
          ok: false,
          reason: "summarizer-limit",
          detail: lastFail.detail,
          attempts: attempt,
          retried,
          ...(lastFail.sample !== undefined ? { sample: lastFail.sample } : {}),
          ...(fb !== undefined ? { fellBack: fb } : {}),
        }
      }
      if (attempt < attempts) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0)
      continue
    }
    const fb = fellBack()
    return {
      ok: true,
      checkpoint: parsed.checkpoint,
      compiledBy: label,
      droppedKeys: parsed.droppedKeys,
      trimmed: parsed.trimmed,
      attempts: attempt,
      retried,
      // fellBack is reported only when a fallback actually wrote the checkpoint — a
      // fallback that ran and lost before a later primary success would mislabel the save
      ...(label !== model.label && fb !== undefined ? { fellBack: fb } : {}),
      format: convo.format,
      messagesKept: convo.messagesKept,
      messagesTotal: convo.messagesTotal,
      charsSent: convo.text.length,
      modelMs,
      ...usage,
    }
  }
  // a fallback chain that ran and still lost is part of the failure report — the daemon log says so
  const fb = fellBack()
  return {
    ok: false,
    reason: lastFail.reason,
    detail: lastFail.detail,
    attempts,
    retried,
    ...(lastFail.sample !== undefined ? { sample: lastFail.sample } : {}),
    ...(fb !== undefined ? { fellBack: fb } : {}),
  }
}

/**
 * The throwaway session `mida summarizer test` turns into the real extraction prompt: the
 * one-line "reply with JSON" prompt read to Claude's small model as an injection attempt and
 * made the test report a working model as broken (UF-P2R). Five lines, `\n`-ended.
 */
export const PROBE_TRANSCRIPT =
  [
    "L1 user:",
    'Add a hello() function to src/hello.ts that returns "hello". Use pnpm, never npm.',
    "",
    "L2 assistant:",
    'Created src/hello.ts with hello() returning "hello". The test file is not written yet.',
  ].join("\n") + "\n"

/**
 * `mida summarizer test` (UF-P2a): run the command once and classify the outcome. `ok` needs an
 * answer whose JSON object carries a string `objective`. A failed run becomes `limit` (usage
 * limit), `missing` (spawn error — the binary is not there), `timeout`, or plain `failed`.
 */
export async function probeModel(
  command: ModelCommand,
): Promise<{ ok: true; ms: number } | { ok: false; why: "limit" | "missing" | "timeout" | "failed"; detail: string; ms: number }> {
  const run = await runModel(command, buildExtractPrompt(PROBE_TRANSCRIPT))
  if (run.ok) {
    const obj = extractJsonObject(run.stdout)
    if (typeof obj === "object" && obj !== null && typeof (obj as Record<string, unknown>).objective === "string") {
      return { ok: true, ms: run.ms }
    }
    return { ok: false, why: "failed", detail: "no JSON in the answer", ms: run.ms }
  }
  const why =
    run.limit === true ? "limit" : run.detail.startsWith("spawn:") ? "missing" : run.detail.startsWith("timeout") ? "timeout" : "failed"
  return { ok: false, why, detail: run.detail, ms: run.ms }
}
