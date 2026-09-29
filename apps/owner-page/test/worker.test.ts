import { afterEach, describe, expect, it, vi } from "vitest"
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
    expect(assetPathFor("/me")).toBe("/me.html")
    expect(assetPathFor("/me/")).toBe("/me.html")
    expect(assetPathFor("/owner.css")).toBe("/owner.css")
    expect(assetPathFor("/approve.js")).toBe("/approve.js")
    // an unknown route is passed through — the assets layer 404s it, the page never guesses
    expect(assetPathFor("/admin")).toBe("/admin")
    // /me/config.json is answered by the Worker itself, never an asset lookup
    expect(assetPathFor("/me/config.json")).toBe("/me/config.json")
  })
})

describe("Content-Security-Policy", () => {
  it("connect-src is exactly the five allowed origins; no forms, no frames, no inline script", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split(";").map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/)
        return [name!, rest.join(" ")]
      }),
    )
    expect(directives["connect-src"]).toBe(
      "'self' https://testnet-rpc.monad.xyz https://store.midacontext.xyz https://sponsor.midacontext.xyz https://indexer.dev.hyperindex.xyz",
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

describe("/me", () => {
  function fakeAssets(indexUrl?: string): { env: OwnerPageEnv; asked: string[] } {
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
      ...(indexUrl === undefined ? {} : { INDEX_GRAPHQL_URL: indexUrl }),
    }
    return { env, asked }
  }

  it("routes /me and /me/ to me.html under the same security headers", async () => {
    const { env, asked } = fakeAssets()
    const me = await worker.fetch(new Request("https://app.midacontext.xyz/me"), env)
    const meSlash = await worker.fetch(new Request("https://app.midacontext.xyz/me/"), env)
    expect(asked).toEqual(["/me.html", "/me.html"])
    expect(me.status).toBe(200)
    expect(await me.text()).toBe("body of /me.html")
    expect(me.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY)
    expect(meSlash.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY)
  })

  it("serves the index URL from INDEX_GRAPHQL_URL at /me/config.json", async () => {
    const indexUrl = "https://indexer.dev.hyperindex.xyz/abc123/v1/graphql"
    const { env, asked } = fakeAssets(indexUrl)
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ indexUrl })
    // the config answer is the Worker's own — it never reaches the assets binding
    expect(asked).toEqual([])
    expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY)
  })

  it("answers indexUrl: null when the env var is unset — the page reports the index missing", async () => {
    const { env } = fakeAssets()
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null })
  })

  it("an empty INDEX_GRAPHQL_URL means not configured — indexUrl: null with no reason (in-26 Q-4)", async () => {
    // A cleared dashboard field or `[vars] INDEX_GRAPHQL_URL = ""` must read as "no index",
    // not as a URL the CSP refused — and the cron already treats "" as unset, so the halves
    // agree.
    const { env } = fakeAssets("")
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null })
  })

  it("a whitespace-only INDEX_GRAPHQL_URL means not configured too — the value is trimmed first (in-27 R-4)", async () => {
    // A dashboard paste that left a stray space or newline must read as "no index" — today it
    // reaches the CSP gate and answers "not allowed", blaming the index instead of the config.
    const { env } = fakeAssets("  \n  ")
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null })
  })

  it("a padded INDEX_GRAPHQL_URL serves the trimmed URL (in-27 R-4)", async () => {
    const indexUrl = "https://indexer.dev.hyperindex.xyz/abc123/v1/graphql"
    const { env } = fakeAssets(`  ${indexUrl}\n`)
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl })
  })

  it("serves an index on the page's own origin — the CSP's 'self' already allows it (in-26 Q-4)", async () => {
    const indexUrl = "https://app.midacontext.xyz/v1/graphql"
    const { env } = fakeAssets(indexUrl)
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl })
  })

  it("but 'self' means THIS page's origin — the same URL on a foreign origin stays refused", async () => {
    const indexUrl = "https://app.midacontext.xyz/v1/graphql"
    const { env } = fakeAssets(indexUrl)
    const res = await worker.fetch(new Request("https://other-host.example.org/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null, reason: "index-url-not-allowed" })
  })

  it("never serves an index URL the page's own CSP refuses — a foreign origin answers not-allowed", async () => {
    // A self-hosted index origin is a valid deployment, but connect-src is a fixed five-entry
    // list — serving the URL anyway would read as a dead index, not a blocked one.
    const indexUrl = "https://mida-index.example.org/v1/graphql"
    const { env } = fakeAssets(indexUrl)
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null, reason: "index-url-not-allowed" })
    // and the CSP does in fact refuse that origin — the gate and the page agree
    const connectSrc = CONTENT_SECURITY_POLICY.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"))!
      .split(/\s+/)
      .slice(1)
    expect(connectSrc).not.toContain(new URL(indexUrl).origin)
  })

  it("an http:// index URL is not-allowed too — mixed content on an https page", async () => {
    const { env } = fakeAssets("http://localhost:8080/v1/graphql")
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null, reason: "index-url-not-allowed" })
  })

  it("a URL that is not a URL at all answers not-allowed rather than throwing", async () => {
    const { env } = fakeAssets("not a url")
    const res = await worker.fetch(new Request("https://app.midacontext.xyz/me/config.json"), env)
    expect(await res.json()).toEqual({ indexUrl: null, reason: "index-url-not-allowed" })
  })
})

