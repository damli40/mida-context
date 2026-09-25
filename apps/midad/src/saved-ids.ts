import type { Hex } from "@mida/protocol"
import type { MidaHome } from "./home.js"

/**
 * The local index of eventIds already saved, at `state/saved-ids.json` — outside `queue/`, whose
 * sweeper would carry any .json it finds there to `queue/bad/` (CAP-25). It is a cache, not the
 * truth: a miss still asks the chain, a corrupt file is rebuilt by reading as usual, and a
 * leftover index under `queue/` is ignored — never migrated. When a batched save is re-sealed
 * and resubmitted after a stale-epoch rejection its contextId changes; the index follows the
 * newest id so a later duplicate check names the record that is actually live.
 */
export function readSavedIds(home: MidaHome): Record<string, Hex> {
  try {
    const raw = home.readJson<Record<string, unknown>>("state/saved-ids.json")
    if (raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return {}
    const index: Record<string, Hex> = {}
    for (const [eventId, contextId] of Object.entries(raw)) {
      if (typeof contextId === "string" && /^0x[0-9a-f]{64}$/.test(contextId)) index[eventId] = contextId as Hex
    }
    return index
  } catch {
    return {}
  }
}

export function recordSavedId(home: MidaHome, eventId: string, contextId: Hex): void {
  home.writeSecretJson("state/saved-ids.json", { ...readSavedIds(home), [eventId]: contextId })
}
