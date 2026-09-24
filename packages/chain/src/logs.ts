import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { AbiEvent } from "viem"

/** The largest window an eth_getLogs scan may open with — Quicknode's Monad endpoint serves 1,000-block ranges. */
export const MAX_LOG_BLOCK_RANGE = 1_000n
/**
 * The window every provider is assumed to accept — Monad's public RPC caps eth_getLogs at 100
 * blocks. The first range refusal drops the rest of a scan, and the refused window, to this size.
 */
export const SAFE_LOG_BLOCK_RANGE = 100n

export interface BlockWindow {
  fromBlock: bigint
  toBlock: bigint
}

export function blockWindows(fromBlock: bigint, toBlock: bigint, size: bigint = MAX_LOG_BLOCK_RANGE): BlockWindow[] {
  if (size <= 0n || size > MAX_LOG_BLOCK_RANGE) {
    throw new MidaError("INVALID_WIRE", `log window must be 1-${MAX_LOG_BLOCK_RANGE} blocks`)
  }
  const windows: BlockWindow[] = []
  for (let start = fromBlock; start <= toBlock; start += size) {
    const end = start + size - 1n
    windows.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock })
  }
  return windows
}

/**
 * The window size a scan opens with, clamped to 1..MAX_LOG_BLOCK_RANGE. `undefined` means the
 * maximum. Callers pass an operator-chosen value through (MIDA_LOG_BLOCK_RANGE); a nonsense one
 * is pulled inside the valid range rather than crashing the scan — the same way an unreadable
 * env value is ignored instead of refused.
 */
export function clampLogRange(maxRange: bigint | undefined): bigint {
  if (maxRange === undefined) return MAX_LOG_BLOCK_RANGE
  if (maxRange < 1n) return 1n
  if (maxRange > MAX_LOG_BLOCK_RANGE) return MAX_LOG_BLOCK_RANGE
  return maxRange
}

export interface DecodedLog {
  args: Record<string, unknown>
  blockNumber: bigint | null
  transactionHash: Hex | null
  logIndex: number | null
}

/** Structural subset of viem's PublicClient used for log scans, so tests can pass a recording fake. */
export interface LogClient {
  getBlockNumber(parameters?: { cacheTime?: number }): Promise<bigint>
  getLogs(parameters: {
    address: Address
    event: AbiEvent
    args?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
    strict: true
  }): Promise<readonly unknown[]>
}

export interface LogScanOptions {
  /** The window size the scan opens with — clamped to 1..MAX_LOG_BLOCK_RANGE, default the maximum. */
  maxRange?: bigint
  /**
   * Scan progress as (completed, planned) requests. `total` grows when a range refusal splits a
   * window into SAFE pieces, so it is an estimate, not a promise. Called at most about once per
   * 5% of the plan, and always once at the end with (total, total).
   */
  onProgress?: (done: number, total: number) => void
}

/**
 * True for a provider answer that means "your block range was too wide": HTTP 413, the JSON-RPC
 * codes Quicknode and Monad use (-32614, -32005), or a message that says so. viem nests the
 * transport failure inside its own error, so the whole cause chain is checked.
 */
function isRangeLimitError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== null && current !== undefined && depth < 10; depth++) {
    const record = current as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; cause?: unknown }
    if (record.code === -32614 || record.code === -32005) return true
    if (record.status === 413 || record.statusCode === 413) return true
    for (const text of [record.message, record.details]) {
      if (typeof text === "string" && /range|block range|limited to|too many blocks/i.test(text)) return true
    }
    current = record.cause
  }
  return false
}

