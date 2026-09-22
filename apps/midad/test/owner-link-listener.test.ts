import { describe, expect, it } from "vitest"
import { buildOwnerReturnUrl } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { startReturnListener, newOwnerNonce } from "../src/owner-link/listener.js"

/**
 * The listener is the terminal's half of the return channel: the page navigates to
 * http://127.0.0.1:<port>/mida-return#nonce=…&result=…, the served page POSTs the fragment
 * back, and the listener hands the decoded result to the waiting command — once.
 */

const NONCE = "0123456789abcdef"
const RESULT_HASH = `0x${"42".repeat(32)}` as Hex

function goodResult(nonce = NONCE) {
  return {
    v: 1 as const,
    status: "success" as const,
    nonce,
    requestHash: RESULT_HASH,
    owner: "0x1234567890abcdef1234567890abcdef12345678" as const,
    transactions: [`0x${"77".repeat(32)}`] as Hex[],
    operations: [] as Hex[],
  }
}

/** What the served page does: read location.hash, POST it to the same path. */
async function postFragment(port: number, fragment: string) {
  return fetch(`http://127.0.0.1:${port}/mida-return`, { method: "POST", body: fragment })
}

function fragmentFor(port: number, result: object, nonce = NONCE): string {
  const url = buildOwnerReturnUrl(port, nonce, result as never)
  return url.split("#")[1]!
}

describe("startReturnListener", () => {
  it("newOwnerNonce issues 16 lowercase hex characters", () => {
    expect(newOwnerNonce()).toMatch(/^[0-9a-f]{16}$/)
    expect(newOwnerNonce()).not.toBe(newOwnerNonce())
  })

  it("happy path: serves the return page, accepts the fragment POST, resolves once", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    try {
      const get = await fetch(`http://127.0.0.1:${listener.port}/mida-return`)
      expect(get.status).toBe(200)
      const html = await get.text()
      // no external resources — the page must work with everything on this one response
      expect(html).not.toMatch(/https?:\/\//)
      expect(html).not.toMatch(/src=["']|href=["']/)
      // CSP: nothing by default, the one inline script by hash, POSTs to self only
      const csp = get.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("default-src 'none'")
      expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
      expect(csp).toContain("connect-src 'self'")
      expect(get.headers.get("access-control-allow-origin")).toBeNull()

      const res = await postFragment(listener.port, fragmentFor(listener.port, goodResult()))
      expect(res.status).toBe(200)
      const result = await listener.result
      expect(result.status).toBe("success")
      expect(result.owner).toBe("0x1234567890abcdef1234567890abcdef12345678")
      // the listener closed itself after resolving
      const after = await fetch(`http://127.0.0.1:${listener.port}/mida-return`).catch((e) => e)
      expect(after instanceof Error).toBe(true)
    } finally {
      listener.close()
    }
  })

  it("a POST with a different nonce gets 409 and the listener keeps waiting", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    listener.result.catch(() => {}) // settle handler — the test resolves it at the end
    try {
      const wrong = await postFragment(listener.port, fragmentFor(listener.port, goodResult("ffffffffffffffff"), "ffffffffffffffff"))
      expect(wrong.status).toBe(409)
      const right = await postFragment(listener.port, fragmentFor(listener.port, goodResult()))
      expect(right.status).toBe(200)
      await listener.result
    } finally {
      listener.close()
    }
  })

  it("a second POST after the result resolved gets 409", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    const first = await postFragment(listener.port, fragmentFor(listener.port, goodResult()))
    expect(first.status).toBe(200)
    await listener.result
    const second = await postFragment(listener.port, fragmentFor(listener.port, goodResult())).catch((e) => e)
    // the server may already be closed — either a refusal or a connection error is honest
    expect(second instanceof Error ? true : second.status === 409).toBe(true)
    listener.close()
  })

  it("a malformed fragment gets 400 and the listener keeps waiting", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    listener.result.catch(() => {})
    try {
      for (const body of ["", `nonce=${NONCE}`, `result=zzz&nonce=${NONCE}`, `nonce=${NONCE}&result=${Buffer.from("not json").toString("base64url")}`]) {
        const res = await postFragment(listener.port, body)
        expect(res.status).toBe(400)
      }
      const res = await postFragment(listener.port, fragmentFor(listener.port, goodResult()))
      expect(res.status).toBe(200)
      await listener.result
    } finally {
      listener.close()
    }
  })

  it("a result whose inner nonce differs from the fragment nonce gets 400", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    listener.result.catch(() => {})
    try {
      const res = await postFragment(listener.port, fragmentFor(listener.port, goodResult("ffffffffffffffff")))
      expect(res.status).toBe(400)
      listener.close()
    } finally {
      listener.close()
    }
  })

  it("a body over 16 KB gets 400", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    listener.result.catch(() => {})
    try {
      const res = await postFragment(listener.port, `nonce=${NONCE}&result=${"x".repeat(17 * 1024)}`)
      expect(res.status).toBe(400)
      listener.close()
    } finally {
      listener.close()
    }
  })

  it("any other path gets 404", async () => {
    const listener = await startReturnListener({ nonce: NONCE })
    listener.result.catch(() => {})
    try {
      expect((await fetch(`http://127.0.0.1:${listener.port}/`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${listener.port}/favicon.ico`)).status).toBe(404)
    } finally {
      listener.close()
    }
  })

  it("rejects with OWNER_LINK_TIMEOUT when the wait runs out", async () => {
    const listener = await startReturnListener({ nonce: NONCE, timeoutMs: 30 })
    await expect(listener.result).rejects.toMatchObject({ code: "OWNER_LINK_TIMEOUT" })
    listener.close()
  })

  it("close() before any POST rejects the waiter and frees the port", async () => {
    const listener = await startReturnListener({ nonce: NONCE, timeoutMs: 60_000 })
    const watched = listener.result.catch((e) => e)
    listener.close()
    await expect(watched).resolves.toMatchObject({ code: "OWNER_LINK_CLOSED" })
    const res = await fetch(`http://127.0.0.1:${listener.port}/mida-return`).catch((e) => e)
    expect(res instanceof Error).toBe(true)
    listener.close() // idempotent
  })
})
