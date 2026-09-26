import { isChainBusy } from "@mida/chain"
import { isMidaError } from "@mida/protocol"
import { BaseError, ContractFunctionRevertedError, InsufficientFundsError } from "viem"

/**
 * "The chain could not be asked", as one test every refusal boundary shares (in-6 R4):
 *
 * - the transport's own ChainBusyError, wherever viem wrapped it (isChainBusy walks `cause`);
 * - the store's CHAIN_UNAVAILABLE answer, whether it arrives as a MidaError or a plain error
 *   whose `code` was preserved — and the same code nested inside another error's cause;
 * - any viem failure with NO contract revert inside: a wrapped revert is the chain answering
 *   "no" and keeps its real name, but a transport-level failure means Monad was unreachable.
 *
 * What this must never catch: an actual CAPABILITY_DENIED — the chain answered "no grant" and
 * the refusal is real. Busy means unreachable, not refused.
 */
export function isChainBusyError(error: unknown): boolean {
  if (isChainBusy(error)) return true
  for (
    let current = error;
    current !== null && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    const code = (current as { code?: unknown }).code
    if (code === "CHAIN_UNAVAILABLE" || code === "CHAIN_BUSY") return true
  }
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ContractFunctionRevertedError) === null
  )
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
