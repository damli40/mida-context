import { realpathSync } from "node:fs"
import { basename } from "node:path"
import { createPublicClient, parseEventLogs, verifyMessage } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  accessRequestHash,
  buildOwnerLink,
  decodeUint64,
  encodeUint64,
  namespaceById,
} from "@mida/protocol"
import type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  GrantedCapability,
  Hex,
  OwnerLinkFlow,
  OwnerLinkRequest,
  OwnerLinkResult,
} from "@mida/protocol"
import { capabilityRegistryAbi, chainFor, createSponsoredSender, createWriteContext, rpcTransport } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { RegistryReader } from "@mida/api"
import { provisionAgent } from "@mida/fake-vault"
import { permissionNames } from "@mida/grant-advisor"
import { newOwnerNonce, startReturnListener } from "./listener.js"
import type { ReturnListener } from "./listener.js"
import { openOwnerLink } from "./open.js"
import {
  clearRevokePending,
  identityFrom,
  isRevoked,
  listAgentNames,
  loadAgentIdentity,
  loadOrCreateOperatorSecrets,
  loadOrCreateSignerKey,
  loadOwnerAddress,
  markRevokePending,
  markRevoked,
  replaceSignerKey,
  revokePending,
  saveAgentIdentity,
  saveGrants,
  saveOwnerAddress,
  saveOwnerMode,
} from "../keys.js"
import {
  MIN_BALANCE_WEI,
  PURPOSE_ID,
  ServiceRuntime,
  apiClient,
  formatMon,
  makeOwnerBalanceGuard,
  parseSponsorUrl,
  sponsorReachable,
} from "../runtime.js"
import type { Network } from "../runtime.js"
import { resolveNetwork } from "../network.js"
import { canonicalEntries, ensureProjectMarker, readApprovalsFile, writeSignedApprovals } from "../projects.js"
import type { ProjectApproval } from "../projects.js"
import { FileAccessRequestStore } from "../request-store.js"
import {
  declarationsFor,
  deploymentMismatchError,
  expectedScopesFor,
  hasAnyLiveCapability,
  isCapabilityLive,
  missingExpectedScopes,
  purposeFor,
  resolveAgentId,
  ungrantedScopes,
} from "../skeleton.js"
import type { MidaHome } from "../home.js"

/**
 * The terminal side of the passkey owner flows (M3-F2): `mida init --passkey`, `approve` and
 * `revoke` on a passkey home. The pattern is always the same — the terminal builds and hashes
 * the request, prints the pairing code, hands the action to the page, waits on the local
 * listener, then believes nothing the page said until the chain (or a signature against the
 * owner address) proves it. No owner secret ever exists in this process: there is no vault,
 * no owner wallet context, and nothing here can create one.
 */

export const OWNER_PAGE_ORIGIN = "https://app.midacontext.xyz"
export const PASSKEY_IDENTITY_LINE = "Your passkey is your Mida identity. Use the same passkey you originally registered."
export const WRONG_OWNER_LINE = "That passkey is not this Mida owner's. Use the same passkey you originally registered."
/** What the owner is told when the result fails any of PROTOCOL.md's four checks. */
export const PAGE_MISMATCH_LINE = "the approval page returned something that does not match this request"
/** A revoke-still-landing message that names the wait, chain-checkable with no store access. */
export const REVOKE_LANDING_LINE = (name: string) => `a revoke of ${name} is still landing — wait, then approve again`

/**
 * What a page outcome means for the batch summary's `(…)` label: `declined` is the owner saying
 * no, `page-mismatch` is an answer that did not match the request or failed the chain proof
 * (possible tampering), `pending` is a sponsored operation that may still land, and `failed` is
 * the page itself reporting the operation could not be done.
 */
export type OwnerLinkOutcomeKind = "declined" | "page-mismatch" | "pending" | "failed"

/**
 * A command outcome the CLI prints verbatim — the page's decline reason, the wrong-owner line,
 * or the mismatch line — carrying the exit code the brief fixes for each case and the kind the
 * batch summary names it by.
 */
export class OwnerLinkOutcome extends Error {
  constructor(
    readonly line: string,
    readonly exitCode: number,
    readonly kind: OwnerLinkOutcomeKind,
  ) {
    super(line)
    this.name = "OwnerLinkOutcome"
  }
}

function codedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/**
 * Everything a passkey command needs that is not code — the page opener and the listener are
 * injectable so tests can drive a fake page end to end. `readOwnerKey` and `provision` exist
 * for the same reason: the default in each case is the real thing.
 */
export interface PasskeyDeps {
  print(line: string): void
  progress?: (line: string) => void
  /** The page origin — defaults to https://app.midacontext.xyz. */
  origin?: string
  /** How long the listener waits for the page — default 10 minutes. */
  timeoutMs?: number
  startListener?: (input: { nonce: string; timeoutMs?: number }) => Promise<ReturnListener>
  openLink?: (link: { url: string; requestBytes: Uint8Array }, deps: { print(line: string): void }) => Promise<void>
  /** Chain read of the registered passkey point — default: RegistryReader over a fresh client. */
  readOwnerKey?: (owner: Address) => Promise<{ qx: bigint; qy: bigint } | null>
  /** Agent provisioning — default: openOwnerSession + provisionPasskeyAgents. Injectable for tests. */
  provision?: (owner: Address) => Promise<Record<string, Hex>>
}

const LISTENER_TIMEOUT_MS = 10 * 60 * 1000
const GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60

/**
 * One full page round: build the exact request bytes, open the link (printing the pairing code
 * first), wait for the result, then check the two things only the terminal can check — the
 * nonce belongs to this listener and the requestHash covers these exact bytes.
 */
export async function runOwnerLinkRound(
  flow: OwnerLinkFlow,
  req: OwnerLinkRequest,
  deps: PasskeyDeps,
): Promise<OwnerLinkResult> {
  const nonce = newOwnerNonce()
  const start = deps.startListener ?? startReturnListener
  const listener = await start({ nonce, timeoutMs: deps.timeoutMs ?? LISTENER_TIMEOUT_MS })
  try {
    const link = buildOwnerLink({
      origin: deps.origin ?? OWNER_PAGE_ORIGIN,
      flow,
      req,
      nonce,
      port: listener.port,
    })
    await (deps.openLink ?? openOwnerLink)(link, { print: deps.print })
    deps.print(PASSKEY_IDENTITY_LINE)
    const result = await listener.result
    if (result.nonce !== nonce || result.requestHash !== link.requestHash) {
      throw new OwnerLinkOutcome(PAGE_MISMATCH_LINE, 1, "page-mismatch")
    }
    return result
  } finally {
    listener.close()
  }
}

/** The page said no. The reason it gave is the one line the owner sees; exit 2 per the brief. */
function declined(result: OwnerLinkResult): never {
  if (result.status === "pending") {
    const op = result.operations[result.operations.length - 1]
    const label = op === undefined ? "" : ` ${op.slice(0, 10)}…`
    throw new OwnerLinkOutcome(
      `the sponsored operation${label} was accepted and may still land — run the same command again in a minute — it will tell you if it already went through; nothing was sent from your wallet`,
      1,
      "pending",
    )
  }
  const reason = result.reason ?? "the page did not finish"
  // The page detects a passkey that derives a different owner and reports it in the reason;
  // the brief's fixed line replaces it so the owner always reads the same words.
  if (/different Mida owner/.test(reason)) throw new OwnerLinkOutcome(WRONG_OWNER_LINE, 2, "declined")
  // The page's own verdict decides the label: a "failed" status is an operation failure, not a
  // decline — the batch summary must not call it one.
  throw new OwnerLinkOutcome(reason, 2, result.status === "failed" ? "failed" : "declined")
}

function mismatch(): never {
  throw new OwnerLinkOutcome(PAGE_MISMATCH_LINE, 1, "page-mismatch")
}

/** The chain read every passkey check needs — a bare context, no lock, no secrets. */
function bareChain(network: Network): ChainContext {
  return {
    publicClient: createPublicClient({ chain: chainFor(network.deployment.chainId), batch: { multicall: true }, transport: rpcTransport(network.rpcUrl) }),
    deployment: network.deployment,
  }
}

// ---------------------------------------------------------------------------
// init --passkey
// ---------------------------------------------------------------------------

/**
 * `mida init --passkey`: the signup round creates the passkey on the page and registers its
 * P-256 key on chain. The terminal then proves `ownerP256Key(owner)` is the key the page
 * returned before writing anything — owner-address.json and owner/mode.json land only after
 * that check, and network.json after them, so a failed round leaves the home untouched.
 * A resume (owner address + chain key already present) skips the round entirely.
 */
