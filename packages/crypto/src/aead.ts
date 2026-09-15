import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { MidaError } from "@mida/protocol"

export const KEY_BYTES = 32
export const NONCE_BYTES = 24
export const TAG_BYTES = 16

function checkSizes(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES) {
    throw new MidaError("INVALID_WIRE", "XChaCha20-Poly1305 needs a 32-byte key and 24-byte nonce")
  }
}

export function seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  checkSizes(key, nonce)
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
}

export function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  checkSizes(key, nonce)
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext)
  } catch {
    throw new MidaError("DECRYPT_FAILED", "authentication failed")
  }
}
