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
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    ...(isHtml ? { "Cache-Control": "no-store" } : {}),
  }
}