export async function initPasskey(
  home: MidaHome,
  network: Network,
  agentNames: readonly string[],
  deps: PasskeyDeps,
): Promise<{ owner: Address; agents: Record<string, Hex> }> {
  if (home.has("network.json")) {
    // Same binding rule as the software init: a saved network.json is never rewritten, and one
    // that names another contract than this run resolves to refuses before any chain call —
    // the key read below included.
    const resolved = await resolveNetwork(home, process.env, {
      loadBuiltIn: () => network.deployment,
      probeChainId: false,
    })
    if (resolved.mismatch !== undefined) {
      throw deploymentMismatchError(resolved.mismatch.saved, resolved.mismatch.builtIn)
    }
  }
  const chain = bareChain(network)
  const readOwnerKey = deps.readOwnerKey ?? ((owner: Address) => new RegistryReader(chain).ownerP256Key(owner))

  let owner = loadOwnerAddress(home)
  const registered = owner !== undefined ? await readOwnerKey(owner) : null
  if (owner !== undefined && registered !== null) {
    deps.print(`owner ${owner} — already registered on chain`)
    // re-stamp the point too — a home resumed from before the field existed gains it here,
    // and a run interrupted between the two writes still ends with a mode
    saveOwnerAddress(home, owner, { x: `0x${registered.qx.toString(16).padStart(64, "0")}`, y: `0x${registered.qy.toString(16).padStart(64, "0")}` })
    saveOwnerMode(home, "passkey")
  } else {
    const result = await runOwnerLinkRound("signup", { chainId: Number(network.deployment.chainId) }, deps)
    if (result.status !== "success") declined(result)
    if (result.owner === null || result.publicKey === undefined) mismatch()
    const key = await readOwnerKey(result.owner)
    if (
      key === null ||
      key.qx !== BigInt(result.publicKey.x) ||
      key.qy !== BigInt(result.publicKey.y)
    ) {
      mismatch()
    }
    owner = result.owner
    saveOwnerAddress(home, owner, result.publicKey)
    saveOwnerMode(home, "passkey")
  }

  // Only now does anything else land on disk: the network record the daemon reads, then the
  // agents — operator registration and manifest uploads need no owner signature. The identity
  // line goes with every passkey command.
  deps.print(PASSKEY_IDENTITY_LINE)
  if (!home.has("network.json")) {
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

  const agents =
    deps.provision !== undefined
      ? await deps.provision(owner)
      : await provisionViaSession(home, network, agentNames, deps)
  return { owner, agents }
}

async function provisionViaSession(
  home: MidaHome,
  network: Network,
  agentNames: readonly string[],
  deps: PasskeyDeps,
): Promise<Record<string, Hex>> {
  const session = await ServiceRuntime.openOwnerSession(home, network)
  try {
    session.progress = deps.progress
    return await provisionPasskeyAgents(session, agentNames, deps)
  } finally {
    await session.close()
  }
}

/**
 * The agent half of init for a passkey home: operator registration and the manifest uploads
 * are unchanged (neither needs an owner signature — the operator signs both, and a registered
 * agent's manifest envelope is self-authenticating). The assistant's READ-only grant goes
 * through the page as one more approve round because only the passkey can sign it. There is
 * no owner wallet on this machine to fund anything from: sends are paid by the sponsor or by
 * the network's funder — a passkey init with neither refuses plainly.
 */
export async function provisionPasskeyAgents(
  session: ServiceRuntime,
  agentNames: readonly string[],
  deps: PasskeyDeps,
): Promise<Record<string, Hex>> {
  const { home, network, reader, owner } = session
  const progress = (line: string) => session.progress?.(line)
  const sponsorUrl = parseSponsorUrl(network.sponsorUrl)
  const sponsorUp = sponsorUrl !== undefined && (await sponsorReachable(sponsorUrl))
  if (sponsorUp) {
    progress("gas sponsor on — no MON needed")
  } else if (sponsorUrl !== undefined) {
    progress("gas sponsor not answering — this setup needs a funder")
  }

  const operatorAccount = privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey)
  const operator = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: operatorAccount })
  if (sponsorUrl !== undefined) {
    operator.sponsor = createSponsoredSender({
      sponsorUrl,
      rpcUrl: network.rpcUrl,
      account: operatorAccount,
      deployment: network.deployment,
      progress,
    })
  }
  // A passkey home has no owner wallet to top anyone up from: the funder is the only source,
  // and without one the guard's OWNER_WALLET_LOW names what the send would have cost.
  operator.beforeSend = makeOwnerBalanceGuard({ chain: operator, fund: network.fund, progress })

  // Once the agent is registered its manifest envelope is self-authenticating — the operator
  // may carry it exactly as the owner would.
  const api = apiClient(session.apiBaseUrl, network.deployment, operatorAccount)

  const ensureFunded = async (address: Address, label: string): Promise<void> => {
    if (sponsorUp) return
    const balance = await session.chain.publicClient.getBalance({ address })
    if (balance >= MIN_BALANCE_WEI) return
    if (network.fund === undefined) {
      throw new MidaError(
        "OWNER_WALLET_LOW",
        `${label} holds ${formatMon(balance)} MON and this network has no funder — a passkey setup needs the gas sponsor or a funder`,
      )
    }
    progress(`topping up ${label}…`)
    await network.fund(address)
  }

  const agents: Record<string, Hex> = {}
  for (const name of agentNames) {
    let identity = loadAgentIdentity(home, name)
    if (identity === undefined) {
      await ensureFunded(operatorAccount.address, "the operator wallet")
      // Saved to disk BEFORE the registration transaction, exactly as the software init does:
      // a crash must never leave a registered agent with no key.
      let signerPrivateKey = loadOrCreateSignerKey(home, name)
      if ((await reader.agentIdOfSigner(privateKeyToAccount(signerPrivateKey).address)) !== null) {
        signerPrivateKey = replaceSignerKey(home, name)
      }
      progress(`registering ${name} on the chain…`)
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
    }
    // An idempotent PUT, run for every agent on every init: a lost upload is retried here.
    await api.putAgentManifest(identity.manifest)
    await ensureFunded(privateKeyToAccount(identity.signerPrivateKey).address, `${name}'s wallet`)

    // `assistant` never joins a project, so there is no request/approve round-trip for it: its
    // whole READ-only policy grant is signed at init — by the page in passkey mode.
    if (identity.purposeId === "general_assistance") {
      const missing = await missingExpectedScopes(session, identity.agentId, identity.purposeId)
      if (missing.length > 0) {
        const request = await session.agent(name).createAccessRequest({
          purposeId: identity.purposeId,
          scopes: missing.map((s) => ({ namespace: namespaceById(s.namespaceId).name, permissions: s.permissions, provenancePolicy: s.provenancePolicy })),
          capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
        })
        progress(`${name} needs a grant only the passkey can sign — one more touch on the page`)
        const result = await runOwnerLinkRound(
          "approve",
          {
            chainId: Number(network.deployment.chainId),
            owner,
            request: request as unknown as Record<string, unknown>,
            manifest: identity.manifest as unknown as Record<string, unknown>,
            readers: localAgentIds(home),
          },
          deps,
        )
        if (result.status !== "success") declined(result)
        if (result.owner?.toLowerCase() !== owner.toLowerCase()) mismatch()
        const agent = session.agent(name)
        progress("proving the grant on the chain…")
        const grant = await agent.completeAccessRequest(request, await synthesizeGrantResponse(session, request, result))
        saveGrants(home, name, [...agent.grants])
        progress(`${name}'s grant landed (${grant.capabilities.length} capabilities)`)
      }
    }
    agents[name] = identity.agentId
  }
  return agents
}

