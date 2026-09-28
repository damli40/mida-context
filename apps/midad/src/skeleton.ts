import { privateKeyToAccount } from "viem/accounts"
import { entryPoint08Address } from "viem/account-abstraction"
import { MidaError, PERMISSION, decodeUint64, isMidaError, namespaceById, namespaceId } from "@mida/protocol"
import type { AccessRequest, Address, GrantAdvice, Hex, PurposeId, RequestedScope } from "@mida/protocol"
import { batchAnchorAbi, capabilityRegistryAbi, createSponsoredSender, createWriteContext, latestTimestamp, ownerHistory, readAgentRecord, recordPlacementsNear } from "@mida/chain"
import type { ChainContext, HistoryScanCursor, RecordPlacement } from "@mida/chain"
import { DENY_CANCEL_EXPIRY_SECONDS, provisionAgent } from "@mida/fake-vault"
import { POLICY_DOCUMENT_V1, adviseGrant, assertRequestFresh, expandScopeInputs, permissionBits, provenancePolicyBits } from "@mida/grant-advisor"
import type { ScopeInput } from "@mida/grant-advisor"
import type { BatchReceipt } from "@mida/api"
import { compareChainOrder } from "@mida/checkpoint"
import type { StoredCheckpoint as CheckpointRecord } from "@mida/checkpoint"
import type { ContextObject } from "@mida/sdk"
import { addPendingAnchor, batchClient, batchStatusProbe, keepPendingPlaintext, laneForSave } from "./batching.js"
import type { Lane } from "./batching.js"
import { readSavedIds, recordSavedId } from "./saved-ids.js"
import { NAMESPACE, PURPOSE_ID, makeOwnerBalanceGuard, parseSponsorUrl, sponsorReachable } from "./runtime.js"
import type { Runtime, ServiceRuntime } from "./runtime.js"
import { resolveNetwork } from "./network.js"
import { FACT_NAMESPACES } from "./remember.js"
import { unwrapCheckpoint, wrapCheckpoint } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import { FileAccessRequestStore } from "./request-store.js"
import type { MidaHome } from "./home.js"
import {
  clearRevokePending, identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets, loadOrCreateSignerKey,
  markRevokePending, markRevoked, replaceSignerKey, revokePending, saveAgentIdentity, saveGrants, saveOwnerAddress, saveOwnerMode,
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
      const missing = await missingExpectedScopes(runtime, identity.agentId, identity.purposeId)
      if (missing.length > 0) {
        const request = await runtime.agent(name).createAccessRequest({
          purposeId: identity.purposeId,
          scopes: missing.map((s) => ({ namespace: namespaceById(s.namespaceId).name, permissions: s.permissions, provenancePolicy: s.provenancePolicy })),
          capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
        })
        runtime.sendProgress(`sending ${name}'s grant`)
        const approval = await vault.approveGrant({ accessRequest: request, manifest: identity.manifest, selection: { kind: "recommended" } })
        const agent = runtime.agent(name)
        await agent.completeAccessRequest(request, approval.response)
        saveGrants(home, name, [...agent.grants])
      }
    }
    agents[name] = identity.agentId
  }
  return { owner, agents }
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
 * The per-agent scan cursor (R4-9): `state/history/<agentId>.json`, written atomically by the
 * home. The file names the chain id and the registry it was scanned on, so a cursor from a
 * different chain or deployment is ignored rather than trusted. Anything missing, unreadable or
 * malformed answers undefined — a full scan, never a guess.
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
  // agent-record and revocation-history reads: an expired request refuses here, never after a
  // getLogs scan (in-15 J-2 — Sep 27 live printed "about 928 requests" before REQUEST_EXPIRED)
  const now = await latestTimestamp(runtime.ownerChain)
  assertRequestFresh(request, now)
  const agentRecord = await readAgentRecord(runtime.ownerChain, request.agentId)
  const history = await ownerHistory({
    client: runtime.ownerChain.publicClient,
    deployment: runtime.ownerChain.deployment,
    owner: runtime.owner,
    agentId: request.agentId,
    cursor: historyCursor(runtime.home, request.agentId, runtime.network.deployment.chainId, runtime.network.deployment.capabilityRegistry),
    maxRange: runtime.network.logBlockRange,
    // an estimate: a provider that refuses the window size splits the rest into smaller requests
    onScan: (requests) => runtime.progress?.(`checking ${name}'s history on the chain (about ${requests} requests)…`),
    onProgress: (done, total) =>
      runtime.progress?.(
        `reading ${name}'s revocations history: ${total === 0 ? 100 : Math.floor((done * 100) / total)}% (${done.toLocaleString("en-US")} of about ${total.toLocaleString("en-US")} requests)`,
      ),
  })
  return adviseGrant({ request, manifest, agentRecord, ownerHistory: history, now })
}

