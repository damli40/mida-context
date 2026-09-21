import { describe, expect, it } from "vitest"
import { assertNoSecretMaterial, buildReport } from "../src/check/report.js"
import { bytesToHex } from "../src/check/bytes.js"
import { RP_ID, TEST_CHALLENGE } from "../src/check/constants.js"
import { makeKeyPair } from "./helpers.js"

const environment = {
  userAgent: "test-agent",
  platform: "TestOS",
  secureContext: true,
  webauthnAvailable: true,
  platformAuthenticatorAvailable: true,
  authenticatorAttachment: "platform",
}

function realisticInput() {
  const { x, y } = makeKeyPair()
  return {
    rpId: RP_ID,
    challengeHex: bytesToHex(TEST_CHALLENGE),
    environment,
    credential: {
      credentialId: "ZmFrZS1jcmVkZW50aWFsLWlk",
      transports: ["internal"],
      algorithm: -7,
      publicKey: { x: bytesToHex(x), y: bytesToHex(y) },
    },
    calls: { create: 1, get: 1 },
    fingerprintOfSecret: "a1b2c3d4",
    lines: [
      { id: "secure-context", status: "pass" as const, text: "ok" },
      { id: "prf", status: "pass" as const, text: "ok" },
    ],
  }
}

describe("buildReport", () => {
  it("produces a JSON-serializable report of public values", () => {
    const report = buildReport(realisticInput())
    const json = JSON.stringify(report)
    expect(json).toContain('"credentialId":"ZmFrZS1jcmVkZW50aWFsLWlk"')
    expect(json).toContain('"fingerprintOfSecret":"a1b2c3d4"')
    expect(report["credential"]).not.toBeNull()
  })

  it("contains no key named like a secret", () => {
    const report = buildReport(realisticInput())
    const keys = JSON.stringify(report)
    expect(keys).not.toMatch(/"prf(Output|Salt)?"\s*:/)
    expect(keys).not.toMatch(/"secret(?!OfSecret)/i)
  })
})

describe("assertNoSecretMaterial", () => {
  it("refuses a 32-byte value under a prf* key", () => {
    expect(() => assertNoSecretMaterial({ prfOutput: new Uint8Array(32) })).toThrow(/prfOutput/)
    expect(() => assertNoSecretMaterial({ prfSalt: new Uint8Array(32).fill(1) })).toThrow(/prfSalt/)
  })

  it("refuses 32-byte values under secret* and private* keys, nested anywhere", () => {
    expect(() => assertNoSecretMaterial({ deep: { secretBytes: new Uint8Array(32) } })).toThrow(/secretBytes/)
    expect(() => assertNoSecretMaterial([{ privateKey: "ab".repeat(32) }])).toThrow(/privateKey/)
    expect(() => assertNoSecretMaterial({ private: Array(32).fill(0) })).toThrow(/private/)
  })

  it("refuses a 64-hex-char string under a secret-looking key", () => {
    expect(() => assertNoSecretMaterial({ secretSeed: `0x${"cd".repeat(32)}` })).toThrow()
  })

  it("accepts public 32-byte values under ordinary keys", () => {
    const { x } = makeKeyPair()
    expect(() =>
      assertNoSecretMaterial({
        publicKey: { x: bytesToHex(x), y: "ab".repeat(32) },
        challenge: "ab".repeat(32),
        rpIdHash: `0x${"ef".repeat(32)}`,
        fingerprintOfSecret: "a1b2c3d4",
      }),
    ).not.toThrow()
  })

  it("accepts the report buildReport actually produces", () => {
    expect(() => assertNoSecretMaterial(buildReport(realisticInput()))).not.toThrow()
  })
})
