import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { MidaError, assertHex, isZeroBytes } from "@mida/protocol"
import type { Hex } from "@mida/protocol"

export function hexOf(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}` as Hex
}

export function bytesOf(hex: string, byteLength: number): Uint8Array {
  return hexToBytes(assertHex(hex, byteLength).slice(2))
}

export function assertNonZeroKey(bytes: Uint8Array, label: string): void {
  if (bytes.length !== 32 || isZeroBytes(bytes)) {
    throw new MidaError("ZERO_KEY", `${label} must be 32 non-zero bytes`)
  }
}
