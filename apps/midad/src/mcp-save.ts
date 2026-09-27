import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { CONTENT_FIELDS, validateCheckpoint } from "@mida/checkpoint"
import type { Checkpoint } from "@mida/checkpoint"
import { scrubValue } from "@mida/compiler"
import { PERMISSION, PROVENANCE_POLICY, isMidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { chainRefusalReason } from "./chain-busy.js"
import { CheckpointPayloadError, fieldPathsFromErrors } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import { capabilityState, noContextText, projectCheckRefusal } from "./handoff.js"
import { CHAIN_REFUSAL_TEXT } from "./hook-output.js"
import type { CapabilityState } from "./handoff.js"
import { MCP_CLIENT_TOOLS } from "./install.js"
import { isRevoked, loadAgentIdentity, revokePending } from "./keys.js"
import type { AgentIdentity, RevokePendingMarker } from "./keys.js"
import { checkProject } from "./projects.js"
import type { ProjectCheck } from "./projects.js"
import { isSafeName } from "./queue.js"
import { isTaskName, TASK_RULE_TEXT } from "./task.js"
import { NAMESPACE_ID, saveCheckpoint } from "./skeleton.js"
import type { MidaHome } from "./home.js"
import type { ServiceRuntime } from "./runtime.js"

/**
 * The daemon's POST /save — the write half of the MCP adapter (in-5). The adapter itself holds no
 * keys and validates nothing; this route is the same security boundary the reads use. Gates run in
 * the order the owner set: the name is a registered MCP client identity, the folder is approved for
 * it (the same owner-signed list `read` consults), the chain grant carries CREATE on the project
 * area, and the identity is neither revoked nor mid-revoke. Only then does the checkpoint reach
 * `saveCheckpoint` — the drain's own path: wrap, seal, store, register or batch, signed as the
 * client's identity with agent-inferred provenance.
 *
 * Two limits sit in front of the send: one save per minute per identity per project (the drain's
 * own cadence, so a looping model cannot spend the sponsor's gas), and one stable session id per
 * identity + project so the handoff merge treats every save as a single continuing history.
 */

/** The fields a model may send: the ten content fields plus the optional verbatim ask. */
const SAVE_FIELDS: readonly string[] = [...CONTENT_FIELDS, "originalRequest"]

/** One save per minute per identity + project — the drain's own `DEFAULT_MIN_GAP_MS` cadence. */
const DEFAULT_MIN_GAP_MS = 60_000

/**
 * The session every save by one MCP client in one project chains under. Stable across daemon
 * restarts and never taken from the model: `mcp-<agent>-<projectId>` when the id is a safe name,
 * a digest suffix otherwise — either way it is safe for state files and reads clearly in a handoff.
 */
export function mcpSaveSessionId(agent: string, projectId: string): string {
  const suffix = isSafeName(projectId) && projectId.length <= 80 ? projectId : bytesToHex(sha256(utf8ToBytes(projectId))).slice(0, 24)
  return `mcp-${agent}-${suffix}`
}

/** The deterministic save id: same content in the same slot means the same eventId, so a retry is a duplicate. */
function mcpSaveEventId(projectId: string, sessionId: string, content: Record<string, unknown>): string {
  const digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify([projectId, sessionId, content]))))
  return `cp-${digest.slice(0, 40)}`
}

export type McpSaveResult =
  | {
      kind: "saved"
      text: string
      contextId: string
      transactionHash: string | null
      duplicate: boolean
      lane: "direct" | "batched"
      eventId: string
      projectId: string
      sessionId: string
      checkpoint: Checkpoint
      /** The task the checkpoint was filed under — absent when it is `main` (tk-1). */
      task?: string
    }
  | {
      kind: "refused"
      reason: string
      text: string
      /** Leading field names the validator flagged — names only, never values. */
      fields?: string[]
      /** ISO time the next save is allowed — present on a rate-limited refusal. */
      nextAllowedAt?: string
    }

