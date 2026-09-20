import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome, NAMESPACE, PURPOSE_ID, Runtime, approve, init, loadAgentIdentity, readCheckpoints, requestAccess, revoke,
  saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import type { Checkpoint } from "@mida/checkpoint"
import { sampleCheckpoint } from "./helpers.js"

const NAMESPACE_ID = namespaceId(NAMESPACE)
const STEP_TIMEOUT = 120_000
const CHECKPOINT_V1 = sampleCheckpoint({ eventId: "cp-c2-v001", objective: "before the rotation", nextAction: "first" })
const CHECKPOINT_V2 = sampleCheckpoint({ eventId: "cp-c2-v002", objective: "after the rotation", nextAction: "second" })
const envelope = (checkpoint: Checkpoint) => ({ projectId: "proj-c2", sessionId: "s1", continuesSession: null, compiledBy: "test", checkpoint })

/**
 * Fix round C2 on local Anvil, in its own home: the revoked marker, a missing identity file and the
 * already-approved guards must all defer to what the chain says, never to stale local files.
 */
describe("M0 fix round C2: local files never outrank the chain", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime

  const approveAgent = async (name: string) => {
    await requestAccess(runtime, name)
    await approve(runtime, name)
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-recovery2-")))
    runtime = await Runtime.open(home, network)
    await init(runtime, ["claude-code", "codex", "probe", "ghost"])
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("C2: a re-approved agent still gets reader wraps after the next rotation", async () => {
    await approveAgent("claude-code")
    await approveAgent("codex")
    await approveAgent("probe")
    await saveCheckpoint(runtime, "codex", envelope(CHECKPOINT_V1))

    // claude-code is revoked — the marker is written — then approved again. The marker must not survive approval.
    await revoke(runtime, "claude-code")
    expect(home.has("agents/claude-code/revoked.json")).toBe(true)
    await approveAgent("claude-code")
    expect(home.has("agents/claude-code/revoked.json")).toBe(false)

    // probe's revocation rotates the read epoch; every agent the chain still says has READ must be rewrapped.
    const repair = await revoke(runtime, "probe")
    expect(repair.rewrapped).toEqual(["claude-code", "codex"])

    await saveCheckpoint(runtime, "codex", envelope(CHECKPOINT_V2))
    const read = await readCheckpoints(runtime, "claude-code", "proj-c2")
    expect(read.checkpoints.map((c) => c.checkpoint)).toEqual([CHECKPOINT_V1, CHECKPOINT_V2])
  }, STEP_TIMEOUT)

  it("C2b: revoking a never-approved agent sends nothing and writes no marker", async () => {
    const result = await revoke(runtime, "ghost")
    expect(result.transactionHashes).toEqual([])
    expect(home.has("agents/ghost/revoked.json")).toBe(false)
  }, STEP_TIMEOUT)

  it("C3: revoke finds the agent id in grants.json or the signer when identity.json is gone", async () => {
    // Fallback two: identity.json deleted, grants.json still names the agentId.
    await init(runtime, ["solo"])
    await approveAgent("solo")
    const soloId = runtime.agent("solo").agentId
    home.remove("agents/solo/identity.json")
    const solo = await revoke(runtime, "solo")
    expect(solo.transactionHashes).toHaveLength(1)
    expect(await runtime.reader.hasAuthority(runtime.owner, soloId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, soloId)).toEqual([])

    // Fallback three: grants.json gone too, so the registered signer key maps back to the agent on chain.
    await init(runtime, ["duo"])
    await approveAgent("duo")
    const duoId = runtime.agent("duo").agentId
    home.remove("agents/duo/identity.json")
    home.remove("agents/duo/grants.json")
    const duo = await revoke(runtime, "duo")
    expect(duo.transactionHashes).toHaveLength(1)
    expect(await runtime.reader.hasAuthority(runtime.owner, duoId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, duoId)).toEqual([])

    // A damaged identity.json is treated the same as a missing one: the fallbacks still revoke.
    await init(runtime, ["trio"])
    await approveAgent("trio")
    const trioId = runtime.agent("trio").agentId
    writeFileSync(home.path("agents/trio/identity.json"), "{not json")
    const trio = await revoke(runtime, "trio")
    expect(trio.transactionHashes).toHaveLength(1)
    expect(await runtime.reader.hasAuthority(runtime.owner, trioId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)
  }, STEP_TIMEOUT)

  it("C4: the already-approved guards see any live capability, not only READ", async () => {
    await init(runtime, ["scribe"])
    const agent = runtime.agent("scribe")
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60)
    const request = await agent.createAccessRequest({
      purposeId: PURPOSE_ID,
      scopes: [{ namespace: NAMESPACE, permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
      capabilityExpiresAt: expiresAt,
    })
    // A CREATE-only capability is minted straight through the vault: no READ anywhere on chain.
    await runtime.vault.approveGrant({
      accessRequest: request,
      manifest: loadAgentIdentity(home, "scribe")!.manifest,
      selection: { kind: "custom", scopes: request.scopes, expiresAt },
    })
    expect(await runtime.reader.hasAuthority(runtime.owner, agent.agentId, NAMESPACE_ID, PERMISSION.READ, 0)).toBe(false)
    expect(await runtime.reader.activeCapabilityIds(runtime.owner, agent.agentId)).not.toEqual([])

    await expect(requestAccess(runtime, "scribe")).rejects.toThrow(/already approved/)

    home.writeSecretJson("agents/scribe/pending-request.json", { request })
    await expect(approve(runtime, "scribe")).rejects.toThrow(/already approved/)
  }, STEP_TIMEOUT)
})
