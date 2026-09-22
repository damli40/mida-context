import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { SponsorPending } from "@mida/chain"
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
  revoke,
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

  it("a revoke still landing keeps its deny — approve prints the line and clears nothing", async () => {
    await init(runtime, ["codex3"])
    await requestAccess(runtime, "codex3")
    await approve(runtime, "codex3")
    const agentId = loadAgentIdentity(home, "codex3")!.agentId

    // Stage exactly what a revoke ending SPONSOR_PENDING leaves: the active deny plus the marker.
    const { intentId } = await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })
    home.writeSecretJson("agents/codex3/revoke-pending.json", { intentId, userOpHash: `0x${"ab".repeat(32)}`, at: new Date().toISOString() })

    progressLines = []
    await expect(approve(runtime, "codex3")).rejects.toMatchObject({ code: "already-approved" })
    expect(progressLines).toContain("a revoke of codex3 is still landing — not cleared")
    expect(progressLines).not.toContain(CLEARED)
    // The deny survives: the store still refuses the agent whose revoke may be about to land.
    expect((await runtime.ownerApi.listRevocations("active")).map((intent) => intent.intentId)).toContain(intentId)
    await expect(runtime.vault.publishReaderWraps({ agentId, namespaceId: namespaceId("profile.skills") })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(home.has("agents/codex3/revoke-pending.json")).toBe(true)
  })

  it("a pending revoke older than the stale window is called dropped and names the way out", async () => {
    await init(runtime, ["codex9"])
    await requestAccess(runtime, "codex9")
    await approve(runtime, "codex9")
    const agentId = loadAgentIdentity(home, "codex9")!.agentId
    const { intentId } = await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })
    // The marker is 40 minutes old: a bundler-accepted operation that has not landed by now never will.
    const at = new Date(Date.now() - 40 * 60_000).toISOString()
    home.writeSecretJson("agents/codex9/revoke-pending.json", { intentId, userOpHash: `0x${"cd".repeat(32)}`, at })

    progressLines = []
    await expect(approve(runtime, "codex9")).rejects.toMatchObject({ code: "already-approved" })
    const line = progressLines.find((l) => l.startsWith("a revoke of codex9 was accepted "))
    expect(line).toBeDefined()
    expect(line).toContain("has not landed — run `mida revoke codex9` again")
    expect(progressLines).not.toContain("a revoke of codex9 is still landing — not cleared")
    // Still fail-closed: the deny and the marker are left exactly as they were.
    expect((await runtime.ownerApi.listRevocations("active")).map((intent) => intent.intentId)).toContain(intentId)
    expect(home.has("agents/codex9/revoke-pending.json")).toBe(true)
  })

  it("once the pending revoke lands the marker is removed and its deny is left to anchor", async () => {
    await init(runtime, ["codex4"])
    await requestAccess(runtime, "codex4")
    await approve(runtime, "codex4")
    const agentId = loadAgentIdentity(home, "codex4")!.agentId

    const { intentId } = await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })
    home.writeSecretJson("agents/codex4/revoke-pending.json", { intentId, userOpHash: `0x${"cd".repeat(32)}`, at: new Date().toISOString() })

    // The accepted operation lands for real: the owner-agent epoch moves past the recorded one.
    await runtime.vault.approveRevocation({ kind: "agent", agentId })

    progressLines = []
    // codex4 is revoked on chain and holds no pending request, so approve refuses — but only
    // after the stale-deny pass ran: the marker is gone and its deny was left to anchor.
    await expect(approve(runtime, "codex4")).rejects.toMatchObject({ code: "no-pending-request" })
    expect(progressLines).not.toContain("a revoke of codex4 is still landing — not cleared")
    expect(home.has("agents/codex4/revoke-pending.json")).toBe(false)
    // The deny the marker guarded was left for reconcile to anchor — never cancelled.
    const anchored = await runtime.ownerApi.listRevocations("anchored")
    expect(anchored.map((intent) => intent.intentId)).toContain(intentId)
    const cancelled = await runtime.ownerApi.listRevocations("cancelled")
    expect(cancelled.map((intent) => intent.intentId)).not.toContain(intentId)
  })

  it("a revoke ending SPONSOR_PENDING writes the marker naming the deny's intent", async () => {
    await init(runtime, ["codex5"])
    await requestAccess(runtime, "codex5")
    await approve(runtime, "codex5")

    // The vault's deny stays staged on a pending operation; the error carries the intent id.
    const pending = new SponsorPending(`0x${"ef".repeat(32)}` as Hex)
    const intentId = `0x${"12".repeat(32)}` as Hex
    const stubVault = {
      ...runtime.vault,
      approveRevocation: async () => {
        ;(pending as { intentId?: Hex }).intentId = intentId
        throw pending
      },
    }
    const stub = { ...runtime, sendProgress: runtime.sendProgress.bind(runtime), vault: stubVault } as unknown as Runtime
    await expect(revoke(stub, "codex5")).rejects.toMatchObject({ code: "SPONSOR_PENDING" })
    expect(home.readJson("agents/codex5/revoke-pending.json")).toMatchObject({ intentId, userOpHash: pending.userOpHash })
  })

  it("a capability deny whose read fails is named, not silently skipped", async () => {
    await init(runtime, ["codex6"])
    await requestAccess(runtime, "codex6")
    await approve(runtime, "codex6")
    const capabilityId = loadGrants(home, "codex6")[0]!.capabilities[0]!.capabilityId
    const { intentId } = await runtime.ownerApi.requestRevocationDeny({ capabilityId })

    // An RPC hiccup on the capability read must not read as "not this agent": the deny stays
    // standing AND the owner hears which block could not be checked.
    const realGet = runtime.reader.getCapability
    runtime.reader.getCapability = async () => {
      throw new Error("connection reset")
    }
    try {
      progressLines = []
      await expect(approve(runtime, "codex6")).rejects.toMatchObject({ code: "already-approved" })
    } finally {
      runtime.reader.getCapability = realGet
    }
    const line = `could not check one store block (capability ${capabilityId}): connection reset — run \`mida approve codex6\` again`
    expect(progressLines).toContain(line)
    expect(progressLines).not.toContain(CLEARED)
    expect((await runtime.ownerApi.listRevocations("active")).map((intent) => intent.intentId)).toContain(intentId)
  })
})
