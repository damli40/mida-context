import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import { increaseLocalTime, latestTimestamp } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  AGENT_PERMISSIONS, MidaHome, NAMESPACE, PURPOSE_ID, Runtime, approve, init, loadAgentIdentity,
  loadGrants, loadOrCreateSignerKey, loadOwnerStartBlock, readCheckpoints, requestAccess, revoke, saveCheckpoint,
  saveGrants,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const NAMESPACE_ID = namespaceId(NAMESPACE)
const STEP_TIMEOUT = 120_000
const CHECKPOINT = sampleCheckpoint({ eventId: "cp-a1-0001", objective: "still here after expiry", nextAction: "keep going" })

/**
 * Fix round A on local Anvil, in its own home: expiry-aware approval guards, a revoke that follows the
 * chain's signer mapping rather than a stale grants.json, and a start block that can never hide the
 * owner's real history.
 */
describe("M1 fix round A: expired grants, stale files, impossible scan ranges", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m1-recovery3-")))
    runtime = await Runtime.open(home, network)
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("A1: an expired grant is re-approvable — the raw id list is not proof of approval", async () => {
    await init(runtime, ["coder"])
    const agent = runtime.agent("coder")

    // A grant that expires in under a minute, minted straight through the vault (the C4 custom pattern).
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 45)
    const request = await agent.createAccessRequest({
      purposeId: PURPOSE_ID,
      scopes: [{ namespace: NAMESPACE, permissions: AGENT_PERMISSIONS, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
      capabilityExpiresAt: expiresAt,
    })
    const approval = await runtime.vault.approveGrant({
      accessRequest: request,
      manifest: loadAgentIdentity(home, "coder")!.manifest,
      selection: { kind: "custom", scopes: request.scopes, expiresAt },
    })
    await agent.completeAccessRequest(request, approval.response)
    saveGrants(home, "coder", [...agent.grants])
    expect(await runtime.reader.hasAuthority(runtime.owner, agent.agentId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(true)

    // Move the chain's clock past the grant's expiry. The raw stored list still returns the dead id.
    await increaseLocalTime(network.rpcUrl, 300n)
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, agent.agentId)).not.toEqual([])
    expect(await runtime.reader.hasAuthority(runtime.owner, agent.agentId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)

    // The bug: requestAccess and approve threw "already approved" forever. Both must now succeed.
    await requestAccess(runtime, "coder")
    await approve(runtime, "coder")

    const saved = await saveCheckpoint(runtime, "coder", {
      projectId: "proj-a1", sessionId: "s1", continuesSession: null, compiledBy: "test", checkpoint: CHECKPOINT,
    })
    expect(saved.duplicate).toBe(false)
    const read = await readCheckpoints(runtime, "coder", "proj-a1")
    expect(read.checkpoints.map((c) => c.checkpoint)).toEqual([CHECKPOINT])
  }, STEP_TIMEOUT)

  it("A2: a stale grants.json cannot redirect a revoke — the signer's chain mapping wins", async () => {
    await init(runtime, ["agentx", "agenty"])
    await requestAccess(runtime, "agentx")
    await approve(runtime, "agentx")
    await requestAccess(runtime, "agenty")
    await approve(runtime, "agenty")
    const xId = runtime.agent("agentx").agentId
    const yId = runtime.agent("agenty").agentId

    // A hand-copied folder produces this mix-up: grants.json names agentx's id, signer.json holds
    // agenty's registered key, and identity.json is gone. The chain must decide who gets revoked.
    home.writeSecretJson("agents/mixup/grants.json", loadGrants(home, "agentx"))
    home.writeSecretJson("agents/mixup/signer.json", { signerPrivateKey: loadOrCreateSignerKey(home, "agenty") })

    const result = await revoke(runtime, "mixup")
    expect(result.transactionHashes).toHaveLength(1)
    expect(home.has("agents/mixup/revoked.json")).toBe(true)
    // The chain said the signer belongs to agenty: agenty lost everything, agentx is untouched.
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, yId)).toEqual([])
    expect(await runtime.reader.hasAuthority(runtime.owner, yId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)
    expect(await runtime.reader.hasAuthority(runtime.owner, xId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(true)
  }, STEP_TIMEOUT)

  it("A3: an owner that already transacted but has no start-block file rescans from deploymentBlock", async () => {
    // This home's owner has been transacting since beforeAll. Deleting the file must not let the
    // "head minus margin" shortcut (valid only for a brand-new owner) hide that history.
    await runtime.close()
    home.remove("owner/start-block.json")
    runtime = await Runtime.open(home, network)
    expect(runtime.ownerStartBlock).toBe(network.deployment.deploymentBlock)
    expect(loadOwnerStartBlock(home, network.deployment.chainId)).toBe(network.deployment.deploymentBlock)
    const record = home.readJson<{ registry?: string }>("owner/start-block.json")
    expect(record?.registry).toBe(network.deployment.capabilityRegistry.toLowerCase())
  }, STEP_TIMEOUT)

  it("A3b: a saved start block above the current head is discarded and recomputed", async () => {
    await runtime.close()
    home.writeSecretJson("owner/start-block.json", {
      chainId: network.deployment.chainId.toString(10),
      blockNumber: "999999999999",
      registry: network.deployment.capabilityRegistry,
    })
    runtime = await Runtime.open(home, network)
    // The record named a block the chain has not reached: recomputed by the rule — this owner has
    // already transacted, so the answer is deploymentBlock.
    expect(runtime.ownerStartBlock).toBe(network.deployment.deploymentBlock)
    expect(runtime.ownerStartBlock).toBeLessThanOrEqual(await runtime.ownerChain.publicClient.getBlockNumber())
  }, STEP_TIMEOUT)

  it("A5: an expired grant's re-approval folds each wrap-repair failure to one line (in-41 U-2)", async () => {
    // Re-approving an agent whose READ expired rotates the namespace epoch, after which every
    // surviving reader is re-keyed — and each refusal lands on a progress note carrying the
    // store's own reason text. That text must never paint the terminal.
    await init(runtime, ["coder5", "reader5"])
    // reader5 holds the ordinary live grant BEFORE the expiry exists, so coder5's approve is
    // the one that hits the closed epoch — the rotation and its repair pass run there.
    await requestAccess(runtime, "reader5")
    await approve(runtime, "reader5")

    const agent = runtime.agent("coder5")
    // the chain's clock, not the wall's — earlier tests have already moved Anvil ahead
    const expiresAt = (await latestTimestamp(runtime.ownerChain)) + 45n
    const request = await agent.createAccessRequest({
      purposeId: PURPOSE_ID,
      scopes: [{ namespace: NAMESPACE, permissions: AGENT_PERMISSIONS, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
      capabilityExpiresAt: expiresAt,
    })
    const approval = await runtime.vault.approveGrant({
      accessRequest: request,
      manifest: loadAgentIdentity(home, "coder5")!.manifest,
      selection: { kind: "custom", scopes: request.scopes, expiresAt },
    })
    await agent.completeAccessRequest(request, approval.response)
    saveGrants(home, "coder5", [...agent.grants])
    await increaseLocalTime(network.rpcUrl, 300n)
    await requestAccess(runtime, "coder5")

    // The store refuses every republish but the just-approved agent's own — the grant path
    // itself calls publishReaderWraps internally for it — so a surviving reader's note is
    // what prints.
    const progress: string[] = []
    runtime.progress = (line) => progress.push(line)
    const real = runtime.vault.publishReaderWraps.bind(runtime.vault)
    const spy = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input) => {
      if (input.agentId !== agent.agentId) {
        throw new Error(`store says ${String.fromCharCode(0x1b)}[2J wipe\nforged second line`)
      }
      return real(input)
    })
    try {
      await approve(runtime, "coder5")
    } finally {
      spy.mockRestore()
      runtime.progress = undefined
    }
    const notes = progress.filter((line) => line.startsWith("note: could not send the new key to "))
    expect(notes.length).toBeGreaterThan(0)
    for (const note of notes) {
      expect(note).not.toContain(String.fromCharCode(0x1b))
      expect(note).not.toContain("\n")
      expect(note).toContain("store says [2J wipe")
      expect(note).not.toContain("forged second line")
    }
  }, STEP_TIMEOUT)

  it("A4: a crash between the revoke transaction and the marker still leaves the marker on re-run", async () => {
    await init(runtime, ["crashvictim"])
    await requestAccess(runtime, "crashvictim")
    await approve(runtime, "crashvictim")
    const victimId = runtime.agent("crashvictim").agentId

    // The crash: stage 1's owner transaction landed (the vault call here is exactly that call);
    // the process died before stage 2 could write revoked.json.
    await runtime.vault.approveRevocation({ kind: "agent", agentId: victimId })
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, victimId)).toEqual([])

    // The re-run sees a chain that already shows nothing valid: it sends nothing — but the agent WAS
    // revoked, so the marker must still be written. Only a never-approved agent gets none.
    const result = await revoke(runtime, "crashvictim")
    expect(result.transactionHashes).toEqual([])
    expect(home.has("agents/crashvictim/revoked.json")).toBe(true)
  }, STEP_TIMEOUT)
})
