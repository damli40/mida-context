import { privateKeyToAccount } from "viem/accounts"
import type { ContextApiClient } from "@mida/api"
import type { Deployment } from "@mida/chain"
import type { CreateContextInput } from "@mida/sdk"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { MidaHome } from "./home.js"
import { isRevoked, loadAgentIdentity } from "./keys.js"
import { readSavedNetwork } from "./network.js"
import type { SavedNetwork } from "./network.js"
import { NAMESPACE, apiClient } from "./runtime.js"
import type { ServiceRuntime } from "./runtime.js"
import { recordSavedId } from "./saved-ids.js"

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
  /** HELD is still in-flight: the store is holding the save while a revoke is pending (in-3 I5). */
  state: "QUEUED" | "SUBMITTED" | "HELD"
  /** Stale-epoch resubmissions already spent on this save — the cap is MAX_EPOCH_RETRIES. */
  retries?: number
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
      .filter((entry) => entry.state === "QUEUED" || entry.state === "SUBMITTED" || entry.state === "HELD")
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
    if (!isEntry(entry, PENDING_FIELDS) || (entry.state !== "QUEUED" && entry.state !== "SUBMITTED" && entry.state !== "HELD")) {
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

/** Counts a resubmission attempt on the entry — kept through failed tries so the cap still holds. */
function setPendingAnchorRetries(home: MidaHome, contextId: Hex, retries: number): void {
  const entries = pendingAnchors(home)
  const entry = entries.find((candidate) => candidate.contextId === contextId)
  if (entry === undefined) return
  entry.retries = retries
  home.writeSecretJson(PENDING_FILE, { entries })
}

/**
 * The plaintext a batched save keeps for a stale-epoch retry (in-2 I3): the same createBatched
 * input the queue call used — the checkpoint envelope, kind, source and tags — at
 * `state/batch-plaintext/<contextId>.json`. Written the moment a save is queued, held while the
 * pending ledger owns it, and dropped the instant the chain answers final: anchored, refused,
 * or retries spent. writeSecretJson gives it the home's 0600 atomic write, and its content is
 * never logged — the ledgers and the drain log carry contextIds and eventIds only.
 */
const PENDING_PLAINTEXT_DIR = "state/batch-plaintext"

const pendingPlaintextPath = (contextId: Hex): string => `${PENDING_PLAINTEXT_DIR}/${contextId.toLowerCase()}.json`

/** Rejection names a resubmission can fix: the signature was sealed under a rotated-away epoch. */
const EPOCH_RETRYABLE = new Set(["BAD_EPOCH", "EPOCH_STALE"])
/** A stale-epoch save is re-sealed and resubmitted at most this many times, then it is refused. */
const MAX_EPOCH_RETRIES = 3

/**
 * The wire codes a resubmission may treat as the store judging the SAVE (in-12 N-3) — and only
 * these. Each is an authority answer the contract itself would reproduce for the same signed
 * fields: the signer holds no live grant or is not an agent at all (CAPABILITY_DENIED /
 * CAPABILITY_REVOKED / CAPABILITY_EXPIRED / NOT_AN_AGENT), the signature does not recover to the
 * request signer (SIGNER_MISMATCH), or a save with that contextId is already stored
 * (ALREADY_QUEUED). EVERYTHING else is "asked but could not judge": the store's own
 * CHAIN_UNAVAILABLE / CHAIN_MISCONFIGURED / RPC_AUTH_REJECTED / INTERNAL_ERROR, its RATE_LIMITED
 * and QUOTA_EXCEEDED limiters, WRITE_DENIED (a staged deny can still be cancelled),
 * EPOCH_ROTATION_REQUIRED, an HTML error page at ANY status (StoreHttpError's STORE_UNREACHABLE
 * on a 403/404/429/5xx alike — the allowlist is what makes a bare error page non-final), and an
 * error that never carried a code at all. Non-final answers wait for the next pass unspent —
 * the retry cap is spent only on EPOCH_STALE, the very condition being resubmitted.
 */
const RESUBMIT_FINAL = new Set([
  "CAPABILITY_DENIED",
  "CAPABILITY_REVOKED",
  "CAPABILITY_EXPIRED",
  "NOT_AN_AGENT",
  "SIGNER_MISMATCH",
  "ALREADY_QUEUED",
])

export function keepPendingPlaintext(home: MidaHome, contextId: Hex, input: Record<string, unknown>): void {
  home.writeSecretJson(pendingPlaintextPath(contextId), input)
}

/** The kept createBatched input for one pending save — undefined when absent, corrupt, or shapeless. */
export function pendingPlaintext(home: MidaHome, contextId: Hex): Record<string, unknown> | undefined {
  try {
    const raw = home.readJson<Record<string, unknown>>(pendingPlaintextPath(contextId))
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) && raw.value !== undefined ? raw : undefined
  } catch {
    return undefined
  }
}

/** Drops the kept plaintext — its whole job is the window between queue and the chain's answer. */
export function dropPendingPlaintext(home: MidaHome, contextId: Hex): void {
  home.remove(pendingPlaintextPath(contextId))
}

/**
 * Housekeeping: a plaintext file whose contextId no pending entry names is an orphan — a crash
 * between the queue writes, or a leftover an older follow-up could not finish. Nothing in the
 * ledger can ever reference it again, and a plaintext checkpoint is never kept past its save.
 */