/** Every agent id this home knows — the `readers` hint the page re-checks on chain before re-wrapping. */
function localAgentIds(home: MidaHome): Hex[] {
  const ids: Hex[] = []
  for (const name of listAgentNames(home)) {
    try {
      const identity = loadAgentIdentity(home, name)
      if (identity !== undefined) ids.push(identity.agentId)
    } catch {
      // a damaged identity file cannot be a reader hint — skip it
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// The grant-response synthesis — the terminal's independent chain check
// ---------------------------------------------------------------------------

/**
 * The page returns transaction hashes, never the grant record itself — and PROTOCOL.md calls
 * them hints, not proof. The response the agent completes is therefore rebuilt here from the
 * chain: every capability in it must be one the page's own transactions emitted (a
 * `CapabilityGranted` log for this owner–agent pair), must match a requested scope exactly and
 * must be live right now. `completeAccessRequest` then runs its own full verification on top —
 * each capability re-read on chain and each transaction receipt re-checked. Zero matching
 * capabilities means the page claimed a grant that never landed — the mismatch line, nothing
 * written.
 */
async function synthesizeGrantResponse(
  session: ServiceRuntime,
  request: AccessRequest,
  result: OwnerLinkResult,
): Promise<AccessGrantResponse> {
  const { owner } = session
  const registry = session.network.deployment.capabilityRegistry.toLowerCase()
  const emitted = new Map<string, Hex>()
  for (const tx of result.transactions) {
    const receipt = await session.chain.publicClient.getTransactionReceipt({ hash: tx }).catch(() => null)
    if (receipt === null || receipt.status !== "success") continue
    for (const log of parseEventLogs({ abi: capabilityRegistryAbi, eventName: "CapabilityGranted", logs: receipt.logs })) {
      if (
        log.address.toLowerCase() === registry &&
        log.args.owner.toLowerCase() === owner.toLowerCase() &&
        log.args.agentId.toLowerCase() === request.agentId.toLowerCase()
      ) {
        emitted.set(log.args.capabilityId.toLowerCase(), tx)
      }
    }
  }
  const wanted = new Set(request.scopes.map((s) => `${s.namespaceId.toLowerCase()}:${s.permissions}:${s.provenancePolicy}`))
  const capabilities: GrantedCapability[] = []
  for (const id of await session.reader.activeCapabilityIds(owner, request.agentId)) {
    const txHash = emitted.get(id.toLowerCase())
    if (txHash === undefined) continue
    const capability = await session.reader.getCapability(id)
    if (capability === null) continue
    if (!wanted.has(`${capability.namespaceId}:${capability.permissions}:${capability.provenancePolicy}`)) continue
    if (!(await isCapabilityLive(session.chain, id))) continue
    capabilities.push({
      namespaceId: capability.namespaceId,
      permissions: capability.permissions,
      provenancePolicy: capability.provenancePolicy,
      expiresAt: encodeUint64(capability.expiresAt),
      capabilityId: id,
      transactionHash: txHash,
    })
  }
  if (capabilities.length === 0) mismatch()
  const { agentSignature: _sig, ...unsigned } = request
  return {
    v: 1,
    chainId: request.chainId,
    capabilityRegistry: request.capabilityRegistry,
    requestId: request.requestId,
    nonce: request.nonce,
    requestHash: accessRequestHash(unsigned),
    owner,
    agentId: request.agentId,
    manifestHash: request.manifestHash,
    manifestVersion: request.manifestVersion,
    policyVersion: POLICY_VERSION,
    namespaceTreeVersion: NAMESPACE_TREE_VERSION,
    capabilities,
  }
}

// ---------------------------------------------------------------------------
// The signed project list — verify the page's signature and content before writing
// ---------------------------------------------------------------------------

function asApprovalRow(raw: unknown): ProjectApproval | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (Object.keys(record).length !== 4) return undefined
  for (const key of ["agent", "projectId", "root", "approvedAt"] as const) {
    if (typeof record[key] !== "string" || record[key] === "") return undefined
  }
  return record as unknown as ProjectApproval
}

/**
 * The signed list the page returns is trusted only after two checks: the signature verifies
 * against the owner address over the canonical form, and the content is exactly the rows the
 * terminal sent minus the replaced row plus the new row — the page chooses only `approvedAt`.
 * Anything else (a dropped row, an added row, a row that was never sent) is the mismatch line.
 */
async function writePageSignedList(
  home: MidaHome,
  owner: Address,
  expected: { kept: readonly ProjectApproval[]; added?: { agent: string; projectId: string; root: string } },
  entry: unknown,
): Promise<void> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) mismatch()
  const list = entry as { entries?: unknown; signature?: unknown }
  if (!Array.isArray(list.entries) || typeof list.signature !== "string") mismatch()
  const rows: ProjectApproval[] = []
  for (const raw of list.entries) {
    const row = asApprovalRow(raw)
    if (row === undefined) mismatch()
    rows.push(row)
  }
  // Exactly one row may differ from what was sent: the `added` row, whose approvedAt the page stamps.
  const remaining = [...rows]
  if (expected.added !== undefined) {
    const added = expected.added
    const index = remaining.findIndex((row) => row.agent === added.agent && row.projectId === added.projectId && row.root === added.root)
    if (index < 0) mismatch()
    remaining.splice(index, 1)
  }
  const kept = [...expected.kept]
  for (const row of remaining) {
    const index = kept.findIndex(
      (k) => k.agent === row.agent && k.projectId === row.projectId && k.root === row.root && k.approvedAt === row.approvedAt,
    )
    if (index < 0) mismatch()
    kept.splice(index, 1)
  }
  if (kept.length !== 0) mismatch()
  const verified = await verifyMessage({
    address: owner,
    message: canonicalEntries(rows),
    signature: list.signature as Hex,
  }).catch(() => false)
  if (!verified) mismatch()
  await writeSignedApprovals(home, rows, list.signature as Hex)
}

