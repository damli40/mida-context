import { describe, expect, it } from "vitest"
import {
  PAIRING_WORDS,
  OwnerLinkError,
  buildOwnerLink,
  buildOwnerResult,
  buildOwnerReturnUrl,
  pairingCode,
  parseOwnerLink,
  parseOwnerResult,
  requestHash,
} from "../src/owner-link.js"
import type { OwnerLinkRequest } from "../src/owner-link.js"
import type { Hex } from "../src/types.js"

const OWNER = "0x1234567890abcdef1234567890abcdef12345678"
const AGENT_ID = `0x${"ab".repeat(32)}` as Hex
const NONCE = "0123456789abcdef"
const enc = new TextEncoder()

describe("pairingCode", () => {
  it("pins the three known-answer pairs the page and terminal must agree on", () => {
    expect(pairingCode(new Uint8Array(0))).toBe("quiver nest scent 47")
    expect(pairingCode(enc.encode(`{"agent":"mida.test"}`))).toBe("scent soap onion 76")
    expect(pairingCode(enc.encode("hello"))).toBe("olive spear scent 35")
  })

  it("the word list is the contract: 256 distinct entries", () => {
    expect(PAIRING_WORDS).toHaveLength(256)
    expect(new Set(PAIRING_WORDS).size).toBe(256)
  })

  it("one changed byte changes the code", () => {
    expect(pairingCode(enc.encode("hello"))).not.toBe(pairingCode(enc.encode("hellp")))
  })
})

describe("requestHash", () => {
  it("is the 0x-prefixed sha256 of the exact request bytes", () => {
    // sha256("") — the empty-input digest is the known answer.
    expect(requestHash(new Uint8Array(0))).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })
})

describe("buildOwnerLink / parseOwnerLink", () => {
  const req: OwnerLinkRequest = {
    chainId: 10143,
    owner: OWNER,
    agentId: AGENT_ID,
    readers: [`0x${"cd".repeat(32)}`],
  }

  it("builds the link the spec describes and parses it back to the same bytes", () => {
    const built = buildOwnerLink({ origin: "https://app.midacontext.xyz", flow: "revoke", req, nonce: NONCE, port: 8021 })
    expect(built.url.startsWith("https://app.midacontext.xyz/revoke#")).toBe(true)
    expect(built.url).toContain("v=1")
    expect(built.url).toContain("port=8021")
    expect(built.url).toContain(`nonce=${NONCE}`)
    expect(built.requestHash).toBe(requestHash(built.requestBytes))

    const fragment = built.url.split("#")[1]!
    const parsed = parseOwnerLink(fragment, "revoke")
    expect(parsed.nonce).toBe(NONCE)
    expect(parsed.port).toBe(8021)
    expect(parsed.requestHash).toBe(built.requestHash)
    // the bytes that came back are the bytes that went out — pairing code and hash never drift
    expect(new Uint8Array(parsed.requestBytes)).toEqual(built.requestBytes)
    expect(parsed.req).toEqual({ ...req, owner: OWNER, agentId: AGENT_ID })
  })

  it("lowercases owner and agentId before serializing, so bytes are stable", () => {
    const built = buildOwnerLink({
      origin: "https://app.midacontext.xyz",
      flow: "revoke",
      req: { chainId: 10143, owner: OWNER.toUpperCase().replace("0X", "0x") as never, agentId: AGENT_ID.toUpperCase().replace("0X", "0x") as never },
      nonce: NONCE,
      port: 8021,
    })
    const parsed = parseOwnerLink(built.url.split("#")[1]!, "revoke")
    expect(parsed.req.owner).toBe(OWNER)
    expect(parsed.req.agentId).toBe(AGENT_ID)
  })

  it("omits the port when none is given", () => {
    const built = buildOwnerLink({ origin: "https://app.midacontext.xyz", flow: "signup", req: { chainId: 10143 }, nonce: NONCE })
    expect(built.url).not.toContain("port=")
    const parsed = parseOwnerLink(built.url.split("#")[1]!, "signup")
    expect(parsed.port).toBeUndefined()
  })

  it("refuses a nonce that is not 16 hex characters", () => {
    for (const bad of ["123", "z123456789abcdef", "0123456789abcdef0"]) {
      expect(() => buildOwnerLink({ origin: "https://x", flow: "signup", req: { chainId: 1 }, nonce: bad })).toThrowError(OwnerLinkError)
    }
  })

  it("refuses a port outside 1024–65535", () => {
    for (const port of [80, 1023, 65536, 1.5]) {
      expect(() =>
        buildOwnerLink({ origin: "https://x", flow: "signup", req: { chainId: 1 }, nonce: NONCE, port }),
      ).toThrowError(OwnerLinkError)
    }
  })

  it("refuses to build a request the page would refuse — wrong flow fields, unknown keys, oversize", () => {
    expect(() =>
      buildOwnerLink({ origin: "https://x", flow: "signup", req: { chainId: 1, owner: OWNER }, nonce: NONCE }),
    ).toThrowError(OwnerLinkError)
    expect(() =>
      buildOwnerLink({ origin: "https://x", flow: "approve", req: { chainId: 1, owner: OWNER }, nonce: NONCE }),
    ).toThrowError(OwnerLinkError)
    expect(() =>
      buildOwnerLink({
        origin: "https://x",
        flow: "signup",
        req: { chainId: 1, request: { pad: "x".repeat(9 * 1024) } } as never,
        nonce: NONCE,
      }),
    ).toThrowError(OwnerLinkError)
    expect(() =>
      buildOwnerLink({
        origin: "https://x",
        flow: "signup",
        req: { chainId: 1, extra: true } as never,
        nonce: NONCE,
      }),
    ).toThrowError(OwnerLinkError)
  })

  it("refuses every refused character class in a field the page renders — one fixed sentence (in-30 T-3)", () => {
    // Control characters, line/paragraph separators, zero-width marks, bidi controls, BOM — each
    // can forge or hide inside a rendered line. The refusal is the same fixed sentence for all.
    const sentence = "This request contains characters Mida does not accept, so this page will not show or sign it."
    const entry = { agent: "claude-code", projectId: "proj-1", root: "/srv/context" }
    const dirty = (cp: number) => `text${String.fromCharCode(cp)}more`
    const fragment = (req: unknown) =>
      new URLSearchParams({ v: "1", nonce: NONCE, req: Buffer.from(JSON.stringify(req)).toString("base64url") }).toString()
    for (const cp of [0x0a, 0x85, 0x2028, 0x2029, 0x200b, 0x200e, 0x202a, 0x2067, 0xfeff]) {
      const reqs = [
        { ...req, entry: { ...entry, agent: dirty(cp) } },
        { ...req, entry: { ...entry, root: dirty(cp) } },
        { ...req, project: { id: "proj-1", label: dirty(cp) } },
        { ...req, entries: [{ ...entry, root: dirty(cp), approvedAt: "2026-01-01T00:00:00Z" }] },
      ]
      for (const request of reqs) {
        expect(() => parseOwnerLink(fragment({ ...request, chainId: 10143, owner: OWNER, request: { agentId: AGENT_ID } }), "approve")).toThrowError(
          sentence,
        )
      }
    }
  })
})

