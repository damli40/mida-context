import { privateKeyToAccount } from "viem/accounts"
import { entryPoint08Address } from "viem/account-abstraction"
import type { AbiEvent } from "viem"
import { MidaError, NAMESPACE_TREE_VERSION, PERMISSION, POLICY_VERSION, accessRequestHash, decodeUint64, displaySafeLine, encodeUint64, isMidaError, namespaceById, namespaceId } from "@mida/protocol"
import type { AccessGrantResponse, AccessRequest, Address, GrantAdvice, GrantedCapability, Hex, PurposeId, RequestedScope } from "@mida/protocol"
import { batchAnchorAbi, capabilityRegistryAbi, createSponsoredSender, createWriteContext, failedBeforeSend, getLogsChunked, latestTimestamp, ownerHistory, readAgentRecord, recordPlacementsNear } from "@mida/chain"
import type { ChainContext, DecodedLog, HistoryScanCursor, RecordPlacement } from "@mida/chain"
import { DENY_CANCEL_EXPIRY_SECONDS, provisionAgent } from "@mida/fake-vault"
import { POLICY_DOCUMENT_V1, adviseGrant, assertRequestFresh, expandScopeInputs, permissionBits, provenancePolicyBits } from "@mida/grant-advisor"
import type { ScopeInput } from "@mida/grant-advisor"
import type { BatchReceipt, RegistryReader } from "@mida/api"
import { compareChainOrder } from "@mida/checkpoint"
import type { StoredCheckpoint as CheckpointRecord } from "@mida/checkpoint"
import type { ContextObject, Grant } from "@mida/sdk"
import { FLUSH_WAIT_MS, RESUBMIT_LANE_CLOSED, addPendingAnchor, batchStatusProbe, flushForeignPending, keepPendingPlaintext, laneForSave } from "./batching.js"
import type { Lane } from "./batching.js"
import { readSavedIds, recordSavedId } from "./saved-ids.js"
import { NAMESPACE, PURPOSE_ID, makeOwnerBalanceGuard, parseSponsorUrl, sponsorReachable } from "./runtime.js"
import type { Runtime, ServiceRuntime } from "./runtime.js"
import { resolveNetwork } from "./network.js"
import { resetOutOfGasWaits } from "./drain.js"
import { FACT_NAMESPACES } from "./remember.js"
import { unwrapCheckpoint, wrapCheckpoint } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import { FileAccessRequestStore } from "./request-store.js"
import type { MidaHome } from "./home.js"
import {
  clearRevokePending, identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets, loadOrCreateSignerKey,
  markRevokePending, markRevoked, markWrapsOwed, replaceSignerKey, revokePending, saveAgentIdentity, saveGrants, saveOwnerAddress, saveOwnerMode, settleWrapsOwed, wrapsOwed,
} from "./keys.js"
import type { RevokePendingMarker } from "./keys.js"
import { approveProject, ensureProjectMarker, removeAgentApprovals } from "./projects.js"

/**
 * The contract's isCapabilityValid view. activeCapabilityIds returns the RAW stored list — expired and
 * revoked ids stay in it until a later grant or revoke compacts it — so a non-empty list proves nothing.
 * RegistryReader has no method for this view and apps/api is out of scope, so it is read here the same
 * way chain-views.ts reads the registry. Exported for the drainer's read-only approval check.
 */
export async function isCapabilityLive(context: ChainContext, capabilityId: Hex): Promise<boolean> {
  return (await context.publicClient.readContract({
    address: context.deployment.capabilityRegistry,
    abi: capabilityRegistryAbi,
    functionName: "isCapabilityValid",
    args: [capabilityId],
  } as never)) as boolean
}

/** "Approved" means the chain lists at least one live capability for this owner–agent pair — any permission. */
export async function hasAnyLiveCapability(runtime: ServiceRuntime, agentId: Hex): Promise<boolean> {
  for (const id of await runtime.reader.activeCapabilityIds(runtime.owner, agentId)) {
    if (await isCapabilityLive(runtime.chain, id)) return true
  }
  return false
}

const GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60
/** The namespace every Mida checkpoint is written under — exported for the daemon's copy seeding. */
export const NAMESPACE_ID = namespaceId(NAMESPACE)
/** Every namespace a reader key can be owed for — a wraps-owed.json with no namespace list (the pre-APR5 shape) means all of these. */
const EVERY_READER_NAMESPACE: Hex[] = [NAMESPACE_ID, ...FACT_NAMESPACES.map((ns) => namespaceId(ns))]

/**
 * The grant an agent asks for is read off the grant-advisor policy's `expected` list for its
 * purpose — never a second copy of the namespace list here. For `project_assistance` that is
 * READ on `profile.skills` and `preferences.communication` plus READ+CREATE+SUPERSEDE_OWN on
 * `projects.current`; for `general_assistance` the two READs only.
 */
export function expectedScopesFor(purposeId: PurposeId): ScopeInput[] {
  return POLICY_DOCUMENT_V1.purposes[purposeId].expected.map((entry) => ({
    namespace: entry.namespace,
    permissions: permissionBits(entry.permissions),
    provenancePolicy: provenancePolicyBits(entry.provenancePolicies),
  }))
}

/**
 * The policy's expected scopes that the chain does NOT currently authorize for this owner–agent
 * pair, as exact (namespaceId, permissions, provenancePolicy) tuples. This is the upgrade path's
 * diff: an agent holding the old single `projects.current` grant is missing exactly the two
 * READ scopes, and only those are asked for.
 */
export async function missingExpectedScopes(runtime: ServiceRuntime, agentId: Hex, purposeId: PurposeId): Promise<RequestedScope[]> {
  const missing: RequestedScope[] = []
  for (const scope of expandScopeInputs(expectedScopesFor(purposeId))) {
    if (!(await runtime.reader.hasAuthority(runtime.owner, agentId, scope.namespaceId, scope.permissions, scope.provenancePolicy))) {
      missing.push(scope)
    }
  }
  return missing
}

/** A signed scope that the chain no longer authorizes — the still-needed part of a pending request. */
export async function ungrantedScopes(runtime: ServiceRuntime, agentId: Hex, scopes: readonly RequestedScope[]): Promise<RequestedScope[]> {
  const needed: RequestedScope[] = []
  for (const scope of scopes) {
    if (!(await runtime.reader.hasAuthority(runtime.owner, agentId, scope.namespaceId, scope.permissions, scope.provenancePolicy))) {
      needed.push(scope)
    }
  }
  return needed
}

/**
 * UF-APR5 F4: what a pending request file the store no longer honours — consumed already, or
 * its record gone — means for the agent, as the chain sees it. The ONE check both `approve` and
 * `approve --all`'s per-agent gate run for that case.
 * `finish`: every scope the request asked for is still live — the grant landed and only the
 * finishing steps died, so approve finishes it without a transaction (the D2 path).
 * `renew`: some scopes are live but others expired or were revoked — the partly-expired-grant
 * case that used to loop approve ↔ request; the stale file goes and the upgrade path re-asks
 * exactly the scopes the chain says are missing. UF-APR6 G3: the same answer when every scope
 * the request covered is dead but the agent still holds another capability — the upgrade path
 * renews the expired part, while a refusal would loop approve ↔ request all over again.
 * `refuse`: the agent holds nothing live at all — a revoked agent or a request that genuinely
 * never completed; the old "no pending request" refusal stands.
 */
export async function usedUpRequestVerdict(
  runtime: ServiceRuntime,
  agentId: Hex,
  scopes: readonly RequestedScope[],
): Promise<"finish" | "renew" | "refuse"> {
  const stillOwed = await ungrantedScopes(runtime, agentId, scopes)
  if (stillOwed.length === 0) return "finish"
  if (stillOwed.length < scopes.length) return "renew"
  // "Nothing this request covered is live" is not "the agent holds nothing" — a scope the
  // request never asked for can still be live, and then the renewal path rebuilds the request
  // for exactly what is missing instead of refusing into an approve ↔ request loop.
  return (await hasAnyLiveCapability(runtime, agentId)) ? "renew" : "refuse"
}

/** The agent names `mida init` knows: the two coding tools and the least-context stand-in. */
export function purposeFor(name: string): PurposeId {
  return name === "assistant" ? "general_assistance" : PURPOSE_ID
}

/** The manifest's scope declarations are the same policy `expected` list the grant comes from. */
export function declarationsFor(purposeId: PurposeId) {
  return POLICY_DOCUMENT_V1.purposes[purposeId].expected.map((entry) => ({
    namespace: entry.namespace,
    permissions: [...entry.permissions],
    provenancePolicies: [...entry.provenancePolicies],
  }))
}

/**
 * The init refusal when the setup's saved contract is not the one this run resolves to. `saved`
 * and `builtIn` ride on the error so ownerRefusalLine can name both records without re-resolving.
 */
export function deploymentMismatchError(saved: string, builtIn: string): Error {
  const short = (a: string) => `${a.slice(0, 6)}…`
  return Object.assign(
    new Error(`this setup's network.json names contract ${short(saved)}, not the ${short(builtIn)} this run resolves to`),
    { code: "deployment-mismatch", saved, builtIn },
  )
}

