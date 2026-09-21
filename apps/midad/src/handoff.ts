import { isAbsolute } from "node:path"
import { isMidaError } from "@mida/protocol"
import { mergeCheckpoints, renderHandoff } from "@mida/checkpoint"
import { loadAgentIdentity, loadGrants } from "./keys.js"
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
  | { kind: "handoff"; text: string; checkpoints: number; facts: number; factsFailed: string | null; readMs: number }
  | { kind: "empty"; text: string; facts: number; factsFailed: string | null; readMs: number }
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
async function capabilityState(runtime: ServiceRuntime, agent: string): Promise<CapabilityState> {
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

type ReadOutcome =
  | { status: "ok"; checkpoints: Awaited<ReturnType<typeof readCheckpoints>>["checkpoints"] }
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
  // the name is interpolated into refusal text — only after it is proven a safe local agent name
  if (!isSafeName(agent)) return refused("bad-agent", noContextText("bad-agent"))
  // a relative cwd would be resolved against the DAEMON's working directory — refuse it outright
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return refused("bad-input", noContextText("bad-input"))
  try {
    const check = await (deps.checkProject ?? checkProject)(runtime, { agent, cwd: input.cwd })
    if (!check.ok) {
      if (check.reason === "list-tampered") return refused("list-tampered", TAMPERED_TEXT)
      if (check.reason === "list-unreadable") return refused("list-unreadable", UNREADABLE_TEXT)
      // a failed check names no cause the owner could act on — the generic line, not a guess
      if (check.reason === "check-failed") return refused("check-failed", noContextText("check-failed"))
      return refused(check.reason, notApprovedText(agent))
    }
    const state = await (deps.capability ?? capabilityState)(runtime, agent)
    if (state === "revoked") return refused("revoked", revokedText(agent))
    if (state !== "live") return refused("not-approved", notApprovedText(agent))

    const now = deps.now ?? (() => Date.now())
    const readStarted = now()
    // `settled` never rejects, so a read that finishes or fails after the deadline is discarded
    // quietly — no unhandled rejection, and its text is never logged or rendered.
    const settled = (deps.read ?? readCheckpoints)(runtime, agent, check.approval.projectId).then(
      (value): ReadOutcome => ({ status: "ok", checkpoints: value.checkpoints }),
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
    const outcome = (await Promise.race([settled, slow])) as ReadOutcome
    const factOutcome = (await Promise.race([factSettled, slow])) as FactOutcome
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
    if (merged === null) return { kind: "empty", text: EMPTY_TEXT, facts: facts.length, factsFailed, readMs }
    // Serving a handoff to a named new session binds it to the chain it was shown: the drainer's
    // saves for that session read state/continues/<sessionId>.json into continuesSession. A record
    // scoped to this project, a session never continues itself, and a write that fails only means
    // the link is missing later — never a refused handoff.
    if (isSafeName(input.sessionId) && input.sessionId !== merged.headSessionId) {
      try {
        runtime.home.writeSecretJson(`state/continues/${input.sessionId}.json`, {
          continues: merged.headSessionId,
          projectId: check.approval.projectId,
        })
      } catch {
        // a failed record degrades to continuesSession null at save time
      }
    }
    return {
      kind: "handoff",
      text: renderHandoff(merged, { authorNames: input.authorNames, facts, factsFailed }),
      checkpoints: outcome.checkpoints.length,
      facts: facts.length,
      factsFailed,
      readMs,
    }
  } catch {
    return refused("internal", noContextText("internal"))
  }
}
