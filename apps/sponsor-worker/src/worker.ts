import { consumeSendBudget, utcDay } from "./budget.js"
import type { D1Like } from "./budget.js"
import {
  CALL_GAS_CEILING,
  ENTRY_POINT_V0_8,
  FEE_CEILING,
  MAX_INNER_CALLS,
  PAYMASTER_GAS_CEILING,
  PRE_VERIFICATION_GAS_CEILING,
  USER_OP_METHODS,
  VERIFICATION_GAS_CEILING,
  PolicyRefusal,
  checkUserOperation,
  checkedParams,
} from "./policy.js"
import type { PolicyEnv } from "./policy.js"
import { ProviderError, alchemyProvider, httpJsonRpcProvider, pimlicoProvider } from "./provider.js"
import type { SponsorProvider } from "./provider.js"

/**
 * A JSON-RPC proxy that pays gas for Mida calls and refuses everything else. It holds the provider
 * API key and the sponsorship policy id server-side; it can pay for a call or refuse to. It cannot
 * sign, read, grant or revoke anything — the contract still sees the user's own address as
 * msg.sender.
 */

export interface SponsorEnv {
  /** D1 binding for the daily budget counters. */
  DB: D1Like
  /** Provider selection: "pimlico" (default) or "alchemy"; PROVIDER_URL overrides both. */
  PROVIDER?: string
  /** Full provider JSON-RPC URL including any embedded key — a secret. Overrides PROVIDER. */
  PROVIDER_URL?: string
  /** Provider API key — a secret. */
  PROVIDER_KEY?: string
  /** Pimlico chain slug; default "monad-testnet". */
  PIMLICO_CHAIN_SLUG?: string
  /** Alchemy account-abstraction base URL (the key is appended as the last path segment). */
  ALCHEMY_BASE_URL?: string
  /** Sponsorship policy id — a secret; injected by the worker, never taken from the client. */
  POLICY_ID: string
  /** Chain JSON-RPC used to read a sender's delegation when the op carries no authorization — a secret. */
  RPC_URL: string
  CHAIN_ID: string
  CAPABILITY_REGISTRY: string
  CONTEXT_REGISTRY: string
  /** Comma-separated EIP-7702 implementation addresses the sender may delegate to. */
  ALLOWED_IMPLEMENTATIONS: string
  PER_SENDER_DAILY_LIMIT?: string
  GLOBAL_DAILY_LIMIT?: string
}

const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pimlico_getUserOperationGasPrice",
])

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const REFUSED = -32000

interface SponsorConfig {
  provider: SponsorProvider
  policy: PolicyEnv
  secrets: string[]
  perSenderDailyLimit: number
  globalDailyLimit: number
  /** The log body — everything the worker may print, already reduced to non-secret fields. */
  log(method: string, refused: string | undefined, sender: string | undefined, ms: number): void
}

const built = new WeakMap<SponsorEnv, SponsorConfig>()

function required(env: SponsorEnv, name: keyof SponsorEnv): string {
  const value = env[name]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required configuration ${name}`)
  }
  return value
}

function parseAddress(value: string, name: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is not a 20-byte hex address`)
  return value.toLowerCase()
}

function parseLimit(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`)
  return n
}

export function buildWorker(env: SponsorEnv): SponsorConfig {
  const cached = built.get(env)
  if (cached) return cached

  const secrets = [env.PROVIDER_KEY, env.POLICY_ID, env.PROVIDER_URL, env.RPC_URL].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  )
  const provider = env.PROVIDER_URL
    ? httpJsonRpcProvider(env.PROVIDER_URL, { name: env.PROVIDER ?? "custom" })
    : (env.PROVIDER ?? "pimlico") === "pimlico"
      ? pimlicoProvider({ apiKey: required(env, "PROVIDER_KEY"), chainSlug: env.PIMLICO_CHAIN_SLUG ?? "monad-testnet" })
      : env.PROVIDER === "alchemy"
        ? alchemyProvider({ apiKey: required(env, "PROVIDER_KEY"), baseUrl: required(env, "ALCHEMY_BASE_URL") })
        : (() => {
            throw new Error(`unknown PROVIDER "${env.PROVIDER}" — expected "pimlico", "alchemy", or set PROVIDER_URL`)
          })()

  const chainId = BigInt(required(env, "CHAIN_ID"))
  const allowedImplementations = new Set(
    required(env, "ALLOWED_IMPLEMENTATIONS")
      .split(",")
      .map((raw) => parseAddress(raw.trim(), "ALLOWED_IMPLEMENTATIONS")),
  )

  const config: SponsorConfig = {
    provider,
    policy: {
      chainId,
      capabilityRegistry: parseAddress(required(env, "CAPABILITY_REGISTRY"), "CAPABILITY_REGISTRY"),
      contextRegistry: parseAddress(required(env, "CONTEXT_REGISTRY"), "CONTEXT_REGISTRY"),
      allowedImplementations,
    },
    secrets,
    perSenderDailyLimit: parseLimit(env.PER_SENDER_DAILY_LIMIT, 30, "PER_SENDER_DAILY_LIMIT"),
    globalDailyLimit: parseLimit(env.GLOBAL_DAILY_LIMIT, 2000, "GLOBAL_DAILY_LIMIT"),
    log(method, refused, sender, ms) {
      // method, refusal rule, first 10 chars of the sender, milliseconds — never a body, a key,
      // a policy id, a private key, or a full address or hash.
      console.log(JSON.stringify({ method, refused, sender: sender?.slice(0, 10), ms }))
    },
  }
  built.set(env, config)
  return config
}

/** Replace every configured secret in provider output before it can reach a client or a log. */
function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join("[redacted]")
  return out
}

async function rpcGetCode(rpcUrl: string, address: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  })
  if (!response.ok) throw new Error(`eth_getCode answered HTTP ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } }
  if (body.error) throw new Error(typeof body.error.message === "string" ? body.error.message : "eth_getCode failed")
  return typeof body.result === "string" ? body.result : "0x"
}

