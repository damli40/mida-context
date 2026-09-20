import type { MidaHome } from "./home.js"
import { appendLog } from "./log.js"
import { enqueue } from "./queue.js"

/** The Claude Code events Mida listens to. */
export type HookEvent = "PostToolUse" | "Stop" | "StopFailure" | "PreCompact" | "SessionEnd"

/** Events that mean "save now": the session is ending or about to lose context, so the 60 s gap is ignored. */
export const FLUSH_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["Stop", "StopFailure", "PreCompact", "SessionEnd"])

const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEvent>(["PostToolUse", "Stop", "StopFailure", "PreCompact", "SessionEnd"])

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
    if (typeof record.transcript_path !== "string" || record.transcript_path === "") {
      log({ event, sessionId, outcome: "ignored", reason: "no-transcript-path" })
      return
    }
    const job = enqueue(input.home, {
      agent: input.agent,
      event: event as HookEvent,
      sessionId: sessionId ?? "",
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