export interface McpSaveDeps {
  /** Identity lookup; default loadAgentIdentity — tests inject. */
  loadIdentity?: (home: MidaHome, name: string) => AgentIdentity | undefined
  /** The owner-signed folder check; default checkProject — tests inject. */
  checkProject?: (runtime: ServiceRuntime, input: { agent: string; cwd: string }) => Promise<ProjectCheck>
  /** The chain-capability verdict for distinguishing "revoked" from "never had it"; default capabilityState. */
  capability?: (runtime: ServiceRuntime, agent: string) => Promise<CapabilityState>
  /** The CREATE/READ authority question; default asks the chain's CapabilityRegistry for the project area. */
  hasAuthority?: (agentId: Hex, permission: number, provenancePolicy: number) => Promise<boolean>
  /** The revoke marker `mida revoke` leaves; default isRevoked — tests inject. */
  isRevoked?: (name: string) => boolean
  /** The staged store deny of a revoke still in flight; default revokePending — tests inject. */
  revokePending?: (name: string) => RevokePendingMarker | undefined
  /** The write itself; default saveCheckpoint — the drain's own seal/store/register path. */
  save?: typeof saveCheckpoint
  /** Wall clock for createdAt and the rate slot; default Date.now — tests inject. */
  now?: () => number
  /** The per-(identity, project) last-admitted save times — the daemon owns one map for the process. */
  lastSaves?: Map<string, number>
  /** The rate window; default one minute. */
  minGapMs?: number
}

const refused = (reason: string, text: string, extra: Partial<Extract<McpSaveResult, { kind: "refused" }>> = {}): McpSaveResult => ({
  kind: "refused",
  reason,
  text,
  ...extra,
})

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

const readOnlyText = (agent: string): string =>
  `${agent} can read but not write here — run \`mida request ${agent}\` and \`mida approve ${agent}\` to add write access`
const notApprovedText = (agent: string): string =>
  `Mida: ${agent} is not approved for this project — run \`mida approve ${agent}\` in this folder. Nothing was saved.`
const revokedText = (agent: string): string => `Mida: ${agent}'s access was revoked by the owner. Nothing was saved.`
const revokePendingText = (agent: string): string => `Mida: a revoke of ${agent} is still landing — nothing was saved. Try again shortly.`
const noIdentityText = (agent: string, homeRoot: string): string =>
  `Mida: no agent "${agent}" is set up in this Mida home (${homeRoot}). Nothing was saved.`
const identityUnreadableText = (agent: string, homeRoot: string): string =>
  `Mida: ${agent}'s identity in this Mida home (${homeRoot}) exists but could not be read. Nothing was saved. Run \`mida doctor\`.`
const notMcpClientText = (agent: string): string =>
  `Mida: ${agent} is not an MCP client identity — mida_save signs for ${MCP_CLIENT_TOOLS.join(" and ")}. Nothing was saved.`
const rateLimitedText = (agent: string, seconds: number, at: string): string =>
  `Mida: ${agent} may save once per minute in a project — the next save is allowed in ${seconds} s (at ${at}). Nothing was saved.`

/**
 * Handles one POST /save body. `record` is the raw JSON the socket carried; every check decides
 * locally here so the adapter can stay a pipe. Nothing throws on an input problem — a refusal is a
 * result — but a save that fails for a reason the codes do not name still propagates to the daemon's
 * 500 answer rather than being reported as a refusal the model could act on.
 */
