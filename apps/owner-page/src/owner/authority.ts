import { parseEventLogs, zeroHash } from "viem"
import type { Abi, LocalAccount, PublicClient, TransactionReceipt } from "viem"
import {
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  accessRequestHash,
  cancelFastRevokeDigest,
  canonicalizeNamespace,
  decodeUint64,
  encodeUint64,
  grantDigest,
  isMidaError,
  namespaceById,
  namespaceId as toNamespaceId,
  sortScopes,
} from "@mida/protocol"
import type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  GrantAdvice,
  GrantedCapability,
  Hex,
  WebAuthnAuthStruct,
} from "@mida/protocol"
import {
  bytesOf,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  hexOf,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { EpochKeyPair } from "@mida/crypto"
import {
  capabilityRegistryAbi,
  latestTimestamp,
  ownerHistory,
  readAgentRecord,
  toMidaError,
} from "@mida/chain/browser"
import type { Deployment, SponsoredReceipt, SponsoredSender, TxKind } from "@mida/chain/browser"
import { POLICY_HASH_V1, adviseGrant, assertFinalSelection, assertRequestFresh } from "@mida/grant-advisor"
import { fakePrfOutput, toAccessRequestStruct } from "@mida/fake-vault/browser"
import type {
  GrantApproval,
  GrantRequest,
  RevokeApproval,
  RevokeRequest,
  VaultAuthority,
  VaultContextApi,
  WebAuthnAssertionWire,
} from "@mida/fake-vault/browser"
import { assertionChallenge } from "./webauthn.js"
import type { CapturedAssertion } from "./webauthn.js"
import { capturedToAuthStruct } from "./webauthn.js"
import { sendSponsoredOnly } from "./send.js"
import type { SponsoredWriteContext } from "./send.js"
import type { OwnerSecrets } from "./secrets.js"
import { equalBytes } from "../check/bytes.js"
import { bytesToHex } from "../check/bytes.js"

/**
 * The passkey-backed counterpart of FakeVaultAuthority (§4.2): same interface, same sequencing,
 * two deliberate differences.
 *
 * 1. Secrets come from ONE passkey ceremony, not files on disk. The PRF output is stretched into
 *    the EVM wallet key and the owner seed by deriveOwnerSecrets; the P-256 key is the passkey's
 *    own. Buffers are never intentionally persisted and are released (best-effort overwrite) by
 *    release(), which every flow calls when its one action ends.
 * 2. Sends are sponsored-only — no self-pay fallback, because a passkey owner holds no MON.
 *    SponsorDidNotPay and SponsorPending surface to the flow unchanged.
 *
 * The WebAuthn assertion arrives already captured: the grant challenge must be computed BEFORE
 * the ceremony runs, so the flow performs the ceremony, converts the capture, and hands the
 * struct in. approveGrant re-derives the digest and refuses if the assertion signed anything else.
 */
export interface PasskeyAuthorityConfig {
  secrets: OwnerSecrets
  /** viem account over secrets.evmKey — its address IS the owner. */
  account: LocalAccount
  publicClient: PublicClient
  deployment: Deployment
  sponsor: SponsoredSender
  api: VaultContextApi
  /** The passkey's P-256 point — captured at signup, or the chain-registered key. Needed only to register. */
  p256PublicKey?: { qx: bigint; qy: bigint }
  /** The ceremony's captured assertion — required by approveGrant, ignored by revocation. */
  assertion?: CapturedAssertion
  /**
   * A SECOND ceremony, only ever for undoing a staged deny after a failed revoke send: the flow
   * wires a `get` over the cancelFastRevokeDigest challenge and returns the wire assertion. When
   * absent the undo cannot run, the deny stays, and the send error carries the manual-clear line.
   */
  signCancelAssertion?: (challenge: Hex) => Promise<WebAuthnAssertionWire>
}

/**
 * The store surface M3-D4 lands on merge: requestRevocationDeny gains a cancellationNonce and the
 * api gains cancelRevocation. This branch's package predates the merge, so the authority reads the
 * deny through this shape — a pre-merge api simply fails the undo, and the send error carries the
 * manual-clear line exactly as if cancelRevocation itself had failed.
 */
interface CancelCapableApi extends VaultContextApi {
  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }): Promise<{ intentId: Hex; cancellationNonce: string }>
  cancelRevocation(intentId: Hex, input: { expiresAt: bigint; assertion: WebAuthnAssertionWire }): Promise<unknown>
  /** GET /revocations — owner-authenticated; the nonce is withheld, reissue mints a fresh one. */
  listRevocations(state?: string): Promise<RevocationIntentView[]>
  reissueRevocationNonce(intentId: Hex): Promise<{ intentId: Hex; state: string; cancellationNonce: string }>
}

