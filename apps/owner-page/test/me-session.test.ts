import { describe, expect, it } from "vitest"
import { MidaError, namespaceById, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { deriveEpochKeyPair, deriveNamespaceSecret, hexOf, sealContextObject } from "@mida/crypto"
import { fakePrfOutput } from "@mida/fake-vault/browser"
import { DEPLOYMENT } from "../src/owner/core.js"
import { deriveOwnerSecrets, ownerAccount, shortAddress } from "../src/owner/secrets.js"
import type { OwnerSecrets } from "../src/owner/secrets.js"
import type { FlowEnvironment } from "../src/owner/flows.js"
import type { CredentialsContainerLike } from "../src/check/client.js"
import { makeAssertion, makeKeyPair } from "./helpers.js"
import { signIn } from "../src/me/session.js"

/**
 * Task 4's /me session, end to end against the same fakes flows.test.ts drives: a credentials
 * container that signs whatever challenge it is handed and answers the PRF extension with a
 * fixed secret, and a chain that answers `ownerP256Key`. The assertions pin the order the plan
 * fixes — ONE `get` ceremony, namespace secrets derived from the owner seed, `release()` before
 * signIn returns — and the decrypt contract: a row that will not open is `{ ok: false }`,
 * never a guess and never a throw that takes the page down.
 */

const PRF = new Uint8Array(32).map((_, i) => i + 1)
const OTHER_PRF = new Uint8Array(32).map((_, i) => i + 50)
const NS = namespaceId("projects.current")
const NS2 = namespaceId("profile.skills")
const CONTEXT_ID = `0x${"dd".repeat(32)}` as Hex

const passkey = makeKeyPair()
const passkeyPoint = { qx: BigInt(hexOf(passkey.x)), qy: BigInt(hexOf(passkey.y)) }

function ownerOf(prf: Uint8Array): Address {
  return ownerAccount(deriveOwnerSecrets(prf.slice())).address.toLowerCase() as Address
}
const OWNER = ownerOf(PRF)

/** The namespace secret a seed+area yields — the same derivation the session performs. */
function namespaceSecretOf(prf: Uint8Array, nsId: Hex): Uint8Array {
  const secrets = deriveOwnerSecrets(prf.slice())
  try {
    const node = namespaceById(nsId)
    return deriveNamespaceSecret(fakePrfOutput(secrets.ownerSeed, node.domain), node.id)
  } finally {
    secrets.release()
  }
}

/** A real sealed row under the epoch key this passkey's seed derives — the store's shape back. */
function sealRow(opts: { prf?: Uint8Array; nsId?: Hex; epoch?: bigint; text?: string; source?: "USER_ASSERTED" | "AGENT_INFERRED" } = {}) {
  const nsId = opts.nsId ?? NS
  const epoch = opts.epoch ?? 1n
  const keys = deriveEpochKeyPair(namespaceSecretOf(opts.prf ?? PRF, nsId), epoch)
  const sealed = sealContextObject({
    payload: {
      v: 1,
      value: { text: opts.text ?? "remembered across tools" },
      kind: "PREFERENCE",
      provenance: { source: opts.source ?? "USER_ASSERTED" },
    },
    binding: {
      chainId: DEPLOYMENT.chainId,
      contextRegistry: DEPLOYMENT.contextRegistry,
      contextId: CONTEXT_ID,
      namespaceId: nsId,
      readEpoch: epoch,
    },
    epochPublicKey: keys.publicKey,
  })
  keys.privateKey.fill(0)
  return { contextId: CONTEXT_ID, namespaceId: nsId, readEpoch: epoch, manifest: sealed.manifest, ciphertext: hexOf(sealed.ciphertext) }
}

// --- fakes ------------------------------------------------------------------

function fakeCredentials(prfOutput: Uint8Array) {
  const calls: { kind: "create" | "get"; challenge?: Uint8Array }[] = []
  const rawId = new TextEncoder().encode("owner-credential")
  const prf = prfOutput // the buffer deriveOwnerSecrets must consume in place
  const toBuf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const container: CredentialsContainerLike = {
    async create() {
      calls.push({ kind: "create" })
      throw new Error("sign-in never creates a credential")
    },
    async get(options) {
      const request = options!.publicKey as { challenge: Uint8Array }
      calls.push({ kind: "get", challenge: request.challenge })
      const assertion = makeAssertion(passkey.privateKey, { challenge: request.challenge, rpId: DEPLOYMENT.vaultRpId })
      return {
        type: "public-key",
        rawId,
        response: {
          authenticatorData: toBuf(assertion.authenticatorData),
          clientDataJSON: toBuf(assertion.clientDataJSON),
          signature: toBuf(assertion.signatureDer),
        },
        getClientExtensionResults: () => ({ prf: { results: { first: prf } } }),
      }
    },
  }
  return { container, calls }
}

function fakeChain(ownerKey: readonly [bigint, bigint] = [passkeyPoint.qx, passkeyPoint.qy]) {
  const calls: string[] = []
  const publicClient = {
    async readContract(input: { functionName: string }) {
      calls.push(`read:${input.functionName}`)
      if (input.functionName === "ownerP256Key") return [...ownerKey]
      throw new Error(`no fake for ${input.functionName}`)
    },
  }
  return { publicClient: publicClient as never, calls }
}

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  }
}