export async function buildMcpSave(runtime: ServiceRuntime, record: unknown, deps: McpSaveDeps = {}): Promise<McpSaveResult> {
  const now = deps.now ?? Date.now
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS
  const lastSaves = deps.lastSaves ?? new Map()
  const isRevokedDep = deps.isRevoked ?? ((name: string) => isRevoked(runtime.home, name))
  const revokedPendingDep = deps.revokePending ?? ((name: string) => revokePending(runtime.home, name))
  const save = deps.save ?? saveCheckpoint
  const check = deps.checkProject ?? checkProject
  const capability = deps.capability ?? capabilityState
  const askAuthority =
    deps.hasAuthority ??
    ((agentId: Hex, permission: number, provenancePolicy: number) =>
      runtime.reader.hasAuthority(runtime.owner, agentId, NAMESPACE_ID, permission, provenancePolicy))

  const badInput = refused("bad-input", "Mida: bad save input — nothing was saved.")
  if (!isObj(record)) return badInput
  const agent = typeof record.agent === "string" ? record.agent : ""
  const cwd = typeof record.cwd === "string" ? record.cwd : ""
  const extraTop = Object.keys(record).filter((k) => k !== "agent" && k !== "cwd" && k !== "fields" && k !== "task")
  // the name is interpolated into refusal text — only after it is proven a safe local agent name,
  // and a relative cwd would resolve against the daemon's own working directory
  if (!isSafeName(agent)) return refused("bad-agent", "Mida: bad agent name — nothing was saved.")
  if (cwd === "" || !isAbsolute(cwd)) return badInput
  if (extraTop.length > 0) return refused("bad-input", `Mida: bad save input (${extraTop.join(", ")}) — nothing was saved.`, { fields: extraTop })
  // tk-1: a named task is refused, never silently dropped — saving under `main` when the model
  // asked for `sdk` would file the checkpoint where its own session will never look
  const task = record.task
  if (task !== undefined && !isTaskName(task)) {
    return refused("bad-task", `Mida: bad task name — ${TASK_RULE_TEXT}. Nothing was saved.`, { fields: ["task"] })
  }

  // Gate 1: a known MCP client identity — this route signs for mida-mcp's clients only, so a
  // coding agent (which writes through its own hooks) is refused before its identity is even read.
  if (!MCP_CLIENT_TOOLS.includes(agent)) return refused("not-an-mcp-client", notMcpClientText(agent))
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

  // Gate 2: the owner-signed folder approval — the same check the reads make, so its refusals are
  // the same lines (with the write-side tail appended).
  const project = await check(runtime, { agent, cwd })
  if (!project.ok) {
    const refusal = projectCheckRefusal(runtime, agent, project, isRevokedDep)
    return refused(refusal.reason, `${refusal.text} Nothing was saved.`)
  }
  const projectId = project.approval.projectId

  // Gate 3: the chain grant carries CREATE on the project area with agent-inferred provenance —
  // the same tuple the contract itself requires of a batched write. A failure to answer is a
  // refusal, never an admission.
  let canCreate: boolean
  try {
    canCreate = await askAuthority(identity.agentId, PERMISSION.CREATE, PROVENANCE_POLICY.ALLOW_INFERENCE)
  } catch (error) {
    // a chain that could not be asked is not a failed check — it names itself (in-6 R4)
    const chainReason = chainRefusalReason(error)
    if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
    return refused("check-failed", noContextText("check-failed"))
  }
  if (!canCreate) {
    if (isRevokedDep(agent)) return refused("revoked", revokedText(agent))
    let state: Awaited<ReturnType<typeof capability>>
    try {
      state = await capability(runtime, agent)
    } catch (error) {
      const chainReason = chainRefusalReason(error)
      if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
      throw error
    }
    if (state === "revoked") return refused("revoked", revokedText(agent))
    try {
      if (await askAuthority(identity.agentId, PERMISSION.READ, 0)) {
        return refused("read-only", readOnlyText(agent))
      }
    } catch (error) {
      const chainReason = chainRefusalReason(error)
      if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
      return refused("check-failed", noContextText("check-failed"))
    }
    return refused("not-approved", notApprovedText(agent))
  }

  // Gate 4: the local markers the chain cannot see — a landed revoke and a revoke whose store
  // deny is still in flight both stop the save before a signature is attempted.
  if (isRevokedDep(agent)) return refused("revoked", revokedText(agent))
  if (revokedPendingDep(agent) !== undefined) return refused("revoke-pending", revokePendingText(agent))

  // Shape: only the checkpoint's content fields — every identity-bearing key (eventId, agent,
  // source, createdAt) is stamped here, so a model-supplied one is an unknown key and gets named.
  const fields = record.fields
  if (!isObj(fields)) return badInput
  const unknown = Object.keys(fields).filter((k) => !SAVE_FIELDS.includes(k))
  if (unknown.length > 0) {
    return refused("invalid-shape", `Mida: these fields are not part of a checkpoint: ${unknown.join(", ")} — nothing was saved.`, { fields: unknown })
  }

  // Secrets are scrubbed with the compiler's own scrubber before anything is sealed — nested
  // arrays and objects included, and sensitive-looking key names redact their values outright.
  const content = scrubValue(fields) as Record<string, unknown>

  const sessionId = mcpSaveSessionId(agent, projectId)
  const checkpoint: Checkpoint = {
    eventId: mcpSaveEventId(projectId, sessionId, content),
    agent,
    source: "agent-tool",
    createdAt: new Date(now()).toISOString(),
    objective: content.objective as string,
    originalRequest: (content.originalRequest ?? null) as string | null,
    progress: (content.progress ?? []) as string[],
    decisions: (content.decisions ?? []) as Checkpoint["decisions"],
    rejected: (content.rejected ?? []) as Checkpoint["rejected"],
    constraints: (content.constraints ?? []) as string[],
    artifacts: (content.artifacts ?? []) as string[],
    unresolvedIssue: (content.unresolvedIssue ?? null) as string | null,
    nextAction: content.nextAction as string,
    remainingPlan: (content.remainingPlan ?? []) as string[],
    evidence: (content.evidence ?? []) as Checkpoint["evidence"],
  }
  const validated = validateCheckpoint(checkpoint)
  if (!validated.ok) {
    const bad = fieldPathsFromErrors(validated.errors)
    return refused("invalid-shape", `Mida: invalid checkpoint fields: ${bad.join(", ")} — nothing was saved.`, { fields: bad })
  }

  // One save per minute in this slot — checked after every gate so a refused call never consumes
  // the interval, and reserved before the send so a second call during a slow save still refuses.
  const slot = `${agent}\n${projectId}`
  const last = lastSaves.get(slot)
  if (last !== undefined && now() - last < minGapMs) {
    const nextAllowedAt = new Date(last + minGapMs).toISOString()
    const seconds = Math.ceil((last + minGapMs - now()) / 1000)
    return refused("rate-limited", rateLimitedText(agent, seconds, nextAllowedAt), { nextAllowedAt })
  }
  lastSaves.set(slot, now())

  const input: Omit<CheckpointEnvelope, "type"> = {
    projectId,
    sessionId,
    continuesSession: null,
    compiledBy: agent,
    checkpoint: validated.value,
    ...(task === undefined ? {} : { task }),
  }
  try {
    const saved = await save(runtime, agent, input)
    const short = saved.contextId.slice(0, 10)
    const text = saved.duplicate
      ? `Mida: this checkpoint was already saved (record ${short}…).`
      : saved.lane === "batched"
        ? `Mida: checkpoint queued as ${agent} (record ${short}… — anchors with the next batch).`
        : `Mida: checkpoint saved as ${agent} (record ${short}…${saved.transactionHash !== null ? `, tx ${saved.transactionHash.slice(0, 10)}…` : ""}).`
    return {
      kind: "saved",
      text,
      contextId: saved.contextId,
      transactionHash: saved.transactionHash,
      duplicate: saved.duplicate,
      lane: saved.lane ?? "direct",
      eventId: validated.value.eventId,
      projectId,
      sessionId,
      checkpoint: validated.value,
      ...(task === undefined ? {} : { task }),
    }
  } catch (error) {
    // a save that never landed frees the slot — the next call gets a real answer, not a stale hold
    lastSaves.delete(slot)
    if (error instanceof CheckpointPayloadError) {
      return refused(error.code, `Mida: ${error.message} — nothing was saved.`, { fields: error.fields })
    }
    // the chain's own answers between the gates and the send map onto the same lines the gates print
    if (isMidaError(error, "CAPABILITY_REVOKED")) return refused("revoked", revokedText(agent))
    if (isMidaError(error, "WRITE_DENIED")) return refused("revoke-pending", revokePendingText(agent))
    if (isMidaError(error, "CAPABILITY_DENIED")) {
      return isRevokedDep(agent) ? refused("revoked", revokedText(agent)) : refused("not-approved", notApprovedText(agent))
    }
    if (isMidaError(error, "PARTIAL_READ")) return refused("check-failed", noContextText("check-failed"))
    if ((error as { code?: unknown }).code === "agent-not-setup") {
      return refused("no-identity", noIdentityText(agent, runtime.home.root))
    }
    // a send or read that died on a chain that could not answer is a refusal, not "not-approved" (in-6 R4)
    const chainReason = chainRefusalReason(error)
    if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
    if (isMidaError(error)) return refused(error.code, noContextText(error.code))
    throw error
  }
}