export async function getLogsChunked(
  client: LogClient,
  parameters: { address: Address; event: AbiEvent; args?: Record<string, unknown>; fromBlock: bigint; toBlock?: bigint },
  options?: LogScanOptions,
): Promise<DecodedLog[]> {
  // cacheTime: 0 — viem answers getBlockNumber from a per-client cache for client.cacheTime ms, and
  // a receipt wait just before the scan can leave a pre-mining head in it. The scan would then end
  // before the block that was just mined and miss its logs — a hole that looks like "not anchored".
  const toBlock = parameters.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }))
  const windows = blockWindows(parameters.fromBlock, toBlock, clampLogRange(options?.maxRange))
  // One request at a time made a scan grow by about 4,300 sequential requests per day of chain
  // age (Monad: a block every 0.4 s, 100 blocks per request). Windows are fetched a few at a
  // time — the public RPC allows about 25 requests a second — and put back in block order.
  const pages: DecodedLog[][] = new Array(windows.length)
  let next = 0
  // Set by the first window the provider refuses for its size. Once a provider has said its cap,
  // asking the same question for the next window only earns the refusal again — every later
  // window still wider than SAFE is re-sliced without being tried first.
  let rangeLimited = false
  // `total` is the planned request count: one per window until a refusal splits a window into
  // SAFE pieces, each of which is its own request. `done` counts completed requests.
  let total = windows.length
  let done = 0
  // the `done` value last handed to onProgress — -1 means nothing has been reported yet, so the
  // closing report still fires on an empty scan
  let reported = -1
  const report = (): void => {
    if (options?.onProgress === undefined || done === reported) return
    if (done === total || done - reported >= Math.max(1, Math.ceil(total / 20))) {
      reported = done
      options.onProgress(done, total)
    }
  }
  const worker = async (): Promise<void> => {
    while (next < windows.length) {
      const index = next++
      const window = windows[index]!
      const widerThanSafe = window.toBlock - window.fromBlock + 1n > SAFE_LOG_BLOCK_RANGE
      let logs: readonly unknown[] | undefined
      if (!(rangeLimited && widerThanSafe)) {
        try {
          logs = await fetchWindow(client, parameters, window)
        } catch (error) {
          // A range refusal is not a failure to retry: the window's blocks still have to be read,
          // in pieces the provider accepts. Anything else keeps fetchWindow's retry-then-fail.
          if (!isRangeLimitError(error)) throw error
          rangeLimited = true
        }
      }
      if (logs !== undefined) {
        pages[index] = logs as DecodedLog[]
        done += 1
        report()
        continue
      }
      // The window was refused for its size (or a previous refusal proved it would be): re-fetch
      // the SAME blocks in SAFE pieces. Skipping any of them could make a revoked agent look
      // never-revoked — a hole in a history scan is the one outcome worse than a slow one.
      const pieces = blockWindows(window.fromBlock, window.toBlock, SAFE_LOG_BLOCK_RANGE)
      total += pieces.length - 1
      const collected: DecodedLog[] = []
      for (const piece of pieces) {
        collected.push(...((await fetchWindow(client, parameters, piece)) as DecodedLog[]))
        done += 1
        report()
      }
      pages[index] = collected
    }
  }
  // A window that still fails after its retries rejects here and fails the whole scan: a scan
  // with a hole in it could report "never revoked" when the revoke sits in the missing window.
  await Promise.all(Array.from({ length: Math.min(LOG_SCAN_CONCURRENCY, windows.length) }, worker))
  // Always close on (done, total) — the last window's own report usually already carried it, so
  // only fire again if progress stalled short of the final state (or never ran, on an empty scan).
  if (done !== reported) options?.onProgress?.(done, total)
  return pages.flat()
}

/** How many windows are in flight at once. */
export const LOG_SCAN_CONCURRENCY = 8
const WINDOW_ATTEMPTS = 3

async function fetchWindow(
  client: LogClient,
  parameters: { address: Address; event: AbiEvent; args?: Record<string, unknown> },
  window: BlockWindow,
): Promise<readonly unknown[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.getLogs({
        address: parameters.address,
        event: parameters.event,
        ...(parameters.args === undefined ? {} : { args: parameters.args }),
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        strict: true,
      })
    } catch (error) {
      // a range refusal is deterministic — retrying asks the same question again, so it surfaces
      // at once for the caller to re-slice; a rate-limit or a dropped connection is worth a short
      // wait; the last failure is thrown
      if (isRangeLimitError(error) || attempt >= WINDOW_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
}
