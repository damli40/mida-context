import { http } from "viem"

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

/** The Sep 25 live answer worded it "requests limited to 15/sec"; providers say it a few ways. */
const BUSY_MESSAGE = /requests? limit|rate limit|too many requests/i

/** HTTP 429, or a JSON-RPC error message that names rate limiting — single or batched body. */
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
 * one bucket — the daemon, drainer and CLI cannot double-spend the host's allowance.
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
        const response = await fetch(input, init)
        if (!(await busyAnswer(response))) return response
        if (attempt >= RETRY_DELAYS_MS.length) throw new ChainBusyError()
        await sleep(RETRY_DELAYS_MS[attempt]!)
      }
    },
  })
}
