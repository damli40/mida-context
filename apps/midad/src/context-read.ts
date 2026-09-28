import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { zeroHash } from "viem"
import { canonicalizeNamespace, isMidaError, namespaceId } from "@mida/protocol"
import type { ContextKind, Hex, RecordReference } from "@mida/protocol"
import { batchAnchorAbi, recordPlacementsNear } from "@mida/chain"
import type { RecordPlacement } from "@mida/chain"
import { compareChainOrder, orderTime, taskOf } from "@mida/checkpoint"
import type { MigrationEnvelope, StoredCheckpoint } from "@mida/checkpoint"
import type { ContextObject } from "@mida/sdk"
import { batchClient, batchStatusProbe } from "./batching.js"
import { chainRefusalReason } from "./chain-busy.js"
import { unwrapCheckpoint } from "./checkpoint-payload.js"
import { CHAIN_REFUSAL_TEXT } from "./hook-output.js"
import {
  capabilityState,
  generalAssistanceText,
  identityUnreadableText,
  isGeneralAssistant,
  noContextText,
  noIdentityText,
  projectCheckRefusal,
} from "./handoff.js"
import type { CapabilityState } from "./handoff.js"
import { isRevoked, loadAgentIdentity } from "./keys.js"
import { checkProject } from "./projects.js"
import { isSafeName } from "./queue.js"
import { authorNamesFor } from "./skeleton.js"
import { NAMESPACE } from "./runtime.js"
import type { ServiceRuntime } from "./runtime.js"

/**
 * The /context route's daemon half: one scoped read over the agent's verified read path
 * (`readWithStatus` merged with the batch table, exactly the lanes `readCheckpoints` combines),
 * gated the way `checkAccess` gates a handoff — safe name, identity on disk, the owner-signed
 * project list when the read touches `projects.current`, then the chain's own capability verdict
 * and the local revoke marker. A refused read returns `{ kind: "refused" }` with the same reason
 * vocabulary the other routes use, so the SDK maps it onto the same typed codes.
 *
 * The result is raw records rendered as `ContextItem`s — the handoff's checkpoint-only envelope
 * filter narrows to "records of another project stay out", superseded records drop to their
 * newest lineage head, and ordering is the handoff's own chain-time rule (`compareChainOrder`)
 * over the same effective instant, newest first. A pending batched save is shown marked
 * `pending` — never counted as anchored — stamped with the store's own `receivedAt`, the only
 * honest "when" it has.
 */

export interface ContextItemWire {
  id: Hex
  namespace: string
  kind: ContextKind
  content: string | Record<string, unknown>
  author: { name: string | null; id: Hex }
  source: string
  writtenAt: string
  state: "anchored" | "pending"
  superseded: false
  references: RecordReference[]
  proof: { manifestHash: Hex; recordId: Hex }
  /**
   * Checkpoint records only: the named task the sealed envelope belongs to — "main" when it
   * names none. context() is task-agnostic and serves every task's records together, so the
   * item must name which thread it came from rather than let tasks blur silently (in-18 S2).
   * Absent on every non-checkpoint record.
   */
  task?: string
}

export type ContextReadResult =
  | { kind: "context"; items: ContextItemWire[]; cursor: string | null; overLimit?: true; partial?: true }
  | { kind: "refused"; reason: string; text: string }

/** A verified object plus the fields the batched lane alone carries: the pending mark and stamp. */
export type ReadObject = ContextObject & { anchor?: "PENDING_ANCHOR"; receivedAt?: number }

export interface NamespaceRead {
  objects: ReadObject[]
  partial: boolean
  skipped: number
}

export interface ContextReadDeps {
  loadIdentity?: typeof loadAgentIdentity
  checkProject?: typeof checkProject
  capability?: (runtime: ServiceRuntime, agent: string) => Promise<CapabilityState>
  isRevoked?: (name: string) => boolean
  /** One namespace's merged read (direct lane + batch table); tests inject a fake list. */
  read?: (runtime: ServiceRuntime, agent: string, namespace: string) => Promise<NamespaceRead>
  authorNames?: (runtime: ServiceRuntime) => Record<string, string>
}

