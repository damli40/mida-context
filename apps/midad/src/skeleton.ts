import { privateKeyToAccount } from "viem/accounts"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { createWriteContext } from "@mida/chain"
import { provisionAgent } from "@mida/fake-vault"
import { AGENT_PERMISSIONS, NAMESPACE, PURPOSE_ID } from "./runtime.js"
import type { Runtime } from "./runtime.js"
import { FileAccessRequestStore } from "./request-store.js"
import {
  identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadOrCreateOperatorSecrets, loadOrCreateSignerKey,
  markRevoked, replaceSignerKey, saveAgentIdentity, saveGrants,
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
      let signerPrivateKey = loadOrCreateSignerKey(home, name)
      // Unless the crash came after registration: then this signer is bound to an agent whose encryption key was
      // never persisted, and reusing it reverts SignerAlreadyBound. Start over with a fresh key; the orphan is inert.
      if ((await reader.agentIdOfSigner(privateKeyToAccount(signerPrivateKey).address)) !== null) {
        signerPrivateKey = replaceSignerKey(home, name)
      }
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
      runtime.attach(identity)
    }
    // An idempotent PUT, run for every agent on every init: a manifest upload lost to a crash is retried here.
    await runtime.ownerApi.putAgentManifest(identity.manifest)
    await runtime.ensureFunded(privateKeyToAccount(identity.signerPrivateKey).address)
    agents[name] = identity.agentId
  }
  return { owner, agents }
}

/** Spec §5B step 1: the agent asks. The request is on disk before this returns, and so is which request is pending. */
export async function requestAccess(runtime: Runtime, name: string): Promise<{ requestId: Hex }> {
  const identity = loadAgentIdentity(runtime.home, name)
  if (identity !== undefined && (await runtime.reader.hasAuthority(runtime.owner, identity.agentId, NAMESPACE_ID, PERMISSION.READ, 0))) {
    throw new Error(`agent "${name}" is already approved`)
  }
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
  const { home, vault, reader, owner } = runtime
  const identity = loadAgentIdentity(home, name)
  const pending = home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)
  if (identity === undefined || pending === undefined) throw new Error(`agent "${name}" has no pending request; run requestAccess first`)
  const stored = await new FileAccessRequestStore(home, name).load(pending.request.requestId)
  if (stored === undefined || stored.consumed) throw new Error(`agent "${name}" has no pending request; run requestAccess first`)
  if (await reader.hasAuthority(owner, identity.agentId, NAMESPACE_ID, PERMISSION.READ, 0)) {
    throw new Error(`agent "${name}" is already approved`)
  }
  const approval = await vault.approveGrant({ accessRequest: pending.request, manifest: identity.manifest, selection: { kind: "recommended" } })
  const agent = runtime.agent(name)
  const grant = await agent.completeAccessRequest(pending.request, approval.response)
  saveGrants(home, name, [...agent.grants])
  home.remove(`agents/${name}/pending-request.json`)
  return {
    capabilityIds: grant.capabilities.map((capability) => capability.capabilityId),
    permissions: grant.capabilities.map((capability) => capability.permissions),
    transactionHash: approval.response.capabilities[0]!.transactionHash,
    gasUsed: approval.gasUsed,
  }
}

/** Spec §5C steps 4–5 with a hard-coded checkpoint: encrypt, upload, and register on Monad under the agent's own key. */
export async function saveCheckpoint(runtime: Runtime, name: string, input: { projectId: string; checkpoint: Record<string, unknown> }): Promise<{ contextId: Hex; transactionHash: Hex; milliseconds: number }> {
  if (typeof input?.projectId !== "string" || input.projectId === "") throw new Error("projectId must be a non-empty string")
  if (typeof input.checkpoint !== "object" || input.checkpoint === null || Array.isArray(input.checkpoint)) {
    throw new Error("checkpoint must be a plain object")
  }
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
  if (typeof projectId !== "string" || projectId === "") throw new Error("projectId must be a non-empty string")
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

/**
 * Spec §5E, in three crash-safe stages: (1) one owner transaction revokes every capability the agent holds and
 * rotates the read epoch — skipped entirely when the chain shows nothing left to revoke, so a re-run after a
 * crash sends nothing; (2) the local revoked marker; (3) reader wraps republished to every surviving agent.
 * Stage 1 needs no grants.json: the vault's "agent" branch reads the live capability list from Monad itself.
 */
export async function revoke(runtime: Runtime, name: string): Promise<{ transactionHashes: Hex[]; rewrapped: string[] }> {
  const { home, vault, reader, owner } = runtime
  const identity = loadAgentIdentity(home, name)
  if (identity === undefined) throw new Error(`agent "${name}" is not set up on this machine; run init first`)
  const transactionHashes: Hex[] = []
  if ((await reader.activeCapabilityIds(owner, identity.agentId)).length > 0) {
    transactionHashes.push((await vault.approveRevocation({ kind: "agent", agentId: identity.agentId })).transactionHash)
  }
  markRevoked(home, name)
  const rewrapped = await repairReaderWraps(runtime)
  return { transactionHashes, rewrapped }
}

/**
 * Publishes reader wraps for the current read epoch to every agent that still has authority on chain and is not
 * revoked locally. This is revoke's third stage, exported so a crash between the revocation transaction and the
 * rewrap can be repaired without re-sending anything.
 */
export async function repairReaderWraps(runtime: Runtime): Promise<string[]> {
  const { home, vault, reader, owner } = runtime
  const rewrapped: string[] = []
  for (const name of listAgentNames(home)) {
    if (isRevoked(home, name)) continue
    const identity = loadAgentIdentity(home, name)
    if (identity === undefined) continue
    if (!(await reader.hasAuthority(owner, identity.agentId, NAMESPACE_ID, PERMISSION.READ, 0))) continue
    await vault.publishReaderWraps({ agentId: identity.agentId, namespaceId: NAMESPACE_ID })
    rewrapped.push(name)
  }
  return rewrapped
}
