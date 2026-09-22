import { describe, expect, it } from "vitest"
import { sha256 } from "@noble/hashes/sha2.js"
import { FLAG_AT, FLAG_UP, FLAG_UV, RP_ID } from "../src/check/constants.js"
import { parseAuthenticatorData } from "../src/check/authdata.js"
import { makeAuthenticatorData } from "./helpers.js"

describe("parseAuthenticatorData", () => {
  it("reads rpIdHash, flags and the signature counter", () => {
    const info = parseAuthenticatorData(makeAuthenticatorData())
    expect(info).not.toBeNull()
    expect(info!.rpIdHash).toEqual(sha256(new TextEncoder().encode(RP_ID)))
    expect(info!.userPresent).toBe(true)
    expect(info!.userVerified).toBe(true)
    expect(info!.attestedCredentialData).toBe(false)
    expect(info!.signCount).toBe(1)
  })

  it("reports a missing user-verified flag", () => {
    const info = parseAuthenticatorData(makeAuthenticatorData(RP_ID, FLAG_UP | FLAG_AT))
    expect(info!.userVerified).toBe(false)
    expect(info!.attestedCredentialData).toBe(true)
  })

  it("returns null for a short buffer", () => {
    expect(parseAuthenticatorData(new Uint8Array(36))).toBeNull()
  })
})
