import { indexUrlAllowed, securityHeaders } from "./headers.js"

/** The Workers static-assets binding declared in wrangler.toml. */
export interface OwnerPageEnv {
  ASSETS: { fetch(input: Request | string): Promise<Response> }
  /** The deployed index's GraphQL URL — served to /me at runtime, never baked into the bundle. */
  INDEX_GRAPHQL_URL?: string
}

/** The one slice of a scheduled event's execution context this Worker uses. */
interface ScheduledContextLike {
  waitUntil(promise: Promise<unknown>): void
}

/** `/` serves the public home page, `/check` the device check; each owner flow gets its own page route. */
export function assetPathFor(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/index.html"
  if (pathname === "/check" || pathname === "/check/") return "/check.html"
  if (pathname === "/signup" || pathname === "/signup/") return "/signup.html"
  if (pathname === "/approve" || pathname === "/approve/") return "/approve.html"
  if (pathname === "/revoke" || pathname === "/revoke/") return "/revoke.html"
  if (pathname === "/me" || pathname === "/me/") return "/me.html"
  return pathname
}

export default {
  async fetch(request: Request, env: OwnerPageEnv): Promise<Response> {
    const url = new URL(request.url)
    // The one dynamic answer: /me reads the index URL from Worker config so a re-deployed index
    // changes the path without a rebuild. no-store — a stale answer would point the page at a
    // dead deployment. A configured URL the page's own CSP refuses is never served as usable —
    // the reason field lets /me say "not allowed" instead of reporting a dead index.
    if (url.pathname === "/me/config.json") {
      const configured = env.INDEX_GRAPHQL_URL
      const body =
        configured === undefined || configured === ""
          ? { indexUrl: null }
          : indexUrlAllowed(configured, url.origin)
            ? { indexUrl: configured }
            : { indexUrl: null, reason: "index-url-not-allowed" }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...securityHeaders(false),
        },
      })
    }
    const path = assetPathFor(url.pathname)
    const assetRequest = path === url.pathname ? request : new Request(new URL(path, url.origin).toString(), request)
    const response = await env.ASSETS.fetch(assetRequest)
    const headers = new Headers(response.headers)
    const isHtml = (headers.get("content-type") ?? "").includes("text/html") || path.endsWith(".html")
    for (const [name, value] of Object.entries(securityHeaders(isHtml))) headers.set(name, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },

  /**
   * The daily cron (`[triggers]` in wrangler.toml). Envio Cloud's free plan deletes a dev
   * deployment after 7 days with no queries, so this POSTs the smallest useful one to keep the
   * /me index alive. The promise rides waitUntil — a floating fetch can be cancelled when the
   * handler returns — and it can never reject: a failed keep-alive is not worth a retry, and a
   * rejected waitUntil would mark the whole invocation failed.
   */
  async scheduled(_event: { cron: string }, env: OwnerPageEnv, ctx: ScheduledContextLike): Promise<void> {
    const indexUrl = env.INDEX_GRAPHQL_URL
    if (!indexUrl) return
    ctx.waitUntil(
      fetch(indexUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ GlobalStats(limit: 1) { lastBlock } }" }),
      }).then(
        () => undefined,
        () => undefined,
      ),
    )
  },
}