/**
 * approve --all's per-agent gate, run while the combined list prints: the same checks a single
 * approve makes before its prompt, in the same order — the pending file must name a request the
 * store still holds (not consumed, never replayed), then the grant advisor must accept it
 * (freshness, signature, manifest, all of assertRequestIsCurrent). Whatever fails throws the
 * coded refusal the batch names in its verdict and the agent is excluded before the one typed
 * yes — an expired or stale request is never carried to the signing step.
 */
export async function pendingApprovalAdvice(runtime: Runtime, name: string): Promise<GrantAdvice> {
  const { home } = runtime
  const identity = loadAgentIdentity(home, name)
  const pending = home.readJson<{ request?: AccessRequest }>(`agents/${name}/pending-request.json`)
  if (identity === undefined || pending?.request === undefined) {
    throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
  }
  const stored = await new FileAccessRequestStore(home, name).load(pending.request.requestId)
  if (stored === undefined || stored.consumed) {
    throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
  }
  return grantAdviceFor(runtime, name, pending.request, identity.manifest)
}

/** Spec §5B steps 3–4: the owner approves the pending request on-chain; the agent checks the result and keeps the grant. */
export async function approve(
  runtime: Runtime,
  name: string,
  cwd?: string,
  confirm?: (preview: ApprovePreview) => Promise<boolean>,
): Promise<{ capabilityIds: Hex[]; permissions: number[]; transactionHash: Hex | null; gasUsed: bigint; projectId?: string; projectAlreadyListed?: boolean; droppedRows?: number | null }> {
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
      runtime.progress?.(`note: could not send the new key to ${failure.name}: ${failure.reason}`)
    }
  }
  let pending = home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)

  // When the chain already approves the agent there is nothing to send — but if the command ran in
  // a project folder, the honest next step is the local list row, which is what the owner was asking
  // for. The result says whether the row was new so the CLI can say "now approved" only when it was.
  // `assistant` is never listed: it gets no project approval, ever.
  const alreadyApprovedResult = async () => {
    if (cwd === undefined || identity.purposeId !== PURPOSE_ID) {
      throw codedError("already-approved", `agent "${name}" is already approved`)
    }
    if (confirm !== undefined && !(await confirm({ kind: "project", agent: name, projectId: marker!.projectId }))) throw notApprovedError()
    const listed = await approveProject(runtime, { agent: name, cwd })
    return { capabilityIds: [] as Hex[], permissions: [] as number[], transactionHash: null, gasUsed: 0n, projectId: listed.approval.projectId, projectAlreadyListed: listed.alreadyListed, droppedRows: listed.droppedRows }
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

  const stored = await new FileAccessRequestStore(home, name).load(pending.request.requestId)
  if (stored === undefined || stored.consumed) throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
  // Only what the chain does not already authorize is granted — a request whose scopes are all live
  // mints nothing, so a second approve sends no transaction.
  const needed = await ungrantedScopes(runtime, identity.agentId, pending.request.scopes)
  // A pending request whose scopes are all already live is the same answer: nothing to send, but the
  // folder still gets its list row when there is one — this is the path the Sep-22 incident hit.
  if (needed.length === 0) return alreadyApprovedResult()
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
    }
  }
  runtime.sendProgress("sending the grant")
  const approval = await vault.approveGrant({
    accessRequest: pending.request,
    manifest: identity.manifest,
    selection: { kind: "custom", scopes: needed, expiresAt: decodeUint64(pending.request.capabilityExpiresAt) },
  })
  const agent = runtime.agent(name)
  runtime.progress?.("proving the grant on the chain…")
  const grant = await agent.completeAccessRequest(pending.request, approval.response)
  saveGrants(home, name, [...agent.grants])
  if (rotated.length > 0) {
    const repair = await repairReaderWraps(runtime, rotated)
    for (const failure of repair.failed) {
      runtime.progress?.(`note: could not send the new key to ${failure.name}: ${failure.reason}`)
    }
  }
  // A marker left by an earlier revoke must not outlive a fresh approval.
  home.remove(`agents/${name}/revoked.json`)
  home.remove(`agents/${name}/pending-request.json`)
  const listed = cwd === undefined || identity.purposeId !== PURPOSE_ID ? undefined : await approveProject(runtime, { agent: name, cwd })
  return {
    capabilityIds: grant.capabilities.map((capability) => capability.capabilityId),
    permissions: grant.capabilities.map((capability) => capability.permissions),
    transactionHash: approval.response.capabilities[0]!.transactionHash as Hex | null,
    gasUsed: approval.gasUsed,
    ...(listed !== undefined ? { projectId: listed.approval.projectId, droppedRows: listed.droppedRows } : {}),
  }
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
    let queued: { contextId: Hex; receipt?: BatchReceipt }
    try {
      queued = await agent.createBatched(runtime.owner, NAMESPACE, create)
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ALREADY_QUEUED") throw error
      const held = (error as { contextId?: unknown }).contextId
      if (typeof held !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(held)) throw error
      queued = { contextId: held.toLowerCase() as Hex }
    }
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

