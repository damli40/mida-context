import { base64UrlEncode, bytesToHex } from "./bytes.js"
import type { CreateCapture } from "./client.js"
import { parseP256Spki } from "./spki.js"
import type { SavedTestCredential } from "./storage.js"

/**
 * The "Copy report" payload: everything a reviewer needs to reproduce the check and nothing that
 * would hand them key material. `assertNoSecretMaterial` is the guard — it refuses to serialize
 * any object that carries a 32-byte value under a key named like `prf*`, `secret*` or `private*`,
 * so a future field added by accident fails loudly instead of leaking the secret it holds.
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

const SECRET_KEY = /^(prf|secret|private)/i

function isThirtyTwoBytes(value: unknown): boolean {
  if (value instanceof Uint8Array) return value.length === 32
  if (Array.isArray(value)) return value.length === 32 && value.every((v) => typeof v === "number")
  if (typeof value === "string") return /^(0x)?[0-9a-fA-F]{64}$/.test(value)
  return false
}

/** Throws on the first 32-byte value found under a secret-looking key, anywhere in the tree. */
export function assertNoSecretMaterial(value: unknown, path = "report"): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoSecretMaterial(value[i], `${path}[${i}]`)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && isThirtyTwoBytes(child)) {
        throw new Error(`report would expose "${path}.${key}" — a 32-byte value under a secret-looking name`)
      }
      assertNoSecretMaterial(child, `${path}.${key}`)
    }
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
