import { MIDA_ERROR_CODES, MidaError, isMidaError } from "@mida/protocol"
import type { MidaErrorCode } from "@mida/protocol"
import { chainErrorKind } from "@mida/chain"

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
  CHAIN_MISCONFIGURED: 502,
  RPC_AUTH_REJECTED: 502,
  CHAIN_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
}

export function statusFor(code: MidaErrorCode): number {
  return STATUS[code] ?? 400
}

/**
 * Unknown failures never leak internals and never read as authorization (in-6 R4). The chain
 * error's kind picks the answer (in-11 R-8): a genuinely unreachable RPC — rate-limited, 5xx,
 * dropped, timed out, or this request's own Monad read budget — is 503 CHAIN_UNAVAILABLE and
 * retryable; an RPC that answered "no contract here" is 502 CHAIN_MISCONFIGURED and a provider
 * that refused the key is 502 RPC_AUTH_REJECTED, neither retryable. A viem failure that is none
 * of those — the chain answered something unexpected — is 500 INTERNAL_ERROR rather than a 503
 * that would lie "unreachable". All still return no data (fail closed): the Sep 25 incident was
 * a busy RPC wearing CAPABILITY_DENIED.
 *
 * `options.rpcHint` names THIS store's RPC-endpoint setting in the operator hint (in-14 F-4):
 * the hosted Worker's is the RPC_URL variable; the local persistent store's is the rpcUrl key in
 * network.json. A caller that passes neither gets a setting-neutral hint rather than a name that
 * store does not have.
 */
export function toErrorBody(error: unknown, options?: { rpcHint?: string }): { status: number; body: ApiErrorBody } {
  const rpcHint = options?.rpcHint ?? "RPC endpoint"
  if (isMidaError(error)) return { status: statusFor(error.code), body: { error: { code: error.code, message: error.message } } }
  const kind = chainErrorKind(error)
  if (kind === "misconfigured") {
    return { status: 502, body: { error: { code: "CHAIN_MISCONFIGURED", message: `the RPC answered but found no Mida contract — check the store's ${rpcHint} setting` } } }
  }
  if (kind === "rpc-auth") {
    return { status: 502, body: { error: { code: "RPC_AUTH_REJECTED", message: `the RPC provider refused the key — check the store's ${rpcHint} setting` } } }
  }
  if (kind === "busy") {
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
