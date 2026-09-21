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
] as const

export type MidaErrorCode = (typeof MIDA_ERROR_CODES)[number]

export class MidaError extends Error {
  readonly code: MidaErrorCode

  constructor(code: MidaErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = "MidaError"
    this.code = code
  }
}

export function isMidaError(value: unknown, code?: MidaErrorCode): value is MidaError {
  return value instanceof MidaError && (code === undefined || value.code === code)
}