export function sweepPendingPlaintexts(home: MidaHome): number {
  const ids = new Set(pendingAnchors(home).map((entry) => entry.contextId.toLowerCase()))
  let swept = 0
  for (const name of home.list(PENDING_PLAINTEXT_DIR)) {
    if (!name.endsWith(".json")) continue
    const id = name.slice(0, -".json".length).toLowerCase()
    if (!ids.has(id)) {
      home.remove(`${PENDING_PLAINTEXT_DIR}/${name}`)
      swept += 1
    }
  }
  return swept
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
  return apiClient(baseUrl, deployment, privateKeyToAccount(identity.signerPrivateKey), undefined, home)
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
 * What a stale-epoch resubmission came back with. `requeued` — the save is queued again under a
 * fresh contextId; `retry-later` — nothing final happened, the entry waits for the next pass;
 * `refused` — the save is dead: its author lost authority, its plaintext is gone or unreadable,
 * or the resubmission itself was refused outright.
 */
type ResubmitOutcome = "requeued" | "retry-later" | "refused"

/**
 * Re-seals a BAD_EPOCH/EPOCH_STALE save under the current epoch and POSTs it again (in-2 I3).
 * The contract checks authority before epoch, so the stale answer itself proves a grant was
 * live at submit — but the owner's revoke may have landed since, so the chain is asked again:
 * no live CREATE grant, no local identity, a revoked marker or no readable plaintext all mean
 * the save is refused, never retried. A successful re-queue moves the pending entry, its kept
 * plaintext and the saved-id index onto the fresh contextId — the resubmission carries a new
 * random nonce, so the old id stays rejected at the store and only the new one is followed.
 */
async function resubmitStaleEpoch(
  runtime: ServiceRuntime,
  entry: PendingAnchor,
  reason: string,
  log: (record: Record<string, unknown>) => void,
): Promise<ResubmitOutcome> {
  const home = runtime.home
  const identity = loadAgentIdentity(home, entry.agent)
  if (identity === undefined || isRevoked(home, entry.agent)) return "refused"
  const input = pendingPlaintext(home, entry.contextId)
  if (input === undefined) return "refused"
  try {
    const allowed = await runtime.reader.hasAuthority(
      runtime.owner,
      identity.agentId,
      namespaceId(NAMESPACE),
      PERMISSION.CREATE,
      PROVENANCE_POLICY.ALLOW_INFERENCE,
    )
    if (!allowed) return "refused"
  } catch {
    // authority unknown is never a final answer — the next pass asks again
    return "retry-later"
  }
  const retries = (entry.retries ?? 0) + 1
  // The try covers the POST alone: only an answer from the store may classify the outcome —
  // a local ledger write failing (an fs error, whose .code is a string too) must throw through
  // to the pass rather than masquerade as a store refusal.
  const requeue = () => runtime.agent(entry.agent).createBatched(runtime.owner, NAMESPACE, input as unknown as CreateContextInput)
  let queued: Awaited<ReturnType<typeof requeue>>
  try {
    queued = await requeue()
  } catch (error) {
    // The allowlist (in-12 N-3): only a code in RESUBMIT_FINAL is the store judging the save —
    // before it, "any string code but EPOCH_STALE" was final, so a Cloudflare error page's
    // STORE_UNREACHABLE or the store's own RATE_LIMITED deleted the kept plaintext. Every other
    // outcome — a bare StoreHttpError at any status, a code that means "could not judge", a
    // code this build does not know at all, a thrown value carrying no code — waits unspent.
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && RESUBMIT_FINAL.has(code)) return "refused"
    if (code === "EPOCH_STALE") {
      // the very condition being retried answering the resubmission itself — one spent
      setPendingAnchorRetries(home, entry.contextId, retries)
      return retries >= MAX_EPOCH_RETRIES ? "refused" : "retry-later"
    }
    return "retry-later"
  }
  // Entry first: a crash after the POST leaves the new save untracked — it still anchors —
  // rather than the stale id retrying again and queueing a second copy of the checkpoint.
  removePendingAnchor(home, entry.contextId)
  dropPendingPlaintext(home, entry.contextId)
  keepPendingPlaintext(home, queued.contextId, input)
  addPendingAnchor(home, {
    contextId: queued.contextId,
    eventId: entry.eventId,
    sessionId: entry.sessionId,
    agent: entry.agent,
    queuedAt: new Date().toISOString(),
    retries,
  })
  recordSavedId(home, entry.eventId, queued.contextId)
  log({
    sessionId: entry.sessionId,
    agent: entry.agent,
    eventId: entry.eventId,
    outcome: "requeued",
    lane: "batched",
    contextId: queued.contextId,
    previousContextId: entry.contextId,
    reason: `batch-rejected:${reason}`,
    attempts: retries,
  })
  return "requeued"
}

/**
 * The ledger's follow-up, run at the end of every drain pass: asks the store where each
 * queued/submitted save stands. ANCHORED is the only moment a batched save may be logged "saved";
 * REJECTED for a stale epoch is re-sealed and resubmitted (up to MAX_EPOCH_RETRIES, only while
 * the author still holds CREATE); every other REJECTED moves it to the rejected ledger and logs
 * the contract's reason; anything else keeps it waiting — and a status error leaves the entry
 * exactly as it was, never dropped and never logged as final.
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
      dropPendingPlaintext(runtime.home, entry.contextId)
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
      const retried =
        EPOCH_RETRYABLE.has(reason) &&
        (entry.retries ?? 0) < MAX_EPOCH_RETRIES &&
        (await resubmitStaleEpoch(runtime, entry, reason, log))
      if (retried === "requeued" || retried === "retry-later") {
        counts.waiting += 1
        continue
      }
      dropPendingPlaintext(runtime.home, entry.contextId)
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
