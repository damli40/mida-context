// Turn a transcript into a validated checkpoint through a swappable model
// command. Ported from spike/hooks/capture-worker.mjs with three changes:
// the model runs through async spawn (the drainer must stay responsive), a
// failed call is retried with backoff, and the checkpoint is returned to the
// caller instead of stored — the drainer owns storage.

import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { CONTENT_FIELDS, LIMITS, validateCheckpoint, type Checkpoint } from "@mida/checkpoint"
import { extractJsonObject } from "./extract-json.js"
import { buildExtractPrompt } from "./prompt.js"
import { scrubValue } from "./scrub.js"
import { readConversation, type Conversation } from "./transcript-claude.js"

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
}

export const DEFAULT_MODEL: ModelCommand = {
  argv: ["claude", "-p", "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config"],
  label: "claude-haiku",
  timeoutMs: 90_000,
}

export interface CompileInput {
  transcriptPath: string
  agent: string
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
    }
  | {
      ok: false
      reason: "model-failed" | "no-json" | "invalid"
      detail: string
      attempts: number
      /** Leading field paths from the validator when reason is "invalid" — names only, safe for logs. */
      fields?: string[]
      /** Present when the fallback ran (and lost too): which model failed and the reason that triggered it. */
      fellBack?: { from: string; to: string; reason: string }
    }

const MAX_STDOUT = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 90_000
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type ModelRun = { ok: true; stdout: string; ms: number } | { ok: false; detail: string; ms: number }

// One bad field must not cost the whole save. Strings over the schema limit
// are cut to it ending in "…"; arrays over the item limit keep 50 entries —
// the LAST 50 for progress/evidence (the newest entries are the ones that
// matter), the FIRST 50 for every other array. Each cut is named in
// `trimmed` ("progress[3]", "decisions", "decisions[3].rationale").
function trimFields(picked: Record<string, unknown>, trimmed: string[]): void {
  const cutStr = (v: unknown, path: string): unknown => {
    if (typeof v !== "string" || v.length <= LIMITS.maxString) return v
    trimmed.push(path)
    return v.slice(0, LIMITS.maxString - 1) + "…"
  }
  for (const field of ["objective", "nextAction", "unresolvedIssue"]) {
    picked[field] = cutStr(picked[field], field)
  }
  const cutList = (field: string, keepLast: boolean) => {
    const arr = picked[field]
    if (!Array.isArray(arr)) return
    for (let i = 0; i < arr.length; i++) arr[i] = cutStr(arr[i], `${field}[${i}]`)
    if (arr.length > LIMITS.maxArray) {
      trimmed.push(field)
      picked[field] = keepLast ? arr.slice(-LIMITS.maxArray) : arr.slice(0, LIMITS.maxArray)
    }
  }
  for (const field of ["progress", "constraints", "artifacts", "remainingPlan"]) {
    cutList(field, field === "progress")
  }
  for (const field of ["decisions", "rejected", "evidence"]) {
    const arr = picked[field]
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
    if (arr.length > LIMITS.maxArray) {
      trimmed.push(field)
      picked[field] = field === "evidence" ? arr.slice(-LIMITS.maxArray) : arr.slice(0, LIMITS.maxArray)
    }
  }
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
function runModel(model: ModelCommand, prompt: string): Promise<ModelRun> {
  const t0 = Date.now()
  const timeoutMs = model.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { ok: true; stdout: string } | { ok: false; detail: string }) => {
      if (settled) return
      settled = true
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

    let child
    try {
      child = spawn(model.argv[0] ?? "", [...model.argv.slice(1)], {
        cwd: os.tmpdir(),
        env,
        // stderr is piped only for commands whose stderr is a controlled channel (stderrDetail);
        // an arbitrary model's stderr is ignored, never captured into a log line
        stdio: ["pipe", "pipe", model.stderrDetail === true ? "pipe" : "ignore"],
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

    const settle = () => {
      clearTimeout(timer)
      if (timedOut || exited === null) return
      if (exited.code !== 0) done({ ok: false, detail: `exit ${exited.code} signal ${exited.signal}${stderrNote()}` })
      else done({ ok: true, stdout })
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
      if (stderr.length < 4096) stderr += c.slice(0, 4096 - stderr.length)
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

  const convo = readConversation(input.transcriptPath)
  const prompt = buildExtractPrompt(convo.text, input.previous)

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
  let lastFail: { reason: "model-failed" | "no-json"; detail: string } = {
    reason: "model-failed",
    detail: "no attempt ran",
  }
  // The unspent fallback providers. Each is shifted out as it runs, so a provider is
  // never tried twice — a later attempt re-runs the primary, never the chain.
  const queue = [...(input.fallbackModels ?? [])]

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let current = model
    let label = model.label
    // This attempt's failure trail ("<label>: <detail>") — the detail of a chain that
    // failed end-to-end names every provider it tried, in order.
    const trail: string[] = []
    // Walk the provider chain inside this attempt: a command failure (exit, spawn error,
    // timeout — a provider's "http 429"/5xx lands as the first) or output holding no usable
    // JSON both move to the next unspent provider; a usable object leaves the loop for the
    // validation below.
    let parsed: Record<string, unknown> | undefined
    for (;;) {
      const run = await runModel(current, prompt)
      modelMs += run.ms
      let fail: { reason: "model-failed" | "no-json"; detail: string }
      if (run.ok) {
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
          parsed = obj as Record<string, unknown>
          break
        }
        fail = { reason: "no-json", detail: obj === undefined ? "model output held no JSON object" : "first JSON object held no checkpoint fields" }
      } else {
        fail = { reason: "model-failed", detail: run.detail }
      }
      trail.push(`${current.label}: ${fail.detail}`)
      const next = queue.shift()
      if (next === undefined) {
        lastFail = { reason: fail.reason, detail: trail.join("; ") }
        break
      }
      hops.push({ from: current.label, to: next.label, reason: `${current.label}: ${fail.detail}` })
      current = next
      label = current.label
    }
    if (parsed === undefined) {
      if (attempt < attempts) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0)
      continue
    }
    {
      const obj = parsed
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
      picked.originalRequest = convo.firstUserMessage

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
      trimFields(picked, trimmed)

      const v = validateCheckpoint(picked)
      // A validation failure is deterministic — the same input would fail
      // the same way — so it is reported at once and never retried.
      const fb = fellBack()
      if (!v.ok) {
        // the drainer may log field NAMES ("decisions[3].rationale") — never
        // the validator's messages, which can echo the value that failed
        const fields = [...new Set(v.errors.map((e) => e.split(":")[0]!))]
        return { ok: false, reason: "invalid", detail: v.errors.join("; "), attempts: attempt, fields, ...(fb !== undefined ? { fellBack: fb } : {}) }
      }
      return {
        ok: true,
        checkpoint: v.value,
        compiledBy: label,
        droppedKeys,
        trimmed,
        attempts: attempt,
        // fellBack is reported only when a fallback actually wrote the checkpoint — a
        // fallback that ran and lost before a later primary success would mislabel the save
        ...(label !== model.label && fb !== undefined ? { fellBack: fb } : {}),
        format: convo.format,
        messagesKept: convo.messagesKept,
        messagesTotal: convo.messagesTotal,
        charsSent: convo.text.length,
        modelMs,
      }
    }
  }
  // a fallback chain that ran and still lost is part of the failure report — the daemon log says so
  const fb = fellBack()
  return { ok: false, reason: lastFail.reason, detail: lastFail.detail, attempts, ...(fb !== undefined ? { fellBack: fb } : {}) }
}
