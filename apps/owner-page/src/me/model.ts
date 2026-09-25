export type Hex = `0x${string}`
export interface Chips { read: boolean; write: boolean; updateOwn: boolean; updateAny: boolean }
export type Lane = "direct" | "batched"
// "unverified" means the chain answered and the record is not what it claimed; "unknown" means
// the chain check itself could not run — a failed read must never read as "not on Monad".
export type AnchorState = "anchored" | "pending" | "unverified" | "unknown"
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

export type GrantLabel = "Can read" | "Revoked" | "Expired" | "Expired or revoked on Monad" | "Unverified"

export interface GrantTruth {
  /** What the discovery source claimed — the index row, or a grant log in chain-log mode. */
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

export function grantStatus(t: GrantTruth): { label: GrantLabel; flagged: boolean } {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const cap = t.capability
  if (cap === null || t.chainSaysValid === null) return { label: "Unverified", flagged: true }
  if (!same(cap.owner, t.owner) || !same(cap.agentId, t.agentId) || !same(cap.namespaceId, t.namespaceId)) {
    return { label: "Unverified", flagged: true }
  }
  if (t.chainSaysValid) return { label: "Can read", flagged: !t.sourceSaysLive }
  // Dead on chain: expiry is the only cause that is a wall-clock fact — name it exactly; when
  // the clock could not be read, "expired or revoked" is the honest label.
  if (t.nowSeconds === null) {
    return t.sourceSaysLive ? { label: "Expired or revoked on Monad", flagged: true } : { label: "Revoked", flagged: false }
  }
  if (cap.expiresAt !== 0n && cap.expiresAt <= t.nowSeconds) return { label: "Expired", flagged: t.sourceSaysLive }
  return { label: "Revoked", flagged: t.sourceSaysLive }
}
