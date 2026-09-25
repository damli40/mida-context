// Shared test plumbing for the Envio indexer tests.
//
// createTestIndexer() is envio's in-memory indexer: it parses config.yaml +
// schema.graphql itself (native addon, resolved relative to process.cwd()),
// loads the real registered handlers from src/EventHandlers.ts, runs simulate
// items through the same routing pipeline as live indexing, and stores entities
// in a per-instance in-memory store. No network, no Docker, no Postgres.
//
// Because the config file is resolved from cwd, every test that calls
// createTestIndexer() must run after this module has chdir'd into apps/indexer.
import { createTestIndexer } from "envio"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const indexerDir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(indexerDir)

export const CHAIN_ID = 10143
// Read from config.yaml's start_block — simulate items may not sit below it. Read, not copied:
// the Sep 22 redeploy moved the block and a copied constant silently failed every test.
export const START_BLOCK = (() => {
  const text = readFileSync(new URL("../config.yaml", import.meta.url), "utf8")
  const match = /^\s*start_block:\s*(\d+)\s*$/m.exec(text)
  if (match === null) throw new Error("config.yaml has no start_block")
  return Number(match[1])
})()

// BatchAnchor carries its own contract-level start_block (it deployed later than
// the other contracts). Simulate items for it may not sit below that block either.
// Read from config.yaml, not copied — same reason as START_BLOCK above.
export const BATCH_ANCHOR_START_BLOCK = (() => {
  const text = readFileSync(new URL("../config.yaml", import.meta.url), "utf8")
  // "- name: BatchAnchor" appears twice — the top-level contracts list has no
  // start_block, so anchor inside `chains:` where the per-contract one lives.
  const match = /chains:[\s\S]*?- name: BatchAnchor[\s\S]*?start_block:\s*(\d+)/.exec(text)
  if (match === null) return START_BLOCK
  return Number(match[1])
})()

export const newIndexer = () => createTestIndexer()

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
export const bytes32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
export const txHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

export type SimItem = {
  contract: string
  event: string
  params?: Record<string, unknown>
  srcAddress?: string
  logIndex?: number
  block?: { number?: number; timestamp?: number; hash?: string }
  transaction?: { hash?: string }
}

// Builds one simulate item. `opts.tx` and `opts.logIndex` together form the
// event id ("${txHash}-${logIndex}") every idempotent row is keyed on.
export const item = (
  contract: string,
  event: string,
  params: Record<string, unknown>,
  opts: { tx: number; block: number; timestamp?: number; logIndex?: number },
): SimItem => ({
  contract,
  event,
  params,
  block: { number: opts.block, timestamp: opts.timestamp ?? 1_700_000_000 + opts.block },
  transaction: { hash: txHash(opts.tx) },
  ...(opts.logIndex === undefined ? {} : { logIndex: opts.logIndex }),
})

export const run = async (indexer: ReturnType<typeof newIndexer>, items: SimItem[]) => {
  await indexer.process({
    chains: {
      [CHAIN_ID]: { simulate: items as never },
    },
  })
}

// A GrantContext tuple, as CapabilityGranted carries it. Only existence matters
// to the index — the fields are public commitments.
export const grantContext = (seed = 1) => ({
  requestHash: bytes32(0x1000 + seed),
  manifestHash: bytes32(0x2000 + seed),
  manifestVersion: 1n,
  policyVersionHash: bytes32(0x3000 + seed),
  namespaceTreeVersionHash: bytes32(0x4000 + seed),
  grantNonce: BigInt(seed),
})

// A full ContextRegistry record tuple (recordType 0 = context, 1 = evidence).
export const contextRecordTuple = (seed: number, recordType: 0n | 1n = 0n) => ({
  contextId: bytes32(0x5000 + seed),
  owner: addr(0x10 + seed),
  author: bytes32(0x6000 + seed),
  namespaceId: bytes32(0x7000 + seed),
  lineageId: bytes32(0x8000 + seed),
  parentId: bytes32(0),
  manifestHash: bytes32(0x9000 + seed),
  ciphertextCommitment: bytes32(0xa000 + seed),
  evidenceCommitment: bytes32(0xb000 + seed),
  readEpoch: 0n,
  createdAt: 1700000000n,
  expiresAt: 1800000000n,
  version: 1n,
  recordType,
  lineagePolicy: 0n,
  kind: 0n,
  provenanceSource: 0n,
})
