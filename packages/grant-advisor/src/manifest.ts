import {
  MidaError,
  PERMISSION,
  PROVENANCE_POLICY,
  assertHex,
  canonicalBytes,
  canonicalizeNamespace,
  manifestBindingTypedData,
} from "@mida/protocol"
import type { AgentCapabilityManifestBody, AgentRecord, Address, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { keccak256 } from "viem"
import { isPurposeId } from "./policy.js"
import { isTypedDataSignedBy } from "./signatures.js"

export const MANIFEST_LIMITS = Object.freeze({ nameBytes: 80, textBytes: 280, purposes: 8, scopeDeclarations: 32 })

const utf8Length = (value: string) => new TextEncoder().encode(value).length

function nfc<T>(value: T): T {
  if (typeof value === "string") return value.normalize("NFC") as T
  if (Array.isArray(value)) return value.map((item) => nfc(item)) as T
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nfc(item)])) as T
  }
  return value
}

function wire(detail: string): never {
  throw new MidaError("INVALID_WIRE", `manifest: ${detail}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[], where: string) {
  if (!isPlainObject(value)) return wire(`${where} must be an object`)
  for (const key of required) if (!Object.hasOwn(value, key)) wire(`${where}.${key} is required`)
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) wire(`${where}.${key} is not allowed`)
  }
  return value
}

function text(value: unknown, min: number, max: number, where: string): string {
  if (typeof value !== "string") return wire(`${where} must be a string`)
  const length = utf8Length(value)
  if (length < min || length > max) wire(`${where} must be ${min}-${max} UTF-8 bytes`)
  return value
}

function uniqueNames(value: unknown, known: Record<string, number>, allowEmpty: boolean, where: string): void {
  if (!Array.isArray(value)) return wire(`${where} must be an array`)
  if (!allowEmpty && value.length === 0) wire(`${where} must be non-empty`)
  const seen = new Set<string>()
  for (const name of value) {
    if (typeof name !== "string" || !Object.hasOwn(known, name)) wire(`${where} has unknown value ${String(name)}`)
    if (seen.has(name)) wire(`${where} has duplicate ${name}`)
    seen.add(name)
  }
}

export function normalizeManifestBody(body: AgentCapabilityManifestBody): AgentCapabilityManifestBody {
  return nfc(body)
}

/** Enforces every §14.1 structural rule and limit on the NFC-normalized body. Sensitivity claims are rejected as unknown keys. */
export function validateManifestBody(input: unknown, now: bigint): asserts input is AgentCapabilityManifestBody {
  const body = exactKeys(nfc(input), ["v", "agentId", "manifestVersion", "name", "purposes", "scopeDeclarations", "issuedAt"], [], "body")
  if (body.v !== 1) wire("v must be 1")
  if (typeof body.agentId !== "string") wire("agentId must be a string")
  assertHex(body.agentId as string, 32)
  if (!Number.isSafeInteger(body.manifestVersion) || (body.manifestVersion as number) < 1) wire("manifestVersion must be an integer >= 1")
  text(body.name, 1, MANIFEST_LIMITS.nameBytes, "name")
  if (!Number.isSafeInteger(body.issuedAt) || (body.issuedAt as number) < 0) wire("issuedAt must be a non-negative integer")
  if (BigInt(body.issuedAt as number) > now) wire("issuedAt is in the future")

  if (!Array.isArray(body.purposes)) return wire("purposes must be an array")
  if (body.purposes.length < 1 || body.purposes.length > MANIFEST_LIMITS.purposes) wire("purposes must have 1-8 entries")
  const declaredPurposes = new Set<string>()
  body.purposes.forEach((entry, index) => {
    const purpose = exactKeys(entry, ["id", "description"], [], `purposes[${index}]`)
    if (typeof purpose.id !== "string" || !isPurposeId(purpose.id)) {
      throw new MidaError("PURPOSE_UNKNOWN", `purposes[${index}].id ${String(purpose.id)}`)
    }
    if (declaredPurposes.has(purpose.id)) wire(`duplicate purpose ${purpose.id}`)
    declaredPurposes.add(purpose.id)
    text(purpose.description, 1, MANIFEST_LIMITS.textBytes, `purposes[${index}].description`)
  })

  if (!Array.isArray(body.scopeDeclarations)) return wire("scopeDeclarations must be an array")
  if (body.scopeDeclarations.length > MANIFEST_LIMITS.scopeDeclarations) wire("scopeDeclarations must have at most 32 entries")
  const declaredPairs = new Set<string>()
  body.scopeDeclarations.forEach((entry, index) => {
    const where = `scopeDeclarations[${index}]`
    const scope = exactKeys(entry, ["purposeId", "namespace", "permissions", "reason"], ["provenancePolicies"], where)
    if (typeof scope.purposeId !== "string" || !declaredPurposes.has(scope.purposeId)) {
      throw new MidaError("PURPOSE_UNKNOWN", `${where}.purposeId is not declared in purposes`)
    }
    if (typeof scope.namespace !== "string" || canonicalizeNamespace(scope.namespace) !== scope.namespace) {
      throw new MidaError("INVALID_NAMESPACE", `${where}.namespace must already be canonical`)
    }
    const pair = `${scope.purposeId} ${scope.namespace}`
    if (declaredPairs.has(pair)) wire(`duplicate declaration ${scope.purposeId}/${scope.namespace}`)
    declaredPairs.add(pair)
    uniqueNames(scope.permissions, PERMISSION, false, `${where}.permissions`)
    if (Object.hasOwn(scope, "provenancePolicies")) {
      uniqueNames(scope.provenancePolicies, PROVENANCE_POLICY, true, `${where}.provenancePolicies`)
    }
    text(scope.reason, 1, MANIFEST_LIMITS.textBytes, `${where}.reason`)
  })
}

export function manifestBodyHash(body: AgentCapabilityManifestBody): Hex {
  return keccak256(canonicalBytes(normalizeManifestBody(body)))
}

export function manifestEnvelopeBytes(envelope: SignedAgentCapabilityManifest): Uint8Array {
  return canonicalBytes({ manifest: normalizeManifestBody(envelope.manifest), operatorSignature: envelope.operatorSignature })
}

export function manifestEnvelopeHash(envelope: SignedAgentCapabilityManifest): Hex {
  return `0x${bytesToHex(sha256(manifestEnvelopeBytes(envelope)))}`
}

export function manifestBindingFor(input: { chainId: bigint; capabilityRegistry: Address; body: AgentCapabilityManifestBody }) {
  return manifestBindingTypedData({
    chainId: input.chainId,
    capabilityRegistry: input.capabilityRegistry,
    bodyHash: manifestBodyHash(input.body),
    agentId: input.body.agentId,
    manifestVersion: BigInt(input.body.manifestVersion),
  })
}

/**
 * §14.1 currentness check. Order: structure, agent identity, version, body hash, operator signature.
 * An envelope is current only when its body hash and version equal the on-chain AgentRecord.
 */
export function verifySignedManifest(input: {
  envelope: SignedAgentCapabilityManifest
  agentRecord: AgentRecord
  chainId: bigint
  capabilityRegistry: Address
  now: bigint
}): { bodyHash: Hex; envelopeHash: Hex } {
  const envelope = exactKeys(input.envelope, ["manifest", "operatorSignature"], [], "envelope")
  if (typeof envelope.operatorSignature !== "string") wire("operatorSignature must be a string")
  const body = input.envelope.manifest
  validateManifestBody(body, input.now)
  const { agentRecord } = input
  if (body.agentId.toLowerCase() !== agentRecord.agentId.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "manifest agentId differs from the registered agent")
  }
  if (body.manifestVersion !== agentRecord.capabilityManifestVersion) {
    throw new MidaError("MANIFEST_STALE", `manifest version ${body.manifestVersion} is not current`)
  }
  const bodyHash = manifestBodyHash(body)
  if (bodyHash !== agentRecord.capabilityManifestHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "manifest body hash differs from the registered commitment")
  }
  const binding = manifestBindingFor({ chainId: input.chainId, capabilityRegistry: input.capabilityRegistry, body })
  if (!isTypedDataSignedBy(binding, input.envelope.operatorSignature, agentRecord.operator)) {
    throw new MidaError("MANIFEST_SIGNATURE_INVALID", "binding is not signed by the registered operator for this chain and registry")
  }
  return { bodyHash, envelopeHash: manifestEnvelopeHash(input.envelope) }
}

/**
 * For GET /agent-manifests/:bodyHash (§14.1): stored bytes must hash to the indexed envelope hash, be canonical,
 * and contain a body whose hash is the requested body hash. The signature is checked later by verifySignedManifest.
 */
export function parseManifestEnvelopeBytes(input: { bytes: Uint8Array; expectedEnvelopeHash: Hex; expectedBodyHash: Hex }): SignedAgentCapabilityManifest {
  if (`0x${bytesToHex(sha256(input.bytes))}` !== input.expectedEnvelopeHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "envelope bytes do not match the indexed envelope hash")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes))
  } catch {
    return wire("envelope bytes are not UTF-8 JSON")
  }
  const envelope = exactKeys(parsed, ["manifest", "operatorSignature"], [], "envelope")
  if (typeof envelope.operatorSignature !== "string" || !isPlainObject(envelope.manifest)) wire("envelope shape")
  const canonical = canonicalBytes(parsed)
  if (canonical.length !== input.bytes.length || canonical.some((byte, index) => byte !== input.bytes[index])) {
    wire("envelope bytes are not RFC 8785 canonical")
  }
  const signed = parsed as SignedAgentCapabilityManifest
  if (manifestBodyHash(signed.manifest) !== input.expectedBodyHash.toLowerCase()) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "envelope body does not hash to the requested body hash")
  }
  return signed
}
