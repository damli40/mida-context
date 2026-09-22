import type { MidaHome } from "./home.js"
import { isSafeName } from "./queue.js"

/**
 * The session's seen set — the foreign contextIds already delivered to it or covered by its
 * handoff — kept in `state/lastseen/<sessionId>.json`. Lives in its own module because the
 * writers disagree about what else they may touch: the hooks and the MCP adapter record ids
 * but must never pull in the key-holding graph (whatsnew.ts imports handoff.ts, which reads
 * agent keys). Nothing here reads or writes context — only a list of ids.
 */

const lastSeenPath = (sessionId: string) => `state/lastseen/${sessionId}.json`

/** How many delivered contextIds a session's seen record keeps — the oldest drop past this. */
export const SEEN_MAX = 300

/**
 * The session's seen set, or the empty set when there is no usable record: a missing file, a
 * corrupt one, or the old `{ lastSeen }` watermark shape all mean "never saw anything", so every
 * foreign checkpoint counts as new once and the delivered set then quietens later prompts.
 */
export function readSeen(home: MidaHome, sessionId: string | undefined): Set<string> {
  if (sessionId === undefined || !isSafeName(sessionId)) return new Set()
  try {
    const stored = home.readJson<{ seen?: unknown }>(lastSeenPath(sessionId))
    if (!Array.isArray(stored?.seen)) return new Set()
    return new Set(stored.seen.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

/**
 * Written by the context-reading clients — the hooks and the MCP server — at session start (the
 * contextIds the handoff covered) and after a delivered note. `seen` is oldest-first; the file
 * keeps at most SEEN_MAX, the oldest dropped.
 */
export function writeSeen(home: MidaHome, sessionId: string, seen: string[]): void {
  if (!isSafeName(sessionId)) return
  home.writeSecretJson(lastSeenPath(sessionId), { seen: seen.slice(-SEEN_MAX) })
}