/** Spec §5A. Every step first asks the chain or the disk whether it is already done, so running it twice is harmless. */
export async function init(runtime: Runtime, agentNames: readonly string[]): Promise<{ owner: Address; agents: Record<string, Hex> }> {
  const { home, network, vault, reader, owner } = runtime
  if (home.has("network.json")) {
    // A setup's contract is bound at init: a saved network.json is never rewritten — only
    // `mida migrate` may move it. When the file names another contract than the one this run
    // resolves to, init refuses before any chain call; a corrupt file refuses the same way
    // (network-json-invalid propagates — corrupt is never treated as missing).
    const resolved = await resolveNetwork(home, process.env, {
      loadBuiltIn: () => network.deployment,
      probeChainId: false,
    })
    if (resolved.mismatch !== undefined) {
      throw deploymentMismatchError(resolved.mismatch.saved, resolved.mismatch.builtIn)
    }
  } else {
    // The detached drainer never loads .env; init leaves it the public chain coordinates to read back.
    // chainId/deploymentBlock/batchAnchorBlock are bigints, so they go on disk as decimal strings for
    // parseDeployment (absent batchAnchorBlock serializes as no key).
    const deployment = network.deployment
    home.writeSecretJson("network.json", {
      chainId: Number(deployment.chainId),
      rpcUrl: network.rpcUrl,
      deployment: {
        ...deployment,
        chainId: deployment.chainId.toString(),
        deploymentBlock: deployment.deploymentBlock.toString(),
        batchAnchorBlock: deployment.batchAnchorBlock?.toString(),
      },
      // absent stays absent — an unset URL serializes as no key, and a later `init` without the
      // value does not blank one an operator wrote into the file by hand
      ...(network.storageUrl === undefined ? {} : { storageUrl: network.storageUrl }),
      ...(network.sponsorUrl === undefined ? {} : { sponsorUrl: network.sponsorUrl }),
    })
  }
  // The daemon needs the owner's public address to verify the signed approved-projects list and to
  // ask the chain about grants — it never reads owner/secrets.json, so the address is public metadata.
  saveOwnerAddress(home, owner)
  // The mode marker (M3-F2): every owner command reads it before touching owner material, so a
  // software-key home and a passkey home can never be mixed by accident.
  saveOwnerMode(home, "software")
  // With a gas sponsor every send below is paid by the sponsor — a brand-new empty owner wallet
  // inits fine (M3-C), and no wallet needs MON up front: not the owner's, not the operator's, not
  // an agent signer's (M3-D3). But a CONFIGURED URL is not proof the sponsor answers (M3-D6):
  // probe it once — the same 2 s GET doctor runs — before telling the owner no MON is needed.
  // A silent sponsor means every send falls back to self-pay, so the wallets are funded exactly
  // as if none were set: the refusal names the address to fund and a re-run resumes where this
  // one stopped.
  const sponsorUrl = parseSponsorUrl(network.sponsorUrl)
  const sponsorUp = sponsorUrl !== undefined && (await sponsorReachable(sponsorUrl))
  if (sponsorUp) {
    runtime.progress?.("gas sponsor on — no MON needed")
  } else {
    if (sponsorUrl !== undefined) {
      runtime.progress?.("gas sponsor not answering — this setup needs MON in your wallet")
    }
    await runtime.ensureFunded(owner, "your wallet")
  }
  const ownerKey = await reader.ownerP256Key(owner)
  if (ownerKey == null || ownerKey.qx === 0n) {
    runtime.progress?.("registering your key on the chain…")
    await vault.registerOwnerKey()
  }
  // The checkpoint namespace plus the two owner-fact namespaces (A14) — opened before any grant so
  // the first approved agent's reader wraps exist before a fact can be written.
  const unopened: string[] = []
  for (const ns of [NAMESPACE, ...FACT_NAMESPACES]) {
    if ((await reader.epochPublicKey(owner, namespaceId(ns), 1n)) == null) unopened.push(ns)
  }
  if (unopened.length > 0) {
    runtime.progress?.(`opening ${unopened.length} context areas (${unopened.length} transactions)…`)
    for (const ns of unopened) await vault.initializeNamespace(ns)
  }

  const operatorAccount = privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey)
  const operator = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: operatorAccount })
  if (sponsorUrl !== undefined) {
    // The operator registers every agent — sponsored too, so an empty wallet still works.
    operator.sponsor = createSponsoredSender({
      sponsorUrl,
      rpcUrl: network.rpcUrl,
      account: operatorAccount,
      deployment: network.deployment,
      progress: (line) => runtime.progress?.(line),
    })
  }
  // The operator pays its own gas only when the sponsor cannot (or is off) — and its top-up
  // then comes from the owner's wallet, so the failure still prints the send-MON line instead
  // of a bare node error deep inside a register.
  operator.beforeSend = makeOwnerBalanceGuard({
    chain: operator,
    fund: network.fund ?? ((address, gate) => runtime.topUpFromOwner(address, gate)),
    progress: (line) => runtime.progress?.(line),
  })
  const agents: Record<string, Hex> = {}
  for (const name of agentNames) {
    let identity = loadAgentIdentity(home, name)
    if (identity === undefined) {
      if (!sponsorUp) await runtime.ensureFunded(operatorAccount.address, "the operator wallet")
      // Saved to disk BEFORE the registration transaction: a crash must never leave a registered agent with no key.
      let signerPrivateKey = loadOrCreateSignerKey(home, name)
      // Unless the crash came after registration: then this signer is bound to an agent whose encryption key was
      // never persisted, and reusing it reverts SignerAlreadyBound. Start over with a fresh key; the orphan is inert.
      if ((await reader.agentIdOfSigner(privateKeyToAccount(signerPrivateKey).address)) !== null) {
        signerPrivateKey = replaceSignerKey(home, name)
      }
      runtime.progress?.(`registering ${name} on the chain…`)
      const provisioned = await provisionAgent({
        operator,
        name,
        purposeId: purposeFor(name),
        declarations: declarationsFor(purposeFor(name)),
        callbackOrigin: `https://${name}.mida.example`,
        signer: privateKeyToAccount(signerPrivateKey),
      })
      identity = identityFrom(name, signerPrivateKey, provisioned)
      saveAgentIdentity(home, identity)
      runtime.attach(identity)
    }
    // An idempotent PUT, run for every agent on every init: a manifest upload lost to a crash is retried here.
    await runtime.ownerApi.putAgentManifest(identity.manifest)
    if (!sponsorUp) {
      await runtime.ensureFunded(privateKeyToAccount(identity.signerPrivateKey).address, `${name}'s wallet`)
    }
    // `assistant` never joins a project, so there is no request/approve round-trip for it: the owner
    // grants its whole READ-only policy grant at init. Missing scopes only — a re-run sends nothing.
    if (identity.purposeId === "general_assistance") {
      // UF-APR7B R5: `mida init` takes no agent argument, so its refusal line is built with an
      // empty name — it printed "'s request has expired… run `mida request `". Every error the
      // assistant's grant step throws carries the name on `.agent` (the same way
      // deploymentMismatchError carries `saved`/`builtIn`), and ownerRefusalLine reads it when
      // the command line names nobody.
      try {
        await initAssistantGrant(runtime, name, identity)
      } catch (error) {
        throw nameOnError(error, name)
      }
    }
    agents[name] = identity.agentId
  }
  // in-29 S-2: the funding pass just ran — a session still waiting out a gas backoff was recorded
  // against a dry wallet and is stale now; clearing it lets the next drain pass retry at once.
  resetOutOfGasWaits(home)
  return { owner, agents }
}

/**
 * The general-assistance grant step of init: finish any landed-but-unrecorded grant from the
 * saved requests, then send for whatever is still missing. Own function so the caller stamps
 * the agent's name on every error it throws (UF-APR7B R5).
 */
async function initAssistantGrant(runtime: Runtime, name: string, identity: NonNullable<ReturnType<typeof loadAgentIdentity>>): Promise<void> {
  const { home, vault, reader, owner } = runtime
  const missing = await missingExpectedScopes(runtime, identity.agentId, identity.purposeId)
  // UF-APR7: nothing missing on the chain is only half the question — the other half is
  // whether THIS machine finished recording the grant. An earlier init can have lost the
  // sponsor's reply after the grant landed: every scope is live, grants.json was never
  // written, and the assistant exists but reads nothing. The check is the same rule doctor
  // reports: every expected scope matched to a saved, still-live capability.
  // UF-APR7B R3: the finish pass now runs BEFORE the send whenever the coverage check fails —
  // a grant can be live but unrecorded while OTHER scopes are still missing (a missing scope
  // already proves the coverage check cannot pass, so the chain read is spent only when
  // nothing is missing). The live part is finished from the saved requests first, then the
  // send below asks for what is still missing, as today.
  const recorded =
    missing.length === 0 &&
    recordedCoverage(
      home,
      name,
      await liveCapabilityIdsOf(reader, owner, identity.agentId),
      expandScopeInputs(expectedScopesFor(identity.purposeId)),
    )
  if (!recorded) {
    // finishOnChainApproval sends no transaction; a throw from it reaches the caller
    // unchanged. Every saved request is tried, newest first — a request whose reply was
    // lost before the latest re-run may be the one whose grant landed (UF-APR7B R2), and
    // the first that returns a grant ends the search.
    let grant: Grant | undefined
    for (const request of readInitGrantRequests(home, name, identity.agentId).reverse()) {
      try {
        grant = await finishOnChainApproval(runtime, name, identity.agentId, request, "mida init")
      } catch (error) {
        // UF-APR7B R5: a finish that could not RUN is not "no live grant found" — the owner
        // must hear the approval is already on chain before the error's own line lands.
        runtime.progress?.(`${name}'s approval is on chain, but Mida could not finish recording it. Run mida init again to finish it.`)
        throw error
      }
      if (grant !== undefined) break
    }
    if (grant !== undefined) {
      removeStaleFile(runtime, name, `agents/${name}/init-grant-request.json`, "mida init")
      runtime.progress?.(`${name}'s approval was already on chain from an earlier try. Mida finished recording it on this machine (no transaction).`)
    } else if (missing.length === 0) {
      runtime.progress?.(`${name} is approved on chain, but this machine never finished recording that approval, so ${name} cannot read. Run mida revoke ${name}, then mida init.`)
    }
  }
  if (missing.length > 0) {
    const request = await runtime.agent(name).createAccessRequest({
      purposeId: identity.purposeId,
      scopes: missing.map((s) => ({ namespace: namespaceById(s.namespaceId).name, permissions: s.permissions, provenancePolicy: s.provenancePolicy })),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
    })
    // UF-APR7: the request is saved BEFORE the send so a lost sponsor reply — grant landed,
    // answer never arrived — can be finished by the next init run. The name is NOT
    // pending-request.json on purpose: approve, approve --all and doctor read that file as a
    // project request, and a general-assistance identity must never appear in those lists.
    // UF-APR7B R2: the file is a LIST — append, never overwrite. An earlier request whose
    // reply was lost may still land AFTER this re-run signs the next one, and overwriting it
    // is what lost a landed grant to begin with; every entry stays until one is recorded.
    const requestFile = `agents/${name}/init-grant-request.json`
    let prior: unknown[] = []
    try {
      const raw = home.readJson<{ request?: unknown; requests?: unknown }>(requestFile)
      prior = raw === undefined ? [] : [...(Array.isArray(raw.requests) ? raw.requests : []), ...(raw.request === undefined ? [] : [raw.request])]
    } catch {
      // a file that cannot be parsed holds nothing worth keeping
    }
    home.writeSecretJson(requestFile, { requests: [...prior, request] })
    runtime.sendProgress(`sending ${name}'s grant`)
    // UF-APR7B R4: the same landed-check approve wraps its send in. A failure after the
    // grant transaction went out must ask the chain whether it landed before ANY line may
    // claim nothing was sent — an unwrapped transport timeout would otherwise print
    // chain-busy's "nothing was sent" about a grant that is already live. The retry the
    // wrapped lines name is `mida init` — `mida approve assistant` is refused.
    let approval: Awaited<ReturnType<typeof vault.approveGrant>>
    try {
      approval = await vault.approveGrant({ accessRequest: request, manifest: identity.manifest, selection: { kind: "recommended" } })
    } catch (error) {
      if (failedBeforeSend(error) || (error instanceof MidaError && APPROVE_REQUEST_REFUSAL_CODES.has(error.code))) throw error
      // As in approve: if the grant did land, its readers' sends are owed work a later run
      // must see — the marker is written before either coded refusal is thrown.
      try {
        markWrapsOwed(home, [
          ...new Set<Hex>(request.scopes.filter((scope) => (scope.permissions & PERMISSION.READ) !== 0).map((scope) => scope.namespaceId)),
        ])
      } catch {
        // the marker is bookkeeping; it must never mask the real failure
      }
      const landed = await ungrantedScopes(runtime, identity.agentId, request.scopes)
        .then((still) => still.length === 0)
        .catch(() => false)
      if (landed) {
        throw codedError(
          "grant-landed-unfinished",
          `the grant for ${name} landed on Monad, but Mida could not finish setting it up: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida init\` again to finish; it sends no new grant`,
        )
      }
      if (isMidaError(error, "OWNER_WALLET_LOW")) throw error
      if (isMidaError(error, "SEND_TIMEOUT") || isMidaError(error, "SPONSOR_PENDING")) throw error
      throw codedError(
        "grant-unconfirmed",
        `the grant for ${name} was sent to Monad, but Mida could not confirm it: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida init\` again to finish; it sends nothing new if the grant landed`,
      )
    }
    const agent = runtime.agent(name)
    await agent.completeAccessRequest(request, approval.response)
    saveGrants(home, name, [...agent.grants])
    // A marker left by an earlier revoke must not outlive the fresh grant init just recorded.
    // UF-APR5 F3: a removal that fails is a note naming the retry, never a bare error.
    removeStaleFile(runtime, name, `agents/${name}/revoked.json`, "mida init")
    removeStaleFile(runtime, name, `agents/${name}/init-grant-request.json`, "mida init")
  }
}

/**
 * UF-APR7B R5: `mida init` takes no agent argument, so its refusal line is built with an empty
 * name. The agent whose step failed rides on the error's `.agent` (same convention as
 * deploymentMismatchError's `saved`/`builtIn`) — set only when absent, so a deeper layer that
 * already named someone is never overwritten.
 */
function nameOnError(error: unknown, name: string): unknown {
  if (typeof error === "object" && error !== null && (error as { agent?: unknown }).agent === undefined) {
    try {
      ;(error as { agent?: string }).agent = name
    } catch {
      // a frozen error keeps itself — stamping must never launder the real refusal
    }
  }
  return error
}

/** Spec §5B step 1: the agent asks for the policy's whole recommended grant for its purpose. The request is on disk before this returns, and so is which request is pending. */
export async function requestAccess(runtime: ServiceRuntime, name: string): Promise<{ requestId: Hex }> {
  const identity = loadAgentIdentity(runtime.home, name)
  runtime.progress?.(`asking the chain what ${name} already holds…`)
  if (identity !== undefined && (await hasAnyLiveCapability(runtime, identity.agentId))) {
    throw codedError("already-approved", `agent "${name}" is already approved`)
  }
  const purposeId = identity?.purposeId ?? PURPOSE_ID
  const request = await runtime.agent(name).createAccessRequest({
    purposeId,
    scopes: expectedScopesFor(purposeId),
    capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
  })
  runtime.home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
  return { requestId: request.requestId }
}

/**
 * What the owner is shown before an approve signs anything. `grant` is a fresh (or pending)
 * capability grant with the advisor's advice; `project` is only a row in the signed
 * approved-projects list for an agent the chain already approves.
 */
export type ApprovePreview =
  | { kind: "grant"; agent: string; requested: RequestedScope[]; scopes: RequestedScope[]; expiresAt: bigint; advice: GrantAdvice }
  | { kind: "project"; agent: string; projectId: string }

/** The owner saw the ask and did not type yes. Coded so the CLI can print "not approved" and exit 1. */
function notApprovedError(): Error {
  const error = new Error("the owner did not approve") as Error & { code: string }
  error.code = "not-approved"
  return error
}

/**
 * A refusal a user-facing command can hit carries a stable code — a bare `refused: ERROR` on the
 * owner's screen names nothing. The CLI maps the codes it knows a next step for; the rest print
 * as `refused: <code>`.
 */
function codedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/**
 * The codes completeAccessRequest throws when the rebuilt response is REFUSED as this request's
 * grant — the only throws recovery may read as "not found". Everything else (a network failure,
 * a rate limit) means the check never ran and must surface as approval-check-failed.
 */
const SDK_REFUSAL_CODES = ["RESPONSE_MISMATCH", "REQUEST_CONSUMED", "CAPABILITY_DENIED"] as const

/**
 * UF-APR5 F2: the refusal codes approveGrant can raise only BEFORE the grant transaction goes
 * out — request wire/expiry checks, the advisor's manifest and history checks, the final-
 * selection check, and the local gas-ceiling refusal. Each one proves nothing was sent, so it
 * keeps its own honest line instead of being re-asked of the chain (an expired request's retry
 * is `mida request`, not "wait for the grant to confirm").
 */
const APPROVE_REQUEST_REFUSAL_CODES = new Set([
  "INVALID_WIRE",
  "REQUEST_EXPIRED",
  "REQUEST_SIGNATURE_INVALID",
  "POLICY_VERSION_UNSUPPORTED",
  "NAMESPACE_TREE_VERSION_UNSUPPORTED",
  "AGENT_ID_MISMATCH",
  "MANIFEST_STALE",
  "MANIFEST_HASH_MISMATCH",
  "PURPOSE_UNKNOWN",
  "RESPONSE_MISMATCH",
  "CAPABILITY_EXPIRED",
  "GAS_CEILING_EXCEEDED",
])

/**
 * The per-agent memory of the last history check (R4-9): `state/history/<agentId>.json`, written
 * atomically by the home. The file names the chain id and the registry it was checked on, so a
 * record from a different chain or deployment is ignored rather than trusted. Anything missing,
 * unreadable or malformed answers undefined — the check re-reads the contract, never a guess.
 */
