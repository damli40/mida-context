import { privateKeyToAccount } from "viem/accounts"
import type { ContextApiClient } from "@mida/api"
import type { Deployment } from "@mida/chain"
import type { Address, Hex } from "@mida/protocol"
import type { MidaHome } from "./home.js"
import { loadAgentIdentity } from "./keys.js"
import { readSavedNetwork } from "./network.js"
import type { SavedNetwork } from "./network.js"
import { apiClient } from "./runtime.js"
import type { ServiceRuntime } from "./runtime.js"

/**
 * The batched checkpoint lane (BatchAnchor): many agents' saves share one Monad transaction while
 * the contract still checks each save's signature, live grant, area, read epoch and parent. It is
 * opt-in — a home without `batching: true` in network.json never takes it, and every failure mode
 * falls back to the direct lane so the save still happens.
 *
 * Two ledgers carry a batched save from "the store took responsibility" to "the chain decided".
 * `state/batch-pending.json` owns saves the store accepted (QUEUED or SUBMITTED) until the store
 * reports ANCHORED or REJECTED — the store's receipt proves only that it queued the save, never
 * that Monad anchored it, so nothing here may call a queued save final. `state/batch-rejected.json`
 * keeps the saves the contract refused, so `mida doctor` can still name them after the pending
 * entry is gone.
 */

/** Why a save took the direct lane after batching was considered. */
export type LaneWhy = "switch-off" | "no-batch-anchor" | "local-store" | "store-disabled" | "store-unreachable"

export type Lane =
  | { kind: "batched"; storeUrl: string; batchAnchor: Address }
  | { kind: "direct"; why: LaneWhy }

/**
 * The lane decision for one save: batched only when the setup switched batching on AND the
 * deployment carries a BatchAnchor AND the hosted store is in use AND the store says batching is
 * on for THIS contract (same anchor address — a store set up for another deployment must not take
 * this setup's saves). Everything else is a direct save with the reason that decided it. The
 * status call itself failing is `store-unreachable`, and a status that answers but disagrees on
 * the anchor reads as `store-disabled` — for this setup the store cannot serve a batch either way.
 */
export async function decideLane(input: {
  saved: SavedNetwork | undefined
  deployment: Deployment
  storageUrl: string | undefined
  status: () => Promise<{ enabled: boolean; batchAnchor: Address } | null>
}): Promise<Lane> {
  if (input.saved?.batching !== true) return { kind: "direct", why: "switch-off" }
  const batchAnchor = input.deployment.batchAnchor
  if (batchAnchor === undefined) return { kind: "direct", why: "no-batch-anchor" }
  if (input.storageUrl === undefined) return { kind: "direct", why: "local-store" }
  const answer = await input.status().catch(() => null)
  if (answer === null) return { kind: "direct", why: "store-unreachable" }
  if (answer.enabled !== true || answer.batchAnchor.toLowerCase() !== batchAnchor.toLowerCase()) {
    return { kind: "direct", why: "store-disabled" }
  }
  return { kind: "batched", storeUrl: input.storageUrl, batchAnchor }
}

/** The plain-words form of a `why` — the refusal `mida batching on` prints and doctor reuses. */
export function laneWhyText(why: LaneWhy): string {
  switch (why) {
    case "switch-off":
      return "batching is not turned on in network.json"
    case "no-batch-anchor":
      return "this setup's contracts do not include a BatchAnchor"
    case "local-store":
      return "this setup keeps context on this machine — batching needs the hosted store"
    case "store-disabled":
      return "the hosted store is not offering batching on this setup's contracts"
    case "store-unreachable":
      return "the hosted store did not answer the batching check"
  }
}

/** A save the store queued, owned by this ledger until the store reports a final state. */
export interface PendingAnchor {
  contextId: Hex
  eventId: string
  sessionId: string
  agent: string
  queuedAt: string
  state: "QUEUED" | "SUBMITTED"
}

/** A save the contract refused — the permanent record a doctor run reports. */
export interface RejectedAnchor {
  contextId: Hex
  eventId: string
  sessionId: string
  agent: string
  reason: string
  at: string
}

const PENDING_FILE = "state/batch-pending.json"
const REJECTED_FILE = "state/batch-rejected.json"

function isEntry(value: unknown, fields: readonly string[]): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string")
  )
}

