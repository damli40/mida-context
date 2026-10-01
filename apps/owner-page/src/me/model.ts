export type Hex = `0x${string}`
export type Lane = "direct" | "batched"
// "unverified" means the chain answered and the record is not what it claimed; "unknown" means
// the chain check itself could not run — a failed read must never read as "not on Monad".
// "blocked" is a pending save whose author can no longer write: the store's deny list names them
// (a revoke is pending on Monad, or the store already holds the row HELD) or Monad's authority
// is gone — the save is parked or dead, never merely "waiting".
export type AnchorState = "anchored" | "pending" | "unverified" | "unknown" | "blocked"
export type Badge = { kind: "you" | "agent" | "unknown"; text: string }

// PROVENANCE_SOURCE (constants.ts:25-28). The contract accepts 1/2 only from the owner
// (ContextRegistry.sol:130-132), and BatchAnchor accepts only 3 (BatchAnchor.sol:127).
// Provenance is only ever a chain fact: a row whose state is not "anchored" has no verified
// provenance at all, so it must say "Source unknown" — never "You said" off a
// pending save's self-report.
export function provenanceBadge(i: { source: number | null; authorName: string; lane: Lane; state: AnchorState }): Badge {
  if (i.state !== "anchored") return { kind: "unknown", text: "Source unknown" }
  if (i.source === 1 || i.source === 2) return { kind: "you", text: "You said" }
  if (i.source === 3) return { kind: "agent", text: `${i.authorName} inferred` }
  return { kind: "unknown", text: "Source unknown" }
}