export function historyCursor(home: MidaHome, agentId: Hex, chainId: bigint, registry: Address): HistoryScanCursor {
  const file = `state/history/${agentId}.json`
  return {
    load() {
      try {
        const raw = home.readJson<Record<string, unknown>>(file)
        if (raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return undefined
        if (String(raw.chainId) !== chainId.toString()) return undefined
        if (typeof raw.registry !== "string" || raw.registry.toLowerCase() !== registry.toLowerCase()) return undefined
        const observedThroughBlock = BigInt(raw.observedThroughBlock as string)
        if (observedThroughBlock < 0n) return undefined
        return { observedThroughBlock, previouslyRevoked: raw.previouslyRevoked === true }
      } catch {
        return undefined
      }
    },
    save(state) {
      home.writeSecretJson(file, {
        chainId: chainId.toString(),
        registry,
        observedThroughBlock: state.observedThroughBlock.toString(),
        previouslyRevoked: state.previouslyRevoked,
      })
    },
  }
}

/**
 * The same advice approveGrant computes internally, run read-only so the owner can see it before
 * deciding. assertRequestIsCurrent throws for a stale request here, exactly as it would below.
 */
async function grantAdviceFor(runtime: Runtime, name: string, request: AccessRequest, manifest: Parameters<typeof adviseGrant>[0]["manifest"]): Promise<GrantAdvice> {
  // the expiry window needs only the chain's clock — one getBlock — so it is checked before the
  // agent-record and revocation-history reads: an expired request refuses here, never after
  // them (in-15 J-2 — Sep 27 live printed "about 928 requests" before REQUEST_EXPIRED, back when
  // the history answer came from a log scan)
  const now = await latestTimestamp(runtime.ownerChain)
  assertRequestFresh(request, now)
  const agentRecord = await readAgentRecord(runtime.ownerChain, request.agentId)
  // ownerHistory reads the contract — agentEpoch, the agent's listed capabilities and their
  // revoked flags — plus this machine's saved yes; there is no log scan to report progress on.
  const history = await ownerHistory({
    client: runtime.ownerChain.publicClient,
    deployment: runtime.ownerChain.deployment,
    owner: runtime.owner,
    agentId: request.agentId,
    cursor: historyCursor(runtime.home, request.agentId, runtime.network.deployment.chainId, runtime.network.deployment.capabilityRegistry),
  })
  return adviseGrant({ request, manifest, agentRecord, ownerHistory: history, now })
}

/**
 * What the batch's preview line should tell the owner a pending agent's approve will do.
 * `advice` carries the grant advisor's verdict for a request the store still honours;
 * `finish` and `renew` are the usedUpRequestVerdict answers for a request file the store no
 * longer honours — the preview names the work, never the stale ask.
 */
export type PendingApprovalGate =
  | { kind: "advice"; advice: GrantAdvice }
  | { kind: "finish" }
  | { kind: "renew" }

/**
 * approve --all's per-agent gate, run while the combined list prints: the same checks a single
 * approve makes before its prompt, in the same order — the pending file must name a request the
 * store still holds (not consumed, never replayed), then the grant advisor must accept it
 * (freshness, signature, manifest, all of assertRequestIsCurrent). Whatever fails throws the
 * coded refusal the batch names in its verdict and the agent is excluded before the one typed
 * yes — an expired or stale request is never carried to the signing step. UF-APR5 F4: a request
 * the store used up is not refused here either — the shared chain verdict says whether its
 * approve finishes a landed grant or renews the part that expired.
 */
export async function pendingApprovalGate(runtime: Runtime, name: string): Promise<PendingApprovalGate> {
  const { home } = runtime
  const identity = loadAgentIdentity(home, name)
  const pending = home.readJson<{ request?: AccessRequest }>(`agents/${name}/pending-request.json`)
  if (identity === undefined || pending?.request === undefined) {
    throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
  }
  const stored = await new FileAccessRequestStore(home, name).load(pending.request.requestId)
  if (stored === undefined || stored.consumed) {
    const verdict = await usedUpRequestVerdict(runtime, identity.agentId, pending.request.scopes)
    if (verdict === "refuse") {
      throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
    }
    return { kind: verdict }
  }
  return { kind: "advice", advice: await grantAdviceFor(runtime, name, pending.request, identity.manifest) }
}

/** Spec §5B steps 3–4: the owner approves the pending request on-chain; the agent checks the result and keeps the grant. */
export async function approve(
  runtime: Runtime,
  name: string,
  cwd?: string,
  confirm?: (preview: ApprovePreview) => Promise<boolean>,
): Promise<{
  capabilityIds: Hex[]
  permissions: number[]
  transactionHash: Hex | null
  gasUsed: bigint
  /** UF-AP: the grant's transaction had already landed when this ran (its earlier reply was lost) — the approval was finished locally without sending anything. */
  completedEarlier?: boolean
  /** UF-AP: the chain approves the agent but this machine holds no recorded grant for it — reads and saves will refuse until the repair the CLI prints is run. */
  unrecorded?: boolean
  projectId?: string
  projectAlreadyListed?: boolean
  droppedRows?: number | null
}> {
  const { home, vault, reader, owner } = runtime
  // When a project folder is given its marker is resolved first: a folder that may not hold a
  // project (the owner's home, the filesystem root) is refused with not-a-project before any
  // transaction can go out. The list entry itself is written only after the grant succeeds.
  const marker = cwd === undefined ? undefined : ensureProjectMarker(cwd)
  const identity = loadAgentIdentity(home, name)
  if (identity === undefined) throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)

  // The policy's expected grant minus what the CHAIN says is already live. An agent approved under
  // the old single `projects.current` scope (an M1 home) is missing exactly the two READ scopes —
  // those, and only those, get asked for below.
  runtime.progress?.(`asking the chain what ${name} already holds…`)
  const missing = await missingExpectedScopes(runtime, identity.agentId, identity.purposeId)
  const live = await hasAnyLiveCapability(runtime, identity.agentId)
  // M3-D4: a revoke that failed after its deny was staged leaves the store blocking an agent the
  // chain approves. The cleanup runs before EVERY branch below because the deny would poison any of
  // them: the grant path's own wrap publish gets CAPABILITY_DENIED, and the already-approved answer
  // would tell the owner nothing is wrong while the store still refuses the agent.
  const cleared = await clearStaleStoreDenies(runtime, identity.agentId, name)
  if (cleared > 0) {
    const repair = await repairReaderWraps(runtime, undefined, identity.agentId)
    for (const failure of repair.failed) {
      runtime.progress?.(`note: could not send the new key to ${failure.name}: ${displaySafeLine(failure.reason, 300)} — run \`mida approve ${failure.name}\``)
    }
  }
  let pending = home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)

  // When the chain already approves the agent there is nothing to send — but if the command ran in
  // a project folder, the honest next step is the local list row, which is what the owner was asking
  // for. The result says whether the row was new so the CLI can say "now approved" only when it was.
  // `assistant` is never listed: it gets no project approval, ever.
  const alreadyApprovedResult = async () => {
    // UF-APR3: "already approved" is still a chance to repair. An earlier approve may have died
    // after the grant landed but before its key re-send finished; this run re-sends the keys for
    // this agent's granted READ namespaces to every reader of them, so the command the failure
    // notes name does the work it promises. The strict chain read stays first: a read that
    // throws must fail the command with nothing changed, never after a repair ran.
    const covering = pending?.request.scopes ?? expandScopeInputs(expectedScopesFor(identity.purposeId))
    // UF-APR5 F6: the live-id read feeds only the folder path's unrecorded check below — on that
    // path the strict ordering stands (a read that throws fails the command before anything
    // changed). With no folder to list the read is dead work, and a failed one must not mask the
    // already-approved answer: the stale-deny pass above already ran and named every store block
    // it could not check, which is the information the owner needs.
    const folderRow = cwd !== undefined && identity.purposeId === PURPOSE_ID
    let liveIds: Set<string> | undefined
    if (folderRow) {
      try {
        liveIds = await liveCapabilityIdsOf(runtime.reader, runtime.owner, identity.agentId)
      } catch (error) {
        throw codedError("approval-check-failed", `the chain could not be read while checking ${name}'s approval: ${displaySafeLine(error instanceof Error ? error.message : String(error), 300)}`)
      }
    }
    // UF-APR4 + UF-APR5 F1: the pass runs only while wraps-owed.json says a send is owed, and it
    // covers the namespaces the MARKER names — every reader of them — not only the ones this
    // agent happens to hold. A marker in the old shape (no list) owes every reader namespace.
    const owed = wrapsOwed(home)
    if (owed !== undefined) {
      try {
        const repair = await repairReaderWraps(runtime, owed.namespaces ?? EVERY_READER_NAMESPACE)
        for (const failure of repair.failed) {
          runtime.progress?.(`note: could not send the new key to ${failure.name}: ${displaySafeLine(failure.reason, 300)} — run \`mida approve ${failure.name}\``)
        }
      } catch (error) {
        runtime.progress?.(
          `note: ${name} is approved, but Mida could not send the key to the other agents: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida approve ${name}\` again to finish`,
        )
      }
    }
    // UF-APR5 F3: on this path the chain approves the agent, so a revoked.json left behind by a
    // failed cleanup is stale by definition — the retry every removal note names must clear it.
    removeStaleFile(runtime, name, `agents/${name}/revoked.json`)
    if (cwd === undefined || identity.purposeId !== PURPOSE_ID) {
      // UF-APR7: a general-assistance grant is init's to send and finish — when the chain approves
      // it but this machine never recorded it (init's lost reply), "already approved" hides the
      // only repair that works, so the refusal names it. A live-id read that fails keeps the
      // already-approved answer exactly as before: nothing here may mask it.
      if (identity.purposeId !== PURPOSE_ID) {
        const ids = liveIds ?? (await liveCapabilityIdsOf(runtime.reader, runtime.owner, identity.agentId).catch(() => undefined))
        if (ids !== undefined && !recordedCoverage(home, name, ids, covering)) {
          // UF-APR7B R1: "run mida init" is the repair only while init still holds a request it
          // can finish with — the same check init and doctor make. Without one the only repair
          // left is revoke-then-init, and naming init instead would loop the owner straight
          // back to this refusal.
          throw codedError(
            "assistant-grant-via-init",
            initCanFinishGrant(home, name, identity.agentId)
              ? `${name}'s grant is sent by mida init, not approve. Run mida init to finish recording it.`
              : `${name} is approved on chain, but this machine never finished recording that approval, so ${name} cannot read. Run mida revoke ${name}, then mida init.`,
          )
        }
      }
      throw codedError("already-approved", `agent "${name}" is already approved`)
    }
    if (confirm !== undefined && !(await confirm({ kind: "project", agent: name, projectId: marker!.projectId }))) throw notApprovedError()
    // UF-AP: "approved on chain" is only half the truth — when no saved grant covers the scopes
    // this approval was for, the agent still cannot read or save here, and the result must say
    // so instead of answering like an ordinary approval.
    // UF-APR2: the chain read runs BEFORE the folder row is written — a read that throws must
    // fail the command with nothing written, not list the folder and then fail.
    const listed = await approveProject(runtime, { agent: name, cwd }).catch((error: unknown) => {
      throw approvedUnlisted(name, error)
    })
    const unrecorded = !recordedCoverage(home, name, liveIds!, covering)
    return { capabilityIds: [] as Hex[], permissions: [] as number[], transactionHash: null, gasUsed: 0n, ...(unrecorded ? { unrecorded: true } : {}), projectId: listed.approval.projectId, projectAlreadyListed: listed.alreadyListed, droppedRows: listed.droppedRows }
  }

  if (pending !== undefined) {
    const stored = await new FileAccessRequestStore(home, name).load(pending.request.requestId)
    if (stored === undefined || stored.consumed) {
      // UF-APR4 D2 + UF-APR5 F4: a request this run cannot use — consumed already, or its record
      // gone — is judged by the chain, through the same verdict approve --all's gate applies.
      // Every scope still live: the grant landed and only the post-grant cleanup failed last
      // time, so finish as D2 does — remove the stale markers and answer from the
      // already-approved path, which also finishes any sends the owed-keys marker still records.
      // Part live — a partly expired grant, the case that used to loop approve ↔ request — drops
      // the stale request file and falls through to the upgrade path below, which re-asks only
      // the missing scopes. Nothing live — a revoked agent, a request that genuinely never
      // completed — keeps the refusal.
      const verdict = await usedUpRequestVerdict(runtime, identity.agentId, pending.request.scopes)
      if (verdict === "finish") {
        // UF-APR5 F3: the grant is live — these removals are the cleanup a failed earlier approve
        // left behind, so a removal that fails again is a note, not a bare refusal.
        removeStaleFile(runtime, name, `agents/${name}/pending-request.json`)
        removeStaleFile(runtime, name, `agents/${name}/revoked.json`)
        return alreadyApprovedResult()
      }
      if (verdict === "refuse") throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
      removeStaleFile(runtime, name, `agents/${name}/pending-request.json`)
      pending = undefined
    }
  }

  if (pending === undefined) {
    if (missing.length === 0) {
      if (!live) throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
      return alreadyApprovedResult()
    }
    if (!live) throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
    // The upgrade path: the agent holds part of the grant (a live capability exists) and no request
    // is pending — sign one for exactly the scopes the chain says are missing, then approve it below.
    const request = await runtime.agent(name).createAccessRequest({
      purposeId: identity.purposeId,
      scopes: missing.map((s) => ({ namespace: namespaceById(s.namespaceId).name, permissions: s.permissions, provenancePolicy: s.provenancePolicy })),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
    })
    home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
    pending = { request }
  }
  // Only what the chain does not already authorize is granted — a request whose scopes are all live
  // mints nothing, so a second approve sends no transaction.
  const needed = await ungrantedScopes(runtime, identity.agentId, pending.request.scopes)
  // A pending request whose scopes are all already live is normally the same answer: nothing to
  // send, but the folder still gets its list row — this is the path the Sep-22 incident hit.
  // UF-AP first: when this machine never completed THIS request (its grant transaction landed but
  // the reply was lost), the honest move is to finish that approval — the grant is found on chain
  // and recorded through the same SDK check, and no transaction goes out.
  if (needed.length === 0) {
    const unfinished = !loadGrants(home, name).some((grant) => grant.requestId === pending.request.requestId)
    if (unfinished) {
      // UF-APR: a chain or store call that THROWS during the finish is not "the grant was not
      // found" — nothing local was written, and the coded refusal keeps the owner off the
      // revoke-and-repair advice for what may just be a busy RPC.
      let grant: Grant | undefined
      try {
        grant = await finishOnChainApproval(runtime, name, identity.agentId, pending.request)
      } catch (error) {
        throw codedError("approval-check-failed", `the chain could not be read while finishing ${name}'s approval: ${displaySafeLine(error instanceof Error ? error.message : String(error), 300)}`)
      }
      if (grant !== undefined) {
        const listed =
          cwd === undefined || identity.purposeId !== PURPOSE_ID
            ? undefined
            : // The folder asks the same typed yes alreadyApprovedResult asks — the grant is
              // already recorded either way, so a decline leaves the row unwritten.
              await (async () => {
                if (confirm !== undefined && !(await confirm({ kind: "project", agent: name, projectId: marker!.projectId }))) throw notApprovedError()
                return approveProject(runtime, { agent: name, cwd }).catch((error: unknown) => {
                  throw approvedUnlisted(name, error)
                })
              })()
        return {
          capabilityIds: grant.capabilities.map((capability) => capability.capabilityId),
          permissions: grant.capabilities.map((capability) => capability.permissions),
          transactionHash: null,
          gasUsed: 0n,
          completedEarlier: true,
          ...(listed === undefined ? {} : { projectId: listed.approval.projectId, projectAlreadyListed: listed.alreadyListed, droppedRows: listed.droppedRows }),
        }
      }
    }
    return alreadyApprovedResult()
  }
  // The owner sees the ask and the advisor's advice before anything is signed — only an explicit
  // confirm gets past this point. The question and the answer live in the CLI, which injects it.
  if (confirm !== undefined) {
    const advice = await grantAdviceFor(runtime, name, pending.request, identity.manifest)
    if (!(await confirm({ kind: "grant", agent: name, requested: pending.request.scopes, scopes: needed, expiresAt: decodeUint64(pending.request.capabilityExpiresAt), advice }))) throw notApprovedError()
  }
  // A READ grant that expired closes the namespace's write epoch (§7.3): grantBatch reverts
  // EpochRotationRequired until the owner rotates it, and every surviving reader then needs a wrap
  // for the new epoch — so each rotated namespace is followed by the same repair pass a revoke runs.
  const rotated: Hex[] = []
  for (const nsId of [...new Set(needed.map((s) => s.namespaceId))]) {
    if (!(await reader.isWriteEpochValid(owner, nsId, await reader.requiredReadEpoch(owner, nsId)))) {
      runtime.progress?.(`rotating the ${namespaceById(nsId).name} epoch…`)
      await vault.rotateExpiredEpoch(nsId)
      rotated.push(nsId)
      // UF-APR4: the moment an epoch turns, every other reader's wraps are dead — the debt exists
      // whether or not the grant below ever lands. UF-APR5 F1: the marker names this namespace.
      markWrapsOwed(home, [nsId])
    }
  }
  runtime.sendProgress("sending the grant")
  // UF-APR5 F2: approveGrant's last steps are the agent's own read-key publishes — one per READ
  // capability, each a chain read — so a dropped connection there arrives as an error while the
  // grant is already LIVE on chain. What the error already proves is honoured first: the chain
  // write layer marks failures it knows happened before any send (`failedBeforeSend`), and the
  // request-validation refusals below can only be thrown before the transaction goes out — both
  // keep their own honest line. Anything else asks the chain whether the agent now holds every
  // scope the request asked for. Landed means the send succeeded and only the finishing steps
  // died; anything less — or a check that itself cannot run — is still "unconfirmed", never
  // "nothing was sent".
  let approval: Awaited<ReturnType<typeof vault.approveGrant>>
  try {
    approval = await vault.approveGrant({
      accessRequest: pending.request,
      manifest: identity.manifest,
      selection: { kind: "custom", scopes: needed, expiresAt: decodeUint64(pending.request.capabilityExpiresAt) },
    })
  } catch (error) {
    if (failedBeforeSend(error) || (error instanceof MidaError && APPROVE_REQUEST_REFUSAL_CODES.has(error.code))) throw error
    // The owed-keys marker goes down before either coded refusal: if the grant did land, its
    // readers' sends are owed work a later `mida approve` must see.
    try {
      markWrapsOwed(home, [
        ...new Set<Hex>([
          ...needed.filter((scope) => (scope.permissions & PERMISSION.READ) !== 0).map((scope) => scope.namespaceId),
          ...rotated,
        ]),
      ])
    } catch {
      // the marker is bookkeeping; it must never mask the real failure
    }
    const landed = await ungrantedScopes(runtime, identity.agentId, pending.request.scopes)
      .then((missing) => missing.length === 0)
      .catch(() => false)
    if (landed) {
      throw codedError(
        "grant-landed-unfinished",
        `the grant for ${name} landed on Monad, but Mida could not finish setting it up: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida approve ${name}\` again to finish; it sends no new grant`,
      )
    }
    // UF-AP: a wallet-low refusal the chain clears of a landed grant already carries the honest
    // sentence — the sponsor refused or timed out and the wallet could not pay — and the refusal
    // line adds the timeout retry hint. Recasting it as "sent but unconfirmed" would claim a send
    // the seam never saw and hide the shortfall the owner needs.
    if (isMidaError(error, "OWNER_WALLET_LOW")) throw error
    // UF-APR6 G2: a send whose outcome is still open keeps its own advice. SEND_TIMEOUT names a
    // hash (or an attempted send) and says "don't run the command again until `mida doctor` shows
    // the result"; SPONSOR_PENDING says the accepted operation may still land and a re-run asks
    // the chain first. The chain check just found nothing landed, so wrapping either as "the
    // grant was sent — run `mida approve` again" prints a second instruction that contradicts
    // the first.
    if (isMidaError(error, "SEND_TIMEOUT") || isMidaError(error, "SPONSOR_PENDING")) throw error
    throw codedError(
      "grant-unconfirmed",
      `the grant for ${name} was sent to Monad, but Mida could not confirm it: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida approve ${name}\` again to finish; it sends nothing new if the grant landed`,
    )
  }
  const agent = runtime.agent(name)
  runtime.progress?.("proving the grant on the chain…")
  let grant: Grant
  try {
    grant = await agent.completeAccessRequest(pending.request, approval.response)
  } catch (error) {
    // UF-APR4 D3: approveGrant already returned — the grant transaction went out. A refusal code
    // from the SDK's own check keeps its meaning, but every other throw here (a receipt read
    // that died, a rate limit) is a confirmation that never RAN, not an approval that never
    // happened: the grant may be live on chain. The wrapper carries no `cause` on purpose —
    // chainErrorKind walks causes, and one holding a transport error would re-classify this as
    // chain-busy, the line that claims nothing was sent.
    if (error instanceof MidaError && (SDK_REFUSAL_CODES as readonly string[]).includes(error.code)) throw error
    throw codedError(
      "grant-unconfirmed",
      `the grant for ${name} was sent to Monad, but Mida could not confirm it: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida approve ${name}\` again to finish; it sends nothing new if the grant landed`,
    )
  }
  saveGrants(home, name, [...agent.grants])
  const grantReadNamespaces = grant.capabilities.filter((capability) => (capability.permissions & PERMISSION.READ) !== 0).map((capability) => capability.namespaceId)
  // UF-APR4 D1 + UF-APR5 F1: the owed-keys marker is written the moment the grant is safe —
  // before the marker removals, the folder row and the re-send — so a crash in ANY later step
  // leaves a debt the next approve can see and finish, and it names exactly the namespaces the
  // sends are owed for. A grant with no READ side and no rotation owes no wraps.
  if (grantReadNamespaces.length > 0 || rotated.length > 0) {
    markWrapsOwed(home, [...new Set<Hex>([...grantReadNamespaces, ...rotated])])
  }
  // UF-APR3: once the grant is safe on disk and on chain, nothing later may strand the
  // approval: the stale-revoke marker and the consumed request go first, then the folder row.
  // Only the key re-send is left, and it is the one step a retry can still repair.
  // UF-APR5 F3: a removal that fails here (EPERM) is a note naming the retry, never a bare error.
  removeStaleFile(runtime, name, `agents/${name}/revoked.json`)
  removeStaleFile(runtime, name, `agents/${name}/pending-request.json`)
  // Every reader of the granted READ namespaces gets the key re-sent, always, not only when this
  // run rotated. An earlier approve may have replaced an expired key and then died before the
  // grant send; this run cannot see that, and skipping the re-send leaves every other reader
  // failing NO_EPOCH_WRAP. Rotated namespaces already in the grant's list are sent once. The pass
  // itself is best-effort: a throw here (the RPC dying mid-enumeration) must not fail an approval
  // that already succeeded, so it becomes a note naming the one command that finishes it.
  const repairNamespaces = [...new Set<Hex>([...grantReadNamespaces, ...rotated])]
  if (repairNamespaces.length > 0) {
    try {
      // approveGrant already published this agent's wrap for every READ namespace it granted;
      // the pass owes those namespaces to the OTHER readers only.
      const repair = await repairReaderWraps(runtime, repairNamespaces, undefined, { agentId: identity.agentId, namespaceIds: grantReadNamespaces }, rotated.length > 0)
      for (const failure of repair.failed) {
        runtime.progress?.(`note: could not send the new key to ${failure.name}: ${displaySafeLine(failure.reason, 300)} — run \`mida approve ${failure.name}\``)
      }
    } catch (error) {
      runtime.progress?.(
        `note: ${name} is approved, but Mida could not send the key to the other agents: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`mida approve ${name}\` again to finish`,
      )
    }
  }
  // UF-APR4 D4: the folder row is written AFTER the re-send, not before — a list read that dies
  // here can no longer skip the sends the rotated keys owe the other readers. The error is still
  // thrown (the row is genuinely missing), but approvedUnlisted makes its line say the agent IS
  // approved and name the retry that adds the folder.
  const listed =
    cwd === undefined || identity.purposeId !== PURPOSE_ID
      ? undefined
      : await approveProject(runtime, { agent: name, cwd }).catch((error: unknown) => {
          throw approvedUnlisted(name, error)
        })
  return {
    capabilityIds: grant.capabilities.map((capability) => capability.capabilityId),
    permissions: grant.capabilities.map((capability) => capability.permissions),
    transactionHash: approval.response.capabilities[0]!.transactionHash as Hex | null,
    gasUsed: approval.gasUsed,
    ...(listed !== undefined ? { projectId: listed.approval.projectId, droppedRows: listed.droppedRows } : {}),
  }
}

