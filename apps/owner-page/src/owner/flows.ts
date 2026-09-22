import type { LocalAccount, PublicClient } from "viem"
import { isMeraError } from "@category-labs/mera"
import { MidaError, PERMISSION, decodeUint64, namespaceById, namespaceId, sortScopes } from "@mida/protocol"
import type {
  AccessRequest,
  Address,
  GrantAdvice,
  Hex,
  RequestedScope,
  SignedAgentCapabilityManifest,
} from "@mida/protocol"
import { bytesOf, hexOf } from "@mida/crypto"
import { capabilityRegistryAbi, readAgentRecord, toMidaError } from "@mida/chain/browser"
import type { Deployment, SponsoredSender } from "@mida/chain/browser"
import { manifestBodyHash } from "@mida/grant-advisor"
import { assertionToWire } from "@mida/fake-vault/browser"
import type { VaultContextApi } from "@mida/fake-vault/browser"
import { SponsorPending } from "@mida/chain/browser"
import type { CredentialsContainerLike } from "../check/client.js"
import { PasskeyVaultAuthority, prepareGrant } from "./authority.js"
import type { CapturedAssertion } from "./webauthn.js"
import { actionChallenge, assertOwnerPasskey, capturedToAuthStruct, createOwnerPasskey, verifyCapturedAssertion } from "./webauthn.js"
import { deriveOwnerSecrets, ownerAccount, shortAddress } from "./secrets.js"
import type { OwnerSecrets } from "./secrets.js"
import type { FlowResult, LinkRequest, ParsedLink } from "./link.js"
import { buildResult } from "./link.js"
import {
  assertExpectedOwner,
  describeError,
  loadStoredOwner,
  readOwnerKey,
  saveStoredOwner,
} from "./session.js"
import type { StorageLike } from "./session.js"

/**
 * The three owner flows, written so every external service is injectable: a test drives them end
 * to end against a fake navigator.credentials, a fake chain reader, a fake sponsor and a fake
 * store, and asserts the order — verify the request, ONE credential call, then the sends.
 *
 * Two phases per post-signup flow: `prepare*` does every read and check that can fail BEFORE the
 * passkey prompt (a bad link never costs a touch), `confirm*` is the button's work: one ceremony,
 * the owner check, then the sends. Each flow ends by releasing the secret buffers.
 */

export interface FlowEnvironment {
  credentials: CredentialsContainerLike
  publicClient: PublicClient
  deployment: Deployment
  storeUrl: string
  storage: StorageLike
  /** Builds the sponsored sender for the derived account — production wraps createSponsoredSender. */
  makeSponsor: (account: LocalAccount) => SponsoredSender
  /** Builds the hosted-store client for the derived account — production wraps ContextApiClient. */
  makeApi: (account: LocalAccount) => VaultContextApi
  /** Fetches a signed manifest by body hash — production GETs the store's public route. */
  fetchManifest: (bodyHash: Hex) => Promise<unknown>
  progress?: (line: string) => void
  /** Test clock override; chain latest block otherwise. */
  now?: () => bigint
  /**
   * Test hook: fired with the secrets object AFTER release() so a test can assert the buffers
   * were overwritten and the object ended — production never sets it.
   */
  onSecrets?: (secrets: OwnerSecrets) => void
}

const OWNER_NAMESPACES = ["projects.current", "preferences.communication", "profile.skills"] as const

function resultBase(link: ParsedLink, owner: Address | null) {
  return { v: 1 as const, nonce: link.nonce, requestHash: link.requestHash, owner }
}

/** Wraps any sender so every confirmed send lands in `sent` — the result's transaction list. */
function recording(sponsor: SponsoredSender, sent: { transactionHash: Hex; userOpHash: Hex }[]): SponsoredSender {
  return {
    async send(call, kind) {
      const receipt = await sponsor.send(call, kind)
      sent.push({ transactionHash: receipt.transactionHash, userOpHash: receipt.userOpHash })
      return receipt
    },
  }
}

