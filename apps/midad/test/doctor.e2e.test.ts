import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { increaseLocalTime } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  approve,
  init,
  installClaudeCode,
  installCodex,
  requestAccess,
  revoke,
  runDoctor,
  startDaemon,
  startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"

const STEP_TIMEOUT = 60_000

/**
 * The repo's own `bin/` — where the `mida-hook` and `mida-inject` launchers live until the npm
 * package exists. The healthy home's env carries it on PATH, exactly as a real install expects
 * the owner to have it (R4-6); the empty-PATH case proves the PROBLEM line when it is absent.
 */
const REPO_BIN = fileURLToPath(new URL("../../../bin/", import.meta.url))

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

/**
 * Doctor end to end on local Anvil: a real daemon answers /health, the chain holds a registered
 * owner and two approved agents, and the hook checks read real installed config from temp paths.
 * The time-travel test is last but one: once the chain's clock moves the grants stay expired.
 */
describe("mida doctor on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let daemon: DaemonHandle | undefined
  let claudeSettings: string
  let codexConfig: string
  let listBytes: string

  const doctor = async () => {
    const lines: string[] = []
    const code = await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": claudeSettings, codex: codexConfig },
      // the hook commands must resolve on the PATH the hooks get — the repo's bin/ is prepended,
      // and the rest of the ambient env stays out of the test
      env: { PATH: `${REPO_BIN}${delimiter}${process.env.PATH ?? ""}` },
    })
    return { lines, code }
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({
      rpcUrl: env.rpcUrl,
      deployment: env.deployment,
      dataDir: mkdtempSync(join(tmpdir(), "mida-doctor-data-")),
    })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-doctor-e2e-")))
    const workDir = join(mkdtempSync(join(tmpdir(), "mida-doctor-work-")), "work")
    mark(workDir, "proj-doctor")
    claudeSettings = join(mkdtempSync(join(tmpdir(), "mida-doctor-cfg-")), "settings.json")
    codexConfig = join(mkdtempSync(join(tmpdir(), "mida-doctor-cfg-")), "config.toml")
    installClaudeCode(claudeSettings)
    installCodex(codexConfig)

    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile: async () => {
        throw new Error("no compile in this suite")
      },
      now: () => Date.now(),
      log: () => {},
      tickMs: 60_000,
    })
    listBytes = readFileSync(home.path("approved-projects.json"), "utf8")
  }, STEP_TIMEOUT * 6)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  })

  it("(a) a healthy home prints ok lines and exits 0", async () => {
    const { lines, code } = await doctor()
    expect(lines[0]).toBe("ok: midad answers")
    expect(lines).toContain("ok: network.json present")
    expect(lines).toContain("ok: owner registered on chain")
    expect(lines).toContain("ok: claude-code approved")
    expect(lines).toContain("ok: codex approved")
    expect(lines).toContain("ok: approved-projects signature valid")
    expect(lines).toContain("ok: claude-code hooks installed")
    expect(lines).toContain("ok: codex hooks installed")
    expect(lines).toContain("ok: queue empty")
    expect(lines).toContain("ok: wallets have gas")
    expect(lines.every((line) => !line.startsWith("PROBLEM:"))).toBe(true)
    expect(code).toBe(0)
  }, STEP_TIMEOUT)

  it("(b) a tampered approved-projects file is one PROBLEM line and exit 1", async () => {
    writeFileSync(home.path("approved-projects.json"), '{"entries":[],"signature":"0xdead"}')
    const { lines, code } = await doctor()
    expect(lines).toContain(
      "PROBLEM: the approved-projects list failed its signature check — re-run `mida approve <agent>` in each project folder",
    )
    expect(code).toBe(1)
    // restore the signed list so later checks stay honest
    writeFileSync(home.path("approved-projects.json"), listBytes)
  }, STEP_TIMEOUT)

  it("(c) a just-revoked agent is reported revoked — never 'has never asked for access'", async () => {
    // a second home keeps the revoke away from the shared one: the real path writes
    // agents/doomed-agent/revoked.json and empties the agent's live capability list on chain.
    // it runs before the time-travel test — after the clock moves, approve() cannot create a grant.
    const home2 = new MidaHome(mkdtempSync(join(tmpdir(), "mida-doctor-revoked-")))
    const workDir = join(mkdtempSync(join(tmpdir(), "mida-doctor-work-")), "work")
    mark(workDir, "proj-revoked")
    const runtime = await Runtime.open(home2, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["doomed-agent"])
      await requestAccess(runtime, "doomed-agent")
      await approve(runtime, "doomed-agent", workDir)
      await revoke(runtime, "doomed-agent")
    } finally {
      await runtime.close()
    }
    const lines: string[] = []
    await runDoctor({ home: home2, print: (line) => lines.push(line), env: { PATH: `${REPO_BIN}${delimiter}${process.env.PATH ?? ""}` }, daemonProbeMs: 50 })
    const agentLine = lines.find((line) => line.includes("doomed-agent"))
    expect(agentLine).toContain("revoked")
    expect(agentLine).not.toContain("never asked")
  }, STEP_TIMEOUT)

  it("(d) an expired grant prints the expiry date (Anvil time travel)", async () => {
    await increaseLocalTime(env.rpcUrl, 33n * 24n * 60n * 60n)
    const { lines, code } = await doctor()
    const expired = lines.filter((line) => line.includes("grant expired"))
    expect(expired.length).toBeGreaterThanOrEqual(1)
    for (const line of expired) expect(line).toMatch(/grant expired \d{4}-\d{2}-\d{2}T/)
    expect(lines).toContain("ok: midad answers")
    expect(code).toBe(expired.length)
  }, STEP_TIMEOUT)

  it("(e) with the daemon down the daemon line is a PROBLEM and the run still finishes", async () => {
    await daemon?.close()
    const { lines, code } = await doctor()
    expect(lines[0]).toBe("PROBLEM: midad is not answering — start the daemon")
    // the chain checks still ran lock-free: the expired grants are still reported
    expect(lines.some((line) => line.includes("grant expired"))).toBe(true)
    expect(code).toBeGreaterThan(0)
    expect(code).toBeLessThanOrEqual(9)
  }, STEP_TIMEOUT)

  it("(f) a PATH without the hook commands is a PROBLEM that names the fix (R4-6)", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "mida-doctor-path-"))
    const lines: string[] = []
    const code = await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": claudeSettings, codex: codexConfig },
      env: { PATH: emptyPath },
      daemonProbeMs: 50,
    })
    for (const command of ["mida-hook", "mida-inject"]) {
      const line = lines.find((l) => l.includes(command))
      expect(line).toContain("PROBLEM:")
      expect(line).toContain(`the command \`${command}\` is not on your PATH`)
      // the fix text points at a real folder — the repo's own bin/, until the npm package exists
      expect(line).toContain(`add ${REPO_BIN}`)
      expect(line).toContain("to your PATH")
    }
    expect(code).toBeGreaterThan(0)
  }, STEP_TIMEOUT)
})
