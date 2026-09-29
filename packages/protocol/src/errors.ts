/** §12.6 typed failures, §14.8 advisor hard failures, then plan decision 3 implementation codes. */
export const MIDA_ERROR_CODES = [
  "CAPABILITY_DENIED",
  "CAPABILITY_EXPIRED",
  "CAPABILITY_REVOKED",
  "EPOCH_ROTATION_REQUIRED",
  "EPOCH_STALE",
  "NO_EPOCH_WRAP",
  "WRAP_KEY_VERSION_MISMATCH",
  "MANIFEST_MISMATCH",
  "CONTENT_HASH_MISMATCH",
  "COMMITMENT_MISMATCH",
  "DECRYPT_FAILED",
  "INVALID_NAMESPACE",
  "STALE_PARENT",
  "EVIDENCE_IMMUTABLE",
  "PROVENANCE_FORBIDDEN",
  "ANCHOR_OWNER_ONLY",
  "MANIFEST_NOT_FOUND",
  "MANIFEST_HASH_MISMATCH",
  "MANIFEST_SIGNATURE_INVALID",
  "MANIFEST_STALE",
  "AGENT_ID_MISMATCH",
  "PURPOSE_UNKNOWN",
  "REQUEST_SIGNATURE_INVALID",
  "NAMESPACE_TREE_VERSION_UNSUPPORTED",
  "POLICY_VERSION_UNSUPPORTED",
  "INVALID_WIRE",
  "PAYLOAD_TOO_LARGE",
  "ZERO_KEY",
  "AUTH_INVALID",
  "REPLAY",
  "REQUEST_EXPIRED",
  "REQUEST_CONSUMED",
  "RESPONSE_MISMATCH",
  "NOT_FOUND",
  "GAS_CEILING_EXCEEDED",
  "OWNER_WALLET_LOW",
  "PARTIAL_READ",
  "SPONSOR_FAILED",
  "SPONSOR_PENDING",
  // A client-side send gave up waiting after its bounded window: the message itself says
  // whether a transaction hash is known ("sent as 0x…, not confirmed yet") or nothing left the
  // process — a send is never reported as a silent success (in-15 J-4).
  "SEND_TIMEOUT",
  // A write the store refused while the owner's revoke is still pending on Monad: distinct from
  // CAPABILITY_REVOKED (the chain already shows the revocation) so a caller can drop the job
  // without treating the transcript as permanently dead — the deny may still be cancelled.
  "WRITE_DENIED",
  // The chain could not be asked at all — a rate-limited or down RPC, or a request that ran out
  // of its own Monad read budget. Still a refusal (fail closed, no data served), but retryable
  // and never an authorization answer: the Sep 25 incident was exactly this wearing DENIED.
  "CHAIN_UNAVAILABLE",
  // The RPC answered but the configured address held no Mida contract (the call returned "0x"):
  // a wrong-network rpcUrl or a stale deployment. Not retryable — the fix is the setup, and the
  // caller must hear that instead of "busy" (in-11 R-8).
  "CHAIN_MISCONFIGURED",
  // The RPC provider refused the credential (HTTP 401/403). Not retryable — the fix is the key
  // in the provider URL, and the caller must hear that instead of "busy" (in-11 R-8).
  "RPC_AUTH_REJECTED",
  // A failure no more honest name exists for. Anything thrown that is not a protocol error used
  // to be flattened to CAPABILITY_DENIED — an infrastructure fault impersonating an authorization
  // answer. It gets its own non-authorization code instead.
  "INTERNAL_ERROR",
] as const

export type MidaErrorCode = (typeof MIDA_ERROR_CODES)[number]

export class MidaError extends Error {
  readonly code: MidaErrorCode
  /**
   * GAS_CEILING_EXCEEDED only: the estimate that was refused and the ceiling it was compared
   * against. A caller that re-sizes — the batcher shrinking a refused take — reads the numbers
   * here rather than parsing them back out of the message text.
   */
  estimate?: bigint
  ceiling?: bigint

  constructor(code: MidaErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = "MidaError"
    this.code = code
  }
}

export function isMidaError(value: unknown, code?: MidaErrorCode): value is MidaError {
  return value instanceof MidaError && (code === undefined || value.code === code)
}

/**
 * The one sentence the owner page shows when a request carries a refused character in a field it renders — a manifest name, a folder root, a project label.
 * One fixed sentence, with no field name or code, so the refusal itself can never smuggle part
 * of the request onto the page (in-27 R-1). This string is final copy.
 */
export const UNACCEPTABLE_REQUEST_TEXT =
  "This request contains characters Mida does not accept, so this page will not show or sign it."

/**
 * The characters that must never reach a field a page or a terminal renders. The set is wider
 * than C0+DEL (in-30 T-3): every control character, the Unicode line and paragraph separators,
 * the zero-width space (200B), the directional marks (200E-200F), the bidirectional controls
 * (202A-202E, 2066-2069) and the BOM. Each can forge a rendered line or hide inside one.
 * The joiners are NOT refused (in-31 V-3): the zero-width non-joiner (200C) is part of Persian
 * and Indic spelling and the zero-width joiner (200D) holds emoji sequences together — neither
 * can mint or hide a line.
 */
export const UNACCEPTABLE_REQUEST_CHARS = /[\p{Cc}\p{Zl}\p{Zp}​‎‏‪-‮⁦-⁩﻿]/u

/**
 * A refused character folded to a single space — for a display-only field that is size-checked
 * but not refused (a manifest's purpose description or scope reason, in-30 T-3). Validation keeps
 * the bytes untouched so the manifest's hash still matches what was registered; whatever later
 * renders the field passes it through here first.
 */
export function displaySafeText(value: string): string {
  return value.replace(new RegExp(UNACCEPTABLE_REQUEST_CHARS.source, "gu"), " ")
}

/**
 * INVALID_WIRE whose message is already the owner-facing sentence. MidaError prefixes its detail
 * with the code — "INVALID_WIRE: This request…" is not the page's text — so this subclass keeps
 * the code for API/log handling and the bare sentence for describeError.
 */
export class UnacceptableCharactersError extends MidaError {
  constructor() {
    super("INVALID_WIRE")
    this.name = "UnacceptableCharactersError"
    this.message = UNACCEPTABLE_REQUEST_TEXT
  }
}