function authorityFor(
  env: FlowEnvironment,
  secrets: OwnerSecrets,
  extra: { p256PublicKey?: { qx: bigint; qy: bigint }; assertion?: CapturedAssertion },
): { authority: PasskeyVaultAuthority; sent: { transactionHash: Hex; userOpHash: Hex }[] } {
  const account = ownerAccount(secrets)
  const sent: { transactionHash: Hex; userOpHash: Hex }[] = []
  const authority = new PasskeyVaultAuthority({
    secrets,
    account,
    publicClient: env.publicClient,
    deployment: env.deployment,
    sponsor: recording(env.makeSponsor(account), sent),
    api: env.makeApi(account),
    p256PublicKey: extra.p256PublicKey,
    assertion: extra.assertion,
    // The deny-undo path (M3-D4): a failed revoke send cancels its staged deny, which takes a
    // fresh passkey assertion over the cancel digest — a second touch, on the failure path only.
    signCancelAssertion: async (challenge) => {
      const stored = loadStoredOwner(env.storage)
      const again = await assertOwnerPasskey({
        credentials: env.credentials,
        rpId: env.deployment.vaultRpId,
        challenge: bytesOf(challenge, 32),
        ...(stored?.credentialId !== undefined ? { credentialId: stored.credentialId } : {}),
        ...(stored?.transports !== undefined ? { transports: stored.transports } : {}),
      })
      try {
        return assertionToWire(capturedToAuthStruct(again.assertion))
      } finally {
        again.prfOutput.fill(0)
      }
    },
  })
  return { authority, sent }
}

async function readCapability<T>(
  env: FlowEnvironment,
  functionName: string,
  args: readonly unknown[],
): Promise<T> {
  try {
    return (await env.publicClient.readContract({
      address: env.deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName,
      args,
    } as never)) as T
  } catch (error) {
    throw toMidaError(error)
  }
}

// ---------------------------------------------------------------------------
// /signup — create the passkey, register its key, open the three context areas
// ---------------------------------------------------------------------------

export async function runSignup(env: FlowEnvironment, link: ParsedLink, userName: string): Promise<FlowResult> {
  const progress = env.progress ?? (() => {})
  const sent: { transactionHash: Hex; userOpHash: Hex }[] = []
  try {
    progress("Waiting for the passkey prompt — create your Mida passkey when the browser asks.")
    const created = await createOwnerPasskey({
      credentials: env.credentials,
      rpId: env.deployment.vaultRpId,
      userName,
    })
    if (created.algorithm !== -7) {
      throw new MidaError(
        "AUTH_INVALID",
        "This passkey is not a P-256 (ES256) credential, so the chain could never verify it. Delete it and create it again in a password manager that supports passkeys.",
      )
    }

    const secrets = deriveOwnerSecrets(created.prfOutput)
    const account = ownerAccount(secrets)
    const owner = account.address.toLowerCase() as Address
    progress(`This passkey derives owner ${owner}.`)

    const authority = new PasskeyVaultAuthority({
      secrets,
      account,
      publicClient: env.publicClient,
      deployment: env.deployment,
      sponsor: recording(env.makeSponsor(account), sent),
      api: env.makeApi(account),
      p256PublicKey: { qx: BigInt(hexOf(created.publicKey.x)), qy: BigInt(hexOf(created.publicKey.y)) },
    })
    try {
      const existing = await readOwnerKey(env.publicClient, env.deployment, owner)
      if (existing[0] === 0n && existing[1] === 0n) {
        progress("Registering your passkey's key on the chain…")
        await authority.registerOwnerKey()
      } else {
        progress("This owner already has a key on the chain — skipping registration.")
      }
      for (const ns of OWNER_NAMESPACES) {
        const onChain = await readCapability<Hex>(env, "epochPublicKey", [owner, namespaceId(ns), 1n])
        if (onChain === `0x${"00".repeat(32)}`) {
          progress(`Opening the ${ns} area…`)
          await authority.initializeNamespace(ns)
        }
      }
    } finally {
      authority.release()
      env.onSecrets?.(secrets)
    }

    saveStoredOwner(env.storage, {
      credentialId: created.credentialId,
      ...(created.transports !== null ? { transports: [...created.transports] } : {}),
      x: bytesToHexString(created.publicKey.x),
      y: bytesToHexString(created.publicKey.y),
      owner,
    })
    return buildResult({
      ...resultBase(link, owner),
      status: "success",
      transactions: sent.map((s) => s.transactionHash),
      operations: sent.map((s) => s.userOpHash),
      publicKey: { x: `0x${bytesToHexString(created.publicKey.x)}` as Hex, y: `0x${bytesToHexString(created.publicKey.y)}` as Hex },
    })
  } catch (error) {
    if (error instanceof SponsorPending) {
      return buildResult({
        ...resultBase(link, null),
        status: "pending",
        transactions: sent.map((s) => s.transactionHash),
        operations: [...sent.map((s) => s.userOpHash), error.userOpHash],
        reason: describeError(error),
      })
    }
    return failure(link, null, error, sent)
  }
}

