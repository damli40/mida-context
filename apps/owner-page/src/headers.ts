/**
 * The response headers every answer from this Worker carries. The page must call WebAuthn on 'self'
 * and may reach only the Monad testnet RPC, the two Mida endpoints and the Envio index —
 * everything else is refused.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self' https://testnet-rpc.monad.xyz https://store.midacontext.xyz https://sponsor.midacontext.xyz https://indexer.dev.hyperindex.xyz; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export function securityHeaders(isHtml: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Strict-Transport-Security": "max-age=31536000",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    ...(isHtml ? { "Cache-Control": "no-store" } : {}),
  }
}

// The origin list inside connect-src, parsed from the CSP itself so the Worker cannot drift from
// what the page is actually allowed to call.
const CONNECT_SRC = CONTENT_SECURITY_POLICY.split(";")
  .map((directive) => directive.trim())
  .find((directive) => directive.startsWith("connect-src"))!
  .split(/\s+/)
  .slice(1)

/**
 * Whether the page's own CSP would let /me call this index URL — https and an origin named in
 * connect-src. Serving a URL the CSP refuses reads as a dead index, never as the misconfiguration
 * it is, so the Worker answers "not allowed" instead of handing the page a URL it cannot use.
 */
export function indexUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && CONNECT_SRC.includes(url.origin)
  } catch {
    return false
  }
}
