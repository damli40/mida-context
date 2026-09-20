import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, runCli } from "@mida/midad"
import type { Network } from "@mida/midad"

describe("the crude mida command", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  const lines: string[] = []
  const run = (...argv: string[]) => runCli(argv, { home, network, print: (line) => lines.push(line) })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-")))
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("rejects an unknown command, an unknown agent and a missing project with exit code 2", async () => {
    expect(await run("frobnicate")).toBe(2)
    expect(await run("approve", "cursor")).toBe(2)
    expect(await run("read", "codex")).toBe(2)
  })

  it("walks the whole demo: init, approve both, save, read, revoke, refused", async () => {
    expect(await run("init")).toBe(0)
    expect(await run("request", "claude-code")).toBe(0)
    expect(await run("approve", "claude-code")).toBe(0)
    expect(await run("save-demo", "claude-code", "proj-1")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(1)
    expect(await run("request", "codex")).toBe(0)
    expect(await run("approve", "codex")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(await run("revoke", "claude-code")).toBe(0)
    expect(await run("read", "claude-code", "proj-1")).toBe(1)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(lines.some((line) => line.includes("CAPABILITY_REVOKED"))).toBe(true)
  }, 300_000)

  it("never prints a secret: no output line contains any key stored in the home folder", () => {
    const secrets: string[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder)) {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== "data") walk(full)
        } else if (/secrets|signer|identity/.test(entry)) {
          const text = readFileSync(full, "utf8")
          for (const match of text.matchAll(/"(?:privateKey|seed|p256PrivateKey|signerPrivateKey|encryptionPrivateKey)":\s*"(0x[0-9a-f]{64})"/g)) secrets.push(match[1]!)
        }
      }
    }
    walk(home.root)
    expect(secrets.length).toBeGreaterThanOrEqual(8)
    const output = lines.join("\n")
    for (const secret of secrets) expect(output.includes(secret)).toBe(false)
  })
})
