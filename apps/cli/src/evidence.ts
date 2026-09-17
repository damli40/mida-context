import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, randomBytes } from "@noble/hashes/utils.js"
import type { PublicClient } from "viem"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
export const P256_VERIFIER: Hex = "0x0000000000000000000000000000000000000100"
export const PRECOMPILE_TRUE: Hex = `0x${"00".repeat(31)}01`

export interface ScenarioEvidence {
  network: string
  generatedAt: string
  chainId: string
  capabilityRegistry: Hex
  contextRegistry: Hex
  deploymentBlock: string
  p256PrecompileProbe: { valid: Hex; tampered: Hex }
  grantBatchGasUsed: Record<string, string>
  transactions: Record<string, Hex>
}

/** Local runs write to the gitignored .mida-data/; the Monad testnet run writes the committed docs/evidence/ file. */
export function evidencePath(network: string, date: Date = new Date()): string {
  return network === "monad-testnet"
    ? `${ROOT}docs/evidence/monad-testnet-${date.toISOString().slice(0, 10)}.json`
    : `${ROOT}.mida-data/evidence/${network}.json`
}

export function writeEvidence(path: string, evidence: ScenarioEvidence): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
}

/** Direct eth_call to the P256 verifier: a fresh valid (hash, r, s, qx, qy) must return 1, a tampered one nothing. */
export async function probeP256Precompile(publicClient: PublicClient): Promise<{ valid: Hex; tampered: Hex }> {
  const secretKey = p256.utils.randomSecretKey()
  const message = randomBytes(32)
  const signature = p256.sign(message, secretKey, { prehash: true, lowS: true })
  const publicKey = p256.getPublicKey(secretKey, false)
  const input = concatBytes(sha256(message), signature, publicKey.subarray(1))
  const tampered = Uint8Array.from(input)
  tampered[159] = tampered[159]! ^ 0x01
  const call = async (data: Uint8Array) => (await publicClient.call({ to: P256_VERIFIER, data: hexOf(data) })).data ?? "0x"
  return { valid: await call(input), tampered: await call(tampered) }
}
