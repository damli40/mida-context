import { describe, expect, it } from "vitest"
import { sha256 } from "@noble/hashes/sha2.js"
import { verifyVaultAssertion } from "../../api/src/verify-assertion.js"
import { assertionToWire } from "@mida/fake-vault/browser"
import { hexOf } from "@mida/crypto"
import { RP_ID } from "../src/check/constants.js"
import { base64UrlEncode, bytesToHex, concatBytes } from "../src/check/bytes.js"
import type { CredentialsContainerLike } from "../src/check/client.js"
import { parseP256Spki } from "../src/check/spki.js"
import { makeAssertion, makeKeyPair } from "./helpers.js"
import {
  actionChallenge,
  assertionChallenge,
  capturedToAuthStruct,
  createOwnerPasskey,
  assertOwnerPasskey,
  emptyCounts,
  rpIdCompatible,
  verifyCapturedAssertion,
} from "../src/owner/webauthn.js"
import { OWNER_PRF_SALT } from "../src/owner/secrets.js"

const PRF = new Uint8Array(32).map((_, i) => i + 7)

const toBuf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

/**
 * A fake navigator.credentials that behaves like a real passkey: it signs the challenge it is
 * actually given (so the challenge substitution is exercised end to end) and answers the PRF
 * extension with a fixed secret.
 */
function fakeOwnerCredentials(key: ReturnType<typeof makeKeyPair>, opts: { rpId?: string; prfOutput?: Uint8Array } = {}) {
  const calls: { kind: "create" | "get"; publicKey: Record<string, unknown> }[] = []
  const rawId = new TextEncoder().encode("owner-credential")
  const prfOutput = opts.prfOutput ?? PRF
  const container: CredentialsContainerLike = {
    async create(options) {
      calls.push({ kind: "create", publicKey: options!.publicKey as Record<string, unknown> })
      return {
        type: "public-key",
        rawId,
        authenticatorAttachment: "platform",
        response: {
          getPublicKeyAlgorithm: () => -7,
          getPublicKey: () => toBuf(key.spki),
          getTransports: () => ["internal"],
        },
        getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: prfOutput } } }),
      }
    },
    async get(options) {
      const request = options!.publicKey as { challenge: Uint8Array; rpId: string }
      calls.push({ kind: "get", publicKey: request })
      // a real authenticator signs the challenge it was handed — the fake does too, so a client
      // that failed to substitute OUR challenge produces an assertion that fails verification.
      const assertion = makeAssertion(key.privateKey, { challenge: request.challenge, rpId: opts.rpId ?? RP_ID })
      return {
        type: "public-key",
        rawId,
        authenticatorAttachment: "platform",
        response: {
          authenticatorData: toBuf(assertion.authenticatorData),
          clientDataJSON: toBuf(assertion.clientDataJSON),
          signature: toBuf(assertion.signatureDer),
        },
        getClientExtensionResults: () => ({ prf: { results: { first: prfOutput } } }),
      }
    },
  }
  return { container, calls, rawId }
}

describe("createOwnerPasskey", () => {
  it("runs one create ceremony, evaluates our PRF salt, and captures the passkey's P-256 point", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const counts = emptyCounts()
    const result = await createOwnerPasskey({
      credentials: fake.container,
      rpId: RP_ID,
      userName: "Dami's Mida",
      counts,
    })
    expect(counts).toEqual({ create: 1, get: 0 })
    expect(result.credentialId).toBe(base64UrlEncode(fake.rawId))
    expect(result.prfOutput).toEqual(PRF)
    expect(result.algorithm).toBe(-7)
    expect(result.publicKey).toEqual({ x: key.x, y: key.y })
    // the browser was asked for OUR salt — the derivation constants are what they are because of it
    const extensions = fake.calls[0]!.publicKey["extensions"] as { prf: { eval: { first: Uint8Array } } }
    expect(extensions.prf.eval.first).toEqual(OWNER_PRF_SALT)
  })
})

describe("assertOwnerPasskey", () => {
  it("runs one get ceremony over OUR challenge and returns the assertion bytes", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const counts = emptyCounts()
    const challenge = new Uint8Array(32).fill(0xab)
    const result = await assertOwnerPasskey({
      credentials: fake.container,
      rpId: RP_ID,
      challenge,
      credentialId: base64UrlEncode(fake.rawId),
      counts,
    })
    expect(counts).toEqual({ create: 0, get: 1 })
    expect(result.credentialId).toBe(base64UrlEncode(fake.rawId))
    expect(result.prfOutput).toEqual(PRF)
    // the browser signed our challenge — not the random one Mera generated for the request
    expect(fake.calls[0]!.publicKey["challenge"]).toEqual(challenge)
    expect(assertionChallenge(result.assertion)).toEqual(challenge)
  })

  it("throws AUTH_INVALID when the platform returns a credential without assertion bytes", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const bare = fake.container
    const broken: CredentialsContainerLike = {
      create: bare.create.bind(bare),
      async get(options) {
        const credential = (await bare.get(options)) as { response: Record<string, unknown> }
        credential.response = {} // a browser that hides the bytes
        return credential
      },
    }
    await expect(
      assertOwnerPasskey({ credentials: broken, rpId: RP_ID, challenge: new Uint8Array(32).fill(1) }),
    ).rejects.toThrowError(/assertion bytes/)
  })
})

