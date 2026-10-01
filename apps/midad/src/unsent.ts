import { unwrapCheckpoint } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import type { MidaHome } from "./home.js"
import { isSafeName } from "./queue.js"

/**
 * CAP-26: a session's save that is compiled on this machine but not yet stored or anchored. The
 * drain marks it right after compiling (or reusing a compiled envelope) and clears the mark once
 * the save lands or fails for good, so the next agent's handoff can show it — marked UNSENT — for a
 * fast switch, instead of waiting ~51 s for the chain. The mark only points at the compiled-envelope
 * cache (`queue/compiled/<eventId>.json`, which is NOT deleted after a save — the hourly sweep ages
 * it out), so a session without a mark is never shown, however many compiled files it left behind.
 * Its own folder: a session id may contain dots, so a name beside `queue/state/<sessionId>.json`
 * could collide with another session's state file.
 */
const markPath = (sessionId: string) => `queue/unsent/${sessionId}.json`

export function markUnsent(home: MidaHome, sessionId: string, eventId: string): void {
  if (!isSafeName(sessionId) || !isSafeName(eventId)) return
  try {
    home.writeSecretJson(markPath(sessionId), { eventId })
  } catch {
    // a failed mark only means the next agent waits for the chain, as it did before CAP-26
  }
}

export function clearUnsent(home: MidaHome, sessionId: string): void {
  if (!isSafeName(sessionId)) return
  try {
    home.remove(markPath(sessionId))
  } catch {
    // an absent mark is the goal; a stuck one is still bounded by "the session has a queued job"
  }
}

/**
 * The marked compiled envelope for a session, or undefined. Local files are untrusted input: the
 * mark must name a safe event id, the envelope must parse as a checkpoint envelope, and it must
 * belong to the session that marked it.
 */
export function readUnsent(home: MidaHome, sessionId: string): CheckpointEnvelope | undefined {
  if (!isSafeName(sessionId)) return undefined
  try {
    const mark = home.readJson<{ eventId?: unknown }>(markPath(sessionId))
    if (mark === undefined || !isSafeName(mark.eventId)) return undefined
    const raw = home.readJson<Record<string, unknown>>(`queue/compiled/${mark.eventId}.json`)
    if (raw === undefined) return undefined
    const envelope = unwrapCheckpoint(raw)
    if (envelope === null || envelope.sessionId !== sessionId) return undefined
    return envelope
  } catch {
    return undefined
  }
}
