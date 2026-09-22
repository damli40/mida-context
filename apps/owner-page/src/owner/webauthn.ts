import { createPasskeyWithPrfOutput, getPasskeyPrfOutput } from "@category-labs/mera"
import { sha256 } from "@noble/hashes/sha2.js"
import { MidaError, toWebAuthnAuthStruct } from "@mida/protocol"
import type { WebAuthnAuthStruct } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { makeCheckClient } from "../check/client.js"
import type { CredentialsContainerLike, InvocationCounts } from "../check/client.js"
import { parseP256Spki } from "../check/spki.js"
import type { P256PublicKey } from "../check/spki.js"
import { parseDerSignature } from "../check/der.js"
import { parseAuthenticatorData } from "../check/authdata.js"
import { verifyAssertionInBrowser } from "../check/assertion.js"
import type { BrowserVerification } from "../check/assertion.js"
import { base64UrlDecode, toBytes } from "../check/bytes.js"
import { OWNER_PRF_SALT } from "./secrets.js"

/**
 * The passkey ceremonies the owner flows run. Each flow gets ONE credential ceremony per button
 * click: `create` on signup (the passkey's own key is registered, and the same ceremony evaluates
 * the PRF salt), `get` on approve and revoke (on approve the assertion doubles as the grant
 * authorization — the contract re-verifies it — and the PRF extension returns the secret bytes in
 * the same touch).
 *
 * The capture client is the device check's: it substitutes OUR challenge for Mera's random one on
 * `get` (Mera never reads the assertion; the contract does) and copies the assertion bytes Mera
 * discards, because grantBatch needs the raw authenticatorData/clientDataJSON/signature.
 */

export type CeremonyCounts = InvocationCounts

export function emptyCounts(): CeremonyCounts {
  return { create: 0, get: 0 }
}

export interface OwnerCreateResult {
  /** Canonical unpadded base64url, as Mera reports it — the form localStorage and getCredential use. */
  credentialId: string
  /** The passkey's own P-256 point, from the SPKI the platform reported — what registerP256Key stores. */
  publicKey: P256PublicKey
  /** COSE algorithm — the flow refuses anything but −7 before a send. */
  algorithm: number | null
  transports: readonly string[] | null
  /** 32 secret bytes. Ownership passes to the caller, which hands them straight to deriveOwnerSecrets. */
  prfOutput: Uint8Array
}

export interface OwnerAssertResult {
  credentialId: string
  prfOutput: Uint8Array
  assertion: CapturedAssertion
}

/** The raw assertion bytes the contract's WebAuthn check consumes, as the browser produced them. */
export interface CapturedAssertion {
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  signatureDer: Uint8Array
}

type CaptureBox = Parameters<typeof makeCheckClient>[0]["capture"]

const RP_NAME = "Mida"

/**
 * Signup's one ceremony. Throws MeraError(PRF_UNAVAILABLE) when the passkey cannot return the
 * secret — the flow turns that into the plain-words "saved somewhere that cannot hold Mida's
 * secret" stop BEFORE anything is sent. A missing/odd public key is the same kind of stop.
 */
export async function createOwnerPasskey(input: {
  credentials: CredentialsContainerLike
  rpId: string
  userName: string
  counts?: CeremonyCounts
}): Promise<OwnerCreateResult> {
  const capture: CaptureBox = { create: null, get: null }
  const counts = input.counts ?? emptyCounts()
  const client = makeCheckClient({
    credentials: input.credentials,
    challenge: new Uint8Array(32), // unused on create — Mera's own challenge stands
    counts,
    capture,
  })
  const result = await createPasskeyWithPrfOutput({
    rp: { id: input.rpId, name: RP_NAME },
    user: { name: input.userName, displayName: input.userName },
    prfSalt: OWNER_PRF_SALT,
    webAuthnClient: client,
  })
  const created = capture.create
  const point = created?.spki ? parseP256Spki(created.spki) : null
  if (point === null) {
    throw new MidaError("AUTH_INVALID", "the passkey did not report a usable P-256 public key")
  }
  return {
    credentialId: result.credentialId,
    publicKey: point,
    algorithm: created?.algorithm ?? null,
    transports: created?.transports ?? null,
    prfOutput: result.prfOutput,
  }
}

/**
 * The one `get` ceremony approve/revoke run: signs `challenge` (approve sends the grant digest;
 * revoke signs a domain-separated action digest that never reaches a contract) and evaluates the
 * owner PRF salt in the same touch. Throws PRF_UNAVAILABLE when no secret comes back, and
 * AUTH_INVALID when the platform returned a credential without the assertion bytes the contract
 * needs — both plain stops, never silent retries.
 */
