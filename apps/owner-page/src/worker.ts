import { securityHeaders } from "./headers.js"

/** The Workers static-assets binding declared in wrangler.toml. */
export interface OwnerPageEnv {
  ASSETS: { fetch(input: Request | string): Promise<Response> }
  /** The deployed index's GraphQL URL — served to /me at runtime, never baked into the bundle. */
  INDEX_GRAPHQL_URL?: string
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
    // dead deployment.
    if (url.pathname === "/me/config.json") {
      return new Response(JSON.stringify({ indexUrl: env.INDEX_GRAPHQL_URL ?? null }), {
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
}
