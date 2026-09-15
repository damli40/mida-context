import { randomBytes } from "@noble/hashes/utils.js"
import { encodeAbiParameters, hexToBytes } from "viem"
import { CRYPTO_VERSION, MAX_PAYLOAD_BYTES, MidaError, canonicalBytes, canonicalJson } from "@mida/protocol"
import type { Address, ContextPayload, Hex } from "@mida/protocol"
import { KEY_BYTES, NONCE_BYTES, open, seal } from "./aead.js"

/** Values every object-level AAD binds (§8.2, §8.3). */
export interface ObjectBinding {
  chainId: bigint
  contextRegistry: Address
  contextId: Hex
  namespaceId: Hex
  readEpoch: bigint
}

const OBJECT_AAD_TYPES = [
  { type: "string" },
  { type: "uint256" },
  { type: "address" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "uint64" },
  { type: "string" },
] as const

function objectAad(tag: string, binding: ObjectBinding): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(OBJECT_AAD_TYPES, [
      tag,
      binding.chainId,
      binding.contextRegistry,
      binding.contextId,
      binding.namespaceId,
      binding.readEpoch,
      CRYPTO_VERSION,
    ]),
  )
}

export function payloadAad(binding: ObjectBinding): Uint8Array {
  return objectAad("MIDA_CONTEXT_PAYLOAD_V1", binding)
}

export function epochDekWrapAad(binding: ObjectBinding): Uint8Array {
  return objectAad("MIDA_EPOCH_DEK_WRAP_V1", binding)
}

export function encodePayload(payload: ContextPayload): Uint8Array {
  const bytes = canonicalBytes(payload)
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new MidaError("PAYLOAD_TOO_LARGE", `${bytes.length} bytes exceeds ${MAX_PAYLOAD_BYTES}`)
  }
  return bytes
}

export function decodePayload(bytes: Uint8Array): ContextPayload {
  let text: string
  let parsed: ContextPayload
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    parsed = JSON.parse(text) as ContextPayload
  } catch {
    throw new MidaError("INVALID_WIRE", "payload is not UTF-8 JSON")
  }
  if (parsed === null || typeof parsed !== "object" || canonicalJson(parsed) !== text || parsed.v !== 1) {
    throw new MidaError("INVALID_WIRE", "payload is not canonical v1 JSON")
  }
  return parsed
}

export interface EncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
  dek: Uint8Array
}

/** §8.2: fresh random DEK and nonce for every object. */
export function encryptPayload(payload: ContextPayload, binding: ObjectBinding): EncryptedPayload {
  const plaintext = encodePayload(payload)
  const dek = randomBytes(KEY_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  return { ciphertext: seal(dek, nonce, payloadAad(binding), plaintext), nonce, dek }
}

export function decryptPayload(encrypted: EncryptedPayload, binding: ObjectBinding): ContextPayload {
  return decodePayload(open(encrypted.dek, encrypted.nonce, payloadAad(binding), encrypted.ciphertext))
}
