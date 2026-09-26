import { chainErrorKind } from "@mida/chain"
import { isMidaError } from "@mida/protocol"
import { BaseError, InsufficientFundsError } from "viem"

/**
 * The refusal reason a thrown chain error earns, shared by every boundary that names one
 * (in-11 R-8). `chain-busy` is the reason from in-6 R4 — "the chain could not be asked" —
 * but narrowed to failures a retry can honestly change: rate limits, 5xx, dropped
 * connections, timeouts, and the store's own CHAIN_UNAVAILABLE. Two failures the old
 * catch-all mislabeled as busy get their own reasons:
 *
 * - `chain-misconfigured` — the RPC answered but found no Mida contract at the configured
 *   address (a wrong-network rpcUrl or stale deployment): the owner fixes the setup,
 *   not the timing;
 * - `rpc-auth` — the provider refused the credential (HTTP 401/403): the owner fixes the
 *   key, not the timing.
 *
 * `undefined` means the error names itself — a real contract refusal like CAPABILITY_DENIED
 * or a wrapped revert — and callers keep their existing fallback.
 */
export type ChainRefusalReason = "chain-busy" | "chain-misconfigured" | "rpc-auth"

export function chainRefusalReason(error: unknown): ChainRefusalReason | undefined {
  const kind = chainErrorKind(error)
  if (kind === "busy") return "chain-busy"
  if (kind === "misconfigured") return "chain-misconfigured"
  if (kind === "rpc-auth") return "rpc-auth"
  return undefined
}

/**
 * True only for a chain that genuinely could not be asked (in-6 R4). Misconfiguration and
 * refused credentials are NOT busy — "it tries again next session" is the wrong advice for
 * either, so they answer `false` here and carry their own reasons via chainRefusalReason.
 */
export function isChainBusyError(error: unknown): boolean {
  return chainErrorKind(error) === "busy"
}

/**
 * A wallet that cannot pay the send: the balance guard's OWNER_WALLET_LOW, or viem's own
 * insufficient-funds answer when the balance moved between the guard and the send. Transient —
 * funding the wallet clears it, so the drain treats it like a chain hiccup, not a refusal.
 */
export function isWalletLow(error: unknown): boolean {
  if (isMidaError(error, "OWNER_WALLET_LOW")) return true
  return error instanceof BaseError && error.walk((cause) => cause instanceof InsufficientFundsError) !== null
}
