import { bytesOf, deriveEpochKeyPair, deriveNamespaceSecret, manifestHash, openContextObject } from "@mida/crypto"
import type { EpochKeyPair } from "@mida/crypto"
import { fakePrfOutput } from "@mida/fake-vault/browser"
import { MidaError, PROVENANCE_SOURCE, namespaceById } from "@mida/protocol"
import type { Address, ContextPayload, Hex, ObjectManifest, ProvenanceSource } from "@mida/protocol"
import type { LocalAccount } from "viem"
import type { Deployment } from "@mida/chain/browser"
import type { FlowEnvironment } from "../owner/flows.js"
import { deriveOwnerSecrets, ownerAccount, shortAddress } from "../owner/secrets.js"
import { loadStoredOwner, readOwnerKey, saveStoredOwner } from "../owner/session.js"
import { actionChallenge, assertOwnerPasskey } from "../owner/webauthn.js"

/**
 * The /me session. signIn runs ONE passkey `get` ceremony — the same assertOwnerPasskey the
 * owner flows use, with a domain-separated challenge whose assertion never leaves the page —
 * and feeds the PRF output straight to deriveOwnerSecrets. The owner seed then derives one
 * namespace secret per given area (the authority.ts path: fakePrfOutput over the seed, HKDF on
 * the namespace id) and release() runs before signIn returns. Only afterwards does the chain
 * get consulted: `ownerP256Key` is what separates a signed-up owner from a passkey that has
 * never registered, so the "not signed up yet" answer carries the derived address.
 *
 * What the session keeps afterwards: the derived secp256k1 account (`signer` — viem holds its
 * own internal copy of the evmKey that only GC can reclaim, same caveat OwnerSecrets carries),
 * the namespace secrets, and the epoch private keys open() derives lazily per
 * (namespaceId, readEpoch). end() overwrites every kept buffer in place and ends the session;
 * open() reports anything it cannot open as `{ ok: false }` — never a guess, never a throw
 * that takes the page down. The page renders `{ ok: false }` as "could not be opened".
 */
export interface MeSession {
  /** The owner's own address — derived from this passkey, checked against the chain's key record. */
  owner: Address
  /** The evmKey-derived account — the page hands it to makeApi so store reads carry the owner's signature. */
  signer: LocalAccount
  /**
   * Every secret byte the session still holds — the namespace secrets, plus each epoch private
   * key open() derived. end() overwrites them in place; the field exists so that overwrite is
   * observable, the same way OwnerSecrets's readonly buffers make release() visible. Never copy.
   */
  readonly secretBuffers: readonly Uint8Array[]
  /** True after end() — open() refuses and every kept byte has been overwritten. */
  readonly ended: boolean
  /**
   * Decrypt one record row in the browser — pure local crypto, no network. The manifest's own
   * consistency checks run again here; the chain-commitment check already happened in sources.ts.
   */
  /**
   * provenanceSource is the payload's OWN claim, returned as the numeric PROVENANCE_SOURCE code
   * so the page can cross-check it against the chain record — null when the payload's source is
   * not a known key.
   */
  open(row: {
    namespaceId: Hex
    readEpoch: bigint
    contextId: Hex
    manifest: unknown
    ciphertext: Hex
  }): { ok: true; text: string; provenanceSource: number | null } | { ok: false }
  /** Overwrite every kept key byte and close the session. Idempotent. */
  end(): void
}

interface SessionState {
  ended: boolean
  /** The live list of secret buffers end() must overwrite — grows as open() derives epoch keys. */
  secretBuffers: Uint8Array[]
  namespaceSecrets: Map<Hex, Uint8Array>
  epochKeys: Map<string, EpochKeyPair>
}