describe("buildOwnerReturnUrl / parseOwnerResult", () => {
  it("the return host is the literal 127.0.0.1 and the result round-trips", () => {
    const result = buildOwnerResult({
      v: 1,
      status: "success",
      nonce: NONCE,
      requestHash: `0x${"11".repeat(32)}`,
      owner: OWNER,
      transactions: [`0x${"22".repeat(32)}`],
      operations: [],
    })
    const url = buildOwnerReturnUrl(8021, NONCE, result)
    expect(url.startsWith("http://127.0.0.1:8021/mida-return#")).toBe(true)
    const params = new URLSearchParams(url.split("#")[1]!)
    expect(params.get("nonce")).toBe(NONCE)
    const parsed = parseOwnerResult(params.get("result")!)
    expect(parsed.status).toBe("success")
    expect(parsed.owner).toBe(OWNER)
    expect(parsed.transactions).toEqual([`0x${"22".repeat(32)}`])
  })

  it("refuses a result carrying 32 bytes under a secret-looking key", () => {
    expect(() =>
      buildOwnerResult({
        v: 1,
        status: "success",
        nonce: NONCE,
        requestHash: `0x${"11".repeat(32)}`,
        owner: OWNER,
        transactions: [],
        operations: [],
        prfOutput: `0x${"aa".repeat(32)}`,
      } as never),
    ).toThrowError(/prfOutput/)
  })

  it("parseOwnerResult refuses bad shapes and secret material", () => {
    const good = Buffer.from(JSON.stringify({
      v: 1, status: "cancelled", nonce: NONCE,
      requestHash: `0x${"11".repeat(32)}`, owner: null, transactions: [], operations: [], reason: "no",
    })).toString("base64url")
    expect(parseOwnerResult(good).status).toBe("cancelled")

    const bad = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
    for (const obj of [
      { v: 2, status: "success", nonce: NONCE, requestHash: `0x${"11".repeat(32)}`, owner: OWNER, transactions: [], operations: [] },
      { v: 1, status: "nope", nonce: NONCE, requestHash: `0x${"11".repeat(32)}`, owner: OWNER, transactions: [], operations: [] },
      { v: 1, status: "success", nonce: "zz", requestHash: `0x${"11".repeat(32)}`, owner: OWNER, transactions: [], operations: [] },
      { v: 1, status: "success", nonce: NONCE, requestHash: "0x1234", owner: OWNER, transactions: [], operations: [] },
      { v: 1, status: "success", nonce: NONCE, requestHash: `0x${"11".repeat(32)}`, owner: "not-an-address", transactions: [], operations: [] },
      { v: 1, status: "success", nonce: NONCE, requestHash: `0x${"11".repeat(32)}`, owner: OWNER, transactions: ["0x1"], operations: [] },
      { v: 1, status: "success", nonce: NONCE, requestHash: `0x${"11".repeat(32)}`, owner: OWNER, transactions: [], operations: [], seed: `0x${"ee".repeat(32)}` },
    ]) {
      expect(() => parseOwnerResult(bad(obj))).toThrowError(OwnerLinkError)
    }
    expect(() => parseOwnerResult("!!!not-base64url!!!")).toThrowError(OwnerLinkError)
    expect(() => parseOwnerResult(Buffer.from("not json").toString("base64url"))).toThrowError(OwnerLinkError)
  })
})
