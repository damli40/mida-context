import { MidaError, assertHex, cancelFastRevokeDigest } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { ReplayGuard, authenticateRequest } from "./auth.js"
import type { RegistryReader } from "./chain-views.js"
import { DenyOverlay } from "./deny-overlay.js"
import type { RevocationTarget } from "./deny-overlay.js"
import { toErrorBody } from "./errors.js"
import { verifyVaultAssertion } from "./verify-assertion.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"

export const CANCELLATION_MAX_LIFETIME_SECONDS = 300n

export interface ContextApiOptions {
  reader: RegistryReader
  deployment: Deployment
  dataDir: string
  /** Wall-clock seconds for request freshness. Chain time decides capability expiry. */
  clock?: () => bigint
}

type Env = { Variables: { signer: Address; body: Uint8Array } }

function bytes32(value: unknown, where: string): Hex {
  if (typeof value !== "string") throw new MidaError("INVALID_WIRE", `${where} must be a string`)
  try {
    return assertHex(value, 32)
  } catch {
    throw new MidaError("INVALID_WIRE", `${where} must be lowercase bytes32`)
  }
}

/** Task 23 stage: request authentication and the §12.5 revocation routes. Task 24 replaces this file with every §12 route. */
export function createContextApi(options: ContextApiOptions) {
  const { reader, deployment } = options
  const clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  const overlay = new DenyOverlay(`${options.dataDir}/revocations.json`)
  const replay = new ReplayGuard(`${options.dataDir}/replay-nonces.json`)
  const app = new Hono<Env>()

  app.onError((error, c) => {
    const { status, body } = toErrorBody(error)
    return c.json(body, status as 400)
  })

  const authenticated = createMiddleware<Env>(async (c, next) => {
    const body = new Uint8Array(await c.req.arrayBuffer())
    c.set(
      "signer",
      authenticateRequest({
        method: c.req.method,
        url: new URL(c.req.url),
        headers: c.req.raw.headers,
        body,
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        now: clock(),
        replay,
      }),
    )
    c.set("body", body)
    await next()
  })

  const json = <T>(body: Uint8Array): T => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T
    } catch {
      throw new MidaError("INVALID_WIRE", "request body must be UTF-8 JSON")
    }
  }

  /** §12.5: owner-authenticated. The target must exist and belong to the signer before the deny is recorded. */
  app.post("/revocations", authenticated, async (c) => {
    const owner = c.get("signer")
    const request = json<{ capabilityId?: unknown; agentId?: unknown }>(c.get("body"))
    let target: RevocationTarget
    let agentEpochAtIntent: bigint | null = null
    if (request.capabilityId !== undefined) {
      const capabilityId = bytes32(request.capabilityId, "capabilityId")
      const capability = await reader.getCapability(capabilityId)
      if (capability === null || capability.owner !== owner) throw new MidaError("CAPABILITY_DENIED", "capability is not the signer's")
      target = { kind: "capability", capabilityId }
    } else if (request.agentId !== undefined) {
      const agentId = bytes32(request.agentId, "agentId")
      if ((await reader.getAgent(agentId)) === null) throw new MidaError("NOT_FOUND", "agent not found")
      target = { kind: "agent", agentId }
      agentEpochAtIntent = await reader.agentEpoch(owner, agentId)
    } else {
      throw new MidaError("INVALID_WIRE", "revocation needs capabilityId or agentId")
    }
    const intent = overlay.create(owner, target, agentEpochAtIntent)
    return c.json({ intentId: intent.id, state: intent.state, cancellationNonce: intent.cancellationNonce })
  })

  /** §12.5 cancellation restores authority, so it needs a fresh P256 assertion with UV, not just a session signature. */
  app.post("/revocations/:id/cancel", authenticated, async (c) => {
    const owner = c.get("signer")
    const id = bytes32(c.req.param("id"), "id")
    const request = json<{ expiresAt?: string; assertion?: WebAuthnAssertionInput }>(c.get("body"))
    const intent = overlay.get(id)
    if (intent === undefined || intent.owner !== owner) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null) throw new MidaError("REPLAY", "revocation intent is not cancellable")
    if (request.assertion === undefined || typeof request.expiresAt !== "string" || !/^(0|[1-9][0-9]*)$/.test(request.expiresAt)) {
      throw new MidaError("AUTH_INVALID", "cancellation requires a fresh passkey assertion and expiresAt")
    }
    const expiresAt = BigInt(request.expiresAt)
    const now = clock()
    if (now >= expiresAt || expiresAt - now > CANCELLATION_MAX_LIFETIME_SECONDS) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is expired or valid for more than five minutes")
    }
    const key = await reader.ownerP256Key(owner)
    const nonce = BigInt(intent.cancellationNonce)
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner,
      revocationIntentId: intent.id,
      apiCancellationNonce: nonce,
      expiresAt,
    })
    if (key === null || !verifyVaultAssertion({ challenge, assertion: request.assertion, qx: key.qx, qy: key.qy, rpIdHash: deployment.vaultRpIdHash })) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is not a valid owner passkey assertion")
    }
    const cancelled = overlay.cancel(intent.id, owner, nonce)
    return c.json({ intentId: cancelled.id, state: cancelled.state })
  })

  return { app, overlay }
}
