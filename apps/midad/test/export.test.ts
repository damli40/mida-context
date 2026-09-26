// Brief ex-1: `mida export <folder>` — the unit side. Every refusal in Part 2 of the brief is
// exercised here against temp homes and a hand-built runtime (no chain): the destination gates,
// the owner-mode gates, the staged-write cleanup, the queued-saves count, the 0700/0600 modes,
// and the proof that no agent path — the daemon's /cli route, the MCP tool list, the hook entry
// point — can reach an export. The real-chain end to end lives in export.e2e.test.ts.

import { describe, expect, it } from "vitest"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keccak256, zeroHash } from "viem"
import { OWNER_AUTHOR_ID, canonicalBytes, namespaceId } from "@mida/protocol"
import type { Hex, ObjectManifest } from "@mida/protocol"
import {
  CLI_COMMANDS,
  MCP_TOOLS,
  MidaHome,
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
  runHook,
  saveOwnerAddress,
  saveOwnerMode,
} from "@mida/midad"
import type { ExportEntry, Network, Runtime, SourceRecord } from "@mida/midad"

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

/** A software-owner home — owner-mode marker plus address — so the owner gates pass. */
function ownerHome(): MidaHome {
  const home = tempHome()
  saveOwnerMode(home, "software")
  saveOwnerAddress(home, OWNER)
  return home
}

/** The runtime stand-in: everything export touches, nothing else. `closed` proves close() ran. */
function fakeRuntime(home: MidaHome, closed: { n: number } = { n: 0 }): Runtime {
  return {
    home,
    network,
    owner: OWNER,
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
      new Error(`owner-read-incomplete: 1 record(s) could not be read back completely: ${id} (the store's object list could not be served)`),
      { code: "owner-read-incomplete" },
    )
    // the cli catch routes thrown errors through ownerRefusalLine — the line is the message,
    // which names every contextId the read could not certify
    expect(ownerRefusalLine("export", "", error)).toContain(id)
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
    expect(first.current).toBe(false)
    expect(first.supersededBy).toBe(v2.contextId)
    expect(second.current).toBe(true)
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
    expect(lines[1]).toBe("2 saves still queued on this laptop are not in the export — they have not reached Monad yet")
    const readme = readFileSync(join(dest, "README.md"), "utf8")
    expect(readme).toContain("Saves still queued on this laptop: 2")
    expect(readme).toContain("ContextRegistry: " + network.deployment.contextRegistry)
    expect(readme).toContain("export block: 42")
    expect(readme).toContain("contains no keys")
  })

  it("records.md groups by area, newest first, with author, flags and the plaintext warning", async () => {
    const old = fixtureRecord({ createdAt: 1_600_000_000n })
    const new_ = fixtureRecord({ createdAt: 1_700_000_000n })
    const { dest } = await exportWith([new_, old])
    const md = readFileSync(join(dest, "records.md"), "utf8")
    expect(md).toContain("contains no keys")
    expect(md).toContain("## projects.current (2)")
    const firstAt = md.indexOf(new_.contextId)
    const secondAt = md.indexOf(old.contextId)
    expect(firstAt).toBeGreaterThan(-1)
    expect(firstAt).toBeLessThan(secondAt) // newest first
    expect(md).toContain("by you")
    expect(md).toContain("> secret text")
  })

  it("no file in the export carries any secret the home holds", async () => {
    const secrets = [`0x${"77".repeat(32)}`, `0x${"88".repeat(64)}`]
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
    const files = [join(dest, "README.md"), join(dest, "records.json"), join(dest, "records.md")]
    for (const name of readdirSync(join(dest, "encrypted"))) files.push(join(dest, "encrypted", name))
    for (const file of files) {
      const bytes = readFileSync(file)
      for (const secret of secrets) {
        expect(bytes.includes(secret.slice(2))).toBe(false)
        expect(bytes.includes(Buffer.from(secret.slice(2), "hex").toString("base64"))).toBe(false)
      }
    }
  })
})

describe("mida export — no agent path reaches it", () => {
  it("the MCP tool list has no export tool", () => {
    expect(MCP_TOOLS.map((tool) => tool.name).every((name) => !name.includes("export"))).toBe(true)
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
  })
})