function infoResponse(config: SponsorConfig): Response {
  const body = {
    name: "mida-gas-sponsor",
    description:
      "A gas sponsor for Mida calls on Monad. It can pay for a call or refuse to. It cannot sign, read, grant or revoke.",
    provider: config.provider.name,
    chainId: config.policy.chainId.toString(),
    entryPoint: ENTRY_POINT_V0_8,
    capabilityRegistry: config.policy.capabilityRegistry,
    contextRegistry: config.policy.contextRegistry,
    allowedImplementations: [...config.policy.allowedImplementations],
    methods: [...ALLOWED_METHODS],
    limits: {
      maxInnerCalls: MAX_INNER_CALLS,
      callGasLimit: CALL_GAS_CEILING.toString(),
      verificationGasLimit: VERIFICATION_GAS_CEILING.toString(),
      preVerificationGas: PRE_VERIFICATION_GAS_CEILING.toString(),
      paymasterGas: PAYMASTER_GAS_CEILING.toString(),
      maxFee: FEE_CEILING.toString(),
      perSenderPerDay: config.perSenderDailyLimit,
      globalPerDay: config.globalDailyLimit,
    },
  }
  return new Response(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json" } })
}

function jsonRpcResponse(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result })
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
}

async function handleJsonRpc(env: SponsorEnv, config: SponsorConfig, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonRpcError(null, PARSE_ERROR, "the request body is not JSON")
  }
  // Batches are refused outright — batching is how a policy check gets skipped.
  if (Array.isArray(body) || typeof body !== "object" || body === null) {
    return jsonRpcError(null, INVALID_REQUEST, "this endpoint takes one JSON-RPC request at a time — no batches")
  }
  const { id, method, params } = body as { id?: unknown; method?: unknown; params?: unknown }
  if (typeof method !== "string") return jsonRpcError(id ?? null, INVALID_REQUEST, "missing method")
  if (!ALLOWED_METHODS.has(method)) return jsonRpcError(id ?? null, METHOD_NOT_FOUND, `method ${method} is not supported here`)

  const started = Date.now()
  let sender: string | undefined
  try {
    let outParams: unknown = params
    if (USER_OP_METHODS.has(method)) {
      const checked = checkedParams(method, params, config.policy, config.provider.policyContext(required(env, "POLICY_ID")))
      const op = checked[0] as Record<string, unknown>
      sender = typeof op.sender === "string" ? op.sender.toLowerCase() : undefined
      const refusal = await checkUserOperation(op, config.policy, {
        getCode: (address) => rpcGetCode(env.RPC_URL, address),
      })
      if (refusal) {
        config.log(method, refusal.rule, sender, Date.now() - started)
        return jsonRpcError(id ?? null, REFUSED, refusal.message)
      }
      if (method === "eth_sendUserOperation" && sender) {
        const budget = await consumeSendBudget(env.DB, {
          day: utcDay(),
          sender,
          perSender: config.perSenderDailyLimit,
          global: config.globalDailyLimit,
        })
        if (!budget.allowed) {
          config.log(method, `budget-${budget.reason}`, sender, Date.now() - started)
          return jsonRpcError(
            id ?? null,
            REFUSED,
            budget.reason === "sender"
              ? `refused: this sender used its ${config.perSenderDailyLimit} sponsored operations for today — pay gas yourself or try tomorrow`
              : "refused: the sponsor's daily budget is exhausted — pay gas yourself or try tomorrow",
          )
        }
      }
      outParams = checked
    }
    const result = await config.provider.forward(method, outParams)
    config.log(method, undefined, sender, Date.now() - started)
    return jsonRpcResponse(id ?? null, result)
  } catch (e) {
    if (e instanceof PolicyRefusal) {
      config.log(method, e.refusal.rule, sender, Date.now() - started)
      return jsonRpcError(id ?? null, REFUSED, e.refusal.message)
    }
    if (e instanceof ProviderError) {
      config.log(method, `provider-${e.code}`, sender, Date.now() - started)
      return jsonRpcError(id ?? null, e.code, scrub(e.message, config.secrets))
    }
    config.log(method, "internal", sender, Date.now() - started)
    return jsonRpcError(id ?? null, INTERNAL_ERROR, "internal sponsor error")
  }
}

export default {
  async fetch(request: Request, env: SponsorEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/") {
      try {
        return infoResponse(buildWorker(env))
      } catch {
        return Response.json({ error: "the sponsor endpoint is not configured" }, { status: 500 })
      }
    }
    if (request.method !== "POST" || url.pathname !== "/") {
      return Response.json({ error: "not found" }, { status: 404 })
    }
    try {
      const config = buildWorker(env)
      return await handleJsonRpc(env, config, request)
    } catch {
      return Response.json({ error: "the sponsor endpoint is not configured" }, { status: 500 })
    }
  },
}
