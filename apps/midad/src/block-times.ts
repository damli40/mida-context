import { BLOCK_TIME_CACHE_MAX } from "@mida/chain"
import type { MidaHome } from "./home.js"

const FILE = "state/block-times.json"

/** The service writes the file at most this often while the map keeps growing (CHAIN-04). */
export const BLOCK_TIMES_SAVE_EVERY_MS = 30_000

const PLAIN_INTEGER = /^\d{1,20}$/

/**
 * Monad block timestamps this home has already asked for, at `state/block-times.json` (CHAIN-04,
 * Oct 5). A block number and its time are public chain data, safe on disk, and they never change,
 * so a restarted service reads its batched saves without asking Monad about those blocks again.
 * Keyed by chain id: a file written against another chain id is ignored; a local test chain
 * restarted under the SAME chain id reuses block numbers, so delete the file when you reset one
 * (MIN-3). It is a cache, not the truth: a missing, corrupt or foreign file reads as empty.
 */
export function loadBlockTimes(home: MidaHome, chainId: bigint): Map<bigint, bigint> {
  const map = new Map<bigint, bigint>()
  try {
    const raw = home.readJson<{ chainId?: unknown; blocks?: unknown }>(FILE)
    if (raw === undefined || raw === null || typeof raw !== "object" || raw.chainId !== chainId.toString()) return map
    const blocks = raw.blocks
    if (typeof blocks !== "object" || blocks === null || Array.isArray(blocks)) return map
    for (const [block, time] of Object.entries(blocks as Record<string, unknown>)) {
      if (map.size >= BLOCK_TIME_CACHE_MAX) break
      if (PLAIN_INTEGER.test(block) && typeof time === "string" && PLAIN_INTEGER.test(time)) map.set(BigInt(block), BigInt(time))
    }
    return map
  } catch {
    return new Map()
  }
}

/** Writes the map atomically, owner-only. A failed write is dropped: it only means a slower next start. */
export function saveBlockTimes(home: MidaHome, chainId: bigint, map: ReadonlyMap<bigint, bigint>): void {
  try {
    const blocks: Record<string, string> = {}
    for (const [block, time] of map) blocks[block.toString()] = time.toString()
    home.writeSecretJson(FILE, { chainId: chainId.toString(), blocks })
  } catch {
    // a cache that cannot be written costs the next start some chain reads, never a refusal
  }
}