/** What GET /revocations returns per intent — the shape apps/api/src/client.ts declares. */
interface RevocationIntentView {
  intentId: Hex
  state: string
  target: { kind: "capability"; capabilityId: Hex } | { kind: "agent"; agentId: Hex }
  agentEpochAtIntent: string | null
}

/**
 * RevokeApproval after the M3-D4 merge carries `sponsored` — the class returns it now so both
 * sides of the merge compile, and `PageRevokeApproval` is the merge's shape either way.
 */
export type PageRevokeApproval = RevokeApproval & { sponsored: boolean }

/** The undo window the store accepts for a deny cancellation — two minutes (§12.5, M3-D4). */
const DENY_CANCEL_EXPIRY_SECONDS = 120n

/** A sponsored send's receipt carries `userOpHash` — that field, not the network config, says who paid. */
function isSponsored(receipt: TransactionReceipt): boolean {
  return (receipt as TransactionReceipt & { userOpHash?: Hex }).userOpHash !== undefined
}

interface CapabilityView {
  owner: Address
  agentId: Hex
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: bigint
  revoked: boolean
}

export class PasskeyVaultAuthority implements VaultAuthority {
  readonly owner: Address
  readonly #secrets: OwnerSecrets
  readonly #account: LocalAccount
  readonly #write: SponsoredWriteContext
  readonly #publicClient: PublicClient
  readonly #deployment: Deployment
  readonly #api: VaultContextApi
  readonly #p256PublicKey?: { qx: bigint; qy: bigint }
  readonly #assertion?: CapturedAssertion
  readonly #signCancelAssertion?: (challenge: Hex) => Promise<WebAuthnAssertionWire>
  #released = false

