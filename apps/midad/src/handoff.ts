import { isAbsolute } from "node:path"
import { isMidaError } from "@mida/protocol"
import { mergeCheckpoints, renderHandoffReport } from "@mida/checkpoint"
import { isRevoked, loadAgentIdentity, loadGrants } from "./keys.js"
import { checkProject } from "./projects.js"
import type { ProjectCheck } from "./projects.js"
import { isSafeName } from "./queue.js"
import { readOwnerFacts } from "./remember.js"
import type { ServiceRuntime } from "./runtime.js"
import { isCapabilityLive, readCheckpoints } from "./skeleton.js"

/**
 * Spec §5D — what a fresh agent's session-start hook prints. One of three outcomes: the merged
 * handoff text (already fenced by render.ts), the "connected, nothing saved yet" line, or one
 * plain refusal line. A refusal is never a partial or stale handoff: any gate that cannot be
 * answered cleanly answers with a stable code instead.
 */
export type HandoffResult =
  | {
      kind: "handoff"
      text: string
      checkpoints: number
      facts: number
      factsFailed: string | null
      readMs: number
      /** The resolved name of the agent that saved the newest covered checkpoint — for the owner's line. */
      savedBy: string
      /** The newest covered checkpoint's createdAt — the point a whats-new read continues from. */
      savedAt: string
      /** The foreign contextIds this handoff covered, oldest first — the session's whats-new seen set starts here. */
      seen: string[]
      /** The size limit the text was cut against — the daemon logs it next to the text's length. */
      limitChars: number
      /** Oldest progress entries were left out so the text fits the limit — the owner sees "(shortened)". */
      cut: boolean
      /** Still longer than the limit after trimming — the owner sees "(longer than the limit)". */
      oversized: boolean
      /** The store's list was incomplete — the text opens with the may-be-incomplete line and the owner sees "(incomplete …)". */
      partial: boolean
    }
  | { kind: "empty"; text: string; facts: number; factsFailed: string | null; readMs: number; seen: string[]; partial: boolean }
  | { kind: "refused"; text: string; reason: string }

/** What the chain says about the agent's grants: one is live, at least one was revoked, or nothing valid remains. */
export type CapabilityState = "live" | "none" | "revoked"

export interface HandoffDeps {
  /** The read must finish inside this budget so the daemon answers before the hook's 8 s client timeout. Default 7.5 s. */
  limitMs?: number
  checkProject?: (runtime: ServiceRuntime, input: { agent: string; cwd: string }) => Promise<ProjectCheck>
  capability?: (runtime: ServiceRuntime, agent: string) => Promise<CapabilityState>
  read?: typeof readCheckpoints
  /** The owner-fact read; defaults to readOwnerFacts. A failure here degrades, never refuses. */
  readFacts?: typeof readOwnerFacts
  /**
   * "The owner revoked this agent" — the marker `mida revoke` writes into the home. Consulted
   * when the project check answers not-approved: the revoked agent's list row is gone by then,
   * so the check alone cannot tell "never approved" from "revoked" (R4-3). Defaults to the
   * real file; tests inject it.
   */
  isRevoked?: (agent: string) => boolean
  now?: () => number
}

const HANDOFF_READ_LIMIT_MS = 7_500

const notApprovedText = (agent: string): string =>
  `Mida: ${agent} is not approved for this project — run \`mida approve ${agent}\` in this folder.`
const revokedText = (agent: string): string =>
  `Mida: ${agent}'s access was revoked by the owner. Nothing was shared.`
const TAMPERED_TEXT = "Mida: the approved-projects list failed its signature check. Nothing was shared. Run `mida doctor`."
const UNREADABLE_TEXT = "Mida: the approved-projects list could not be read: check the file's permissions. Nothing was shared. Run `mida doctor`."
const EMPTY_TEXT = "Mida: connected. Nothing has been saved for this project yet."
/**
 * The one line a partial read adds at the top of the model text (M3-D): the store verified what it
 * served but could not check every row, so what follows may be missing context. The same sentence
 * is the whole text when nothing rendered at all.
 */
export const PARTIAL_LINE = "Some saved context could not be loaded yet; what follows may be incomplete."

/** The generic refusal line — the only text a session-start hook prints on its own failures. */
export function noContextText(code: string): string {
  return `Mida: no context available right now (${code}).`
}

const refused = (reason: string, text: string): HandoffResult => ({ kind: "refused", reason, text })

/**
 * Asks the chain — never a local flag — whether the agent currently holds a live capability.
 * Two chain signals both mean "revoked": a capability record marked revoked, or a granted
 * capability whose captured agent epoch the owner has moved past (the agent-level revoke
 * increments it and empties activeCapabilityIds entirely — which is why the ids to inspect
 * come from grants.json as well; grants.json only supplies WHICH ids to ask about, the chain
 * records give the verdict). Anything else — expired, superseded, never granted — is "none",
 * the not-approved refusal: if the chain cannot tell those cases apart, neither can we.
 */
