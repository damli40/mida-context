import { describe, expect, it } from "vitest"
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError } from "@category-labs/mera"
import { base64UrlEncode } from "../src/check/bytes.js"
import { RP_ID, RP_NAME, TEST_CHALLENGE } from "../src/check/constants.js"
import { makeCheckClient } from "../src/check/client.js"
import type { CheckClientDeps, CredentialsContainerLike, InvocationCounts } from "../src/check/client.js"
import { makeAssertion, makeKeyPair, throwIfNotAllowed } from "./helpers.js"

/**
 * A fake navigator.credentials: records what it was asked for, answers with fabricated
 * PublicKeyCredential-shaped objects, and proves the client calls the browser exactly once per
 * ceremony while returning the shape Mera consumes.
 */
function fakeCredentials(opts: { createExt?: object; getExt?: object } = {}) {
  const calls: { kind: "create" | "get"; publicKey: Record<string, unknown> }[] = []
  const { privateKey, spki } = makeKeyPair()
  const assertion = makeAssertion(privateKey)
  const rawId = new TextEncoder().encode("fake-credential-id")

  const container: CredentialsContainerLike = {
    async create(options) {
      calls.push({ kind: "create", publicKey: options!.publicKey as Record<string, unknown> })
      return {
        type: "public-key",
        rawId,
        authenticatorAttachment: "platform",
        response: {
          getPublicKeyAlgorithm: () => -7,
          getPublicKey: () => spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength),
          getTransports: () => ["internal"],
          clientDataJSON: new Uint8Array(8).buffer,
          attestationObject: new Uint8Array(8).buffer,
        },
        getClientExtensionResults: () =>
          opts.createExt ?? { prf: { enabled: true, results: { first: new Uint8Array(32).fill(0x11) } } },
      }
    },
    async get(options) {
      const request = options!.publicKey as Record<string, unknown> & { allowCredentials?: { id: ArrayLike<number> }[] }
      calls.push({ kind: "get", publicKey: request })
      // the browser's real behavior: an unlisted credential is never offered → NotAllowedError
      throwIfNotAllowed(request.allowCredentials, rawId)
      return {
        type: "public-key",
        rawId,
        authenticatorAttachment: "platform",
        response: {
          authenticatorData: assertion.authenticatorData.buffer.slice(
            assertion.authenticatorData.byteOffset,
            assertion.authenticatorData.byteOffset + assertion.authenticatorData.byteLength,
          ),
          clientDataJSON: assertion.clientDataJSON.buffer.slice(
            assertion.clientDataJSON.byteOffset,
            assertion.clientDataJSON.byteOffset + assertion.clientDataJSON.byteLength,
          ),
          signature: assertion.signatureDer.buffer.slice(
            assertion.signatureDer.byteOffset,
            assertion.signatureDer.byteOffset + assertion.signatureDer.byteLength,
          ),
        },
        getClientExtensionResults: () => opts.getExt ?? { prf: { results: { first: new Uint8Array(32).fill(0x22) } } },
      }
    },
  }
  return { container, calls, spki, assertion, rawId }
}

function deps(credentials: CredentialsContainerLike): { deps: CheckClientDeps; counts: InvocationCounts; capture: CheckClientDeps["capture"] } {
  const counts: InvocationCounts = { create: 0, get: 0 }
  const capture: CheckClientDeps["capture"] = { create: null, get: null }
  return { deps: { credentials, challenge: TEST_CHALLENGE, counts, capture }, counts, capture }
}

