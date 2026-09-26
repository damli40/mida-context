// Brief ex-1: `mida export <folder>` — the unit side. Every refusal in Part 2 of the brief is
// exercised here against temp homes and a hand-built runtime (no chain): the destination gates,
// the owner-mode gates, the staged-write cleanup, the queued-saves count, the 0700/0600 modes,
// and the proof that no agent path — the daemon's /cli route, the MCP tool list, the hook entry
// point — can reach an export. The real-chain end to end lives in export.e2e.test.ts.

import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { HttpRequestError, keccak256, zeroHash } from "viem"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CONTEXT_KIND, OWNER_AUTHOR_ID, PROVENANCE_SOURCE, canonicalBytes, namespaceId } from "@mida/protocol"
import type { Hex, ObjectManifest } from "@mida/protocol"
import { deriveEpochKeyPair, hexOf, sealContextObject } from "@mida/crypto"
import {
  CLI_COMMANDS,
  MCP_TOOLS,
  MidaHome,
  createMidaMcpServer,
  NEEDS_TERMINAL_LINE,
  OWNER_COMMANDS,
  USAGE,
  enqueue,
  exportRecords,
  ownerOnlyLine,
  ownerRefusalLine,
  peekJobs,
  runCli,
  runCliWithRuntime,
  readOwnerUniverse,
  runHook,
  saveOwnerAddress,
  saveOwnerMode,
  wrapCheckpoint,
} from "@mida/midad"
import type { ExportEntry, MigrationEnvelope, Network, Runtime, SourceRecord } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const OWNER = `0x${"ab".repeat(20)}` as const
const NS_PROJECTS = namespaceId("projects.current")

const network: Network = {
  rpcUrl: "http://localhost:1",
  deployment: {
    chainId: 31337n,
    capabilityRegistry: `0x${"11".repeat(20)}`,
    contextRegistry: `0x${"22".repeat(20)}`,
    deploymentBlock: 0n,
    policyHashV1: `0x${"33".repeat(32)}`,
    vaultRpId: "test",
    vaultRpIdHash: `0x${"44".repeat(32)}`,
  },
} as Network

const tempHome = (): MidaHome => new MidaHome(mkdtempSync(join(tmpdir(), "mida-export-")))
const tempDir = (): string => mkdtempSync(join(tmpdir(), "mida-export-cwd-"))

/** A software-owner home — owner-mode marker, address and key — so the owner gates pass. */
function ownerHome(): MidaHome {
  const home = tempHome()
  saveOwnerMode(home, "software")
  saveOwnerAddress(home, OWNER)
  home.writeSecretJson("owner/secrets.json", {
    privateKey: `0x${"11".repeat(32)}`,
    seed: `0x${"22".repeat(32)}`,
    p256PrivateKey: `0x${"33".repeat(32)}`,
  })
  return home
}

/** The runtime stand-in: everything export touches, nothing else. `closed` proves close() ran. */
function fakeRuntime(home: MidaHome, closed: { n: number } = { n: 0 }): Runtime {
  return {
    home,
    network,
    owner: OWNER,
    // The real runtime holds the owner's key material in memory (the vault carries the seed and
    // the passkey-shaped key) — the fake carries the same file's contents so a leak of anything
    // the runtime holds is inside the no-secret scan's reach.
    secrets: home.readJson("owner/secrets.json"),
    apiBaseUrl: "http://store.test",
    chain: {
      publicClient: {
        getBlockNumber: async () => 42n,
        getBlock: async () => ({ timestamp: 1_700_000_000n }),
      },
      deployment: network.deployment,
    },
    close: async () => {
      closed.n += 1
    },
  } as unknown as Runtime
}

let seq = 0
const nextId = (): Hex => `0x${(++seq).toString(16).padStart(64, "0")}` as Hex

function fakeManifest(contextId: Hex): ObjectManifest {
  return {
    v: 1,
    contextId,
    ciphertextHash: `0x${"aa".repeat(32)}` as Hex,
    ciphertextSize: 4,
    payloadNonce: `0x${"bb".repeat(24)}` as Hex,
    cryptoVersion: "mida-crypto-v1",
    readEpoch: "1",
    epochDekWrap: {
      v: 1,
      contextId,
      namespaceId: NS_PROJECTS,
      readEpoch: "1",
      ephemeralPublicKey: `0x${"cc".repeat(33)}` as Hex,
      nonce: `0x${"dd".repeat(24)}` as Hex,
      wrappedDek: `0x${"ee".repeat(48)}` as Hex,
    },
  }
}

/** A complete, self-consistent record as keepEncrypted owner-read would return it. */
function fixtureRecord(over: Partial<SourceRecord> = {}): SourceRecord {
  const contextId = over.contextId ?? nextId()
  const manifest = fakeManifest(contextId)
  return {
    contextId,
    namespaceId: NS_PROJECTS,
    namespace: "projects.current",
    authorId: OWNER_AUTHOR_ID,
    recordType: 0,
    kind: 1,
    provenanceSource: 1,
    lineagePolicy: 0,
    lineageId: over.lineageId ?? contextId,
    parentId: zeroHash,
    version: 1,
    readEpoch: 1n,
    createdAt: 1_700_000_000n,
    expiresAt: 0n,
    manifestHash: keccak256(canonicalBytes(manifest)),
    payload: { v: 1, value: { text: `secret text for ${contextId}` }, kind: "FACT", provenance: { source: "USER_ASSERTED" } },
    references: [],
    lane: "direct",
    ...over,
    encrypted: over.encrypted ?? { manifest, ciphertext: new Uint8Array([1, 2, 3, 4]) },
  }
}

const collect = (): { lines: string[]; print: (line: string) => void } => {
  const lines: string[] = []
  return { lines, print: (line) => lines.push(line) }
}

const run = (argv: string[], home: MidaHome, cwd: string, lines: string[]) =>
  runCli(argv, {
    home,
    network,
    cwd,
    print: (line) => lines.push(line),
    prompt: async () => "yes",
    stdinIsTTY: true,
    stdoutIsTTY: true,
  })

