import { consumeFreeCalls, consumeSignBudget, recordIssued, refundSignBudget, utcDay, wasIssued } from "./budget.js"
import type { D1Like } from "./budget.js"
import {
  CALL_OVERHEAD_PER_CALL,
  DEFAULT_GAS_CEILINGS,
  ENTRY_POINT_V0_8,
  MAX_INNER_CALLS,
  USER_OP_METHODS,
  PolicyRefusal,
  checkUserOperation,
  checkedParams,
  operationIdentity,
} from "./policy.js"
import type { GasCeilings, PolicyEnv } from "./policy.js"
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
  /** Daily allowance for the unsigned methods (stub data, gas estimation) — 120 by default. */
  FREE_PER_SENDER_DAILY_LIMIT?: string
  /**
   * Optional tighter values for the fixed gas ceilings, in wei (decimal or 0x-prefixed). Each may
   * only LOWER its built-in — a value above it is ignored and logged, never applied.
   */
  VERIFICATION_GAS_CEILING?: string
  PRE_VERIFICATION_GAS_CEILING?: string
  PAYMASTER_GAS_CEILING?: string
  FEE_CEILING?: string
  /**
   * "true" sponsors the exact delegation-clearing operation (zero-address authorization, one
   * execute to self, empty data). Anything else — including unset — leaves it off.
   */
  ALLOW_CLEARING?: string
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
  freePerSenderDailyLimit: number
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

/**
 * The fixed gas ceilings as deployed. An env var may only tighten a built-in — a value above it,
 * a negative one, or one that does not parse is ignored and reported through `warn`, never
 * applied. Values are wei, decimal or 0x-prefixed.
 */
