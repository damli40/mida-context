// The hosted Mida context store: the same createContextApi that runs on a laptop, served as a Cloudflare Worker.
// It holds ciphertext only — the keys never reach it — and anyone can run the identical server themselves.

import { createPublicClient, http } from "viem"
import { assertHex } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { AUTH_HEADERS, MANIFEST_VERIFY_CACHE_SECONDS, RegistryReader, createContextApi } from "@mida/api"
import type { StoreLimits } from "@mida/api"
import { d1Stores, runSweep } from "./index.js"
import type { D1Like } from "./d1.js"

/** The slice of Cloudflare's rate-limit binding this worker calls: one `limit` per request. */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

/** Environment bindings. No file paths, no secrets in wrangler.toml — RPC_URL goes in as a secret. */
export interface WorkerEnv {
  DB: D1Like
  /** [[ratelimits]] bindings: 120/min for signed requests, 20/min for unsigned ones — absent in local dev. */
  LIMITER_SIGNED?: RateLimitBinding
  LIMITER_UNSIGNED?: RateLimitBinding
  RPC_URL: string
  CHAIN_ID: string
  CAPABILITY_REGISTRY: string
  CONTEXT_REGISTRY: string
  DEPLOYMENT_BLOCK: string
  POLICY_HASH_V1: string
  VAULT_RP_ID: string
  VAULT_RP_ID_HASH: string
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

function required(env: WorkerEnv, key: keyof WorkerEnv): string {
  const value = env[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing or empty environment variable ${key}`)
  return value
}

function addressEnv(env: WorkerEnv, key: keyof WorkerEnv): Address {
  const value = required(env, key)
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`environment variable ${key} must be a 0x-prefixed 20-byte address`)
  return value.toLowerCase() as Address
}

function integerEnv(env: WorkerEnv, key: keyof WorkerEnv): bigint {
  const value = required(env, key)
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`environment variable ${key} must be a non-negative integer`)
  return BigInt(value)
}

function hashEnv(env: WorkerEnv, key: keyof WorkerEnv): Hex {
  const value = required(env, key)
  try {
    return assertHex(value.toLowerCase(), 32)
  } catch {
    throw new Error(`environment variable ${key} must be a 0x-prefixed 32-byte hex`)
  }
}

/**
 * The Deployment assembled from environment variables — never from a deployment file (there is no file system
 * here and `loadDeployment` would try to read one). Every missing or malformed variable fails closed by name.
 */
export function deploymentFromEnv(env: WorkerEnv): Deployment {
  return {
    chainId: integerEnv(env, "CHAIN_ID"),
    capabilityRegistry: addressEnv(env, "CAPABILITY_REGISTRY"),
    contextRegistry: addressEnv(env, "CONTEXT_REGISTRY"),
    deploymentBlock: integerEnv(env, "DEPLOYMENT_BLOCK"),
    policyHashV1: hashEnv(env, "POLICY_HASH_V1"),
    vaultRpId: required(env, "VAULT_RP_ID"),
    vaultRpIdHash: hashEnv(env, "VAULT_RP_ID_HASH"),
  }
}

interface Built {
  app: ReturnType<typeof createContextApi>["app"]
  reader: RegistryReader
  stores: ReturnType<typeof d1Stores>
  deployment: Deployment
  limits: StoreLimits
}

let built: { env: WorkerEnv; value: Built } | undefined

/** Built once per isolate: the D1 stores, the Monad reader and the shared app. A bad env fails the whole worker. */
function buildWorker(env: WorkerEnv): Built {
  if (built !== undefined && built.env === env) return built.value
  const deployment = deploymentFromEnv(env)
  const rpcUrl = required(env, "RPC_URL")
  try {
    new URL(rpcUrl)
  } catch {
    throw new Error(`environment variable RPC_URL must be an absolute URL`)
  }
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment })
  const stores = d1Stores(env.DB)
  const { app, limits } = createContextApi({ reader, deployment, stores })
  built = { env, value: { app, reader, stores, deployment, limits } }
  return built.value
}

/** Any browser may read or write ciphertext with a valid signature — but never with ambient credentials. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-mida-signer, x-mida-timestamp, x-mida-nonce, x-mida-signature",
  "access-control-max-age": "86400",
}

/** The route shape for logs: concrete context ids and body hashes collapse to their parameter names. */
function pathTemplate(pathname: string): string {
  if (/^\/manifests\/0x[0-9a-fA-F]{64}$/.test(pathname)) return "/manifests/:contextId"
  if (/^\/agent-manifests\/0x[0-9a-fA-F]{64}$/.test(pathname)) return "/agent-manifests/:bodyHash"
  if (/^\/revocations\/0x[0-9a-fA-F]{64}\/cancel$/.test(pathname)) return "/revocations/:id/cancel"
  return pathname
}

/** One structured log line per request: method, path template, status, response bytes, milliseconds — never a
 * body, a signature, a full address or a full hash. */
function logRequest(input: { method: string; path: string; status: number; bytes: number; ms: number }): void {
  console.log(
    JSON.stringify({ method: input.method, path: input.path, status: input.status, bytes: input.bytes, ms: input.ms }),
  )
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)
  return new Response(response.body, { status: response.status, headers })
}

const ROOT_NOTICE =
  "This server stores ciphertext only. It holds no keys and cannot read what it stores. Source: <repo url placeholder>"

/**
 * The per-IP request budgets the [[ratelimits]] bindings in wrangler.toml enforce — kept here for GET / to
 * report. A binding that is absent reports null: nothing on the worker limits that bucket then, which is
 * what a binding-less dev deployment should say about itself.
 */
const RATE_LIMIT_SIGNED_PER_MINUTE = 120
const RATE_LIMIT_UNSIGNED_PER_MINUTE = 20

/** Exported for tests: the same request path `fetch` runs, with logging and CORS wrapped around the app. */
export async function handleRequest(env: WorkerEnv, request: Request): Promise<Response> {
  const started = Date.now()
  const url = new URL(request.url)
  const path = pathTemplate(url.pathname)
  let status = 500
  let bytes = 0
  try {
    const { app, deployment, limits } = buildWorker(env)
    // The per-IP budget is checked here, at the edge of every route — including OPTIONS and GET /, which
    // never reach the app's own middleware. Each request consumes exactly one token: signed traffic
    // (a signature header is present) against the 120/min binding, anonymous traffic against the 20/min
    // one. A binding that is absent limits nothing — a self-hosted deployment limits at its proxy.
    const signed = request.headers.get(AUTH_HEADERS.signature) !== null
    const binding = signed ? env.LIMITER_SIGNED : env.LIMITER_UNSIGNED
    if (binding !== undefined) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
      if (!(await binding.limit({ key: ip })).success) {
        status = 429
        const payload = JSON.stringify({ error: { code: "RATE_LIMITED", message: "too many requests from this address — try again in a minute" } })
        bytes = payload.length
        return withCors(new Response(payload, { status, headers: { "content-type": "application/json", "retry-after": "60" } }))
      }
    }
    if (request.method === "OPTIONS") {
      status = 204
      return new Response(null, { status, headers: CORS_HEADERS })
    }
    if (url.pathname === "/" && request.method === "GET") {
      const payload = JSON.stringify({
        name: "mida-context-store",
        version: "0.0.0",
        chainId: deployment.chainId.toString(10),
        capabilityRegistry: deployment.capabilityRegistry,
        contextRegistry: deployment.contextRegistry,
        limits,
        manifestVerifyCacheSeconds: Number(MANIFEST_VERIFY_CACHE_SECONDS),
        rateLimitsPerMinute: {
          signed: env.LIMITER_SIGNED === undefined ? null : RATE_LIMIT_SIGNED_PER_MINUTE,
          unsigned: env.LIMITER_UNSIGNED === undefined ? null : RATE_LIMIT_UNSIGNED_PER_MINUTE,
        },
        notice: ROOT_NOTICE,
      })
      status = 200
      bytes = payload.length
      return withCors(new Response(payload, { status, headers: { "content-type": "application/json" } }))
    }
    const response = await app.fetch(request)
    const body = await response.arrayBuffer()
    status = response.status
    bytes = body.byteLength
    return withCors(new Response(body, { status, headers: response.headers }))
  } catch (error) {
    // Configuration failures name the variable in plain text; request failures keep the app's own error shape.
    const message = error instanceof Error ? error.message : String(error)
    return withCors(new Response(JSON.stringify({ error: { code: "CONFIG_INVALID", message } }), { status, headers: { "content-type": "application/json" } }))
  } finally {
    logRequest({ method: request.method, path, status, bytes, ms: Date.now() - started })
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(env, request)
  },

  /** Daily cron: sweep pending uploads past 24 h and expired nonces (item 5). */
  async scheduled(_event: { cron: string }, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const { stores, reader } = buildWorker(env)
        const result = await runSweep({ stores, reader })
        console.log(JSON.stringify({ event: "sweep", objectsRemoved: result.objectsRemoved, manifestsRemoved: result.manifestsRemoved, noncesRemoved: result.noncesRemoved }))
      })(),
    )
  },
}
