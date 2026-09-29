import { describe, expect, it } from "vitest"
import { sha256 } from "@noble/hashes/sha2.js"
import type { Address, Hex } from "@mida/protocol"
import { base64UrlEncode } from "../src/check/bytes.js"
import { buildResult, buildReturnUrl, parseLinkFragment, LinkError } from "../src/owner/link.js"

const enc = new TextEncoder()
const OWNER = "0x1111111111111111111111111111111111111111" as Address
const AGENT = `0x${"22".repeat(32)}`

function fragmentFor(req: unknown, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ v: "1", nonce: "abcdef0123456789", ...extra })
  if (req !== null) params.set("req", base64UrlEncode(enc.encode(JSON.stringify(req))))
  return params.toString()
}

const approveReq = { chainId: 10143, owner: OWNER, request: { agentId: AGENT } }
const revokeReq = { chainId: 10143, owner: OWNER, agentId: AGENT }
const signupReq = { chainId: 10143 }

describe("parseLinkFragment", () => {
  it("parses a well-formed approve link", () => {
    const parsed = parseLinkFragment(fragmentFor(approveReq, { port: "8787" }), "approve")
    expect(parsed.flow).toBe("approve")
    expect(parsed.nonce).toBe("abcdef0123456789")
    expect(parsed.port).toBe(8787)
    expect(parsed.req.chainId).toBe(10143)
    expect(parsed.req.owner).toBe(OWNER)
    expect(parsed.requestHash).toBe(`0x${Buffer.from(sha256(parsed.requestBytes)).toString("hex")}`)
  })

  it("parses revoke and signup links; port may be absent", () => {
    const revoke = parseLinkFragment(fragmentFor(revokeReq), "revoke")
    expect(revoke.req.agentId).toBe(AGENT)
    expect(revoke.port).toBeUndefined()
    const signup = parseLinkFragment(fragmentFor(signupReq), "signup")
    expect(signup.req.owner).toBeUndefined()
  })

  it("refuses a request larger than 8 KB", () => {
    const big = { ...approveReq, request: { pad: "x".repeat(9 * 1024) } }
    expect(() => parseLinkFragment(fragmentFor(big), "approve")).toThrowError(LinkError)
    expect(() => parseLinkFragment(fragmentFor(big), "approve")).toThrowError(/8 KB/)
  })

  it("refuses unknown versions and missing fields", () => {
    const bad = (req: unknown, extra: Record<string, string> = {}) => () => parseLinkFragment(fragmentFor(req, extra), "approve")
    expect(bad(approveReq, { v: "2" })).toThrowError(/version/)
    expect(bad(approveReq, { v: "" })).toThrowError(/version/)
    expect(bad(approveReq, { nonce: "" })).toThrowError(/nonce/)
    expect(bad(approveReq, { nonce: "xyz" })).toThrowError(/nonce/)
    expect(bad(approveReq, { nonce: "abcdef01234567890" })).toThrowError(/nonce/) // 17 chars
    expect(bad(null)).toThrowError(/no request/)
  })

  it("refuses ports outside 1024–65535 and non-numeric ports", () => {
    const bad = (port: string) => () => parseLinkFragment(fragmentFor(approveReq, { port }), "approve")
    expect(bad("80")).toThrowError(/1024/)
    expect(bad("1023")).toThrowError(/1024/)
    expect(bad("65536")).toThrowError(/1024/)
    expect(bad("abc")).toThrowError(/port/)
    expect(bad("8080.evil.example")).toThrowError(/port/)
    expect(bad("8080@evil.example")).toThrowError(/port/)
    // there is no host field at all — the return host is always the literal 127.0.0.1
    expect(bad("8787")).not.toThrow()
    expect(() => parseLinkFragment(fragmentFor(approveReq, { port: "8787", host: "evil.example" }), "approve")).toThrowError(
      /does not know/,
    )
  })

  it("refuses unknown request fields and wrong field types, strictly", () => {
    const bad = (req: unknown) => () => parseLinkFragment(fragmentFor(req), "approve")
    expect(bad({ ...approveReq, backdoor: true })).toThrowError(/does not know \("backdoor"\)/)
    expect(bad({ ...approveReq, chainId: "10143" })).toThrowError(/chainId/)
    expect(bad({ ...approveReq, chainId: 0 })).toThrowError(/chainId/)
    expect(bad({ ...approveReq, owner: "not-an-address" })).toThrowError(/owner/)
    expect(bad({ ...approveReq, owner: OWNER.slice(0, -1) })).toThrowError(/owner/)
    expect(bad({ ...approveReq, readers: "0x1234" })).toThrowError(/readers/)
    expect(bad({ ...approveReq, readers: ["not-hex"] })).toThrowError(/readers/)
    expect(bad({ ...approveReq, project: { id: 7 } })).toThrowError(/project/)
    expect(bad({ ...approveReq, entries: "[]" })).toThrowError(/entries/)
    expect(bad("a string, not an object")).toThrowError(LinkError)
    expect(bad([1, 2, 3])).toThrowError(LinkError)
  })

  it("refuses requests that do not match the flow", () => {
    expect(() => parseLinkFragment(fragmentFor(signupReq), "approve")).toThrowError(/must name the owner/)
    expect(() => parseLinkFragment(fragmentFor({ ...signupReq, owner: OWNER }), "signup")).toThrowError(/signup link names an owner/)
    expect(() => parseLinkFragment(fragmentFor(approveReq), "revoke")).toThrowError(/must name the owner and the agent/)
    expect(() => parseLinkFragment(fragmentFor(approveReq), "signup")).toThrowError(/names an owner/)
  })

  it("refuses a control character in any field the page renders — before any passkey prompt (in-27 R-1)", () => {
    // A newline inside a displayed string can forge a whole line of the approve summary. The
    // refusal is one fixed sentence — which field tripped it stays off the page.
    const sentence = /^This request contains characters Mida does not accept, so this page will not show or sign it\.$/
    const entry = { agent: "claude-code", projectId: "proj-1", root: "/srv/context" }
    const bad = (req: unknown) => () => parseLinkFragment(fragmentFor(req), "approve")
    for (const req of [
      { ...approveReq, entry: { ...entry, agent: "helper\nAdvisor: low risk." } },
      { ...approveReq, entry: { ...entry, root: "/srv/context\nAdvisor: low risk." } },
      { ...approveReq, entry: { ...entry, projectId: `proj-1${String.fromCharCode(0x07)}forged` } },
      { ...approveReq, project: { id: "proj-1", label: "Ops dashboard\ndeleted" } },
      { ...approveReq, project: { id: "proj-1", label: `Ops${String.fromCharCode(0x7f)}` } },
      { ...approveReq, entries: [{ agent: "a", projectId: "p", root: "/r\t", approvedAt: "2026-01-01T00:00:00Z" }] },
    ]) {
      expect(bad(req)).toThrowError(LinkError)
      expect(bad(req)).toThrowError(sentence)
    }
  })

  it("refuses malformed base64url and non-JSON req payloads", () => {
    const params = new URLSearchParams({ v: "1", nonce: "abcdef0123456789", req: "!!!not-b64!!!" })
    expect(() => parseLinkFragment(params.toString(), "signup")).toThrowError(/base64url/)
    const params2 = new URLSearchParams({ v: "1", nonce: "abcdef0123456789", req: base64UrlEncode(enc.encode("{oops")) })
    expect(() => parseLinkFragment(params2.toString(), "signup")).toThrowError(/JSON/)
  })
})