// ── UF-AP: finishing an approval that landed on chain but was never recorded ──────────────────
// A grant transaction whose reply was lost (the sponsor timed out) leaves pending-request.json
// behind while the chain already approves the agent — and approve's `needed.length === 0` branch
// would then answer "already approved" forever, with the agent's reads refusing CAPABILITY_DENIED.
// The finish below sends nothing: it finds the transaction that emitted CapabilityGranted for
// the pending request's capabilities inside the request's own validity window, rebuilds the
// exact AccessGrantResponse approveGrant would have returned, republishes the read keys the same
// way, and hands the response to completeAccessRequest — the only path a grant is ever recorded
// through. A lookup that cannot find the transaction writes nothing and reports "unrecorded".

/**
 * The grant can only have been mined while the request was valid: the scan window is
 * [issuedAt - 60 s, requestExpiresAt + 120 s] (clock skew and mining lag on either side), and a
 * window wider than this cap is treated as "not found" rather than scanned — the log scan is
 * never unbounded.
 */
const GRANT_TX_MARGIN_BEFORE_S = 60n
const GRANT_TX_MARGIN_AFTER_S = 120n
const GRANT_TX_MAX_BLOCKS = 6_000n

const CAPABILITY_GRANTED_EVENT = capabilityRegistryAbi.find(
  (entry) => entry.type === "event" && entry.name === "CapabilityGranted",
) as AbiEvent

/** The first block in [lo, hi] whose timestamp is >= `timestamp` — undefined when none qualifies. */
async function blockAtOrAfter(get: (blockNumber: bigint) => Promise<{ timestamp: bigint }>, timestamp: bigint, lo: bigint, hi: bigint): Promise<bigint | undefined> {
  if (lo > hi || (await get(hi)).timestamp < timestamp) return undefined
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if ((await get(mid)).timestamp >= timestamp) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/** The last block in [lo, hi] whose timestamp is <= `timestamp` — undefined when none qualifies. */
async function blockAtOrBefore(get: (blockNumber: bigint) => Promise<{ timestamp: bigint }>, timestamp: bigint, lo: bigint, hi: bigint): Promise<bigint | undefined> {
  if (lo > hi || (await get(lo)).timestamp > timestamp) return undefined
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    if ((await get(mid)).timestamp <= timestamp) lo = mid
    else hi = mid - 1n
  }
  return lo
}

/**
 * The CapabilityGranted logs this request's grant emitted, found inside the request's validity
 * window — [issuedAt - 60 s, requestExpiresAt + 120 s] of block timestamps, resolved by binary
 * search on getBlock and capped at GRANT_TX_MAX_BLOCKS so a strange clock can never open an
 * unbounded scan. undefined when no transaction qualifies.
 */
async function findGrantLogs(runtime: Runtime, request: AccessRequest, capabilityIds: ReadonlySet<string>): Promise<DecodedLog[] | undefined> {
  // Scope coverage alone cannot identify THIS request's grant — the same scopes approved under
  // a different request would otherwise masquerade as the lost reply. The event's context
  // carries the request hash the vault computed, so matching it is the binding check.
  const requestHashExpected = accessRequestHash(request).toLowerCase()
  const client = runtime.chain.publicClient
  const deployment = runtime.network.deployment
  const latest = await client.getBlock()
  const fromTs = decodeUint64(request.issuedAt) - GRANT_TX_MARGIN_BEFORE_S
  const toTs = decodeUint64(request.requestExpiresAt) + GRANT_TX_MARGIN_AFTER_S
  if (latest.timestamp < fromTs) return undefined
  const floor = deployment.deploymentBlock < latest.number ? deployment.deploymentBlock : latest.number
  const get = (blockNumber: bigint) => client.getBlock({ blockNumber })
  const fromBlock = await blockAtOrAfter(get, fromTs, floor, latest.number)
  if (fromBlock === undefined) return undefined
  const toBlock = await blockAtOrBefore(get, toTs, fromBlock, latest.number)
  if (toBlock === undefined || toBlock - fromBlock + 1n > GRANT_TX_MAX_BLOCKS) return undefined
  const logs = await getLogsChunked(client, {
    address: deployment.capabilityRegistry,
    event: CAPABILITY_GRANTED_EVENT,
    args: { owner: runtime.owner, agentId: request.agentId },
    fromBlock,
    toBlock,
  })
  const found = logs.filter((log) => {
    const context = log.args.context as { requestHash?: unknown } | undefined
    return (
      log.transactionHash !== null &&
      typeof log.args.capabilityId === "string" &&
      capabilityIds.has(log.args.capabilityId.toLowerCase()) &&
      typeof context?.requestHash === "string" &&
      context.requestHash.toLowerCase() === requestHashExpected
    )
  })
  return found.length === 0 ? undefined : found
}

/**
 * Rebuilds the AccessGrantResponse approveGrant would have returned, from a grant transaction's
 * CapabilityGranted logs: the same fields, the capabilities taken from the found logs only.
 * Exported so the recovery tests can prove the unchanged SDK check refuses a response that
 * names a capability the request never got.
 */
export function grantResponseFromLogs(request: AccessRequest, owner: Address, logs: readonly DecodedLog[]): AccessGrantResponse {
  return {
    v: 1,
    chainId: request.chainId,
    capabilityRegistry: request.capabilityRegistry,
    requestId: request.requestId,
    nonce: request.nonce,
    requestHash: accessRequestHash(request),
    owner,
    agentId: request.agentId,
    manifestHash: request.manifestHash,
    manifestVersion: request.manifestVersion,
    policyVersion: POLICY_VERSION,
    namespaceTreeVersion: NAMESPACE_TREE_VERSION,
    capabilities: logs.map(
      (log): GrantedCapability => ({
        namespaceId: log.args.namespaceId as Hex,
        permissions: Number(log.args.permissions),
        provenancePolicy: Number(log.args.provenancePolicy),
        expiresAt: encodeUint64(log.args.expiresAt as bigint),
        capabilityId: log.args.capabilityId as Hex,
        transactionHash: log.transactionHash!,
      }),
    ),
  }
}

/**
 * Finishes an approval the chain already holds — no transaction is sent. Returns the grant the
 * unchanged SDK check accepted; undefined when the grant's transaction cannot be found inside
 * the request's window or the rebuilt response fails the SDK's validation (the caller then
 * reports the approval as unrecorded). A chain or store call that throws reaches the caller
 * as a throw: "cannot read the chain" is not "not found".
 */
async function finishOnChainApproval(runtime: Runtime, name: string, agentId: Hex, request: AccessRequest, retry = `mida approve ${name}`): Promise<Grant | undefined> {
  const { home, reader, owner, vault } = runtime
  // The live capabilities matching the pending request's scopes — the same records
  // ungrantedScopes asked about above, read again so each id can be named in the log scan.
  const now = await reader.now()
  const wanted = new Set<string>()
  for (const id of await reader.activeCapabilityIds(owner, agentId)) {
    const view = await reader.getCapability(id)
    if (view === null || view.revoked || (view.expiresAt !== 0n && now >= view.expiresAt)) continue
    const covers = request.scopes.some(
      (scope) =>
        scope.namespaceId.toLowerCase() === view.namespaceId.toLowerCase() &&
        (view.permissions & scope.permissions) === scope.permissions &&
        view.provenancePolicy === scope.provenancePolicy,
    )
    if (covers) wanted.add(id.toLowerCase())
  }
  if (wanted.size === 0) return undefined
  const logs = await findGrantLogs(runtime, request, wanted)
  if (logs === undefined) return undefined
  const response = grantResponseFromLogs(request, owner, logs)
  // The read keys the normal send publishes before its response returns — skipped here once
  // meant the grant verified while the agent still could not unwrap what it read.
  const readNamespaces = [...new Set(response.capabilities.filter((capability) => (capability.permissions & PERMISSION.READ) !== 0).map((capability) => capability.namespaceId))]
  try {
    for (const nsId of readNamespaces) {
      await vault.publishReaderWraps({ agentId, namespaceId: nsId })
    }
    // The lost first try may also have replaced an expired key, which invalidated every other
    // reader's wraps — recovery cannot tell, so it re-sends the new key to every approved reader
    // over these namespaces, the same pass the normal path runs after a rotation. The agent's own
    // wraps went out above, so the pass owes those namespaces to the other readers only.
    const repair = await repairReaderWraps(runtime, readNamespaces, undefined, { agentId, namespaceIds: readNamespaces })
    for (const failure of repair.failed) {
      runtime.progress?.(`note: could not send the new key to ${failure.name}: ${displaySafeLine(failure.reason, 300)} — run \`mida approve ${failure.name}\``)
    }
  } catch (error) {
    // UF-APR4 + UF-APR5 F1: an interrupted re-send here is owed work — the marker names these
    // namespaces so a later plain `mida approve <name>` finishes it. repairReaderWraps marks its
    // own throws; this also covers the agent's own-wrap publishes above.
    try {
      markWrapsOwed(home, readNamespaces)
    } catch {
      // the real failure stands on its own
    }
    throw error
  }
  const agent = runtime.agent(name)
  // A refusal from the SDK's own check is a clean "not this request's grant" — the caller then
  // falls back to the unrecorded answer. Anything else (a network failure, a rate limit) is a
  // check that could not run, and the throw reaches the caller as approval-check-failed.
  let grant: Grant | undefined
  try {
    grant = await agent.completeAccessRequest(request, response)
  } catch (error) {
    if (error instanceof MidaError && (SDK_REFUSAL_CODES as readonly string[]).includes(error.code)) return undefined
    throw error
  }
  if (grant === undefined) return undefined
  saveGrants(home, name, [...agent.grants])
  // A marker left by an earlier revoke must not outlive a fresh approval — same as the send path.
  // UF-APR5 F3: a removal that fails here is a note naming the retry, never a bare error.
  // UF-APR7B R5: the retry is the caller's — init's finish of the assistant grant names
  // `mida init`, because `mida approve assistant` is refused and would never remove them.
  removeStaleFile(runtime, name, `agents/${name}/revoked.json`, retry)
  removeStaleFile(runtime, name, `agents/${name}/pending-request.json`, retry)
  return grant
}

/**
 * The requests init saved before it sent the assistant's grant (UF-APR7), read back by the
 * re-run that finishes a landed-but-unrecorded approval, in file order — appends land last, so
 * the newest request is at the end. Both the `{ requests: [...] }` list shape and the pre-list
 * `{ request }` shape are read. Only requests signed for THIS identity count: a missing,
 * unreadable or foreign file answers [], which is the pre-0.1.3 case — the owner gets the
 * revoke-then-init line instead.
 */
function readInitGrantRequests(home: MidaHome, name: string, agentId: Hex): AccessRequest[] {
  try {
    const raw = home.readJson<{ request?: AccessRequest; requests?: AccessRequest[] }>(`agents/${name}/init-grant-request.json`)
    const list =
      raw === undefined ? [] : [...(Array.isArray(raw.requests) ? raw.requests : []), ...(raw.request === undefined ? [] : [raw.request])]
    return list.filter(
      (request): request is AccessRequest =>
        request !== null &&
        typeof request === "object" &&
        typeof request.agentId === "string" &&
        request.agentId.toLowerCase() === agentId.toLowerCase(),
    )
  } catch {
    return []
  }
}

/**
 * UF-APR7B R1: the ONE answer approve, doctor and init must agree on — "can `mida init` finish
 * this approval?" Only when the saved file still parses and holds at least one request signed
 * for this identity. File existence alone proved nothing (a corrupt file or another agent's
 * request finishes nothing), and advice built on it sent the owner round an init loop that
 * could only end in the revoke line anyway.
 */