  constructor(config: PasskeyAuthorityConfig) {
    if (config.deployment.policyHashV1 !== POLICY_HASH_V1) {
      throw new MidaError("POLICY_VERSION_UNSUPPORTED", "deployed POLICY_HASH_V1 differs from this authority's policy")
    }
    this.#secrets = config.secrets
    this.#account = config.account
    this.#publicClient = config.publicClient
    this.#deployment = config.deployment
    this.#write = {
      publicClient: config.publicClient,
      account: config.account,
      deployment: config.deployment,
      sponsor: config.sponsor,
    }
    this.#api = config.api
    this.#p256PublicKey = config.p256PublicKey
    this.#assertion = config.assertion
    this.#signCancelAssertion = config.signCancelAssertion
    this.owner = config.account.address.toLowerCase() as Address
  }

  get released(): boolean {
    return this.#released
  }

  /**
   * End of the one action this authority existed for: overwrite the secret buffers and drop the
   * references. Best-effort — the JS runtime may hold copies nothing can reach — and the
   * account's internal key copy is released only by dropping the reference.
   */
  release(): void {
    if (this.#released) return
    this.#secrets.release()
    this.#released = true
  }

  #live(): void {
    if (this.#released || this.#secrets.released) {
      throw new MidaError("AUTH_INVALID", "this passkey authority has already been released")
    }
  }

  async deriveNamespaceSecret(namespaceId: Hex): Promise<Uint8Array> {
    this.#live()
    const node = namespaceById(namespaceId)
    return deriveNamespaceSecret(fakePrfOutput(this.#secrets.ownerSeed, node.domain), node.id)
  }

  /** §10.2: registers the passkey's own (x, y) — captured in the signup ceremony — as the owner key. */
  async registerOwnerKey(): Promise<Hex> {
    this.#live()
    if (this.#p256PublicKey === undefined) {
      throw new MidaError("AUTH_INVALID", "no passkey public key was captured to register")
    }
    return (await this.#sendCapability("owner.key", "registerP256Key", [this.#p256PublicKey.qx, this.#p256PublicKey.qy])).transactionHash
  }

  /** Key rotation needs a fresh assertion over the rotation digest — out of scope for this page. */
  rotateP256Key(): Promise<never> {
    throw new MidaError("AUTH_INVALID", "this page cannot rotate the owner key — that is a different passkey ceremony")
  }

  async initializeNamespace(namespace: string): Promise<Hex> {
    this.#live()
    const id = toNamespaceId(canonicalizeNamespace(namespace))
    const keys = await this.#epochKeys(id, 1n)
    return (await this.#sendCapability("epoch.init", "initializeReadEpoch", [id, hexOf(keys.publicKey)])).transactionHash
  }

  async approveGrant(request: GrantRequest): Promise<GrantApproval> {
    this.#live()
    const { accessRequest } = request
    const { deployment } = this.#write
    const prepared = await prepareGrant(
      { publicClient: this.#publicClient, deployment },
      this.owner,
      request,
      (functionName, args) => this.#readCapability(functionName, args),
    )
    const auth = this.#grantAssertion(prepared.challenge)
    const receipt = await this.#sendCapability("grant.batch", "grantBatch", [
      toAccessRequestStruct(accessRequest),
      prepared.selected.scopes,
      prepared.selected.expiresAt,
      auth,
    ])

    const capabilities: GrantedCapability[] = parseEventLogs({
      abi: capabilityRegistryAbi,
      eventName: "CapabilityGranted",
      logs: receipt.logs,
    }).map((log) => ({
      namespaceId: log.args.namespaceId,
      permissions: log.args.permissions,
      provenancePolicy: log.args.provenancePolicy,
      expiresAt: encodeUint64(log.args.expiresAt),
      capabilityId: log.args.capabilityId,
      transactionHash: receipt.transactionHash,
    }))
    const response: AccessGrantResponse = {
      v: 1,
      chainId: accessRequest.chainId,
      capabilityRegistry: accessRequest.capabilityRegistry,
      requestId: accessRequest.requestId,
      nonce: accessRequest.nonce,
      requestHash: prepared.requestHash,
      owner: this.owner,
      agentId: accessRequest.agentId,
      manifestHash: accessRequest.manifestHash,
      manifestVersion: accessRequest.manifestVersion,
      policyVersion: POLICY_VERSION,
      namespaceTreeVersion: NAMESPACE_TREE_VERSION,
      capabilities,
    }
    // §13.4: wraps are published only now that the chain holds the READ capability.
    for (const capability of capabilities) {
      if ((capability.permissions & PERMISSION.READ) !== 0) {
        await this.publishReaderWraps({ agentId: accessRequest.agentId, namespaceId: capability.namespaceId })
      }
    }
    return { advice: prepared.advice, response, gasUsed: receipt.gasUsed }
  }

  /** Publishes one wrap per registered epoch for an agent that holds live exact READ — same as the fake vault. */
  async publishReaderWraps(input: { agentId: Hex; namespaceId: Hex }): Promise<bigint[]> {
    this.#live()
    const { deployment } = this.#write
    const authorized = await this.#readCapability<boolean>("hasAuthority", [
      this.owner,
      input.agentId,
      input.namespaceId,
      PERMISSION.READ,
      0,
    ])
    if (!authorized) throw new MidaError("CAPABILITY_DENIED", "agent has no live exact READ capability; no wrap published")
    const agent = await readAgentRecord(this.#write, input.agentId)
    const required = await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, input.namespaceId])
    const createdAt = await latestTimestamp(this.#write)
    const published: bigint[] = []
    for (let epoch = 1n; epoch <= required; epoch++) {
      const onChain = await this.#readCapability<Hex>("epochPublicKey", [this.owner, input.namespaceId, epoch])
      if (onChain === zeroHash) continue
      const keys = await this.#epochKeys(input.namespaceId, epoch, onChain)
      await this.#api.publishEpochWrap(
        wrapEpochPrivateKeyToAgent({
          epochPrivateKey: keys.privateKey,
          agentEncryptionPublicKey: bytesOf(agent.encryptionPublicKey, 32),
          binding: {
            chainId: deployment.chainId,
            capabilityRegistry: deployment.capabilityRegistry,
            owner: this.owner,
            namespaceId: input.namespaceId,
            readEpoch: epoch,
            agentId: input.agentId,
            agentKeyVersion: agent.encryptionKeyVersion,
          },
          createdAt,
        }),
      )
      published.push(epoch)
    }
    return published
  }

  /** §7.3 and §16 steps 13–14: the local deny is posted first, then one sponsored transaction revokes and rotates. */
  async approveRevocation(request: RevokeRequest): Promise<PageRevokeApproval> {
    this.#live()
    const api = this.#api as CancelCapableApi
    if (request.kind === "capability") {
      const capability = await this.#readCapability<CapabilityView>("getCapability", [request.capabilityId])
      if (capability.owner.toLowerCase() !== this.owner) {
        throw new MidaError("CAPABILITY_DENIED", "capability belongs to another owner")
      }
      const live = await this.#readCapability<boolean>("isCapabilityValid", [request.capabilityId])
      const endsRead = live && (capability.permissions & PERMISSION.READ) !== 0
      const deny = await api.requestRevocationDeny({ capabilityId: request.capabilityId })
      const label = (request as { name?: string }).name ?? capability.agentId
      if (!endsRead) {
        const receipt = await this.#sendOrUndoDeny(deny, label, () =>
          this.#sendCapability("revoke.capability", "revoke", [request.capabilityId]),
        )
        return { intentId: deny.intentId, transactionHash: receipt.transactionHash, sponsored: isSponsored(receipt), rotated: [] }
      }
      const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, capability.namespaceId])) + 1n
      const keys = await this.#epochKeys(capability.namespaceId, next)
      const receipt = await this.#sendOrUndoDeny(deny, label, () =>
        this.#sendCapability("revoke.rotate", "revokeAndRotate", [request.capabilityId, hexOf(keys.publicKey)]),
      )
      return { intentId: deny.intentId, transactionHash: receipt.transactionHash, sponsored: isSponsored(receipt), rotated: [{ namespaceId: capability.namespaceId, readEpoch: next }] }
    }

    const ids = await this.#readCapability<readonly Hex[]>("activeCapabilityIds", [this.owner, request.agentId])
    const readNamespaces: Hex[] = []
    for (const id of ids) {
      const capability = await this.#readCapability<CapabilityView>("getCapability", [id])
      const live = await this.#readCapability<boolean>("isCapabilityValid", [id])
      if (live && (capability.permissions & PERMISSION.READ) !== 0 && !readNamespaces.includes(capability.namespaceId)) {
        readNamespaces.push(capability.namespaceId)
      }
    }
    const rotations: Array<{ namespaceId: Hex; newEpochPublicKey: Hex }> = []
    const rotated: PageRevokeApproval["rotated"] = []
    for (const namespaceId of readNamespaces) {
      const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])) + 1n
      rotations.push({ namespaceId, newEpochPublicKey: hexOf((await this.#epochKeys(namespaceId, next)).publicKey) })
      rotated.push({ namespaceId, readEpoch: next })
    }
    const deny = await api.requestRevocationDeny({ owner: this.owner, agentId: request.agentId })
    const receipt = await this.#sendOrUndoDeny(deny, (request as { name?: string }).name ?? request.agentId, () =>
      this.#sendCapability("revoke.agent", "revokeAgentAndRotate", [request.agentId, rotations]),
    )
    return { intentId: deny.intentId, transactionHash: receipt.transactionHash, sponsored: isSponsored(receipt), rotated }
  }

  /**
   * The undo half of "deny first, then send" (§12.5, M3-D4): a send that provably never happened —
   * simulation or a sponsor refusal — must not leave its deny behind, or the store keeps blocking
   * an agent the chain still approves. SPONSOR_PENDING is the exception: the bundler accepted the
   * operation and it may still land, so its deny stays and the error propagates untouched. Any
   * other failure cancels the intent with a fresh passkey assertion over cancelFastRevokeDigest
   * (two-minute expiry). When the cancel itself fails the original error still surfaces, carrying
   * the one line that clears the deny by hand.
   */
  async #sendOrUndoDeny(
    deny: { intentId: Hex; cancellationNonce: string },
    label: string,
    send: () => Promise<TransactionReceipt>,
  ): Promise<TransactionReceipt> {
    try {
      return await send()
    } catch (error) {
      if (isMidaError(error, "SPONSOR_PENDING")) throw error
      try {
        const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + DENY_CANCEL_EXPIRY_SECONDS
        const challenge = cancelFastRevokeDigest({
          chainId: this.#deployment.chainId,
          capabilityRegistry: this.#deployment.capabilityRegistry,
          owner: this.owner,
          revocationIntentId: deny.intentId,
          apiCancellationNonce: BigInt(deny.cancellationNonce),
          expiresAt,
        })
        if (this.#signCancelAssertion === undefined) throw new MidaError("AUTH_INVALID", "no cancel signer was wired")
        await (this.#api as CancelCapableApi).cancelRevocation(deny.intentId, {
          expiresAt,
          assertion: await this.#signCancelAssertion(challenge),
        })
      } catch {
        if (error instanceof Error) {
          error.message += `\nthe store may still list ${label} as denied — run \`mida approve ${label}\` to clear it`
        }
      }
      throw error
    }
  }

  /**
   * M3-D4 item 3, page side: a revoke that failed after its deny was staged leaves an `active`
   * intent blocking an agent the chain still approves — the software CLI clears those in its
   * approve; on a passkey home only the page can reach the owner-authenticated deny list, so
   * the clearing lives here, before the grant. Each cancel is a fresh passkey assertion over a
   * nonce the store hands out NOW (`reissue`), so every cleared deny is a second ceremony — the
   * `progress` line tells the owner why the browser is asking again.
   * A deny whose revocation actually landed is anchored — the chain's epoch moved on or the
   * capability is dead — and is left for the store's own reconcile, never cancelled here.
   */
  async clearStaleDenies(agentId: Hex, progress?: (line: string) => void): Promise<number> {
    this.#live()
    const api = this.#api as CancelCapableApi
    let intents: RevocationIntentView[]
    try {
      intents = await api.listRevocations("active")
    } catch {
      // The store could not even be asked — same honesty rule as the CLI: a stale deny may
      // still exist, the grant below will say CAPABILITY_DENIED if it does.
      progress?.("note: could not reach the store to check for stale denies")
      return 0
    }
    let cleared = 0
    for (const intent of intents) {
      if (intent.target.kind === "agent") {
        if (intent.target.agentId.toLowerCase() !== agentId.toLowerCase()) continue
        const atIntent = intent.agentEpochAtIntent === null ? null : BigInt(intent.agentEpochAtIntent)
        if (atIntent !== null) {
          const epoch = await this.#readCapability<bigint>("agentEpoch", [this.owner, agentId])
          if (epoch > atIntent) continue // the revoke landed — anchored, not stale
        }
      } else {
        const capability = await this.#readCapability<CapabilityView>("getCapability", [intent.target.capabilityId]).catch(() => null)
        if (capability === null || capability.agentId.toLowerCase() !== agentId.toLowerCase()) continue
        const live = await this.#readCapability<boolean>("isCapabilityValid", [intent.target.capabilityId]).catch(() => false)
        if (!live) continue // the capability is dead — the deny is anchored
      }
      progress?.("A failed revoke left a block on this agent — clearing it needs one more passkey touch.")
      try {
        const reissued = await api.reissueRevocationNonce(intent.intentId)
        const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + DENY_CANCEL_EXPIRY_SECONDS
        const challenge = cancelFastRevokeDigest({
          chainId: this.#deployment.chainId,
          capabilityRegistry: this.#deployment.capabilityRegistry,
          owner: this.owner,
          revocationIntentId: intent.intentId,
          apiCancellationNonce: BigInt(reissued.cancellationNonce),
          expiresAt,
        })
        if (this.#signCancelAssertion === undefined) throw new MidaError("AUTH_INVALID", "no cancel signer was wired")
        await api.cancelRevocation(intent.intentId, {
          expiresAt,
          assertion: await this.#signCancelAssertion(challenge),
        })
      } catch (error) {
        // REPLAY means the intent anchored or was cancelled between list and reissue — a deny
        // whose revocation really landed is not stale, and clearing it would be the bug.
        if (isMidaError(error) && error.code === "REPLAY") continue
        throw error
      }
      cleared += 1
    }
    return cleared
  }

  /** §7.3 expiry: resumes writes after the earliest READ expiry closed the epoch. */
  async rotateExpiredEpoch(namespaceId: Hex): Promise<{ transactionHash: Hex; readEpoch: bigint }> {
    this.#live()
    const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])) + 1n
    const keys = await this.#epochKeys(namespaceId, next)
    const receipt = await this.#sendCapability("epoch.rotateExpired", "rotateExpiredEpoch", [namespaceId, hexOf(keys.publicKey)])
    return { transactionHash: receipt.transactionHash, readEpoch: next }
  }

  /**
   * The captured assertion → the grant struct, after proving the ceremony signed THIS grant: the
   * challenge inside clientDataJSON must equal the digest recomputed here. A mismatch means the
   * capture belongs to another challenge and would revert on chain — refuse locally instead.
   */
  #grantAssertion(challenge: Hex): WebAuthnAuthStruct {
    if (this.#assertion === undefined) {
      throw new MidaError("AUTH_INVALID", "no passkey assertion was captured for this grant")
    }
    const signed = assertionChallenge(this.#assertion)
    const expected = bytesOf(challenge, 32)
    if (!equalBytes(signed, expected)) {
      throw new MidaError(
        "AUTH_INVALID",
        `the passkey signed challenge 0x${bytesToHex(signed)}, not this grant's 0x${bytesToHex(expected)}`,
      )
    }
    return capturedToAuthStruct(this.#assertion)
  }

  async #epochKeys(namespaceId: Hex, epoch: bigint, expectedPublicKey?: Hex): Promise<EpochKeyPair> {
    const keys = deriveEpochKeyPair(await this.deriveNamespaceSecret(namespaceId), epoch)
    if (expectedPublicKey !== undefined && hexOf(keys.publicKey) !== expectedPublicKey.toLowerCase()) {
      // §11.1: the contract cannot prove key derivation; a mismatch means this seed is not the key's owner.
      throw new MidaError("COMMITMENT_MISMATCH", `derived epoch ${epoch} public key differs from the published key`)
    }
    return keys
  }

  async #readCapability<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    try {
      return (await this.#publicClient.readContract({
        address: this.#deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName,
        args,
      } as never)) as T
    } catch (error) {
      throw toMidaError(error)
    }
  }

  #sendCapability(kind: TxKind, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    return this.#send(kind, capabilityRegistryAbi, this.#deployment.capabilityRegistry, functionName, args)
  }

  async #send(kind: TxKind, abi: Abi, address: Address, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    return sendSponsoredOnly(this.#write, { address, abi, functionName, args }, kind)
  }
}