const refused = (reason: string, text: string): ContextReadResult => ({ kind: "refused", reason, text })

const BAD_INPUT = "Mida: the context read was malformed — nothing was read."

/** How long a read waits for a foreign-agent pending save to anchor after asking for the flush. */
const FLUSH_WAIT_MS = 3_000
const FLUSH_POLL_MS = 250

/**
 * The merge `readCheckpoints` runs on `projects.current`, lifted to whatever namespace the call
 * names: the direct lane's verified read plus — when this deployment anchors batches — the batch
 * table's anchored and verified-pending rows, pending saves from OTHER agents flushed once and
 * awaited briefly, a route-less store answered by the contract's own hasBatchedSaves flag rather
 * than believed empty, and the same-second tie scan that places the members of a cross-lane
 * second together. Everything the store claims is verified inside the SDK calls; nothing here
 * trusts a row's filed shape over what Monad recorded.
 */
async function readNamespaceObjects(
  runtime: ServiceRuntime,
  name: string,
  namespace: string,
  options?: { flushWaitMs?: number },
): Promise<NamespaceRead> {
  const agent = runtime.agent(name)
  const { objects, partial: directPartial } = await agent.readWithStatus(runtime.owner, namespace)
  let partial = directPartial
  let skipped = 0
  const merged: ReadObject[] = [...objects]
  const deployment = runtime.network?.deployment
  const batchAnchor = deployment?.batchAnchor
  let mergedBatched = false
  if (batchAnchor !== undefined && deployment !== undefined) {
    const status = await batchStatusProbe(runtime.apiBaseUrl)
    if (status !== null && status.batchAnchor.toLowerCase() === batchAnchor.toLowerCase()) {
      const readBatched = async () => {
        try {
          return await agent.readBatchedWithStatus(runtime.owner, namespace)
        } catch {
          return null
        }
      }
      let batched = await readBatched()
      if (batched === null) {
        partial = true
      } else {
        let myAgentId: Hex | undefined
        try {
          myAgentId = loadAgentIdentity(runtime.home, name)?.agentId
        } catch {
          myAgentId = undefined
        }
        const foreign = batched.pending.filter(
          (item) => myAgentId === undefined || item.authorAgentId.toLowerCase() !== myAgentId.toLowerCase(),
        )
        if (foreign.length > 0) {
          const client = batchClient(runtime.home, runtime.apiBaseUrl, deployment, name)
          await client?.flushBatch().catch(() => undefined)
          const waiting = new Set(foreign.map((item) => item.contextId))
          const deadline = Date.now() + (options?.flushWaitMs ?? FLUSH_WAIT_MS)
          while (Date.now() < deadline && batched.pending.some((item) => waiting.has(item.contextId))) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(FLUSH_POLL_MS, deadline - Date.now())))
            const again = await readBatched()
            if (again !== null) batched = again
          }
        }
        skipped += batched.skipped.length
        if (batched.partial) partial = true
        const directCount = merged.length
        merged.push(...batched.anchored)
        merged.push(...batched.pending)
        mergedBatched = merged.length > directCount
      }
    } else {
      try {
        const has = (await runtime.chain.publicClient.readContract({
          address: batchAnchor,
          abi: batchAnchorAbi,
          functionName: "hasBatchedSaves",
          args: [runtime.owner],
        } as never)) as boolean
        if (has) partial = true
      } catch {
        partial = true
      }
    }
  }
  // The same-second tie scan readCheckpoints runs: a second shared across the two lanes needs
  // every member's chain placement before the sort can be trusted — re-scan once, bounded, and a
  // second it cannot fully place keeps no member's placement at all.
  if (mergedBatched && deployment !== undefined) {
    const bySecond = new Map<bigint, ReadObject[]>()
    for (const object of merged) {
      if (object.chain === undefined) continue
      const list = bySecond.get(object.chain.at)
      if (list === undefined) bySecond.set(object.chain.at, [object])
      else list.push(object)
    }
    const tied = new Map<bigint, Hex[]>()
    for (const [second, members] of bySecond) {
      if (members.length < 2) continue
      const needsScan = members.some((object, i) =>
        members.slice(i + 1).some((other) => {
          const a = object.chain!
          const b = other.chain!
          if (a.block === undefined || b.block === undefined) return true
          if (a.block !== b.block) return false
          if (a.transaction !== undefined && b.transaction !== undefined) return false
          return !(
            a.batchId !== undefined &&
            b.batchId !== undefined &&
            a.batchId.toLowerCase() === b.batchId.toLowerCase() &&
            a.index !== undefined &&
            b.index !== undefined
          )
        }),
      )
      if (needsScan) tied.set(second, members.map((object) => object.contextId))
    }
    if (tied.size > 0) {
      const placements = await recordPlacementsNear({
        client: runtime.chain.publicClient,
        deployment,
        owner: runtime.owner,
        namespaceId: namespaceId(namespace),
        tied,
      }).catch(() => new Map<string, RecordPlacement>())
      for (const second of tied.keys()) {
        const members = bySecond.get(second)!
        const complete = members.every((object) => placements.has(object.contextId.toLowerCase()))
        for (const object of members) {
          const placement = complete ? placements.get(object.contextId.toLowerCase()) : undefined
          object.chain =
            placement === undefined
              ? { at: object.chain!.at }
              : {
                  at: object.chain!.at,
                  block: placement.block,
                  ...(placement.transaction === undefined ? {} : { transaction: placement.transaction }),
                  index: placement.index,
                  ...(object.chain!.batchId === undefined ? {} : { batchId: object.chain!.batchId }),
                }
        }
      }
    }
  }
  return { objects: merged, partial, skipped }
}

