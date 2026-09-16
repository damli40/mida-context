import { CRYPTO_VERSION, MidaError, assertHex, decodeUint64 } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"

/** PUT /objects body (§12.2). `capabilityId` names the agent's exact capability; owners omit it. */
export interface ObjectUploadBody {
  owner: Address
  namespaceId: Hex
  objectNonce: Hex
  expectedParentId: Hex
  manifest: ObjectManifest
  ciphertext: Hex
  capabilityId?: Hex
}

/** One element of GET /objects (§12.3). Clients re-check both commitments against Monad before decrypting. */
export interface AnchoredObject {
  contextId: Hex
  owner: Address
  namespaceId: Hex
  authorId: Hex
  manifest: ObjectManifest
  manifestHash: Hex
  ciphertext: Hex
}

function wire(detail: string): never {
  throw new MidaError("INVALID_WIRE", detail)
}

function object(value: unknown, where: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return wire(`${where} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of keys) if (!Object.hasOwn(record, key)) wire(`${where}.${key} is required`)
  for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) wire(`${where}.${key} is not allowed`)
  return record
}

export function hex(value: unknown, bytes: number, where: string): Hex {
  if (typeof value !== "string") return wire(`${where} must be a string`)
  try {
    return assertHex(value, bytes)
  } catch {
    return wire(`${where} must be lowercase 0x hex of ${bytes} bytes`)
  }
}

export function address(value: unknown, where: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) return wire(`${where} must be a lowercase address`)
  return value as Address
}

function uint64(value: unknown, where: string): string {
  if (typeof value !== "string") return wire(`${where} must be a base-10 string`)
  decodeUint64(value)
  return value
}

export function parseObjectManifest(value: unknown): ObjectManifest {
  const manifest = object(value, "manifest", ["v", "contextId", "ciphertextHash", "ciphertextSize", "payloadNonce", "cryptoVersion", "readEpoch", "epochDekWrap"])
  if (manifest.v !== 1) wire("manifest.v must be 1")
  if (manifest.cryptoVersion !== CRYPTO_VERSION) wire(`manifest.cryptoVersion must be ${CRYPTO_VERSION}`)
  if (!Number.isSafeInteger(manifest.ciphertextSize) || (manifest.ciphertextSize as number) < 0) wire("manifest.ciphertextSize must be a non-negative integer")
  const wrap = object(manifest.epochDekWrap, "manifest.epochDekWrap", ["v", "contextId", "namespaceId", "readEpoch", "ephemeralPublicKey", "nonce", "wrappedDek"])
  if (wrap.v !== 1) wire("manifest.epochDekWrap.v must be 1")
  return {
    v: 1,
    contextId: hex(manifest.contextId, 32, "manifest.contextId"),
    ciphertextHash: hex(manifest.ciphertextHash, 32, "manifest.ciphertextHash"),
    ciphertextSize: manifest.ciphertextSize as number,
    payloadNonce: hex(manifest.payloadNonce, 24, "manifest.payloadNonce"),
    cryptoVersion: CRYPTO_VERSION,
    readEpoch: uint64(manifest.readEpoch, "manifest.readEpoch"),
    epochDekWrap: {
      v: 1,
      contextId: hex(wrap.contextId, 32, "epochDekWrap.contextId"),
      namespaceId: hex(wrap.namespaceId, 32, "epochDekWrap.namespaceId"),
      readEpoch: uint64(wrap.readEpoch, "epochDekWrap.readEpoch"),
      ephemeralPublicKey: hex(wrap.ephemeralPublicKey, 32, "epochDekWrap.ephemeralPublicKey"),
      nonce: hex(wrap.nonce, 24, "epochDekWrap.nonce"),
      wrappedDek: hex(wrap.wrappedDek, 48, "epochDekWrap.wrappedDek"),
    },
  }
}

export function parseObjectUpload(value: unknown): ObjectUploadBody {
  const body = object(value, "upload", ["owner", "namespaceId", "objectNonce", "expectedParentId", "manifest", "ciphertext"], ["capabilityId"])
  if (typeof body.ciphertext !== "string" || !/^0x([0-9a-f]{2})*$/.test(body.ciphertext)) wire("ciphertext must be lowercase 0x hex")
  return {
    owner: address(body.owner, "owner"),
    namespaceId: hex(body.namespaceId, 32, "namespaceId"),
    objectNonce: hex(body.objectNonce, 32, "objectNonce"),
    expectedParentId: hex(body.expectedParentId, 32, "expectedParentId"),
    manifest: parseObjectManifest(body.manifest),
    ciphertext: body.ciphertext as Hex,
    ...(body.capabilityId === undefined ? {} : { capabilityId: hex(body.capabilityId, 32, "capabilityId") }),
  }
}

/** §12.4 step 6: every wrap field present, correctly typed and of the exact byte length. */
export function parseReaderWrap(value: unknown): ReaderEpochWrap {
  const wrap = object(value, "wrap", [
    "v", "owner", "namespaceId", "readEpoch", "agentId", "agentKeyVersion", "ephemeralPublicKey", "nonce", "wrappedEpochPrivateKey", "createdAt",
  ])
  if (wrap.v !== 1) wire("wrap.v must be 1")
  if (!Number.isSafeInteger(wrap.agentKeyVersion) || (wrap.agentKeyVersion as number) < 1 || (wrap.agentKeyVersion as number) > 0xffffffff) {
    wire("wrap.agentKeyVersion must be a uint32 of at least 1")
  }
  return {
    v: 1,
    owner: address(wrap.owner, "wrap.owner"),
    namespaceId: hex(wrap.namespaceId, 32, "wrap.namespaceId"),
    readEpoch: uint64(wrap.readEpoch, "wrap.readEpoch"),
    agentId: hex(wrap.agentId, 32, "wrap.agentId"),
    agentKeyVersion: wrap.agentKeyVersion as number,
    ephemeralPublicKey: hex(wrap.ephemeralPublicKey, 32, "wrap.ephemeralPublicKey"),
    nonce: hex(wrap.nonce, 24, "wrap.nonce"),
    wrappedEpochPrivateKey: hex(wrap.wrappedEpochPrivateKey, 48, "wrap.wrappedEpochPrivateKey"),
    createdAt: uint64(wrap.createdAt, "wrap.createdAt"),
  }
}
