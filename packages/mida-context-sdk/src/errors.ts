/**
 * Every failure an SDK call can raise carries one of these codes. The SDK's own codes say why the
 * call never left this machine (or never could); the rest are the Mida service's refusal reasons,
 * passed through unchanged so a caller can key on exactly what the daemon said.
 */
export type MidaSdkErrorCode =
  // Raised by the SDK itself, before or around a call.
  | "transport-unavailable" // a transport that does not exist yet — phase 2's `direct`
  | "invalid-option" // an option or argument the SDK refuses outright
  | "service-unavailable" // the Mida service is not answering — run any `mida` command to start it
  | "service-refused" // the service refused for a reason this SDK build does not name (see `serviceReason`)
  | "failed" // the call failed and no more specific code applies
  // The service's refusal reasons, verbatim.
  | "bad-agent"
  | "bad-input"
  | "no-identity"
  | "identity-unreadable"
  | "general-assistance"
  | "not-a-project"
  | "folder-mismatch"
  | "list-tampered"
  | "list-unreadable"
  | "check-failed"
  | "already-approved"
  | "not-approved"
  | "revoked"
  | "revoke-pending"
  | "read-only"
  | "rate-limited"
  | "invalid-shape"
  | "invalid-content"
  | "invalid-namespace"
  | "too-large"
  | "not-found"
  | "partial-read"
  | "chain-busy"
  | "chain-misconfigured"
  | "rpc-auth"
  | "store-misconfigured"
  | "store-rpc-auth"

/** The refusal reasons the daemon's routes can answer — a reason outside this set maps to `service-refused`. */
const SERVICE_REASONS: ReadonlySet<string> = new Set([
  "bad-agent",
  "bad-input",
  "no-identity",
  "identity-unreadable",
  "general-assistance",
  "not-a-project",
  "folder-mismatch",
  "list-tampered",
  "list-unreadable",
  "check-failed",
  "already-approved",
  "not-approved",
  "revoked",
  "revoke-pending",
  "read-only",
  "rate-limited",
  "invalid-shape",
  "invalid-content",
  "invalid-namespace",
  "invalid-option",
  "too-large",
  "not-found",
  "partial-read",
  "chain-busy",
  "chain-misconfigured",
  "rpc-auth",
  "store-misconfigured",
  "store-rpc-auth",
])

/**
 * The one error the SDK throws. `code` names the failure class; the message is one plain sentence
 * that says what did NOT happen — no provider URL, key or raw upstream message ever reaches it.
 */
export class MidaSdkError extends Error {
  readonly code: MidaSdkErrorCode
  /** The service's own refusal reason — present only when it is not the code itself. */
  readonly serviceReason?: string
  /** Which save lane a `rate-limited` refusal names — set only on that code. */
  readonly lane?: "direct" | "batched"

  constructor(code: MidaSdkErrorCode, message: string, options?: { cause?: unknown; serviceReason?: string; lane?: "direct" | "batched" }) {
    super(message)
    this.name = "MidaSdkError"
    this.code = code
    if (options?.cause !== undefined) this.cause = options.cause
    if (options?.serviceReason !== undefined) this.serviceReason = options.serviceReason
    if (options?.lane !== undefined) this.lane = options.lane
  }
}

/** Maps the service's refusal reason onto an SDK code — verbatim when known, `service-refused` when not. */
export function serviceRefusal(reason: string, text: string, options?: { lane?: "direct" | "batched" }): MidaSdkError {
  if (SERVICE_REASONS.has(reason)) {
    return new MidaSdkError(reason as MidaSdkErrorCode, text, options)
  }
  return new MidaSdkError("service-refused", text, { ...options, serviceReason: reason })
}

export function isMidaSdkError(error: unknown, code?: MidaSdkErrorCode): error is MidaSdkError {
  return error instanceof MidaSdkError && (code === undefined || error.code === code)
}
