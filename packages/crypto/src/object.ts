import { sha256 } from "@noble/hashes/sha2.js"
import { keccak256 } from "viem"
import { CRYPTO_VERSION, MidaError, canonicalBytes, decodeUint64, encodeUint64 } from "@mida/protocol"
import type { ContextPayload, EpochDEKWrap, Hex, ObjectManifest } from "@mida/protocol"
import { NONCE_BYTES } from "./aead.js"
import { bytesOf, hexOf } from "./bytes.js"
import { decryptPayload, encryptPayload } from "./payload.js"
import type { ObjectBinding } from "./payload.js"
import { unwrapDekFromEpoch, wrapDekToEpoch } from "./wraps.js"

/** §9.1: ciphertextHash = SHA256(ciphertextBytes). */
export function ciphertextHash(ciphertext: Uint8Array): Hex {
  return hexOf(sha256(ciphertext))
}

/** §9.1: manifestHash = keccak256(RFC 8785 canonical manifest bytes). */
export function manifestHash(manifest: ObjectManifest): Hex {
  return keccak256(canonicalBytes(manifest))
}

export function buildObjectManifest(input: {
  contextId: Hex
  ciphertext: Uint8Array
  payloadNonce: Uint8Array
  readEpoch: bigint
  epochDekWrap: EpochDEKWrap
}): ObjectManifest {
  return {
    v: 1,
    contextId: input.contextId,
    ciphertextHash: ciphertextHash(input.ciphertext),
    ciphertextSize: input.ciphertext.length,
    payloadNonce: hexOf(input.payloadNonce),
    cryptoVersion: CRYPTO_VERSION,
    readEpoch: encodeUint64(input.readEpoch),
    epochDekWrap: input.epochDekWrap,
  }
}

/**
 * Checks, in order: the manifest matches its on-chain commitment, its embedded wrap belongs to the same
 * object and epoch, and the ciphertext bytes match the committed hash and size. Runs before any decryption.
 */
export function verifyObjectManifest(input: {
  manifest: ObjectManifest
  expectedManifestHash: Hex
  ciphertext: Uint8Array
}): void {
  const { manifest } = input
  if (manifestHash(manifest) !== input.expectedManifestHash) {
    throw new MidaError("MANIFEST_MISMATCH", "manifest does not match its commitment")
  }
  if (
    manifest.v !== 1 ||
    manifest.cryptoVersion !== CRYPTO_VERSION ||
    manifest.epochDekWrap.contextId !== manifest.contextId ||
    manifest.epochDekWrap.readEpoch !== manifest.readEpoch
  ) {
    throw new MidaError("MANIFEST_MISMATCH", "manifest fields are inconsistent")
  }
  if (manifest.ciphertextSize !== input.ciphertext.length || ciphertextHash(input.ciphertext) !== manifest.ciphertextHash) {
    throw new MidaError("CONTENT_HASH_MISMATCH", "ciphertext does not match the manifest")
  }
}

export interface SealedContextObject {
  ciphertext: Uint8Array
  manifest: ObjectManifest
  manifestHash: Hex
  ciphertextCommitment: Hex
}

/** Encrypts a payload and wraps its DEK to the epoch public key. Needs only the public key (§7.1 CREATE). */
export function sealContextObject(input: {
  payload: ContextPayload
  binding: ObjectBinding
  epochPublicKey: Uint8Array
}): SealedContextObject {
  const encrypted = encryptPayload(input.payload, input.binding)
  const epochDekWrap = wrapDekToEpoch({ dek: encrypted.dek, epochPublicKey: input.epochPublicKey, binding: input.binding })
  encrypted.dek.fill(0)
  const manifest = buildObjectManifest({
    contextId: input.binding.contextId,
    ciphertext: encrypted.ciphertext,
    payloadNonce: encrypted.nonce,
    readEpoch: input.binding.readEpoch,
    epochDekWrap,
  })
  return {
    ciphertext: encrypted.ciphertext,
    manifest,
    manifestHash: manifestHash(manifest),
    ciphertextCommitment: manifest.ciphertextHash,
  }
}

/** Verifies commitments, unwraps the DEK with the epoch private key, and decrypts (§7.1 READ). */
export function openContextObject(input: {
  manifest: ObjectManifest
  expectedManifestHash: Hex
  ciphertext: Uint8Array
  epochPrivateKey: Uint8Array
  binding: ObjectBinding
}): ContextPayload {
  verifyObjectManifest(input)
  if (input.manifest.contextId !== input.binding.contextId || decodeUint64(input.manifest.readEpoch) !== input.binding.readEpoch) {
    throw new MidaError("MANIFEST_MISMATCH", "manifest belongs to a different object or epoch")
  }
  const dek = unwrapDekFromEpoch({ wrap: input.manifest.epochDekWrap, epochPrivateKey: input.epochPrivateKey, binding: input.binding })
  try {
    return decryptPayload(
      { ciphertext: input.ciphertext, nonce: bytesOf(input.manifest.payloadNonce, NONCE_BYTES), dek },
      input.binding,
    )
  } finally {
    dek.fill(0)
  }
}
