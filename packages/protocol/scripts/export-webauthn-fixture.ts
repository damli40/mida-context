/**
 * Writes contracts/test/vectors/webauthn-v1.json: one WebAuthn assertion produced by ox exactly as
 * FakeVault will produce it (plan Task 22). Solidity tests (plan Task 15) verify it through
 * MidaWebAuthn on both the native P256 precompile and the FreshCryptoLib fallback.
 * The private key is a fixed test value; ECDSA signing is deterministic (RFC 6979), so output is stable.
 * Usage: pnpm vectors:webauthn [outputPath]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { P256, WebAuthnP256 } from "ox"
import type { Hex } from "ox"

const out = process.argv[2] ?? fileURLToPath(new URL("../../../contracts/test/vectors/webauthn-v1.json", import.meta.url))

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const TEST_PRIVATE_KEY: Hex.Hex = `0x${"4d".repeat(32)}`
const RP_ID = "vault.mida.xyz"
const ORIGIN = "https://vault.mida.xyz"
const CHALLENGE: Hex.Hex = `0x${"ab".repeat(32)}`

const toBytes32 = (value: bigint): Hex.Hex => `0x${value.toString(16).padStart(64, "0")}`

const publicKey = P256.getPublicKey({ privateKey: TEST_PRIVATE_KEY })
const { metadata, payload } = WebAuthnP256.getSignPayload({
  challenge: CHALLENGE,
  rpId: RP_ID,
  origin: ORIGIN,
  userVerification: "required",
})
const signature = P256.sign({ payload, privateKey: TEST_PRIVATE_KEY, hash: true })

// webauthn-sol rejects s > n/2; every Mida assertion adapter normalizes (spec §10.4).
const r = BigInt(signature.r)
const rawS = BigInt(signature.s)
const s = rawS > P256_N / 2n ? P256_N - rawS : rawS

// ox 1.7.4 represents r and s as hex strings, not bigints.
if (!WebAuthnP256.verify({ challenge: CHALLENGE, metadata, publicKey, signature: { r: toBytes32(r), s: toBytes32(s), yParity: 0 } })) {
  throw new Error("fixture does not verify off-chain")
}

const fixture = {
  rpId: RP_ID,
  origin: ORIGIN,
  challenge: CHALLENGE,
  qx: toBytes32(BigInt(publicKey.x)),
  qy: toBytes32(BigInt(publicKey.y)),
  authenticatorData: metadata.authenticatorData,
  clientDataJSON: metadata.clientDataJSON,
  challengeIndex: metadata.challengeIndex,
  typeIndex: metadata.typeIndex,
  r: toBytes32(r),
  s: toBytes32(s),
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${out}`)
