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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  return http(url, {
    // R3's retry lives inside this fetchFn; viem's transport-level retry would multiply it.
    retryCount: 0,
    fetchFn: async (input: string | URL | Request, init?: RequestInit) => {
      await takeTurn(origin)
      return fetch(input, init)
    },
  })
}
