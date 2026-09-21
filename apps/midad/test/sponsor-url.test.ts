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
  }, 60_000)

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
  }, 60_000)
})

describe("the doctor sponsor line", () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const server of servers) server.close()
  })

  const doctorLines = async (home: MidaHome): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), env: {} })
    return lines
  }

  it("prints the host and the limits the endpoint advertises", async () => {
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
    const baseUrl = await new Promise<string>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
    )
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sponsorurl-")))
    home.writeSecretJson("network.json", { sponsorUrl: baseUrl })
    const lines = await doctorLines(home)
    expect(lines).toContain(`ok: gas sponsor ${new URL(baseUrl).host} answers (30 signings per address a day, 2000 a day in total)`)
    expect(lines.join("\n")).not.toContain(baseUrl) // host only, never the URL
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
    expect(lines).toContain("ok: no gas sponsor configured — sends pay their own gas")
  })
})