/** The list rows the page will sign: current verified entries, plus the new row for this folder. */
async function currentListRows(
  home: MidaHome,
  owner: Address,
): Promise<{ file: "missing" | "unreadable" | "bad-signature" | "signed"; entries: ProjectApproval[]; droppedRows: number | null }> {
  const file = await readApprovalsFile(home, owner)
  if (file.kind === "unreadable") return { file: "unreadable", entries: [], droppedRows: null }
  if (file.kind === "missing") return { file: "missing", entries: [], droppedRows: null }
  if (file.kind === "bad-signature") return { file: "bad-signature", entries: [], droppedRows: file.rows }
  return { file: "signed", entries: file.entries, droppedRows: 0 }
}

// ---------------------------------------------------------------------------
// approve <agent> — passkey mode
// ---------------------------------------------------------------------------

export interface ApprovePasskeyResult {
  transactionHashes: Hex[]
  /** Number of capabilities the chain now shows for this grant — 0 for the list-only path. */
  granted: number
  /** The folder row was signed by the page and written. */
  projectId?: string
  projectAlreadyListed?: boolean
  droppedRows?: number | null
  /** No grant was needed — the page touched only to sign the folder row. */
  listOnly: boolean
}

/**
 * `mida approve <agent>` on a passkey home. The terminal computes exactly what the chain still
 * owes the agent, carries the signed request + manifest + the verified project-list rows to the
 * page, and afterwards proves the grant itself: capabilities must exist on chain emitted by the
 * page's own transactions, and the returned list signature must verify against the owner before
 * a single file changes. The chain-denies cleanup the software approve runs against the store
 * is the page's job here — the deny list is owner-authenticated, so the page cancels the stale
 * denies itself as part of its approve flow.
 */
