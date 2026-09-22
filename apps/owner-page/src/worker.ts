import { securityHeaders } from "./headers.js"

/** The Workers static-assets binding declared in wrangler.toml. */
export interface OwnerPageEnv {
  ASSETS: { fetch(input: Request | string): Promise<Response> }
}

/** `/` and `/check` serve the device check; each owner flow gets its own page route. */
export function assetPathFor(pathname: string): string {
  if (pathname === "" || pathname === "/" || pathname === "/check" || pathname === "/check/") return "/check.html"
  if (pathname === "/signup" || pathname === "/signup/") return "/signup.html"
  if (pathname === "/approve" || pathname === "/approve/") return "/approve.html"
  if (pathname === "/revoke" || pathname === "/revoke/") return "/revoke.html"
  return pathname
}

export default {
  async fetch(request: Request, env: OwnerPageEnv): Promise<Response> {
    const url = new URL(request.url)
    const path = assetPathFor(url.pathname)
    const assetRequest = path === url.pathname ? request : new Request(new URL(path, url.origin).toString(), request)
    const response = await env.ASSETS.fetch(assetRequest)
    const headers = new Headers(response.headers)
    const isHtml = (headers.get("content-type") ?? "").includes("text/html") || path.endsWith(".html")
    for (const [name, value] of Object.entries(securityHeaders(isHtml))) headers.set(name, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
