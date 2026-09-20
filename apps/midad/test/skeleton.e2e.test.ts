import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { privateKeyToAccount } from "viem/accounts"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { bytesOf } from "@mida/crypto"
import { createWriteContext } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { localEnvironment, monadTestnetEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  AGENT_PERMISSIONS, MidaHome, Runtime, approve, init, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets, readCheckpoints, requestAccess, revoke, saveCheckpoint,
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
  let registeredAgents: Record<string, Hex>
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
    registeredAgents = result.agents
    expect(Object.keys(result.agents).sort()).toEqual(["claude-code", "codex"])
    expect(result.agents["claude-code"]).not.toBe(result.agents.codex)
    for (const name of AGENTS) {
      expect(await runtime.reader.getAgent(result.agents[name]!)).toMatchObject({ active: true })
    }
  })

  step("2. init is safe to run again: same agents, and neither the owner nor the operator sends a new transaction", async () => {
    const operatorAddress = privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey).address
    const ownerBefore = await runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })
    const operatorBefore = await runtime.ownerChain.publicClient.getTransactionCount({ address: operatorAddress })
    const again = await init(runtime, AGENTS)
    expect(again.agents).toEqual(registeredAgents)
    expect(await runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })).toBe(ownerBefore)
    expect(await runtime.ownerChain.publicClient.getTransactionCount({ address: operatorAddress })).toBe(operatorBefore)
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

  step("8. after the restart claude-code can still save, and codex sees the new save", async () => {
    const started = Date.now()
    const saved = await saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: { ...CHECKPOINT, nextAction: "Write the README" } })
    const read = await readCheckpoints(runtime, "codex", "proj-1")
    transactions.saveToReadableMs = String(Date.now() - started)
    timings.save.push(saved.milliseconds)
    timings.read.push(read.milliseconds)
    transactions.saveAfterRestart = saved.transactionHash
    expect(read.checkpoints).toHaveLength(2)
  })

  step("9. ATTACK: an agent rebuilt with a forged grant gets nothing", async () => {
    const identity = loadAgentIdentity(home, "codex")!
    const real = loadGrants(home, "codex")[0]!
    const forgedCapability = { ...real.capabilities[0]!, capabilityId: `0x${"f0".repeat(32)}` as `0x${string}` }
    const signer = privateKeyToAccount(identity.signerPrivateKey)
    const forged = new MidaAgent({
      agentId: identity.agentId,
      callbackOrigin: identity.callbackOrigin,
      encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
      chain: createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: signer }),
      api: new ContextApiClient({ baseUrl: runtime.apiBaseUrl, account: signer, chainId: network.deployment.chainId, capabilityRegistry: network.deployment.capabilityRegistry }),
      grants: [{ ...real, capabilities: [forgedCapability] }],
    })
    await expect(forged.read(runtime.owner, "projects.current")).rejects.toMatchObject({ code: expect.stringMatching(/^(CAPABILITY_DENIED|CAPABILITY_REVOKED|NOT_FOUND)$/) })
  })

  step("10. the owner revokes claude-code: it is refused for reads AND writes", async () => {
    const result = await revoke(runtime, "claude-code")
    expect(result.transactionHashes).toHaveLength(1)
    expect(result.rewrapped).toEqual(["codex"])
    transactions.revokeAndRotate = result.transactionHashes[0]!
    const claudeId = registeredAgents["claude-code"]!
    const current = namespaceId("projects.current")
    expect(await runtime.reader.hasAuthority(runtime.owner, claudeId, current, PERMISSION.READ, 0)).toBe(false)
    expect(await runtime.reader.hasAuthority(runtime.owner, claudeId, current, PERMISSION.CREATE, PROVENANCE_POLICY.ALLOW_INFERENCE)).toBe(false)
    await expect(readCheckpoints(runtime, "claude-code", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    await expect(saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: CHECKPOINT })).rejects.toMatchObject({
      code: expect.stringMatching(/^CAPABILITY_(REVOKED|DENIED)$/),
    })
  })

  step("11. codex is untouched: it still reads everything, and saves under the new key", async () => {
    const saved = await saveCheckpoint(runtime, "codex", { projectId: "proj-1", checkpoint: { objective: "Codex carried on" } })
    transactions.codexSaveAfterRevoke = saved.transactionHash
    const read = await readCheckpoints(runtime, "codex", "proj-1")
    expect(read.checkpoints).toHaveLength(3)
    expect(read.checkpoints.map((c) => c.checkpoint.objective)).toContain("Codex carried on")
  })

  step("12. the revocation survives a restart, and the measurements are written down", async () => {
    await runtime.close()
    runtime = await Runtime.open(home, network)
    await expect(readCheckpoints(runtime, "claude-code", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect((await readCheckpoints(runtime, "codex", "proj-1")).checkpoints).toHaveLength(3)
    const folder = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url))
    mkdirSync(folder, { recursive: true })
    const { saveToReadableMs, ...hashes } = transactions
    writeFileSync(
      `${folder}m0-${ON_TESTNET ? "monad-testnet" : "local-anvil"}.json`,
      JSON.stringify({
        network: env.name, generatedAt: new Date().toISOString(), oneOperatorRegisteredBothAgents: true,
        grantGasUsed, saveMilliseconds: timings.save, readMilliseconds: timings.read,
        saveToReadableMilliseconds: Number(saveToReadableMs), transactions: hashes,
      }, null, 2),
    )
  })
})
