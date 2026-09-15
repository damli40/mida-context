import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { MidaError, encodeUint64, isZeroBytes } from "@mida/protocol"
import type { Hex, IsolationDomain } from "@mida/protocol"
import { assertNonZeroKey, bytesOf } from "./bytes.js"

export const ISOLATION_DOMAINS: readonly IsolationDomain[] = ["general", "financial", "relationships", "private"]

const NAMESPACE_SECRET_INFO = utf8ToBytes("mida/context/namespace-secret/v1")
const READ_EPOCH_INFO = utf8ToBytes("mida/context/read-epoch/x25519/v1")

/** §6.1: SHA256(UTF8("mida/context/prf/<domain>/v1")). */
export function prfSalt(domain: IsolationDomain): Uint8Array {
  return sha256(utf8ToBytes(`mida/context/prf/${domain}/v1`))
}

/** §6.2: HKDF-SHA256(ikm = PRF_D, salt = namespaceId, info, 32). */
export function deriveNamespaceSecret(domainPrfOutput: Uint8Array, namespaceId: Hex): Uint8Array {
  assertNonZeroKey(domainPrfOutput, "PRF output")
  return hkdf(sha256, domainPrfOutput, bytesOf(namespaceId, 32), NAMESPACE_SECRET_INFO, 32)
}

export function uint64be(value: bigint): Uint8Array {
  encodeUint64(value)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, false)
  return out
}

export interface X25519KeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export interface EpochKeyPair extends X25519KeyPair {
  readEpoch: bigint
}

/** §7.1: epochSeed = HKDF-SHA256(namespaceSecret, uint64be(readEpoch), info, 32); noble clamps the scalar. */
export function deriveEpochKeyPair(namespaceSecret: Uint8Array, readEpoch: bigint): EpochKeyPair {
  assertNonZeroKey(namespaceSecret, "namespace secret")
  if (readEpoch < 1n) {
    throw new MidaError("INVALID_WIRE", "read epochs start at 1")
  }
  const privateKey = hkdf(sha256, namespaceSecret, uint64be(readEpoch), READ_EPOCH_INFO, 32)
  const publicKey = x25519.getPublicKey(privateKey)
  assertNonZeroKey(publicKey, "epoch public key")
  return { readEpoch, privateKey, publicKey }
}

export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  assertNonZeroKey(privateKey, "X25519 private key")
  return x25519.getPublicKey(privateKey)
}

export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomSecretKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

/** §7.1: reject an all-zero public key or shared secret before any HKDF. */
export function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertNonZeroKey(privateKey, "X25519 private key")
  assertNonZeroKey(publicKey, "X25519 public key")
  let shared: Uint8Array
  try {
    shared = x25519.getSharedSecret(privateKey, publicKey)
  } catch {
    throw new MidaError("ZERO_KEY", "X25519 rejected a low-order public key")
  }
  if (isZeroBytes(shared)) {
    throw new MidaError("ZERO_KEY", "X25519 shared secret is all zero")
  }
  return shared
}
