import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { CONTEXT_KIND, MAX_PAYLOAD_BYTES, PERMISSION, PROVENANCE_POLICY, canonicalizeNamespace, isMidaError, namespaceId } from "@mida/protocol"
import type { ContextKind, Hex, RecordReference } from "@mida/protocol"
import type { CreateContextInput } from "@mida/sdk"
import { RESUBMIT_LANE_CLOSED, addPendingAnchor, keepPendingPlaintext, laneForSave } from "./batching.js"
import type { Lane } from "./batching.js"
import { chainRefusalReason } from "./chain-busy.js"
import { capabilityState, projectCheckRefusal } from "./handoff.js"
import type { CapabilityState } from "./handoff.js"
import { CHAIN_REFUSAL_TEXT } from "./hook-output.js"
import { isRevoked, loadAgentIdentity, revokePending } from "./keys.js"
import type { AgentIdentity, RevokePendingMarker } from "./keys.js"
import { checkProject } from "./projects.js"
import type { ProjectCheck } from "./projects.js"
import { isSafeName } from "./queue.js"
import { NAMESPACE } from "./runtime.js"
import type { MidaHome } from "./home.js"
import type { ServiceRuntime } from "./runtime.js"

/**
 * The daemon's POST /remember — the SDK's one write. Same security boundary as /save: the
 * caller sends a namespace and content; everything identity-bearing (author, source, chain
 * fields) is stamped here. Gates run in the order the owner set — safe name, shape, identity
 * on disk, the owner-signed folder list when the write lands in `projects.current`, the chain's
 * own verdict on the grant (CREATE for a new record, SUPERSEDE_OWN/ANY for `supersedes`), the
 * local revoke markers, then the per-lane rate window — before the write reaches the same
 * direct/batched lanes checkpoint saves take.
 *
 * A batched write joins the pending ledger (`state/batch-pending.json`) with its kept plaintext
 * exactly as a batched checkpoint does, and carries its namespace so a stale-epoch resubmit
 * re-seals under the right area — the checkpoint path hardcodes `projects.current`.
 */

/** Accepted `remember` writes per agent per minute, by save lane — the only place the numbers live. */
export const REMEMBER_LIMITS: Readonly<Record<"direct" | "batched", number>> = { direct: 1, batched: 60 }
const REMEMBER_WINDOW_MS = 60_000

const HEX_ID = /^0x[0-9a-fA-F]{64}$/
const REFERENCE_RELATIONS = new Set(["supports", "derived_from", "confirmed_from"])
const TOP_KEYS = new Set(["agent", "cwd", "namespace", "content", "kind", "references", "supersedes"])

export type RememberSaveResult =
  | { kind: "saved"; id: Hex; state: "anchored" | "pending"; lane: "direct" | "batched" }
  | {
      kind: "refused"
      reason: string
      text: string
      lane?: "direct" | "batched"
      nextAllowedAt?: string
      /** Leading field names the validator flagged — names only, never values. */
      fields?: string[]
    }

export interface RememberDeps {
  /** Identity lookup; default loadAgentIdentity — tests inject. */
  loadIdentity?: (home: MidaHome, name: string) => AgentIdentity | undefined
  /** The owner-signed folder check — consulted only for `projects.current`; tests inject. */
  checkProject?: (runtime: ServiceRuntime, input: { agent: string; cwd: string }) => Promise<ProjectCheck>
  /** The chain-capability verdict for distinguishing "revoked" from "never had it". */
  capability?: (runtime: ServiceRuntime, agent: string) => Promise<CapabilityState>
  /** The chain's CapabilityRegistry for one namespace + permission + provenance tuple. */
  hasAuthority?: (agentId: Hex, namespaceId: Hex, permission: number, provenancePolicy: number) => Promise<boolean>
  /** The revoke marker `mida revoke` leaves; default isRevoked. */
  isRevoked?: (name: string) => boolean
  /** The staged store deny of a revoke still in flight; default revokePending. */
  revokePending?: (name: string) => RevokePendingMarker | undefined
  /** The lane decision for a create; default laneForSave — supersede always writes directly. */
  lane?: (runtime: ServiceRuntime, agent: string) => Promise<Lane>
  /** The direct write; default the agent's own `create`. */
  create?: (runtime: ServiceRuntime, agent: string, namespace: string, input: CreateContextInput) => Promise<{ contextId: Hex }>
  /** The batched write; default the agent's own `createBatched`. */
  createBatched?: (runtime: ServiceRuntime, agent: string, namespace: string, input: CreateContextInput) => Promise<{ contextId: Hex }>
  /** The supersede write; default the agent's own `supersede` — the chain refuses a foreign lineage. */
  supersede?: (runtime: ServiceRuntime, agent: string, parentId: Hex, input: CreateContextInput) => Promise<{ contextId: Hex }>
  /** Wall clock for the rate window; default Date.now. */
  now?: () => number
  /** The admitted-write timestamps per lane+agent — the daemon owns one map for the process. */
  admittedSaves?: Map<string, number[]>
}