describe("the check client as a WebAuthnClient", () => {
  it("createCredential returns what Mera expects and captures the public key", async () => {
    const fake = fakeCredentials()
    const { deps: d, counts, capture } = deps(fake.container)
    const client = makeCheckClient(d)

    const result = await client.createCredential({
      rp: { id: RP_ID, name: RP_NAME },
      user: { id: new Uint8Array(32), name: "n", displayName: "N" },
      challenge: new Uint8Array(32).fill(0x99),
      algorithms: [-7, -257],
      prfSalt: new Uint8Array(32).fill(0x55),
      residentKey: "required",
      userVerification: "required",
      attestation: "none",
    })

    expect(result.credentialId).toEqual(fake.rawId)
    expect(result.prfEnabled).toBe(true)
    expect(result.prfOutput).toEqual(new Uint8Array(32).fill(0x11))
    expect(result.transports).toEqual(["internal"])
    expect(counts.create).toBe(1)

    expect(capture.create?.algorithm).toBe(-7)
    expect(capture.create?.spki).toEqual(fake.spki)
    expect(capture.create?.transports).toEqual(["internal"])
    expect(capture.create?.attachment).toBe("platform")

    const options = fake.calls[0]!.publicKey
    expect(options["residentKey"]).toBeUndefined() // lives under authenticatorSelection
    const selection = options["authenticatorSelection"] as Record<string, unknown>
    expect(selection["residentKey"]).toBe("required")
    expect(selection["userVerification"]).toBe("required")
    const extensions = options["extensions"] as { prf: { eval: { first: Uint8Array } } }
    expect(extensions.prf.eval.first).toEqual(new Uint8Array(32).fill(0x55))
    const params = options["pubKeyCredParams"] as { type: string; alg: number }[]
    expect(params.map((p) => p.alg)).toEqual([-7, -257])
  })

  it("getCredential substitutes our fixed challenge and captures the assertion", async () => {
    const fake = fakeCredentials()
    const { deps: d, counts, capture } = deps(fake.container)
    const client = makeCheckClient(d)

    const meraChallenge = new Uint8Array(32).fill(0x99)
    const result = await client.getCredential({
      rpId: RP_ID,
      challenge: meraChallenge,
      prfSalt: new Uint8Array(32).fill(0x55),
      userVerification: "required",
    })

    expect(result.credentialId).toEqual(fake.rawId)
    expect(result.prfOutput).toEqual(new Uint8Array(32).fill(0x22))
    expect(counts.get).toBe(1)

    // the browser was asked to sign OUR challenge, not the random one Mera generated
    const options = fake.calls[0]!.publicKey
    expect(options["challenge"]).toEqual(TEST_CHALLENGE)
    expect(options["challenge"]).not.toEqual(meraChallenge)

    expect(capture.get?.authenticatorData).toEqual(fake.assertion.authenticatorData)
    expect(capture.get?.clientDataJSON).toEqual(fake.assertion.clientDataJSON)
    expect(capture.get?.signatureDer).toEqual(fake.assertion.signatureDer)
  })

  it("drives the real Mera functions end to end — one browser call per ceremony", async () => {
    const fake = fakeCredentials()
    const { deps: d, counts } = deps(fake.container)
    const client = makeCheckClient(d)

    const created = await createPasskeyWithPrfOutput({
      rp: { id: RP_ID, name: RP_NAME },
      user: { name: "n", displayName: "N" },
      webAuthnClient: client,
    })
    expect(created.credentialId).toBe(base64UrlEncode(fake.rawId))
    expect(created.prfOutput).toEqual(new Uint8Array(32).fill(0x11))
    expect(counts.create).toBe(1)
    expect(counts.get).toBe(0)

    const used = await getPasskeyPrfOutput({
      rpId: RP_ID,
      credential: { credentialId: created.credentialId, transports: created.transports },
      webAuthnClient: client,
    })
    expect(used.prfOutput).toEqual(new Uint8Array(32).fill(0x22))
    expect(counts.get).toBe(1)

    // the allowCredentials list carried the stored credential id back to the browser
    const getOptions = fake.calls.at(-1)!.publicKey
    const allow = getOptions["allowCredentials"] as { id: Uint8Array; type: string; transports?: string[] }[]
    expect(allow).toHaveLength(1)
    expect(allow[0]!.id).toEqual(fake.rawId)
    expect(allow[0]!.transports).toEqual(["internal"])
  })

  it("surfaces PRF_UNAVAILABLE through the real Mera path when the authenticator reports no PRF", async () => {
    const fake = fakeCredentials({ createExt: { prf: { enabled: false } } })
    const { deps: d } = deps(fake.container)
    const client = makeCheckClient(d)

    const error = await createPasskeyWithPrfOutput({
      rp: { id: RP_ID, name: RP_NAME },
      user: { name: "n", displayName: "N" },
      webAuthnClient: client,
    }).catch((e: unknown) => e)
    expect(isMeraError(error)).toBe(true)
    expect((error as { code: string }).code).toBe("PRF_UNAVAILABLE")
  })

  it("runs a second browser ceremony when create enables PRF but returns no output — the fallback prompt", async () => {
    const fake = fakeCredentials({ createExt: { prf: { enabled: true } } }) // enabled, but no results.first
    const { deps: d, counts } = deps(fake.container)
    const client = makeCheckClient(d)

    const created = await createPasskeyWithPrfOutput({
      rp: { id: RP_ID, name: RP_NAME },
      user: { name: "n", displayName: "N" },
      webAuthnClient: client,
    })
    // Mera fell back to a get ceremony — one click, two navigator.credentials invocations
    expect(created.prfOutput).toEqual(new Uint8Array(32).fill(0x22))
    expect(counts.create).toBe(1)
    expect(counts.get).toBe(1)
  })
})
