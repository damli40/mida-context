import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer as createHttpServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, Runtime, init, runCli } from "@mida/midad"
import type { Network } from "@mida/midad"

/**
 * R4-1 — owner commands narrate each slow step on a separate `progress` channel (STDERR by
 * default), so the printed output keeps meaning exactly what it meant before.
 */
describe("owner command progress lines", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  const progressLines: string[] = []
  const printLines: string[] = []
  const run = (...argv: string[]) =>
    runCli(argv, {
      home,
      network,
      print: (line) => printLines.push(line),
      progress: (line) => progressLines.push(line),
      prompt: async () => "yes",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-progress-")))
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("init narrates the chain steps before they run", async () => {
    progressLines.length = 0
    expect(await run("init")).toBe(0)
    const at = (fragment: string) => progressLines.findIndex((line) => line === fragment)
    expect(at("registering your key on the chain…")).toBeGreaterThanOrEqual(0)
    expect(at("opening 3 context areas (3 transactions)…")).toBeGreaterThan(at("registering your key on the chain…"))
    expect(at("registering claude-code on the chain…")).toBeGreaterThan(at("opening 3 context areas (3 transactions)…"))
    expect(at("registering codex on the chain…")).toBeGreaterThan(at("registering claude-code on the chain…"))
  }, 300_000)

  it("approve narrates the reads and the send, in order", async () => {
    progressLines.length = 0
    expect(await run("request", "claude-code")).toBe(0)
    expect(await run("approve", "claude-code")).toBe(0)
    const at = (fragment: string) => progressLines.findIndex((line) => line === fragment)
    expect(at("asking the chain what claude-code already holds…")).toBeGreaterThanOrEqual(0)
    expect(at("sending the grant (about 5 seconds)…")).toBeGreaterThan(at("asking the chain what claude-code already holds…"))
    expect(at("proving the grant on the chain…")).toBeGreaterThan(at("sending the grant (about 5 seconds)…"))
  }, 300_000)

  it("revoke narrates the send and the rewrap, in order", async () => {
    progressLines.length = 0
    expect(await run("revoke", "claude-code")).toBe(0)
    const at = (fragment: string) => progressLines.findIndex((line) => line.startsWith(fragment))
    expect(at("sending the revocation (about 5 seconds)…")).toBeGreaterThanOrEqual(0)
    expect(at("sending the new key to ")).toBeGreaterThan(at("sending the revocation (about 5 seconds)…"))
    expect(progressLines.some((line) => /^sending the new key to \d+ agent(s)?…$/.test(line))).toBe(true)
  }, 300_000)

  it("remember narrates the write", async () => {
    progressLines.length = 0
    expect(await run("remember", "answer in lowercase")).toBe(0)
    expect(progressLines).toContain("writing your fact (about 5 seconds)…")
  }, 300_000)

  it("no progress line ever carries a key, a seed, a signature or a full 64-hex value", () => {
    for (const line of progressLines) {
      expect(line).not.toMatch(/0x[0-9a-fA-F]{64}/)
      expect(line).not.toMatch(/[0-9a-fA-F]{64}/)
    }
  })

  it("a run with no progress dep prints exactly what it printed before", async () => {
    const lines: string[] = []
    const silent = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await silent("request", "codex")).toBe(0)
    lines.length = 0
    expect(await silent("approve", "codex")).toBe(0)
    // the printed conversation is exactly today's: the ask, the scopes, the advice and the
    // result — and not one progress-style line (all of them end in "…") leaked into it
    expect(lines[0]).toBe("codex is asking for:")
    expect(lines).toContain("  profile.skills: READ")
    expect(lines).toContain("  projects.current: READ + CREATE + SUPERSEDE_OWN")
    expect(lines).toContain("  preferences.communication: READ")
    expect(lines.some((line) => line.startsWith("grant advisor: "))).toBe(true)
    expect(lines.at(-1)).toMatch(/^approved codex tx 0x[0-9a-f]{64} gas \d+$/)
    expect(lines.some((line) => line.endsWith("…"))).toBe(false)
  }, 300_000)
})

/**
 * M3-D3 item 4 — the "(sponsored)" suffix is read off the write context that will send, never
 * guessed. M3-D6 item 2 — init no longer trusts a CONFIGURED sponsor URL: it probes the
 * endpoint once (the same 2 s GET doctor runs) and only an answering sponsor earns "no MON
 * needed"; a silent one funds the wallet exactly as the no-sponsor path does.
 */
describe("sponsored progress lines", () => {
  it("an answering sponsor keeps 'no MON needed' — and a send that falls back still lands", async () => {
    const env = await localEnvironment()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-progress-sponsor-")))
    // Answers the GET probe but refuses every JSON-RPC operation: reachable ≠ willing, and the
    // send-time fallback is what carries init once the probe has passed.
    const sponsor = createHttpServer((req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ name: "mida-gas-sponsor" }))
        return
      }
      res.statusCode = 500
      res.end("{}")
    })
    try {
      const sponsorUrl = await new Promise<string>((resolve, reject) => {
        sponsor.once("error", reject)
        sponsor.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(sponsor.address() as { port: number }).port}`))
      })
      const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, sponsorUrl }
      const runtime = await Runtime.open(home, network)
      try {
        const lines: string[] = []
        runtime.progress = (line) => lines.push(line)
        await init(runtime, ["assistant"])
        expect(lines).toContain("gas sponsor on — no MON needed")
        expect(lines).toContain("sending assistant's grant (sponsored)…")
        expect(
          lines.some((line) => line.includes("the gas sponsor did not pay") && line.includes("paying from your own wallet")),
        ).toBe(true)
      } finally {
        await runtime.close()
      }
    } finally {
      await new Promise<void>((done) => sponsor.close(() => done()))
      await env.stop()
    }
  }, 300_000)

  it("a silent sponsor with a funder says so, tops the wallet up, and still inits", async () => {
    const env = await localEnvironment()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-progress-deadsponsor-")))
    try {
      const network: Network = {
        rpcUrl: env.rpcUrl,
        deployment: env.deployment,
        fund: env.fund,
        sponsorUrl: "http://127.0.0.1:9", // configured but never answers — the Sep 22 shape
      }
      const runtime = await Runtime.open(home, network)
      try {
        const lines: string[] = []
        runtime.progress = (line) => lines.push(line)
        await init(runtime, ["assistant"])
        expect(lines).toContain("gas sponsor not answering — this setup needs MON in your wallet")
        expect(lines).not.toContain("gas sponsor on — no MON needed")
        expect(lines).toContain("topping up your wallet…") // ensureFunded ran, sponsor or not
      } finally {
        await runtime.close()
      }
    } finally {
      await env.stop()
    }
  }, 300_000)

  it("a silent sponsor with no funder refuses init with the send-MON refusal — not 'no MON needed'", async () => {
    const env = await localEnvironment()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-progress-nofund-")))
    try {
      const network: Network = {
        rpcUrl: env.rpcUrl,
        deployment: env.deployment,
        sponsorUrl: "http://127.0.0.1:9", // configured, dead — and nobody to top the wallet up
      }
      const runtime = await Runtime.open(home, network)
      try {
        const lines: string[] = []
        runtime.progress = (line) => lines.push(line)
        const error = await init(runtime, ["assistant"]).then(() => null, (e: unknown) => e)
        expect(lines).toContain("gas sponsor not answering — this setup needs MON in your wallet")
        expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
      } finally {
        await runtime.close()
      }
    } finally {
      await env.stop()
    }
  }, 120_000)
})
