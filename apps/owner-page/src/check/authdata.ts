import { FLAG_AT, FLAG_ED, FLAG_UP, FLAG_UV } from "./constants.js"

/**
 * The parts of `authenticatorData` the checks read: rpIdHash (first 32 bytes), the flags byte,
 * and the signature counter. Mirrors what apps/api and the contract verify — same layout, same bits.
 */
export interface AuthenticatorDataInfo {
  rpIdHash: Uint8Array
  userPresent: boolean
  userVerified: boolean
  attestedCredentialData: boolean
  extensionData: boolean
  signCount: number
}

export function parseAuthenticatorData(data: Uint8Array): AuthenticatorDataInfo | null {
  if (data.length < 37) return null
  const flags = data[32]!
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    rpIdHash: data.slice(0, 32),
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    attestedCredentialData: (flags & FLAG_AT) !== 0,
    extensionData: (flags & FLAG_ED) !== 0,
    signCount: view.getUint32(33, false),
  }
}
