import { describe, expect, it } from "vitest"
import { CONTENT_SECURITY_POLICY, securityHeaders } from "../src/headers.js"
import { assetPathFor } from "../src/worker.js"

describe("securityHeaders", () => {
  it("applies the full header set on HTML", () => {
    const headers = securityHeaders(true)
    expect(headers["Content-Security-Policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        "connect-src 'self' https://testnet-rpc.monad.xyz https://store.midacontext.xyz https://sponsor.midacontext.xyz https://indexer.dev.hyperindex.xyz; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    expect(headers["Referrer-Policy"]).toBe("no-referrer")
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["Permissions-Policy"]).toBe("publickey-credentials-get=(self), publickey-credentials-create=(self)")
    expect(headers["Cache-Control"]).toBe("no-store")
  })

  it("lets non-HTML assets be cached", () => {
    const headers = securityHeaders(false)
    expect(headers["Cache-Control"]).toBeUndefined()
    expect(headers["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY)
  })
})

describe("assetPathFor", () => {
  it("serves the home page at root, the device check at /check, and the owner view at /me", () => {
    expect(assetPathFor("/")).toBe("/index.html")
    expect(assetPathFor("/check")).toBe("/check.html")
    expect(assetPathFor("/check/")).toBe("/check.html")
    expect(assetPathFor("/me")).toBe("/me.html")
    expect(assetPathFor("/me/")).toBe("/me.html")
  })

  it("passes real asset paths through", () => {
    expect(assetPathFor("/check.js")).toBe("/check.js")
    expect(assetPathFor("/check.css")).toBe("/check.css")
  })
})