/**
 * The effective stamp one record orders and reports by — the handoff's `orderTime` rule applied
 * to a generic record through a StoredCheckpoint-shaped adapter: the chain's placement stamp
 * wins; a moved record's envelope may only AGE it; a pending save's store receivedAt is the only
 * "when" it honestly has (it is the fallback claim — no chain fact places it).
 */
const orderAdapter = (object: ReadObject): StoredCheckpoint => ({
  contextId: object.contextId,
  authorId: object.authorId,
  namespaceId: object.namespaceId,
  // `createdAt` is the writer-claim field the comparator only reads when NO chain stamp exists —
  // for a pending batched row that is the store's receivedAt, not a payload claim.
  checkpoint: { createdAt: new Date(object.receivedAt ?? 0).toISOString() } as StoredCheckpoint["checkpoint"],
  projectId: "",
  sessionId: "",
  continuesSession: null,
  compiledBy: "",
  ...(object.chain === undefined ? {} : { chain: object.chain }),
  ...(migrationOf(object) === undefined ? {} : { migration: migrationOf(object) }),
})

/** A record's migration envelope — beside a string value, inside an object value. */
function migrationOf(object: ReadObject): MigrationEnvelope | undefined {
  if (object.payload.migration !== undefined) return object.payload.migration as MigrationEnvelope
  const value = object.payload.value
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return (value as { migration?: MigrationEnvelope }).migration
  }
  return undefined
}

const contentBytes = (value: string | Record<string, unknown>): number =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")

/**
 * The /context body → the routed answer. The caller supplies `agent`, the `cwd` the read runs
 * from, one of `namespace`/`namespaces`, a byte `limit` for the page's content, and optional
 * `since` (ISO, strictly newer) and `cursor` (the last returned item's id — the next page resumes
 * strictly after it in the same chain order).
 */
