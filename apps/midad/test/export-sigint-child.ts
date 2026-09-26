// Child process for the SIGINT regression test (export.test.ts "an interrupted export…"):
// exports a large record set into <argv[2]>/backup through the real exportRecords with injected
// deps — no chain, no real home. The parent sends SIGINT while the staged plaintext folder
// exists; the export must delete it before the process exits.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keccak256, zeroHash } from "viem"
import { OWNER_AUTHOR_ID, canonicalBytes, namespaceId } from "@mida/protocol"
import type { Hex, ObjectManifest } from "@mida/protocol"
import { MidaHome } from "../src/home.js"
import { saveOwnerAddress, saveOwnerMode } from "../src/keys.js"
import { exportRecords } from "../src/export.js"
import type { SourceRecord } from "../src/owner-read.js"
import type { Network, Runtime } from "../src/runtime.js"

const cwd = process.argv[2]!
const OWNER = `0x${"ab".repeat(20)}` as const
const NS = namespaceId("projects.current")
const network = {
  rpcUrl: "http://127.0.0.1:1",
  deployment: {
    chainId: 31337n,
    capabilityRegistry: `0x${"11".repeat(20)}`,
    contextRegistry: `0x${"22".repeat(20)}`,
    deploymentBlock: 0n,
  },
} as unknown as Network

const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sigint-home-")))
saveOwnerMode(home, "software")
saveOwnerAddress(home, OWNER)

// Enough records and payload that the staged write takes seconds — a real window for the signal.
const bigText = "P".repeat(128 * 1024)
const ciphertext = new Uint8Array([7, 7, 7, 7])
const records: SourceRecord[] = Array.from({ length: 800 }, (_, i) => {
  const contextId = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex
  const manifest = {
    v: 1,
    contextId,
    ciphertextHash: `0x${"aa".repeat(32)}`,
    ciphertextSize: ciphertext.length,
    payloadNonce: `0x${"bb".repeat(24)}`,
    cryptoVersion: "mida-crypto-v1",
    readEpoch: "1",
    epochDekWrap: {
      v: 1,
      contextId,
      namespaceId: NS,
      readEpoch: "1",
      ephemeralPublicKey: `0x${"cc".repeat(33)}`,
      nonce: `0x${"dd".repeat(24)}`,
      wrappedDek: `0x${"ee".repeat(48)}`,
    },
  } as unknown as ObjectManifest
  return {
    contextId,
    namespaceId: NS,
    namespace: "projects.current",
    authorId: OWNER_AUTHOR_ID,
    recordType: 0,
    kind: 1,
    provenanceSource: 1,
    lineagePolicy: 0,
    lineageId: contextId,
    parentId: zeroHash,
    version: 1,
    readEpoch: 1n,
    createdAt: 1_700_000_000n,
    expiresAt: 0n,
    manifestHash: keccak256(canonicalBytes(manifest)),
    payload: { v: 1, value: { text: `PLAINTEXT-${i}-${bigText}` } } as never,
    references: [],
    lane: "direct",
    encrypted: { manifest, ciphertext },
  }
})

const runtime = {
  home,
  network,
  owner: OWNER,
  apiBaseUrl: "http://store.test",
  chain: {
    publicClient: {
      getBlockNumber: async () => 1n,
      getBlock: async () => ({ timestamp: 1n }),
    },
    deployment: network.deployment,
  },
  close: async () => {},
} as unknown as Runtime

await exportRecords({
  home,
  network,
  folder: join(cwd, "backup"),
  print: (line) => process.stdout.write(`${line}\n`),
  openRuntime: async () => runtime,
  readUniverse: async () => records,
})
