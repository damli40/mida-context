import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, ServiceRuntime } from "@mida/midad"
import type { Network } from "@mida/midad"

/**
 * The daemon's runtime carries no owner key. These tests run with no chain: the refusal happens
 * before any chain call, and the open itself only binds a local API server.
 */
const DEPLOYMENT = {
  chainId: 31337n,
  capabilityRegistry: "0x0000000000000000000000000000000000000001",
  contextRegistry: "0x0000000000000000000000000000000000000002",
  deploymentBlock: 0n,
  policyHashV1: `0x${"00".repeat(32)}`,
  vaultRpId: "test.local",
  vaultRpIdHash: `0x${"00".repeat(32)}`,
} as const
const network: Network = { rpcUrl: "http://127.0.0.1:1", deployment: DEPLOYMENT as never, fund: async () => {} }
const OWNER = "0x1111111111111111111111111111111111111111"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-svc-")))

describe("ServiceRuntime — the daemon's runtime", () => {
  it("refuses to open when owner-address.json is missing, with one line telling the user to run mida init", async () => {
    const home = freshHome()
    await expect(ServiceRuntime.open(home, network)).rejects.toThrow(/mida init/)
    // refused before the lock was ever taken
    expect(home.has("midad.lock")).toBe(false)
  })

  it("opens on the public owner address alone — the owner secret file is never read or created", async () => {
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const runtime = await ServiceRuntime.open(home, network)
    try {
      expect(runtime.owner).toBe(OWNER)
      expect(home.has("owner/secrets.json")).toBe(false)
      // no owner-signing member exists on the type — a compile-time fact, exercised here as data
      for (const member of ["vault", "ownerChain", "ownerApi", "ensureFunded", "attach"] as const) {
        expect(member in runtime, member).toBe(false)
      }
      // while the daemon runs, the owner CLI finds its Context API through api-url.json
      const published = JSON.parse(readFileSync(home.path("api-url.json"), "utf8")) as { baseUrl?: string }
      expect(published.baseUrl).toBe(runtime.apiBaseUrl)
    } finally {
      await runtime.close()
    }
    expect(home.has("midad.lock")).toBe(false)
    expect(home.has("api-url.json")).toBe(false)
  })

  it("an agent() call rebuilds from disk every time, so a grant written after open is seen at once", async () => {
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const runtime = await ServiceRuntime.open(home, network)
    try {
      // no identity on disk — the error is the same one the owner runtime gives
      expect(() => runtime.agent("codex")).toThrow(/run init first/)
    } finally {
      await runtime.close()
    }
  })
})