const refused = (
  reason: string,
  text: string,
  extra: Partial<Extract<RememberSaveResult, { kind: "refused" }>> = {},
): RememberSaveResult => ({ kind: "refused", reason, text, ...extra })

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

const BAD_INPUT = "Mida: the remember call was malformed — nothing was written."
const notApprovedText = (agent: string): string =>
  `Mida: ${agent} is not approved to write to this area — run \`mida approve ${agent}\`. Nothing was written.`
const supersedeDeniedText = (agent: string): string =>
  `Mida: ${agent} holds no grant to supersede records in this area — supersede works on this agent's own lineage only. Nothing was written.`
const readOnlyText = (agent: string): string =>
  `Mida: ${agent} can read but not write here — run \`mida request ${agent}\` and \`mida approve ${agent}\` to add write access. Nothing was written.`
const revokedText = (agent: string): string => `Mida: ${agent}'s access was revoked by the owner. Nothing was written.`
const revokePendingText = (agent: string): string => `Mida: a revoke of ${agent} is still landing — nothing was written. Try again shortly.`
const noIdentityText = (agent: string, homeRoot: string): string =>
  `Mida: no agent "${agent}" is set up in this Mida home (${homeRoot}). Nothing was written.`
const identityUnreadableText = (agent: string, homeRoot: string): string =>
  `Mida: ${agent}'s identity in this Mida home (${homeRoot}) exists but could not be read. Nothing was written. Run \`mida doctor\`.`

/**
 * Handles one POST /remember body. Every check decides locally here so the SDK transport stays
 * a pipe; a refusal is a result, never a throw — a write that fails for a reason the codes do
 * not name still propagates to the daemon's 500 rather than posing as an answerable refusal.
 */
