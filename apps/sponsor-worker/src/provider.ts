/**
 * The provider seam. The Worker never builds provider URLs or contexts in the request path — a
 * `SponsorProvider` hides where the key lives and how this provider wants the sponsorship policy
 * identified, so the same policy code runs against Pimlico today and Alchemy when Monad 7702 is
 * allowlisted there.
 */

/** The provider answered with a JSON-RPC error — code/message pass to the client after secret scrubbing. */
export class ProviderError extends Error {
  readonly code: number
  /** The provider error's own `data`, when it sent one — logged for diagnosis, never echoed raw to a client. */
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "ProviderError"
    this.code = code
    this.data = data
  }
}

export interface SponsorProvider {
  readonly name: string
  /** POST one JSON-RPC call; resolves with `result` or throws ProviderError on a JSON-RPC/HTTP error. */
  forward(method: string, params: unknown): Promise<unknown>
  /**
   * The object the Worker substitutes for the client's `paymasterContext`/context argument on
   * `pm_getPaymasterStubData`/`pm_getPaymasterData`. Whatever the client sent is dropped here —
   * this is where the server-held `POLICY_ID` becomes a provider-shaped context.
   */
  policyContext(policyId: string): unknown
}

export interface ProviderOptions {
  name?: string
  /** How this provider wants the policy id expressed; defaults to Pimlico's sponsorshipPolicyId. */
  policyContext?: (policyId: string) => unknown
}

/** A raw JSON-RPC endpoint behind the SponsorProvider interface — for tests and custom deployments. */
export function httpJsonRpcProvider(url: string, options?: ProviderOptions): SponsorProvider {
  let nextId = 1
  return {
    name: options?.name ?? "custom",
    policyContext: options?.policyContext ?? ((policyId) => ({ sponsorshipPolicyId: policyId })),
    async forward(method, params) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      })
      if (!response.ok) {
        throw new ProviderError(-32603, `sponsor provider answered HTTP ${response.status}`)
      }
      let body: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }
      try {
        body = (await response.json()) as typeof body
      } catch {
        throw new ProviderError(-32603, "sponsor provider returned a non-JSON body")
      }
      if (body.error) {
        const code = typeof body.error.code === "number" ? body.error.code : -32603
        const message = typeof body.error.message === "string" ? body.error.message : "sponsor provider error"
        throw new ProviderError(code, message, body.error.data)
      }
      return body.result
    },
  }
}

/**
 * Pimlico — bundler and paymaster on Monad testnet (slug `monad-testnet`), EntryPoint v0.8.
 * The API key rides in the URL query, which is exactly why no committed file may name it.
 * Sponsorship policy: `paymasterContext: { sponsorshipPolicyId }`.
 */
export function pimlicoProvider(input: { apiKey: string; chainSlug?: string }): SponsorProvider {
  const slug = input.chainSlug ?? "monad-testnet"
  return httpJsonRpcProvider(`https://api.pimlico.io/v2/${slug}/rpc?apikey=${input.apiKey}`, { name: "pimlico" })
}

/**
 * Alchemy — same standard paymaster methods (`pm_getPaymasterStubData`/`pm_getPaymasterData`) over
 * its account-abstraction RPC. Monad 7702 is allowlist-only there today; this adapter is written
 * and tested against the interface, not the live service. The key rides in the URL path.
 */
export function alchemyProvider(input: { apiKey: string; baseUrl: string }): SponsorProvider {
  const base = input.baseUrl.replace(/\/+$/, "")
  return httpJsonRpcProvider(`${base}/${input.apiKey}`, {
    name: "alchemy",
    policyContext: (policyId) => ({ policyId }),
  })
}
