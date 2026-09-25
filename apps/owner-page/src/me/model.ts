export type Hex = `0x${string}`
export interface Chips { read: boolean; write: boolean; updateOwn: boolean; updateAny: boolean }
export type Lane = "direct" | "batched"
export type AnchorState = "anchored" | "pending" | "unverified"
export type Badge = { kind: "you" | "agent" | "claimed" | "unknown"; text: string }

// Bit values are PERMISSION in packages/protocol/src/constants.ts:1 — duplicated here on purpose so
// the model has no imports and stays trivially testable; the test pins them.
export function chipsFor(permissions: number): Chips {
  return { read: (permissions & 1) !== 0, write: (permissions & 2) !== 0, updateOwn: (permissions & 4) !== 0, updateAny: (permissions & 8) !== 0 }
}

// PROVENANCE_SOURCE (constants.ts:25-28). The contract accepts 1/2 only from the owner
// (ContextRegistry.sol:130-132), and BatchAnchor accepts only 3 (BatchAnchor.sol:127).
export function provenanceBadge(i: { source: number | null; authorName: string; lane: Lane; state: AnchorState }): Badge {
  if (i.lane === "batched" && i.state === "pending") return { kind: "claimed", text: `${i.authorName} claimed` }
  if (i.source === 1 || i.source === 2) return { kind: "you", text: "You said" }
  if (i.source === 3) return { kind: "agent", text: `${i.authorName} inferred` }
  return { kind: "unknown", text: "Source unknown" }
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value)
}

// Monad's ~0.4 s block cadence — the index's lag is a block count (Envio `_meta`:
// sourceBlock − progressBlock), rendered as seconds so the owner reads "how stale" not "how
// many blocks". Past STALE_INDEX_BLOCKS the badge flags the index stale.
const SECONDS_PER_BLOCK = 0.4
export const STALE_INDEX_BLOCKS = 150

export function lagText(blocksBehind: number | null): { text: string; stale: boolean } {
  if (blocksBehind === null || !Number.isFinite(blocksBehind)) return { text: "index unavailable", stale: true }
  const blocks = Math.max(0, blocksBehind)
  const seconds = Math.round(blocks * SECONDS_PER_BLOCK)
  return { text: `≈ ${seconds} s behind Monad`, stale: blocks > STALE_INDEX_BLOCKS }
}

/**
 * Every OTHER agent the page knows about, whatever state its rows showed — "could not verify" is
 * a reason to ask the chain, not to skip the agent. confirmRevoke re-checks hasAuthority(READ)
 * per rotated area before any wrap publishes, so a stale or unverifiable row can waste a read,
 * never grant one; a row the page failed to check could still be a live reader the rotate locks
 * out if it is left off the list.
 */
export function readersAfterRevoke(agents: readonly { agentId: Hex }[], revoking: Hex): Hex[] {
  const r = revoking.toLowerCase()
  return agents.filter((a) => a.agentId.toLowerCase() !== r).map((a) => a.agentId)
}

export interface GrantTruth { indexSaysLive: boolean; chainSaysValid: boolean | null }
export function grantStatus(t: GrantTruth): { label: "Can read" | "Revoked" | "Expired or revoked on Monad" | "Unverified"; flagged: boolean } {
  if (t.chainSaysValid === null) return { label: "Unverified", flagged: true }
  if (t.chainSaysValid) return { label: "Can read", flagged: !t.indexSaysLive }
  return t.indexSaysLive ? { label: "Expired or revoked on Monad", flagged: true } : { label: "Revoked", flagged: false }
}