/** How long a read waits for a foreign-agent pending save to anchor after asking for the flush. */
const FLUSH_WAIT_MS = 3_000
const FLUSH_POLL_MS = 250

/**
 * Spec §5D steps 2–3, plus the BatchAnchor read (plan Task 8): a full protocol read as this agent,
 * then — whenever the deployment carries a BatchAnchor, whether or not batching is switched on —
 * the batch table's anchored and verified-pending saves merged in, marked `anchor` so a pending
 * save is never mistaken for an anchored one. A pending save from a DIFFERENT agent triggers the
 * store flush (Amendment B.4): `POST /batch/flush` once, then re-reads every 250 ms until those
 * saves anchor or `flushWaitMs` runs out — never a wait when every pending save is the reader's
 * own. A batched list the store cannot serve leaves `partial` set rather than hiding the gap —
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
    if (status !== null && status.batchAnchor.toLowerCase() === batchAnchor.toLowerCase()) {
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
          // Agent switch (Amendment B.4): ask the store to anchor the queue now — once per read.
          // "empty" and "rate-limited" are ordinary answers, and a failed flush must not fail the
          // read: the pending saves are still shown, marked.
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
  if (anyLive) {
    runtime.sendProgress("sending the revocation")
    try {
      const approval = await vault.approveRevocation({ kind: "agent", agentId })
      transactionHashes.push(approval.transactionHash)
      sponsored = approval.sponsored
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
    repair = await repairReaderWraps(runtime)
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

export async function repairReaderWraps(
  runtime: Runtime,
  namespaceIds: readonly Hex[] = [NAMESPACE_ID, ...FACT_NAMESPACES.map((ns) => namespaceId(ns))],
  onlyAgentId?: Hex,
): Promise<{ rewrapped: string[]; failed: { name: string; reason: string }[] }> {
  const { home, vault, reader, owner } = runtime
  // Who gets a wrap is decided first, so the owner hears how many agents the new key goes to
  // before the sends start — the authority checks run either way.
  const targets: { name: string; agentId: Hex; nsIds: Hex[] }[] = []
  for (const name of listAgentNames(home)) {
    // A damaged identity.json cannot receive a wrap; it must not stop the others from getting theirs.
    let identity: ReturnType<typeof loadAgentIdentity>
    try { identity = loadAgentIdentity(home, name) } catch { continue }
    if (identity === undefined) continue
    if (onlyAgentId !== undefined && identity.agentId.toLowerCase() !== onlyAgentId.toLowerCase()) continue
    const nsIds: Hex[] = []
    for (const nsId of namespaceIds) {
      if (await reader.hasAuthority(owner, identity.agentId, nsId, PERMISSION.READ, 0)) nsIds.push(nsId)
    }
    if (nsIds.length > 0) targets.push({ name, agentId: identity.agentId, nsIds })
  }
  if (targets.length > 0) {
    runtime.progress?.(`sending the new key to ${targets.length} agent${targets.length === 1 ? "" : "s"}…`)
  }
  const rewrapped: string[] = []
  const failed: { name: string; reason: string }[] = []
  for (const target of targets) {
    try {
      for (const nsId of target.nsIds) {
        await vault.publishReaderWraps({ agentId: target.agentId, namespaceId: nsId })
      }
      rewrapped.push(target.name)
    } catch (error) {
      // M3-D4: one refused wrap must not abort the pass — the rest still publish, and the caller
      // names each failure with the reason and the fix instead of one error hiding them all.
      failed.push({ name: target.name, reason: wrapFailureReason(error) })
    }
  }
  return { rewrapped, failed }
}
