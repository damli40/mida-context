import { describe, expect, it } from "vitest"
import { sha256 } from "@noble/hashes/sha2.js"
import { p256 } from "@noble/curves/nist.js"
import { FLAG_UP, RP_ID, TEST_CHALLENGE } from "../src/check/constants.js"
import { parseAuthenticatorData } from "../src/check/authdata.js"
import { parseDerSignature } from "../src/check/der.js"
import { parseP256Spki } from "../src/check/spki.js"
import {
  assertionDigest,
  assertionMessage,
  buildPrecompileInput,
  verifyAssertionInBrowser,
} from "../src/check/assertion.js"
import { bigIntToBytes32, concatBytes } from "../src/check/bytes.js"
import { makeAssertion, makeKeyPair } from "./helpers.js"

describe("the full synthetic ceremony", () => {
  it("verifies an assertion over our challenge end to end", () => {
    const { privateKey, spki } = makeKeyPair()
    const publicKey = parseP256Spki(spki)!
    const assertion = makeAssertion(privateKey)
    const authInfo = parseAuthenticatorData(assertion.authenticatorData)!
    const signature = parseDerSignature(assertion.signatureDer)

    const verdict = verifyAssertionInBrowser({
      authenticatorData: assertion.authenticatorData,
      authInfo,
      clientDataJSON: assertion.clientDataJSON,
      signature,
      publicKey,
    })
    expect(verdict).toEqual({ signatureOk: true, rpIdHashOk: true, userVerifiedOk: true, challengeOk: true, ok: true })
  })

  it("fails the rpIdHash check when the assertion targets a different relying party", () => {
    const { privateKey, spki } = makeKeyPair()
    const assertion = makeAssertion(privateKey, { rpId: "evil.example" })
    const verdict = verifyAssertionInBrowser({
      authenticatorData: assertion.authenticatorData,
      authInfo: parseAuthenticatorData(assertion.authenticatorData)!,
      clientDataJSON: assertion.clientDataJSON,
      signature: parseDerSignature(assertion.signatureDer),
      publicKey: parseP256Spki(spki)!,
    })
    expect(verdict.rpIdHashOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })

  it("fails when the user-verified flag is absent", () => {
    const { privateKey, spki } = makeKeyPair()
    const assertion = makeAssertion(privateKey, { flags: FLAG_UP })
    const verdict = verifyAssertionInBrowser({
      authenticatorData: assertion.authenticatorData,
      authInfo: parseAuthenticatorData(assertion.authenticatorData)!,
      clientDataJSON: assertion.clientDataJSON,
      signature: parseDerSignature(assertion.signatureDer),
      publicKey: parseP256Spki(spki)!,
    })
    expect(verdict.userVerifiedOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })

  it("fails when the signed challenge is not our test challenge", () => {
    const { privateKey, spki } = makeKeyPair()
    const assertion = makeAssertion(privateKey, { challenge: new Uint8Array(32).fill(0xaa) })
    const verdict = verifyAssertionInBrowser({
      authenticatorData: assertion.authenticatorData,
      authInfo: parseAuthenticatorData(assertion.authenticatorData)!,
      clientDataJSON: assertion.clientDataJSON,
      signature: parseDerSignature(assertion.signatureDer),
      publicKey: parseP256Spki(spki)!,
    })
    expect(verdict.challengeOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })

  it("fails when the signature does not match the message", () => {
    const { privateKey, spki } = makeKeyPair()
    const assertion = makeAssertion(privateKey)
    const other = makeAssertion(privateKey, { flags: FLAG_UP })
    const verdict = verifyAssertionInBrowser({
      authenticatorData: assertion.authenticatorData,
      authInfo: parseAuthenticatorData(assertion.authenticatorData)!,
      clientDataJSON: assertion.clientDataJSON,
      signature: parseDerSignature(other.signatureDer), // signature over different authenticatorData
      publicKey: parseP256Spki(spki)!,
    })
    expect(verdict.signatureOk).toBe(false)
    expect(verdict.ok).toBe(false)
  })
})

describe("buildPrecompileInput", () => {
  it("lays out hash ‖ r ‖ s ‖ x ‖ y in 160 bytes", () => {
    const { privateKey, spki, x, y } = makeKeyPair()
    const assertion = makeAssertion(privateKey)
    const signature = parseDerSignature(assertion.signatureDer)
    const digest = assertionDigest(assertion.authenticatorData, assertion.clientDataJSON)
    const input = buildPrecompileInput(digest, signature, { x, y })

    expect(input.length).toBe(160)
    expect(input.slice(0, 32)).toEqual(digest)
    expect(input.slice(32, 64)).toEqual(bigIntToBytes32(signature.r))
    expect(input.slice(64, 96)).toEqual(bigIntToBytes32(signature.s))
    expect(input.slice(96, 128)).toEqual(x)
    expect(input.slice(128, 160)).toEqual(y)
    // r agrees with noble's own decode of the same DER
    const expected = p256.Signature.fromBytes(assertion.signatureDer, "der")
    expect(signature.r).toBe(expected.r)
  })

  it("the digest equals sha256(authenticatorData ‖ sha256(clientDataJSON))", () => {
    const assertion = makeAssertion(makeKeyPair().privateKey)
    const expected = sha256(assertionMessage(assertion.authenticatorData, assertion.clientDataJSON))
    expect(assertionDigest(assertion.authenticatorData, assertion.clientDataJSON)).toEqual(expected)
  })
})

describe("a signature the precompile would reject", () => {
  it("does not verify in the browser either — the two checks agree", () => {
    const { privateKey, spki } = makeKeyPair()
    const assertion = makeAssertion(privateKey)
    const tampered = concatBytes(assertion.authenticatorData, new Uint8Array([0x00]))
    const verdict = verifyAssertionInBrowser({
      authenticatorData: tampered,
      authInfo: parseAuthenticatorData(assertion.authenticatorData)!,
      clientDataJSON: assertion.clientDataJSON,
      signature: parseDerSignature(assertion.signatureDer),
      publicKey: parseP256Spki(spki)!,
    })
    expect(verdict.signatureOk).toBe(false)
  })
})
