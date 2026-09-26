import { MIDA_ERROR_CODES, MidaError, isMidaError } from "@mida/protocol"
import type { MidaErrorCode } from "@mida/protocol"
import { isChainBusy } from "@mida/chain"
import { BaseError } from "viem"
import { isChainReadBudgetExceeded } from "./chain-budget.js"

export interface ApiErrorBody {
  error: { code: MidaErrorCode; message: string }
}

const STATUS: Partial<Record<MidaErrorCode, number>> = {
  AUTH_INVALID: 401,
  REPLAY: 401,
  CAPABILITY_DENIED: 403,
  CAPABILITY_EXPIRED: 403,
  CAPABILITY_REVOKED: 403,
  WRITE_DENIED: 403,
  PROVENANCE_FORBIDDEN: 403,
  ANCHOR_OWNER_ONLY: 403,
  NOT_FOUND: 404,
  NO_EPOCH_WRAP: 404,
  MANIFEST_NOT_FOUND: 404,
  EPOCH_STALE: 409,
  EPOCH_ROTATION_REQUIRED: 409,
  STALE_PARENT: 409,
  REQUEST_CONSUMED: 409,
  PAYLOAD_TOO_LARGE: 413,
  CHAIN_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
}

export function statusFor(code: MidaErrorCode): number {
  return STATUS[code] ?? 400
}

/**
 * Unknown failures never leak internals and never read as authorization (in-6 R4). A chain that
 * could not be asked — the transport's ChainBusyError, any viem failure, this request's own
 * Monad read budget — answers 503 CHAIN_UNAVAILABLE; anything else is 500 INTERNAL_ERROR. Both
 * still return no data (fail closed), but a client can now tell "Monad was unreachable" from
 * "the chain said no" — the Sep 25 incident was a busy RPC wearing CAPABILITY_DENIED.
 */
export function toErrorBody(error: unknown): { status: number; body: ApiErrorBody } {
  if (isMidaError(error)) return { status: statusFor(error.code), body: { error: { code: error.code, message: error.message } } }
  if (isChainBusy(error) || error instanceof BaseError || isChainReadBudgetExceeded(error)) {
    return { status: 503, body: { error: { code: "CHAIN_UNAVAILABLE", message: "the chain could not answer right now — retry in a moment" } } }
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "internal error; request denied" } } }
}

export function errorFromBody(status: number, body: unknown): Error {
  const error = (body as Partial<ApiErrorBody> | null)?.error
  if (error !== undefined && (MIDA_ERROR_CODES as readonly string[]).includes(error.code)) {
    return new MidaError(error.code, error.message.replace(new RegExp(`^${error.code}: `), ""))
  }
  // A route-level refusal that is not a protocol code — NOT_AN_AGENT, SIGNER_MISMATCH,
  // ALREADY_QUEUED — travels in the same { error: { code, message } } envelope. Keep the wire
  // name on the thrown error so a caller can still tell the store's own "this save cannot go"
  // from a transport failure; flattened to the bare status, every refusal looks retryable.
  return Object.assign(new Error(`Context API returned HTTP ${status}${error === undefined ? "" : `: ${error.message}`}`), {
    ...(error === undefined ? {} : { code: String(error.code), status }),
  })
}
