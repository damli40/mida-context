import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import { bytesOf } from "@mida/crypto"
import { createWriteContext } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { provisionAgent } from "@mida/fake-vault"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  AGENT_PERMISSIONS, MidaHome, NAMESPACE, PURPOSE_ID, Runtime, approve, init, loadAgentIdentity,
  loadOrCreateOperatorSecrets, loadOrCreateSignerKey, loadOwnerStartBlock, readCheckpoints, requestAccess, revoke,
  saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import type { Checkpoint } from "@mida/checkpoint"
import { sampleCheckpoint } from "./helpers.js"

const AGENTS = ["claude-code", "codex"] as const
const NAMESPACE_ID = namespaceId(NAMESPACE)
const CHECKPOINT = sampleCheckpoint({ eventId: "cp-recov-01", objective: "Keep the lights on", nextAction: "Ship it" })
const STEP_TIMEOUT = 120_000

/**
 * The fix-round-B scenarios on local Anvil: every `it` runs in order and shares one owner, one home and one
 * runtime, so earlier tests leave real state (approvals, revocations) that later tests build on.
 */
describe("M0 crash-safety and whole-agent revocation", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime

  const ownerTxCount = () => runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })
  const rebuilt = (name: string, grants: ConstructorParameters<typeof MidaAgent>[0]["grants"]) => {
    const identity = loadAgentIdentity(home, name)!
    const signer = privateKeyToAccount(identity.signerPrivateKey)
    return new MidaAgent({
      agentId: identity.agentId,
      callbackOrigin: identity.callbackOrigin,
      encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
      chain: createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: signer }),
      api: new ContextApiClient({ baseUrl: runtime.apiBaseUrl, account: signer, chainId: network.deployment.chainId, capabilityRegistry: network.deployment.capabilityRegistry }),
      grants,
    })
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-recovery-")))
    runtime = await Runtime.open(home, network)
    await init(runtime, AGENTS)
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("B1: revoke ends every capability the agent holds on chain, not just the ones in grants.json", async () => {
    await requestAccess(runtime, "claude-code")
    await approve(runtime, "claude-code")
    // A second grant straight through the vault and the SDK: two live capabilities on chain, one in grants.json.
    const agent = runtime.agent("claude-code")
    const secondRequest = await agent.createAccessRequest({
      purposeId: PURPOSE_ID,
      scopes: [{ namespace: NAMESPACE, permissions: AGENT_PERMISSIONS, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
    })
    const secondApproval = await runtime.vault.approveGrant({
      accessRequest: secondRequest,
      manifest: loadAgentIdentity(home, "claude-code")!.manifest,
      selection: { kind: "recommended" },
    })
    const secondGrant = await agent.completeAccessRequest(secondRequest, secondApproval.response)
    expect(secondGrant.capabilities).toHaveLength(1)
    expect(loadAgentIdentity(home, "claude-code")!.signerPrivateKey).toMatch(/^0x/)

    const agentId = agent.agentId
    expect(await runtime.reader.hasAuthority(runtime.owner, agentId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(true)
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, agentId)).toHaveLength(2)

    await revoke(runtime, "claude-code")

    expect(await runtime.reader.hasAuthority(runtime.owner, agentId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)
    expect(await runtime.reader.hasAuthority(runtime.owner, agentId, NAMESPACE_ID, PERMISSION.CREATE, PROVENANCE_POLICY.ALLOW_INFERENCE)).toBe(false)

    // An agent rebuilt from the saved identity holding ONLY the second grant is refused on read and on write.
    const ghost = rebuilt("claude-code", [secondGrant])
    await expect(ghost.read(runtime.owner, NAMESPACE)).rejects.toMatchObject({
      code: expect.stringMatching(/^CAPABILITY_(REVOKED|DENIED)$/),
    })
    await expect(
      ghost.create(runtime.owner, NAMESPACE, { value: { checkpoint: CHECKPOINT }, kind: "EPISODE", source: "AGENT_INFERRED" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^CAPABILITY_(REVOKED|DENIED)$/) })
  }, STEP_TIMEOUT)

  it("B2: requestAccess and approve refuse to mint a second live grant", async () => {
    await requestAccess(runtime, "codex")
    await approve(runtime, "codex")

    const before = await ownerTxCount()
    await expect(approve(runtime, "codex")).rejects.toThrow()
    await expect(requestAccess(runtime, "codex")).rejects.toThrow(/already approved/)
    expect(await ownerTxCount()).toBe(before)
  }, STEP_TIMEOUT)

  it("B3a: revoke is safe to re-run — no new owner transaction, survivors still rewrapped", async () => {
    const before = await ownerTxCount()
    const again = await revoke(runtime, "claude-code")
    expect(again.transactionHashes).toEqual([])
    expect(again.rewrapped).toEqual(["codex"])
    expect(await ownerTxCount()).toBe(before)
  }, STEP_TIMEOUT)

  it("B3b: a crash between the revoke transaction and the rewrap leaves no agent stranded", async () => {
    await init(runtime, ["gemini"])
    await requestAccess(runtime, "gemini")
    await approve(runtime, "gemini")

    // The crash: the owner transaction lands, the process dies before reader wraps are republished.
    await runtime.vault.approveRevocation({ kind: "agent", agentId: runtime.agent("gemini").agentId })

    // The rotation already happened: codex writes under the new epoch but cannot read it back.
    await saveCheckpoint(runtime, "codex", { projectId: "proj-crash", sessionId: "s1", continuesSession: null, compiledBy: "test", checkpoint: CHECKPOINT })
    await expect(readCheckpoints(runtime, "codex", "proj-crash")).rejects.toMatchObject({ code: "NO_EPOCH_WRAP" })

    const repair = await revoke(runtime, "gemini")
    expect(repair.transactionHashes).toEqual([])
    expect(repair.rewrapped).toEqual(["codex"])
    const read = await readCheckpoints(runtime, "codex", "proj-crash")
    expect(read.checkpoints.map((c) => c.checkpoint)).toEqual([CHECKPOINT])
  }, STEP_TIMEOUT)

  it("B4: init recovers when a crash orphaned a registered signer key", async () => {
    const crashedHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-orphan-")))
    const crashed = await Runtime.open(crashedHome, network)
    try {
      // Replay the crash: signer.json saved, the agent registered, identity.json never written.
      const orphanKey = loadOrCreateSignerKey(crashedHome, "codex")
      const operatorAccount = privateKeyToAccount(loadOrCreateOperatorSecrets(crashedHome).privateKey)
      await crashed.ensureFunded(operatorAccount.address)
      const operator = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: operatorAccount })
      await provisionAgent({
        operator,
        name: "codex",
        purposeId: PURPOSE_ID,
        declarations: [{ namespace: NAMESPACE, permissions: ["READ", "CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE"] }],
        callbackOrigin: "https://codex.mida.example",
        signer: privateKeyToAccount(orphanKey),
      })

      const result = await init(crashed, ["claude-code", "codex"])
      const identity = loadAgentIdentity(crashedHome, "codex")!
      expect(privateKeyToAccount(identity.signerPrivateKey).address).not.toBe(privateKeyToAccount(orphanKey).address)
      expect(await crashed.reader.getAgent(result.agents.codex!)).toMatchObject({ active: true })
    } finally {
      await crashed.close()
    }
  }, STEP_TIMEOUT)

  it("B5: init republishes the agent manifest on every run, not only on first registration", async () => {
    const identity = loadAgentIdentity(home, "codex")!
    // Simulate a lost manifest upload: the index entry is gone, the identity file still exists.
    rmSync(home.path(`data/agent-manifests/${identity.manifestHash}.json`), { force: true })
    await expect(runtime.ownerApi.getAgentManifest(identity.manifestHash)).rejects.toMatchObject({ code: "MANIFEST_NOT_FOUND" })
    await init(runtime, ["codex"])
    expect(await runtime.ownerApi.getAgentManifest(identity.manifestHash)).toEqual(identity.manifest)
  }, STEP_TIMEOUT)

  it("B7a: Runtime.open releases the server and the lock when startup fails", async () => {
    const failedHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-failopen-")))
    let failed = await Runtime.open(failedHome, network)
    await init(failed, ["codex"])
    const goodIdentity = loadAgentIdentity(failedHome, "codex")!
    await failed.close()

    writeFileSync(failedHome.path("agents/codex/identity.json"), "{not json")
    await expect(Runtime.open(failedHome, network)).rejects.toThrow()
    expect(failedHome.has("midad.lock")).toBe(false)

    failedHome.writeSecretJson("agents/codex/identity.json", goodIdentity)
    failed = await Runtime.open(failedHome, network)
    await failed.close()
  }, STEP_TIMEOUT)

  it("B7b: two runtimes cannot share one home, and a dead pid's lock is taken over", async () => {
    const lockedHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-lock-")))
    const first = await Runtime.open(lockedHome, network)
    // a held lock is now retried for up to 30 s before giving up — shrink the wait for the test
    await expect(Runtime.open(lockedHome, network, { lockWaitMs: 400, lockStepMs: 50 })).rejects.toThrow(/another Mida process/)
    await first.close()
    const second = await Runtime.open(lockedHome, network)
    await second.close()

    const staleHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-stale-")))
    staleHome.writeSecretJson("midad.lock", { pid: 2147483646 })
    const taken = await Runtime.open(staleHome, network)
    await taken.close()
  }, STEP_TIMEOUT)

  it("B8: save and read validate their inputs before any network call", async () => {
    // codex is approved at this point, so without validation these calls would reach the chain or succeed.
    const invalid = { sessionId: "s", continuesSession: null, compiledBy: "t" }
    await expect(saveCheckpoint(runtime, "codex", { projectId: "", ...invalid, checkpoint: CHECKPOINT })).rejects.toThrow(/projectId/)
    await expect(saveCheckpoint(runtime, "codex", { projectId: "proj-x", ...invalid, checkpoint: [] as unknown as Checkpoint })).rejects.toThrow(/checkpoint/)
    await expect(saveCheckpoint(runtime, "codex", { projectId: "proj-x", ...invalid, checkpoint: null as unknown as Checkpoint })).rejects.toThrow(/checkpoint/)
    await expect(readCheckpoints(runtime, "codex", "")).rejects.toThrow(/projectId/)
    await expect(readCheckpoints(runtime, "codex", 5 as unknown as string)).rejects.toThrow(/projectId/)
  }, STEP_TIMEOUT)

  it("C1: the owner's history scan starts at the owner's recorded first block, and survives a restart", async () => {
    // The shared runtime was opened on a fresh home in beforeAll, so its start block was recorded then.
    const saved = loadOwnerStartBlock(home, network.deployment.chainId)
    expect(saved).toBeDefined()
    expect(runtime.ownerStartBlock).toBe(saved)
    expect(runtime.ownerChain.deployment.deploymentBlock).toBe(saved)
    expect(saved!).toBeGreaterThanOrEqual(network.deployment.deploymentBlock)
    expect(saved!).toBeLessThanOrEqual(await runtime.ownerChain.publicClient.getBlockNumber())
    // Every other context keeps the true deployment block.
    expect(runtime.network.deployment.deploymentBlock).toBe(network.deployment.deploymentBlock)

    // Blocks have been mined since the first open, so a recomputed start would differ: equal means it was loaded.
    await runtime.close()
    runtime = await Runtime.open(home, network)
    expect(loadOwnerStartBlock(home, network.deployment.chainId)).toBe(saved)
    expect(runtime.ownerStartBlock).toBe(saved)
    expect(runtime.ownerChain.deployment.deploymentBlock).toBe(saved)
  }, STEP_TIMEOUT)
})
