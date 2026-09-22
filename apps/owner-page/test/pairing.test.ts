import { describe, expect, it } from "vitest"
import { PAIRING_WORDS, pairingCode } from "../src/owner/pairing.js"

const enc = new TextEncoder()

describe("PAIRING_WORDS", () => {
  it("is exactly 256 unique words — one per byte value", () => {
    expect(PAIRING_WORDS).toHaveLength(256)
    expect(new Set(PAIRING_WORDS).size).toBe(256)
  })
})

describe("pairingCode", () => {
  it("matches the known answers — this is the wire contract with the terminal", () => {
    // Generated once and pinned: sha256("mida.pair.v1" ‖ requestBytes), bytes 0–2 pick words,
    // byte 3 picks digits. If these change, the word list or the hash changed and every
    // in-flight terminal↔page pair breaks.
    expect(pairingCode(new Uint8Array(0))).toBe("quiver nest scent 47")
    expect(pairingCode(enc.encode('{"agent":"mida.test"}'))).toBe("scent soap onion 76")
    expect(pairingCode(enc.encode("hello"))).toBe("olive spear scent 35")
  })

  it("is deterministic for the same request bytes", () => {
    const req = enc.encode('{"agentId":"0x11","chainId":10143}')
    expect(pairingCode(req)).toBe(pairingCode(req.slice()))
  })

  it("changes completely when a single request byte changes", () => {
    const a = pairingCode(enc.encode('{"agentId":"0x11"}'))
    const b = pairingCode(enc.encode('{"agentId":"0x12"}'))
    expect(a).not.toBe(b)
  })

  it("always prints three words and two digits", () => {
    const code = pairingCode(enc.encode("anything"))
    expect(code).toMatch(/^[a-z]+ [a-z]+ [a-z]+ \d{2}$/)
  })
})