export async function approvePasskey(
  session: ServiceRuntime,
  name: string,
  cwd: string | undefined,
  deps: PasskeyDeps,
): Promise<ApprovePasskeyResult> {
  const { home, network, owner } = session
  const marker = cwd === undefined ? undefined : ensureProjectMarker(cwd)
  const identity = loadAgentIdentity(home, name)
  if (identity === undefined) throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)

  session.progress?.(`asking the chain what ${name} already holds…`)
  const missing = await missingExpectedScopes(session, identity.agentId, identity.purposeId)
  const live = await hasAnyLiveCapability(session, identity.agentId)
  await guardRevokePending(session, name, live)

  const wantsProject = marker !== undefined && identity.purposeId === PURPOSE_ID
  const root = marker === undefined ? undefined : realpathSync(marker.markerDir)
  const list = wantsProject ? await currentListRows(home, owner) : { file: "missing" as const, entries: [] as ProjectApproval[], droppedRows: null }
  if (list.file === "unreadable") throw codedError("list-unreadable", "the approved-projects list could not be read")

  let request: AccessRequest | undefined
  let pendingRequest = false
  const pending = home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)
  if (pending !== undefined) {
    const stored = await new FileAccessRequestStore(home, name).load(pending.request.requestId)
    if (stored?.consumed) throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
    if (stored !== undefined) {
      request = pending.request
      pendingRequest = true
    }
    // undefined means the file is the upgrade path's own — never written to the store — so the
    // code below rebuilds it rather than stranding the re-run on a "no pending request" refusal
  }
  if (request === undefined) {
    if (missing.length > 0 && live) {
      // The upgrade path: partially granted agent, no pending request — sign one for the missing scopes.
      request = await session.agent(name).createAccessRequest({
        purposeId: identity.purposeId,
        scopes: missing.map((s) => ({ namespace: namespaceById(s.namespaceId).name, permissions: s.permissions, provenancePolicy: s.provenancePolicy })),
        capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
      })
      home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
      pendingRequest = true
    } else if (live && wantsProject) {
      // Already approved on chain; the folder row still needs the passkey's signature — the
      // request exists only to carry the entry through the page's approve flow.
      deps.print(`${name} is already approved on chain; adding this folder needs one passkey touch`)
      request = await session.agent(name).createAccessRequest({
        purposeId: identity.purposeId,
        scopes: expectedScopesFor(identity.purposeId),
        capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
      })
    } else if (live) {
      throw codedError("already-approved", `agent "${name}" is already approved`)
    } else {
      throw codedError("no-pending-request", `agent "${name}" has no pending request; run requestAccess first`)
    }
  }

  // Only what the chain does not already authorize is granted — a request whose scopes are all
  // live mints nothing; that is the already-approved answer unless a folder row is due.
  const needed = await ungrantedScopes(session, identity.agentId, request.scopes)
  if (needed.length === 0 && !wantsProject) throw codedError("already-approved", `agent "${name}" is already approved`)

  if (needed.length > 0) {
    deps.print(`${name} is asking for:`)
    for (const scope of needed) {
      deps.print(`  ${namespaceName(scope.namespaceId)}: ${permissionNames(scope.permissions).join(" + ")}`)
    }
    deps.print(`  until ${new Date(Number(decodeUint64(request.capabilityExpiresAt)) * 1000).toISOString()}`)
  }

  const req: OwnerLinkRequest = {
    chainId: Number(network.deployment.chainId),
    owner,
    request: request as unknown as Record<string, unknown>,
    manifest: identity.manifest as unknown as Record<string, unknown>,
    readers: localAgentIds(home),
  }
  let added: { agent: string; projectId: string; root: string } | undefined
  if (wantsProject) {
    added = { agent: name, projectId: marker!.projectId, root: root! }
    req.project = { id: marker!.projectId, label: basename(root!) }
    req.entries = list.entries as unknown as Record<string, unknown>[]
    req.entry = added
  }
  const projectAlreadyListed = list.entries.some((e) => e.agent === name && e.projectId === marker?.projectId && e.root === root)

  const result = await runOwnerLinkRound("approve", req, deps)
  if (result.status !== "success") declined(result)
  if (result.owner?.toLowerCase() !== owner.toLowerCase()) mismatch()

  let granted = 0
  if (needed.length > 0) {
    session.progress?.("proving the grant on the chain…")
    const agent = session.agent(name)
    const grant = await agent.completeAccessRequest(request, await synthesizeGrantResponse(session, request, result))
    granted = grant.capabilities.length
    saveGrants(home, name, [...agent.grants])
  }
  if (wantsProject) {
    await writePageSignedList(home, owner, { kept: list.entries, added: added! }, result.entry)
  }
  // A marker left by an earlier revoke must not outlive a fresh approval.
  home.remove(`agents/${name}/revoked.json`)
  if (pendingRequest) home.remove(`agents/${name}/pending-request.json`)

  return {
    transactionHashes: result.transactions,
    granted,
    listOnly: needed.length === 0,
    ...(wantsProject ? { projectId: marker!.projectId, projectAlreadyListed, droppedRows: list.droppedRows } : {}),
  }
}