function makeEnv(opts: {
  prf?: Uint8Array
  ownerKey?: readonly [bigint, bigint]
  releasedSecrets?: OwnerSecrets[]
} = {}) {
  const credentials = fakeCredentials(opts.prf ?? PRF.slice())
  const chain = fakeChain(opts.ownerKey)
  const store = fakeStorage()
  const env: FlowEnvironment = {
    credentials: credentials.container,
    publicClient: chain.publicClient,
    deployment: DEPLOYMENT,
    storeUrl: "https://store.test",
    storage: store.storage,
    // A sign-in never sends, never builds a store client, never fetches — the page does those.
    makeSponsor: () => {
      throw new Error("sign-in never sends")
    },
    makeApi: () => {
      throw new Error("the session signs; the page builds clients")
    },
    fetchManifest: async () => {
      throw new Error("sign-in never fetches")
    },
    onSecrets: (secrets) => opts.releasedSecrets?.push(secrets),
  }
  return { env, credentials, chain, storage: store }
}

// --- tests ------------------------------------------------------------------

describe("me session", () => {
  it("one passkey touch signs in, derives the areas' secrets, then releases the owner seed", async () => {
    const releasedSecrets: OwnerSecrets[] = []
    const { env, credentials, chain } = makeEnv({ releasedSecrets })
    const session = await signIn(env, [NS, NS2])

    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"])
    expect(session.owner).toBe(OWNER)
    expect(session.signer.address.toLowerCase()).toBe(OWNER)
    // The seed lived exactly long enough to derive the areas' secrets — released before return.
    expect(releasedSecrets).toHaveLength(1)
    expect(releasedSecrets[0]!.released).toBe(true)
    expect(releasedSecrets[0]!.evmKey.every((b) => b === 0)).toBe(true)
    expect(releasedSecrets[0]!.ownerSeed.every((b) => b === 0)).toBe(true)
    // The namespace secrets survived the release: a row in either area still opens.
    for (const nsId of [NS, NS2]) {
      expect(session.open(sealRow({ nsId, text: `body for ${nsId.slice(2, 8)}` }))).toEqual({
        ok: true,
        text: `body for ${nsId.slice(2, 8)}`,
        provenanceSource: 1,
      })
    }
    // The only chain read was the owner-key check — never a write.
    expect(chain.calls).toEqual(["read:ownerP256Key"])
    session.end()
  })

  it("opens a row sealed under this passkey's epoch key", async () => {
    const { env } = makeEnv()
    const session = await signIn(env, [NS])
    expect(session.open(sealRow({ text: "the checkpoint body" }))).toEqual({ ok: true, text: "the checkpoint body", provenanceSource: 1 })
    session.end()
  })

  it("open returns the payload's own provenance claim as its numeric code", async () => {
    const { env } = makeEnv()
    const session = await signIn(env, [NS])
    // USER_ASSERTED=1 sealed in above; a payload that claims agent inference must answer 3 —
    // the page cross-checks this against the chain record's provenanceSource.
    expect(session.open(sealRow({ source: "AGENT_INFERRED" }))).toEqual({
      ok: true,
      text: "remembered across tools",
      provenanceSource: 3,
    })
    session.end()
  })

  it("a row that will not open is { ok: false }, never a guess", async () => {
    const { env } = makeEnv()
    const session = await signIn(env, [NS])
    // Sealed under a different seed — the unwrap yields garbage, the ciphertext check refuses.
    expect(session.open(sealRow({ prf: OTHER_PRF }))).toEqual({ ok: false })
    // An area this session was not given has no secret — fail closed, not a crash.
    expect(session.open(sealRow({ nsId: NS2 }))).toEqual({ ok: false })
    // A row whose epoch lies about the seal — the binding check refuses it.
    expect(session.open({ ...sealRow({ epoch: 1n }), readEpoch: 2n })).toEqual({ ok: false })
    // A manifest that is not a manifest at all — same answer, no throw.
    expect(session.open({ ...sealRow(), manifest: "not-a-manifest" })).toEqual({ ok: false })
    session.end()
  })

  it("end() zeroes every kept key byte and closes the session", async () => {
    const { env } = makeEnv()
    const session = await signIn(env, [NS])
    const row = sealRow()
    expect(session.open(row)).toEqual({ ok: true, text: "remembered across tools", provenanceSource: 1 })

    const kept = session.secretBuffers
    // The namespace secret, plus the epoch private key open() derived lazily.
    expect(kept.length).toBeGreaterThanOrEqual(2)
    session.end()
    expect(session.ended).toBe(true)
    for (const buffer of kept) expect(buffer.every((b) => b === 0)).toBe(true)
    expect(session.open(row)).toEqual({ ok: false })
    session.end() // idempotent
  })

  it("a passkey whose owner has no key on chain fails plainly", async () => {
    const releasedSecrets: OwnerSecrets[] = []
    const { env } = makeEnv({ ownerKey: [0n, 0n], releasedSecrets })
    const failure = await signIn(env, [NS]).catch((error) => error)
    expect(failure).toBeInstanceOf(MidaError)
    expect((failure as MidaError).code).toBe("AUTH_INVALID")
    expect((failure as MidaError).message).toContain("signed up")
    expect((failure as MidaError).message).toContain(shortAddress(OWNER))
    // The secrets were still released — a failed sign-in keeps nothing.
    expect(releasedSecrets[0]?.released).toBe(true)
    expect(releasedSecrets[0]?.ownerSeed.every((b) => b === 0)).toBe(true)
  })

  it("an area outside the frozen tree fails before any passkey touch", async () => {
    const { env, credentials } = makeEnv()
    const unknown = `0x${"ee".repeat(32)}` as Hex
    await expect(signIn(env, [unknown])).rejects.toThrowError(MidaError)
    expect(credentials.calls).toEqual([])
  })
})
