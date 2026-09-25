// The hosted Mida context store: the same createContextApi that runs on a laptop, served as a Cloudflare Worker.
// It holds ciphertext only — the keys never reach it — and anyone can run the identical server themselves.

import { AsyncLocalStorage } from "node:async_hooks"
import { createPublicClient } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { assertHex } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { batchAnchorAbi, rpcTransport } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { AUTH_HEADERS, MANIFEST_VERIFY_CACHE_SECONDS, MAX_CHAIN_READS_PER_REQUEST, RegistryReader, SWEEP_MAX_OBJECTS_PER_RUN, createContextApi } from "@mida/api"
import type { BatchingOptions, StoreLimits } from "@mida/api"
import { D1BatchStore, d1Stores, runSweep } from "./index.js"
import type { D1Like } from "./d1.js"

export { BatchCoordinator } from "./batch-coordinator.js"

/** The slice of Cloudflare's rate-limit binding this worker calls: one `limit` per request. */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

/** The slice of a Durable Object namespace binding the worker calls to reach the batcher. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
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
  // BatchAnchor (Task 6): the batched-save lane. Off unless BATCHING_ENABLED === "true"; the batch
  // surface mounts whenever BATCH_ANCHOR parses as an address, so the kill switch can answer
  // { enabled: false } instead of 404ing. BATCHER_PRIVATE_KEY and RECEIPT_PRIVATE_KEY are secrets.
  BATCH_ANCHOR?: string
  BATCHING_ENABLED?: string
  BATCHER_PRIVATE_KEY?: string
  RECEIPT_PRIVATE_KEY?: string
  /** Trial gate: comma-separated owner addresses the enabled lane admits (case-insensitive). */
  BATCH_OWNER_ALLOWLIST?: string
  /** The block BatchAnchor was deployed in — the floor for its historical log scans. */
  BATCH_ANCHOR_BLOCK?: string
  BATCH_COORDINATOR?: DurableObjectNamespaceLike
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

/**
 * The request's execution context, tracked so a route's fire-and-forget wakeup — the notify fetch
 * into the coordinator — can ride the request's waitUntil instead of floating: an un-awaited
 * subrequest can be cancelled the moment the response returns, and a cancelled notify strands the
 * queue until a flush. Under Node (tests, local runs) nothing tracks a request and the promise
 * simply runs, rejection swallowed — the alarm inside the DO is the real guarantee either way.
 */
const requestScope = new AsyncLocalStorage<ExecutionContextLike>()