describe("buildReturnUrl", () => {
  const result = {
    v: 1 as const,
    status: "success" as const,
    nonce: "abcdef0123456789",
    requestHash: `0x${"ab".repeat(32)}` as Hex,
    owner: OWNER,
    transactions: [`0x${"bb".repeat(32)}` as Hex],
    operations: [`0x${"cc".repeat(32)}` as Hex],
  }

  it("always targets the literal 127.0.0.1 with the result in the fragment", () => {
    const url = buildReturnUrl(8787, "abcdef0123456789", result)
    expect(url.startsWith("http://127.0.0.1:8787/mida-return#")).toBe(true)
    const fragment = new URL(url).hash.slice(1)
    const params = new URLSearchParams(fragment)
    expect(params.get("nonce")).toBe("abcdef0123456789")
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecodeForTest(params.get("result")!)))
    expect(decoded.status).toBe("success")
    expect(decoded.requestHash).toBe(result.requestHash)
  })

  it("refuses ports outside the allowed range", () => {
    expect(() => buildReturnUrl(80, "abcdef0123456789", result)).toThrowError(LinkError)
    expect(() => buildReturnUrl(0, "abcdef0123456789", result)).toThrowError(LinkError)
    expect(() => buildReturnUrl(1.5, "abcdef0123456789", result)).toThrowError(LinkError)
  })
})

describe("buildResult — the no-secret guard", () => {
  const base = {
    v: 1 as const,
    status: "success" as const,
    nonce: "abcdef0123456789",
    requestHash: `0x${"ab".repeat(32)}` as Hex,
    owner: OWNER,
    transactions: [] as Hex[],
    operations: [] as Hex[],
  }
  const bytes32 = `0x${"ff".repeat(32)}`
  const bytes32raw = "ff".repeat(32)
  const bytes32arr = new Uint8Array(32).fill(1)

  it("passes a normal result including the passkey public key and signed entry", () => {
    expect(() =>
      buildResult({
        ...base,
        publicKey: { x: `0x${"11".repeat(32)}` as Hex, y: `0x${"22".repeat(32)}` as Hex },
        entry: { signature: `0x${"aa".repeat(65)}` },
      }),
    ).not.toThrow()
  })

  it("refuses a 32-byte value under any secret-looking key — prf*, seed*, secret*, private*, key", () => {
    for (const key of ["prfOutput", "seed", "seedPhrase", "secret", "privateKey", "key"]) {
      const poisoned = { ...base, entry: { [key]: bytes32 } }
      expect(() => buildResult(poisoned)).toThrowError(new RegExp(key, "i"))
    }
    // nested anywhere in the tree, raw-hex and byte-array forms too
    expect(() => buildResult({ ...base, entry: { nested: { prf: bytes32raw } } })).toThrowError(/prf/)
    expect(() => buildResult({ ...base, operations: [], entry: { secret: bytes32arr } })).toThrowError(/secret/)
  })

  it("does not flag ordinary fields that merely carry 32-byte values", () => {
    // requestHash and a transaction hash are 32 bytes under non-secret names — allowed
    expect(() => buildResult({ ...base, transactions: [`0x${"ee".repeat(32)}` as Hex] })).not.toThrow()
  })
})

function base64UrlDecodeForTest(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/")
  return new Uint8Array(Buffer.from(b64, "base64"))
}