async function loadManifest(env: FlowEnvironment, req: LinkRequest, accessRequest: AccessRequest): Promise<SignedAgentCapabilityManifest> {
  if (req.manifest !== undefined) {
    const manifest = req.manifest as unknown as SignedAgentCapabilityManifest
    if (manifestBodyHash(manifest.manifest) !== accessRequest.manifestHash.toLowerCase()) {
      throw new MidaError("MANIFEST_HASH_MISMATCH", "the manifest in the link does not match this request")
    }
    return manifest
  }
  const fetched = (await env.fetchManifest(accessRequest.manifestHash)) as SignedAgentCapabilityManifest
  if (typeof fetched !== "object" || fetched === null || typeof fetched.manifest !== "object" || typeof fetched.operatorSignature !== "string") {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "the store returned something that is not a signed manifest")
  }
  if (manifestBodyHash(fetched.manifest) !== accessRequest.manifestHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "the store returned a manifest that does not match this request")
  }
  return fetched
}

// ---------------------------------------------------------------------------
// /approve — verify the request, show the ask, one touch, grant, wraps, entry
// ---------------------------------------------------------------------------

export interface PreparedApprove {
  accessRequest: AccessRequest
  manifest: SignedAgentCapabilityManifest
  agentName: string
  operator: Address
  advice: GrantAdvice
  /** Requested scopes the chain does not already authorize — the only ones the send may mint. */
  needed: RequestedScope[]
  /** The exact challenge the ceremony must sign — the grant digest over the final selection. */
  challenge: Hex
  expiresAt: bigint
  /** True when every requested scope is already live — the flow refuses without a ceremony. */
  alreadyGranted: boolean
}

export async function prepareApprove(env: FlowEnvironment, link: ParsedLink): Promise<PreparedApprove> {
  const req = link.req
  if (BigInt(req.chainId) !== env.deployment.chainId) {
    throw new MidaError("INVALID_WIRE", "this link was built for a different chain")
  }
  const accessRequest = req.request as unknown as AccessRequest
  const owner = req.owner!

  const manifest = await loadManifest(env, req, accessRequest)
  const prepared = await prepareGrant(
    { publicClient: env.publicClient, deployment: env.deployment },
    owner,
    { accessRequest, manifest, selection: { kind: "recommended" } },
  )

  // The advisor's recommendation is the ceiling; the send mints only scopes that are BOTH
  // recommended and still ungranted on chain — the same "missing scopes only" the CLI applies.
  const needed: RequestedScope[] = []
  for (const scope of prepared.advice.recommended) {
    const live = await readCapability<boolean>(env, "hasAuthority", [
      owner,
      accessRequest.agentId,
      scope.namespaceId,
      scope.permissions,
      scope.provenancePolicy,
    ])
    if (!live) needed.push(scope)
  }
  const expiresAt = decodeUint64(prepared.advice.recommendedExpiresAt)
  const finalPrepared =
    needed.length === 0
      ? prepared
      : await prepareGrant({ publicClient: env.publicClient, deployment: env.deployment }, owner, {
          accessRequest,
          manifest,
          selection: { kind: "custom", scopes: sortScopes(needed), expiresAt },
        })
  return {
    accessRequest,
    manifest,
    agentName: manifest.manifest.name,
    operator: await preparedOperator(env, accessRequest),
    advice: finalPrepared.advice,
    needed,
    challenge: finalPrepared.challenge,
    expiresAt,
    alreadyGranted: needed.length === 0,
  }
}

