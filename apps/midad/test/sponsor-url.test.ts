// M3-D item 2(iii): network.sponsorUrl — validation, wiring onto write contexts, network.json
// persistence, and the doctor line (host only, reachable or not, the advertised limits).

import { afterAll, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import { MidaHome, Runtime, parseSponsorUrl, runDoctor } from "@mida/midad"
import type { Network } from "@mida/midad"
import type { Deployment } from "@mida/chain"

const fakeDeployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  deploymentBlock: 0n,
  policyHashV1: `0x${"00".repeat(32)}`,
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"00".repeat(32)}`,
}

describe("parseSponsorUrl", () => {
  it("accepts https and localhost-only http", () => {
    expect(parseSponsorUrl("https://sponsor.mida.example")).toBe("https://sponsor.mida.example")
    expect(parseSponsorUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
    expect(parseSponsorUrl("http://localhost:8787/rpc")).toBe("http://localhost:8787/rpc")
    expect(parseSponsorUrl(undefined)).toBeUndefined()
    expect(parseSponsorUrl("")).toBeUndefined()
  })

  it("refuses remote http, other schemes, credentials and garbage with bad-sponsor-url", () => {
    for (const bad of [
      "http://169.254.169.254:80",
      "ftp://sponsor.example/x",
      "https://user:pass@sponsor.mida.example",
      "https://token@sponsor.mida.example",
      "not a url",
    ]) {
      expect(() => parseSponsorUrl(bad)).toThrowError(expect.objectContaining({ code: "bad-sponsor-url" }) as Error)
    }
  })
})

describe("Runtime.open with a sponsorUrl", () => {
  it("refuses a bad sponsor URL before the lock or any chain call", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    for (const bad of ["http://169.254.169.254:80", "https://user:pw@host.example", "not a url"]) {
      await expect(
        Runtime.open(home, { rpcUrl: "http://127.0.0.1:1", deployment: fakeDeployment, sponsorUrl: bad }),
      ).rejects.toMatchObject({ code: "bad-sponsor-url" })
      expect(home.has("midad.lock")).toBe(false)
    }
  })

  it("wires a sponsored sender and a progress sink onto the owner's write context", async () => {
    const env = await localEnvironment()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    try {
      const runtime = await Runtime.open(home, {
        rpcUrl: env.rpcUrl,
        deployment: env.deployment,
        fund: env.fund,
        sponsorUrl: "http://127.0.0.1:9", // unreachable is fine — the sender only builds clients
      })
      try {
        expect(runtime.ownerChain.sponsor).toBeDefined()
        expect(runtime.ownerChain.progress).toBeDefined()
        // and init persists it for the daemon and the drainer to read back
        const { init } = await import("@mida/midad")
        await init(runtime, [])
        const stored = home.readJson<{ sponsorUrl?: unknown }>("network.json")
        expect(stored?.sponsorUrl).toBe("http://127.0.0.1:9")
      } finally {
        await runtime.close()
      }
    } finally {
      await env.stop()
    }
    // localEnvironment queues on the shared deploy lock — the wait alone can outlast a
    // short cap when the whole suite runs, so these use the file's 300s chain-test timeout
  }, 300_000)

  it("leaves both unset without one", async () => {
    const env = await localEnvironment()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    try {
      const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund })
      try {
        expect(runtime.ownerChain.sponsor).toBeUndefined()
      } finally {
        await runtime.close()
      }
    } finally {
      await env.stop()
    }
  }, 300_000)

  it("init on a 0-MON owner with a sponsor ANSWERING never runs the funding gate — and says so", async () => {
    // M3-D3 item 2, tightened by M3-D6 item 2: the gate is skipped because the sponsor ANSWERS,
    // not because a URL is configured. The endpoint here replies 2xx to the probe but refuses
    // every operation: init exercises the whole flow — owner key, namespaces, an agent
    // registration, the assistant grant — on the self-pay fallback, while the up-front
    // ensureFunded gates stay skipped. The fallback proving it can still pay is the point.
    const env = await localEnvironment()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    const sponsor = createServer((req, res) => {
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
      const runtime = await Runtime.open(home, {
        rpcUrl: env.rpcUrl,
        deployment: env.deployment,
        fund: env.fund,
        sponsorUrl,
      })
      try {
        const progress: string[] = []
        runtime.progress = (line) => progress.push(line)
        runtime.ensureFunded = async () => {
          throw new Error("ensureFunded must never run while the sponsor answers")
        }
        const { init } = await import("@mida/midad")
        await init(runtime, ["assistant"])
        expect(progress).toContain("gas sponsor on — no MON needed")
        expect(home.has("agents/assistant/identity.json")).toBe(true)
      } finally {
        await runtime.close()
      }
    } finally {
      await new Promise<void>((done) => sponsor.close(() => done()))
      await env.stop()
    }
  }, 300_000)
})

describe("the doctor sponsor line", () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const server of servers) server.close()
  })

  const doctorLines = async (home: MidaHome, env: NodeJS.ProcessEnv = {}): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), env })
    return lines
  }

  /** A sponsor endpoint that answers the GET probe — reachable, whether or not it would pay. */
  const answeringSponsor = async (): Promise<string> => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          name: "mida-gas-sponsor",
          limits: { signingsPerSenderPerDay: 30, signingsGlobalPerDay: 2000, freeCallsPerSenderPerDay: 100 },
        }),
      )
    })
    servers.push(server)
    return new Promise<string>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
    )
  }

  it("prints the host and the limits the endpoint advertises — as reachability, not willingness (M3-D6)", async () => {
    const baseUrl = await answeringSponsor()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    home.writeSecretJson("network.json", { sponsorUrl: baseUrl })
    const lines = await doctorLines(home)
    // a 2xx GET proves the endpoint answers — the Sep 22 refusal came from a reachable sponsor
    expect(lines).toContain(
      `ok: gas sponsor reachable at ${new URL(baseUrl).host} (willingness is only proven by a real send; it advertises 30 signings per address a day, 2000 a day in total)`,
    )
    expect(lines.join("\n")).not.toContain(baseUrl) // host only, never the URL
  })

  it("MIDA_SPONSOR_URL overrides network.json in both directions (M3-D6)", async () => {
    const live = await answeringSponsor()
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    // env → a live URL wins over the stored dead one: the probe goes where a send would go
    home.writeSecretJson("network.json", { sponsorUrl: "http://127.0.0.1:1" })
    let lines = await doctorLines(home, { MIDA_SPONSOR_URL: live })
    expect(lines).toContain(
      `ok: gas sponsor reachable at ${new URL(live).host} (willingness is only proven by a real send; it advertises 30 signings per address a day, 2000 a day in total)`,
    )
    expect(lines.some((line) => line.includes("127.0.0.1:1"))).toBe(false)
    // env → off wins over the stored live one: every send self-pays, so doctor must not probe or claim it
    home.writeSecretJson("network.json", { sponsorUrl: live })
    lines = await doctorLines(home, { MIDA_SPONSOR_URL: "off" })
    expect(lines).toContain("ok: gas sponsor off — sends pay their own gas")
    expect(lines.some((line) => line.includes("reachable") || line.includes("gas is sponsored"))).toBe(false)
  })

  it("MIDA_STORAGE_URL overrides network.json the same way (M3-D6)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    home.writeSecretJson("network.json", { storageUrl: "https://stored.example.com" })
    let lines = await doctorLines(home, { MIDA_STORAGE_URL: "https://env.example.com" })
    expect(lines).toContain("ok: store: env.example.com (MIDA_STORAGE_URL)")
    lines = await doctorLines(home, { MIDA_STORAGE_URL: "off" })
    expect(lines).toContain("ok: store: off — the local store")
    lines = await doctorLines(home)
    expect(lines).toContain("ok: store: stored.example.com (network.json)")
  })

  it("an unreachable sponsor is a problem that names the fallback", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    home.writeSecretJson("network.json", { sponsorUrl: "http://127.0.0.1:1" }) // port 1 never answers
    const lines = await doctorLines(home)
    expect(lines.some((line) => line.startsWith("PROBLEM: the gas sponsor 127.0.0.1:1 did not answer within 2 s"))).toBe(true)
  })

  it("no configured sponsor is a plain ok line, not a problem", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    home.writeSecretJson("network.json", { chainId: 31337 })
    const lines = await doctorLines(home)
    expect(lines).toContain("ok: no gas sponsor in network.json — the services check shows what init will use")
  })
})
