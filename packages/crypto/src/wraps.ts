import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { encodeAbiParameters, hexToBytes } from "viem"
import { CRYPTO_VERSION, MidaError, decodeUint64, encodeUint64 } from "@mida/protocol"
import type { Address, EpochDEKWrap, Hex, ReaderEpochWrap } from "@mida/protocol"
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES, open, seal } from "./aead.js"
import { bytesOf, hexOf } from "./bytes.js"
import { generateX25519KeyPair, x25519SharedSecret } from "./derive.js"
import { epochDekWrapAad } from "./payload.js"
import type { ObjectBinding } from "./payload.js"

const EPOCH_DEK_WRAP_INFO = utf8ToBytes("mida/context/epoch-dek-wrap/v1")
const READER_EPOCH_WRAP_INFO = utf8ToBytes("mida/context/reader-epoch-wrap/v1")
const WRAPPED_KEY_BYTES = KEY_BYTES + TAG_BYTES

function kek(sharedSecret: Uint8Array, salt: Hex, info: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, bytesOf(salt, 32), info, 32)
}

/** §8.3: wrap an object DEK to the namespace epoch public key. */
export function wrapDekToEpoch(input: { dek: Uint8Array; epochPublicKey: Uint8Array; binding: ObjectBinding }): EpochDEKWrap {
  const ephemeral = generateX25519KeyPair()
  const shared = x25519SharedSecret(ephemeral.privateKey, input.epochPublicKey)
  const nonce = randomBytes(NONCE_BYTES)
  const wrapped = seal(kek(shared, input.binding.contextId, EPOCH_DEK_WRAP_INFO), nonce, epochDekWrapAad(input.binding), input.dek)
  return {
    v: 1,
    contextId: input.binding.contextId,
    namespaceId: input.binding.namespaceId,
    readEpoch: encodeUint64(input.binding.readEpoch),
    ephemeralPublicKey: hexOf(ephemeral.publicKey),
    nonce: hexOf(nonce),
    wrappedDek: hexOf(wrapped),
  }
}

export function unwrapDekFromEpoch(input: { wrap: EpochDEKWrap; epochPrivateKey: Uint8Array; binding: ObjectBinding }): Uint8Array {
  const { wrap, binding } = input
  if (
    wrap.v !== 1 ||
    wrap.contextId !== binding.contextId ||
    wrap.namespaceId !== binding.namespaceId ||
    decodeUint64(wrap.readEpoch) !== binding.readEpoch
  ) {
    throw new MidaError("DECRYPT_FAILED", "epoch DEK wrap does not belong to this object")
  }
  const shared = x25519SharedSecret(input.epochPrivateKey, bytesOf(wrap.ephemeralPublicKey, 32))
  return open(
    kek(shared, binding.contextId, EPOCH_DEK_WRAP_INFO),
    bytesOf(wrap.nonce, NONCE_BYTES),
    epochDekWrapAad(binding),
    bytesOf(wrap.wrappedDek, WRAPPED_KEY_BYTES),
  )
}

/** Values the reader-wrap AAD binds (§8.4). */
export interface ReaderBinding {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  namespaceId: Hex
  readEpoch: bigint
  agentId: Hex
  agentKeyVersion: number
}

export function readerEpochWrapAad(binding: ReaderBinding): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "string" },
      ],
      [
        "MIDA_READER_EPOCH_WRAP_V1",
        binding.chainId,
        binding.capabilityRegistry,
        binding.owner,
        binding.namespaceId,
        binding.readEpoch,
        binding.agentId,
        binding.agentKeyVersion,
        CRYPTO_VERSION,
      ],
    ),
  )
}

/** §8.4: wrap an epoch private key to one agent's registered X25519 key and version. */
export function wrapEpochPrivateKeyToAgent(input: {
  epochPrivateKey: Uint8Array
  agentEncryptionPublicKey: Uint8Array
  binding: ReaderBinding
  createdAt: bigint
}): ReaderEpochWrap {
  const ephemeral = generateX25519KeyPair()
  const shared = x25519SharedSecret(ephemeral.privateKey, input.agentEncryptionPublicKey)
  const nonce = randomBytes(NONCE_BYTES)
  const wrapped = seal(
    kek(shared, input.binding.namespaceId, READER_EPOCH_WRAP_INFO),
    nonce,
    readerEpochWrapAad(input.binding),
    input.epochPrivateKey,
  )
  return {
    v: 1,
    owner: input.binding.owner,
    namespaceId: input.binding.namespaceId,
    readEpoch: encodeUint64(input.binding.readEpoch),
    agentId: input.binding.agentId,
    agentKeyVersion: input.binding.agentKeyVersion,
    ephemeralPublicKey: hexOf(ephemeral.publicKey),
    nonce: hexOf(nonce),
    wrappedEpochPrivateKey: hexOf(wrapped),
    createdAt: encodeUint64(input.createdAt),
  }
}

export function unwrapEpochPrivateKey(input: {
  wrap: ReaderEpochWrap
  agentEncryptionPrivateKey: Uint8Array
  binding: ReaderBinding
}): Uint8Array {
  const { wrap, binding } = input
  if (wrap.agentKeyVersion !== binding.agentKeyVersion) {
    throw new MidaError("WRAP_KEY_VERSION_MISMATCH", "wrap targets a different agent encryption key version")
  }
  if (
    wrap.v !== 1 ||
    wrap.owner.toLowerCase() !== binding.owner.toLowerCase() ||
    wrap.namespaceId !== binding.namespaceId ||
    wrap.agentId !== binding.agentId ||
    decodeUint64(wrap.readEpoch) !== binding.readEpoch
  ) {
    throw new MidaError("DECRYPT_FAILED", "reader wrap does not match this owner, namespace, epoch and agent")
  }
  const shared = x25519SharedSecret(input.agentEncryptionPrivateKey, bytesOf(wrap.ephemeralPublicKey, 32))
  return open(
    kek(shared, binding.namespaceId, READER_EPOCH_WRAP_INFO),
    bytesOf(wrap.nonce, NONCE_BYTES),
    readerEpochWrapAad(binding),
    bytesOf(wrap.wrappedEpochPrivateKey, WRAPPED_KEY_BYTES),
  )
}