async function preparedOperator(env: FlowEnvironment, accessRequest: AccessRequest): Promise<Address> {
  const record = await readAgentRecord({ publicClient: env.publicClient, deployment: env.deployment }, accessRequest.agentId)
  return record.operator
}

export async function confirmApprove(env: FlowEnvironment, link: ParsedLink, prep: PreparedApprove): Promise<FlowResult> {
  const progress = env.progress ?? (() => {})
  let sent: { transactionHash: Hex; userOpHash: Hex }[] = []
  const req = link.req
  if (prep.alreadyGranted) {
    return failure(link, req.owner ?? null, new MidaError("CAPABILITY_DENIED", "this agent already holds everything it asked for — nothing was sent"), sent)
  }
  try {
    progress("Waiting for the passkey prompt — use the passkey you signed up with.")
    const asserted = await assertOwnerPasskey({
      credentials: env.credentials,
      rpId: env.deployment.vaultRpId,
      challenge: bytesOf(prep.challenge, 32),
      credentialId: loadStoredOwner(env.storage)?.credentialId,
      transports: loadStoredOwner(env.storage)?.transports,
    })
    const secrets = deriveOwnerSecrets(asserted.prfOutput)
    const account = ownerAccount(secrets)
    const derived = account.address.toLowerCase() as Address
    try {
      const { registeredKey } = await assertExpectedOwner({
        derived,
        expected: req.owner!,
        stored: loadStoredOwner(env.storage),
        publicClient: env.publicClient,
        deployment: env.deployment,
      })
      if (registeredKey === null) {
        throw new MidaError("AUTH_INVALID", `this owner (${shortAddress(derived)}) has not signed up yet — there is no passkey key registered for it on the chain`)
      }
      // The grant assertion must verify against the key on chain — checked here so a passkey whose
      // credential drifted from the registered point fails in words, not as a revert.
      const verdict = verifyCapturedAssertion({
        captured: asserted.assertion,
        rpId: env.deployment.vaultRpId,
        challenge: bytesOf(prep.challenge, 32),
        publicKey: { x: bigintToBytes32(registeredKey.qx), y: bigintToBytes32(registeredKey.qy) },
      })
      if (!verdict.ok) {
        throw new MidaError(
          "AUTH_INVALID",
          "this passkey signed correctly but it is not the key registered for this owner — use the passkey you signed up with",
        )
      }

      const made = authorityFor(env, secrets, { assertion: asserted.assertion })
      const authority = made.authority
      sent = made.sent
      // Expired write epochs close a namespace to grants: rotate first, exactly as the CLI does.
      const rotatedNs: Hex[] = []
      for (const scope of prep.needed) {
        if (rotatedNs.includes(scope.namespaceId)) continue
        const required = await readCapability<bigint>(env, "requiredReadEpoch", [derived, scope.namespaceId])
        const valid = await readCapability<boolean>(env, "isWriteEpochValid", [derived, scope.namespaceId, required])
        if (!valid) {
          progress(`Rotating the ${namespaceById(scope.namespaceId).name} epoch…`)
          await authority.rotateExpiredEpoch(scope.namespaceId)
          rotatedNs.push(scope.namespaceId)
        }
      }
      progress("Sending the grant…")
      const approval = await authority.approveGrant({
        accessRequest: prep.accessRequest,
        manifest: prep.manifest,
        selection: { kind: "custom", scopes: prep.needed, expiresAt: prep.expiresAt },
      })
      // A rotated epoch invalidates every surviving reader's wrap — re-publish for the agents the
      // terminal named, but only those that still hold READ on chain. A lying list can only waste
      // reads; it can never re-authorize anyone.
      for (const nsId of rotatedNs) {
        for (const reader of req.readers ?? []) {
          if (reader === prep.accessRequest.agentId) continue
          const ok = await readCapability<boolean>(env, "hasAuthority", [derived, reader, nsId, PERMISSION.READ, 0])
          if (ok) {
            progress(`Sending the new key to a surviving agent…`)
            await authority.publishReaderWraps({ agentId: reader, namespaceId: nsId })
          }
        }
      }

      const entry = await signProjectEntry(account, req)
      const result = buildResult({
        ...resultBase(link, derived),
        status: "success",
        transactions: sent.map((s) => s.transactionHash),
        operations: sent.map((s) => s.userOpHash),
        ...(entry !== undefined ? { entry } : {}),
      })
      progress(`Granted ${approval.response.capabilities.length} capabilit${approval.response.capabilities.length === 1 ? "y" : "ies"}.`)
      return result
    } finally {
      secrets.release()
      env.onSecrets?.(secrets)
    }
  } catch (error) {
    const owner = req.owner ?? null
    if (error instanceof SponsorPending) {
      return buildResult({
        ...resultBase(link, owner),
        status: "pending",
        transactions: sent.map((s) => s.transactionHash),
        operations: [...sent.map((s) => s.userOpHash), error.userOpHash],
        reason: describeError(error),
      })
    }
    return failure(link, owner, error, sent)
  }
}

