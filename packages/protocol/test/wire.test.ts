import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  MAX_UINT64,
  assertHex,
  canonicalBytes,
  canonicalJson,
  decodeUint64,
  encodeUint64,
  isMidaError,
  isZeroBytes,
} from "@mida/protocol"

const invalid = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, "INVALID_WIRE")
  }
  return false
}

describe("uint64 wire strings (§8)", () => {
  it("encodes canonical base-10", () => {
    expect(encodeUint64(0n)).toBe("0")
    expect(encodeUint64(7n)).toBe("7")
    expect(encodeUint64(MAX_UINT64)).toBe("18446744073709551615")
  })

  it("rejects out-of-range values on encode", () => {
    expect(invalid(() => encodeUint64(-1n))).toBe(true)
    expect(invalid(() => encodeUint64(MAX_UINT64 + 1n))).toBe(true)
  })

  it("rejects signs, leading zeros, whitespace, decimals and overflow on decode", () => {
    for (const bad of ["", "-1", "+1", "01", "00", " 1", "1 ", "1.0", "1e3", "0x1", "18446744073709551616"]) {
      expect(invalid(() => decodeUint64(bad)), bad).toBe(true)
    }
  })

  it("round-trips every uint64", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT64 }), (value) => {
        expect(decodeUint64(encodeUint64(value))).toBe(value)
      }),
    )
  })
})

describe("fixed-size hex (§8)", () => {
  it("accepts lowercase 0x values of the exact length", () => {
    expect(assertHex("0x" + "ab".repeat(32), 32)).toBe("0x" + "ab".repeat(32))
  })

  it("rejects uppercase, missing prefix, odd length and wrong length", () => {
    expect(invalid(() => assertHex("0x" + "AB".repeat(32), 32))).toBe(true)
    expect(invalid(() => assertHex("ab".repeat(32), 32))).toBe(true)
    expect(invalid(() => assertHex("0x" + "a".repeat(63), 32))).toBe(true)
    expect(invalid(() => assertHex("0x" + "ab".repeat(31), 32))).toBe(true)
  })

  it("detects all-zero byte arrays", () => {
    expect(isZeroBytes(new Uint8Array(32))).toBe(true)
    const one = new Uint8Array(32)
    one[31] = 1
    expect(isZeroBytes(one)).toBe(false)
  })
})

describe("canonical JSON (RFC 8785)", () => {
  it("sorts keys recursively and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: [2, { z: 1, y: 2 }] })).toBe('{"a":[2,{"y":2,"z":1}],"b":1}')
  })

  it("is independent of key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse())
        expect(canonicalJson(reversed)).toBe(canonicalJson(record))
      }),
    )
  })

  it("encodes UTF-8 bytes of the canonical string", () => {
    expect(new TextDecoder().decode(canonicalBytes({ x: "é" }))).toBe('{"x":"é"}')
  })

  it("rejects values that have no JSON form", () => {
    expect(invalid(() => canonicalJson(undefined))).toBe(true)
    expect(invalid(() => canonicalJson({ big: 1n }))).toBe(true)
  })
})
