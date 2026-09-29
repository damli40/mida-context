import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CONTENT_SECURITY_POLICY, indexUrlAllowed, securityHeaders } from "../src/headers.js"
import { assetPathFor } from "../src/worker.js"

describe("securityHeaders", () => {
  it("applies the full header set on HTML", () => {
    const headers = securityHeaders(true)
    expect(headers["Content-Security-Policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        "connect-src 'self' https://testnet-rpc.monad.xyz https://store.midacontext.xyz https://sponsor.midacontext.xyz https://indexer.dev.hyperindex.xyz; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000")
    expect(headers["Referrer-Policy"]).toBe("no-referrer")
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["Permissions-Policy"]).toBe("publickey-credentials-get=(self), publickey-credentials-create=(self)")
    expect(headers["Cache-Control"]).toBe("no-store")
  })

  it("lets non-HTML assets be cached — HSTS still rides every response", () => {
    const headers = securityHeaders(false)
    expect(headers["Cache-Control"]).toBeUndefined()
    expect(headers["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY)
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000")
  })
})

describe("indexUrlAllowed", () => {
  const SELF = "https://app.midacontext.xyz"

  it("accepts an https URL on the page's own origin — that is what connect-src 'self' means (in-26 Q-4)", () => {
    expect(indexUrlAllowed(`${SELF}/v1/graphql`, SELF)).toBe(true)
  })

  it("still refuses a foreign origin, an http URL, and a non-URL", () => {
    expect(indexUrlAllowed("https://index.example.org/v1/graphql", SELF)).toBe(false)
    expect(indexUrlAllowed(`http://app.midacontext.xyz/v1/graphql`, SELF)).toBe(false)
    expect(indexUrlAllowed("not a url", SELF)).toBe(false)
  })

  it("keeps accepting the explicitly listed connect-src origins", () => {
    expect(indexUrlAllowed("https://indexer.dev.hyperindex.xyz/abc/v1/graphql", SELF)).toBe(true)
  })
})

describe("the rp-id gate comment in owner/page.ts (in-26 Q-4)", () => {
  it("names the deployment's real rpId — no vault.mida.xyz left", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/owner/page.ts"),
      "utf8",
    )
    expect(source).not.toContain("vault.mida.xyz")
    expect(source).toContain("app.midacontext.xyz")
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