export interface SignedProjectRow {
  agent: string
  projectId: string
  root: string
  approvedAt: string
}

export interface NewProjectRow {
  agent: string
  projectId: string
  root: string
}

/**
 * Every row the approve signature will cover: the link's existing entries minus any row the new
 * entry replaces, plus the new row itself. The approve page renders exactly this set above the
 * button — a crafted link cannot get a row signed that the owner never saw — so the signer and
 * the screen share this one derivation.
 */
export function signableProjectRows(req: LinkRequest): { existing: SignedProjectRow[]; added: NewProjectRow } | null {
  if (req.entry === undefined) return null
  const existing = (req.entries ?? []) as unknown as SignedProjectRow[]
  return {
    existing: existing.filter(
      (e) => !(e.agent === req.entry!.agent && e.projectId === req.entry!.projectId && e.root === req.entry!.root),
    ),
    added: req.entry,
  }
}

/** The project-list signature: byte-identical canonical form to apps/midad projects.ts. */
async function signProjectEntry(
  account: LocalAccount,
  req: LinkRequest,
): Promise<{ entries: Record<string, unknown>[]; signature: Hex } | undefined> {
  const rows = signableProjectRows(req)
  if (rows === null) return undefined
  const next = [...rows.existing, { ...rows.added, approvedAt: new Date().toISOString() }]
  const signature = await account.signMessage({ message: canonicalEntries(next) })
  return { entries: next as unknown as Record<string, unknown>[], signature }
}

/**
 * Byte-identical to `canonicalEntries` in apps/midad/src/projects.ts — the signed form of the
 * approved-projects list. The terminal round will move this to a shared package; until then this
 * mirror is pinned by the flow test's known-answer check.
 */
export function canonicalEntries(entries: readonly { agent: string; projectId: string; root: string; approvedAt: string }[]): string {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const sorted = [...entries].sort((a, b) => cmp(a.agent, b.agent) || cmp(a.projectId, b.projectId) || cmp(a.root, b.root))
  return JSON.stringify(sorted.map((e) => ({ agent: e.agent, projectId: e.projectId, root: e.root, approvedAt: e.approvedAt })))
}

// ---------------------------------------------------------------------------
// /revoke — show what the agent can read, one touch, revoke + rotate, re-wrap
// ---------------------------------------------------------------------------

export interface PreparedRevoke {
  agentId: Hex
  /** The live capabilities the chain reports for this owner–agent pair — what revoke ends. */
  live: { capabilityId: Hex; namespaceId: Hex; namespaceName: string; permissions: number }[]
}

export async function prepareRevoke(env: FlowEnvironment, link: ParsedLink): Promise<PreparedRevoke> {
  const req = link.req
  if (BigInt(req.chainId) !== env.deployment.chainId) {
    throw new MidaError("INVALID_WIRE", "this link was built for a different chain")
  }
  const owner = req.owner!
  const agentId = req.agentId!
  const live: PreparedRevoke["live"] = []
  for (const id of await readCapability<readonly Hex[]>(env, "activeCapabilityIds", [owner, agentId])) {
    const capability = await readCapability<{ namespaceId: Hex; permissions: number }>(env, "getCapability", [id])
    const valid = await readCapability<boolean>(env, "isCapabilityValid", [id])
    if (!valid) continue
    let namespaceName: string = id
    try {
      namespaceName = namespaceById(capability.namespaceId).name
    } catch {
      // an unknown namespace id still displays — by its hash
    }
    live.push({ capabilityId: id, namespaceId: capability.namespaceId, namespaceName, permissions: capability.permissions })
  }
  return { agentId, live }
}

