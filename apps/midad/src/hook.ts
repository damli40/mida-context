import { lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import type { MidaHome } from "./home.js"
import { appendLog } from "./log.js"
import { enqueue, isSafeName } from "./queue.js"

/** The Claude Code events Mida listens to. */
export type HookEvent = "PostToolUse" | "Stop" | "StopFailure" | "PreCompact" | "SessionEnd"

/** Events that mean "save now": the session is ending or about to lose context, so the 60 s gap is ignored. */
export const FLUSH_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["Stop", "StopFailure", "PreCompact", "SessionEnd"])

const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEvent>(["PostToolUse", "Stop", "StopFailure", "PreCompact", "SessionEnd"])

/** Where each agent keeps its session transcripts, relative to the user's home folder. */
const TRANSCRIPT_DIRS: Readonly<Record<string, string>> = { "claude-code": ".claude/projects" }

/**
 * The hook must not be an any-file reader: a transcript is only trusted when it is an absolute
 * `.jsonl` path that really is a regular file (never a symlink, checked with lstat) sitting under
 * the agent's transcript folder inside `homeDir` — for `claude-code` that is
 * `<homeDir>/.claude/projects/`. The realpath comparison also catches a symlinked parent folder;
 * an agent with no known transcript folder may only read files under `homeDir` at all.
 */
export function transcriptPathAllowed(transcriptPath: unknown, agent: string, homeDir: string): transcriptPath is string {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return false
  if (!isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return false
  try {
    const stat = lstatSync(transcriptPath)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    const base = realpathSync(join(homeDir, TRANSCRIPT_DIRS[agent] ?? ""))
    const inside = relative(base, realpathSync(transcriptPath))
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
  } catch {
    return false
  }
}

/**
 * The environment the detached drainer is spawned with: the hook runs inside the agent CLI, so the
 * parent's Anthropic credentials must never leak into a child that outlives the tool call.
 */
export function drainerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.ANTHROPIC_API_KEY
  delete clean.ANTHROPIC_AUTH_TOKEN
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
 * parse the stdin JSON, write one queue file, spawn the detached drainer — and every slow thing
 * (reading the transcript, the model call, the chain write) is the drainer's problem. It never
 * throws and never writes to stdout.
 *
 * MIDA_INNER=1 marks the compiler's own model subprocess so a Mida-driven run is not captured as a
 * user session.
 */
export async function runHook(input: {
  agent: string
  stdin: string
  home: MidaHome
  env: NodeJS.ProcessEnv
  spawnDrainer: () => void
  /** The user's real home folder — injected so tests can point it at a temp dir. */
  homeDir?: string
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
    if (event === null || !KNOWN_EVENTS.has(event)) {
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
    if (!transcriptPathAllowed(record.transcript_path, input.agent, input.homeDir ?? homedir())) {
      log({ event, sessionId, outcome: "ignored", reason: "bad-transcript-path" })
      return
    }
    const job = enqueue(input.home, {
      agent: input.agent,
      event: event as HookEvent,
      sessionId,
      transcriptPath: record.transcript_path,
      cwd: typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd(),
      error: typeof record.error === "string" ? record.error : null,
    })
    log({ event, sessionId, outcome: "enqueued", jobId: job.id })
    try {
      input.spawnDrainer()
    } catch {
      log({ event, sessionId, outcome: "drainer-spawn-failed" })
    }
  } catch (error) {
    log({ event, sessionId, outcome: "error", reason: error instanceof Error ? error.name : "error" })
  }
}
