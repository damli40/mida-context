import { describe, expect, it } from "vitest"
import { assetPathFor } from "../src/worker.js"
import { CONTENT_SECURITY_POLICY } from "../src/headers.js"

describe("assetPathFor", () => {
  it("routes each flow name to its page and leaves assets alone", () => {
    expect(assetPathFor("/")).toBe("/check.html")
    expect(assetPathFor("/check")).toBe("/check.html")
    expect(assetPathFor("/signup")).toBe("/signup.html")
    expect(assetPathFor("/approve")).toBe("/approve.html")
    expect(assetPathFor("/revoke")).toBe("/revoke.html")
    expect(assetPathFor("/approve/")).toBe("/approve.html")
    expect(assetPathFor("/owner.css")).toBe("/owner.css")
    expect(assetPathFor("/approve.js")).toBe("/approve.js")
    // an unknown route is passed through — the assets layer 404s it, the page never guesses
    expect(assetPathFor("/admin")).toBe("/admin")
  })
})

describe("Content-Security-Policy", () => {
  it("connect-src is exactly the four allowed origins; no forms, no frames, no inline script", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split(";").map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/)
        return [name!, rest.join(" ")]
      }),
    )
    expect(directives["connect-src"]).toBe(
      "'self' https://testnet-rpc.monad.xyz https://store.midacontext.xyz https://sponsor.midacontext.xyz",
    )
    expect(directives["form-action"]).toBe("'none'")
    expect(directives["frame-ancestors"]).toBe("'none'")
    expect(directives["script-src"]).toBe("'self'")
    expect(directives["default-src"]).toBe("'none'")
  })
})