export function initCanFinishGrant(home: MidaHome, name: string, agentId: Hex): boolean {
  return readInitGrantRequests(home, name, agentId).length > 0
}

/**
 * The agent's capability ids that are live on the chain right now — the raw
 * activeCapabilityIds list keeps expired and revoked entries until a later write compacts it,
 * so each id is re-read before it counts.
 */
export async function liveCapabilityIdsOf(reader: RegistryReader, owner: Address, agentId: Hex): Promise<Set<string>> {
  const now = await reader.now()
  const live = new Set<string>()
  for (const id of await reader.activeCapabilityIds(owner, agentId)) {
    const view = await reader.getCapability(id)
    if (view !== null && !view.revoked && (view.expiresAt === 0n || now < view.expiresAt)) live.add(id.toLowerCase())
  }
  return live
}

/**
 * Whether this machine's saved grants cover every scope the agent is expected to hold — each
 * scope by SOME recorded capability, in ANY grant entry, whose id is one of the agent's live
 * capability ids on chain. Approve's unrecorded answer and doctor's approved line share this
 * one rule: a saved grant whose capabilities are all dead on chain is no record of the current
 * approval, and a grants file that cannot be read counts as no record.
 */
export function recordedCoverage(home: MidaHome, name: string, liveCapabilityIds: ReadonlySet<string>, scopes: readonly RequestedScope[]): boolean {
  let grants: Grant[]
  try {
    grants = loadGrants(home, name)
  } catch {
    grants = []
  }
  return scopes.every((scope) =>
    grants.some((grant) =>
      grant.capabilities.some(
        (capability) =>
          liveCapabilityIds.has(capability.capabilityId.toLowerCase()) &&
          capability.namespaceId.toLowerCase() === scope.namespaceId.toLowerCase() &&
          (capability.permissions & scope.permissions) === scope.permissions &&
          capability.provenancePolicy === scope.provenancePolicy,
      ),
    ),
  )
}

// The saved-id index moved to saved-ids.ts so batching.ts — which skeleton already imports —
// can keep it pointed at a resubmitted save's fresh contextId without an import cycle.

/** The gas facts a drain's saved line logs — wei as decimal strings, so a bigint never reaches JSON.stringify. */
export interface SaveReceipt {
  gasUsed: string
  gasLimit: string
  effectiveGasPrice: string
  /** The path the send actually took — not the configuration. A sponsored save arrives inside a bundle
   *  addressed to the account-abstraction entrypoint; a self-paid send addresses the registry contract. */
  sponsored: boolean
}

/**
 * The SDK's create keeps only the transaction hash — the gas numbers the drain log needs live on the
 * mined transaction, so the hash buys one read-back: the receipt for gas used and the price actually
 * paid, the transaction for the gas limit it was sent with and the contract it went to. A read-back
 * failure must not fail a save that already landed: the caller just gets no receipt.
 */
async function saveReceipt(runtime: ServiceRuntime, transactionHash: Hex): Promise<SaveReceipt | undefined> {
  try {
    const [receipt, transaction] = await Promise.all([
      runtime.chain.publicClient.getTransactionReceipt({ hash: transactionHash }),
      runtime.chain.publicClient.getTransaction({ hash: transactionHash }),
    ])
    return {
      gasUsed: receipt.gasUsed.toString(),
      gasLimit: transaction.gas.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      sponsored: transaction.to?.toLowerCase() === entryPoint08Address.toLowerCase(),
    }
  } catch {
    return undefined
  }
}

/** Spec §5C steps 4–5: wrap, encrypt, upload and register on Monad under the agent's own key. A second save carrying
 * an eventId this project already has is a drainer retry after a crash — answer with the existing record, send nothing. */
export async function saveCheckpoint(runtime: ServiceRuntime, name: string, input: Omit<CheckpointEnvelope, "type">): Promise<{ contextId: Hex; transactionHash: Hex | null; milliseconds: number; duplicate: boolean; lane?: "direct" | "batched"; laneWhy?: string; batched?: { state: "QUEUED"; receipt?: BatchReceipt }; receipt?: SaveReceipt; receiptMs?: number }> {
  const envelope = wrapCheckpoint(input)
  const started = Date.now()
  const agent = runtime.agent(name)
  // The local index answers a retry without touching the chain at all — but never for an agent
  // the owner has revoked: the marker is set on revoke and cleared on re-approval, and an index
  // hit that skipped this check would let a revoked agent "save" after its authority ended.
  const known = readSavedIds(runtime.home)[envelope.checkpoint.eventId]
  if (known !== undefined) {
    if (isRevoked(runtime.home, name)) throw new MidaError("CAPABILITY_REVOKED", `agent ${name} has been revoked`)
    return { contextId: known, transactionHash: null, milliseconds: Date.now() - started, duplicate: true }
  }
  // Which lane this save takes — one shared transaction (batched) or its own (direct). The
  // decision may throw (an unreadable network.json); a failed decision is still a direct save —
  // never a dropped save — and the drain log names the reason as laneWhy.
  let lane: Lane
  let laneWhy: string | undefined
  try {
    lane = await laneForSave(runtime, name)
    // "switch-off" is the everyday answer and needs no explanation on the line; the other whys
    // all mean the setup asked for batching and could not get it — worth recording once per save
    if (lane.kind === "direct" && lane.why !== "switch-off") laneWhy = lane.why
  } catch (error) {
    lane = { kind: "direct", why: "switch-off" }
    laneWhy = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "decision-failed"
  }
  // The duplicate check asks one question — does this project already hold this eventId — and the
  // answer lives inside the sealed payload, so it opens every row locally (the epoch key fetch is
  // shared per epoch) and spends chain verification only on a row that claims the match (in-12
  // N-6): a burst of N earlier batched saves no longer re-verifies all N rows per save. On the
  // batched lane the batch queue is a second place a save can already exist — an anchored or
  // still-pending row is as much a duplicate as a directly-anchored one. An agent without READ
  // has nothing readable and proceeds to create (the create itself is what the chain judges);
  // any OTHER read failure is real and must surface — swallowing it would turn a broken
  // connection into a duplicate write.
  let existing: Hex | undefined
  try {
    existing = await agent.findDuplicate(
      runtime.owner,
      NAMESPACE,
      (value) => {
        const found = unwrapCheckpoint(value)
        return found !== null && found.projectId === envelope.projectId && found.checkpoint.eventId === envelope.checkpoint.eventId
      },
      { batched: lane.kind === "batched" },
    )
  } catch (error) {
    if (!isMidaError(error, "CAPABILITY_DENIED")) throw error
  }
  if (existing !== undefined) {
    recordSavedId(runtime.home, envelope.checkpoint.eventId, existing)
    return { contextId: existing, transactionHash: null, milliseconds: Date.now() - started, duplicate: true }
  }
  if (lane.kind === "batched") {
    // The store's receipt only means the save was queued — the pending ledger owns it from here
    // until the chain says ANCHORED or REJECTED. transactionHash stays null: no transaction of
    // this save's own exists yet, and none may ever.
    const create = {
      value: { ...envelope },
      kind: "EPISODE" as const,
      source: "AGENT_INFERRED" as const,
      tags: ["mida-checkpoint", envelope.checkpoint.eventId],
    }
    // in-14 F-3: ALREADY_QUEUED is the queued answer through the error channel — an earlier POST
    // of this save landed at the store and its answer died on the wire. The SDK attaches the
    // attempted contextId to the error; with it the save is followed under the id the store
    // holds, exactly like a receipt. Without it the save cannot be followed and surfaces.
    let queued: { contextId: Hex; receipt?: BatchReceipt } | undefined
    try {
      queued = await agent.createBatched(runtime.owner, NAMESPACE, create)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === "ALREADY_QUEUED") {
        const held = (error as { contextId?: unknown }).contextId
        if (typeof held !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(held)) throw error
        queued = { contextId: held.toLowerCase() as Hex }
      } else if (typeof code === "string" && RESUBMIT_LANE_CLOSED.has(code)) {
        // in-20 T-1: the lane closed between the status check and the POST — a bad batching
        // variable at the store answers BATCH_UNAVAILABLE, the kill switch BATCHING_DISABLED.
        // The answer judges the LANE, not this save: the same bytes go out on the save's own
        // transaction below rather than fail because the lane shut mid-flight.
        laneWhy = "store-disabled"
      } else {
        throw error
      }
    }
    if (queued !== undefined) {
      // The plaintext stays in the home from this moment (in-2 I3): a stale-epoch rejection is
      // only recoverable while the bytes that produced the save exist to re-seal. Written before
      // the pending entry so an entry always implies its plaintext — the reverse is a swept orphan.
      keepPendingPlaintext(runtime.home, queued.contextId, create)
      recordSavedId(runtime.home, envelope.checkpoint.eventId, queued.contextId)
      addPendingAnchor(runtime.home, {
        contextId: queued.contextId,
        eventId: envelope.checkpoint.eventId,
        sessionId: input.sessionId,
        agent: name,
        queuedAt: new Date().toISOString(),
      })
      return {
        contextId: queued.contextId,
        transactionHash: null,
        milliseconds: Date.now() - started,
        duplicate: false,
        lane: "batched",
        // the ALREADY_QUEUED path carries no receipt — the store never wrote one for this POST
        batched: { state: "QUEUED", ...(queued.receipt !== undefined ? { receipt: queued.receipt } : {}) },
      }
    }
  }
  const object = await agent.create(runtime.owner, NAMESPACE, {
    value: { ...envelope },
    kind: "EPISODE",
    source: "AGENT_INFERRED",
    tags: ["mida-checkpoint", envelope.checkpoint.eventId],
  })
  recordSavedId(runtime.home, envelope.checkpoint.eventId, object.contextId)
  const transactionHash = object.transactionHash ?? null
  // the save's own latency ends when the create lands — the read-back below is telemetry,
  // so it is timed apart as receiptMs and never counted into milliseconds
  const milliseconds = Date.now() - started
  let receipt: SaveReceipt | undefined
  let receiptMs: number | undefined
  if (transactionHash !== null) {
    const receiptStart = Date.now()
    receipt = await saveReceipt(runtime, transactionHash)
    receiptMs = Date.now() - receiptStart
  }
  return {
    contextId: object.contextId,
    transactionHash,
    milliseconds,
    duplicate: false,
    lane: "direct",
    ...(laneWhy !== undefined ? { laneWhy } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(receiptMs !== undefined ? { receiptMs } : {}),
  }
}

/**
 * Maps each local agent's on-chain authorId (lower-case) to its local name, for rendering who
 * actually saved a record — never the name the checkpoint claims for itself.
 */
export function authorNamesFor(runtime: ServiceRuntime): Record<string, string> {
  const names: Record<string, string> = {}
  for (const name of listAgentNames(runtime.home)) {
    const identity = loadAgentIdentity(runtime.home, name)
    if (identity !== undefined) names[identity.agentId.toLowerCase()] = name
  }
  return names
}

/**
 * A stored checkpoint plus where it stands with the chain: "ANCHORED" once Monad holds the save —
 * every direct save, and a batched save whose batch landed — and "PENDING_ANCHOR" while a batched
 * save has passed every check that needs no anchor but could still be rejected. Optional because
 * the field only exists on records this reader produces; a mocked read that predates it still
 * typechecks, and absent means the record never came from the batched lane.
 */
export type StoredCheckpoint = CheckpointRecord & { anchor?: "ANCHORED" | "PENDING_ANCHOR" }

/**
 * Spec §5D steps 2–3, plus the BatchAnchor read (plan Task 8): a full protocol read as this agent,
 * then — whenever the deployment carries a BatchAnchor, whether or not batching is switched on —
 * the batch table's anchored and verified-pending saves merged in, marked `anchor` so a pending
 * save is never mistaken for an anchored one. A pending save from a DIFFERENT agent triggers the
 * store flush (Amendment B.4) while the lane is open: `POST /batch/flush` once, then re-reads
 * every 250 ms until those saves anchor or `flushWaitMs` runs out — never a wait when every
 * pending save is the reader's own, and no flush and no wait at all on a closed lane (in-21 U-3).
 * A batched list the store cannot serve leaves `partial` set rather than hiding the gap —
 * and when the store serves no batch surface for this anchor at all, the contract's own
 * `hasBatchedSaves(owner)` flag decides whether there is a table to miss: only a confirmed
 * "none" keeps the read complete, anything else is partial too.
 */
