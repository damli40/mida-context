import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { AbiEvent } from "viem"

/** Monad's public RPC caps eth_getLogs at 100 blocks; every scan uses this window whatever the provider. */
export const MAX_LOG_BLOCK_RANGE = 100n

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

export interface DecodedLog {
  args: Record<string, unknown>
  blockNumber: bigint | null
  transactionHash: Hex | null
  logIndex: number | null
}

/** Structural subset of viem's PublicClient used for log scans, so tests can pass a recording fake. */
export interface LogClient {
  getBlockNumber(): Promise<bigint>
  getLogs(parameters: {
    address: Address
    event: AbiEvent
    args?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
    strict: true
  }): Promise<readonly unknown[]>
}

export async function getLogsChunked(
  client: LogClient,
  parameters: { address: Address; event: AbiEvent; args?: Record<string, unknown>; fromBlock: bigint; toBlock?: bigint },
): Promise<DecodedLog[]> {
  const toBlock = parameters.toBlock ?? (await client.getBlockNumber())
  const windows = blockWindows(parameters.fromBlock, toBlock)
  // One request at a time made a scan grow by about 4,300 sequential requests per day of chain
  // age (Monad: a block every 0.4 s, 100 blocks per request). Windows are fetched a few at a
  // time — the public RPC allows about 25 requests a second — and put back in block order.
  const pages: DecodedLog[][] = new Array(windows.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < windows.length) {
      const index = next++
      const window = windows[index]!
      pages[index] = (await fetchWindow(client, parameters, window)) as DecodedLog[]
    }
  }
  // A window that still fails after its retries rejects here and fails the whole scan: a scan
  // with a hole in it could report "never revoked" when the revoke sits in the missing window.
  await Promise.all(Array.from({ length: Math.min(LOG_SCAN_CONCURRENCY, windows.length) }, worker))
  return pages.flat()
}

/** How many 100-block windows are in flight at once. */
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
      // a rate-limit or a dropped connection is worth a short wait; the last failure is thrown
      if (attempt >= WINDOW_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
}