export function resolveGasCeilings(
  env: Pick<SponsorEnv, "VERIFICATION_GAS_CEILING" | "PRE_VERIFICATION_GAS_CEILING" | "PAYMASTER_GAS_CEILING" | "FEE_CEILING">,
  warn: (line: string) => void = (line) => console.log(JSON.stringify({ warn: line })),
): GasCeilings {
  const resolve = (raw: string | undefined, builtin: bigint, name: string): bigint => {
    if (raw === undefined || raw === "") return builtin
    let value: bigint
    try {
      value = BigInt(raw)
    } catch {
      warn(`${name}="${raw}" is not a wei quantity — ignored, using the built-in ${builtin}`)
      return builtin
    }
    if (value < 0n || value > builtin) {
      warn(`${name}=${value} is outside 0..${builtin} — a ceiling may only be lowered; ignored`)
      return builtin
    }
    return value
  }
  return {
    verificationGas: resolve(env.VERIFICATION_GAS_CEILING, DEFAULT_GAS_CEILINGS.verificationGas, "VERIFICATION_GAS_CEILING"),
    preVerificationGas: resolve(env.PRE_VERIFICATION_GAS_CEILING, DEFAULT_GAS_CEILINGS.preVerificationGas, "PRE_VERIFICATION_GAS_CEILING"),
    paymasterGas: resolve(env.PAYMASTER_GAS_CEILING, DEFAULT_GAS_CEILINGS.paymasterGas, "PAYMASTER_GAS_CEILING"),
    fee: resolve(env.FEE_CEILING, DEFAULT_GAS_CEILINGS.fee, "FEE_CEILING"),
  }
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
      ceilings: resolveGasCeilings(env),
      allowClearing: env.ALLOW_CLEARING === "true",
    },
    secrets,
    perSenderDailyLimit: parseLimit(env.PER_SENDER_DAILY_LIMIT, 30, "PER_SENDER_DAILY_LIMIT"),
    globalDailyLimit: parseLimit(env.GLOBAL_DAILY_LIMIT, 2000, "GLOBAL_DAILY_LIMIT"),
    freePerSenderDailyLimit: parseLimit(env.FREE_PER_SENDER_DAILY_LIMIT, 120, "FREE_PER_SENDER_DAILY_LIMIT"),
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
      callGasLimit: `sum of each inner call's per-function ceiling + ${CALL_OVERHEAD_PER_CALL} overhead per call`,
      verificationGasLimit: config.policy.ceilings.verificationGas.toString(),
      preVerificationGas: config.policy.ceilings.preVerificationGas.toString(),
      paymasterGas: config.policy.ceilings.paymasterGas.toString(),
      maxFee: config.policy.ceilings.fee.toString(),
      signingsPerSenderPerDay: config.perSenderDailyLimit,
      signingsGlobalPerDay: config.globalDailyLimit,
      freeCallsPerSenderPerDay: config.freePerSenderDailyLimit,
    },
    policy: {
      budgets:
        "signing budgets are consumed by pm_getPaymasterData, not by eth_sendUserOperation — a send is forwarded only for an operation this endpoint signed today (same sender, nonce and callData); pm_getPaymasterStubData and eth_estimateUserOperationGas share the free-calls allowance instead",
      factory:
        "only the EIP-7702 marker 0x7702 (optionally right-padded to 20 bytes) alongside a valid eip7702Auth; any other non-empty factory, initCode or factoryData is refused",
      delegationClearing: config.policy.allowClearing
        ? "enabled by ALLOW_CLEARING: a zero-address eip7702Auth sponsors only one execute to the sender's own address with empty data"
        : "disabled: zero-address eip7702Auth authorizations are refused",
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
  const day = utcDay()
  let sender: string | undefined
  try {
    let outParams: unknown = params
    let op: Record<string, unknown> | undefined
    if (USER_OP_METHODS.has(method)) {
      const checked = checkedParams(method, params, config.policy, config.provider.policyContext(required(env, "POLICY_ID")))
      op = checked[0] as Record<string, unknown>
      sender = typeof op.sender === "string" ? op.sender.toLowerCase() : undefined
      const refusal = await checkUserOperation(op, config.policy, {
        getCode: (address) => rpcGetCode(env.RPC_URL, address),
      })
      if (refusal) {
        config.log(method, refusal.rule, sender, Date.now() - started)
        return jsonRpcError(id ?? null, REFUSED, refusal.message)
      }
      outParams = checked
    }

    // The budget is spent at signing: pm_getPaymasterData returns a paymaster signature the
    // contract will honour on chain through ANY bundler, so the counters must tick before the
    // request is forwarded — and are given back when the provider never produced a signature.
    if (method === "pm_getPaymasterData") {
      const identity = operationIdentity(op!)
      const budget = await consumeSignBudget(env.DB, {
        day,
        sender: sender!,
        perSender: config.perSenderDailyLimit,
        global: config.globalDailyLimit,
      })
      if (!budget.allowed) {
        config.log(method, `budget-${budget.reason}`, sender, Date.now() - started)
        return jsonRpcError(
          id ?? null,
          REFUSED,
          budget.reason === "sender"
            ? `refused: this sender used its ${config.perSenderDailyLimit} sponsored signings for today — pay gas yourself or try tomorrow`
            : "refused: the sponsor's daily budget is exhausted — pay gas yourself or try tomorrow",
        )
      }
      let result: unknown
      try {
        result = await config.provider.forward(method, outParams)
      } catch (e) {
        await refundSignBudget(env.DB, { day, sender: sender! })
        throw e
      }
      await recordIssued(env.DB, { day, ...identity })
      config.log(method, undefined, sender, Date.now() - started)
      return jsonRpcResponse(id ?? null, result)
    }

    // The unsigned methods cannot spend — but each forwarded call still costs the provider, so
    // they get their own small per-sender allowance instead of the signing budget.
    if (method === "pm_getPaymasterStubData" || method === "eth_estimateUserOperationGas") {
      const free = await consumeFreeCalls(env.DB, { day, sender: sender!, perSender: config.freePerSenderDailyLimit })
      if (!free.allowed) {
        config.log(method, "free-sender", sender, Date.now() - started)
        return jsonRpcError(
          id ?? null,
          REFUSED,
          `refused: this sender used its ${config.freePerSenderDailyLimit} free calls for today — try tomorrow`,
        )
      }
    }

    // A send is only forwarded for an operation this endpoint signed today — we never relay a
    // paymaster sponsorship we did not issue, and we never let send become a free provider call.
    if (method === "eth_sendUserOperation") {
      const identity = operationIdentity(op!)
      if (!(await wasIssued(env.DB, { day, ...identity }))) {
        config.log(method, "not-signed", sender, Date.now() - started)
        return jsonRpcError(
          id ?? null,
          REFUSED,
          "refused: this endpoint did not sign this operation today — call pm_getPaymasterData first",
        )
      }
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
