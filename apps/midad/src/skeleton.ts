import { privateKeyToAccount } from "viem/accounts"
import { PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { createWriteContext } from "@mida/chain"
import { provisionAgent } from "@mida/fake-vault"
import { AGENT_PERMISSIONS, NAMESPACE, PURPOSE_ID } from "./runtime.js"
import type { Runtime } from "./runtime.js"
import {
  identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets, loadOrCreateSignerKey,
  markRevoked, saveAgentIdentity, saveGrants,
} from "./keys.js"

const CHECKPOINT_TYPE = "mida.checkpoint.v0"
const GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60
const NAMESPACE_ID = namespaceId(NAMESPACE)

/** Spec §5A. Every step first asks the chain or the disk whether it is already done, so running it twice is harmless. */
export async function init(runtime: Runtime, agentNames: readonly string[]): Promise<{ owner: Address; agents: Record<string, Hex> }> {
  const { home, network, vault, reader, owner } = runtime
  await runtime.ensureFunded(owner)
  const ownerKey = await reader.ownerP256Key(owner)
  if (ownerKey == null || ownerKey.qx === 0n) await vault.registerOwnerKey()
  if ((await reader.epochPublicKey(owner, NAMESPACE_ID, 1n)) == null) await vault.initializeNamespace(NAMESPACE)

  const operatorAccount = privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey)
  const operator = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: operatorAccount })
  const agents: Record<string, Hex> = {}
  for (const name of agentNames) {
    let identity = loadAgentIdentity(home, name)
    if (identity === undefined) {
      await runtime.ensureFunded(operatorAccount.address)
      // Saved to disk BEFORE the registration transaction: a crash must never leave a registered agent with no key.
      const signerPrivateKey = loadOrCreateSignerKey(home, name)
      const provisioned = await provisionAgent({
        operator,
        name,
        purposeId: PURPOSE_ID,
        declarations: [{ namespace: NAMESPACE, permissions: ["READ", "CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE"] }],
        callbackOrigin: `https://${name}.mida.example`,
        signer: privateKeyToAccount(signerPrivateKey),
      })
      identity = identityFrom(name, signerPrivateKey, provisioned)
      saveAgentIdentity(home, identity)
      await runtime.ownerApi.putAgentManifest(identity.manifest)
      runtime.attach(identity)
    }
    await runtime.ensureFunded(privateKeyToAccount(identity.signerPrivateKey).address)
    agents[name] = identity.agentId
  }
  return { owner, agents }
}

/** Spec §5B step 1: the agent asks. The request is on disk before this returns, and so is which request is pending. */
export async function requestAccess(runtime: Runtime, name: string): Promise<{ requestId: Hex }> {
  const request = await runtime.agent(name).createAccessRequest({
    purposeId: PURPOSE_ID,
    scopes: [{ namespace: NAMESPACE, permissions: AGENT_PERMISSIONS, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
  })
  runtime.home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
  return { requestId: request.requestId }
}

/** Spec §5B steps 3–4: the owner approves the pending request on-chain; the agent checks the result and keeps the grant. */
export async function approve(runtime: Runtime, name: string): Promise<{ capabilityIds: Hex[]; permissions: number[]; transactionHash: Hex; gasUsed: bigint }> {
  const { home, vault } = runtime
  const identity = loadAgentIdentity(home, name)
  const pending = home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)
  if (identity === undefined || pending === undefined) throw new Error(`agent "${name}" has no pending request; run requestAccess first`)
  const approval = await vault.approveGrant({ accessRequest: pending.request, manifest: identity.manifest, selection: { kind: "recommended" } })
  const agent = runtime.agent(name)
  const grant = await agent.completeAccessRequest(pending.request, approval.response)
  saveGrants(home, name, [...agent.grants])
  return {
    capabilityIds: grant.capabilities.map((capability) => capability.capabilityId),
    permissions: grant.capabilities.map((capability) => capability.permissions),
    transactionHash: approval.response.capabilities[0]!.transactionHash,
    gasUsed: approval.gasUsed,
  }
}

/** Spec §5C steps 4–5 with a hard-coded checkpoint: encrypt, upload, and register on Monad under the agent's own key. */
export async function saveCheckpoint(runtime: Runtime, name: string, input: { projectId: string; checkpoint: Record<string, unknown> }): Promise<{ contextId: Hex; transactionHash: Hex; milliseconds: number }> {
  const started = Date.now()
  const object = await runtime.agent(name).create(runtime.owner, NAMESPACE, {
    value: { type: CHECKPOINT_TYPE, projectId: input.projectId, compiledBy: "m0-hardcoded", checkpoint: input.checkpoint },
    kind: "EPISODE",
    source: "AGENT_INFERRED",
    tags: ["mida-checkpoint"],
  })
  return { contextId: object.contextId, transactionHash: object.transactionHash!, milliseconds: Date.now() - started }
}

/** Spec §5D steps 2–3: a full protocol read as this agent, then keep only this project's checkpoints. */
export async function readCheckpoints(runtime: Runtime, name: string, projectId: string): Promise<{ checkpoints: Array<{ contextId: Hex; authorId: Hex; checkpoint: Record<string, unknown> }>; milliseconds: number }> {
  const started = Date.now()
  const objects = await runtime.agent(name).read(runtime.owner, NAMESPACE)
  const checkpoints = objects.flatMap((object) => {
    const value = object.payload.value
    if (typeof value !== "object" || value === null) return []
    const record = value as Record<string, unknown>
    if (record.type !== CHECKPOINT_TYPE || record.projectId !== projectId) return []
    return [{ contextId: object.contextId, authorId: object.authorId, checkpoint: record.checkpoint as Record<string, unknown> }]
  })
  return { checkpoints, milliseconds: Date.now() - started }
}

/** Spec §5E: refuse at once locally, revoke and rotate the key on Monad, then hand the new key to everyone still approved. */
export async function revoke(runtime: Runtime, name: string): Promise<{ transactionHashes: Hex[]; rewrapped: string[] }> {
  const { home, vault, ownerApi } = runtime
  const capabilityIds = loadGrants(home, name).flatMap((grant) => grant.capabilities.map((capability) => capability.capabilityId))
  if (capabilityIds.length === 0) throw new Error(`agent "${name}" has no grant to revoke`)
  for (const capabilityId of capabilityIds) await ownerApi.requestRevocationDeny({ capabilityId })
  const transactionHashes: Hex[] = []
  for (const capabilityId of capabilityIds) transactionHashes.push((await vault.approveRevocation({ kind: "capability", capabilityId })).transactionHash)
  markRevoked(home, name)
  const rewrapped: string[] = []
  for (const other of listAgentNames(home)) {
    if (other === name || isRevoked(home, other) || loadGrants(home, other).length === 0) continue
    await vault.publishReaderWraps({ agentId: loadAgentIdentity(home, other)!.agentId, namespaceId: NAMESPACE_ID })
    rewrapped.push(other)
  }
  return { transactionHashes, rewrapped }
}
