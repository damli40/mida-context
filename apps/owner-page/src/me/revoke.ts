/**
 * Task 6 — revoke an agent straight from /me, without a terminal round-trip.
 *
 * The terminal builds a revoke owner link and the /revoke page consumes it; here the page does
 * both halves itself: it builds the same request object, serializes it through buildOwnerLink,
 * re-parses it through parseOwnerLink — the same validation, normalization and requestHash the
 * terminal flow runs on — then hands it to the same prepareRevoke → confirmRevoke pair. Nothing
 * about the revoke is a different code path just because the request never left the browser.
 *
 * The two rules the spec fixes for this request (§5, R1):
 *  - `owner` is ALWAYS the address the passkey session derived at sign-in — never a field off a
 *    row. confirmRevoke re-checks it: the passkey ceremony must derive that same address or the
 *    flow fails in words before any send.
 *  - `readers` is every other agent the page knows about, whatever state its rows showed — the
 *    rotate inside a revoke invalidates survivors' key wraps, so each is re-wrapped for the new
 *    epoch. The chain rechecks READ before any wrap is published: a stale row can waste a read,
 *    never grant one — and a row the page could not verify is still offered to the chain.
 *
 * There is no `port`: there is no terminal waiting on localhost, so the result is returned to
 * the page, which re-reads the world via loadMe rather than flipping a row it cannot verify.
 */

import { buildOwnerLink, parseOwnerLink } from "@mida/protocol"
import type { Address, Hex, OwnerLinkResult as FlowResult } from "@mida/protocol"
import { confirmRevoke, prepareRevoke, repairReaderWraps } from "../owner/flows.js"
import type { FlowEnvironment, ReaderRepairResult } from "../owner/flows.js"
import { readersAfterRevoke } from "./model.js"
import type { AgentRow } from "./sources.js"

/**
 * The origin only fills the URL's host part — the flow consumes the fragment alone, so the
 * value is inert. `location` does not exist under the node test environment; the fallback keeps
 * the build step honest there.
 */
const FALLBACK_ORIGIN = "https://app.midacontext.xyz"

/** A 16-hex nonce — the same shape the terminal issues, fresh from crypto.getRandomValues. */
function freshNonce(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/**
 * The one refusal the revoke path must make itself: rotating the key against an agent list that
 * never loaded hands the new epoch to nobody and still reports success. A complete list always
 * contains the clicked agent, so an empty list is an unavailable list, whatever the flag says.
 */
export const REVOKE_NEEDS_LIST =
  "Revoke needs the full agent list — the index and chain scan are unavailable; try again shortly"

export interface MeRevokeResult extends FlowResult {
  rewrapFailed: { agentId: Hex; namespaceId: Hex; reason: string }[]
}

/**
 * The plan's Task 6 entry point. `input.signedInOwner` is the session's derived owner address;
 * `input.agentId` is the row the owner clicked; `input.agents` is the agent list the page just
 * re-read at click time, from which the surviving readers are derived. prepareRevoke failures
 * (a bad chain answer, a wrong chain) throw before any passkey prompt; everything after is a
 * FlowResult — "success", "cancelled", "failed", or "pending" — never a local guess.
 */
export async function revokeFromMe(
  env: FlowEnvironment,
  input: { signedInOwner: Address; agentId: Hex; agents: readonly AgentRow[]; agentsUnavailable?: boolean },
): Promise<MeRevokeResult> {
  if (input.agentsUnavailable === true || input.agents.length === 0) {
    // A plain Error — the panel shows this sentence verbatim.
    throw new Error(REVOKE_NEEDS_LIST)
  }
  const built = buildOwnerLink({
    origin: typeof location === "undefined" ? FALLBACK_ORIGIN : location.origin,
    flow: "revoke",
    req: {
      chainId: Number(env.deployment.chainId),
      owner: input.signedInOwner,
      agentId: input.agentId,
      readers: readersAfterRevoke(input.agents, input.agentId),
    },
    nonce: freshNonce(),
  })
  const link = parseOwnerLink(built.url.slice(built.url.indexOf("#") + 1), "revoke")
  const prep = await prepareRevoke(env, link)
  const rewrap = { failed: [] as MeRevokeResult["rewrapFailed"] }
  const result = await confirmRevoke(env, link, prep, rewrap)
  return Object.assign(result, { rewrapFailed: rewrap.failed })
}

/**
 * The repair action: for every agent the page knows and every area any grant touches, the chain
 * decides who still holds READ and the current epoch's wrap is published to each of them. The
 * revoked agent's checks simply fail — it needs no exclusion.
 */
export async function repairReaderWrapsFromMe(
  env: FlowEnvironment,
  input: { signedInOwner: Address; agents: readonly AgentRow[]; agentsUnavailable?: boolean },
): Promise<ReaderRepairResult> {
  if (input.agentsUnavailable === true || input.agents.length === 0) {
    // "Zero known agents" is a failed load, not an empty world — never claim "reached every
    // surviving agent" for a list we could not read.
    throw new Error(REVOKE_NEEDS_LIST)
  }
  const namespaceIds = [
    ...new Set(input.agents.flatMap((agent) => agent.grants.map((grant) => grant.namespaceId.toLowerCase() as Hex))),
  ]
  return repairReaderWraps(env, {
    owner: input.signedInOwner,
    agents: input.agents.map((agent) => agent.agentId),
    namespaceIds,
  })
}