const PENDING_FIELDS = ["contextId", "eventId", "sessionId", "agent", "queuedAt"] as const
const REJECTED_FIELDS = ["contextId", "eventId", "sessionId", "agent", "reason", "at"] as const

/** The pending ledger's well-formed entries; a malformed row is skipped, never trusted. */
export function pendingAnchors(home: MidaHome): PendingAnchor[] {
  try {
    const raw = home.readJson<{ entries?: unknown }>(PENDING_FILE)
    if (!Array.isArray(raw?.entries)) return []
    return raw.entries
      .filter((entry): entry is Record<string, string> => isEntry(entry, PENDING_FIELDS))
      .filter((entry) => entry.state === "QUEUED" || entry.state === "SUBMITTED")
      .map((entry) => entry as unknown as PendingAnchor)
  } catch {
    // a corrupt ledger cannot decide anything — the entries it held are simply unknown to this run
    return []
  }
}

/**
 * The same ledger read fail-closed, for migrate's "is anything still queued?" — pendingAnchors
 * forgives a corrupt file because a drain pass can simply try again, but a migration deciding
 * "nothing pending" off a file it could not read would move on while saves still wait on the
 * chain. Throws on bad JSON, a non-array `entries`, or an entry whose shape or state is not a
 * known in-flight one; the caller treats every throw as "unknown", and unknown means refuse.
 */
export function pendingAnchorsStrict(home: MidaHome): PendingAnchor[] {
  const raw = home.readJson<{ entries?: unknown }>(PENDING_FILE) // throws on unparseable JSON
  if (raw === undefined) return []
  if (!Array.isArray(raw.entries)) throw new Error(`${PENDING_FILE} is not a pending-ledger file`)
  return raw.entries.map((entry, index) => {
    if (!isEntry(entry, PENDING_FIELDS) || (entry.state !== "QUEUED" && entry.state !== "SUBMITTED")) {
      throw new Error(`${PENDING_FILE} entry ${index} is not a well-formed pending save`)
    }
    return entry as unknown as PendingAnchor
  })
}

/** The rejected ledger's well-formed entries. */
export function rejectedAnchors(home: MidaHome): RejectedAnchor[] {
  try {
    const raw = home.readJson<{ entries?: unknown }>(REJECTED_FILE)
    if (!Array.isArray(raw?.entries)) return []
    return raw.entries
      .filter((entry): entry is Record<string, string> => isEntry(entry, REJECTED_FIELDS))
      .map((entry) => entry as unknown as RejectedAnchor)
  } catch {
    return []
  }
}

/**
 * Adds a store-accepted save to the pending ledger. Each mutation is a synchronous
 * read-modify-write: between a `getBatchSave` await and the ledger write another writer (a CLI
 * save, a second pass) may have appended — re-reading inside the mutation is what keeps that
 * append from being lost.
 */
export function addPendingAnchor(home: MidaHome, entry: Omit<PendingAnchor, "state">): void {
  const entries = pendingAnchors(home).filter((existing) => existing.contextId !== entry.contextId)
  entries.push({ ...entry, state: "QUEUED" })
  home.writeSecretJson(PENDING_FILE, { entries })
}

function removePendingAnchor(home: MidaHome, contextId: Hex): void {
  const entries = pendingAnchors(home)
  if (!entries.some((entry) => entry.contextId === contextId)) return
  home.writeSecretJson(PENDING_FILE, { entries: entries.filter((entry) => entry.contextId !== contextId) })
}

function setPendingAnchorState(home: MidaHome, contextId: Hex, state: PendingAnchor["state"]): void {
  const entries = pendingAnchors(home)
  const entry = entries.find((candidate) => candidate.contextId === contextId)
  if (entry === undefined || entry.state === state) return
  entry.state = state
  home.writeSecretJson(PENDING_FILE, { entries })
}

/** Moves a refused save from the pending ledger to the rejected one — both files in one call. */
function recordRejectedAnchor(home: MidaHome, entry: PendingAnchor, reason: string): void {
  const rejected = rejectedAnchors(home)
  if (!rejected.some((existing) => existing.contextId === entry.contextId)) {
    rejected.push({
      contextId: entry.contextId,
      eventId: entry.eventId,
      sessionId: entry.sessionId,
      agent: entry.agent,
      reason,
      at: new Date().toISOString(),
    })
    home.writeSecretJson(REJECTED_FILE, { entries: rejected })
  }
  removePendingAnchor(home, entry.contextId)
}

