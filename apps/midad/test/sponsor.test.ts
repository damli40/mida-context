// in-29 S-3: `mida sponsor on|off` — the owner switch between the hosted gas sponsor and
// self-paid gas. A network.json written before the sponsor existed carries no sponsorUrl: `on`
// splices one in, `off` removes it — every other byte survives either way. The change cannot be
// a `/kick`: the sponsor address is loaded into the send path when the service opens, so the
// command restarts the service instead. Everything runs on fakes — a stub JSON-RPC answers the
// eth_* calls Runtime.open makes; no real sponsor, daemon or chain.

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDeployment } from "@mida/chain"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"
import type { Address } from "@mida/protocol"
import {
  HOSTED_SPONSOR_URL,
  MidaHome,
  resolveNetwork,
  runCli,
  runDoctor,
  saveOwnerAddress,
  saveOwnerMode,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import { setSponsorUrl } from "../src/network.js"

const dir = () => mkdtempSync(join(tmpdir(), "mida-sponsor-"))

const OWNER = `0x${"11".repeat(20)}` as Address

/** A 31337 (foundry) deployment record — raw form for network.json, parsed for code. */
const DEPLOYMENT_RAW = {
  chainId: "31337",
  capabilityRegistry: "0x2222222222222222222222222222222222222222",
  contextRegistry: "0x3333333333333333333333333333333333333333",
  deploymentBlock: "0",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"55".repeat(32)}`,
  // the real policy hash — Runtime.open's FakeVaultAuthority rejects any other
  policyHashV1: POLICY_HASH_V1,
}
const DEPLOYMENT = parseDeployment(DEPLOYMENT_RAW)

/** The JSON-RPC calls Runtime.open actually makes — everything else gets "0x". */
async function stubRpc(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createHttpServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string }
      const reply = (result: unknown) => {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
      }
      if (call.method === "eth_chainId") return reply("0x7a69")
      if (call.method === "eth_blockNumber") return reply("0x64")
      if (call.method === "eth_getTransactionCount") return reply("0x0")
      if (call.method === "eth_getBalance") return reply("0x0")
      // a deployed contract over zero state — decodes cleanly (e.g. ownerP256Key → (0,0))
      if (call.method === "eth_call") return reply(`0x${"0".repeat(128)}`)
      return reply("0x")
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
}

describe("setSponsorUrl — only the sponsor key's bytes may change", () => {
  it("splices sponsorUrl into an old-style file that never had it, preserving every other byte", () => {
    const home = new MidaHome(dir())
    home.writeSecretJson("network.json", {
      rpcUrl: "http://rpc.example",
      deployment: DEPLOYMENT_RAW,
      storageUrl: "http://store.example",
      batching: true,
    })
    const before = readFileSync(home.path("network.json"), "utf8")
    setSponsorUrl(home, "https://sponsor.example")
    const after = readFileSync(home.path("network.json"), "utf8")
    // spliced in as the first key at the file's own indentation — same rule as batching
    const leading = before.slice(1, before.indexOf('"', 1))
    expect(after).toBe(`{${leading}"sponsorUrl": "https://sponsor.example",${before.slice(1)}`)
    const parsed = JSON.parse(after) as Record<string, unknown>
    expect(parsed.sponsorUrl).toBe("https://sponsor.example")
    for (const key of ["rpcUrl", "deployment", "storageUrl", "batching"]) {
      expect(parsed[key]).toEqual((JSON.parse(before) as Record<string, unknown>)[key])
    }
  })

  it("removes a mid-file sponsorUrl — the comma after it goes with it", () => {
    const home = new MidaHome(dir())
    const before = `{\n  "rpcUrl": "http://rpc.example",\n  "sponsorUrl": "https://sponsor.example",\n  "storageUrl": "http://store.example"\n}`
    writeFileSync(home.path("network.json"), before, { mode: 0o600 })
    setSponsorUrl(home, undefined)
    expect(readFileSync(home.path("network.json"), "utf8")).toBe(
      `{\n  "rpcUrl": "http://rpc.example",\n  "storageUrl": "http://store.example"\n}`,
    )
  })

  it("removes a trailing sponsorUrl — the comma before it goes with it", () => {
    const home = new MidaHome(dir())
    const before = `{"rpcUrl":"http://rpc.example","sponsorUrl":"https://sponsor.example"}`
    writeFileSync(home.path("network.json"), before, { mode: 0o600 })
    setSponsorUrl(home, undefined)
    expect(readFileSync(home.path("network.json"), "utf8")).toBe(`{"rpcUrl":"http://rpc.example"}`)
  })

  it("writes nothing when the file is already what was asked for", () => {
    const home = new MidaHome(dir())
    const before = `{\n  "rpcUrl": "http://rpc.example",\n  "deployment": ${JSON.stringify(DEPLOYMENT_RAW)}\n}\n`
    writeFileSync(home.path("network.json"), before, { mode: 0o600 })
    setSponsorUrl(home, undefined)
    expect(readFileSync(home.path("network.json"), "utf8")).toBe(before)
  })

  it("replaces a present sponsorUrl's value in place", () => {
    const home = new MidaHome(dir())
    const before = `{"rpcUrl":"http://rpc.example","sponsorUrl":"https://old.example","batching":true}`
    writeFileSync(home.path("network.json"), before, { mode: 0o600 })
    setSponsorUrl(home, "https://new.example")
    expect(readFileSync(home.path("network.json"), "utf8")).toBe(
      `{"rpcUrl":"http://rpc.example","sponsorUrl":"https://new.example","batching":true}`,
    )
  })

  it("refuses a missing or corrupt file — never a rewrite", () => {
    expect(() => setSponsorUrl(new MidaHome(dir()), "https://sponsor.example")).toThrow("network.json")
    const broken = new MidaHome(dir())
    writeFileSync(broken.path("network.json"), "not json {")
    expect(() => setSponsorUrl(broken, "https://sponsor.example")).toThrow("could not be parsed")
  })
})

describe("mida sponsor on|off", () => {
  const setup = async (over: {
    networkJson?: boolean
    sponsorUrl?: string
    passkey?: boolean
    customSpace?: boolean
    /** What the injected restartDaemon reports back — undefined reads as "restarted" (in-39 B-6). */
    restartOutcome?: "restarted" | "not-running" | "kept-running"
    env?: Record<string, string>
  } = {}) => {
    const rpc = await stubRpc()
    const home = new MidaHome(dir())
    if (over.networkJson !== false) {
      if (over.customSpace === true) {
        // an old-style file, written by hand before the sponsor existed — its own spacing,
        // not JSON.stringify's, so byte preservation is really checked
        const fields = [`"rpcUrl": "${rpc.url}"`, `"deployment": ${JSON.stringify(DEPLOYMENT_RAW)}`, `"batching": true`]
        if (over.sponsorUrl !== undefined) fields.splice(1, 0, `"sponsorUrl":   "${over.sponsorUrl}"`)
        writeFileSync(home.path("network.json"), `{\n    ${fields.join(",\n    ")}\n}\n`, { mode: 0o600 })
      } else {
        home.writeSecretJson("network.json", {
          rpcUrl: rpc.url,
          deployment: DEPLOYMENT_RAW,
          ...(over.sponsorUrl === undefined ? {} : { sponsorUrl: over.sponsorUrl }),
        })
      }
    }
    const network: Network = { rpcUrl: rpc.url, deployment: DEPLOYMENT }
    if (over.passkey === true) {
      saveOwnerMode(home, "passkey")
      saveOwnerAddress(home, OWNER)
    }
    const lines: string[] = []
    const asked: string[] = []
    const restarts: number[] = []
    const kicks: number[] = []
    let answer = "yes"
    const run = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => lines.push(line),
        drainInput: async () => {},
        prompt: async (question) => {
          asked.push(question)
          return answer
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        env: over.env ?? {},
        kickDaemon: () => void kicks.push(1),
        restartDaemon: () => {
          restarts.push(1)
          return over.restartOutcome
        },
      })
    const close = async () => {
      await rpc.close()
    }
    return { rpc, home, lines, asked, restarts, kicks, run, close, sayNo: () => (answer = "no") }
  }

  it("on writes the hosted sponsor into an old-style file, says so, and restarts the service — every other byte intact", async () => {
    const { home, lines, asked, restarts, kicks, run, close } = await setup({ customSpace: true })
    try {
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(JSON.parse(before).sponsorUrl).toBeUndefined() // the pre-sponsor file this command exists for
      expect(await run("sponsor", "on")).toBe(0)
      expect(lines).toContain(
        `Your saves and grants will use the gas sponsor at sponsor.midacontext.xyz, so your wallets stop paying. Your wallets keep what they hold as a fallback.`,
      )
      expect(asked).toEqual(["Type yes to turn the sponsor on: "])
      expect(lines).toContain("gas sponsor on: sponsor.midacontext.xyz")
      // the sponsor lives in the send path opened at service start — a restart, not a kick
      expect(restarts).toHaveLength(1)
      expect(kicks).toHaveLength(0)
      // only the sponsor pair was spliced in — everything else is the same bytes
      const after = readFileSync(home.path("network.json"), "utf8")
      expect(JSON.parse(after).sponsorUrl).toBe(HOSTED_SPONSOR_URL)
      for (const key of ["rpcUrl", "deployment", "batching"]) {
        expect(JSON.parse(after)[key]).toEqual(JSON.parse(before)[key])
      }
      // what doctor will say about it: the file's value, not the default or the environment
      const resolved = await resolveNetwork(home, {}, { probeChainId: false })
      expect(resolved.sponsor).toEqual({ url: HOSTED_SPONSOR_URL, source: "network.json" })
    } finally {
      await close()
    }
  })

  it("a service that does not stop keeps the old gas setting — and the command says so (in-39 B-6)", async () => {
    // The old service survived /shutdown (busy mid-pass, or the probes timed out): telling the
    // owner "sponsor on: …" alone claims a change that has not taken effect — the note names it.
    const { lines, run, close } = await setup({ customSpace: true, restartOutcome: "kept-running" })
    try {
      expect(await run("sponsor", "on")).toBe(0)
      expect(lines).toContain("gas sponsor on: sponsor.midacontext.xyz")
      expect(lines).toContain(
        "note: the Mida service did not restart, so it keeps the old gas setting until its next start. Run mida doctor to check.",
      )
    } finally {
      await close()
    }
  })

  it("a service that was not running is not 'restarted' — and a silent success stays honest (in-39 B-6)", async () => {
    const { lines, restarts, run, close } = await setup({ customSpace: true, restartOutcome: "not-running" })
    try {
      expect(await run("sponsor", "on")).toBe(0)
      expect(lines).toContain("gas sponsor on: sponsor.midacontext.xyz")
      // nothing was kept running, so no kept-running note — the file is already the truth the
      // next service start reads
      expect(lines.some((line) => line.includes("did not restart"))).toBe(false)
      expect(restarts).toHaveLength(1) // the restart attempt still ran
    } finally {
      await close()
    }
  })

  it("MIDA_SPONSOR_URL set in the shell is named after the command's other lines — it wins over the file (in-39 B-6, nit 1)", async () => {
    const { lines, run, close } = await setup({ customSpace: true, env: { MIDA_SPONSOR_URL: "https://env-sponsor.example" } })
    try {
      expect(await run("sponsor", "on")).toBe(0)
      const sponsorLine = lines.findIndex((line) => line === "gas sponsor on: sponsor.midacontext.xyz")
      const noteLine = lines.findIndex(
        (line) => line === "note: MIDA_SPONSOR_URL is set in this shell and wins over network.json while it is set.",
      )
      expect(noteLine).toBeGreaterThan(-1)
      expect(noteLine).toBeGreaterThan(sponsorLine)
    } finally {
      await close()
    }
  })

  it("a doctor run on the switched-on home reports the file's sponsor — the hosted default is not confused for it", async () => {
    const { home, run, close } = await setup()
    try {
      expect(await run("sponsor", "on")).toBe(0)
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        env: {},
        daemonProbeMs: 50,
        // a file naming the hosted sponsor must still never reach it (B-7)
        fetch: async () => new Response("{}", { status: 200 }),
        sponsorReachable: async () => true,
      })
      expect(lines).toContain("ok: sponsor: sponsor.midacontext.xyz (network.json)")
    } finally {
      await close()
    }
  })

  it("doctor's sponsor probes never touch the global fetch — everything goes through the injected one (in-39 B-7)", async () => {
    // a passkey home with no agents makes no chain reads at all, so the only remote calls a
    // doctor run could make are the sponsor and store probes — all of them must ride deps.fetch
    const { home, close } = await setup({ passkey: true, sponsorUrl: HOSTED_SPONSOR_URL })
    try {
      const realFetch = globalThis.fetch
      const fetched: string[] = []
      const leaked: string[] = []
      globalThis.fetch = ((input: unknown, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        // the test's own stub RPC is a loopback server it started; anything else that rides the
        // global fetch is a leak — the sponsor must never be one of them
        if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) {
          leaked.push(url)
          return Promise.reject(new Error(`global fetch left the machine during doctor: ${url}`))
        }
        return realFetch(input as never, init)
      }) as typeof fetch
      try {
        const lines: string[] = []
        await runDoctor({
          home,
          print: (line) => lines.push(line),
          env: {},
          daemonProbeMs: 50,
          fetch: async (input) => {
            fetched.push(String(input))
            return new Response(
              JSON.stringify({ limits: { signingsPerSenderPerDay: 10, signingsGlobalPerDay: 100 } }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          },
          sponsorReachable: async () => true,
        })
        // the sponsor check asked the injected fetch — and the sponsor line proves it answered
        expect(fetched).toEqual([HOSTED_SPONSOR_URL])
        expect(lines).toContain(
          "ok: gas sponsor reachable at sponsor.midacontext.xyz (willingness is only proven by a real send; it advertises 10 signings per address a day, 100 a day in total)",
        )
        expect(lines).toContain("ok: gas is sponsored by sponsor.midacontext.xyz")
        expect(leaked, lines.join("\n")).toEqual([])
        expect(lines.some((line) => line.includes("check failed")), lines.join("\n")).toBe(false)
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      await close()
    }
  })

  it("off removes the sponsor, says the wallets pay, and restarts — the rest of the file untouched", async () => {
    const { home, lines, asked, restarts, run, close } = await setup({ sponsorUrl: "https://sponsor.example", customSpace: true })
    try {
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(await run("sponsor", "off")).toBe(0)
      expect(asked).toEqual(["Type yes to turn the sponsor off: "])
      expect(lines).toContain("gas sponsor off: your wallets pay their own gas")
      expect(restarts).toHaveLength(1)
      // the whole pair left cleanly — its indentation and the comma after it — leaving exactly
      // the bytes the file had before the sponsor existed
      const after = readFileSync(home.path("network.json"), "utf8")
      expect(after).toBe(before.replace(`    "sponsorUrl":   "https://sponsor.example",\n`, ""))
      expect(JSON.parse(after).sponsorUrl).toBeUndefined()
      const resolved = await resolveNetwork(home, {}, { probeChainId: false })
      expect(resolved.sponsor).toEqual({ url: undefined, source: "local" })
    } finally {
      await close()
    }
  })

  it("on then off returns the file to its bytes exactly — the old-style file round-trips", async () => {
    const { home, run, close } = await setup({ customSpace: true })
    try {
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(await run("sponsor", "on")).toBe(0)
      expect(JSON.parse(readFileSync(home.path("network.json"), "utf8")).sponsorUrl).toBe(HOSTED_SPONSOR_URL)
      expect(await run("sponsor", "off")).toBe(0)
      expect(readFileSync(home.path("network.json"), "utf8")).toBe(before)
    } finally {
      await close()
    }
  })

  it("turning the sponsor on clears a recorded out-of-gas wait so saves resume (in-29 S-2)", async () => {
    const { home, run, close } = await setup()
    try {
      home.writeSecretJson("queue/state/s1.json", {
        transcriptBytes: 10,
        lastLineHash: "",
        savedAt: new Date().toISOString(),
        attempts: 3,
        failedAt: new Date().toISOString(),
        reason: "out-of-gas",
      })
      expect(await run("sponsor", "on")).toBe(0)
      const state = home.readJson<Record<string, unknown>>("queue/state/s1.json") ?? {}
      expect(state.attempts).toBeUndefined()
      expect(state.failedAt).toBeUndefined()
      expect(state.reason).toBeUndefined()
    } finally {
      await close()
    }
  })

  it("a passkey home runs the same switch — the file edit needs no owner signature", async () => {
    const { home, lines, restarts, run, close } = await setup({ passkey: true, sponsorUrl: "https://sponsor.example" })
    try {
      expect(await run("sponsor", "off")).toBe(0)
      expect(lines).toContain("gas sponsor off: your wallets pay their own gas")
      expect(restarts).toHaveLength(1)
      expect((home.readJson<Record<string, unknown>>("network.json") ?? {}).sponsorUrl).toBeUndefined()
      expect(home.has("owner/secrets.json")).toBe(false) // the passkey path must never mint a local key
    } finally {
      await close()
    }
  })

  it("an answer other than yes writes nothing; a missing argument is usage; no network.json refuses plainly", async () => {
    const { home, lines, restarts, run, close, sayNo } = await setup()
    try {
      sayNo()
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(await run("sponsor", "on")).toBe(1)
      expect(lines).toContain("not approved")
      expect(readFileSync(home.path("network.json"), "utf8")).toBe(before)
      expect(restarts).toHaveLength(0)
      expect(await run("sponsor")).toBe(2)
    } finally {
      await close()
    }
    const bare = await setup({ networkJson: false })
    try {
      expect(await bare.run("sponsor", "off")).toBe(1)
      expect(bare.lines).toContain("sponsor cannot be turned off: there is no network.json to switch — run `mida init` first")
      expect(bare.restarts).toHaveLength(0)
    } finally {
      await bare.close()
    }
  })
})
