import { describe, expect, it } from "vitest"
import { base64UrlEncode, bytesToHex } from "../src/check/bytes.js"
import type { CreateCapture } from "../src/check/client.js"
import { credentialForReport } from "../src/check/report.js"
import type { SavedTestCredential } from "../src/check/storage.js"
import { makeKeyPair } from "./helpers.js"

function createdCapture(overrides: Partial<CreateCapture> = {}): CreateCapture {
  const { spki } = makeKeyPair()
  return {
    credentialId: new Uint8Array([9, 8, 7, 6]),
    algorithm: -7,
    spki,
    transports: ["internal"],
    attachment: "platform",
    prfEnabled: true,
    prfOutput: undefined,
    ...overrides,
  }
}

describe("credentialForReport", () => {
  it("returns null when nothing was captured or saved", () => {
    expect(credentialForReport(null, null)).toBeNull()
  })

  it("builds the credential from the saved record", () => {
    const { x, y } = makeKeyPair()
    const saved: SavedTestCredential = {
      credentialId: "c2F2ZWQtaWQ",
      transports: ["internal"],
      algorithm: -7,
      x: bytesToHex(x),
      y: bytesToHex(y),
    }
    expect(credentialForReport(saved, null)).toEqual({
      credentialId: "c2F2ZWQtaWQ",
      transports: ["internal"],
      algorithm: -7,
      publicKey: { x: bytesToHex(x), y: bytesToHex(y) },
    })
  })

  it("keeps the captured credential when PRF failed and nothing was saved", () => {
    const created = createdCapture()
    const point = makeKeyPair()
    created.spki = point.spki
    const credential = credentialForReport(null, created)
    expect(credential).toEqual({
      credentialId: base64UrlEncode(new Uint8Array([9, 8, 7, 6])),
      transports: ["internal"],
      algorithm: -7,
      publicKey: { x: bytesToHex(point.x), y: bytesToHex(point.y) },
    })
  })

  it("reports the captured credential with no public key when SPKI is absent", () => {
    const credential = credentialForReport(null, createdCapture({ spki: null, algorithm: null }))
    expect(credential).toEqual({
      credentialId: base64UrlEncode(new Uint8Array([9, 8, 7, 6])),
      transports: ["internal"],
      algorithm: null,
      publicKey: null,
    })
  })

  it("prefers the saved identity but fills a missing public key from the capture", () => {
    const saved: SavedTestCredential = { credentialId: "c2F2ZWQtaWQ" }
    const point = makeKeyPair()
    const credential = credentialForReport(saved, createdCapture({ spki: point.spki }))
    expect(credential?.credentialId).toBe("c2F2ZWQtaWQ")
    expect(credential?.publicKey).toEqual({ x: bytesToHex(point.x), y: bytesToHex(point.y) })
  })
})
