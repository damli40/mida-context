import { describe, expect, it } from "vitest"
import { parseP256Spki } from "../src/check/spki.js"
import { makeKeyPair } from "./helpers.js"

describe("parseP256Spki", () => {
  it("extracts x and y from a synthetic P-256 SPKI", () => {
    const { spki, x, y } = makeKeyPair()
    const parsed = parseP256Spki(spki)
    expect(parsed).not.toBeNull()
    expect(parsed!.x).toEqual(x)
    expect(parsed!.y).toEqual(y)
  })

  it("extracts x and y from a real WebCrypto-generated SPKI", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const parsed = parseP256Spki(spki)
    expect(parsed).not.toBeNull()
    const b64 = (s: string) => {
      const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
      return Uint8Array.from(bin, (c) => c.charCodeAt(0))
    }
    expect(parsed!.x).toEqual(b64(jwk.x!))
    expect(parsed!.y).toEqual(b64(jwk.y!))
  })

  it("returns null for a truncated buffer", () => {
    const { spki } = makeKeyPair()
    expect(parseP256Spki(spki.slice(0, 40))).toBeNull()
  })

  it("returns null when the algorithm is not EC P-256", () => {
    const { spki } = makeKeyPair()
    const mutated = spki.slice()
    mutated[20] = 0x05 // corrupt the prime256v1 OID
    expect(parseP256Spki(mutated)).toBeNull()
  })

  it("returns null for a compressed point", () => {
    const { spki } = makeKeyPair()
    const mutated = spki.slice()
    mutated[26] = 0x02 // compressed-point tag instead of 0x04 uncompressed
    expect(parseP256Spki(mutated)).toBeNull()
  })
})