export async function buildContextRead(
  runtime: ServiceRuntime,
  record: unknown,
  deps: ContextReadDeps = {},
): Promise<ContextReadResult> {
  const body = (typeof record === "object" && record !== null ? record : {}) as Record<string, unknown>
  const agent = typeof body.agent === "string" ? body.agent : ""
  if (!isSafeName(agent)) return refused("bad-agent", "Mida: that is not a valid agent name — nothing was read.")

  // Exactly one of `namespace` / `namespaces`; every name must be one the protocol tree knows.
  if (body.namespace !== undefined && body.namespaces !== undefined) return refused("bad-input", BAD_INPUT)
  const raw: unknown[] =
    typeof body.namespace === "string" ? [body.namespace] : Array.isArray(body.namespaces) ? body.namespaces : []
  if (raw.length === 0) return refused("bad-input", BAD_INPUT)
  const namespaces: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") return refused("bad-input", BAD_INPUT)
    try {
      const canonical = canonicalizeNamespace(entry)
      if (!namespaces.includes(canonical)) namespaces.push(canonical)
    } catch {
      return refused("invalid-namespace", `Mida: "${entry}" is not a context area Mida knows — nothing was read.`)
    }
  }

  // limit is BYTES of content — positive, finite; since parses or the read refuses; the cursor
  // must resolve inside this read's own ordering (a stale or foreign cursor is bad input, not a
  // silent restart).
  const limit = body.limit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return refused("bad-input", BAD_INPUT)
  let sinceMs: number | undefined
  if (body.since !== undefined) {
    if (typeof body.since !== "string") return refused("bad-input", BAD_INPUT)
    sinceMs = Date.parse(body.since)
    if (!Number.isFinite(sinceMs)) return refused("bad-input", BAD_INPUT)
  }
  const cursor = body.cursor
  if (cursor !== undefined && typeof cursor !== "string") return refused("bad-input", BAD_INPUT)

  // identity — the same absent-vs-unreadable distinction checkAccess makes (a stat answers again
  // when the quiet load reported nothing, so EPERM never reads as "not set up").
  let identity: ReturnType<typeof loadAgentIdentity>
  try {
    identity = (deps.loadIdentity ?? loadAgentIdentity)(runtime.home, agent)
  } catch {
    identity = undefined
  }
  if (identity === undefined) {
    let absent = false
    try {
      statSync(runtime.home.path(`agents/${agent}/identity.json`))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      absent = code === "ENOENT" || code === "ENOTDIR"
    }
    return absent
      ? refused("no-identity", noIdentityText(agent, runtime.home.root))
      : refused("identity-unreadable", identityUnreadableText(agent, runtime.home.root))
  }

  // The owner-signed project list gates `projects.current` only — a fact namespace answers to the
  // chain grant alone and never needs a folder.
  let projectId: string | undefined
  if (namespaces.includes(NAMESPACE)) {
    const cwd = typeof body.cwd === "string" ? body.cwd : ""
    if (!isAbsolute(cwd)) return refused("bad-input", BAD_INPUT)
    const check = await (deps.checkProject ?? checkProject)(runtime, { agent, cwd })
    if (!check.ok) {
      const outcome = projectCheckRefusal(runtime, agent, check, deps.isRevoked)
      return refused(outcome.reason, outcome.text)
    }
    projectId = check.approval.projectId
  }

  // The chain's own verdict — a revoked agent is refused revoked, never an empty list; a
  // never-approved one gets the approve hint (or the general-assistance line when approve could
  // never help). The local marker answers again when the chain verdict is ambiguous.
  const markedRevoked = (() => {
    try {
      return (deps.isRevoked ?? ((name: string) => isRevoked(runtime.home, name)))(agent)
    } catch {
      return false
    }
  })()
  const state = await (deps.capability ?? capabilityState)(runtime, agent)
  if (state === "revoked" || (state === "none" && markedRevoked)) {
    return refused("revoked", `Mida: ${agent}'s access was revoked by the owner — nothing was read.`)
  }
  if (state !== "live") {
    if (isGeneralAssistant(runtime.home, agent)) return refused("general-assistance", generalAssistanceText(agent))
    return refused("not-approved", `Mida: ${agent} is not approved for this context — the owner approves with \`mida approve ${agent}\`.`)
  }

  // The reads — every namespace through the same verified path; a chain refusal names its real
  // reason, a capability denial on one area refuses the call (partial grants are not silent gaps).
  const objects: ReadObject[] = []
  let partial = false
  const readNamespace = deps.read ?? readNamespaceObjects
  for (const namespace of namespaces) {
    let outcome: NamespaceRead
    try {
      outcome = await readNamespace(runtime, agent, namespace)
    } catch (error) {
      if (isMidaError(error, "CAPABILITY_DENIED")) {
        return markedRevoked
          ? refused("revoked", `Mida: ${agent}'s access was revoked by the owner — nothing was read.`)
          : refused("not-approved", `Mida: ${agent} holds no grant covering "${namespace}" — the owner approves with \`mida approve ${agent}\`.`)
      }
      const chainReason = chainRefusalReason(error)
      if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
      if (isMidaError(error)) return refused(error.code.toLowerCase().replaceAll("_", "-"), noContextText(error.code))
      throw error
    }
    if (outcome.partial) partial = true
    objects.push(...outcome.objects)
  }

  // Lineage heads: an anchored record names its parent on-chain, so parents collected from
  // anchored children drop out — a pending row's claim hides nothing (it may still be rejected).
  const superseded = new Set<string>()
  for (const object of objects) {
    if (object.anchor === "PENDING_ANCHOR") continue
    if (object.parentId !== zeroHash) superseded.add(object.parentId.toLowerCase())
  }
  const heads = objects.filter((object) => {
    if (object.recordType !== "CONTEXT") return false
    if (object.anchor !== "PENDING_ANCHOR" && superseded.has(object.contextId.toLowerCase())) return false
    if (object.namespace === NAMESPACE && projectId !== undefined) {
      // records of another project stay out — the envelope is verified content, and its claim is
      // only consulted to EXCLUDE, never to include (the folder's own approval already gate-kept).
      const envelope = unwrapCheckpoint(object.payload.value)
      if (envelope !== null && envelope.projectId !== projectId) return false
    }
    return true
  })

  const stamped = heads.map((object) => ({ object, adapter: orderAdapter(object) }))
  stamped.sort((a, b) => compareChainOrder(b.adapter, a.adapter))
  let candidates = stamped
  if (sinceMs !== undefined) candidates = candidates.filter((entry) => orderTime(entry.adapter) > sinceMs)
  if (cursor !== undefined) {
    const at = candidates.findIndex((entry) => entry.object.contextId === cursor)
    if (at === -1) return refused("bad-input", "Mida: the cursor names no record in this read — nothing was read.")
    candidates = candidates.slice(at + 1)
  }

  const names = (deps.authorNames ?? authorNamesFor)(runtime)
  const items: ContextItemWire[] = []
  let nextCursor: string | null = null
  let overLimit = false
  let used = 0
  for (let i = 0; i < candidates.length; i += 1) {
    const entry = candidates[i]!
    const size = contentBytes(entry.object.payload.value)
    // A record bigger than the budget is returned alone, flagged — never hidden, never truncated.
    if (items.length === 0 && size > limit) {
      overLimit = true
      items.push(wireItem(entry.object, entry.adapter, names))
      nextCursor = i + 1 < candidates.length ? entry.object.contextId : null
      break
    }
    if (used + size > limit) {
      nextCursor = items[items.length - 1]!.id
      break
    }
    used += size
    items.push(wireItem(entry.object, entry.adapter, names))
  }

  return {
    kind: "context",
    items,
    cursor: nextCursor,
    ...(overLimit ? { overLimit: true as const } : {}),
    ...(partial ? { partial: true as const } : {}),
  }
}

/** One record on the wire — authorship and stamp from the verified object, never its payload. */
function wireItem(object: ReadObject, adapter: StoredCheckpoint, names: Record<string, string>): ContextItemWire {
  const envelope = unwrapCheckpoint(object.payload.value)
  return {
    id: object.contextId,
    namespace: object.namespace,
    kind: object.payload.kind,
    content: object.payload.value,
    author: { name: names[object.authorId.toLowerCase()] ?? null, id: object.authorId },
    source: object.payload.provenance.source,
    writtenAt: new Date(orderTime(adapter)).toISOString(),
    state: object.anchor === "PENDING_ANCHOR" ? "pending" : "anchored",
    superseded: false,
    references: object.payload.provenance.references ?? [],
    proof: { manifestHash: object.manifestHash ?? zeroHash, recordId: object.contextId },
    ...(envelope === null ? {} : { task: taskOf(envelope) }),
  }
}
