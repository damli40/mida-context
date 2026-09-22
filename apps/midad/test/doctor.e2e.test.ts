import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { Server as HttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { increaseLocalTime } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  approve,
  init,
  installClaudeCode,
  installCodex,
  loadAgentIdentity,
  loadOrCreateOwnerSecrets,
  requestAccess,
  revoke,
  runDoctor,
  startDaemon,
  startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"

const STEP_TIMEOUT = 60_000

/**
 * The hook binaries the doctor resolves — the repo's own sources, named absolutely since the
 * install no longer writes a bare name the hook's shell would have to find on PATH (R5-7).
 */

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
      // no PATH needed for the hooks — the commands name the entry files absolutely
      env: {},
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
    expect(lines).toContain("ok: store blocks nobody who is approved")
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
    await runDoctor({ home: home2, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
    const agentLine = lines.find((line) => line.includes("doomed-agent"))
    expect(agentLine).toContain("revoked")
    expect(agentLine).not.toContain("never asked")
  }, STEP_TIMEOUT)

  it("a stale store deny on an approved agent is a PROBLEM that names `mida approve` — and approve clears it (M3-D4)", async () => {
    // The incident's shape, staged the way the vault stages it: an ACTIVE deny intent for codex
    // whose revoke never landed on chain — doctor must not answer "ok: codex approved" alone.
    const secrets = loadOrCreateOwnerSecrets(home)
    const ownerAccount = privateKeyToAccount(secrets.privateKey)
    const ownerApi = new ContextApiClient({
      baseUrl: apiServer.baseUrl,
      account: ownerAccount,
      chainId: env.deployment.chainId,
      capabilityRegistry: env.deployment.capabilityRegistry,
    })
    const codexId = loadAgentIdentity(home, "codex")!.agentId
    await ownerApi.requestRevocationDeny({ owner: ownerAccount.address, agentId: codexId })

    const { lines, code } = await doctor()
    expect(lines).toContain("ok: codex approved")
    expect(lines).toContain("PROBLEM: the store still blocks codex after a failed revoke — run `mida approve codex`")
    expect(lines).not.toContain("ok: store blocks nobody who is approved")
    // claude-code's deny list is clean — only codex's name appears in a store PROBLEM
    expect(lines.filter((line) => line.startsWith("PROBLEM: the store still blocks"))).toHaveLength(1)
    expect(code).toBe(1)

    // the fix the line names actually works: approve clears the deny, the next doctor is clean
    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await expect(approve(runtime, "codex")).rejects.toMatchObject({ code: "already-approved" })
    } finally {
      await runtime.close()
    }
    const after = await doctor()
    expect(after.lines).toContain("ok: store blocks nobody who is approved")
  }, STEP_TIMEOUT * 2)

  it("an unreachable store is a note, never the 'ok' line (M3-D4)", async () => {
    // Point the home's persisted store at a dead port — the check cannot claim the store blocks
    // nobody when it could not ask, and must not fail the whole run either.
    const networkFile = home.path("network.json")
    const original = readFileSync(networkFile, "utf8")
    const stored = JSON.parse(original) as Record<string, unknown>
    try {
      writeFileSync(networkFile, JSON.stringify({ ...stored, storageUrl: "http://127.0.0.1:1" }))
      const { lines } = await doctor()
      const storeLine = lines.find((line) => line.includes("stale denies") || line.includes("store blocks"))
      expect(storeLine).toBeDefined()
      expect(storeLine).toMatch(/^note:/)
      expect(lines).not.toContain("ok: store blocks nobody who is approved")
      expect(lines.some((line) => line.startsWith("PROBLEM: the store still blocks"))).toBe(false)
    } finally {
      writeFileSync(networkFile, original)
    }
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

  it("(g) a working sponsor turns the wallet line into 'gas is sponsored'; a dead one restores the balance problem", async () => {
    // M3-D3 item 3 — the Sep 22 defect: doctor printed "PROBLEM: owner's wallet is below the gas
    // top-up line" while a sponsor was configured and answering. This home's owner was never
    // funded — 0 MON — so the ONLY thing that can make the wallet line ok is the sponsor.
    const sponsor: HttpServer = createHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ name: "mida-gas-sponsor" }))
    })
    try {
      const sponsorUrl = await new Promise<string>((resolve, reject) => {
        sponsor.once("error", reject)
        sponsor.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(sponsor.address() as { port: number }).port}`))
      })
      const sponsoredHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-doctor-sponsored-")))
      loadOrCreateOwnerSecrets(sponsoredHome) // a fresh owner — 0 MON on this chain
      const deployment = {
        ...env.deployment,
        chainId: env.deployment.chainId.toString(),
        deploymentBlock: env.deployment.deploymentBlock.toString(),
      }
      sponsoredHome.writeSecretJson("network.json", { rpcUrl: env.rpcUrl, deployment, sponsorUrl })
      const up: string[] = []
      await runDoctor({ home: sponsoredHome, print: (line) => up.push(line), env: {}, daemonProbeMs: 50 })
      // M3-D6: reachable names the host and keeps the wallet as a fallback — a 2xx never proved willingness
      expect(up).toContain(`ok: gas is sponsored by ${new URL(sponsorUrl).host} — wallet holds 0.0000 MON (kept as a fallback)`)
      expect(up).toContain(`ok: gas sponsor reachable at ${new URL(sponsorUrl).host} (willingness is only proven by a real send)`)
      expect(up.some((line) => line.includes("below the gas top-up line"))).toBe(false)

      // Same wallet, sponsor no longer answering: the balance matters again — the self-paid
      // fallback is what would have to carry the next send.
      sponsoredHome.writeSecretJson("network.json", { rpcUrl: env.rpcUrl, deployment, sponsorUrl: "http://127.0.0.1:1" })
      const down: string[] = []
      await runDoctor({ home: sponsoredHome, print: (line) => down.push(line), env: {}, daemonProbeMs: 50 })
      expect(down.some((line) => line.startsWith("PROBLEM: owner's wallet is below the gas top-up line"))).toBe(true)
      expect(down.some((line) => line.includes("gas is sponsored"))).toBe(false)
    } finally {
      await new Promise<void>((done) => sponsor.close(() => done()))
    }
  }, STEP_TIMEOUT)

  it("(f) the hook binaries resolve to the repo's own files — no PATH needed (R5-7)", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "mida-doctor-path-"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": claudeSettings, codex: codexConfig },
      env: { PATH: emptyPath },
      daemonProbeMs: 50,
    })
    for (const command of ["mida-hook", "mida-inject"]) {
      const line = lines.find((l) => l.includes(`${command} resolves to`))
      expect(line).toBeDefined()
      expect(line).toContain("ok:")
      // the file the settings name is the repo's own entry source, absolutely
      expect(line).toMatch(/resolves to \//)
    }
  }, STEP_TIMEOUT)
})
