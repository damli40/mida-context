/**
 * What the owner sees when a hook fires. Both agent CLIs show the human a warning line from
 * the hook stdout's top-level `systemMessage`, while the model only ever receives the text in
 * `hookSpecificOutput.additionalContext`. The two channels never mix: the human line is one
 * short plain sentence — no ids, no hex, no context — and the model text is byte-for-byte
 * whatever the daemon answered.
 */

/** The warning line must stay a line — hard cap, counting the ellipsis. */
const MAX_SYSTEM_MESSAGE = 160

/** Anything shaped like a raw id or key never reaches the owner's line. */
const LONG_HEX = /0x[0-9a-f]{40,}|[0-9a-f]{40,}/gi

/** One short line for the owner: hex masked, then cut to the cap. */
export function systemMessage(text: string): string {
  const clean = text.replace(LONG_HEX, "<hex>")
  return clean.length > MAX_SYSTEM_MESSAGE ? `${clean.slice(0, MAX_SYSTEM_MESSAGE - 1)}…` : clean
}

/** "40 s ago" / "3 min ago" / "2 h ago" / "4 d ago" — a timestamp's age in plain words. */
export function agoText(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return "a while ago"
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

/** The /handoff reply fields the human line is built from — all optional, from any daemon. */
export interface SessionStartBody {
  kind?: string
  text?: unknown
  reason?: string
  checkpoints?: number
  facts?: number
  savedBy?: string
  savedAt?: string
  cut?: boolean
  oversized?: boolean
}

/** The one-line degraded outcome: daemon silent, reply unreadable, or a refusal with no prose. */
export function degradedMessage(reason: string): string {
  return systemMessage(`Mida: could not load context (${reason}) — working without it`)
}

/**
 * The human-facing line for a SessionStart outcome. The model-facing text is not touched here —
 * it travels separately inside the envelope.
 */
export function sessionStartMessage(body: SessionStartBody | null | undefined, agent: string, now: number): string {
  if (body === null || body === undefined || typeof body.text !== "string") {
    return degradedMessage("no-answer")
  }
  if (body.kind === "handoff") {
    const counts = `${plural(typeof body.checkpoints === "number" ? body.checkpoints : 0, "checkpoint")}, ${plural(
      typeof body.facts === "number" ? body.facts : 0,
      "fact",
    )}`
    const from =
      typeof body.savedBy === "string" && typeof body.savedAt === "string"
        ? ` (from ${body.savedBy}, ${agoText(body.savedAt, now)})`
        : ""
    // honest size state: "(shortened)" only when progress was actually left out — a handoff that
    // is simply longer than the limit says so instead (R5-4)
    const size = [body.cut === true ? "shortened" : null, body.oversized === true ? "longer than the limit" : null].filter(
      (s): s is string => s !== null,
    )
    const state = size.length > 0 ? ` (${size.join(", ")})` : ""
    return systemMessage(`Mida: handoff loaded — ${counts}${from}${state}`)
  }
  if (body.kind === "empty") return "Mida: connected — nothing saved for this project yet"
  if (body.kind === "refused" && body.reason === "revoked") {
    return systemMessage(`Mida: ${agent} has no access to this project (revoked by the owner)`)
  }
  if (body.kind === "refused" && body.reason === "not-approved") {
    return systemMessage(`Mida: ${agent} has no access to this project (not approved yet — run: mida request ${agent})`)
  }
  return degradedMessage(typeof body.reason === "string" ? body.reason : "no-answer")
}

/** The JSON envelope both tools read: one line, the human line and the model text side by side. */
export function hookReply(eventName: string, message: string, additionalContext: string): string {
  return JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  })
}
