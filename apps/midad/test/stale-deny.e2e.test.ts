import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { namespaceId } from "@mida/protocol"
import { expandScopeInputs } from "@mida/grant-advisor"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  PURPOSE_ID,
  Runtime,
  approve,
  expectedScopesFor,
  init,
  loadAgentIdentity,
  loadGrants,
  requestAccess,
  saveGrants,
} from "@mida/midad"
import type { Network } from "@mida/midad"

const STEP = 90_000
const CLEARED = "cleared a stale block at the store left by a failed revoke"

/**
 * The Sep 22 incident, reproduced: `mida revoke codex` staged a store deny and then died at the
 * gas estimate, so codex stayed approved on chain while the hosted store kept refusing it —
 * and `mida approve codex` answered "already approved" without touching the deny. These runs
 * stage the deny the same way the vault does (POST /revocations), then prove approve now clears
 * it: on the already-approved path AND on the path where a real grant still goes out.
 */
describe("M3-D4: `mida approve` clears a stale store deny", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  let progressLines: string[]

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-d4-")))
    runtime = await Runtime.open(home, network)
    progressLines = []
    runtime.progress = (line) => progressLines.push(line)
  }, 180_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("the already-approved path clears the stale deny and republishes the wraps it was blocking", async () => {
    await init(runtime, ["codex"])
    await requestAccess(runtime, "codex")
    await approve(runtime, "codex")
    const agentId = loadAgentIdentity(home, "codex")!.agentId
    const ns = namespaceId("profile.skills")

    // Stage exactly what a failed revoke leaves: an active agent deny AND an active capability
    // deny for one of codex's live capabilities — both must die, not just the agent one.
    await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })
    const capabilityId = loadGrants(home, "codex")[0]!.capabilities[0]!.capabilityId
    await runtime.ownerApi.requestRevocationDeny({ capabilityId })
    await expect(runtime.vault.publishReaderWraps({ agentId, namespaceId: ns })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })

    progressLines = []
    // codex is approved on chain, so approve still answers already-approved — but only AFTER the
    // stale denies are cancelled and the withheld wraps republished.
    await expect(approve(runtime, "codex")).rejects.toMatchObject({ code: "already-approved" })
    expect(progressLines.filter((line) => line === CLEARED)).toHaveLength(2)
    expect(await runtime.ownerApi.listRevocations("active")).toEqual([])
    await expect(runtime.vault.publishReaderWraps({ agentId, namespaceId: ns })).resolves.toBeDefined()

    // Nothing stale left: a third approve must not print the line again.
    progressLines = []
    await expect(approve(runtime, "codex")).rejects.toMatchObject({ code: "already-approved" })
    expect(progressLines).not.toContain(CLEARED)
  })

  it("the grant path clears the stale deny before the wrap repair, after the grant lands", async () => {
    await init(runtime, ["codex2"])
    const identity = loadAgentIdentity(home, "codex2")!

    // Partially approve codex2: the vault grants ONLY the profile.skills READ scope, so the
    // policy's other two scopes stay missing and approve takes the real grant path.
    const scopeInputs = expectedScopesFor(PURPOSE_ID).filter((scope) => scope.namespace === "profile.skills")
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + 30n * 24n * 60n * 60n
    const request = await runtime.agent("codex2").createAccessRequest({ purposeId: PURPOSE_ID, scopes: scopeInputs, capabilityExpiresAt: expiresAt })
    const partial = await runtime.vault.approveGrant({
      accessRequest: request,
      manifest: identity.manifest,
      selection: { kind: "custom", scopes: expandScopeInputs(scopeInputs), expiresAt },
    })
    const agent = runtime.agent("codex2")
    await agent.completeAccessRequest(request, partial.response)
    saveGrants(home, "codex2", [...agent.grants])

    // A failed revoke stages the deny while codex2 still has scopes to be granted.
    await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId: identity.agentId })

    progressLines = []
    const result = await approve(runtime, "codex2")
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(progressLines).toContain(CLEARED)
    expect(await runtime.ownerApi.listRevocations("active")).toEqual([])
    // The deny was cleared before repair ran, so a fresh wrap publish succeeds under the new grant.
    await expect(runtime.vault.publishReaderWraps({ agentId: identity.agentId, namespaceId: namespaceId("projects.current") })).resolves.toBeDefined()
  })
})