/**
 * The revoke-still-landing guard, chain-only: the store's deny list is owner-authenticated so a
 * passkey terminal cannot read it, but the chain answers "did it land" — live capabilities mean
 * it has not. Inside the landing window the approve waits rather than racing a revoke still in
 * flight; past it, the deny is stale like any other and the page clears it alongside the rest.
 */
async function guardRevokePending(session: ServiceRuntime, name: string, live: boolean): Promise<void> {
  let marker: ReturnType<typeof revokePending>
  try {
    marker = revokePending(session.home, name)
  } catch {
    marker = { intentId: null, userOpHash: null, at: "" }
  }
  if (marker === undefined) return
  if (!live) {
    clearRevokePending(session.home, name)
    return
  }
  const ageMinutes = (() => {
    const startedAt = Date.parse(marker.at)
    return Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 60_000) : Number.NaN
  })()
  if (Number.isFinite(ageMinutes) && ageMinutes >= 15) {
    clearRevokePending(session.home, name)
    return
  }
  throw new OwnerLinkOutcome(REVOKE_LANDING_LINE(name), 1, "pending")
}

function namespaceName(id: Hex): string {
  try {
    return namespaceById(id).name
  } catch {
    return `${id.slice(0, 10)}…`
  }
}

// ---------------------------------------------------------------------------
// revoke <agent> — passkey mode
// ---------------------------------------------------------------------------

