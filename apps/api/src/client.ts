import { httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { LocalAccount } from "viem"
import { AUTH_HEADERS, targetOf } from "./auth.js"
import { errorFromBody } from "./errors.js"

export interface ContextApiClientOptions {
  baseUrl: string
  account: LocalAccount
  chainId: bigint
  capabilityRegistry: Address
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  clock?: () => bigint
}

/** Signs every request with MidaHttpRequestV1 (§12.1). The signature covers the exact body bytes sent. */
export class ContextApiClient {
  readonly account: LocalAccount
  readonly #options: ContextApiClientOptions

  constructor(options: ContextApiClientOptions) {
    this.account = options.account
    this.#options = options
  }

  async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown; signed?: boolean } = {}): Promise<T> {
    const url = new URL(path, this.#options.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    const body = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body))
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (options.signed !== false) {
      const timestamp = (this.#options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000))))()
      const nonce = hexOf(randomBytes(32))
      const signature = await this.account.signTypedData(
        httpRequestTypedData({
          chainId: this.#options.chainId,
          capabilityRegistry: this.#options.capabilityRegistry,
          signer: this.account.address,
          method,
          target: targetOf(url),
          body,
          timestamp,
          nonce,
        }) as never,
      )
      headers[AUTH_HEADERS.signer] = this.account.address
      headers[AUTH_HEADERS.timestamp] = timestamp.toString(10)
      headers[AUTH_HEADERS.nonce] = nonce
      headers[AUTH_HEADERS.signature] = signature
    }
    const doFetch = this.#options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
    const response = await doFetch(url.toString(), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    })
    const text = await response.text()
    const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
    if (!response.ok) throw errorFromBody(response.status, parsed)
    return parsed as T
  }
}