export async function readCheckpoints(
  runtime: ServiceRuntime,
  name: string,
  projectId: string,
  options?: { flushWaitMs?: number },
): Promise<{ checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number; partial: boolean }> {
  if (typeof projectId !== "string" || projectId === "") throw codedError("bad-input", "projectId must be a non-empty string")
  const started = Date.now()
  const agent = runtime.agent(name)
  // readWithStatus, not read: a partial list still yields its checkpoints — the caller flags them
  // rather than the read throwing away work that did verify (M3-D).
  const { objects, partial: directPartial } = await agent.readWithStatus(runtime.owner, NAMESPACE)
  let partial = directPartial
  let skipped = 0
  const checkpoints: StoredCheckpoint[] = []
  const collect = (object: ContextObject, anchor: "ANCHORED" | "PENDING_ANCHOR"): void => {
    const envelope = unwrapCheckpoint(object.payload.value)
    if (envelope === null) {
      skipped += 1
      return
    }
    if (envelope.projectId !== projectId) return
    checkpoints.push({
      checkpoint: envelope.checkpoint,
      projectId: envelope.projectId,
      sessionId: envelope.sessionId,
      continuesSession: envelope.continuesSession,
      compiledBy: envelope.compiledBy,
      contextId: object.contextId,
      authorId: object.authorId,
      namespaceId: object.namespaceId,
      anchor,
      // Monad's placement of the save, when the SDK recovered one — pending saves carry none.
      ...(object.chain === undefined ? {} : { chain: object.chain }),
      // a migrated record's envelope rides on the stored checkpoint as an ordinary typed field —
      // dropped nowhere on the way to the renderers
      ...(envelope.migration === undefined ? {} : { migration: envelope.migration }),
      // same for the named task (tk-1): absent on old records, which read as "main" downstream
      ...(envelope.task === undefined ? {} : { task: envelope.task }),
    })
  }
  for (const object of objects) collect(object, "ANCHORED")

  const deployment = runtime.network?.deployment
  const batchAnchor = deployment?.batchAnchor
  let mergedBatched = false
  if (batchAnchor !== undefined && deployment !== undefined) {
    // The batch table exists only where the store serves it for THIS anchor: the status probe is
    // what decideLane itself asks. But a store that answers nothing — a local store, a pre-batch
    // host — or one answering for another anchor says nothing about what the CHAIN holds: its
    // silence is not proof of an empty table. Only the contract's own hasBatchedSaves flag can
    // say "nothing to miss" — it is set the moment the owner has an accepted batched save and no
    // store outage clears it. A "true", or a read that fails, marks the answer partial rather
    // than letting a route-less store hide batched saves.
    const status = await batchStatusProbe(runtime.apiBaseUrl)
    // the anchor is absent on a degraded lane's answer — only a string it echoed can match
    if (status !== null && typeof status.batchAnchor === "string" && status.batchAnchor.toLowerCase() === batchAnchor.toLowerCase()) {
      const readBatched = async () => {
        try {
          return await agent.readBatchedWithStatus(runtime.owner, NAMESPACE)
        } catch {
          return null
        }
      }
      let batched = await readBatched()
      if (batched === null) {
        // The batch table did not answer though the surface is there — the merged list is
        // incomplete, so partial it is; nothing here may pretend the batch side was empty.
        partial = true
      } else {
        // Agent switch (Amendment B.4): ask the store to anchor the queue now — once per read,
        // and only while the lane is open (in-21 U-3: a closed lane anchors nothing, so the
        // pending rows render marked without a flush call or a wait).
        batched = await flushForeignPending({
          runtime,
          agentName: name,
          deployment,
          enabled: status.enabled,
          batched,
          readBatched,
          flushWaitMs: options?.flushWaitMs ?? FLUSH_WAIT_MS,
        })
        skipped += batched.skipped.length
        if (batched.partial) partial = true
        const directCount = checkpoints.length
        for (const object of batched.anchored) collect(object, "ANCHORED")
        for (const item of batched.pending) collect(item, "PENDING_ANCHOR")
        mergedBatched = checkpoints.length > directCount
      }
    } else {
      // No batch surface for this anchor on this store — ask the chain whether there is a table
      // to miss at all. Fail closed: a thrown read is "unknown", and unknown is never "none".
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
  // A same-second tie that spans the two lanes needs every member's chain placement before
  // the sort below can be trusted — "no block orders first" would otherwise crown whichever
  // lane earned a placement, whatever really landed later (in-13 M-5). The SDK's own tie
  // scan only queries the lane the read listed (a batched record never joins the direct
  // lane's scan), so a cross-lane tie reaches here with the batched member stamped and the
  // direct one not. One bounded re-scan covering BOTH events places the whole second
  // together; a second it cannot complete keeps NO member's placement and the whole group
  // falls to the contextId order — the same rule the scan itself applies to partial answers.
  if (mergedBatched && deployment !== undefined) {
    const bySecond = new Map<bigint, StoredCheckpoint[]>()
    for (const cp of checkpoints) {
      if (cp.chain === undefined) continue
      const list = bySecond.get(cp.chain.at)
      if (list === undefined) bySecond.set(cp.chain.at, [cp])
      else list.push(cp)
    }
    const tied = new Map<bigint, Hex[]>()
    for (const [second, members] of bySecond) {
      if (members.length < 2) continue
      // A second needs the scan only when some pair inside it cannot be ordered without one
      // (in-14 F-1): a member the chain never placed can never compare; a same-block pair
      // orders by their two transaction indexes, or — when both rows carry ONE batch's id —
      // by batch position, which is already the order the transaction wrote them in.
      // Positions in DIFFERENT batches share the same index space, so that pair still needs
      // the anchoring transactions read. A group whose only ties sit inside a single batch
      // orders itself at zero chain cost, and its positions survive a scan the rest of the
      // read never asked for.
      const needsScan = members.some((cp, i) =>
        members.slice(i + 1).some((other) => {
          const a = cp.chain!
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
      if (needsScan) tied.set(second, members.map((cp) => cp.contextId as Hex))
    }
    if (tied.size > 0) {
      const placements = await recordPlacementsNear({
        client: runtime.chain.publicClient,
        deployment,
        owner: runtime.owner,
        namespaceId: NAMESPACE_ID,
        tied,
      }).catch(() => new Map<string, RecordPlacement>())
      for (const second of tied.keys()) {
        const members = bySecond.get(second)!
        const complete = members.every((cp) => placements.has(cp.contextId.toLowerCase()))
        for (const cp of members) {
          const placement = complete ? placements.get(cp.contextId.toLowerCase()) : undefined
          cp.chain =
            placement === undefined
              ? { at: cp.chain!.at }
              : {
                  at: cp.chain!.at,
                  block: placement.block,
                  ...(placement.transaction === undefined ? {} : { transaction: placement.transaction }),
                  index: placement.index,
                  // the batch membership survives the stamp — a scan that ran for the group
                  // must not erase the lane's own fact
                  ...(cp.chain!.batchId === undefined ? {} : { batchId: cp.chain!.batchId }),
                }
        }
      }
    }
  }
  // Sort on the order mergeCheckpoints uses — each record's effective instant (its chain stamp,
  // except a moved record's, which is the earliest of its envelope originalCreatedAt and its
  // replay's stamp; a writer's own createdAt claim only counts for a record with no chain
  // placement at all), then Monad's placement, contextId only at the bottom. Batched items merging is the common trigger, but a read that
  // carries a migration envelope needs the same sort without it: a moved universe's records
  // were all stamped at replay, so the store's own order cannot keep their real places — and
  // that holds whether the store offers no batch surface at all or its batch read failed.
  // A plain deployment keeps the store's order untouched.
  if (mergedBatched || checkpoints.some((cp) => cp.migration !== undefined)) {
    checkpoints.sort(compareChainOrder)
  }
  return { checkpoints, skipped, milliseconds: Date.now() - started, partial }
}

/**
 * Spec §5E, in three crash-safe stages: (1) one owner transaction revokes every capability the agent holds and
 * rotates the read epoch — skipped entirely when the chain shows nothing left to revoke, so a re-run after a
 * crash sends nothing; (2) the local revoked marker; (3) reader wraps republished to every surviving agent.
 * Stage 1 needs no grants.json: the vault's "agent" branch reads the live capability list from Monad itself.
 * The returned `failed` list is M3-D4: a wrap the store refuses for one agent never aborts the others and
 * never turns a landed chain revocation into a "refused" answer — the CLI prints the chain result first.
 */
export async function revoke(
  runtime: Runtime,
  name: string,
): Promise<{ transactionHashes: Hex[]; sponsored: boolean; rewrapped: string[]; failed: { name: string; reason: string }[]; repairError?: string }> {
  const { home, vault, reader, owner } = runtime
  runtime.progress?.(`asking the chain what ${name} already holds…`)
  const agentId = await resolveAgentId(runtime, name)
  const transactionHashes: Hex[] = []
  let sponsored = false
  // The raw list can hold expired or already-revoked ids; the transaction goes out only when at least
  // one id is still valid, so a re-run — or a list that only looks live — sends nothing.
  const listed = await reader.activeCapabilityIds(owner, agentId)
  let anyLive = false
  for (const id of listed) {
    if (await isCapabilityLive(runtime.ownerChain, id)) anyLive = true
  }
  // Whether this run actually rotated an epoch decides the pass's line: a revoke transaction
  // that went out minted a new key ("sending the new key"), a no-transaction re-run re-sends the
  // current one ("re-sending the read key").
  let rotatedNewKey = false
  if (anyLive) {
    runtime.sendProgress("sending the revocation")
    try {
      const approval = await vault.approveRevocation({ kind: "agent", agentId })
      transactionHashes.push(approval.transactionHash)
      sponsored = approval.sponsored
      rotatedNewKey = approval.rotated.length > 0
    } catch (error) {
      // SPONSOR_PENDING means the bundler accepted the revoke and it may still land; its staged
      // deny stays on purpose. The marker is what stops `mida approve` cancelling that deny inside
      // the landing window — clearStaleStoreDenies removes it once the chain shows the revoke.
      if (isMidaError(error, "SPONSOR_PENDING")) {
        markRevokePending(home, name, {
          intentId: (error as { intentId?: Hex }).intentId ?? null,
          userOpHash: (error as { userOpHash?: Hex }).userOpHash ?? null,
        })
      }
      throw error
    }
  }
  // The marker records "this agent was revoked", so it is written whenever the agent was identified and
  // the chain now shows nothing valid for it — whether this run sent the transaction or a crashed
  // earlier run already landed it. The one case that gets no marker is the never-approved agent:
  // the raw list was empty, no marker exists yet, and no grants.json says it ever completed a grant.
  const neverApproved = listed.length === 0 && !isRevoked(home, name) && !home.has(`agents/${name}/grants.json`)
  if (!neverApproved) markRevoked(home, name)
  // the project-folder approvals go too — the file is re-signed without this agent's rows
  await removeAgentApprovals(runtime, name)
  // Even the repair pass failing wholesale — say the RPC dies between the landed revoke and the
  // target enumeration — must not throw: a thrown error would print `refused:` for a revocation
  // that already landed. The failure is reported in the result instead.
  let repair: { rewrapped: string[]; failed: { name: string; reason: string }[]; repairError?: string }
  try {
    repair = await repairReaderWraps(runtime, undefined, undefined, undefined, rotatedNewKey)
  } catch (error) {
    repair = { rewrapped: [], failed: [], repairError: wrapFailureReason(error) }
  }
  return { transactionHashes, sponsored, rewrapped: repair.rewrapped, failed: repair.failed, repairError: repair.repairError }
}

/**
 * Publishes reader wraps for the current read epoch to every agent that still has READ authority on chain. The
 * chain alone decides who survives; the local revoked marker is never consulted, so it cannot blind a re-approved agent. This is revoke's third stage, exported so a crash between the revocation transaction and the
 * rewrap can be repaired without re-sending anything.
 */
/**
 * Revoking must not depend on one local file surviving — but the order matters: identity.json, then the
 * chain's own signer-to-agent mapping, then grants.json LAST. A stale grants.json must never outrank the
 * chain: a grants id is accepted only when no signer key exists locally to contradict it, or when the
 * chain record for that id is still bound to the saved signer's address. A damaged file counts as missing.
 * quietly() swallows only "missing" and "unreadable/corrupt"; EACCES/EPERM propagate, because a permission
 * problem must never silently change which agent gets revoked.
 */
export async function resolveAgentId(runtime: ServiceRuntime, name: string): Promise<Hex> {
  const { home, reader } = runtime
  const quietly = <T>(load: () => T): T | undefined => {
    try {
      return load()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EACCES" || code === "EPERM") throw error
      return undefined
    }
  }
  const identity = quietly(() => loadAgentIdentity(home, name))
  if (identity !== undefined) return identity.agentId
  const signerKey = home.has(`agents/${name}/signer.json`) ? quietly(() => loadOrCreateSignerKey(home, name)) : undefined
  const signerAddress = signerKey === undefined ? null : privateKeyToAccount(signerKey).address
  const onChain = signerAddress === null ? null : await reader.agentIdOfSigner(signerAddress)
  if (onChain !== null) return onChain
  const grant = quietly(() => loadGrants(home, name))?.[0]
  if (grant !== undefined) {
    if (signerAddress === null) return grant.agentId
    const record = await reader.getAgent(grant.agentId)
    if (record !== null && record.signer.toLowerCase() === signerAddress.toLowerCase()) return grant.agentId
  }
  throw codedError("agent-unidentified", `agent "${name}" cannot be identified: identity.json, grants.json and a registered signer.json are all missing or unreadable under agents/${name}/`)
}

/**
 * M3-D4: a revoke that failed after its deny was staged leaves an `active` intent that silently
 * locks this agent out of the store while the chain still approves it. Clearing one takes a fresh
 * owner passkey assertion over a nonce the store hands out NOW — `GET /revocations` withholds
 * nonces, so `POST /revocations/:id/reissue` mints a new one and retires whatever the failed run
 * saw. Covers agent-target denies and capability denies that belong to this agent alike. Returns
 * how many intents were cancelled.
 */
/** After this long a bundler-accepted revoke that the chain still does not show is treated as dropped, not landing. */
export const REVOKE_PENDING_STALE_MINUTES = 15

async function clearStaleStoreDenies(runtime: Runtime, agentId: Hex, name: string): Promise<number> {
  let intents: Awaited<ReturnType<typeof runtime.ownerApi.listRevocations>>
  try {
    intents = await runtime.ownerApi.listRevocations("active")
  } catch {
    // The store could not even be asked — the honest line is a note, not silence: a stale deny
    // may still be there and approve cannot see it. A REFUSED reissue or cancel below still throws.
    runtime.progress?.("note: could not reach the store to check for stale denies")
    return 0
  }
  // M3-D6: a revoke that ended SPONSOR_PENDING left a marker next to its deny. While the chain
  // does not show that revoke landed, clearing the deny would reopen the store inside the landing
  // window — exactly what fast revocation exists to close. A marker that will not parse fails
  // closed the same way: a deny left standing beats one cancelled too early.
  let pending: RevokePendingMarker | undefined
  try {
    pending = revokePending(runtime.home, name)
  } catch {
    pending = { intentId: null, userOpHash: null, at: "" }
  }
  let stillLanding = false
  let landedIntentId: string | null = null
  if (pending !== undefined) {
    const guarded =
      pending.intentId === null
        ? intents.find((i) => i.target.kind === "agent" && i.target.agentId.toLowerCase() === agentId.toLowerCase())
        : intents.find((i) => i.intentId.toLowerCase() === pending.intentId!.toLowerCase())
    if (guarded === undefined) {
      // The deny the marker guarded is no longer active — anchored, cancelled or gone — so the
      // marker's job is done.
      clearRevokePending(runtime.home, name)
    } else if (
      guarded.agentEpochAtIntent !== null &&
      (await runtime.reader.agentEpoch(runtime.owner, agentId)) > BigInt(guarded.agentEpochAtIntent)
    ) {
      // The chain shows the revoke landed; the marker is done and the deny is left for the
      // store's own reconcile to anchor rather than cancelled here.
      clearRevokePending(runtime.home, name)
      landedIntentId = guarded.intentId.toLowerCase()
    } else {
      stillLanding = true
    }
  }
  let cleared = 0
  let pendingPrinted = false
  for (const intent of intents) {
    let forAgent: boolean
    if (intent.target.kind === "agent") {
      forAgent = intent.target.agentId.toLowerCase() === agentId.toLowerCase()
    } else {
      // A capability deny whose owner cannot be resolved — RPC hiccup or a record the chain no
      // longer returns — must not read as "not this agent": the deny stays AND the owner hears
      // which block could not be checked, instead of a silent skip that ends in CAPABILITY_DENIED.
      let capabilityAgent: string | null
      try {
        capabilityAgent = (await runtime.reader.getCapability(intent.target.capabilityId))?.agentId ?? null
      } catch (error) {
        runtime.progress?.(`could not check one store block (capability ${intent.target.capabilityId}): ${wrapFailureReason(error)} — run \`mida approve ${name}\` again`)
        continue
      }
      if (capabilityAgent === null) {
        runtime.progress?.(`could not check one store block (capability ${intent.target.capabilityId}): the chain returned no record for it — run \`mida approve ${name}\` again`)
        continue
      }
      forAgent = capabilityAgent.toLowerCase() === agentId.toLowerCase()
    }
    if (!forAgent) continue
    if (stillLanding) {
      if (!pendingPrinted) {
        pendingPrinted = true
        // A bundler-accepted operation lands within minutes or is dropped for good. Past that
        // window the honest line is not "still landing" but "never landed": the way out is
        // `mida revoke` again (the grants are still live, so it re-sends) — say so, don't loop.
        const startedAt = pending === undefined ? Number.NaN : Date.parse(pending.at)
        const ageMinutes = Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 60_000) : Number.NaN
        runtime.progress?.(
          Number.isFinite(ageMinutes) && ageMinutes >= REVOKE_PENDING_STALE_MINUTES
            ? `a revoke of ${name} was accepted ${ageMinutes} min ago and has not landed — run \`mida revoke ${name}\` again to re-send it; the store's block is left in place`
            : `a revoke of ${name} is still landing — not cleared`,
        )
      }
      continue
    }
    // The marker's own deny was left for reconcile to anchor once its revoke proved landed.
    if (landedIntentId !== null && intent.intentId.toLowerCase() === landedIntentId) continue
    try {
      const reissued = await runtime.ownerApi.reissueRevocationNonce(intent.intentId)
      const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + DENY_CANCEL_EXPIRY_SECONDS
      const assertion = runtime.vault.approveDenyCancellation({
        revocationIntentId: intent.intentId,
        apiCancellationNonce: BigInt(reissued.cancellationNonce),
        expiresAt,
      })
      await runtime.ownerApi.cancelRevocation(intent.intentId, { expiresAt, assertion })
    } catch (error) {
      // REPLAY means the intent anchored or was cancelled in the gap between list and reissue —
      // a deny whose revocation really landed is not stale, and clearing it would be the bug.
      if (isMidaError(error) && error.code === "REPLAY") continue
      throw error
    }
    cleared += 1
    runtime.progress?.("cleared a stale block at the store left by a failed revoke")
  }
  return cleared
}

/** The one-line reason a wrap send failed — a MidaError's own message minus its code prefix. */
function wrapFailureReason(error: unknown): string {
  const text = error instanceof MidaError && error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error instanceof Error ? error.message : String(error)
  return text.split("\n")[0]!
}

/**
 * UF-APR5 F3: deleting a stale file is cleanup AFTER the approval is safe — the grant is recorded
 * on disk and live on chain. A removal that fails (an EPERM on Windows) must not stop the
 * approval with a bare "refused: EPERM" that names no next step: it prints a note that says the
 * agent IS approved and names the retry, and the rest of the approval still runs. The retry is
 * a parameter (UF-APR7B R5): approve's removals keep the default `mida approve <name>` — that
 * command really does re-run the same cleanup — but init's own files (the saved-request file, a
 * stale revoke marker cleared inside init) must name `mida init`, because `mida approve
 * assistant` is refused by design and would never remove them.
 */
function removeStaleFile(runtime: ServiceRuntime, name: string, file: string, retry = `mida approve ${name}`): void {
  try {
    runtime.home.remove(file)
  } catch (error) {
    runtime.progress?.(
      `note: ${name} is approved, but Mida could not remove an old file: ${displaySafeLine(wrapFailureReason(error), 300)} — run \`${retry}\` again to finish`,
    )
  }
}

/**
 * UF-APR4 D4: a folder-listing error raised once the chain approval is settled must not sound
 * like the approval failed — the agent IS approved and only the folder row is missing. The two
 * list codes carry their exact repair lines; anything else approveProject raises keeps its own
 * one-line message after the same prefix. Code `approved-unlisted` makes ownerRefusalLine print
 * the message as given, and the wrapper holds no `cause` so a thrown transport error underneath
 * can never launder this back into chain-busy's "nothing was sent".
 */
function approvedUnlisted(name: string, error: unknown): Error {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code === "list-unreadable") {
    return codedError(
      "approved-unlisted",
      `${name} is approved, but the approved-projects list could not be read — check the file's permissions, then run \`mida approve ${name}\` here again to add this folder`,
    )
  }
  if (code === "list-tampered") {
    return codedError("approved-unlisted", `${name} is approved, but the approved-projects list failed its signature check — run \`mida doctor\``)
  }
  return codedError("approved-unlisted", `${name} is approved, but ${displaySafeLine(wrapFailureReason(error), 300)}`)
}

export async function repairReaderWraps(
  runtime: Runtime,
  namespaceIds: readonly Hex[] = EVERY_READER_NAMESPACE,
  onlyAgentId?: Hex,
  // UF-APR3: the (agent, namespace) pairs the caller already sent this run. approveGrant and the
  // recovery re-publish hand the just-approved agent its wraps themselves, so the pass owes it
  // only namespaces NOT in that list (a rotated namespace the grant did not cover still reaches it).
  alreadySentTo?: { agentId: Hex; namespaceIds: readonly Hex[] },
  // UF-APR4: whether THIS run minted the key (an epoch rotation). A rotation pass announces
  // "sending the new key"; every other pass is re-sending the current one and says so.
  rotated = false,
): Promise<{ rewrapped: string[]; failed: { name: string; reason: string }[] }> {
  const { home, vault, reader, owner } = runtime
  // UF-APR5 F1: the wraps-owed bookkeeping lives here so every caller keeps it, and it is
  // namespace-shaped. A pass that throws or reports a failed send records the namespaces it
  // owed; a clean pass settles only the namespaces it covered — debt it never touched stays on
  // the marker. A pass narrowed to one agent can owe but never settle — it never looked at the
  // other readers.
  const wanted: Hex[] = [...new Map(namespaceIds.map((id) => [id.toLowerCase(), id])).values()]
  try {
    const targets: { name: string; agentId: Hex; nsIds: Hex[] }[] = []
    for (const name of listAgentNames(home)) {
      // A damaged identity.json cannot receive a wrap; it must not stop the others from getting theirs.
      let identity: ReturnType<typeof loadAgentIdentity>
      try { identity = loadAgentIdentity(home, name) } catch { continue }
      if (identity === undefined) continue
      if (onlyAgentId !== undefined && identity.agentId.toLowerCase() !== onlyAgentId.toLowerCase()) continue
      const already =
        alreadySentTo !== undefined && identity.agentId.toLowerCase() === alreadySentTo.agentId.toLowerCase()
          ? new Set(alreadySentTo.namespaceIds.map((id) => id.toLowerCase()))
          : undefined
      const nsIds: Hex[] = []
      for (const nsId of wanted) {
        if (already?.has(nsId.toLowerCase())) continue
        if (await reader.hasAuthority(owner, identity.agentId, nsId, PERMISSION.READ, 0)) nsIds.push(nsId)
      }
      if (nsIds.length > 0) targets.push({ name, agentId: identity.agentId, nsIds })
    }
    if (targets.length > 0) {
      runtime.progress?.(`${rotated ? "sending the new key" : "re-sending the read key"} to ${targets.length} agent${targets.length === 1 ? "" : "s"}…`)
    }
    const rewrapped: string[] = []
    const failed: { name: string; reason: string }[] = []
    // A target whose sends throw mid-way may have received some of its namespaces — conservatively
    // all of them stay owed. The pass settles only the namespaces no failure touched.
    const failedNamespaces = new Set<string>()
    for (const target of targets) {
      try {
        for (const nsId of target.nsIds) {
          await vault.publishReaderWraps({ agentId: target.agentId, namespaceId: nsId })
        }
        rewrapped.push(target.name)
      } catch (error) {
        // M3-D4: one refused wrap must not abort the pass — the rest still publish, and the caller
        // names each failure with the reason and the fix instead of one error hiding them all.
        for (const nsId of target.nsIds) failedNamespaces.add(nsId.toLowerCase())
        failed.push({ name: target.name, reason: wrapFailureReason(error) })
      }
    }
    if (failed.length > 0) {
      try {
        markWrapsOwed(home, wanted.filter((id) => failedNamespaces.has(id.toLowerCase())))
      } catch {
        // a debt that cannot be recorded must not turn the reported sends into a lie
      }
    }
    if (onlyAgentId === undefined) settleWrapsOwed(home, wanted.filter((id) => !failedNamespaces.has(id.toLowerCase())), EVERY_READER_NAMESPACE)
    return { rewrapped, failed }
  } catch (error) {
    try {
      markWrapsOwed(home, wanted)
    } catch {
      // the real failure stands on its own
    }
    throw error
  }
}
