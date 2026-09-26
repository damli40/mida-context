import { http } from "viem"
import {
  ContractFunctionZeroDataError,
  HttpRequestError,
  TimeoutError,
} from "viem"

/**
 * The one chain transport every Mida process uses. `http(rpcUrl)` alone lets a session start or a
 * drain pass burst past the public Monad RPC's ~15 requests/second and come back "not approved"
 * for an approved agent (Sep 25). Two policies live here so no call site can forget them:
 *
 * 1. a token bucket shared process-wide per RPC origin — requests over the limit WAIT, never fail;
 * 2. `retryCount: 0` on the viem transport, because retries belong to this layer (added under R3);
 *    leaving viem's own retry on would multiply every internal retry into ~16 attempts.
 *
 * A JSON-RPC batch or a multicall counts as ONE request — it is one HTTP POST.
 */

const DEFAULT_MAX_PER_SECOND = 10
const WINDOW_MS = 1_000

/** Requests fired inside the window; a serialized tail so concurrent callers cannot both fit. */
interface Bucket {
  sent: number[]
  tail: Promise<unknown>
}
const buckets = new Map<string, Bucket>()

function maxPerSecond(): number {
  const raw = process.env.MIDA_RPC_MAX_PER_SECOND
  const value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_PER_SECOND
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * The shared bucket exists for the public Monad RPC's ~15 requests/second. A loopback endpoint
 * is a local chain (Anvil in tests and dev) — it has no shared quota, and holding its sends to
 * 10/second stalls receipt polling and batch writes enough to time out real flows (in-9, the
 * batch.e2e and chain-order.e2e timeouts). An explicit MIDA_RPC_MAX_PER_SECOND overrides the
 * exemption so a test can still watch the limiter work on any origin it likes.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// in-6 R3 — a rate-limited answer is retried, then named
// ---------------------------------------------------------------------------

/**
 * The chain RPC stayed rate-limited through every retry (250/500/1000 ms). Downstream callers
 * surface this as reason `chain-busy` / code CHAIN_UNAVAILABLE — never "not approved": a busy
 * chain could not be asked, it did not refuse.
 */
export class ChainBusyError extends Error {
  readonly code = "CHAIN_BUSY"
  constructor() {
    super("the chain RPC stayed rate-limited through 3 retries")
    this.name = "ChainBusyError"
  }
}

/**
 * True when a ChainBusyError sits anywhere in the error's cause chain. viem wraps a fetchFn
 * failure in HttpRequestError (and callers may wrap again), so instanceof alone is not enough.
 */
export function isChainBusy(error: unknown): boolean {
  for (let current = error; current !== null && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if (current instanceof ChainBusyError) return true
  }
  return false
}

/**
 * What a thrown chain error actually is, so every surface names it honestly (in-11 R-8):
 *
 * - `busy` — the RPC could not answer: stayed rate-limited, answered 408/429/5xx, dropped the
 *   connection (an HttpRequestError with no status), timed out, or reported an RPC-level
 *   overload code (-32005 limit exceeded / -32603 provider-internal). Waiting and retrying is
 *   honest advice — the same set the transport's own retry treats as transient.
 * - `misconfigured` — the RPC answered but the call returned "0x" (no contract at the
 *   configured address): a wrong-network rpcUrl or a stale deployment. The fix is
 *   MONAD_TESTNET_RPC / network.json, not a retry.
 * - `rpc-auth` — the provider refused the key (HTTP 401/403). The fix is the provider
 *   credential, not a retry.
 * - `undefined` — anything else: a real contract answer (a revert), a decode failure, a local
 *   fault. Not renamed — callers keep their own fallback rather than lie.
 *
 * The walk also honours codes a store already computed: a CHAIN_UNAVAILABLE /
 * CHAIN_MISCONFIGURED / RPC_AUTH_REJECTED answer classifies the same as the raw transport
 * shape it was wrapped from, so a hosted store's answer and a local call get one name.
 */
export type ChainErrorKind = "busy" | "misconfigured" | "rpc-auth"

export function chainErrorKind(error: unknown): ChainErrorKind | undefined {
  let sawZeroData = false
  let sawAuth = false
  let sawBusy = false
  for (
    let current = error;
    current !== null && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    if (current instanceof ChainBusyError) return "busy"
    const code = (current as { code?: unknown }).code
    if (code === "CHAIN_BUSY" || code === "CHAIN_UNAVAILABLE" || code === "CHAIN_READ_BUDGET_EXHAUSTED") {
      return "busy"
    }
    if (code === "CHAIN_MISCONFIGURED") return "misconfigured"
    if (code === "RPC_AUTH_REJECTED") return "rpc-auth"
    if (current instanceof ContractFunctionZeroDataError) sawZeroData = true
    if (current instanceof HttpRequestError) {
      const status = current.status
      if (status === 401 || status === 403) sawAuth = true
      // 408/429/5xx is exactly transientAnswer's set; no status means the request never
      // reached a server (DNS, refused socket) — the same failure a retry can change.
      else if (status === undefined || status === 408 || status === 429 || status >= 500) sawBusy = true
    }
    if (current instanceof TimeoutError) sawBusy = true
    if (code === -32005 || code === -32603) sawBusy = true
  }
  // a zero-data answer is definitive misconfiguration; auth and transport signals follow
  if (sawZeroData) return "misconfigured"
  if (sawAuth) return "rpc-auth"
  if (sawBusy) return "busy"
  return undefined
}

/** The Sep 25 live answer worded it "requests limited to 15/sec"; providers say it a few ways. */
const BUSY_MESSAGE = /requests? limit|rate limit|too many requests/i

/**
 * HTTP 429, or a JSON-RPC error message that names rate limiting — single or batched body.
 * 429 is also "transient" in the 4xx sense, but it is answered first and gets ChainBusyError.
 */
async function busyAnswer(response: Response): Promise<boolean> {
  if (response.status === 429) return true
  let data: unknown
  try {
    data = await response.clone().json()
  } catch {
    return false
  }
  const items = Array.isArray(data) ? data : [data]
  return items.some((item) => {
    const message = (item as { error?: { message?: unknown } } | null | undefined)?.error?.message
    return typeof message === "string" && BUSY_MESSAGE.test(message)
  })
}

const RETRY_DELAYS_MS = [250, 500, 1_000] as const

/**
 * in-9 R-6 — the answers a retry can change: a gateway blip (5xx) or a timed-out request (408).
 * Anything else 4xx is the request itself being wrong — retrying it just burns the allowance.
 * A fetch that throws (DNS, refused connection, dropped socket) is transient the same way and
 * is handled inside fetchFn, where the thrown error can be caught.
 */
function transientAnswer(status: number): boolean {
  return status === 408 || status >= 500
}

/** Waits until this request's send fits inside the origin's sliding 1-second window. */
async function acquire(bucket: Bucket): Promise<void> {
  for (;;) {
    const now = Date.now()
    while (bucket.sent.length > 0 && bucket.sent[0]! <= now - WINDOW_MS) bucket.sent.shift()
    if (bucket.sent.length < maxPerSecond()) {
      bucket.sent.push(now)
      rpcTransportProbe.sentAt.push(now)
      return
    }
    await sleep(Math.max(bucket.sent[0]! + WINDOW_MS - now, 1))
  }
}

function takeTurn(origin: string): Promise<void> {
  let bucket = buckets.get(origin)
  if (bucket === undefined) {
    bucket = { sent: [], tail: Promise.resolve() }
    buckets.set(origin, bucket)
  }
  const next = bucket.tail.then(() => acquire(bucket!))
  bucket.tail = next
  return next
}

/**
 * Test seam (in-6 R1/R2): the admission instant of every request the limiter released — one per
 * wire send, so its length is the HTTP request count and its timestamps are what the limiter
 * enforced (the fetch itself dispatches within the same event-loop turn). Module-global; tests
 * call `reset()` and read `sentAt`.
 */
export const rpcTransportProbe = {
  sentAt: [] as number[],
  reset(): void {
    this.sentAt.length = 0
  },
}

/**
 * The transport to put in every public and wallet client: `rpcTransport(url)` in place of
 * `http(url)`. The rate limit key is the URL's origin, so two transports aimed at one host share
 * one bucket — inside ONE process. The bucket is per process, not global: a `mida` CLI running
 * beside the daemon has its own, so N processes can still reach N× the host's allowance (in-11
 * R-15 — the old comment claimed they could not).
 */
export function rpcTransport(url: string) {
  const origin = originOf(url)
  const loopback = isLoopbackOrigin(origin)
  // Exempt or not, every send is admitted into rpcTransportProbe so request counts stay true.
  const admit = () =>
    loopback && process.env.MIDA_RPC_MAX_PER_SECOND === undefined
      ? Promise.resolve(rpcTransportProbe.sentAt.push(Date.now()) as unknown as void)
      : takeTurn(origin)
  return http(url, {
    // R3's retry lives inside this fetchFn; viem's transport-level retry would multiply it.
    retryCount: 0,
    fetchFn: async (input: string | URL | Request, init?: RequestInit) => {
      for (let attempt = 0; ; attempt += 1) {
        // every attempt is one HTTP request — the bucket counts retries too
        await admit()
        let response: Response
        try {
          response = await fetch(input, init)
        } catch (error) {
          if (attempt >= RETRY_DELAYS_MS.length) throw error
          await sleep(RETRY_DELAYS_MS[attempt]!)
          continue
        }
        if (await busyAnswer(response)) {
          if (attempt >= RETRY_DELAYS_MS.length) throw new ChainBusyError()
          await sleep(RETRY_DELAYS_MS[attempt]!)
          continue
        }
        if (!transientAnswer(response.status)) return response
        // Out of retries: hand the last answer back so viem reports the real status.
        if (attempt >= RETRY_DELAYS_MS.length) return response
        await sleep(RETRY_DELAYS_MS[attempt]!)
      }
    },
  })
}
