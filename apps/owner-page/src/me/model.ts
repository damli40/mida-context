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

export function lagText(indexTimestampSec: number | null, chainTimestampSec: number): { text: string; stale: boolean } {
  if (indexTimestampSec === null) return { text: "index unavailable", stale: true }
  const behind = Math.max(0, chainTimestampSec - indexTimestampSec)
  return { text: `${behind} s behind Monad`, stale: behind > 60 }
}

export function readersAfterRevoke(agents: readonly { agentId: Hex; readLive: boolean }[], revoking: Hex): Hex[] {
  const r = revoking.toLowerCase()
  return agents.filter((a) => a.readLive && a.agentId.toLowerCase() !== r).map((a) => a.agentId)
}

export interface GrantTruth { indexSaysLive: boolean; chainSaysValid: boolean | null }
export function grantStatus(t: GrantTruth): { label: "Can read" | "Revoked" | "Expired or revoked on Monad" | "Unverified"; flagged: boolean } {
  if (t.chainSaysValid === null) return { label: "Unverified", flagged: true }
  if (t.chainSaysValid) return { label: "Can read", flagged: !t.indexSaysLive }
  return t.indexSaysLive ? { label: "Expired or revoked on Monad", flagged: true } : { label: "Revoked", flagged: false }
}
