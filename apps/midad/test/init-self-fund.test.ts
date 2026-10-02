// M3-C: the published CLI ships with no deployer key — when the sponsor is off (or refuses),
// `mida init` must name the owner address and the exact next step, then resume cleanly when the
// wallet is funded. Every agent-side wallet is topped up from the owner's own wallet.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fundLocal } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, runCli } from "@mida/midad"
import type { Network } from "@mida/midad"

describe("init without a funder (the published CLI's funding path)", () => {
  let env: ScenarioEnvironment
  beforeAll(async () => {
    env = await localEnvironment()
  }, 600_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("refuses naming the owner address, then resumes to completion once funded", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-nofund-")))
    // no fund, no sponsor — exactly what the published CLI sees on a fresh machine
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment }
    const lines: string[] = []
    const run = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => lines.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })

    // An empty owner wallet: the run refuses and names where the MON goes.
    expect(await run("init")).toBe(1)
    const refusal = lines.find((line) => line.includes("send at least 0.5 testnet MON"))
    expect(refusal).toBeDefined()
    const owner = refusal!.match(/0x[0-9a-fA-F]{40}/)![0]!
    expect(owner).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // The secrets were already written — a resume must come back to the same owner.
    expect(home.has("owner/secrets.json")).toBe(true)

    // Funded, the same init resumes: key + namespaces already asked about on chain, operator
    // and signer wallets topped up from the owner, all three agents provisioned.
    await fundLocal(env.rpcUrl, owner, 2n * 10n ** 18n)
    expect(await run("init")).toBe(0)
    expect(lines.filter((line) => line.startsWith("agent ")).length).toBe(3)
    // and the owner address it reports is the one the refusal named
    expect(lines.find((line) => line.startsWith("owner "))).toContain(owner)
  }, 300_000)

  it("a mid-run shortfall still names the owner address, not the wallet that was short", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-nofund-")))
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment }
    const lines: string[] = []
    const run = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => lines.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })

    // Fund just above the owner's own start line: key + namespaces fit, the operator top-up
    // may not — whichever step runs out, the answer names the owner address again.
    expect(await run("init")).toBe(1)
    const refusal = lines.find((line) => line.includes("send at least 0.5 testnet MON"))!
    const owner = refusal.match(/0x[0-9a-fA-F]{40}/)![0]!
    await fundLocal(env.rpcUrl, owner, 16n * 10n ** 16n) // 0.16 MON — over the 0.15 start line
    expect(await run("init")).toBe(1)
    const again = lines.filter((line) => line.includes("send at least 0.5 testnet MON")).pop()!
    expect(again).toContain(owner)
    // and a third run finishes the job
    await fundLocal(env.rpcUrl, owner, 2n * 10n ** 18n)
    expect(await run("init")).toBe(0)
  }, 300_000)
})
