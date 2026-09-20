import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { privateKeyToAccount } from "viem/accounts"
import { bytesOf } from "@mida/crypto"
import { createWriteContext } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { localEnvironment, monadTestnetEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  AGENT_PERMISSIONS, MidaHome, Runtime, approve, init, loadAgentIdentity, loadGrants, readCheckpoints, requestAccess, revoke, saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"

const ON_TESTNET = process.env.MIDA_E2E_MONAD_TESTNET === "1"
const STEP_TIMEOUT = ON_TESTNET ? 300_000 : 60_000
const AGENTS = ["claude-code", "codex"] as const
const CHECKPOINT = { objective: "Build a rate limiter", nextAction: "Write KeyedLimiter", constraints: ["no timers"] }

describe(`M0 walking skeleton on ${ON_TESTNET ? "Monad testnet" : "local Anvil"}`, () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  let grantGasUsed = ""
  const timings = { save: [] as number[], read: [] as number[] }
  const transactions: Record<string, string> = {}
  const step = (name: string, fn: () => Promise<void>) => it(name, fn, STEP_TIMEOUT)

  beforeAll(async () => {
    env = ON_TESTNET ? await monadTestnetEnvironment() : await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-")))
    runtime = await Runtime.open(home, network)
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  step("1. init registers the owner, opens projects.current, and registers BOTH agents from ONE operator wallet", async () => {
    const result = await init(runtime, AGENTS)
    expect(Object.keys(result.agents).sort()).toEqual(["claude-code", "codex"])
    expect(result.agents["claude-code"]).not.toBe(result.agents.codex)
    for (const name of AGENTS) {
      expect(await runtime.reader.getAgent(result.agents[name]!)).toMatchObject({ active: true })
    }
  })

  step("2. init is safe to run again: same agents, and the owner sends no new transaction", async () => {
    const before = await runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })
    const again = await init(runtime, AGENTS)
    expect(again.agents["claude-code"]).toBe(runtime.agent("claude-code").agentId)
    expect(await runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })).toBe(before)
  })

  step("3. an agent that was never approved can neither save nor read", async () => {
    await expect(saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: CHECKPOINT })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(readCheckpoints(runtime, "codex", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  step("4. the owner approves claude-code with exactly read + add + replace-own", async () => {
    await requestAccess(runtime, "claude-code")
    const approval = await approve(runtime, "claude-code")
    expect(approval.capabilityIds).toHaveLength(1)
    expect(approval.permissions).toEqual([AGENT_PERMISSIONS])
    expect(approval.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
    transactions.grantClaudeCode = approval.transactionHash
    grantGasUsed = approval.gasUsed.toString()
  })

  step("5. claude-code saves a checkpoint; codex, not yet approved, still cannot read it", async () => {
    const saved = await saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: CHECKPOINT })
    expect(saved.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
    timings.save.push(saved.milliseconds)
    transactions.firstSave = saved.transactionHash
    await expect(readCheckpoints(runtime, "codex", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  step("6. RESTART in the middle of an approval: codex asks, the process restarts, the owner approves after it", async () => {
    await saveCheckpoint(runtime, "claude-code", { projectId: "proj-2", checkpoint: { objective: "A different project" } })
    await requestAccess(runtime, "codex")
    await runtime.close()
    runtime = await Runtime.open(home, network)
    const approval = await approve(runtime, "codex")
    expect(approval.permissions).toEqual([AGENT_PERMISSIONS])
    transactions.grantCodex = approval.transactionHash
  })

  step("7. codex reads claude-code's checkpoint, and only for the project it asked about", async () => {
    const read = await readCheckpoints(runtime, "codex", "proj-1")
    expect(read.checkpoints.map((c) => c.checkpoint)).toEqual([CHECKPOINT])
    expect(read.checkpoints[0]!.authorId).toBe(runtime.agent("claude-code").agentId)
    timings.read.push(read.milliseconds)
  })
})
