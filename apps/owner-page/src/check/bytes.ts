/** Byte helpers the check page shares between ceremonies, tests and the report. No Buffer — the bundle runs in a browser. */

export function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("not hex")
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined
    out += B64URL[a >> 2]! + B64URL[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!
    if (b !== undefined) out += B64URL[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!
    if (c !== undefined) out += B64URL[c & 0x3f]!
  }
  return out
}

export function base64UrlDecode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "")
  if (clean.length % 4 === 1) throw new Error("not base64url")
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of clean) {
    const v = B64URL.indexOf(ch)
    if (v < 0) throw new Error("not base64url")
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function bigIntToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16)
  if (hex.length > 64) throw new Error("does not fit in 32 bytes")
  return hexToBytes(hex.padStart(64, "0"))
}

/** What WebAuthn hands back for a BufferSource or what Mera reports as `ArrayLike<number>` — normalize to a fresh Uint8Array. */
export function toBytes(source: ArrayBuffer | ArrayBufferView | ArrayLike<number>): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  return Uint8Array.from(source as ArrayLike<number>)
}
