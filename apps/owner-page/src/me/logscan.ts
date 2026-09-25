/**
 * The chain-log fallback's bounds. When the index is down, /me reads CapabilityGranted /
 * CapabilityRevoked / AgentRevoked logs straight from the RPC — an unbounded scan of
 * ~65 million blocks could stall the page for minutes at the provider's smallest window, so
 * the scan is capped two ways and either cap ending it means "the agent list is unavailable",
 * never "nobody has access".
 *
 *   - at most LOG_SCAN_IN_FLIGHT requests are in the air at once, across ALL event scans —
 *     the cap lives in a LogClient wrapper, so every getLogs/getBlockNumber any scan issues
 *     counts against the same pool;
 *   - the whole scan dies after LOG_SCAN_TIMEOUT_MS — both by refusing to start a request
 *     past the deadline and by racing the scan against a reject timer for a request that
 *     never comes back.
 */

import type { LogClient } from "@mida/chain/browser"

export const LOG_SCAN_TIMEOUT_MS = 20_000
export const LOG_SCAN_IN_FLIGHT = 4
export const LOG_SCAN_TIMEOUT_TEXT = "the chain log scan ran out of time"

/**
 * `client` with a shared concurrency cap and a deadline. Requests are admitted in call order;
 * one that finds the deadline already passed fails immediately, which is what unwinds the
 * chunked scans above it.
 */
export function boundedScanClient(
  client: LogClient,
  opts: { timeoutMs?: number; maxInFlight?: number } = {},
): LogClient {
  const deadline = Date.now() + (opts.timeoutMs ?? LOG_SCAN_TIMEOUT_MS)
  const limit = Math.max(1, opts.maxInFlight ?? LOG_SCAN_IN_FLIGHT)
  let inFlight = 0
  const waiters: (() => void)[] = []
  const acquire = (): Promise<void> => {
    if (inFlight < limit) {
      inFlight += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next !== undefined) next()
    else inFlight -= 1
  }
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() >= deadline) throw new Error(LOG_SCAN_TIMEOUT_TEXT)
    await acquire()
    try {
      if (Date.now() >= deadline) throw new Error(LOG_SCAN_TIMEOUT_TEXT)
      return await fn()
    } finally {
      release()
    }
  }
  return {
    getBlockNumber: (parameters) => call(() => client.getBlockNumber(parameters)),
    getLogs: (parameters) => call(() => client.getLogs(parameters)),
  }
}

/**
 * The overall deadline for requests already in the air — a getLogs that simply never returns
 * cannot be interrupted, so the scan promise races a timer and the loser is abandoned.
 */
export async function scanWithDeadline<T>(work: Promise<T>, timeoutMs: number = LOG_SCAN_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(LOG_SCAN_TIMEOUT_TEXT)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
