import { zeroHash } from "viem"
import type { LocalAccount, PublicClient } from "viem"
import { isMeraError } from "@category-labs/mera"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { capabilityRegistryAbi, createSponsoredSender, toMidaError } from "@mida/chain/browser"
import type { Deployment, SponsoredSender } from "@mida/chain/browser"
import { ContextApiClient } from "@mida/api/browser"
import type { VaultContextApi } from "@mida/fake-vault/browser"
import { hexOf } from "@mida/crypto"
import { SponsorDidNotPay, SponsorPending } from "@mida/chain/browser"
import { bytesToHex } from "../check/bytes.js"
import type { P256PublicKey } from "../check/spki.js"
import { shortAddress } from "./secrets.js"

/**
 * What the page may keep between visits — and all of it: the credential id, the passkey's public
 * point, and the owner address. localStorage never holds a secret byte. Everything else about a
 * session lives in memory for the length of one flow.
 */

const STORAGE_KEY = "mida.owner.v1"

export interface StoredOwner {
  credentialId: string
  transports?: string[]
  /** The passkey's registered P-256 point, unprefixed hex — public metadata. */
  x?: string
  y?: string
  owner?: Address
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function loadStoredOwner(storage: StorageLike): StoredOwner | null {
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return null // storage can throw (private mode) — absence, never a failure
  }
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.credentialId !== "string" || record.credentialId === "") return null
    const out: StoredOwner = { credentialId: record.credentialId }
    if (Array.isArray(record.transports) && record.transports.every((t) => typeof t === "string")) {
      out.transports = record.transports
    }
    if (typeof record.x === "string" && /^[0-9a-f]{64}$/i.test(record.x)) out.x = record.x
    if (typeof record.y === "string" && /^[0-9a-f]{64}$/i.test(record.y)) out.y = record.y
    if (typeof record.owner === "string" && /^0x[0-9a-fA-F]{40}$/.test(record.owner)) {
      out.owner = record.owner.toLowerCase() as Address
    }
    return out
  } catch {
    return null
  }
}

export function saveStoredOwner(storage: StorageLike, record: StoredOwner): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // storage full or blocked — the flow still worked; the next visit just cannot prefill the hint
  }
}

/**
 * Record the credential that actually answered a ceremony. transports/x/y describe the
 * credential they were written for — they merge only onto an unchanged credential id; a
 * different credential replaces the record whole (in-26 Q-1). Called when a discoverable
 * ceremony answered: /me sign-in always, and an owner flow's retry after its hint missed —
 * without it every future prompt repeats the miss (in-27 R-2).
 */
export function recordAnsweredCredential(storage: StorageLike, credentialId: string, owner: Address): void {
  const stored = loadStoredOwner(storage)
  saveStoredOwner(storage, {
    ...(stored !== null && stored.credentialId === credentialId ? stored : {}),
    credentialId,
    owner,
  })
}

/** Thrown when the passkey maps to a different owner than the link (or this device) expects. */
export class WrongOwnerError extends MidaError {
  constructor(derived: Address, expected: Address) {
    super(
      "AUTH_INVALID",
      `this passkey belongs to a different Mida owner (${shortAddress(derived)}) than the one your terminal is using (${shortAddress(expected)})`,
    )
    this.name = "WrongOwnerError"
  }
}

/**
 * The wrong-owner check every post-signup flow runs right after the single passkey touch, before
 * any network write: the address derived from THIS passkey's PRF output must equal the owner the
 * link names. What this device remembers is deliberately not a second gate — a shared browser
 * holding passkey B's record must not refuse owner A's valid link (in-25 P-3). A passkey that
 * derives an owner with no key registered on chain "has not signed up yet" — a different,
 * plainer failure than a mismatch.
 */
export async function assertExpectedOwner(input: {
  derived: Address
  expected: Address
  publicClient: PublicClient
  deployment: Deployment
  /** When true (approve), also verify the captured assertion against the chain-registered key. */
}): Promise<{ registeredKey: { qx: bigint; qy: bigint } | null }> {
  if (input.derived !== input.expected.toLowerCase()) {
    throw new WrongOwnerError(input.derived, input.expected)
  }
  const [qx, qy] = await readOwnerKey(input.publicClient, input.deployment, input.derived)
  if (qx === 0n && qy === 0n) {
    return { registeredKey: null }
  }
  return { registeredKey: { qx, qy } }
}

/** The on-chain owner key — `ownerP256Key` returns (0, 0) for an owner that never signed up. */
export async function readOwnerKey(
  publicClient: PublicClient,
  deployment: Deployment,
  owner: Address,
): Promise<readonly [bigint, bigint]> {
  try {
    return (await publicClient.readContract({
      address: deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "ownerP256Key",
      args: [owner],
    } as never)) as readonly [bigint, bigint]
  } catch (error) {
    throw toMidaError(error)
  }
}

/** The public key form `verifyCapturedAssertion` and `registerP256Key` both want. */
export function storedPoint(record: StoredOwner | null): P256PublicKey | null {
  if (record?.x === undefined || record.y === undefined) return null
  const bytes = (hex: string) => {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  return { x: bytes(record.x), y: bytes(record.y) }
}

export function pointFromStored(record: { x: string; y: string }): { x: Hex; y: Hex } {
  return { x: `0x${record.x}` as Hex, y: `0x${record.y}` as Hex }
}

/** The sponsored sender for one ceremony's derived account. The flows wrap it to record sends. */
export function makeSponsoredSender(input: {
  account: LocalAccount
  sponsorUrl: string
  rpcUrl: string
  deployment: Deployment
  progress?: (line: string) => void
}): SponsoredSender {
  return createSponsoredSender({
    sponsorUrl: input.sponsorUrl,
    rpcUrl: input.rpcUrl,
    account: input.account,
    deployment: input.deployment,
    progress: input.progress,
  })
}

/** The hosted-store client, signing as the derived owner — raw PRF material never leaves the page. */
export function makeOwnerApi(input: {
  account: LocalAccount
  storeUrl: string
  deployment: Deployment
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}): VaultContextApi {
  return new ContextApiClient({
    baseUrl: input.storeUrl,
    account: input.account,
    chainId: input.deployment.chainId,
    capabilityRegistry: input.deployment.capabilityRegistry,
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
  })
}

/**
 * Errors → the plain words the page shows. Three cases the owner must never confuse: the sponsor
 * refusing (try again later, nothing was sent), the sponsor accepting but not confirming
 * (pending — check the hash, never resend), and the passkey that cannot hold the secret (the
 * signup-stop message the brief fixes verbatim).
 */
export function describeError(error: unknown): string {
  if (error instanceof SponsorPending) {
    return "accepted, still landing — check again in a minute"
  }
  if (error instanceof SponsorDidNotPay) {
    return `the gas sponsor refused: ${error.reason}`
  }
  if (isMeraError(error) && error.code === "PRF_UNAVAILABLE") {
    return "This passkey was saved somewhere that cannot hold Mida's secret. Delete it and create it again, choosing iCloud Keychain, Google Password Manager or 1Password — not 'this device' / 'your Chrome profile'."
  }
  if (error instanceof MidaError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export { bytesToHex, hexOf, zeroHash }