export async function buildRemember(runtime: ServiceRuntime, record: unknown, deps: RememberDeps = {}): Promise<RememberSaveResult> {
  const now = deps.now ?? Date.now
  const admittedSaves = deps.admittedSaves ?? new Map<string, number[]>()
  const isRevokedDep = deps.isRevoked ?? ((name: string) => isRevoked(runtime.home, name))
  const revokePendingDep = deps.revokePending ?? ((name: string) => revokePending(runtime.home, name))
  const check = deps.checkProject ?? checkProject
  const capability = deps.capability ?? capabilityState
  const decideLane = deps.lane ?? laneForSave
  const create = deps.create ?? ((rt: ServiceRuntime, agent: string, namespace: string, input: CreateContextInput) => rt.agent(agent).create(rt.owner, namespace, input))
  const createBatched =
    deps.createBatched ?? ((rt: ServiceRuntime, agent: string, namespace: string, input: CreateContextInput) => rt.agent(agent).createBatched(rt.owner, namespace, input))
  const supersede =
    deps.supersede ?? ((rt: ServiceRuntime, agent: string, parentId: Hex, input: CreateContextInput) => rt.agent(agent).supersede(rt.owner, parentId, input))

  if (!isObj(record)) return refused("bad-input", BAD_INPUT)
  const agent = typeof record.agent === "string" ? record.agent : ""
  // the name is interpolated into refusal text — only after it is proven a safe local agent name
  if (!isSafeName(agent)) return refused("bad-agent", "Mida: bad agent name — nothing was written.")
  const extraTop = Object.keys(record).filter((key) => !TOP_KEYS.has(key))
  if (extraTop.length > 0) {
    return refused("bad-input", `Mida: bad remember input (${extraTop.join(", ")}) — nothing was written.`, { fields: extraTop })
  }

  // The area is required and must be one the protocol tree knows — there is no `auto`.
  if (typeof record.namespace !== "string" || record.namespace === "") return refused("bad-input", BAD_INPUT)
  let namespace: string
  try {
    namespace = canonicalizeNamespace(record.namespace)
  } catch {
    return refused("invalid-namespace", `Mida: "${record.namespace}" is not a context area Mida knows — nothing was written.`)
  }
  const nsId = namespaceId(namespace)

  // Content is the record's whole value: a string or a plain object, small enough to seal.
  const content = record.content
  if (typeof content !== "string" && !isObj(content)) return refused("bad-input", BAD_INPUT)
  const contentSize = Buffer.byteLength(typeof content === "string" ? content : JSON.stringify(content), "utf8")
  if (contentSize > MAX_PAYLOAD_BYTES) {
    return refused("too-large", `Mida: the content is ${contentSize} bytes — a record holds at most ${MAX_PAYLOAD_BYTES}. Nothing was written.`)
  }

  // kind is optional (default INFERENCE); references are {relation, recordId} pairs; supersedes
  // is a record id of this agent's own lineage.
  let kind: Exclude<ContextKind, "NONE"> = "INFERENCE"
  if (record.kind !== undefined) {
    if (typeof record.kind !== "string" || !Object.hasOwn(CONTEXT_KIND, record.kind) || record.kind === "NONE") {
      return refused("invalid-shape", "Mida: `kind` must be a context kind (FACT, GOAL, DECISION, EPISODE, INFERENCE…) — nothing was written.")
    }
    kind = record.kind as Exclude<ContextKind, "NONE">
  }
  let references: RecordReference[] | undefined
  if (record.references !== undefined) {
    const list = record.references
    const valid =
      Array.isArray(list) &&
      list.every(
        (ref) =>
          isObj(ref) &&
          typeof ref.relation === "string" &&
          REFERENCE_RELATIONS.has(ref.relation) &&
          typeof ref.recordId === "string" &&
          HEX_ID.test(ref.recordId),
      )
    if (!valid) {
      return refused("invalid-shape", "Mida: `references` must be { relation, recordId } pairs — nothing was written.")
    }
    references = list as RecordReference[]
  }
  if (record.supersedes !== undefined && (typeof record.supersedes !== "string" || !HEX_ID.test(record.supersedes))) {
    return refused("invalid-shape", "Mida: `supersedes` must be a record id — a 32-byte hex string. Nothing was written.")
  }
  const supersedes = typeof record.supersedes === "string" ? (record.supersedes.toLowerCase() as Hex) : undefined

  // Identity — the absent-vs-unreadable distinction the other routes make, so EPERM never reads
  // as "not set up".
  let identity: AgentIdentity | undefined
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

  // The owner-signed folder list gates `projects.current` only — a fact namespace answers to the
  // chain grant alone.
  if (namespace === NAMESPACE) {
    const cwd = typeof record.cwd === "string" ? record.cwd : ""
    if (cwd === "" || !isAbsolute(cwd)) return refused("bad-input", BAD_INPUT)
    const project = await check(runtime, { agent, cwd })
    if (!project.ok) {
      const outcome = projectCheckRefusal(runtime, agent, project, isRevokedDep)
      return refused(outcome.reason, `${outcome.text} Nothing was written.`)
    }
  }

  // The chain's verdict on the grant this write needs: CREATE for a new record, SUPERSEDE_OWN or
  // SUPERSEDE_ANY for a supersede — the same tuple the contract itself requires. A chain that
  // cannot answer names its real reason, never "not-approved".
  const askAuthority =
    deps.hasAuthority ??
    ((agentId: Hex, ns: Hex, permission: number, policy: number) =>
      runtime.reader.hasAuthority(runtime.owner, agentId, ns, permission, policy))
  const permissions = supersedes === undefined ? [PERMISSION.CREATE] : [PERMISSION.SUPERSEDE_OWN, PERMISSION.SUPERSEDE_ANY]
  let allowed = false
  try {
    for (const permission of permissions) {
      if (await askAuthority(identity.agentId, nsId, permission, PROVENANCE_POLICY.ALLOW_INFERENCE)) {
        allowed = true
        break
      }
    }
  } catch (error) {
    const chainReason = chainRefusalReason(error)
    if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
    return refused("check-failed", `Mida: the grant check could not be completed — nothing was written.`)
  }
  if (!allowed) {
    if (isRevokedDep(agent)) return refused("revoked", revokedText(agent))
    let state: CapabilityState
    try {
      state = await capability(runtime, agent)
    } catch (error) {
      const chainReason = chainRefusalReason(error)
      if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
      throw error
    }
    if (state === "revoked") return refused("revoked", revokedText(agent))
    if (supersedes !== undefined) return refused("not-approved", supersedeDeniedText(agent))
    try {
      if (await askAuthority(identity.agentId, nsId, PERMISSION.READ, 0)) {
        return refused("read-only", readOnlyText(agent))
      }
    } catch (error) {
      const chainReason = chainRefusalReason(error)
      if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
      return refused("check-failed", `Mida: the grant check could not be completed — nothing was written.`)
    }
    return refused("not-approved", notApprovedText(agent))
  }

  // The local markers the chain cannot see — a landed revoke and a revoke whose store deny is
  // still in flight both stop the write before a signature is attempted.
  if (isRevokedDep(agent)) return refused("revoked", revokedText(agent))
  if (revokePendingDep(agent) !== undefined) return refused("revoke-pending", revokePendingText(agent))

  // The lane a create takes is decided fresh (supersede is always its own transaction — the
  // batch wire has no parent field); a failed decision still means a direct write, never a drop.
  let laneKind: "direct" | "batched" = "direct"
  let batchedLane: Extract<Lane, { kind: "batched" }> | undefined
  if (supersedes === undefined) {
    let lane: Lane
    try {
      lane = await decideLane(runtime, agent)
    } catch {
      lane = { kind: "direct", why: "switch-off" }
    }
    if (lane.kind === "batched") {
      laneKind = "batched"
      batchedLane = lane
    }
  }

  // The rate window — service-side (this daemon's map), per agent per lane, so two SDK clients
  // writing as one agent share the same minute. Checked after every gate so a refused call never
  // consumes a slot, and reserved before the send so a second call during a slow write still
  // refuses. A write that never landed frees its slot.
  let slot = `${laneKind}\n${agent}`
  let reservation = 0
  const admit = (lane: "direct" | "batched"): RememberSaveResult | null => {
    const key = `${lane}\n${agent}`
    const admitted = (admittedSaves.get(key) ?? []).filter((stamp) => now() - stamp < REMEMBER_WINDOW_MS)
    const limit = REMEMBER_LIMITS[lane]
    if (admitted.length >= limit) {
      const nextAllowedAt = new Date(admitted[0]! + REMEMBER_WINDOW_MS).toISOString()
      const seconds = Math.ceil((admitted[0]! + REMEMBER_WINDOW_MS - now()) / 1000)
      return refused(
        "rate-limited",
        `Mida: ${agent} may write ${limit} record${limit === 1 ? "" : "s"} per minute on the ${lane} lane — the next write is allowed in ${seconds} s (at ${nextAllowedAt}). Nothing was written.`,
        { lane, nextAllowedAt },
      )
    }
    slot = key
    // one reservation = one stamp, unique in the window: two calls admitted inside the same
    // millisecond must never share it, or releasing one would free them both (in-22 V-5)
    let stamp = now()
    while (admitted.includes(stamp)) stamp += 1
    reservation = stamp
    admitted.push(stamp)
    admittedSaves.set(key, admitted)
    return null
  }
  const release = () => {
    const stamps = admittedSaves.get(slot) ?? []
    const idx = stamps.indexOf(reservation)
    // splice exactly this call's reservation — never every stamp that happens to equal it
    if (idx !== -1) stamps.splice(idx, 1)
    admittedSaves.set(slot, stamps)
  }
  const tooSoon = admit(laneKind)
  if (tooSoon !== null) return tooSoon

  const input: CreateContextInput = {
    value: content,
    kind,
    source: "AGENT_INFERRED",
    ...(references === undefined ? {} : { references }),
    // the save's own identity for dedup — the pending ledger's eventId slot holds the record id
    tags: [`sdk-remember`],
  }

  try {
    if (supersedes !== undefined) {
      const written = await supersede(runtime, agent, supersedes, input)
      return { kind: "saved", id: written.contextId, state: "anchored", lane: "direct" }
    }
    if (laneKind === "batched") {
      let queued: { contextId: Hex } | undefined
      try {
        queued = await createBatched(runtime, agent, namespace, input)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === "ALREADY_QUEUED") {
          const held = (error as { contextId?: unknown }).contextId
          if (typeof held !== "string" || !HEX_ID.test(held)) throw error
          queued = { contextId: held.toLowerCase() as Hex }
        } else if (typeof code === "string" && RESUBMIT_LANE_CLOSED.has(code)) {
          // in-20 T-1: the lane closed between the decision and the POST — the answer judges the
          // lane, not the note, so the write falls through to the direct create below.
          // in-21 U-2: that fall-through IS a direct write — release the batched reservation
          // and admit against the direct lane's own window before anything is sent.
          release()
          const directTooSoon = admit("direct")
          if (directTooSoon !== null) return directTooSoon
        } else {
          throw error
        }
      }
      if (queued !== undefined) {
        keepPendingPlaintext(runtime.home, queued.contextId, input as unknown as Record<string, unknown>)
        addPendingAnchor(runtime.home, {
          contextId: queued.contextId,
          eventId: queued.contextId,
          sessionId: `sdk-${agent}`,
          agent,
          queuedAt: new Date(now()).toISOString(),
          namespace,
        })
        return { kind: "saved", id: queued.contextId, state: "pending", lane: "batched" }
      }
    }
    const written = await create(runtime, agent, namespace, input)
    return { kind: "saved", id: written.contextId, state: "anchored", lane: "direct" }
  } catch (error) {
    // a write that never landed frees the slot — the next call gets a real answer, not a stale hold
    release()
    if (isMidaError(error, "CAPABILITY_REVOKED")) return refused("revoked", revokedText(agent))
    if (isMidaError(error, "WRITE_DENIED")) return refused("revoke-pending", revokePendingText(agent))
    if (isMidaError(error, "CAPABILITY_DENIED")) {
      return isRevokedDep(agent)
        ? refused("revoked", revokedText(agent))
        : refused("not-approved", supersedes === undefined ? notApprovedText(agent) : supersedeDeniedText(agent))
    }
    if (isMidaError(error, "NOT_FOUND")) {
      return refused("not-found", "Mida: the record named by `supersedes` does not exist here — nothing was written.")
    }
    if (isMidaError(error, "ANCHOR_OWNER_ONLY")) {
      return refused("not-approved", "Mida: only the owner may supersede an owner-controlled lineage — nothing was written.")
    }
    if (isMidaError(error, "PARTIAL_READ")) {
      return refused("check-failed", "Mida: the grant check could not be completed — nothing was written.")
    }
    if ((error as { code?: unknown }).code === "agent-not-setup") {
      return refused("no-identity", noIdentityText(agent, runtime.home.root))
    }
    // a send or read that died on a chain that could not answer is a refusal, not "not-approved"
    const chainReason = chainRefusalReason(error)
    if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
    if (isMidaError(error)) {
      return refused(error.code.toLowerCase().replaceAll("_", "-"), `Mida: the write could not be completed (${error.code}) — nothing was written.`)
    }
    throw error
  }
}