export async function confirmRevoke(env: FlowEnvironment, link: ParsedLink, prep: PreparedRevoke): Promise<FlowResult> {
  const progress = env.progress ?? (() => {})
  let sent: { transactionHash: Hex; userOpHash: Hex }[] = []
  const req = link.req
  if (prep.live.length === 0) {
    return failure(link, req.owner ?? null, new MidaError("CAPABILITY_DENIED", "the chain shows nothing live for this agent — nothing was sent"), sent)
  }
  try {
    progress("Waiting for the passkey prompt — use the passkey you signed up with.")
    const asserted = await assertOwnerPasskey({
      credentials: env.credentials,
      rpId: env.deployment.vaultRpId,
      challenge: actionChallenge("revoke", link.requestBytes),
      credentialId: loadStoredOwner(env.storage)?.credentialId,
      transports: loadStoredOwner(env.storage)?.transports,
    })
    const secrets = deriveOwnerSecrets(asserted.prfOutput)
    const account = ownerAccount(secrets)
    const derived = account.address.toLowerCase() as Address
    try {
      const { registeredKey } = await assertExpectedOwner({
        derived,
        expected: req.owner!,
        stored: loadStoredOwner(env.storage),
        publicClient: env.publicClient,
        deployment: env.deployment,
      })
      if (registeredKey === null) {
        throw new MidaError("AUTH_INVALID", `this owner (${shortAddress(derived)}) has not signed up yet`)
      }
      const made = authorityFor(env, secrets, {})
      const authority = made.authority
      sent = made.sent
      progress("Sending the revocation…")
      const approval = await authority.approveRevocation({ kind: "agent", agentId: prep.agentId })
      // Re-wrap the rotated namespaces for the agents that keep READ on chain.
      for (const rotation of approval.rotated) {
        for (const reader of req.readers ?? []) {
          if (reader === prep.agentId) continue
          const ok = await readCapability<boolean>(env, "hasAuthority", [derived, reader, rotation.namespaceId, PERMISSION.READ, 0])
          if (ok) {
            progress("Sending the new key to a surviving agent…")
            await authority.publishReaderWraps({ agentId: reader, namespaceId: rotation.namespaceId })
          }
        }
      }
      return buildResult({
        ...resultBase(link, derived),
        status: "success",
        transactions: sent.map((s) => s.transactionHash),
        operations: sent.map((s) => s.userOpHash),
      })
    } finally {
      secrets.release()
      env.onSecrets?.(secrets)
    }
  } catch (error) {
    const owner = req.owner ?? null
    if (error instanceof SponsorPending) {
      return buildResult({
        ...resultBase(link, owner),
        status: "pending",
        transactions: sent.map((s) => s.transactionHash),
        operations: [...sent.map((s) => s.userOpHash), error.userOpHash],
        reason: describeError(error),
      })
    }
    return failure(link, owner, error, sent)
  }
}

// ---------------------------------------------------------------------------

function failure(
  link: ParsedLink,
  owner: Address | null,
  error: unknown,
  sent: { transactionHash: Hex; userOpHash: Hex }[],
): FlowResult {
  const cancelled = isUserCancel(error)
  return buildResult({
    ...resultBase(link, owner),
    status: cancelled ? "cancelled" : "failed",
    transactions: sent.map((s) => s.transactionHash),
    operations: sent.map((s) => s.userOpHash),
    reason: describeError(error),
  })
}

/** A dismissed passkey prompt surfaces as a NotAllowedError — raw, or as a MeraError's cause. */
function isUserCancel(error: unknown): boolean {
  const name = (value: unknown) =>
    typeof value === "object" && value !== null && "name" in value ? String((value as { name: unknown }).name) : ""
  if (name(error) === "NotAllowedError") return true
  if (isMeraError(error) && error.code === "PASSKEY_OPERATION_FAILED" && name(error.cause) === "NotAllowedError") return true
  return false
}

function bytesToHexString(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

function bigintToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0")
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