export async function assertOwnerPasskey(input: {
  credentials: CredentialsContainerLike
  rpId: string
  challenge: Uint8Array
  /** base64url credential id + transports from localStorage, when this device registered one. */
  credentialId?: string
  transports?: readonly string[]
  counts?: CeremonyCounts
}): Promise<OwnerAssertResult> {
  if (input.challenge.length !== 32) throw new MidaError("INVALID_WIRE", "the passkey challenge must be 32 bytes")
  const capture: CaptureBox = { create: null, get: null }
  const counts = input.counts ?? emptyCounts()
  const client = makeCheckClient({ credentials: input.credentials, challenge: input.challenge, counts, capture })
  const result = await getPasskeyPrfOutput({
    rpId: input.rpId,
    ...(input.credentialId !== undefined
      ? {
          credential: {
            credentialId: input.credentialId,
            ...(input.transports !== undefined ? { transports: input.transports } : {}),
          },
        }
      : {}),
    prfSalt: OWNER_PRF_SALT,
    webAuthnClient: client,
  })
  const got = capture.get
  if (!got?.authenticatorData || !got.clientDataJSON || !got.signatureDer) {
    throw new MidaError("AUTH_INVALID", "the browser did not expose the assertion bytes the contract needs")
  }
  return {
    credentialId: result.credentialId,
    prfOutput: result.prfOutput,
    assertion: {
      authenticatorData: got.authenticatorData,
      clientDataJSON: got.clientDataJSON,
      signatureDer: got.signatureDer,
    },
  }
}

function findIndexOrThrow(haystack: string, needle: string, what: string): number {
  const index = haystack.indexOf(needle)
  if (index < 0) throw new MidaError("AUTH_INVALID", `clientDataJSON has no ${what} the contract can locate`)
  return index
}

/**
 * The captured assertion → the Solidity `WebAuthnAuth` struct. challengeIndex/typeIndex are string
 * offsets into clientDataJSON where `"challenge":"<b64url>"` and `"type":"webauthn.get"` start —
 * the exact slices the contract and the API verifier compare (apps/api verify-assertion.ts). The
 * DER signature is decoded and s normalized to low-s by parseDerSignature.
 */
export function capturedToAuthStruct(captured: CapturedAssertion): WebAuthnAuthStruct {
  const signature = parseDerSignature(captured.signatureDer)
  const clientDataJSON = new TextDecoder().decode(captured.clientDataJSON)
  const typeIndex = findIndexOrThrow(clientDataJSON, '"type":"webauthn.get"', "type field")
  const challengeIndex = findIndexOrThrow(clientDataJSON, '"challenge":"', "challenge field")
  return toWebAuthnAuthStruct({
    authenticatorData: hexOf(captured.authenticatorData),
    clientDataJSON,
    challengeIndex,
    typeIndex,
    r: signature.r,
    s: signature.s,
  })
}

/** The 32-byte challenge an assertion actually signed, read out of its own clientDataJSON. */
export function assertionChallenge(captured: CapturedAssertion): Uint8Array {
  const clientDataJSON = new TextDecoder().decode(captured.clientDataJSON)
  const match = /"challenge":"([A-Za-z0-9_-]+)"/.exec(clientDataJSON)
  if (match === null) throw new MidaError("AUTH_INVALID", "clientDataJSON carries no challenge")
  return base64UrlDecode(match[1]!)
}

/**
 * The browser-side gate before any send: the signature must verify against the owner's REGISTERED
 * P-256 key (read from the chain), the rpId hash must be the deployment's vaultRpId, the UV flag
 * set, and the challenge the one the flow computed. Returns the per-check verdict so the page can
 * say exactly which fact failed in plain words.
 */
export function verifyCapturedAssertion(input: {
  captured: CapturedAssertion
  rpId: string
  challenge: Uint8Array
  /** The passkey's point — at signup from the create capture, afterwards the chain-registered key. */
  publicKey: P256PublicKey
}): BrowserVerification {
  const authInfo = parseAuthenticatorData(input.captured.authenticatorData)
  if (authInfo === null) {
    return { signatureOk: false, rpIdHashOk: false, userVerifiedOk: false, challengeOk: false, ok: false }
  }
  let signature
  try {
    signature = parseDerSignature(input.captured.signatureDer)
  } catch {
    return { signatureOk: false, rpIdHashOk: false, userVerifiedOk: false, challengeOk: false, ok: false }
  }
  return verifyAssertionInBrowser({
    authenticatorData: input.captured.authenticatorData,
    authInfo,
    clientDataJSON: input.captured.clientDataJSON,
    signature,
    publicKey: input.publicKey,
    rpId: input.rpId,
    challenge: input.challenge,
  })
}

/**
 * WebAuthn scopes a credential to an rpId that must equal the page's host or be its parent
 * domain. The deployment pins the rpId (the contract verifies its hash), so when the page is
 * served somewhere else the ceremony would fail with a browser SecurityError — the flows check
 * this first and say so in plain words instead.
 */
export function rpIdCompatible(hostname: string, rpId: string): boolean {
  const host = hostname.toLowerCase()
  const rp = rpId.toLowerCase()
  return host === rp || host.endsWith(`.${rp}`)
}

/**
 * The challenge for a `get` ceremony whose assertion never reaches a contract (revoke, and the
 * PRF-only leg of any flow): sha256("mida.owner.<flow>.v1" ‖ requestBytes). Bound to the exact
 * request bytes so the assertion can never be confused with a grant authorization.
 */
export function actionChallenge(flow: string, requestBytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`mida.owner.${flow}.v1`)
  const all = new Uint8Array(prefix.length + requestBytes.length)
  all.set(prefix, 0)
  all.set(requestBytes, prefix.length)
  return sha256(all)
}
