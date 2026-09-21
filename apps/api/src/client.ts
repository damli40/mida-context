import { httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap, SignedAgentCapabilityManifest } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { LocalAccount } from "viem"
import { AUTH_HEADERS, targetOf } from "./auth.js"
import { errorFromBody } from "./errors.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"
import type { AnchoredObject, ObjectUploadBody } from "./wire.js"

export interface ContextApiClientOptions {
  baseUrl: string
  account: LocalAccount
  chainId: bigint
  capabilityRegistry: Address
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  clock?: () => bigint
}

/**
 * Signs every request with MidaHttpRequestV1 (§12.1); the signature covers the exact body bytes sent. The typed route
 * methods implement the FakeVault's VaultContextApi port structurally, so the same client serves owners and agents.
 */
export class ContextApiClient implements ContextApiRoutes {
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

  putObject(upload: ObjectUploadBody) {
    return this.request<{ contextId: Hex; manifestHash: Hex; state: "pending" }>("PUT", "/objects", { body: upload })
  }

  async listObjects(input: { owner: Address; namespaceId: Hex; capabilityId?: Hex }) {
    const query = { owner: input.owner.toLowerCase(), namespaceId: input.namespaceId, ...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }) }
    return (await this.request<{ objects: AnchoredObject[] }>("GET", "/objects", { query })).objects
  }

  getManifest(contextId: Hex, capabilityId?: Hex) {
    return this.request<{ manifest: ObjectManifest; manifestHash: Hex }>("GET", `/manifests/${contextId}`, capabilityId === undefined ? {} : { query: { capabilityId } })
  }

  putAgentManifest(envelope: SignedAgentCapabilityManifest) {
    // Signed like every other write: the signature buys the per-signer manifest quota and replay
    // protection — and for an agent not yet on Monad it must be the operator that signed the manifest.
    return this.request<{ bodyHash: Hex; envelopeHash: Hex }>("PUT", "/agent-manifests", { body: envelope })
  }

  getAgentManifest(bodyHash: Hex) {
    return this.request<SignedAgentCapabilityManifest>("GET", `/agent-manifests/${bodyHash}`, { signed: false })
  }

  publishEpochWrap(wrap: ReaderEpochWrap) {
    return this.request<{ stored: true }>("POST", "/epoch-wraps", { body: wrap })
  }

  getEpochWrap(input: { owner: Address; namespaceId: Hex; readEpoch: bigint; agentId: Hex; agentKeyVersion: number; capabilityId: Hex }) {
    return this.request<ReaderEpochWrap>("GET", "/epoch-wraps", {
      query: {
        owner: input.owner.toLowerCase(),
        namespaceId: input.namespaceId,
        readEpoch: input.readEpoch.toString(10),
        agentId: input.agentId,
        agentKeyVersion: String(input.agentKeyVersion),
        capabilityId: input.capabilityId,
      },
    })
  }

  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }) {
    const body = "capabilityId" in target ? { capabilityId: target.capabilityId } : { agentId: target.agentId }
    return this.request<{ intentId: Hex; state: string; cancellationNonce: string }>("POST", "/revocations", { body })
  }

  cancelRevocation(intentId: Hex, input: { expiresAt: bigint; assertion: WebAuthnAssertionInput }) {
    return this.request<{ intentId: Hex; state: string }>("POST", `/revocations/${intentId}/cancel`, {
      body: { expiresAt: input.expiresAt.toString(10), assertion: input.assertion },
    })
  }
}

export interface ContextApiRoutes {
  putObject(upload: ObjectUploadBody): Promise<{ contextId: Hex; manifestHash: Hex; state: "pending" }>
  listObjects(input: { owner: Address; namespaceId: Hex; capabilityId?: Hex }): Promise<AnchoredObject[]>
  getManifest(contextId: Hex, capabilityId?: Hex): Promise<{ manifest: ObjectManifest; manifestHash: Hex }>
  putAgentManifest(envelope: SignedAgentCapabilityManifest): Promise<{ bodyHash: Hex; envelopeHash: Hex }>
  getAgentManifest(bodyHash: Hex): Promise<SignedAgentCapabilityManifest>
  publishEpochWrap(wrap: ReaderEpochWrap): Promise<{ stored: true }>
  getEpochWrap(input: { owner: Address; namespaceId: Hex; readEpoch: bigint; agentId: Hex; agentKeyVersion: number; capabilityId: Hex }): Promise<ReaderEpochWrap>
  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }): Promise<{ intentId: Hex; state: string; cancellationNonce: string }>
  cancelRevocation(intentId: Hex, input: { expiresAt: bigint; assertion: WebAuthnAssertionInput }): Promise<{ intentId: Hex; state: string }>
}