export interface PreparedGrant {
  /** The grant advice — also what the page shows the owner before the passkey touch. */
  advice: GrantAdvice
  /** The scopes+expiry the send will carry. */
  selected: { scopes: AccessRequest["scopes"]; expiresAt: bigint }
  /** sha256 of the unsigned request — the requestHash the contract and terminal check. */
  requestHash: Hex
  /** The digest the passkey ceremony must sign — the challenge for `assertOwnerPasskey`. */
  challenge: Hex
}

/**
 * Everything approveGrant needs computed BEFORE the passkey touch: the advisor's verdict (which
 * throws on a bad, expired, or forged request), the selection, and the grant digest the ceremony
 * must sign. `owner` is the EXPECTED owner (from the link) at prepare time — the flow verifies
 * the derived address equals it right after the ceremony, before any send. approveGrant re-runs
 * the same preparation, so a grantNonce that moved between the two reads fails the local
 * challenge check instead of reverting on chain.
 */
export async function prepareGrant(
  ctx: { publicClient: PublicClient; deployment: Deployment },
  owner: Address,
  request: GrantRequest,
  read: (functionName: string, args: readonly unknown[]) => Promise<unknown> = async (functionName, args) =>
    ctx.publicClient.readContract({
      address: ctx.deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName,
      args,
    } as never),
): Promise<PreparedGrant> {
  const { accessRequest } = request
  const { deployment } = ctx
  if (
    decodeUint64(accessRequest.chainId) !== deployment.chainId ||
    accessRequest.capabilityRegistry.toLowerCase() !== deployment.capabilityRegistry
  ) {
    throw new MidaError("INVALID_WIRE", "access request targets a different chain or registry than this authority")
  }
  // The request's own expiry window is checked before the agent-record and owner-history reads —
  // an expired request refuses here on one getBlock, never after a getLogs scan (in-15 J-2's
  // order, applied on the passkey page too — in-16 K-6).
  const now = await latestTimestamp(ctx)
  assertRequestFresh(accessRequest, now)
  const agentRecord = await readAgentRecord(ctx, accessRequest.agentId)
  const history = await ownerHistory({
    client: ctx.publicClient,
    deployment,
    owner,
    agentId: accessRequest.agentId,
  })
  const advice = adviseGrant({ request: accessRequest, manifest: request.manifest, agentRecord, ownerHistory: history, now })

  const selected =
    request.selection.kind === "recommended"
      ? { scopes: advice.recommended, expiresAt: decodeUint64(advice.recommendedExpiresAt) }
      : { scopes: sortScopes(request.selection.scopes), expiresAt: request.selection.expiresAt }
  if (selected.scopes.length === 0) throw new MidaError("CAPABILITY_DENIED", "nothing was selected to grant")
  assertFinalSelection({
    requestedScopes: accessRequest.scopes,
    requestedExpiresAt: decodeUint64(accessRequest.capabilityExpiresAt),
    finalScopes: selected.scopes,
    finalExpiresAt: selected.expiresAt,
    now,
  })

  const { agentSignature: _signature, ...unsigned } = accessRequest
  const requestHash = accessRequestHash(unsigned)
  const nonce = (await read("grantNonce", [owner])) as bigint
  const challenge = grantDigest({
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    owner,
    agentId: accessRequest.agentId,
    requestHash,
    manifestHash: accessRequest.manifestHash,
    manifestVersion: BigInt(accessRequest.manifestVersion),
    finalScopes: selected.scopes,
    expiresAt: selected.expiresAt,
    grantNonce: nonce,
  })
  return { advice, selected, requestHash, challenge }
}