describe("mida export — dispatch and refusals", () => {
  it("the help lists export <folder> and the command tables carry it", () => {
    expect(USAGE).toContain("export <folder>")
    expect(CLI_COMMANDS).toContain("export")
    expect(OWNER_COMMANDS).toContain("export")
  })

  it("no folder is usage; extra args are usage", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const lines: string[] = []
    expect(await run(["export"], home, cwd, lines)).toBe(2)
    expect(lines).toEqual([USAGE])
    lines.length = 0
    expect(await run(["export", "a", "b"], home, cwd, lines)).toBe(2)
    expect(lines).toEqual([USAGE])
  })

  it("--as <agent> is refused: agents never export", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const lines: string[] = []
    expect(await run(["export", "--as", "codex"], home, cwd, lines)).toBe(1)
    expect(lines).toEqual(["export is the owner's own command — agents never export"])
  })

  it("needs a real terminal, like the other owner commands", async () => {
    const home = ownerHome()
    const lines: string[] = []
    const code = await runCli(["export", join(tempDir(), "out")], {
      home,
      network,
      print: (line) => lines.push(line),
      stdinIsTTY: false,
      stdoutIsTTY: true,
    })
    expect(code).toBe(2)
    expect(lines).toEqual([NEEDS_TERMINAL_LINE])
  })

  it("a home with no owner refuses before any secrets file could be created", async () => {
    const home = tempHome()
    const cwd = tempDir()
    const lines: string[] = []
    expect(await run(["export", "backup"], home, cwd, lines)).toBe(1)
    expect(lines).toEqual(["this home has no owner yet — run `mida init` first"])
    expect(home.has("owner/secrets.json")).toBe(false)
    expect(existsSync(join(cwd, "backup"))).toBe(false)
  })

  it("a passkey home refuses with the migrate-style wording, and creates no secrets file", async () => {
    const home = tempHome()
    saveOwnerMode(home, "passkey")
    const cwd = tempDir()
    const lines: string[] = []
    expect(await run(["export", "backup"], home, cwd, lines)).toBe(1)
    expect(lines).toEqual(["export supports software-key setups only in this version"])
    expect(home.has("owner/secrets.json")).toBe(false)
    expect(existsSync(join(cwd, "backup"))).toBe(false)
  })

  it("an owner address with no owner key refuses — export never mints one", async () => {
    // ex-2 X-8a: a software home whose owner-address.json exists but owner/secrets.json does
    // not must refuse — the runtime open must not mint a fresh key into the home.
    const home = tempHome()
    saveOwnerMode(home, "software")
    saveOwnerAddress(home, OWNER)
    const cwd = tempDir()
    const lines: string[] = []
    let opens = 0
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup"),
      cwd,
      print: (line) => lines.push(line),
      openRuntime: async () => {
        opens += 1
        return fakeRuntime(home)
      },
    })
    expect(result).toEqual({ outcome: "refused", code: "no-owner-key" })
    expect(lines).toEqual(["no owner key on this machine — export needs the local software owner key"])
    // the refusal came before the runtime open, and nothing was minted
    expect(opens).toBe(0)
    expect(home.has("owner/secrets.json")).toBe(false)
  })

  it("an existing destination refuses — an empty dir, a file, and even a dangling symlink", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const dirDest = join(cwd, "taken")
    mkdirSync(dirDest)
    const fileDest = join(cwd, "file")
    writeFileSync(fileDest, "x")
    const linkDest = join(cwd, "link")
    symlinkSync(join(cwd, "nowhere"), linkDest)
    for (const dest of [dirDest, fileDest, linkDest]) {
      const lines: string[] = []
      expect(await run(["export", dest], home, cwd, lines)).toBe(1)
      expect(lines).toEqual([`the folder ${dest} already exists — export will not overwrite it`])
    }
    expect(readdirSync(dirDest)).toEqual([])
  })

  it("a destination inside the Mida home refuses — including through a symlinked ancestor", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const lines: string[] = []
    expect(await run(["export", join(home.root, "backup")], home, cwd, lines)).toBe(1)
    expect(lines[0]).toContain("inside the Mida home")
    // a lexical path outside the home that resolves inside it is the same refusal
    const link = join(cwd, "homelink")
    symlinkSync(home.root, link)
    lines.length = 0
    expect(await run(["export", join(link, "backup")], home, cwd, lines)).toBe(1)
    expect(lines[0]).toContain("inside the Mida home")
  })

  it("a missing parent folder refuses rather than silently creating one", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const lines: string[] = []
    const dest = join(cwd, "no-such-parent", "backup")
    expect(await run(["export", dest], home, cwd, lines)).toBe(1)
    expect(lines).toEqual([`the folder's parent does not exist: ${join(cwd, "no-such-parent")}`])
  })

  it("owner-read-incomplete prints through ownerRefusalLine naming the contextIds", () => {
    const id = `0x${"ab".repeat(32)}`
    const error = Object.assign(
      new Error(`owner-read-incomplete: 1 record(s) could not be read back completely: ${id} (object-list-unavailable)`),
      { code: "owner-read-incomplete", contextIds: [id], reasons: ["object-list-unavailable"] },
    )
    // the cli catch routes thrown errors through ownerRefusalLine — the line names every
    // contextId the read could not certify, never the deeper layer's own message
    const line = ownerRefusalLine("export", "", error)
    expect(line).toContain(id)
    expect(line).toContain("object-list-unavailable")
  })

  it("owner-read-incomplete prints the first ten contextIds then a count of the rest", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`)
    const error = Object.assign(new Error("owner-read-incomplete"), {
      code: "owner-read-incomplete",
      contextIds: ids,
      reasons: ["read-back-failed"],
    })
    const line = ownerRefusalLine("export", "", error)
    expect(line).toContain(ids[0]!)
    expect(line).toContain(ids[9]!)
    expect(line).not.toContain(ids[10]!)
    expect(line).toContain("and 2 more")
  })

  it("a 429 on a chain read reports chain-busy — never the RPC URL or the key in its path", async () => {
    // The provider-key-in-URL-path shape (Alchemy/QuickNode): viem strips user:password only.
    const contextId = `0x${"0f".repeat(32)}` as Hex
    const manifest = fakeManifest(contextId)
    const runtime = {
      owner: OWNER,
      ownerStartBlock: 0n,
      network,
      ownerChain: {
        publicClient: {
          getBlockNumber: async () => 10n,
          getLogs: async () => [{ args: { contextId, record: { namespaceId: NS_PROJECTS } }, blockNumber: 1n }],
        },
      },
      ownerApi: {
        listObjects: async () => ({
          objects: [{ contextId, manifestHash: keccak256(canonicalBytes(manifest)), manifest, ciphertext: "0x01020304" }],
          partial: false,
        }),
      },
      vault: { deriveNamespaceSecret: async () => new Uint8Array(32) },
      reader: {
        getRecord: async () => {
          throw new HttpRequestError({
            url: "https://monad-testnet.example-rpc.io/v2/SECRET-RPC-KEY-123",
            status: 429,
            body: { method: "eth_call" },
            details: "Too Many Requests",
          })
        },
      },
    } as unknown as Runtime
    const thrown = await readOwnerUniverse(runtime, { keepEncrypted: true }).catch((error: unknown) => error)
    expect(thrown).toBeDefined()
    const line = ownerRefusalLine("export", "", thrown, undefined, network.deployment.capabilityRegistry)
    expect(line).toContain("busy")
    expect(line).not.toContain("SECRET-RPC-KEY-123")
    expect(line).not.toContain("http")
  })

  it("a chain record whose store object is missing names the contextId — and no deeper message", async () => {
    const contextId = `0x${"0e".repeat(32)}` as Hex
    const runtime = {
      owner: OWNER,
      ownerStartBlock: 0n,
      network,
      ownerChain: {
        publicClient: {
          getBlockNumber: async () => 10n,
          getLogs: async () => [{ args: { contextId, record: { namespaceId: NS_PROJECTS } }, blockNumber: 1n }],
        },
      },
      ownerApi: { listObjects: async () => ({ objects: [], partial: false }) },
      vault: { deriveNamespaceSecret: async () => new Uint8Array(32) },
      reader: { getRecord: async () => null },
    } as unknown as Runtime
    const thrown = await readOwnerUniverse(runtime, { keepEncrypted: true }).catch((error: unknown) => error)
    expect((thrown as { code?: string }).code).toBe("owner-read-incomplete")
    const line = ownerRefusalLine("export", "", thrown, undefined, network.deployment.capabilityRegistry)
    expect(line).toContain(contextId)
    expect(line).toContain("no object in the store")
    // no wrapped error text — just the ids and the read's own reason codes
    expect(line).not.toContain("Error")
  })

  it("a store row registered after the export block is newer than the read — excluded and counted, never refused", async () => {
    // ex-3 E-4: the bounded scan stops at the export block (42). A save whose ContextRegistered
    // log landed at 45 — after the bound but before the store list was read — is found by the
    // after-head scan: excluded and counted, not reported inconsistent. A row with no
    // registration anywhere still refuses.
    const SECRET = new Uint8Array(32).fill(7)
    const readEpoch = 1n
    const oldId = `0x${"0a".repeat(32)}` as Hex
    const lateId = `0x${"0b".repeat(32)}` as Hex
    const sealed = sealContextObject({
      payload: { v: 1, value: { text: "the record the bound knows" }, kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } },
      binding: {
        chainId: network.deployment.chainId,
        contextRegistry: network.deployment.contextRegistry,
        contextId: oldId,
        namespaceId: NS_PROJECTS,
        readEpoch,
      },
      epochPublicKey: deriveEpochKeyPair(SECRET, readEpoch).publicKey,
    })
    const chainRow = {
      owner: OWNER,
      namespaceId: NS_PROJECTS,
      manifestHash: sealed.manifestHash,
      author: OWNER_AUTHOR_ID,
      recordType: 0,
      kind: CONTEXT_KIND.EPISODE,
      provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
      lineagePolicy: 0,
      lineageId: oldId,
      parentId: zeroHash,
      version: 1,
      readEpoch: 1n,
      createdAt: 100n,
      expiresAt: 0n,
    }
    const fake = (lateRegistered: boolean): Runtime =>
      ({
        owner: OWNER,
        ownerStartBlock: 0n,
        network,
        ownerChain: {
          publicClient: {
            getBlockNumber: async () => 50n,
            getLogs: async ({ event, fromBlock }: { event: { name: string }; fromBlock: bigint }) => {
              if (event.name !== "ContextRegistered") return []
              // The after-head scan asks from the bound upward — the late save's log answers there.
              if (fromBlock > 42n) {
                return lateRegistered ? [{ args: { contextId: lateId }, blockNumber: 45n, logIndex: 0 }] : []
              }
              return [{ args: { contextId: oldId, record: { namespaceId: NS_PROJECTS } }, blockNumber: 10n, logIndex: 0 }]
            },
          },
        },
        ownerApi: {
          listObjects: async () => ({
            objects: [
              { contextId: oldId, manifestHash: sealed.manifestHash, manifest: sealed.manifest, ciphertext: hexOf(sealed.ciphertext) },
              { contextId: lateId, manifestHash: zeroHash, manifest: {}, ciphertext: "0x" },
            ],
            partial: false,
          }),
        },
        vault: { deriveNamespaceSecret: async () => SECRET },
        reader: { getRecord: async (id: Hex) => (id === oldId ? chainRow : null) },
      }) as unknown as Runtime

    const afterHead = new Set<Hex>()
    const records = await readOwnerUniverse(fake(true), { keepEncrypted: true, toBlock: 42n, afterHead })
    expect(records.map((record) => record.contextId)).toEqual([oldId])
    expect([...afterHead]).toEqual([lateId])
    expect(records[0]!.payload.value).toEqual({ text: "the record the bound knows" })

    // …and the same store row with NO registration at or before the head — and none after —
    // is still the inconsistency it always was.
    const missing = await readOwnerUniverse(fake(false), { keepEncrypted: true, toBlock: 42n }).catch((error: unknown) => error)
    expect(missing).toMatchObject({ code: "owner-read-incomplete", contextIds: [lateId] })
  })

  it("owner-read-incomplete through exportRecords throws naming the contextIds and leaves nothing", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const dest = join(cwd, "backup")
    const error = Object.assign(
      new Error(`owner-read-incomplete: 1 record(s) could not be read back completely: ${"0x".padEnd(66, "ab")} (the store's object list could not be served)`),
      { code: "owner-read-incomplete" },
    )
    await expect(
      exportRecords({
        home,
        network,
        folder: dest,
        cwd,
        print: () => {},
        openRuntime: async () => fakeRuntime(home),
        readUniverse: async () => {
          throw error
        },
      }),
    ).rejects.toThrow(/owner-read-incomplete/)
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(cwd)).toEqual([])
  })

  it("a mid-export failure deletes the staged folder — at staging and after files exist", async () => {
    for (const stopAfter of ["staged", "files"] as const) {
      const home = ownerHome()
      const cwd = tempDir()
      const dest = join(cwd, `backup-${stopAfter}`)
      const closed = { n: 0 }
      await expect(
        exportRecords({
          home,
          network,
          folder: dest,
          cwd,
          print: () => {},
          openRuntime: async () => fakeRuntime(home, closed),
          readUniverse: async () => [fixtureRecord()],
          stopAfter,
        }),
      ).rejects.toThrow(/the export stopped/)
      expect(existsSync(dest)).toBe(false)
      // no .partial-* sibling left behind — it held plaintext
      expect(readdirSync(cwd).filter((name) => name.includes(".partial-"))).toEqual([])
      // and the runtime was still closed
      expect(closed.n).toBe(1)
    }
  })

  it("a lineage with two children on one parent refuses — naming the lineage and both records", async () => {
    // ex-2 X-9: `export-inconsistent` must say WHICH lineage and WHICH two records disagree —
    // a refusal that names nothing cannot be investigated.
    const parent = fixtureRecord()
    const childA = fixtureRecord({ lineageId: parent.lineageId, parentId: parent.contextId, version: 2 })
    const childB = fixtureRecord({ lineageId: parent.lineageId, parentId: parent.contextId, version: 3 })
    const home = ownerHome()
    const cwd = tempDir()
    const dest = join(cwd, "backup")
    const thrown = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print: () => {},
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [parent, childA, childB],
    }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as { code?: unknown }).code).toBe("export-inconsistent")
    const message = (thrown as Error).message
    expect(message).toContain(parent.lineageId)
    expect(message).toContain(childA.contextId)
    expect(message).toContain(childB.contextId)
    expect(existsSync(dest)).toBe(false)
    // ex-3 E-2: the line the CLI prints — not error.message — is the contract. It names the
    // lineage and both records in short form, says this should be impossible on Monad, and
    // asks the owner to report it.
    const line = ownerRefusalLine("export", "", thrown, undefined, network.deployment.capabilityRegistry)
    const shortOf = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`
    expect(line).toContain(shortOf(parent.lineageId))
    expect(line).toContain(shortOf(childA.contextId))
    expect(line).toContain(shortOf(childB.contextId))
    expect(line).not.toContain(childA.contextId)
    expect(line).toContain("impossible")
    expect(line).toContain("report")
    expect(line).not.toContain("export-inconsistent")
  })

  it("the universe is scanned only up to the block the export names — the head is read first", async () => {
    // ex-2 X-9: the README's "export block" must bound the scan. fakeRuntime's chain answers 42 —
    // the read must receive exactly that as toBlock, not whatever head the chain has moved to.
    const home = ownerHome()
    const cwd = tempDir()
    const dest = join(cwd, "backup")
    let seenToBlock = -1n
    const result = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print: () => {},
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async (_rt, _progress, toBlock) => {
        seenToBlock = toBlock
        return [fixtureRecord()]
      },
    })
    expect(result.outcome).toBe("exported")
    expect(seenToBlock).toBe(42n)
    expect(readFileSync(join(dest, "README.md"), "utf8")).toContain("export block: 42")
  })

  it("a save that landed after the export started is excluded from the folder, counted, and announced", async () => {
    // ex-3 E-4: the read reports a store row whose registration came after the export block
    // through `afterHead` — the export leaves it out of the folder and says so in the README
    // and the printed summary, with the honest next step.
    const home = ownerHome()
    const cwd = tempDir()
    const dest = join(cwd, "backup")
    const lateId = `0x${"0b".repeat(32)}` as Hex
    const lines: string[] = []
    const result = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print: (line) => lines.push(line),
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async (_runtime, _progress, _toBlock, afterHead) => {
        afterHead.add(lateId)
        return [fixtureRecord()]
      },
    })
    expect(result).toMatchObject({ outcome: "exported", records: 1, landedAfter: 1 })
    expect(lines).toContain("1 save landed after the export started; run export again to include them")
    const readme = readFileSync(join(dest, "README.md"), "utf8")
    expect(readme).toContain("Saves that landed after the export began: 1")
    const entries = JSON.parse(readFileSync(join(dest, "records.json"), "utf8")) as { contextId: string }[]
    expect(entries.map((entry) => entry.contextId)).not.toContain(lateId)
  })

  it("a parent that refuses the post-rename fsync still reports success — one warning, complete folder", async () => {
    // The export succeeded the moment the rename landed. A filesystem that refuses to open
    // the parent directory for fsync (here mode 0300: writable and enterable, not readable)
    // must not print a refusal over a finished folder — ex-2 X-2.
    const home = ownerHome()
    const cwd = tempDir()
    const parent = join(cwd, "locked-parent")
    mkdirSync(parent)
    const dest = join(parent, "backup")
    chmodSync(parent, 0o300)
    const lines: string[] = []
    try {
      const result = await exportRecords({
        home,
        network,
        folder: dest,
        cwd,
        print: (line) => lines.push(line),
        openRuntime: async () => fakeRuntime(home),
        readUniverse: async () => [fixtureRecord()],
      })
      expect(result).toMatchObject({ outcome: "exported", records: 1 })
      expect(existsSync(join(dest, "records.json"))).toBe(true)
      expect(lines[0]).toBe(`Exported 1 record (1 namespace) to ${dest}.`)
      expect(lines.every((line) => !line.startsWith("refused"))).toBe(true)
      const warnings = lines.filter((line) => line.startsWith("warning:"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("directory")
    } finally {
      chmodSync(parent, 0o700)
    }
  })

  it("a destination that appears mid-export refuses and the staged folder is cleaned", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    const dest = join(cwd, "backup")
    let appears = false
    await expect(
      exportRecords({
        home,
        network,
        folder: dest,
        cwd,
        print: () => {},
        openRuntime: async () => fakeRuntime(home),
        readUniverse: async () => {
          mkdirSync(dest) // another process claims the name mid-export
          appears = true
          return [fixtureRecord()]
        },
      }),
    ).rejects.toThrow(/appeared while the export was running/)
    expect(appears).toBe(true)
    expect(readdirSync(cwd).filter((name) => name.includes(".partial-"))).toEqual([])
  })
})

describe("mida export — the written folder", () => {
  const exportWith = async (records: SourceRecord[], opts: { queue?: number } = {}) => {
    const home = ownerHome()
    const cwd = tempDir()
    for (let i = 0; i < (opts.queue ?? 0); i += 1) {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: `s${i}`, transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    }
    const { lines, print } = collect()
    const dest = join(cwd, "backup")
    const result = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => records,
    })
    return { home, cwd, dest, lines, result }
  }

  it("writes records.json, records.md, encrypted/ and README.md — dir 0700, files 0600", async () => {
    const records = [fixtureRecord(), fixtureRecord()]
    const { dest, result, lines } = await exportWith(records)
    expect(result).toMatchObject({ outcome: "exported", records: 2, namespaces: 1, queued: 0 })
    expect(lines[0]).toBe(`Exported 2 records (1 namespace) to ${dest}.`)
    expect(lines).toHaveLength(1) // no queued line when the count is 0
    expect(statSync(dest).mode & 0o777).toBe(0o700)
    expect(statSync(join(dest, "encrypted")).mode & 0o777).toBe(0o700)
    const names = readdirSync(dest).sort()
    expect(names).toEqual(["README.md", "encrypted", "records.json", "records.md"])
    for (const name of ["README.md", "records.json", "records.md"]) {
      expect(statSync(join(dest, name)).mode & 0o777).toBe(0o600)
    }
    const enc = readdirSync(join(dest, "encrypted")).sort()
    expect(enc).toHaveLength(4) // manifest + ciphertext per record, direct lane has no batched.json
    for (const name of enc) {
      expect(statSync(join(dest, "encrypted", name)).mode & 0o777).toBe(0o600)
    }
    // nothing plaintext is printed — only counts and the path
    expect(lines.join("\n")).not.toContain("secret text")
  })

  it("records.json carries the chain fields, names the owner 'you', and marks supersession", async () => {
    const v1 = fixtureRecord()
    const v2 = fixtureRecord({ lineageId: v1.lineageId, parentId: v1.contextId, version: 2, createdAt: 1_700_000_100n })
    const { dest } = await exportWith([v1, v2])
    const entries = JSON.parse(readFileSync(join(dest, "records.json"), "utf8")) as ExportEntry[]
    expect(entries).toHaveLength(2)
    const first = entries.find((e) => e.contextId === v1.contextId)!
    const second = entries.find((e) => e.contextId === v2.contextId)!
    expect(first.superseded).toBe(true)
    expect(first.supersededBy).toBe(v2.contextId)
    expect(second.superseded).toBe(false)
    expect(second.supersededBy).toBeNull()
    expect(first.author).toEqual({ id: OWNER_AUTHOR_ID, name: "you" })
    expect(first.recordType).toBe("CONTEXT")
    expect(first.kind).toBe("FACT")
    expect(first.source).toBe("USER_ASSERTED")
    expect(first.expiresAt).toBeNull()
    expect(first.expired).toBe(false)
    expect(first.readEpoch).toBe("1")
    expect(first.writtenAt).toBe("2023-11-14T22:13:20.000Z")
    expect(first.chainTime).toBe("2023-11-14T22:13:20.000Z")
    expect((first.payload as { value: { text: string } }).value.text).toContain("secret text")
  })

  it("two checkpoints saved by plain creates — only the chain-later one is newestCheckpoint", async () => {
    // ex-2 X-5: the real save path creates a NEW lineage per checkpoint, so "current" was
    // true on every one. newestCheckpoint is the merge's pick — the same ordering the
    // handoff uses (orderTime: the chain's stamp, never the writer's claim). The first
    // save claims a LATER createdAt on purpose: the claim must not win.
    const checkpoint = (eventId: string, sessionId: string, claimedAt: string) => ({
      v: 1 as const,
      value: { ...wrapCheckpoint({
        projectId: "proj-x",
        sessionId,
        continuesSession: null,
        compiledBy: "t",
        checkpoint: sampleCheckpoint({ eventId, createdAt: claimedAt }),
      }) } as Record<string, unknown>,
      kind: "EPISODE" as const,
      provenance: { source: "AGENT_INFERRED" as const },
    })
    const first = fixtureRecord({
      kind: 5,
      createdAt: 1_700_000_000n,
      payload: checkpoint("cp-unit-01", "s1", "2026-09-25T10:00:00.000Z"), // claims the later day — a lie
    })
    const second = fixtureRecord({
      kind: 5,
      createdAt: 1_700_000_100n,
      payload: checkpoint("cp-unit-02", "s2", "2026-09-20T10:00:00.000Z"), // claims the earlier day — honest
    })
    const { dest } = await exportWith([first, second])
    const entries = JSON.parse(readFileSync(join(dest, "records.json"), "utf8")) as ExportEntry[]
    const e1 = entries.find((e) => e.contextId === first.contextId)!
    const e2 = entries.find((e) => e.contextId === second.contextId)!
    expect(e1.newestCheckpoint).toBe(false)
    expect(e2.newestCheckpoint).toBe(true)
    // neither was superseded — plain creates link nothing
    expect(e1.superseded).toBe(false)
    expect(e2.superseded).toBe(false)
    // and a non-checkpoint record never carries the flag
    const { dest: dest2 } = await exportWith([fixtureRecord()])
    const fact = JSON.parse(readFileSync(join(dest2, "records.json"), "utf8")) as ExportEntry[]
    expect(fact[0]!.newestCheckpoint).toBe(false)
    // records.md uses the honest labels only — "current" must not appear as a flag
    // (the namespace is named projects.current, so match the flag separator, not the word)
    const md = readFileSync(join(dest, "records.md"), "utf8")
    expect(md).toContain("newest checkpoint")
    expect(md).not.toMatch(/· current/)
  })

  it("the encrypted files are the store's bytes — manifest hashes to manifestHash", async () => {
    const record = fixtureRecord()
    const { dest } = await exportWith([record])
    const id = record.contextId.toLowerCase()
    const manifestBytes = readFileSync(join(dest, "encrypted", `${id}.manifest.json`))
    expect(manifestBytes.equals(Buffer.from(canonicalBytes(record.encrypted!.manifest)))).toBe(true)
    expect(keccak256(manifestBytes)).toBe(record.manifestHash)
    const ciphertext = readFileSync(join(dest, "encrypted", `${id}.ciphertext`))
    expect(ciphertext.equals(Buffer.from(record.encrypted!.ciphertext))).toBe(true)
    // and a batched record also carries its store row
    const batched = fixtureRecord({
      lane: "batched",
      batchId: `0x${"99".repeat(32)}` as Hex,
    })
    batched.encrypted!.batchItem = {
      state: "ANCHORED",
      contextId: batched.contextId,
      receivedAt: "2023-11-14T22:00:00.000Z",
      batchId: `0x${"99".repeat(32)}` as Hex,
      position: 0,
      lineageId: batched.lineageId,
      version: 1,
      save: { message: {}, signature: "0x00", manifest: batched.encrypted!.manifest, ciphertext: "0x0102" },
    } as never
    const second = await exportWith([batched])
    const bId = batched.contextId.toLowerCase()
    expect(existsSync(join(second.dest, "encrypted", `${bId}.batched.json`))).toBe(true)
    const entry = (JSON.parse(readFileSync(join(second.dest, "records.json"), "utf8")) as ExportEntry[])[0]!
    expect(entry.lane).toBe("batched")
    expect(entry.batchId).toBe(`0x${"99".repeat(32)}`)
  })

  it("the queued-saves count is printed and lands in the README when > 0", async () => {
    const { dest, lines } = await exportWith([fixtureRecord()], { queue: 2 })
    expect(lines[1]).toBe("2 saves are still queued on this laptop and 0 batched saves are waiting for Monad; they are not in this export. Run export again after they land.")
    const readme = readFileSync(join(dest, "README.md"), "utf8")
    expect(readme).toContain("Saves still queued on this laptop: 2")
    expect(readme).toContain("ContextRegistry: " + network.deployment.contextRegistry)
    expect(readme).toContain("export block: 42")
    expect(readme).toContain("contains no Mida keys")
  })

  it("a batched save still waiting for Monad is counted separately from the hook queue", async () => {
    // ex-2 X-4: queue/ jobs and the store-accepted pending ledger are different waits —
    // the README and the summary name each count, never one hiding behind the other.
    const home = ownerHome()
    const cwd = tempDir()
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    home.writeSecretJson("state/batch-pending.json", {
      entries: [
        { contextId: nextId(), eventId: "e1", sessionId: "s1", agent: "claude-code", queuedAt: new Date(1_700_000_000_000).toISOString(), state: "QUEUED" },
        { contextId: nextId(), eventId: "e2", sessionId: "s1", agent: "claude-code", queuedAt: new Date(1_700_000_000_000).toISOString(), state: "HELD" },
      ],
    })
    const { lines, print } = collect()
    const dest = join(cwd, "backup")
    const result = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result).toMatchObject({ outcome: "exported", queued: 1, batchedPending: 2 })
    const readme = readFileSync(join(dest, "README.md"), "utf8")
    expect(readme).toContain("Saves still queued on this laptop: 1")
    expect(readme).toContain("Batched saves still waiting for Monad: 2")
    expect(lines).toContain(
      "1 save is still queued on this laptop and 2 batched saves are waiting for Monad; they are not in this export. Run export again after they land.",
    )
  })

  it("a batched-saves ledger that will not parse refuses — export cannot claim what is still waiting", async () => {
    // Fail closed, the way migrate does: an unreadable ledger means "unknown", and unknown
    // is never "0 batched saves waiting".
    const home = ownerHome()
    const cwd = tempDir()
    mkdirSync(join(home.root, "state"), { recursive: true })
    writeFileSync(join(home.root, "state", "batch-pending.json"), "not json")
    const { lines, print } = collect()
    const dest = join(cwd, "backup")
    const result = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("refused")
    expect(lines.some((line) => line.includes("batched"))).toBe(true)
    expect(existsSync(dest)).toBe(false)
  })

  it("a record carrying its migration envelope in both slots still exports — marked unreadable, never fatal", async () => {
    // ex-2 X-8b: readEnvelope throws invalid-migration-envelope on the contradictory shape,
    // which used to abort the whole export. The record leaves with its decrypted payload
    // as-is, envelope "unreadable", writtenAt = the chain stamp — and it is named in
    // records.json, records.md, the README and the printed summary.
    const migration = {
      version: 1,
      originalChainId: "143",
      originalContract: `0x${"55".repeat(20)}`,
      originalRecordId: `0x${"66".repeat(32)}`,
      originalCommitment: `0x${"77".repeat(32)}`,
      originalAuthor: `0x${"88".repeat(32)}`,
      originalCreatedAt: "2024-01-01T00:00:00.000Z",
      migratedAt: "2024-06-01T00:00:00.000Z",
    } as const as MigrationEnvelope
    const bad = fixtureRecord({
      payload: {
        v: 1,
        value: { text: "a moved fact", migration },
        kind: "FACT",
        provenance: { source: "USER_ASSERTED" },
        migration,
      },
    })
    const good = fixtureRecord()
    const { dest, lines, result } = await exportWith([bad, good])
    expect(result).toMatchObject({ outcome: "exported", records: 2 })
    const entries = JSON.parse(readFileSync(join(dest, "records.json"), "utf8")) as ExportEntry[]
    const entry = entries.find((e) => e.contextId === bad.contextId)!
    expect(entry.envelope).toBe("unreadable")
    expect(entry.writtenAt).toBe(entry.chainTime)
    expect((entry.payload as { value: { text: string } }).value.text).toBe("a moved fact")
    expect(entries.find((e) => e.contextId === good.contextId)!.envelope).toBeUndefined()
    const md = readFileSync(join(dest, "records.md"), "utf8")
    expect(md).toContain("migration envelope unreadable")
    const readme = readFileSync(join(dest, "README.md"), "utf8")
    expect(readme).toContain(bad.contextId)
    expect(readme).toContain("unreadable")
    expect(lines.some((line) => line.includes(bad.contextId))).toBe(true)
  })

  it("records.md groups by area, newest first, with author, flags and the plaintext warning", async () => {
    const old = fixtureRecord({ createdAt: 1_600_000_000n })
    const new_ = fixtureRecord({ createdAt: 1_700_000_000n })
    const { dest } = await exportWith([new_, old])
    const md = readFileSync(join(dest, "records.md"), "utf8")
    expect(md).toContain("contains no Mida keys")
    expect(md).toContain("## projects.current (2)")
    const firstAt = md.indexOf(new_.contextId)
    const secondAt = md.indexOf(old.contextId)
    expect(firstAt).toBeGreaterThan(-1)
    expect(firstAt).toBeLessThan(secondAt) // newest first
    expect(md).toContain("by you")
    expect(md).toContain("> secret text")
  })

  it("no file in the export carries any secret the home holds", async () => {
    // ex-2 X-9: the planted secrets are 0x7a…/0xff… — letters in the hex so the uppercase form is
    // distinct, and 0xff so base64url ('_') genuinely differs from base64 ('/'). fakeRuntime
    // loads the file, so the scan covers secrets the runtime under test really holds — a leak in
    // ANY encoding of ANY byte fails.
    const secrets = [`0x${"7a".repeat(32)}`, `0x${"ff".repeat(32)}`]
    const home = ownerHome()
    const cwd = tempDir()
    // drop secrets where the real home keeps them — the export must not touch them
    home.writeSecretJson("owner/secrets.json", { privateKey: secrets[0], seed: secrets[1], p256PrivateKey: secrets[0] })
    const dest = join(cwd, "backup")
    const result = await exportRecords({
      home,
      network,
      folder: dest,
      cwd,
      print: () => {},
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    const needles: Buffer[] = []
    for (const secret of secrets) {
      const raw = Buffer.from(secret.slice(2), "hex")
      needles.push(raw)                                                        // the raw key bytes
      needles.push(Buffer.from(secret.slice(2), "utf8"))                       // bare hex
      needles.push(Buffer.from(secret, "utf8"))                                // 0x-prefixed hex
      needles.push(Buffer.from(secret.slice(2).toUpperCase(), "utf8"))         // uppercase hex
      needles.push(Buffer.from(raw.toString("base64"), "utf8"))                // padded base64
      needles.push(Buffer.from(raw.toString("base64url"), "utf8"))             // base64url
      needles.push(Buffer.from(raw.toString("base64").replace(/=+$/, ""), "utf8")) // unpadded base64
    }
    const files = [join(dest, "README.md"), join(dest, "records.json"), join(dest, "records.md")]
    for (const name of readdirSync(join(dest, "encrypted"))) files.push(join(dest, "encrypted", name))
    for (const file of files) {
      const bytes = readFileSync(file)
      for (const needle of needles) {
        expect(bytes.includes(needle), `${file} contains key material`).toBe(false)
      }
    }
  })
})

describe("mida export — no agent path reaches it", () => {
  it("the MCP server lists no export tool and refuses an export-named call as unknown", async () => {
    // Both halves of the guard: nothing named export is advertised, and actually calling one is
    // the protocol's unknown-tool refusal — a server that added a handler would fail this.
    expect(MCP_TOOLS.map((tool) => tool.name).every((name) => !name.includes("export"))).toBe(true)
    const server = createMidaMcpServer({
      home: tempHome(),
      agent: "codex",
      project: tempDir(),
      sessionId: "s-export",
      daemonUp: false,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "export-probe", version: "0" })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      const listed = await client.listTools()
      expect(listed.tools.some((tool) => tool.name.includes("export"))).toBe(false)
      await expect(client.callTool({ name: "mida_export", arguments: {} })).rejects.toThrow(/unknown tool/)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("the daemon's /cli route refuses it as an owner command", async () => {
    const lines: string[] = []
    const stub = { home: tempHome() } as unknown as Parameters<typeof runCliWithRuntime>[1]
    const code = await runCliWithRuntime(["export", "/tmp/x"], stub, (line) => lines.push(line))
    expect(code).toBe(2)
    expect(lines).toEqual([ownerOnlyLine("export")])
  })

  it("the hook entry point cannot enqueue anything named export — an unknown event is ignored", async () => {
    const home = tempHome()
    const homeDir = tempDir()
    await runHook({
      agent: "claude-code",
      stdin: JSON.stringify({
        hook_event_name: "export",
        session_id: "s1",
        transcript_path: join(homeDir, ".claude", "projects", "p", "s1.jsonl"),
      }),
      home,
      env: {},
      homeDir,
      spawnDrainer: () => {},
    })
    expect(peekJobs(home)).toHaveLength(0)
    // The refusal is the specific one — "unknown event is ignored" — not silence: a hook that
    // enqueued on any event name would land a different outcome here (or a job above).
    const hookLog = readFileSync(home.path("logs/hook.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(hookLog.at(-1)).toMatchObject({ event: "export", outcome: "ignored", reason: "unknown-event" })
  })
})

describe("mida export — an interrupted or left-behind staging folder", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
  const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs")
  const childScript = join(dirname(fileURLToPath(import.meta.url)), "export-sigint-child.ts")

  it("a SIGINT mid-write deletes the staged folder and exits 130 — the real Ctrl-C path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mida-export-sigint-"))
    // A real child process, a real signal, the real exportRecords: an in-process test cannot
    // reproduce "the OS kills the process mid-write".
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, childScript, cwd],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = ""
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)))
    try {
      const deadline = Date.now() + 120_000
      let staged: string | undefined
      while (staged === undefined && Date.now() < deadline) {
        staged = readdirSync(cwd).find((name) => name.includes(".partial-"))
        if (staged === undefined) await new Promise((resolve) => setTimeout(resolve, 2))
      }
      expect(staged, `no staged folder appeared; child stderr: ${stderr.slice(0, 400)}`).toBeDefined()
      const stagedDir = staged!
      // Signal once the plaintext file itself exists — the instant Ctrl-C is most dangerous —
      // or well into the encrypted-file phase on a machine where that file never gets far.
      while (
        !existsSync(join(cwd, stagedDir, "records.json")) &&
        Date.now() < deadline &&
        !(existsSync(join(cwd, stagedDir, "encrypted")) && readdirSync(join(cwd, stagedDir, "encrypted")).length >= 1200)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      child.kill("SIGINT")
      const code = await exited
      expect(code).toBe(130)
      const left = readdirSync(cwd)
      expect(left.filter((name) => name.includes(".partial-"))).toEqual([])
      expect(left).not.toContain("backup")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 120_000)

  it("a leftover .partial-* folder with the staging marker is deleted and reported — kill -9 or a power cut", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    // What a killed export leaves: the JSON marker (written first) plus half-finished content.
    // pid 2**30 names no process on any supported platform — a dead writer.
    const leftover = join(cwd, "backup.partial-deadbeef1234")
    mkdirSync(join(leftover, "encrypted"), { recursive: true })
    writeFileSync(
      join(leftover, ".mida-export-staging"),
      JSON.stringify({ dest: join(cwd, "backup"), pid: 2 ** 30, startedAt: "2026-09-25T00:00:00.000Z" }),
    )
    writeFileSync(join(leftover, "records.json"), "{\"never-finished\":true}")
    const { lines, print } = collect()
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup"),
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    expect(existsSync(leftover)).toBe(false)
    expect(lines.some((line) => line.includes("backup.partial-deadbeef1234") && line.includes("leftover"))).toBe(true)
    expect(existsSync(join(cwd, "backup", "records.json"))).toBe(true)
  })

  it("a leftover from a DIFFERENT destination in the same parent is removed — the sweep covers the parent", async () => {
    // ex-3 E-3: a Ctrl-C'd `export backup` must not survive the next `export backup2` — the
    // sweep is over the parent's `.partial-*` folders, not just the same destination's.
    const home = ownerHome()
    const cwd = tempDir()
    const leftover = join(cwd, "backup.partial-deadbeef1234")
    mkdirSync(leftover)
    writeFileSync(
      join(leftover, ".mida-export-staging"),
      JSON.stringify({ dest: join(cwd, "backup"), pid: 2 ** 30, startedAt: "2026-09-25T00:00:00.000Z" }),
    )
    writeFileSync(join(leftover, "records.json"), "{\"never-finished\":true}")
    const { lines, print } = collect()
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup2"),
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    expect(existsSync(leftover)).toBe(false)
    expect(lines.some((line) => line.includes("backup.partial-deadbeef1234") && line.includes("leftover"))).toBe(true)
    expect(existsSync(join(cwd, "backup2", "records.json"))).toBe(true)
  })

  it("a symlinked .partial-* is never followed or removed — the folder it points at is untouched", async () => {
    // lstat, not stat: a symlink that LOOKS like staging — even one whose target carries a
    // marker — must not have its target deleted, and nothing may be reported.
    const home = ownerHome()
    const cwd = tempDir()
    const victim = join(cwd, "victim")
    mkdirSync(victim)
    writeFileSync(
      join(victim, ".mida-export-staging"),
      JSON.stringify({ dest: join(cwd, "backup"), pid: 2 ** 30, startedAt: "2026-09-25T00:00:00.000Z" }),
    )
    writeFileSync(join(victim, "keep.txt"), "important")
    symlinkSync(victim, join(cwd, "backup.partial-cafebabe0000"))
    const { lines, print } = collect()
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup"),
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("important")
    expect(lstatSync(join(cwd, "backup.partial-cafebabe0000")).isSymbolicLink()).toBe(true)
    expect(lines.every((line) => !line.includes("partial"))).toBe(true)
  })

  it("a .partial-* whose marker names a LIVE pid is left alone — another export is writing it", async () => {
    // Concurrency: the sweep must never delete a folder whose writer is still running —
    // named for THIS export's destination so the old sweep would have removed it outright.
    // process.pid is the only live pid this test can rely on.
    const home = ownerHome()
    const cwd = tempDir()
    const live = join(cwd, "backup2.partial-0ffee0ffee00")
    mkdirSync(live)
    writeFileSync(
      join(live, ".mida-export-staging"),
      JSON.stringify({ dest: join(cwd, "backup"), pid: process.pid, startedAt: new Date().toISOString() }),
    )
    const { lines, print } = collect()
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup2"),
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    expect(existsSync(join(live, ".mida-export-staging"))).toBe(true)
    expect(lines.every((line) => !line.includes("leftover"))).toBe(true)
  })

  it("a .partial-* whose marker is not the JSON shape is left alone — and nothing is reported", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    for (const content of ["staged\n", "{not json", JSON.stringify({ pid: "oops" }), JSON.stringify({ dest: "/x", pid: -1 })]) {
      const leftover = join(cwd, `backup.partial-${Math.random().toString(16).slice(2, 14).padStart(12, "0")}`)
      mkdirSync(leftover)
      writeFileSync(join(leftover, ".mida-export-staging"), content)
    }
    const { lines, print } = collect()
    const before = readdirSync(cwd).filter((name) => name.includes(".partial-")).length
    expect(before).toBe(4)
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup"),
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    expect(readdirSync(cwd).filter((name) => name.includes(".partial-"))).toHaveLength(4)
    expect(lines.every((line) => !line.includes("leftover"))).toBe(true)
  })

  it("a look-alike .partial-* folder WITHOUT the staging marker is left alone", async () => {
    const home = ownerHome()
    const cwd = tempDir()
    // Same name shape, never ours: no marker file means export must not delete it.
    const lookalike = join(cwd, "backup.partial-cafebabe")
    mkdirSync(lookalike)
    writeFileSync(join(lookalike, "notes.txt"), "somebody else's folder")
    const { print } = collect()
    const result = await exportRecords({
      home,
      network,
      folder: join(cwd, "backup"),
      cwd,
      print,
      openRuntime: async () => fakeRuntime(home),
      readUniverse: async () => [fixtureRecord()],
    })
    expect(result.outcome).toBe("exported")
    expect(readFileSync(join(lookalike, "notes.txt"), "utf8")).toBe("somebody else's folder")
  })
})
