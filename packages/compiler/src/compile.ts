// Turn a transcript into a validated checkpoint through a swappable model
// command. Ported from spike/hooks/capture-worker.mjs with three changes:
// the model runs through async spawn (the drainer must stay responsive), a
// failed call is retried with backoff, and the checkpoint is returned to the
// caller instead of stored — the drainer owns storage.

import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { CONTENT_FIELDS, validateCheckpoint, type Checkpoint } from "@mida/checkpoint"
import { extractJsonObject } from "./extract-json.js"
import { EXTRACT_PROMPT } from "./prompt.js"
import { readConversation, type Conversation } from "./transcript-claude.js"

export interface ModelCommand {
  argv: readonly string[]
  label: string // becomes compiledBy
  timeoutMs?: number
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
      attempts: number
      format: Conversation["format"]
      messagesKept: number
      messagesTotal: number
      charsSent: number
      modelMs: number
    }
  | { ok: false; reason: "model-failed" | "no-json" | "invalid"; detail: string; attempts: number }

const MAX_STDOUT = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 90_000
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type ModelRun = { ok: true; stdout: string; ms: number } | { ok: false; detail: string; ms: number }

// One model call: the prompt goes on stdin, stdout is captured up to
// MAX_STDOUT, and the child is killed at the timeout. Never throws — every
// failure mode (spawn error, timeout, non-zero exit) becomes ok:false.
// Failure details carry exit codes and signals only, never model output.
function runModel(model: ModelCommand, prompt: string): Promise<ModelRun> {
  const t0 = Date.now()
  const timeoutMs = model.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    const done = (r: { ok: true; stdout: string } | { ok: false; detail: string }) =>
      resolve({ ...r, ms: Date.now() - t0 })

    // A shell-exported Anthropic key would silently override the model's
    // normal login (spike bug G2: an exported key produced an empty,
    // successful-looking run), so both names are stripped — values are never
    // logged. MIDA_INNER marks the subprocess so the capture hook ignores it:
    // the real model command is itself an agent run and would otherwise be
    // captured as a session of its own, forever.
    const env: NodeJS.ProcessEnv = { ...process.env, MIDA_INNER: "1" }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN

    let child
    try {
      child = spawn(model.argv[0] ?? "", [...model.argv.slice(1)], {
        cwd: os.tmpdir(),
        env,
        stdio: ["pipe", "pipe", "ignore"],
      })
    } catch (err) {
      done({ ok: false, detail: `spawn: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    let stdout = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (c: string) => {
      if (stdout.length < MAX_STDOUT) stdout += c.slice(0, MAX_STDOUT - stdout.length)
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      done({ ok: false, detail: `spawn: ${err.message}` })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (timedOut) done({ ok: false, detail: `timeout after ${timeoutMs} ms` })
      else if (code !== 0) done({ ok: false, detail: `exit ${code} signal ${signal}` })
      else done({ ok: true, stdout })
    })
    child.stdin.on("error", () => {}) // the child may exit before reading the prompt
    child.stdin.end(prompt)
  })
}

export async function compileCheckpoint(input: CompileInput): Promise<CompileResult> {
  const model = input.model ?? DEFAULT_MODEL
  const attempts = input.attempts ?? 3
  const backoff = input.backoffMs ?? [2000, 8000]
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep

  const convo = readConversation(input.transcriptPath)
  const prompt = EXTRACT_PROMPT + "\n" + convo.text

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
  let lastFail: { reason: "model-failed" | "no-json"; detail: string } = {
    reason: "model-failed",
    detail: "no attempt ran",
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const run = await runModel(model, prompt)
    modelMs += run.ms
    if (!run.ok) {
      lastFail = { reason: "model-failed", detail: run.detail }
    } else {
      const parsed = extractJsonObject(run.stdout)
      if (parsed === undefined) {
        lastFail = { reason: "no-json", detail: "model output held no JSON object" }
      } else {
        // Only the model-writable fields are taken; every other key NAME is
        // reported in droppedKeys (never its value) so validation stays
        // strict on what remains. originalRequest is absent from
        // CONTENT_FIELDS on purpose — a model that returns it gets it
        // dropped and named like any unknown key (spike bug H1).
        const obj = parsed as Record<string, unknown>
        const picked: Record<string, unknown> = {}
        const droppedKeys: string[] = []
        for (const k of Object.keys(obj)) {
          if ((CONTENT_FIELDS as readonly string[]).includes(k)) picked[k] = obj[k]
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

        const v = validateCheckpoint(picked)
        // A validation failure is deterministic — the same input would fail
        // the same way — so it is reported at once and never retried.
        if (!v.ok) {
          return { ok: false, reason: "invalid", detail: v.errors.join("; "), attempts: attempt }
        }
        return {
          ok: true,
          checkpoint: v.value,
          compiledBy: model.label,
          droppedKeys,
          attempts: attempt,
          format: convo.format,
          messagesKept: convo.messagesKept,
          messagesTotal: convo.messagesTotal,
          charsSent: convo.text.length,
          modelMs,
        }
      }
    }
    if (attempt < attempts) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0)
  }
  return { ok: false, reason: lastFail.reason, detail: lastFail.detail, attempts }
}
