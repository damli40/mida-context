import { base64UrlEncode, bytesToHex } from "./bytes.js"
import type { CreateCapture } from "./client.js"
import { parseP256Spki } from "./spki.js"
import type { SavedTestCredential } from "./storage.js"
import { assertNoSecretMaterial } from "@mida/protocol"

// The guard lives in @mida/protocol now (owner-link.ts) — the terminal-side result parser uses
// the same check. Re-exported so existing importers keep working.
export { assertNoSecretMaterial }

/**
 * The "Copy report" payload: everything a reviewer needs to reproduce the check and nothing that
 * would hand them key material. `assertNoSecretMaterial` is the guard — it refuses to serialize
 * any object that carries a 32-byte value under a key whose name CONTAINS prf, seed, secret,
 * private or key, so a future field added by accident fails loudly instead of leaking the secret
 * it holds. The match is a substring, not a prefix, because the real names are `evmKey` and
 * `ownerSeed` — neither starts with the secret word.
 */

export type CheckStatus = "pass" | "fail" | "unknown"

export interface CheckLine {
  id: string
  status: CheckStatus
  text: string
}

export interface ReportInput {
  rpId: string
  challengeHex: string
  environment: {
    userAgent: string
    platform: string
    secureContext: boolean
    webauthnAvailable: boolean
    platformAuthenticatorAvailable: boolean | null
    authenticatorAttachment: string | null
  }
  credential: {
    credentialId: string
    transports: string[] | null
    algorithm: number | null
    publicKey: { x: string; y: string } | null
  } | null
  calls: { create: number; get: number }
  fingerprintOfSecret: string | null
  lines: CheckLine[]
}

/**
 * What the report calls "the credential". The saved record wins for identity (it is what a later
 * "use" targets), but a create ceremony whose PRF eval failed is still captured — the public key
 * and transports survive the throw, and a report that dropped them would hide exactly the data a
 * reviewer needs to see which part failed.
 */
export function credentialForReport(saved: SavedTestCredential | null, created: CreateCapture | null): ReportInput["credential"] {
  const credentialId = saved?.credentialId ?? (created !== null ? base64UrlEncode(created.credentialId) : null)
  if (credentialId === null) return null
  const captured = created?.spki ? parseP256Spki(created.spki) : null
  return {
    credentialId,
    transports: saved?.transports ?? created?.transports ?? null,
    algorithm: saved?.algorithm ?? created?.algorithm ?? null,
    publicKey: saved?.x && saved.y ? { x: saved.x, y: saved.y } : captured !== null ? { x: bytesToHex(captured.x), y: bytesToHex(captured.y) } : null,
  }
}

export function buildReport(input: ReportInput): Record<string, unknown> {
  const report: Record<string, unknown> = {
    page: "mida-owner-page device check",
    generatedAt: new Date().toISOString(),
    rpId: input.rpId,
    challenge: { hex: input.challengeHex, note: "fixed fake test value shown on the page — not a secret" },
    environment: input.environment,
    credential: input.credential,
    navigatorInvocations: input.calls,
    fingerprintOfSecret: input.fingerprintOfSecret,
    fingerprintNote: "first 4 bytes of sha256(prfOutput) — a fingerprint of the secret, not the secret",
    checks: input.lines,
  }
  assertNoSecretMaterial(report)
  return report
}
