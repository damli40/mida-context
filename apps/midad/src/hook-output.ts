/**
 * What the owner sees when a hook fires. Both agent CLIs show the human a warning line from
 * the hook stdout's top-level `systemMessage`, while the model only ever receives the text in
 * `hookSpecificOutput.additionalContext`. The two channels never mix: the human line is one
 * short plain sentence — no ids, no hex, no context — and the model text is byte-for-byte
 * whatever the daemon answered.
 */

/** The warning line must stay a line — hard cap, counting the ellipsis. */
const MAX_SYSTEM_MESSAGE = 160

/**
 * The closing fence of every handoff text. It lives on this leaf because the MCP adapter caps
 * the handoff reply at 40,000 chars and must never cut through it — handoff.ts re-exports the
 * same constant so the fence is defined once (mcp.ts may only reach leaf modules).
 */
export const HANDOFF_TAIL = "=== END MIDA HANDOFF DATA ==="

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
  /** The daemon reports when the render left out reasons behind decisions/rejected approaches. */
  reasonsLeftOut?: boolean
  /** The store's list was incomplete — the owner's line must say so, never claim completeness. */
  partial?: boolean
  /** The contextIds the handoff covered — the session's whats-new seen set starts from these. */
  seen?: unknown
}

/** The one-line degraded outcome: daemon silent, reply unreadable, or a refusal with no prose. */
export function degradedMessage(reason: string): string {
  return systemMessage(`Mida: could not load context (${reason}) — working without it`)
}

/**
 * The one line every surface prints when the chain could not be ASKED (in-6 R4): owner-facing
 * in the hook's systemMessage, model-facing as the daemon's refused text, reproduced again in
 * mida-mcp — one wording everywhere so "the RPC was busy" can never come out as "not approved".
 */
export const CHAIN_BUSY_TEXT =
  "Mida: Monad is busy right now — context not loaded; working without it (it tries again next session)"

/**
 * The two failures that are NOT busy (in-11 R-8): the RPC answered but found no contract at
 * the configured address — a setup to fix, not a wait — and the provider refused the key.
 * Same shape as CHAIN_BUSY_TEXT so a hook line never promises a retry that cannot help.
 */
export const CHAIN_MISCONFIGURED_TEXT =
  "Mida: the RPC answered but found no Mida contract — check MONAD_TESTNET_RPC or network.json; context not loaded, working without it"

export const RPC_AUTH_TEXT =
  "Mida: the RPC provider refused the key — check the provider URL in MONAD_TESTNET_RPC or network.json; context not loaded, working without it"

/**
 * The SAME two failures when the STORE reported them (in-12 N-8): then it is the store's
 * connection to Monad that is misconfigured or whose key was refused — telling the owner to
 * inspect their own MONAD_TESTNET_RPC would send them fixing a setup that was never asked.
 */
export const STORE_CHAIN_MISCONFIGURED_TEXT =
  "Mida: the store's connection to Monad is misconfigured — the store operator must fix it; context not loaded, working without it"

export const STORE_RPC_AUTH_TEXT =
  "Mida: the store's RPC key was refused — the store operator must fix it; context not loaded, working without it"

/**
 * The owner-facing line for each chain-refusal reason — one wording on every surface. Keyed by
 * the literal reason strings chain-busy.ts returns; kept import-free so this file stays a leaf
 * the MCP adapter may reach (mcp.test.ts walks that graph).
 */
export const CHAIN_REFUSAL_TEXT = {
  "chain-busy": CHAIN_BUSY_TEXT,
  "chain-misconfigured": CHAIN_MISCONFIGURED_TEXT,
  "rpc-auth": RPC_AUTH_TEXT,
  "store-misconfigured": STORE_CHAIN_MISCONFIGURED_TEXT,
  "store-rpc-auth": STORE_RPC_AUTH_TEXT,
} as const

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
    // honest size state in plain words (in-20 T-3): the "(shortened, longer than the
    // limit)" pair read like a contradiction and a failure. What happened is said
    // instead — "trimmed" only when progress was actually left out, "above the size
    // target" when the text is still over, and the two combine with "; still" so a
    // trimmed handoff that remains over never reads as two separate problems (R5-4).
    // A partial store list joins with "; " after the size part: the owner hears
    // "incomplete", never a count that looks whole (M3-D).
    const size =
      body.cut === true
        ? body.oversized === true
          ? "older entries trimmed; still above the size target"
          : "older entries trimmed to fit"
        : body.oversized === true
          ? "above the size target"
          : null
    const state = size !== null
      ? ` (${size}${body.partial === true ? "; incomplete — try again in a moment" : ""})`
      : body.partial === true
        ? " (incomplete — try again in a moment)"
        : ""
    return systemMessage(`Mida: handoff loaded — ${counts}${from}${state}`)
  }
  if (body.kind === "empty") {
    return body.partial === true
      ? "Mida: connected — could not check saved context fully (incomplete — try again in a moment)"
      : "Mida: connected — nothing saved for this project yet"
  }
  if (body.kind === "refused" && body.reason === "revoked") {
    return systemMessage(`Mida: ${agent} has no access to this project (revoked by the owner). Revoking stops future reads; it cannot recall what this agent already read.`)
  }
  if (body.kind === "refused" && body.reason === "not-approved") {
    return systemMessage(`Mida: ${agent} has no access to this project (not approved yet — run: mida approve ${agent} in this folder)`)
  }
  // a chain refusal is not a denial: each reason — busy, a local setup to fix, or the store's
  // own connection (store-*) — carries its line in CHAIN_REFUSAL_TEXT so the owner hears whose
  // RPC actually broke (in-12 N-8)
  if (body.kind === "refused" && body.reason !== undefined && body.reason in CHAIN_REFUSAL_TEXT) {
    return systemMessage(CHAIN_REFUSAL_TEXT[body.reason as keyof typeof CHAIN_REFUSAL_TEXT])
  }
  return degradedMessage(typeof body.reason === "string" ? body.reason : "no-answer")
}

/**
 * The owner-facing line for a whats-new note: `Mida: update from codex (40 s ago)`, plural for
 * several agents. The note itself is model-facing — this line only says an update arrived.
 */
export function whatsNewMessage(updates: { agent?: unknown; savedAt?: unknown }[], now: number): string {
  const parts = updates.slice(0, 4).map((u) => {
    const name = typeof u.agent === "string" && u.agent !== "" ? u.agent : "another agent"
    return `${name} (${agoText(typeof u.savedAt === "string" ? u.savedAt : "", now)})`
  })
  if (parts.length === 0) return systemMessage("Mida: update from another agent")
  return systemMessage(`Mida: update${parts.length === 1 ? "" : "s"} from ${parts.join(", ")}`)
}

/** The JSON envelope both tools read: one line, the human line and the model text side by side. */
export function hookReply(eventName: string, message: string, additionalContext: string): string {
  return JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  })
}
