import { describe, expect, it } from "vitest"
import worker, { assetPathFor, type OwnerPageEnv } from "../src/worker.js"
import { CONTENT_SECURITY_POLICY, securityHeaders } from "../src/headers.js"

describe("assetPathFor", () => {
  it("routes each flow name to its page and leaves assets alone", () => {
    expect(assetPathFor("/")).toBe("/index.html")
    expect(assetPathFor("")).toBe("/index.html")
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

describe("the home page at /", () => {
  // A stand-in for the static-assets binding: it records which path the Worker asked for and
  // answers the way Cloudflare does, with no security headers of its own.
  function fakeAssets(): { env: OwnerPageEnv; asked: string[] } {
    const asked: string[] = []
    const env: OwnerPageEnv = {
      ASSETS: {
        async fetch(input: Request | string) {
          const path = new URL(typeof input === "string" ? input : input.url).pathname
          asked.push(path)
          const type = path.endsWith(".html") ? "text/html; charset=utf-8" : "text/css"
          return new Response(`body of ${path}`, { status: 200, headers: { "content-type": type } })
        },
      },
    }
    return { env, asked }
  }

  it("serves index.html with the same security headers as the owner pages", async () => {
    const { env, asked } = fakeAssets()
    const home = await worker.fetch(new Request("https://app.midacontext.xyz/"), env)
    const signup = await worker.fetch(new Request("https://app.midacontext.xyz/signup"), env)

    expect(asked).toEqual(["/index.html", "/signup.html"])
    expect(home.status).toBe(200)
    expect(await home.text()).toBe("body of /index.html")
    for (const [name, value] of Object.entries(securityHeaders(true))) {
      expect(home.headers.get(name)).toBe(value)
      expect(home.headers.get(name)).toBe(signup.headers.get(name))
    }
  })

  it("serves its stylesheet as a cacheable asset under the same CSP", async () => {
    const { env } = fakeAssets()
    const css = await worker.fetch(new Request("https://app.midacontext.xyz/home.css"), env)
    expect(css.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY)
    expect(css.headers.get("Cache-Control")).toBeNull()
  })

  it("keeps the device check reachable at /check", async () => {
    const { env, asked } = fakeAssets()
    await worker.fetch(new Request("https://app.midacontext.xyz/check"), env)
    expect(asked).toEqual(["/check.html"])
  })
})
