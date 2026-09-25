// F2's chain-log fallback bounds. When the index is down the page scans grant/revoke events
// straight from the RPC; the scan must never run unbounded — at most 4 requests in the air at
// once across every event it scans, and the whole scan abandoned after 20 seconds, at which
// point /me reports the agent list unavailable rather than hanging.

import { afterEach, describe, expect, it, vi } from "vitest"
import type { AbiEvent } from "viem"
import { getLogsChunked } from "@mida/chain/browser"
import type { LogClient } from "@mida/chain/browser"
import { LOG_SCAN_IN_FLIGHT, LOG_SCAN_TIMEOUT_MS, LOG_SCAN_TIMEOUT_TEXT, boundedScanClient, scanWithDeadline } from "../src/me/logscan.js"
import type { Address } from "@mida/protocol"

const REGISTRY = `0x${"99".repeat(20)}` as Address
const EVENT = { type: "event", name: "CapabilityGranted", inputs: [] } as unknown as AbiEvent

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("boundedScanClient", () => {
  it("never lets more than LOG_SCAN_IN_FLIGHT requests run at once — across separate scans", async () => {
    let inFlight = 0
    let peak = 0
    const inner: LogClient = {
      getBlockNumber: async () => 2_000n,
      getLogs: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await sleep(5)
        inFlight -= 1
        return []
      },
    }
    // one wrapped client shared by three concurrent scans — the same shape page.ts's
    // ownerGrantLogs runs — so the cap is measured against the combined request pool
    const client = boundedScanClient(inner)
    const scan = () =>
      getLogsChunked(client, { address: REGISTRY, event: EVENT, fromBlock: 0n }, { maxRange: 100n })
    await Promise.all([scan(), scan(), scan()])
    // 2,001 blocks at 100-block windows = 21 windows per scan, 63 requests in all —
    // plenty of opportunity to exceed the cap if the wrapper did not enforce it
    expect(peak).toBeLessThanOrEqual(LOG_SCAN_IN_FLIGHT)
    expect(peak).toBeGreaterThan(1) // the cap is real concurrency, not serialization
  })

  it("refuses to start a request once the deadline has passed", async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<{ fromBlock: bigint }> = []
      const inner: LogClient = {
        getBlockNumber: async () => 10_000n,
        getLogs: async (parameters) => {
          calls.push({ fromBlock: parameters.fromBlock })
          await sleep(30_000) // every request is slower than the deadline
          return []
        },
      }
      const client = boundedScanClient(inner, { timeoutMs: LOG_SCAN_TIMEOUT_MS })
      const scan = getLogsChunked(client, { address: REGISTRY, event: EVENT, fromBlock: 0n }, { maxRange: 100n })
      const failure = expect(scan).rejects.toThrow(LOG_SCAN_TIMEOUT_TEXT)
      await vi.advanceTimersByTimeAsync(LOG_SCAN_TIMEOUT_MS + 30_000)
      await failure
      // the deadline stopped the scan partway — 101 windows were planned, nowhere near all ran
      expect(calls.length).toBeLessThan(101)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("scanWithDeadline", () => {
  afterEach(() => vi.useRealTimers())

  it("abandons a scan whose in-flight requests never return", async () => {
    vi.useFakeTimers()
    const never = new Promise<never>(() => {})
    const scan = scanWithDeadline(never, LOG_SCAN_TIMEOUT_MS)
    const failure = expect(scan).rejects.toThrow(LOG_SCAN_TIMEOUT_TEXT)
    await vi.advanceTimersByTimeAsync(LOG_SCAN_TIMEOUT_MS)
    await failure
  })

  it("passes a finished scan through untouched", async () => {
    await expect(scanWithDeadline(Promise.resolve("done"), LOG_SCAN_TIMEOUT_MS)).resolves.toBe("done")
  })
})
