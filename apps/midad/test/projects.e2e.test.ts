import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { chainFor } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome, Runtime, approve, checkProject, init, loadOrCreateOwnerSecrets, requestAccess, revoke,
} from "@mida/midad"
import type { Network } from "@mida/midad"

const STEP_TIMEOUT = 60_000

/**
 * `approve` on local Anvil with the project list in the loop. The owner transaction count is the
 * evidence: the first approve sends the grant, the second — a new folder for an agent whose
 * capability is already live — sends nothing and only signs a new row into the list. `revoke`
 * then drops that agent's rows while the other agent's keep verifying.
 * Test folders are canonicalised: the list stores realpaths, and macOS's tmpdir is a symlink.
 */
describe("approve() and the owner-signed project list on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let dirA: string
  let dirB: string
  let dirC: string
  let dirD: string

  const mark = (folder: string, projectId: string) => {
    mkdirSync(join(folder, ".mida"), { recursive: true })
    writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
  }

  const ownerTxCount = async () => {
    const client = createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) })
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    return client.getTransactionCount({ address: owner })
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-projects-e2e-")))
    const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "mida-proj-e2e-")))
    for (const [name, id] of [["a", "p-a"], ["b", "p-b"], ["c", "p-c"], ["d", "p-d"]] as const) {
      mark(join(dir, name), id)
    }
    dirA = join(dir, "a"); dirB = join(dir, "b"); dirC = join(dir, "c"); dirD = join(dir, "d")
    const runtime = await Runtime.open(home, network)
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await requestAccess(runtime, "codex")
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT * 4)

  afterAll(async () => {
    await env?.stop()
  })

  it("the first approve grants on chain and signs the project in; a second folder for the same agent sends zero transactions", async () => {
    const runtime = await Runtime.open(home, network)
    try {
      const first = await approve(runtime, "claude-code", dirA)
      expect(first.transactionHash).not.toBeNull()
      expect(first.projectId).toBe("p-a")
      const checked = await checkProject(runtime, { agent: "claude-code", cwd: dirA })
      expect(checked).toMatchObject({ ok: true })

      // the chain already shows a live capability — the second approve only adds a list row
      const before = await ownerTxCount()
      const second = await approve(runtime, "claude-code", dirB)
      expect(second.transactionHash).toBeNull()
      expect(second.projectId).toBe("p-b")
      expect(await ownerTxCount()).toBe(before)
      expect(await checkProject(runtime, { agent: "claude-code", cwd: dirB })).toMatchObject({ ok: true })
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT * 2)

  it("codex gets its own chain grant for its first folder, then a transaction-free row for its second", async () => {
    const runtime = await Runtime.open(home, network)
    try {
      const first = await approve(runtime, "codex", dirC)
      expect(first.transactionHash).not.toBeNull()
      const before = await ownerTxCount()
      const second = await approve(runtime, "codex", dirD)
      expect(second.transactionHash).toBeNull()
      expect(await ownerTxCount()).toBe(before)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT * 2)

  it("revoke drops the agent's project rows and re-signs; the other agent's rows still verify", async () => {
    const runtime = await Runtime.open(home, network)
    try {
      await revoke(runtime, "claude-code")
      expect(await checkProject(runtime, { agent: "claude-code", cwd: dirA })).toEqual({ ok: false, reason: "not-approved" })
      expect(await checkProject(runtime, { agent: "claude-code", cwd: dirB })).toEqual({ ok: false, reason: "not-approved" })
      // codex's rows survived the re-sign — the file still verifies for them
      expect(await checkProject(runtime, { agent: "codex", cwd: dirC })).toMatchObject({ ok: true })
      expect(await checkProject(runtime, { agent: "codex", cwd: dirD })).toMatchObject({ ok: true })
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT * 2)
})
