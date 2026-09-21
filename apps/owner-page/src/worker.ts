import { securityHeaders } from "./headers.js"

/** The Workers static-assets binding declared in wrangler.toml. */
export interface OwnerPageEnv {
  ASSETS: { fetch(input: Request | string): Promise<Response> }
}

/** Both `/` and `/check` serve the one page — the reviewer may point the route at either. */
export function assetPathFor(pathname: string): string {
  if (pathname === "" || pathname === "/" || pathname === "/check" || pathname === "/check/") return "/check.html"
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