export async function signIn(env: FlowEnvironment, namespaces: readonly Hex[]): Promise<MeSession> {
  // Unknown areas fail before the touch — a bad input never costs a ceremony.
  const nodes = namespaces.map((id) => namespaceById(id))
  const stored = loadStoredOwner(env.storage)
  const asserted = await assertOwnerPasskey({
    credentials: env.credentials,
    rpId: env.deployment.vaultRpId,
    challenge: actionChallenge("me.signin", new Uint8Array(0)),
    ...(stored?.credentialId !== undefined ? { credentialId: stored.credentialId } : {}),
    ...(stored?.transports !== undefined ? { transports: stored.transports } : {}),
  })
  // Consumes asserted.prfOutput in place — after this line only evmKey + ownerSeed exist.
  const secrets = deriveOwnerSecrets(asserted.prfOutput)
  const state: SessionState = { ended: false, secretBuffers: [], namespaceSecrets: new Map(), epochKeys: new Map() }
  let session: MeSession | null = null
  try {
    const signer = ownerAccount(secrets)
    const owner = signer.address.toLowerCase() as Address
    for (const node of nodes) {
      const domainPrf = fakePrfOutput(secrets.ownerSeed, node.domain)
      const secret = deriveNamespaceSecret(domainPrf, node.id)
      domainPrf.fill(0)
      state.namespaceSecrets.set(node.id, secret)
      state.secretBuffers.push(secret)
    }
    // The seed's work is done — release before the chain read, before the return.
    secrets.release()
    env.onSecrets?.(secrets)
    const [qx, qy] = await readOwnerKey(env.publicClient, env.deployment, owner)
    if (qx === 0n && qy === 0n) {
      throw new MidaError(
        "AUTH_INVALID",
        `this owner (${shortAddress(owner)}) has not signed up yet — there is no passkey key registered for it on the chain`,
      )
    }
    // Merge, never overwrite: a sign-in keeps the record's transports and public point — the
    // fields /signup wrote and the ceremonies hint from — only the credential id and owner move
    // to this passkey's (in-25 P-3).
    saveStoredOwner(env.storage, { ...(stored ?? {}), credentialId: asserted.credentialId, owner })
    session = makeSession(env.deployment, owner, signer, state)
    return session
  } finally {
    if (!secrets.released) {
      secrets.release()
      env.onSecrets?.(secrets)
    }
    if (session === null) endState(state) // a failed sign-in keeps no key bytes
  }
}

function makeSession(deployment: Deployment, owner: Address, signer: LocalAccount, state: SessionState): MeSession {
  const { chainId, contextRegistry } = deployment
  return {
    owner,
    signer,
    secretBuffers: state.secretBuffers,
    get ended() {
      return state.ended
    },
    open(row) {
      if (state.ended) return { ok: false }
      try {
        const nsId = row.namespaceId.toLowerCase() as Hex
        const namespaceSecret = state.namespaceSecrets.get(nsId)
        if (namespaceSecret === undefined) return { ok: false }
        const manifest = asObjectManifest(row.manifest)
        if (manifest === null) return { ok: false }
        const keys = epochKeysFor(state, nsId, namespaceSecret, row.readEpoch)
        const payload = openContextObject({
          manifest,
          // sources.ts already matched this row against its chain commitment; the hash check
          // here is the manifest's own consistency, not a second authority.
          expectedManifestHash: manifestHash(manifest),
          ciphertext: bytesOf(row.ciphertext, manifest.ciphertextSize),
          epochPrivateKey: keys.privateKey,
          binding: {
            chainId,
            contextRegistry,
            contextId: row.contextId.toLowerCase() as Hex,
            namespaceId: nsId,
            readEpoch: row.readEpoch,
          },
        })
        return { ok: true, text: payloadText(payload), provenanceSource: payloadSource(payload) }
      } catch {
        return { ok: false }
      }
    },
    end() {
      endState(state)
    },
  }
}

/** Epoch keys are derived lazily and cached — a page reading 20 rows in one area pays one derivation. */
function epochKeysFor(state: SessionState, nsId: Hex, namespaceSecret: Uint8Array, readEpoch: bigint): EpochKeyPair {
  const cacheKey = `${nsId}:${readEpoch}`
  let keys = state.epochKeys.get(cacheKey)
  if (keys === undefined) {
    keys = deriveEpochKeyPair(namespaceSecret, readEpoch)
    state.epochKeys.set(cacheKey, keys)
    state.secretBuffers.push(keys.privateKey)
  }
  return keys
}

/** A non-object or wrong-version manifest fails here; real inconsistencies fail inside verifyObjectManifest. */
function asObjectManifest(value: unknown): ObjectManifest | null {
  if (typeof value !== "object" || value === null) return null
  const manifest = value as ObjectManifest
  return manifest.v === 1 ? manifest : null
}

/** The payload's own provenance claim as its numeric code — null when it names no known source. */
function payloadSource(payload: ContextPayload): number | null {
  const source = payload.provenance?.source
  // `in` would also admit prototype keys ("toString", "constructor") and hand back a function as
  // a "source code" — the membership test has to be own-keys only.
  if (typeof source !== "string" || !Object.hasOwn(PROVENANCE_SOURCE, source)) return null
  return PROVENANCE_SOURCE[source as ProvenanceSource]
}

/** The payload's displayable text — a bare string, a record's `text` field, else the JSON itself. */
function payloadText(payload: ContextPayload): string {
  const value = payload.value
  if (typeof value === "string") return value
  const text = (value as { text?: unknown }).text
  if (typeof text === "string") return text
  return JSON.stringify(value)
}

function endState(state: SessionState): void {
  if (state.ended) return
  state.ended = true
  for (const buffer of state.secretBuffers) buffer.fill(0)
  state.namespaceSecrets.clear()
  state.epochKeys.clear()
}
