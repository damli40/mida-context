import canonicalize from "canonicalize"
import type { Hex } from "viem"
import { MidaError } from "./errors.js"

export const MAX_UINT64 = (1n << 64n) - 1n
const UINT64_PATTERN = /^(0|[1-9][0-9]*)$/

export function encodeUint64(value: bigint): string {
  if (value < 0n || value > MAX_UINT64) {
    throw new MidaError("INVALID_WIRE", "uint64 out of range")
  }
  return value.toString(10)
}

export function decodeUint64(value: string): bigint {
  if (!UINT64_PATTERN.test(value)) {
    throw new MidaError("INVALID_WIRE", "uint64 must be canonical base-10")
  }
  const parsed = BigInt(value)
  if (parsed > MAX_UINT64) {
    throw new MidaError("INVALID_WIRE", "uint64 out of range")
  }
  return parsed
}

export function assertHex(value: string, byteLength: number): Hex {
  const pattern = new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`)
  if (!pattern.test(value)) {
    throw new MidaError("INVALID_WIRE", `expected lowercase 0x hex of ${byteLength} bytes`)
  }
  return value as Hex
}

export function isZeroBytes(bytes: Uint8Array): boolean {
  let accumulator = 0
  for (const byte of bytes) accumulator |= byte
  return accumulator === 0
}

function rejectBigInt(value: unknown): void {
  if (typeof value === "bigint") {
    throw new MidaError("INVALID_WIRE", "bigint must be encoded as a base-10 string")
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectBigInt(item)
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) rejectBigInt(item)
  }
}

export function canonicalJson(value: unknown): string {
  rejectBigInt(value)
  let result: string | undefined
  try {
    result = canonicalize(value)
  } catch (error) {
    throw new MidaError("INVALID_WIRE", `not canonicalizable: ${(error as Error).message}`)
  }
  if (result === undefined) {
    throw new MidaError("INVALID_WIRE", "value has no JSON representation")
  }
  return result
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