/**
 * The store's unsigned batching status — `GET /batch/status` needs no signature, so the CLI and
 * doctor can ask it without a signer. Any failure (down, refused, malformed body) is null: the
 * caller cannot tell "off" from "unreachable" on a dead store, and null is what `decideLane` maps
 * to `store-unreachable`.
 */
export async function batchStatusProbe(storeUrl: string): Promise<{ enabled: boolean; batchAnchor: Address } | null> {
  try {
    const reply = await fetch(`${storeUrl.replace(/\/+$/, "")}/batch/status`, { signal: AbortSignal.timeout(2_000) })
    if (!reply.ok) return null
    const body = (await reply.json()) as { enabled?: unknown; batchAnchor?: unknown }
    if (typeof body.enabled !== "boolean" || typeof body.batchAnchor !== "string") return null
    return { enabled: body.enabled, batchAnchor: body.batchAnchor as Address }
  } catch {
    return null
  }
}

/**
 * A store client signed as the agent that queued the save — `GET /batch/saves/:contextId` answers
 * unconditionally for the uploader's signer, so following a pending entry needs no READ grant.
 * undefined when the agent's identity is gone: the entry then cannot be asked about and stays put.
 */
export function batchClient(
  home: MidaHome,
  baseUrl: string,
  deployment: Deployment,
  agentName: string,
): ContextApiClient | undefined {
  const identity = loadAgentIdentity(home, agentName)
  if (identity === undefined) return undefined
  return apiClient(baseUrl, deployment, privateKeyToAccount(identity.signerPrivateKey))
}

/**
 * The lane for one checkpoint save, read fresh off the live runtime: the flag is re-read from
 * network.json on every call so `mida batching on|off` takes effect on the next save without a
 * restart. The store status is asked with the saving agent's own signature.
 */
export async function laneForSave(runtime: ServiceRuntime, agentName: string): Promise<Lane> {
  const saved = readSavedNetwork(runtime.home)
  const deployment = runtime.network?.deployment
  if (deployment === undefined) {
    return { kind: "direct", why: saved?.batching === true ? "no-batch-anchor" : "switch-off" }
  }
  return decideLane({
    saved,
    deployment,
    storageUrl: runtime.network?.storageUrl,
    status: () => {
      const client = batchClient(runtime.home, runtime.apiBaseUrl, deployment, agentName)
      return client === undefined ? Promise.resolve(null) : client.batchStatus()
    },
  })
}

/**
 * The ledger's follow-up, run at the end of every drain pass: asks the store where each
 * queued/submitted save stands. ANCHORED is the only moment a batched save may be logged "saved";
 * REJECTED moves it to the rejected ledger and logs the contract's reason; anything else keeps it
 * waiting — and a status error leaves the entry exactly as it was, never dropped and never logged
 * as final.
 */
export async function followPendingAnchors(
  runtime: ServiceRuntime,
  log: (record: Record<string, unknown>) => void,
): Promise<{ anchored: number; rejected: number; waiting: number }> {
  const counts = { anchored: 0, rejected: 0, waiting: 0 }
  const deployment = runtime.network?.deployment
  for (const entry of pendingAnchors(runtime.home)) {
    const client =
      deployment === undefined ? undefined : batchClient(runtime.home, runtime.apiBaseUrl, deployment, entry.agent)
    const answer = client === undefined ? null : await client.getBatchSave(entry.contextId).catch(() => null)
    if (answer === null) {
      counts.waiting += 1
      continue
    }
    if (answer.state === "ANCHORED") {
      removePendingAnchor(runtime.home, entry.contextId)
      counts.anchored += 1
      log({
        sessionId: entry.sessionId,
        agent: entry.agent,
        eventId: entry.eventId,
        outcome: "saved",
        lane: "batched",
        contextId: entry.contextId,
        batchId: answer.item?.batchId ?? null,
      })
    } else if (answer.state === "REJECTED") {
      const reason = answer.reason ?? "unknown"
      recordRejectedAnchor(runtime.home, entry, reason)
      counts.rejected += 1
      log({
        sessionId: entry.sessionId,
        agent: entry.agent,
        eventId: entry.eventId,
        outcome: "failed",
        lane: "batched",
        contextId: entry.contextId,
        reason: `batch-rejected:${reason}`,
      })
    } else {
      setPendingAnchorState(runtime.home, entry.contextId, answer.state)
      counts.waiting += 1
    }
  }
  return counts
}
