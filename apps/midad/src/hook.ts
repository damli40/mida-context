import { lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { recordedCodexHome } from "./codex-home.js"
import { callDaemon } from "./control.js"
import { DEVIN_SAVE_EVENTS, devinDbPathAllowed, foreignClientReplayReason, parentProcessBasename, resolveDevinDbPath } from "./devin-facts.js"
import type { MidaHome } from "./home.js"
import { appendLog } from "./log.js"
import { enqueue, isSafeName, projectIdFor } from "./queue.js"
import { pinSessionTask, resolveSessionTask, taskOrUndefined } from "./task.js"

/** The Claude Code events Mida listens to. */
export type HookEvent = "PostToolUse" | "Stop" | "StopFailure" | "PreCompact" | "SessionEnd"

/** Events that mean "save now": the session is ending or about to lose context, so the 60 s gap is ignored. */
export const FLUSH_EVENTS: ReadonlySet<string> = new Set(["Stop", "StopFailure", "PreCompact", "SessionEnd", "PostCompaction"])

const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEvent>(["PostToolUse", "Stop", "StopFailure", "PreCompact", "SessionEnd"])
/** Devin's own save events — PostCompaction replaces Claude's PreCompact; it has no StopFailure. */
const DEVIN_KNOWN_EVENTS: ReadonlySet<string> = new Set(DEVIN_SAVE_EVENTS)
/** The kick must never slow the hook down: a daemon that does not answer inside 150 ms is treated as down. */
const KICK_TIMEOUT_MS = 150

/**
 * The transcript roots each agent is trusted under, as absolute paths. `claude-code` sessions live
 * at `<homeDir>/.claude/projects/`; Codex writes session rollouts at
 * `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` — verified against the throwaway
 * CODEX_HOME the spike harness runs — so `codex` trusts the `sessions/` folder under the Codex
 * home `mida install codex` recorded in the Mida home, or `<homeDir>/.codex/sessions` while
 * nothing is recorded. The record REPLACES the default rather than adding to it: trusting both
 * would keep reading rollouts under a home the install's own "moved" message says is no longer
 * trusted. An agent with no roots has no trusted transcript folder at all and is refused outright.
 */
export function transcriptRoots(agent: string, homeDir: string, home?: MidaHome): string[] {
  if (agent === "claude-code") return [join(homeDir, ".claude", "projects")]
  if (agent === "codex") {
    const recorded = home === undefined ? undefined : recordedCodexHome(home)
    return [join(recorded ?? join(homeDir, ".codex"), "sessions")]
  }
  return []
}

/**
 * The hook must not be an any-file reader: a transcript is only trusted when it is an absolute
 * `.jsonl` path that really is a regular file (never a symlink, checked with lstat) sitting under
 * one of the agent's transcript roots — for `claude-code` that is `<homeDir>/.claude/projects/`.
 * The realpath comparison also catches a symlinked parent folder. An agent with no transcript
 * roots is refused — there is no fallback to the home folder.
 */
export function transcriptPathAllowed(transcriptPath: unknown, agent: string, homeDir: string, home?: MidaHome): transcriptPath is string {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return false
  if (!isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return false
  const roots = transcriptRoots(agent, homeDir, home)
  if (roots.length === 0) return false
  try {
    const stat = lstatSync(transcriptPath)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    const real = realpathSync.native(transcriptPath)
    return roots.some((root) => {
      try {
        const inside = relative(realpathSync.native(root), real)
        return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/**
 * The environment the detached drainer is spawned with: the hook runs inside the agent CLI, so the
 * parent's Anthropic credentials must never leak into a child that outlives the tool call. The
 * default compile command authenticates through the CLI's own stored login and needs no
 * ANTHROPIC_* variable at all — an inherited ANTHROPIC_BASE_URL or ANTHROPIC_CUSTOM_HEADERS would
 * silently redirect the model traffic, so the allow-list of Anthropic names is empty and every
 * ANTHROPIC_* key is stripped.
 */
export function drainerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (key.startsWith("ANTHROPIC_")) delete clean[key]
  }
  return clean
}

/**
 * Salvages the only fields the hook needs from the head of an oversized stdin payload — they
 * appear first in practice, and a >1 MB body cannot be trusted to JSON.parse anyway. Values are
 * real JSON strings (escaped chars included); a field whose value will not unescape is skipped.
 */
export function extractHookFields(head: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const name of ["hook_event_name", "session_id", "transcript_path", "cwd", "error"]) {
    const match = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head)
    if (match === null) continue
    try {
      found[name] = JSON.parse(`"${match[1]}"`) as string
    } catch {
      // a value that cannot be unescaped is treated as absent
    }
  }
  return found
}

/**
 * The hook runs inside the agent CLI's own process budget: it has to be back in well under a second
 * and must never break the tool call it is attached to. So it does exactly three cheap things —
 * parse the stdin JSON, write one queue file, kick the daemon over the control socket — and every
 * slow thing (reading the transcript, the model call, the chain write) is the daemon's problem. A
 * kick that gets no answer inside 150 ms spawns a detached daemon; the old detached drainer survives
 * only as the fallback when that spawn itself throws. The hook never throws and never writes to
 * stdout.
 *
 * MIDA_INNER=1 marks the compiler's own model subprocess so a Mida-driven run is not captured as a
 * user session.
 */
export async function runHook(input: {
  agent: string
  stdin: string
  home: MidaHome
  env: NodeJS.ProcessEnv
  /** The no-daemon fallback: spawned only when the kick fails AND `spawnDaemon` threw or is absent. */
  spawnDrainer: () => void
  /** Spawns the detached `midad`; called once when the kick gets no answer. */
  spawnDaemon?: () => void
  /** The user's real home folder — injected so tests can point it at a temp dir. */
  homeDir?: string
  /** The parent process's executable basename — injectable so tests never spawn `ps` (in-13 M-8). */
  parentBasename?: () => string | undefined
}): Promise<void> {
  if (input.env.MIDA_INNER === "1") return
  const started = Date.now()
  const log = (record: Record<string, unknown>) =>
    appendLog(input.home, "hook", { agent: input.agent, ...record, ms: Date.now() - started })
  let event: string | null = null
  let sessionId: string | null = null
  try {
    let parsed: unknown
    try {
      parsed = JSON.parse(input.stdin)
    } catch {
      log({ event, sessionId, outcome: "ignored", reason: "unreadable-input" })
      return
    }
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
    event = typeof record.hook_event_name === "string" ? record.hook_event_name : null
    sessionId = typeof record.session_id === "string" ? record.session_id : null
    // Devin imports other clients' hook config and replays it under its own environment, which
    // sets DEVIN_PROJECT_DIR on every hook process it spawns — and the parent-process basename
    // is the second wall for the launches where it does not (in-13 M-8). A Mida entry for any
    // agent but devin firing either way is a replay, not that client's real session — nothing
    // may be queued or saved under the wrong identity. The env comes from the caller, never
    // process.env, so the decision does not depend on who spawned the test or drainer.
    if (foreignClientReplayReason(input.agent, input.env, input.parentBasename ?? parentProcessBasename) !== null) {
      log({ event, sessionId, outcome: "ignored", reason: "foreign-client" })
      return
    }
    const knownEvents = input.agent === "devin" ? DEVIN_KNOWN_EVENTS : KNOWN_EVENTS
    if (event === null || !knownEvents.has(event)) {
      log({ event, sessionId, outcome: "ignored", reason: "unknown-event" })
      return
    }
    // session_id and the agent name are attacker-controlled strings that become filenames inside
    // the home; only short safe names pass, and a missing session id is rejected rather than merged.
    if (!isSafeName(sessionId)) {
      log({ event, outcome: "ignored", reason: "bad-session-id" })
      return
    }
    if (!isSafeName(input.agent)) {
      log({ event, sessionId, outcome: "ignored", reason: "bad-agent" })
      return
    }
    // tk-1, invariant 1: stamp the job with the session's ONCE-resolved task — MIDA_TASK, then
    // the pin a previous event wrote, then the predecessor's task, then the folder default.
    // Resolving here (and pinning) is what makes a `mida task` switch mid-session unable to
    // move this session's later saves; a job written before tasks exist carries no field and
    // the drainer resolves it the same way.
    const safeSessionId = sessionId // const, so the narrowing above survives into the closure
    const taskFor = (cwd: string): string => {
      const projectId = projectIdFor(cwd) ?? undefined
      const resolved = resolveSessionTask(input.home, {
        sessionId: safeSessionId,
        projectId,
        cwd,
        explicit: taskOrUndefined(input.env.MIDA_TASK),
      })
      if (projectId !== undefined && resolved.source !== "session") {
        pinSessionTask(input.home, safeSessionId, projectId, resolved.task)
      }
      return resolved.task
    }
    let job
    if (input.agent === "devin") {
      // Devin's payload is session_id + prompt_id and per-event fields — no transcript_path
      // and no cwd (devin-facts.ts). The session lives in the sessions database resolved from
      // the hook's own env, and the project folder is DEVIN_PROJECT_DIR's whole payload.
      const homeDir = input.homeDir ?? homedir()
      const dbPath = resolveDevinDbPath(input.env, homeDir)
      if (!devinDbPathAllowed(dbPath, input.env, homeDir)) {
        log({ event, sessionId, outcome: "ignored", reason: "devin-db-missing" })
        return
      }
      const cwd = input.env.DEVIN_PROJECT_DIR ?? process.cwd()
      job = enqueue(input.home, {
        agent: input.agent,
        event: event as HookEvent | "PostCompaction",
        sessionId,
        transcriptPath: dbPath,
        cwd,
        task: taskFor(cwd),
        error:
          typeof record.error === "string" ? record.error
          : event === "SessionEnd" && typeof record.reason === "string" ? record.reason
          : null,
      })
    } else {
      if (!transcriptPathAllowed(record.transcript_path, input.agent, input.homeDir ?? homedir(), input.home)) {
        log({ event, sessionId, outcome: "ignored", reason: "bad-transcript-path" })
        return
      }
      const cwd = typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd()
      job = enqueue(input.home, {
        agent: input.agent,
        event: event as HookEvent,
        sessionId,
        transcriptPath: record.transcript_path,
        cwd,
        task: taskFor(cwd),
        error: typeof record.error === "string" ? record.error : null,
      })
    }
    log({ event, sessionId, outcome: "enqueued", jobId: job.id })
    const reply = await callDaemon(input.home, "/kick", {}, { timeoutMs: KICK_TIMEOUT_MS })
    if (reply.status === 0) {
      // the daemon is not answering: it is down or was never started — spawn it and return at once
      try {
        (input.spawnDaemon ?? input.spawnDrainer)()
      } catch {
        // the detached drainer is the last resort — only when there was a real daemon spawn to fail
        if (input.spawnDaemon !== undefined) {
          try {
            input.spawnDrainer()
          } catch {
            // both spawns failed — the job waits in the queue for the next hook
          }
        }
        log({ event, sessionId, outcome: "drainer-spawn-failed" })
      }
    }
  } catch (error) {
    log({ event, sessionId, outcome: "error", reason: error instanceof Error ? error.name : "error" })
  }
}