function background(promise: Promise<unknown> | undefined): void {
  if (promise === undefined) return
  const ctx = requestScope.getStore()
  if (ctx === undefined) {
    void promise.catch(() => {})
    return
  }
  ctx.waitUntil(promise)
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

/** The slice of viem's PublicClient the batch lane uses — one readContract for the anchor check. */
type PublicClientLike = ReturnType<typeof createPublicClient>

interface Built {
  app: ReturnType<typeof createContextApi>["app"]
  reader: RegistryReader
  stores: ReturnType<typeof d1Stores>
  deployment: Deployment
  limits: StoreLimits
}

/**
 * The Task 6 batch lane. The surface mounts whenever BATCH_ANCHOR parses as an address — under the
 * kill switch the routes answer 503/{ enabled: false } rather than 404ing, and a missing receipt
 * key then means exactly that: only BATCHING_ENABLED="true" requires the secrets, the coordinator
 * binding and the batcher key — a disabled lane must never take the whole store down. notify is
 * fire-and-forget into the single "batcher" object (covered by the request's waitUntil); flush is
 * awaited. While enabled, the first batch request also proves the anchor contract's own
 * CAPABILITY_REGISTRY() is this deployment's — a wrong contract refuses the surface (cached; a
 * failed read retries rather than latching a verdict it never reached).
 */
function batchingOptions(env: WorkerEnv, deployment: Deployment, publicClient: PublicClientLike): BatchingOptions | undefined {
  const enabled = env.BATCHING_ENABLED === "true"
  const batchAnchor =
    typeof env.BATCH_ANCHOR === "string" && /^0x[0-9a-fA-F]{40}$/.test(env.BATCH_ANCHOR)
      ? (env.BATCH_ANCHOR.toLowerCase() as Address)
      : undefined
  if (batchAnchor === undefined) {
    if (enabled) throw new Error("BATCHING_ENABLED=true requires BATCH_ANCHOR to be a 0x-prefixed 20-byte address")
    return undefined
  }
  deployment.batchAnchor = batchAnchor
  let receiptAccount: LocalAccount | undefined
  let verifyAnchor: (() => Promise<void>) | undefined
  let ownerAllowlist: Address[] | undefined
  if (enabled) {
    // The anchor's deploy block floors the coordinator's historical scans — only the enabled lane
    // ever reads it, so a placeholder beside BATCHING_ENABLED="false" stays inert rather than
    // failing a boot that never asks it anything. Enabled, a non-numeric value is a configuration
    // error and fails at boot, not inside the object mid-scan.
    if (env.BATCH_ANCHOR_BLOCK !== undefined && env.BATCH_ANCHOR_BLOCK !== "") {
      if (!/^(0|[1-9][0-9]*)$/.test(env.BATCH_ANCHOR_BLOCK)) {
        throw new Error("environment variable BATCH_ANCHOR_BLOCK must be a non-negative integer")
      }
      deployment.batchAnchorBlock = BigInt(env.BATCH_ANCHOR_BLOCK)
    }
    if (env.BATCH_COORDINATOR === undefined) {
      throw new Error("BATCHING_ENABLED=true requires the BATCH_COORDINATOR Durable Object binding")
    }
    hashEnv(env, "BATCHER_PRIVATE_KEY") // the coordinator reads it again at first use; fail at boot, not mid-queue
    receiptAccount = privateKeyToAccount(hashEnv(env, "RECEIPT_PRIVATE_KEY"))
    let verdict: Promise<void> | undefined
    verifyAnchor = () => {
      verdict ??= (async () => {
        let onchain: unknown
        try {
          onchain = await publicClient.readContract({
            address: batchAnchor,
            abi: batchAnchorAbi,
            functionName: "CAPABILITY_REGISTRY",
          })
        } catch (error) {
          verdict = undefined // a read that never reached the contract is not a verdict — retry next time
          throw new Error(`the batch anchor could not be verified against the chain: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (typeof onchain !== "string" || onchain.toLowerCase() !== deployment.capabilityRegistry) {
          throw new Error(
            `BATCH_ANCHOR ${batchAnchor} reports CAPABILITY_REGISTRY ${String(onchain)}, not this deployment's ${deployment.capabilityRegistry} — the batch surface refuses to run against the wrong contract`,
          )
        }
      })()
      return verdict
    }
    // The trial gate is read only while the lane is on — a stale value beside BATCHING_ENABLED=false
    // stays inert rather than failing a boot that never asks it anything. Entries may be
    // mixed-case; the wire's owner field is lowercase, so the list is normalized to match.
    const rawList = env.BATCH_OWNER_ALLOWLIST
    if (typeof rawList === "string" && rawList !== "") {
      const entries = rawList.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
      // A SET value that parses to zero addresses ("," or " ") must not silently mean open —
      // an operator who meant "closed" would get the opposite. Unset or empty stays "no allowlist".
      if (entries.length === 0) {
        throw new Error("environment variable BATCH_OWNER_ALLOWLIST is set but produced zero addresses")
      }
      if (!entries.every((entry) => /^0x[0-9a-fA-F]{40}$/.test(entry))) {
        throw new Error("environment variable BATCH_OWNER_ALLOWLIST must be a comma-separated list of 0x-prefixed 20-byte addresses")
      }
      ownerAllowlist = entries.map((entry) => entry.toLowerCase() as Address)
    }
  }
  const coordinator = (): { fetch(input: string | Request, init?: RequestInit): Promise<Response> } | undefined => {
    const namespace = env.BATCH_COORDINATOR
    return namespace === undefined ? undefined : namespace.get(namespace.idFromName("batcher"))
  }
  return {
    enabled,
    batchAnchor,
    store: new D1BatchStore(env.DB),
    ...(receiptAccount === undefined ? {} : { receiptAccount }),
    ...(verifyAnchor === undefined ? {} : { verifyAnchor }),
    ...(ownerAllowlist === undefined ? {} : { ownerAllowlist }),
    notify: () => {
      background(coordinator()?.fetch("https://batcher.internal/notify", { method: "POST" }))
    },
    flush: async () => {
      const stub = coordinator()
      if (stub === undefined) throw new Error("the batch coordinator is not bound")
      const response = await stub.fetch("https://batcher.internal/flush", { method: "POST" })
      if (!response.ok) throw new Error(`the batch coordinator answered ${response.status}`)
    },
  }
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
  const publicClient = createPublicClient({ batch: { multicall: true }, transport: rpcTransport(rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment })
  const stores = d1Stores(env.DB)
  const batching = batchingOptions(env, deployment, publicClient)
  const { app, limits } = createContextApi({ reader, deployment, stores, ...(batching === undefined ? {} : { batching }) })
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
export async function handleRequest(env: WorkerEnv, request: Request, ctx?: ExecutionContextLike): Promise<Response> {
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
        // Every Monad read a request makes is one subrequest; the budget is sized under the
        // Cloudflare Workers Free plan's 50-per-invocation ceiling — see the README's assumption
        // note and the current Workers limits page.
        chainReadsPerRequest: MAX_CHAIN_READS_PER_REQUEST,
        // A list that ran out of read budget flags x-mida-partial; clients retry and make progress.
        partialObjectsHeader: "x-mida-partial",
        sweep: { cron: "*/15 * * * *", maxObjectsPerRun: SWEEP_MAX_OBJECTS_PER_RUN },
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
    const response = await (ctx === undefined ? app.fetch(request) : requestScope.run(ctx, () => app.fetch(request)))
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
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(env, request, ctx)
  },

  /** Every-15-minutes cron: sweep pending uploads past 24 h and expired nonces, ≤25 object rows a run. */
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
