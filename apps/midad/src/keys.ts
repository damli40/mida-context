import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { p256 } from "@noble/curves/nist.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { hexOf } from "@mida/crypto"
import type { Hex, PurposeId, SignedAgentCapabilityManifest } from "@mida/protocol"
import type { ProvisionedAgent } from "@mida/fake-vault"
import type { Grant } from "@mida/sdk"
import type { MidaHome } from "./home.js"

export interface OwnerSecrets { privateKey: Hex; seed: Hex; p256PrivateKey: Hex }
export interface OperatorSecrets { privateKey: Hex }
export interface AgentIdentity {
  name: string
  agentId: Hex
  signerPrivateKey: Hex
  encryptionPrivateKey: Hex
  encryptionPublicKey: Hex
  callbackOrigin: string
  purposeId: PurposeId
  manifest: SignedAgentCapabilityManifest
  manifestHash: Hex
}

const KEY = /^0x[0-9a-f]{64}$/
const NAME = /^[a-z0-9-]+$/

function assertKeys(file: string, record: Record<string, unknown> | undefined, fields: string[]): void {
  for (const field of fields) {
    const value = record?.[field]
    // The message names the file and the field, never the value.
    if (typeof value !== "string" || !KEY.test(value)) throw new Error(`${file}: field "${field}" is missing or is not a 32-byte hex key`)
  }
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`bad agent name: ${name}`)
}

export function loadOrCreateOwnerSecrets(home: MidaHome): OwnerSecrets {
  const file = "owner/secrets.json"
  const existing = home.readJson<Record<string, unknown>>(file)
  if (existing !== undefined) {
    assertKeys(file, existing, ["privateKey", "seed", "p256PrivateKey"])
    return existing as unknown as OwnerSecrets
  }
  const created: OwnerSecrets = { privateKey: generatePrivateKey(), seed: hexOf(randomBytes(32)), p256PrivateKey: hexOf(p256.utils.randomSecretKey()) }
  home.writeSecretJson(file, created)
  return created
}

export function loadOrCreateOperatorSecrets(home: MidaHome): OperatorSecrets {
  const file = "operator/secrets.json"
  const existing = home.readJson<Record<string, unknown>>(file)
  if (existing !== undefined) {
    assertKeys(file, existing, ["privateKey"])
    return existing as unknown as OperatorSecrets
  }
  const created: OperatorSecrets = { privateKey: generatePrivateKey() }
  home.writeSecretJson(file, created)
  return created
}

export function loadOrCreateSignerKey(home: MidaHome, name: string): Hex {
  assertName(name)
  const file = `agents/${name}/signer.json`
  const existing = home.readJson<Record<string, unknown>>(file)
  if (existing !== undefined) {
    assertKeys(file, existing, ["signerPrivateKey"])
    return existing.signerPrivateKey as Hex
  }
  const signerPrivateKey = generatePrivateKey()
  home.writeSecretJson(file, { signerPrivateKey })
  return signerPrivateKey
}

/**
 * Throws away the saved signer key and writes a fresh one. Used when the saved key turns out to be bound to a
 * registration whose encryption key was never persisted: that agent can never read, so a new signer is required.
 */
export function replaceSignerKey(home: MidaHome, name: string): Hex {
  assertName(name)
  const signerPrivateKey = generatePrivateKey()
  home.writeSecretJson(`agents/${name}/signer.json`, { signerPrivateKey })
  return signerPrivateKey
}

export function identityFrom(name: string, signerPrivateKey: Hex, provisioned: ProvisionedAgent): AgentIdentity {
  assertName(name)
  if (privateKeyToAccount(signerPrivateKey).address !== provisioned.signer.address) {
    throw new Error(`agent ${name}: the saved signer key is not the key the agent was registered with`)
  }
  return {
    name,
    agentId: provisioned.agentId,
    signerPrivateKey,
    encryptionPrivateKey: hexOf(provisioned.encryptionPrivateKey),
    encryptionPublicKey: provisioned.encryptionPublicKey,
    callbackOrigin: provisioned.callbackOrigin,
    purposeId: provisioned.purposeId,
    manifest: provisioned.manifest,
    manifestHash: provisioned.manifestHash,
  }
}

export function saveAgentIdentity(home: MidaHome, identity: AgentIdentity): void {
  assertName(identity.name)
  home.writeSecretJson(`agents/${identity.name}/identity.json`, identity)
}

export function loadAgentIdentity(home: MidaHome, name: string): AgentIdentity | undefined {
  assertName(name)
  const file = `agents/${name}/identity.json`
  const identity = home.readJson<Record<string, unknown>>(file)
  if (identity === undefined) return undefined
  assertKeys(file, identity, ["agentId", "signerPrivateKey", "encryptionPrivateKey", "encryptionPublicKey", "manifestHash"])
  if (identity.name !== name) throw new Error(`${file}: field "name" does not match the agent folder`)
  for (const field of ["callbackOrigin", "purposeId"] as const) {
    if (typeof identity[field] !== "string" || identity[field] === "") {
      throw new Error(`${file}: field "${field}" is missing or is not a non-empty string`)
    }
  }
  if (typeof identity.manifest !== "object" || identity.manifest === null) {
    throw new Error(`${file}: field "manifest" is missing or is not an object`)
  }
  return identity as unknown as AgentIdentity
}

export function listAgentNames(home: MidaHome): string[] {
  return home.list("agents").filter((name) => NAME.test(name) && home.has(`agents/${name}/identity.json`)).sort()
}

export function saveGrants(home: MidaHome, name: string, grants: readonly Grant[]): void {
  assertName(name)
  home.writeSecretJson(`agents/${name}/grants.json`, grants)
}

export function loadGrants(home: MidaHome, name: string): Grant[] {
  assertName(name)
  const file = `agents/${name}/grants.json`
  const grants = home.readJson<unknown>(file)
  if (grants === undefined) return []
  if (!Array.isArray(grants)) throw new Error(`${file}: expected an array of grants`)
  for (const entry of grants) {
    const record = (entry ?? {}) as Record<string, unknown>
    for (const field of ["owner", "agentId", "requestId"] as const) {
      if (typeof record[field] !== "string") throw new Error(`${file}: field "${field}" is missing or is not a string`)
    }
    if (!Array.isArray(record.capabilities)) throw new Error(`${file}: field "capabilities" is missing or is not an array`)
  }
  return grants as Grant[]
}

export function markRevoked(home: MidaHome, name: string): void {
  assertName(name)
  home.writeSecretJson(`agents/${name}/revoked.json`, { revoked: true })
}

export function isRevoked(home: MidaHome, name: string): boolean {
  assertName(name)
  return home.has(`agents/${name}/revoked.json`)
}
