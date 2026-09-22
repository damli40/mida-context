import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { PERMISSION, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { ANVIL_PRIVATE_KEYS, createWriteContext, deployLocal, increaseLocalTime, latestTimestamp, startAnvil } from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, provisionAgent } from "@mida/fake-vault"
import type { ProvisionedAgent } from "@mida/fake-vault"
import { randomBytes } from "@noble/hashes/utils.js"
import { ContextApiClient, DenyOverlay, RegistryReader, authorizeAgent, createContextApi } from "@mida/api"
import type { CapabilityView } from "@mida/api"

const CAREER = namespaceId("goals.career")
const LEARNING = namespaceId("goals.learning")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`

describe("Context API authorization and the deny overlay (plan Task 23)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let reader: RegistryReader
  let overlay: DenyOverlay
  let ownerClient: ContextApiClient
  let strangerClient: ContextApiClient
  let vault: FakeVaultAuthority
  let agentA: ProvisionedAgent
  let agentE: ProvisionedAgent
  let agentN: ProvisionedAgent
  let capabilityA: Hex
  let capabilityE: Hex
  /** Wall-clock override for the API's request/cancellation freshness checks; undefined means real time. */
  let apiNow: bigint | undefined

  const authorize = (agent: ProvisionedAgent, capabilityId: Hex | undefined, extra: { namespaceId?: Hex; permission?: number; agentKeyVersion?: number } = {}) =>
    authorizeAgent({
      reader,
      overlay,
      signer: agent.signer.address.toLowerCase() as Address,
      owner: vault.owner,
      capabilityId,
      namespaceId: extra.namespaceId ?? CAREER,
      permission: extra.permission ?? PERMISSION.READ,
      ...(extra.agentKeyVersion === undefined ? {} : { agentKeyVersion: extra.agentKeyVersion }),
    })

  const grant = async (agent: ProvisionedAgent, selection: Parameters<FakeVaultAuthority["approveGrant"]>[0]["selection"]) => {
    const accessRequest = await buildSignedAccessRequest({ chain: owner, agent, scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    return (await vault.approveGrant({ accessRequest, manifest: agent.manifest, selection })).response.capabilities[0]!.capabilityId
  }

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    reader = new RegistryReader(owner)
    const api = createContextApi({
      reader,
      deployment,
      dataDir: mkdtempSync(join(tmpdir(), "mida-authz-")),
      clock: () => apiNow ?? BigInt(Math.floor(Date.now() / 1000)),
    })
    overlay = api.overlay
    const clientFor = (account: LocalAccount) =>
      new ContextApiClient({
        baseUrl: "http://mida.test",
        account,
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        fetch: async (url, init) => api.app.request(url, init),
      })
    ownerClient = clientFor(owner.account)
    strangerClient = clientFor(privateKeyToAccount(generatePrivateKey()))
    vault = new FakeVaultAuthority({
      seed: SEED,
      p256PrivateKey: P256_KEY,
      chain: owner,
      api: {
        putObject: async () => undefined,
        publishEpochWrap: async () => undefined,
        requestRevocationDeny: (target) =>
          ownerClient.requestRevocationDeny(target),
        cancelRevocation: (intentId, input) => ownerClient.cancelRevocation(intentId, input),
      },
    })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await vault.initializeNamespace("goals.learning")
    const declarations = [
      { namespace: "goals.career", permissions: ["READ" as const] },
      { namespace: "goals.learning", permissions: ["READ" as const] },
    ]
    const provision = (index: number, name: string) =>
      provisionAgent({
        operator: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[index]!) }),
        name,
        purposeId: "career_coaching",
        declarations,
        callbackOrigin: `https://${name.toLowerCase()}.example`,
      })
    agentA = await provision(2, "AgentA")
    agentE = await provision(3, "AgentE")
    agentN = await provision(4, "AgentN")
    capabilityA = await grant(agentA, { kind: "recommended" })
    capabilityE = await grant(agentE, { kind: "custom", scopes: [{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }], expiresAt: (await latestTimestamp(owner)) + 120n })
  }, 240_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("authorizes a live exact READ capability for its own agent", async () => {
    const result = await authorize(agentA, capabilityA, { agentKeyVersion: 1 })
    expect(result.agentId).toBe(agentA.agentId)
  })

  it("step 2: denies a signer that is not a registered agent", async () => {
    const stranger = { ...agentA, signer: privateKeyToAccount(generatePrivateKey()) }
    await expect(authorize(stranger, capabilityA)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("step 3: denies a request that names no capability or another agent's capability", async () => {
    await expect(authorize(agentA, undefined)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, capabilityE)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, hexOf(randomBytes(32)))).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("steps 6–8: wrong namespace, missing permission bit and stale key version each fail closed", async () => {
    await expect(authorize(agentA, capabilityA, { namespaceId: LEARNING })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, capabilityA, { permission: PERMISSION.CREATE })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, capabilityA, { agentKeyVersion: 2 })).rejects.toMatchObject({ code: "WRAP_KEY_VERSION_MISMATCH" })
  })

  it("never lets a stale or lying local view make Monad authorization true", async () => {
    class LyingReader extends RegistryReader {
      override async getCapability(): Promise<CapabilityView> {
        return {
          owner: vault.owner,
          agentId: agentN.agentId,
          namespaceId: CAREER,
          permissions: PERMISSION.READ,
          provenancePolicy: 0,
          issuedAt: 0n,
          expiresAt: 0n,
          agentEpoch: 0n,
          grantedAtReadEpoch: 1n,
          revoked: false,
        }
      }
    }
    await expect(
      authorizeAgent({
        reader: new LyingReader(owner),
        overlay,
        signer: agentN.signer.address.toLowerCase() as Address,
        owner: vault.owner,
        capabilityId: hexOf(randomBytes(32)),
        namespaceId: CAREER,
        permission: PERMISSION.READ,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("POST /revocations requires an authenticated owner of an existing target", async () => {
    await expect(ownerClient.request("POST", "/revocations", { body: { capabilityId: capabilityA }, signed: false })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(strangerClient.request("POST", "/revocations", { body: { capabilityId: capabilityA } })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(ownerClient.request("POST", "/revocations", { body: { agentId: hexOf(randomBytes(32)) } })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a recorded deny blocks at step 4, before namespace and permission checks, while Monad still authorizes", async () => {
    const intent = await ownerClient.request<{ intentId: Hex; state: string; cancellationNonce: string }>("POST", "/revocations", { body: { capabilityId: capabilityA } })
    expect(intent.state).toBe("active")
    await expect(authorize(agentA, capabilityA, { namespaceId: LEARNING, permission: PERMISSION.CREATE })).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect(await reader.hasAuthority(vault.owner, agentA.agentId, CAREER, PERMISSION.READ, 0)).toBe(true)

    // A session signature alone cannot cancel; nor can another passkey or an over-long validity.
    // The API clock is pinned so the five-minute lifetime check sees exactly `now`, never a rolled-over second.
    const now = BigInt(Math.floor(Date.now() / 1000))
    apiNow = now
    try {
      const cancel = (body: unknown) => ownerClient.request<{ state: string }>("POST", `/revocations/${intent.intentId}/cancel`, { body })
      await expect(cancel({})).rejects.toMatchObject({ code: "AUTH_INVALID" })
      const otherVault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: `0x${"4e".repeat(32)}`, chain: owner, api: { putObject: async () => undefined, publishEpochWrap: async () => undefined, requestRevocationDeny: async () => ({ intentId: intent.intentId, cancellationNonce: "1" }), cancelRevocation: async () => ({}) } })
      const nonce = BigInt(intent.cancellationNonce)
      const wrongKey = otherVault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: nonce, expiresAt: now + 120n })
      await expect(cancel({ expiresAt: (now + 120n).toString(), assertion: wrongKey })).rejects.toMatchObject({ code: "AUTH_INVALID" })
      const tooLong = vault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: nonce, expiresAt: now + 301n })
      await expect(cancel({ expiresAt: (now + 301n).toString(), assertion: tooLong })).rejects.toMatchObject({ code: "AUTH_INVALID" })

      const good = { expiresAt: (now + 120n).toString(), assertion: vault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: nonce, expiresAt: now + 120n }) }
      expect((await cancel(good)).state).toBe("cancelled")
      await expect(authorize(agentA, capabilityA)).resolves.toMatchObject({ agentId: agentA.agentId })
      await expect(cancel(good)).rejects.toMatchObject({ code: "REPLAY" })
    } finally {
      apiNow = undefined
    }
  })

  it("a deny anchors only when Monad shows the revocation; without one it stays active", async () => {
    // agentA holds a live capability at this point, so an owner-signed agent deny is accepted; the per-capability
    // revocation below does not bump the owner-agent epoch, so the intent stays "active".
    await ownerClient.request("POST", "/revocations", { body: { agentId: agentA.agentId } })
    await overlay.reconcile(reader)
    expect((await overlay.list()).filter((intent) => intent.target.kind === "agent").map((intent) => intent.state)).toEqual(["active"])

    const approval = await vault.approveRevocation({ kind: "capability", capabilityId: capabilityA })
    expect((await overlay.get(approval.intentId))?.state).toBe("active")
    await overlay.reconcile(reader)
    expect((await overlay.get(approval.intentId))?.state).toBe("anchored")
    await expect(authorize(agentA, capabilityA)).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect((await overlay.list()).filter((intent) => intent.target.kind === "agent").map((intent) => intent.state)).toEqual(["active"])
  })

  it("step 5: expiry, on chain time, fails before namespace and key-version checks", async () => {
    await increaseLocalTime(node.rpcUrl, 200n)
    await expect(authorize(agentE, capabilityE, { namespaceId: LEARNING, agentKeyVersion: 9 })).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" })
    expect((await overlay.list()).filter((intent) => intent.target.kind === "agent").map((intent) => intent.state)).toEqual(["active"])
  })

  it("an agent-target deny intent requires a real owner-agent relationship", async () => {
    // The stranger is authenticated but has never granted to or revoked agentA: no intent may be recorded.
    await expect(strangerClient.request("POST", "/revocations", { body: { agentId: agentA.agentId } })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    // agentN is registered but has no capability from and no revocation by this owner either.
    await expect(ownerClient.request("POST", "/revocations", { body: { agentId: agentN.agentId } })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    // Positive control: the owner granted agentE capabilityE, so the intent is recorded and then cancellable.
    const intent = await ownerClient.request<{ intentId: Hex; state: string; cancellationNonce: string }>("POST", "/revocations", { body: { agentId: agentE.agentId } })
    expect(intent.state).toBe("active")
    const now = BigInt(Math.floor(Date.now() / 1000))
    const expiresAt = now + 120n
    const assertion = vault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: BigInt(intent.cancellationNonce), expiresAt })
    const cancelled = await ownerClient.request<{ state: string }>("POST", `/revocations/${intent.intentId}/cancel`, { body: { expiresAt: expiresAt.toString(), assertion } })
    expect(cancelled.state).toBe("cancelled")
  })

  it("GET /revocations lists only the signer's intents, filters by state, and never carries the nonce", async () => {
    // What exists by now, all owned by this vault's owner: a cancelled capability deny for
    // capabilityA, an anchored one (the real revoke above), an active agent deny for agentA —
    // its epoch never bumped, the capability revoke did not anchor it — and a cancelled agent
    // deny for agentE. The stranger owns none of them.
    const all = await ownerClient.listRevocations()
    expect(all.length).toBeGreaterThanOrEqual(4)
    for (const entry of all) {
      expect(Object.keys(entry).sort()).toEqual(["agentEpochAtIntent", "intentId", "state", "target"])
    }
    const states = await ownerClient.listRevocations("active")
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ state: "active", target: { kind: "agent", agentId: agentA.agentId } })
    const anchored = await ownerClient.listRevocations("anchored")
    expect(anchored.every((intent) => intent.state === "anchored")).toBe(true)
    // another signer's list is empty — no cross-owner leakage
    expect(await strangerClient.listRevocations()).toEqual([])
    expect(await strangerClient.listRevocations("active")).toEqual([])
    // an unknown state is a wire error, not a silently empty list
    await expect(ownerClient.request("GET", "/revocations", { query: { state: "pending" } })).rejects.toMatchObject({ code: "INVALID_WIRE" })
  })
})