describe("capturedToAuthStruct + verifyVaultAssertion (the API's own verifier)", () => {
  it("produces a struct the off-chain contract mirror accepts — indexes, low-s and all", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const challenge = sha256(new TextEncoder().encode("a real grant digest stand-in"))
    const { assertion } = await assertOwnerPasskey({ credentials: fake.container, rpId: RP_ID, challenge })
    const struct = capturedToAuthStruct(assertion)
    // The same check apps/api applies to a deny cancellation — and the same slices the contract
    // compares. If challengeIndex/typeIndex are off this returns false, not a crash.
    const ok = verifyVaultAssertion({
      challenge: hexOf(challenge),
      assertion: assertionToWire(struct),
      qx: BigInt(`0x${bytesToHex(key.x)}`),
      qy: BigInt(`0x${bytesToHex(key.y)}`),
      rpIdHash: `0x${bytesToHex(sha256(new TextEncoder().encode(RP_ID)))}` as `0x${string}`,
    })
    expect(ok).toBe(true)
  })

  it("locates challenge and type at their declared indexes", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const challenge = new Uint8Array(32).fill(0xcd)
    const { assertion } = await assertOwnerPasskey({ credentials: fake.container, rpId: RP_ID, challenge })
    const struct = capturedToAuthStruct(assertion)
    const at = (index: bigint, len: number) => struct.clientDataJSON.slice(Number(index), Number(index) + len)
    expect(at(struct.typeIndex, '"type":"webauthn.get"'.length)).toBe('"type":"webauthn.get"')
    expect(at(struct.challengeIndex, `"challenge":"${base64UrlEncode(challenge)}"`.length)).toBe(
      `"challenge":"${base64UrlEncode(challenge)}"`,
    )
  })
})

describe("verifyCapturedAssertion", () => {
  it("accepts a real assertion over the expected challenge and registered key", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const challenge = new Uint8Array(32).fill(7)
    const { assertion } = await assertOwnerPasskey({ credentials: fake.container, rpId: RP_ID, challenge })
    const verdict = verifyCapturedAssertion({ captured: assertion, rpId: RP_ID, challenge, publicKey: { x: key.x, y: key.y } })
    expect(verdict).toEqual({ signatureOk: true, rpIdHashOk: true, userVerifiedOk: true, challengeOk: true, ok: true })
  })

  it("fails closed when the assertion signed a different challenge", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const { assertion } = await assertOwnerPasskey({
      credentials: fake.container,
      rpId: RP_ID,
      challenge: new Uint8Array(32).fill(7),
    })
    const verdict = verifyCapturedAssertion({
      captured: assertion,
      rpId: RP_ID,
      challenge: new Uint8Array(32).fill(9),
      publicKey: { x: key.x, y: key.y },
    })
    expect(verdict.challengeOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })

  it("fails when the authenticator scoped the assertion to a different rpId", async () => {
    const key = makeKeyPair()
    const fake = fakeOwnerCredentials(key, { rpId: "evil.example" })
    const challenge = new Uint8Array(32).fill(7)
    const { assertion } = await assertOwnerPasskey({ credentials: fake.container, rpId: "evil.example", challenge })
    const verdict = verifyCapturedAssertion({ captured: assertion, rpId: RP_ID, challenge, publicKey: { x: key.x, y: key.y } })
    expect(verdict.rpIdHashOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })

  it("fails the signature check against a different public key — the wrong-passkey case", async () => {
    const key = makeKeyPair()
    const other = makeKeyPair()
    const fake = fakeOwnerCredentials(key)
    const challenge = new Uint8Array(32).fill(7)
    const { assertion } = await assertOwnerPasskey({ credentials: fake.container, rpId: RP_ID, challenge })
    const verdict = verifyCapturedAssertion({
      captured: assertion,
      rpId: RP_ID,
      challenge,
      publicKey: { x: other.x, y: other.y },
    })
    expect(verdict.signatureOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })
})

describe("rpIdCompatible", () => {
  it("accepts the rpId itself and subdomains, refuses lookalikes", () => {
    expect(rpIdCompatible("midacontext.xyz", "midacontext.xyz")).toBe(true)
    expect(rpIdCompatible("app.midacontext.xyz", "midacontext.xyz")).toBe(true)
    expect(rpIdCompatible("vault.mida.xyz", "vault.mida.xyz")).toBe(true)
    expect(rpIdCompatible("evil-midacontext.xyz", "midacontext.xyz")).toBe(false)
    expect(rpIdCompatible("midacontext.xyz.evil.example", "midacontext.xyz")).toBe(false)
    // the current deployment-vs-page mismatch the flows must catch loudly
    expect(rpIdCompatible("app.midacontext.xyz", "vault.mida.xyz")).toBe(false)
  })
})

describe("actionChallenge", () => {
  it("is deterministic, domain-separated per flow, and bound to the request bytes", () => {
    const req = new TextEncoder().encode('{"agentId":"0x11"}')
    const a = actionChallenge("revoke", req)
    expect(a).toEqual(actionChallenge("revoke", req))
    expect(a).not.toEqual(actionChallenge("approve", req))
    expect(a).not.toEqual(actionChallenge("revoke", new TextEncoder().encode('{"agentId":"0x22"}')))
    expect(a).toHaveLength(32)
  })
})