export interface RevokePasskeyResult {
  transactionHashes: Hex[]
  /** Local names whose READ survived the revoke — the page re-wrapped their keys. */
  rewrapped: string[]
  /** The agent's capabilities were already gone — nothing was sent. */
  nothingToRevoke: boolean
}

/**
 * `mida revoke <agent>` on a passkey home. The page stages the deny, sends the revocation and
 * re-wraps the surviving readers; the terminal then reads the chain itself — every capability
 * it listed must be dead — before the revoked marker and the re-signed project list are
 * written. The returned list must contain exactly the rows the terminal sent to keep.
 */
export async function revokePasskey(
  session: ServiceRuntime,
  name: string,
  deps: PasskeyDeps,
): Promise<RevokePasskeyResult> {
  const { home, network, owner, reader } = session
  session.progress?.(`asking the chain what ${name} already holds…`)
  const agentId = await resolveAgentId(session, name)
  const listed = await reader.activeCapabilityIds(owner, agentId)
  const liveIds: Hex[] = []
  const readNamespaces: Hex[] = []
  for (const id of listed) {
    if (await isCapabilityLive(session.chain, id)) {
      liveIds.push(id)
      const capability = await reader.getCapability(id)
      if (capability !== null && (capability.permissions & PERMISSION.READ) !== 0 && !readNamespaces.includes(capability.namespaceId)) {
        readNamespaces.push(capability.namespaceId)
      }
    }
  }

  const file = await readApprovalsFile(home, owner)
  if (file.kind === "unreadable") throw codedError("list-unreadable", "the approved-projects list could not be read")
  const current = file.kind === "signed" ? file.entries : []
  const kept = current.filter((e) => e.agent !== name)

  if (liveIds.length === 0 && file.kind === "missing") {
    // Nothing on chain and no signed list — mirror software revoke's never-approved rule. A
    // pending marker left by an earlier revoke that has now landed is retired here too.
    const neverApproved = listed.length === 0 && !isRevoked(home, name) && !home.has(`agents/${name}/grants.json`)
    if (!neverApproved) markRevoked(home, name)
    clearRevokePending(home, name)
    return { transactionHashes: [], rewrapped: [], nothingToRevoke: true }
  }

  const req: OwnerLinkRequest = {
    chainId: Number(network.deployment.chainId),
    owner,
    agentId,
    readers: localAgentIds(home).filter((id) => id.toLowerCase() !== agentId.toLowerCase()),
    // The rows to KEEP — sent only when a list exists, so a missing file stays missing.
    ...(file.kind !== "missing" ? { entries: kept as unknown as Record<string, unknown>[] } : {}),
  }
  const result = await runOwnerLinkRound("revoke", req, deps)
  if (result.status === "pending") {
    markRevokePending(home, name, { intentId: null, userOpHash: result.operations[result.operations.length - 1] ?? null })
    declined(result)
  }
  if (result.status !== "success") declined(result)
  if (result.owner?.toLowerCase() !== owner.toLowerCase()) mismatch()

  // The chain, not the page, decides whether the revoke landed: every id that was live must be dead.
  session.progress?.("proving the revocation on the chain…")
  for (const id of liveIds) {
    if (await isCapabilityLive(session.chain, id)) mismatch()
  }
  const neverApproved = listed.length === 0 && !isRevoked(home, name) && !home.has(`agents/${name}/grants.json`)
  if (!neverApproved) markRevoked(home, name)
  clearRevokePending(home, name)
  if (file.kind !== "missing") {
    await writePageSignedList(home, owner, { kept }, result.entry)
  }

  // Who the page re-wrapped: the local agents that still hold READ on a namespace the revoked
  // agent could read — the same set the page recomputed from the chain.
  const rewrapped: string[] = []
  for (const other of listAgentNames(home)) {
    if (other === name) continue
    let identity: ReturnType<typeof loadAgentIdentity>
    try {
      identity = loadAgentIdentity(home, other)
    } catch {
      continue
    }
    if (identity === undefined) continue
    for (const nsId of readNamespaces) {
      if (await reader.hasAuthority(owner, identity.agentId, nsId, PERMISSION.READ, 0)) {
        rewrapped.push(other)
        break
      }
    }
  }
  return { transactionHashes: result.transactions, rewrapped, nothingToRevoke: false }
}