export async function capabilityState(runtime: ServiceRuntime, agent: string): Promise<CapabilityState> {
  const identity = loadAgentIdentity(runtime.home, agent)
  if (identity === undefined) return "none"
  const ids = new Set(await runtime.reader.activeCapabilityIds(runtime.owner, identity.agentId))
  for (const grant of loadGrants(runtime.home, agent)) {
    for (const capability of grant.capabilities) ids.add(capability.capabilityId)
  }
  if (ids.size === 0) return "none"
  const agentEpoch = await runtime.reader.agentEpoch(runtime.owner, identity.agentId)
  let sawRevoked = false
  for (const id of ids) {
    if (await isCapabilityLive(runtime.chain, id)) return "live"
    const capability = await runtime.reader.getCapability(id).catch(() => null)
    if (capability !== null && capability.owner === runtime.owner && (capability.revoked || capability.agentEpoch !== agentEpoch)) {
      sawRevoked = true
    }
  }
  return sawRevoked ? "revoked" : "none"
}

/**
 * The gates every context read passes through, in their security order: the agent name and the
 * cwd are proven safe, then the owner-signed project list answers, and only a live chain
 * capability opens the read. The whats-new read goes through exactly this — a refused agent gets
 * nothing there either (R5-5).
 */
export type AccessCheck =
  | { ok: true; approval: Extract<ProjectCheck, { ok: true }>["approval"] }
  | { ok: false; reason: string; text: string }

export async function checkAccess(
  runtime: ServiceRuntime,
  input: { agent: string; cwd: string },
  deps: Pick<HandoffDeps, "checkProject" | "capability" | "isRevoked"> = {},
): Promise<AccessCheck> {
  const agent = input.agent
  // the name is interpolated into refusal text — only after it is proven a safe local agent name
  if (!isSafeName(agent)) return { ok: false, reason: "bad-agent", text: noContextText("bad-agent") }
  // a relative cwd would be resolved against the DAEMON's working directory — refuse it outright
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
    return { ok: false, reason: "bad-input", text: noContextText("bad-input") }
  }
  const check = await (deps.checkProject ?? checkProject)(runtime, { agent, cwd: input.cwd })
  if (!check.ok) {
    if (check.reason === "list-tampered") return { ok: false, reason: "list-tampered", text: TAMPERED_TEXT }
    if (check.reason === "list-unreadable") return { ok: false, reason: "list-unreadable", text: UNREADABLE_TEXT }
    // a failed check names no cause the owner could act on — the generic line, not a guess
    if (check.reason === "check-failed") return { ok: false, reason: "check-failed", text: noContextText("check-failed") }
    // A revoked agent's project row is gone, so the project check answers not-approved first —
    // the marker `mida revoke` left behind says why access really ended (R4-3). A marker that
    // cannot be read leaves the not-approved answer standing, never a crash.
    if (check.reason === "not-approved") {
      try {
        if ((deps.isRevoked ?? ((name) => isRevoked(runtime.home, name)))(agent)) {
          return { ok: false, reason: "revoked", text: revokedText(agent) }
        }
      } catch { /* fall through to not-approved */ }
    }
    return { ok: false, reason: check.reason, text: notApprovedText(agent) }
  }
  const state = await (deps.capability ?? capabilityState)(runtime, agent)
  if (state === "revoked") return { ok: false, reason: "revoked", text: revokedText(agent) }
  if (state !== "live") return { ok: false, reason: "not-approved", text: notApprovedText(agent) }
  return { ok: true, approval: check.approval }
}

type ReadOutcome =
  | { status: "ok"; checkpoints: Awaited<ReturnType<typeof readCheckpoints>>["checkpoints"]; partial: boolean }
  | { status: "failed"; error: unknown }
  | { status: "slow" }

type FactOutcome = { status: "ok"; facts: Awaited<ReturnType<typeof readOwnerFacts>> } | { status: "failed" } | { status: "slow" }

/**
 * The gate order is the security property: the owner-signed project list answers first and a
 * refusal there means zero further reads — no chain call, no server call. Then the chain's own
 * answer on the agent's capability, then the full protocol read, merged and rendered.
 */
