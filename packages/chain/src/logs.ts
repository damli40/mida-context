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
  const logs: DecodedLog[] = []
  for (const window of blockWindows(parameters.fromBlock, toBlock)) {
    const page = await client.getLogs({
      address: parameters.address,
      event: parameters.event,
      ...(parameters.args === undefined ? {} : { args: parameters.args }),
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
      strict: true,
    })
    logs.push(...(page as DecodedLog[]))
  }
  return logs
}
