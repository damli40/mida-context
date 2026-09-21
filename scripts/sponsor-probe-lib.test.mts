// Unit tests for the pure parts of the sponsor probe — masking and the evidence JSON shape.
// No network: these run in the normal vitest pass.

import { describe, expect, it } from "vitest"
import { buildEvidence, maskForLog, maskHexRuns, maskSecrets } from "./sponsor-probe-lib.mjs"

const ADDRESS = "0xF07D24dBD1FE21645a0489a94baE2c99d7E0E80b"
const HASH = "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45"
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

describe("maskHexRuns", () => {
  it("masks a 0x-prefixed address, a 64-hex hash and a bare 40-hex run", () => {
    const line = `registry ${ADDRESS} tx ${HASH} bare ${PRIVATE_KEY.slice(2)}`
    const masked = maskHexRuns(line)
    expect(masked).not.toContain(ADDRESS.slice(11))
    expect(masked).not.toContain(HASH.slice(11))
    expect(masked).not.toContain(PRIVATE_KEY.slice(11))
    expect(masked).toContain("…[masked]")
  })

  it("leaves short hex alone — only 40+ runs are secret-shaped", () => {
    expect(maskHexRuns("chain 0x279f block 0x1a2b selector 0xb61d27f6")).toBe("chain 0x279f block 0x1a2b selector 0xb61d27f6")
  })

  it("keeps allow-listed runs readable, case-insensitively", () => {
    const masked = maskHexRuns(`fresh ${ADDRESS.toLowerCase()} tx ${HASH}`, [ADDRESS])
    expect(masked).toContain(ADDRESS.toLowerCase())
    expect(masked).not.toContain(HASH.slice(11))
  })
})

describe("maskSecrets", () => {
  it("replaces every occurrence of each secret", () => {
    expect(maskSecrets(`key=sp_secret_key_123&again=sp_secret_key_123`, ["sp_secret_key_123"])).toBe("key=[redacted]&again=[redacted]")
  })

  it("skips secrets shorter than 8 characters and undefined entries", () => {
    expect(maskSecrets("a tiny key", ["tiny", undefined, "key"])).toBe("a tiny key")
  })

  it("a provider error echoing the api key cannot leak it", () => {
    const apiKey = "pim_secret_abcdef123456"
    const providerError = `{"code":-32000,"message":"upstream rejected apikey=${apiKey} with 401"}`
    expect(maskSecrets(providerError, [apiKey])).not.toContain(apiKey)
  })
})

describe("maskForLog", () => {
  it("redacts a hex-shaped secret whole instead of leaving a partial hex mask", () => {
    // Order matters: secrets first, then hex runs — a private key must be [redacted], not
    // "0x59c6995e9…[masked]" which would leak its first bytes.
    expect(maskForLog(`oops ${PRIVATE_KEY}`, { secrets: [PRIVATE_KEY] })).toBe("oops [redacted]")
  })

  it("applies both layers to ordinary evidence text", () => {
    const out = maskForLog(`sent ${HASH} for ${ADDRESS} with pim_key_99999`, { secrets: ["pim_key_99999"], allow: [HASH] })
    expect(out).toContain(HASH)
    expect(out).toContain("[redacted]")
    expect(out).not.toContain(ADDRESS.slice(11))
  })
})

describe("buildEvidence", () => {
  it("emits the documented shape: probe id, chain, address, ordered steps, counted summary", () => {
    const evidence = buildEvidence({
      chainId: 10143,
      freshAddress: ADDRESS,
      steps: [
        { id: "a", name: "fresh-account", status: "pass", detail: { balanceWei: "0" } },
        { id: "b", name: "implementation-code", status: "fail", detail: { reason: "empty" } },
        { id: "c", name: "sponsored-register", status: "skip", detail: { reason: "no key" } },
      ],
    })
    expect(evidence.probe).toBe("m3-sponsor-probe")
    expect(evidence.chainId).toBe(10143)
    expect(evidence.freshAddress).toBe(ADDRESS)
    expect(evidence.steps.map((step) => step.id)).toEqual(["a", "b", "c"])
    expect(evidence.summary).toEqual({ passed: 1, failed: 1, skipped: 1 })
    expect(new Date(evidence.generatedAt).toString()).not.toBe("Invalid Date")
  })
})
