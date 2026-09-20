// Port of spike/test/scrub.test.mjs — every case, same inputs, same
// expectations. node:test/assert → vitest describe/it/expect.

import { describe, expect, it } from "vitest"
import { scrubSecrets, scrubTranscript } from "../src/index.js"

const HEX64 = "abcdef0123456789".repeat(4)

describe("scrubSecrets", () => {
  it("env assignments whose value is wrapped in escaped quotes", () => {
    const out = scrubSecrets('export API_KEY=\\"hunter2-real-secret\\" && run')
    expect(out).toContain("API_KEY=[REDACTED]")
    expect(out).not.toContain("hunter2")
  })

  it("JSON/YAML key-value pairs redact the value, keep the key", () => {
    for (const [input, key] of [
      ['"apiKey": "deadbeefcafe1234"', '"apiKey"'],
      ["privateKey: deadbeefcafe1234", "privateKey"],
      ["'client_secret' : 'deadbeefcafe1234'", "'client_secret'"],
      ["api_token=deadbeefcafe1234", "api_token"],
    ]) {
      const out = scrubSecrets(input!)
      expect(out).not.toContain("deadbeefcafe1234")
      expect(out).toContain(key!)
      expect(out).toContain("[REDACTED]")
    }
  })

  it("short values and ordinary prose survive unchanged", () => {
    for (const text of [
      "the key idea is simple",
      'key: "user:42"',
      '"apiKey": "shrt"',
      '"password": "a long sentence here"',
    ]) {
      expect(scrubSecrets(text)).toBe(text)
    }
  })

  it("Bearer tokens redact in header and bare form", () => {
    for (const input of [
      "Authorization: Bearer tok-abc123def456",
      "Bearer tok-abc123def456",
      "authorization: bearer tok-abc123def456",
    ]) {
      const out = scrubSecrets(input)
      expect(out).not.toContain("tok-abc123def456")
      expect(out).toMatch(/[Bb]earer \[REDACTED\]/)
    }
  })

  it("bare 64-hex strings redact without a 0x prefix", () => {
    expect(scrubSecrets(`pk ${HEX64} end`)).toBe("pk [REDACTED] end")
    expect(scrubSecrets(`0x${HEX64}`)).not.toContain(HEX64)
  })
})

describe("scrubTranscript", () => {
  it("decoded JSON lines get every string scrubbed", () => {
    const line = JSON.stringify({ content: 'export API_KEY="hunter2-real-secret" && run' })
    const out = scrubTranscript(line)
    expect(out).not.toContain("hunter2")
    expect(JSON.parse(out).content).toContain("[REDACTED]")
  })

  it("sensitive JSON keys redact their values at any depth", () => {
    const line = JSON.stringify({
      cfg: { privateKey: HEX64, apiKey: "plainApiKeyValue42", note: "fine" },
    })
    const out = scrubTranscript(line)
    expect(out).not.toContain(HEX64)
    expect(out).not.toContain("plainApiKeyValue42")
    const parsed = JSON.parse(out)
    expect(parsed.cfg.privateKey).toBe("[REDACTED]")
    expect(parsed.cfg.note).toBe("fine")
  })

  it("unparseable lines fall back to raw scrubbing", () => {
    const line = 'broken tail API_KEY=\\"hunter2-real-secret\\" && run'
    const out = scrubTranscript(line)
    expect(out).not.toContain("hunter2")
    expect(out).toContain("API_KEY=[REDACTED]")
  })

  it("non-secret sentences survive a JSONL round trip", () => {
    const line = JSON.stringify({
      a: "the key idea is simple",
      b: 'key: "user:42"',
    })
    const parsed = JSON.parse(scrubTranscript(line))
    expect(parsed.a).toBe("the key idea is simple")
    expect(parsed.b).toBe('key: "user:42"')
  })
})