describe("the daily index keep-alive", () => {
  // Envio Cloud's free plan deletes a dev deployment after 7 days with no queries, so the Worker
  // pings the index once a day (the cron itself is [triggers] in wrangler.toml; this tests what
  // the ping does). It must never throw — a missed day is harmless, a retry storm is not — and it
  // must do nothing at all when no index is configured.
  const cron = { cron: "17 6 * * *" }
  const indexUrl = "https://indexer.dev.hyperindex.xyz/abc123/v1/graphql"

  function keepAliveEnv(index?: string): OwnerPageEnv {
    return {
      ASSETS: { async fetch() { return new Response("unused — scheduled never touches assets") } },
      ...(index === undefined ? {} : { INDEX_GRAPHQL_URL: index }),
    }
  }

  // The ctx Cloudflare hands a scheduled event: work the handler wants to outlive its return rides
  // waitUntil. Capturing those promises is also how the test proves the ping is not left floating —
  // an un-awaited subrequest can be cancelled the moment the handler returns.
  function ctxCapture(): { ctx: { waitUntil(p: Promise<unknown>): void }; pings: Promise<unknown>[] } {
    const pings: Promise<unknown>[] = []
    return { ctx: { waitUntil: (p) => void pings.push(p) }, pings }
  }

  afterEach(() => vi.unstubAllGlobals())

  it("POSTs one tiny GlobalStats query to the configured index URL, held open by waitUntil", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body })
      return new Response("{}")
    })
    const { ctx, pings } = ctxCapture()

    await worker.scheduled(cron, keepAliveEnv(indexUrl), ctx)
    expect(pings).toHaveLength(1)
    await Promise.all(pings)

    expect(calls).toEqual([
      { url: indexUrl, method: "POST", body: JSON.stringify({ query: "{ GlobalStats(limit: 1) { lastBlock } }" }) },
    ])
  })

  it("swallows a failed ping — a keep-alive is never worth a retry", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    const { ctx, pings } = ctxCapture()

    await expect(worker.scheduled(cron, keepAliveEnv(indexUrl), ctx)).resolves.toBeUndefined()
    expect(pings).toHaveLength(1)
    // a rejected waitUntil promise would mark the whole scheduled invocation failed
    await expect(Promise.all(pings)).resolves.toBeDefined()
  })

  it("does nothing when INDEX_GRAPHQL_URL is unset", async () => {
    const calls: unknown[] = []
    vi.stubGlobal("fetch", async () => {
      calls.push(1)
      return new Response("{}")
    })
    const { ctx, pings } = ctxCapture()

    await worker.scheduled(cron, keepAliveEnv(), ctx)
    expect(pings).toEqual([])
    expect(calls).toEqual([])
  })

  it("does nothing when INDEX_GRAPHQL_URL is only whitespace (in-27 R-4)", async () => {
    const calls: unknown[] = []
    vi.stubGlobal("fetch", async () => {
      calls.push(1)
      return new Response("{}")
    })
    const { ctx, pings } = ctxCapture()

    await worker.scheduled(cron, keepAliveEnv("   \n"), ctx)
    expect(pings).toEqual([])
    expect(calls).toEqual([])
  })
})