export async function buildHandoff(
  runtime: ServiceRuntime,
  input: { agent: string; cwd: string; authorNames: Record<string, string>; sessionId?: string },
  deps: HandoffDeps = {},
): Promise<HandoffResult> {
  const agent = input.agent
  try {
    const access = await checkAccess(runtime, { agent, cwd: input.cwd }, deps)
    if (!access.ok) return refused(access.reason, access.text)
    const check = access.approval

    const now = deps.now ?? (() => Date.now())
    const readStarted = now()
    // `settled` never rejects, so a read that finishes or fails after the deadline is discarded
    // quietly — no unhandled rejection, and its text is never logged or rendered.
    const settled = (deps.read ?? readCheckpoints)(runtime, agent, check.projectId).then(
      (value): ReadOutcome => ({ status: "ok", checkpoints: value.checkpoints, partial: value.partial }),
      (error): ReadOutcome => ({ status: "failed", error }),
    )
    // The owner-fact read shares the deadline but degrades, never refuses: a failure here means a
    // handoff with facts: 0 and a stable code for the daemon log — unlike a checkpoint failure.
    const factSettled = (deps.readFacts ?? readOwnerFacts)(runtime, agent).then(
      (facts): FactOutcome => ({ status: "ok", facts }),
      (): FactOutcome => ({ status: "failed" }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const limitMs = deps.limitMs ?? HANDOFF_READ_LIMIT_MS
    const slow = new Promise<ReadOutcome | FactOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: "slow" }), limitMs)
    })
    // The two reads are independent and run concurrently (R4-2): each is raced against the one
    // shared deadline, so the facts read gets the checkpoint read's leftover time, not a fresh
    // budget — and its slow/failed outcome still degrades inside the handoff.
    const [outcome, factOutcome] = await Promise.all([
      Promise.race([settled, slow]) as Promise<ReadOutcome>,
      Promise.race([factSettled, slow]) as Promise<FactOutcome>,
    ])
    clearTimeout(timer)
    const readMs = now() - readStarted

    if (outcome.status === "slow") return refused("read-slow", noContextText("read-slow"))
    if (outcome.status === "failed") {
      const error = outcome.error
      if (isMidaError(error, "CAPABILITY_REVOKED")) return refused("revoked", revokedText(agent))
      if (isMidaError(error, "CAPABILITY_DENIED") || isMidaError(error, "CAPABILITY_EXPIRED")) {
        return refused("not-approved", notApprovedText(agent))
      }
      return refused("read-failed", noContextText("read-failed"))
    }
    const facts = factOutcome.status === "ok" ? factOutcome.facts : []
    const factsFailed = factOutcome.status === "ok" ? null : factOutcome.status === "slow" ? "facts-read-slow" : "facts-read-failed"
    const merged = mergeCheckpoints(outcome.checkpoints)
    // A partial read still produces a handoff — the served checkpoints are real — but both
    // channels must say the list was incomplete: the model text opens with PARTIAL_LINE, the
    // owner's line adds "(incomplete — try again in a moment)", the daemon log records it.
    if (merged === null) {
      return {
        kind: "empty",
        text: outcome.partial ? `Mida: connected. ${PARTIAL_LINE}` : EMPTY_TEXT,
        facts: facts.length,
        factsFailed,
        readMs,
        seen: [],
        partial: outcome.partial,
      }
    }
    // the checkpoints this session may treat as covered — its own never count: a session's own
    // saves are never updates for it and must never enter its seen set
    const covered = outcome.checkpoints
      .filter((cp) => cp.sessionId !== input.sessionId)
      .sort((a, b) => Date.parse(a.checkpoint.createdAt) - Date.parse(b.checkpoint.createdAt))
      .map((cp) => cp.contextId)
    // Serving a handoff to a named new session binds it to the chain it was shown: the drainer's
    // saves for that session read state/continues/<sessionId>.json into continuesSession. A record
    // scoped to this project, a session never continues itself, and a write that fails only means
    // the link is missing later — never a refused handoff. A partial merge may be missing the
    // real head, so it binds nothing — the next complete read links the session properly (M3-D).
    if (!outcome.partial && isSafeName(input.sessionId) && input.sessionId !== merged.headSessionId) {
      try {
        runtime.home.writeSecretJson(`state/continues/${input.sessionId}.json`, {
          continues: merged.headSessionId,
          projectId: check.projectId,
        })
      } catch {
        // a failed record degrades to continuesSession null at save time
      }
    }
    // the newest record the merge covered — scope is time-sorted, so the last provenance row is it
    const newest = merged.provenance.at(-1)
    const savedBy =
      newest === undefined ? "unknown agent" : (input.authorNames[newest.authorId.toLowerCase()] ?? "unknown agent")
    const rendered = renderHandoffReport(merged, { authorNames: input.authorNames, facts, factsFailed })
    return {
      kind: "handoff",
      text: outcome.partial ? `${PARTIAL_LINE}\n\n${rendered.text}` : rendered.text,
      checkpoints: outcome.checkpoints.length,
      facts: facts.length,
      factsFailed,
      readMs,
      savedBy,
      savedAt: newest?.createdAt ?? "",
      seen: covered,
      limitChars: rendered.limitChars,
      cut: rendered.cut,
      oversized: rendered.oversized,
      partial: outcome.partial,
    }
  } catch {
    return refused("internal", noContextText("internal"))
  }
}
