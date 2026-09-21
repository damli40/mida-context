import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { callDaemon, ensureDaemon } from "./control.js"
import { noContextText } from "./handoff.js"
import type { SessionStartBody } from "./hook-output.js"
import { degradedMessage, hookReply, sessionStartMessage, whatsNewMessage } from "./hook-output.js"
import { resolveHome } from "./home.js"
import type { MidaHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { appendLog } from "./log.js"
import { isSafeName } from "./queue.js"
import { writeSeen } from "./whatsnew.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const DAEMON_MAIN = fileURLToPath(new URL("./daemon-main.ts", import.meta.url))
const STDIN_CAP_BYTES = 1_000_000
/** The session-start hook may wait for the daemon to come up — but not forever. */
const DAEMON_WAIT_MS = 4_000
const HANDOFF_TIMEOUT_MS = 8_000
/** A prompt must never wait: the whats-new hook gives up silently after this and injects nothing. */
const WHATS_NEW_TIMEOUT_MS = 1_500

/**
 * Reads stdin to EOF — stopping early would leave the hooked CLI holding a full pipe. Only the
 * first `cap` bytes are kept: anything bigger is reported as bad-input, never parsed.
 */
async function readStdin(cap: number): Promise<{ text: string; oversized: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer
    size += buf.length
    if (size <= cap) chunks.push(buf)
  }
  return { text: Buffer.concat(chunks).toString("utf8"), oversized: size > cap }
}

/** One stdout line, flushed before the process exits — the hook's only output channel. */
function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(`${line}\n`, () => resolve())
    } catch {
      resolve()
    }
  })
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, ["--import", "tsx", DAEMON_MAIN], {
    detached: true,
    stdio: "ignore",
    cwd: REPO_ROOT,
    env: drainerEnv(process.env),
  })
  child.on("error", () => {})
  child.unref()
}

/** A local failure still answers the envelope — the owner gets the degraded line either way. */
function degraded(reason: string): string {
  return hookReply("SessionStart", degradedMessage(reason), noContextText(reason))
}

/**
 * The UserPromptSubmit hook — the "what's new" note. It goes straight to the socket: no daemon
 * boot, no health probe, one call with a 1.5 s ceiling. Silence is the contract for every
 * non-update answer — nothing new, a refusal, a timeout or a dead daemon all print nothing and
 * exit 0, so a prompt never waits and never fails. The watermark advances only here, after the
 * note actually reached the model: a lost answer is re-offered by the next prompt.
 */
async function whatsNew(home: MidaHome, agent: string | undefined, record: Record<string, unknown>): Promise<void> {
  try {
    if (!isSafeName(agent)) return
    const cwd = typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd()
    const sessionId = typeof record.session_id === "string" ? record.session_id : undefined
    const reply = await callDaemon(home, "/whatsnew", { agent, cwd, sessionId }, { timeoutMs: WHATS_NEW_TIMEOUT_MS })
    if (reply.status !== 200) {
      // silence stays the prompt's contract — but a give-up is not invisible: doctor counts these
      if (reply.status === 0) appendLog(home, "hook", { event: "whatsnew-timeout", agent, sessionId })
      return
    }
    const body = reply.body as { kind?: unknown; note?: unknown; updates?: unknown; seen?: unknown } | null
    if (body?.kind !== "updates" || typeof body.note !== "string" || body.note === "") return
    const updates = Array.isArray(body.updates) ? body.updates : []
    const seen = Array.isArray(body.seen) ? body.seen.filter((id): id is string => typeof id === "string") : undefined
    await writeLine(hookReply("UserPromptSubmit", whatsNewMessage(updates, Date.now()), body.note))
    // the seen set is written only after the note was printed — an answer lost on the way to the
    // model stays undelivered, and the next prompt offers it again
    if (sessionId !== undefined && seen !== undefined) {
      try {
        writeSeen(home, sessionId, seen)
      } catch {
        // a failed state write only means the same note may be offered once more
      }
    }
  } catch {
    // the prompt hook never throws — silence, exit 0
  }
}

/**
 * The SessionStart hook: asks midad for this project's handoff as `inject-main.ts <agent>` and
 * prints one JSON line — `systemMessage` is the one-line outcome both tools show the owner,
 * `hookSpecificOutput.additionalContext` carries the model's text byte-for-byte. It is fail-open
 * by contract: whatever goes wrong, the exit code is 0 and stderr stays empty, because a failing
 * session-start hook must never block the agent.
 */
async function main(): Promise<void> {
  // an EPIPE on stdout must not become an unhandled stream error — stdout is best-effort
  process.stdout.on("error", () => {})
  const home = resolveHome(process.env)
  const agent = process.argv[2]
  const { text, oversized } = await readStdin(STDIN_CAP_BYTES)
  let parsed: unknown = undefined
  if (!oversized) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  // the prompt hook is a different contract — silent always, even on bad input or a bad name:
  // it dispatches before the checks that print SessionStart-shaped refusals
  if (record.hook_event_name === "UserPromptSubmit") {
    await whatsNew(home, agent, record)
    return
  }
  if (!isSafeName(agent)) {
    await writeLine(degraded("bad-agent"))
    return
  }
  if (parsed === undefined) {
    await writeLine(degraded("bad-input"))
    return
  }
  // anything that is not a session start — another hook event, or no event at all — stays silent
  if (record.hook_event_name !== "SessionStart") return
  const cwd = typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd()
  // before `init` wrote network.json no daemon can exist — the spawn would die on the same check
  const up = home.has("network.json") && (await ensureDaemon(home, spawnDaemon, { waitMs: DAEMON_WAIT_MS }))
  if (!up) {
    await writeLine(degraded("daemon-down"))
    return
  }
  const reply = await callDaemon(
    home,
    "/handoff",
    { agent, cwd, sessionId: typeof record.session_id === "string" ? record.session_id : undefined },
    { timeoutMs: HANDOFF_TIMEOUT_MS },
  )
  const body = reply.body as SessionStartBody | null
  if (reply.status === 0) {
    await writeLine(degraded("daemon-down"))
    return
  }
  if (typeof body?.text !== "string") {
    await writeLine(degraded("bad-reply"))
    return
  }
  // the session's whats-new seen set starts here: the contextIds this handoff covered — or the
  // empty set, so the first real save afterwards still shows up as new. It is written only once
  // the handoff was actually delivered: a line that never reached the model covered nothing.
  const sessionId = typeof record.session_id === "string" ? record.session_id : undefined
  const covered =
    body.kind === "refused" || !Array.isArray(body.seen)
      ? undefined
      : body.seen.filter((id): id is string => typeof id === "string")
  await writeLine(hookReply("SessionStart", sessionStartMessage(body, agent, Date.now()), body.text))
  if (sessionId !== undefined && covered !== undefined) {
    try {
      writeSeen(home, sessionId, covered)
    } catch {
      // no baseline written — the whats-new read will simply treat everything as new once
    }
  }
}

// fail-open, always: one try/catch around everything, exit 0, nothing on stderr
main().catch(() => {}).finally(() => process.exit(0))
