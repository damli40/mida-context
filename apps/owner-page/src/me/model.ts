export type Hex = `0x${string}`
export interface Chips { read: boolean; write: boolean; updateOwn: boolean; updateAny: boolean }
export type Lane = "direct" | "batched"
// "unverified" means the chain answered and the record is not what it claimed; "unknown" means
// the chain check itself could not run — a failed read must never read as "not on Monad".
// "blocked" is a pending save whose author can no longer write: the store's deny list names them
// (a revoke is pending on Monad, or the store already holds the row HELD) or Monad's authority
// is gone — the save is parked or dead, never merely "waiting".
export type AnchorState = "anchored" | "pending" | "unverified" | "unknown" | "blocked"
export type Badge = { kind: "you" | "agent" | "unknown"; text: string }

// Bit values are PERMISSION in packages/protocol/src/constants.ts:1 — duplicated here on purpose so
// the model has no imports and stays trivially testable; the test pins them.
export function chipsFor(permissions: number): Chips {
  return { read: (permissions & 1) !== 0, write: (permissions & 2) !== 0, updateOwn: (permissions & 4) !== 0, updateAny: (permissions & 8) !== 0 }
}

// PROVENANCE_SOURCE (constants.ts:25-28). The contract accepts 1/2 only from the owner
// (ContextRegistry.sol:130-132), and BatchAnchor accepts only 3 (BatchAnchor.sol:127).
// Provenance is only ever a chain fact: a row whose state is not "anchored" has no verified
// provenance at all, so it must say "Source unknown" — never "You said" off an index claim or a
// pending save's self-report.
export function provenanceBadge(i: { source: number | null; authorName: string; lane: Lane; state: AnchorState }): Badge {
  if (i.state !== "anchored") return { kind: "unknown", text: "Source unknown" }
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

/**
 * lagText's text when the index answered but could not say how fresh it is — exported so the
 * summary headline can tell "cannot measure" apart from a measured lag and hedge accordingly
 * ("may be behind" vs "is behind", in-26 Q-2).
 */
export const INDEX_FRESHNESS_UNKNOWN_TEXT = "index freshness unknown"

export function lagText(blocksBehind: number | null): { text: string; stale: boolean } {
  // Null means the index ANSWERED but its freshness row was missing, unreadable or for another
  // chain — "index unavailable" would contradict the badge's "Read from the Envio index".
  if (blocksBehind === null || !Number.isFinite(blocksBehind)) return { text: INDEX_FRESHNESS_UNKNOWN_TEXT, stale: true }
  const blocks = Math.max(0, blocksBehind)
  const seconds = Math.round(blocks * SECONDS_PER_BLOCK)
  return { text: `≈ ${seconds} s behind Monad`, stale: blocks > STALE_INDEX_BLOCKS }
}

export type GrantLabel = "Can read" | "Revoked" | "Expired" | "Expired or revoked on Monad" | "Unverified"

export interface GrantTruth {
  /** What the discovery source claimed — the index row. */
  sourceSaysLive: boolean
  /**
   * The chain's capability row — null when the getCapability read itself failed. A row whose
   * owner/agent/namespace does not match the listing is not a fact about this grant at all:
   * "Unverified", never live.
   */
  capability: {
    owner: string
    agentId: string
    namespaceId: string
    /** uint64 seconds — 0 means the grant never expires. */
    expiresAt: bigint
  } | null
  /** isCapabilityValid's answer — null when that read failed. */
  chainSaysValid: boolean | null
  owner: string
  agentId: string
  namespaceId: string
  /** The chain clock (latest block timestamp) — expiry is a timestamp comparison, not a vote. */
  nowSeconds: bigint | null
}

export function grantStatus(t: GrantTruth): { label: GrantLabel; flagged: boolean; unchecked: boolean } {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const cap = t.capability
  // The chain read produced nothing — threw or answered null — so no chain answer exists to
  // compare the listing to. "Unverified" here means could-not-check, a different claim than
  // "the index disagrees"; the page picks its wording off `unchecked`.
  if (cap === null || t.chainSaysValid === null) return { label: "Unverified", flagged: true, unchecked: true }
  // The chain ANSWERED — with a row for a different grant. That is a disagreement between the
  // listing and Monad, not an unreachable chain.
  if (!same(cap.owner, t.owner) || !same(cap.agentId, t.agentId) || !same(cap.namespaceId, t.namespaceId)) {
    return { label: "Unverified", flagged: true, unchecked: false }
  }
  if (t.chainSaysValid) return { label: "Can read", flagged: !t.sourceSaysLive, unchecked: false }
  // Dead on chain: expiry is the only cause that is a wall-clock fact — name it exactly; when
  // the clock could not be read, "expired or revoked" is the honest label.
  if (t.nowSeconds === null) {
    return t.sourceSaysLive
      ? { label: "Expired or revoked on Monad", flagged: true, unchecked: false }
      : { label: "Revoked", flagged: false, unchecked: false }
  }
  if (cap.expiresAt !== 0n && cap.expiresAt <= t.nowSeconds) {
    // The index has no notion of expiry — an aged-out grant is a chain clock fact, never an
    // index disagreement, so it is not flagged.
    return { label: "Expired", flagged: false, unchecked: false }
  }
  return { label: "Revoked", flagged: t.sourceSaysLive, unchecked: false }
}
