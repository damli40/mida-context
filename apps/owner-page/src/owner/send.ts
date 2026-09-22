import { toMidaError } from "@mida/chain/browser"
import type { Abi, Address, LocalAccount, PublicClient } from "viem"
import type { Deployment, SponsoredReceipt, SponsoredSender, TxKind } from "@mida/chain/browser"

/**
 * The owner page's ONLY write path. `sendContract` in @mida/chain does the same first step —
 * `simulateContract` is an eth_call and needs no balance, so a revert surfaces as a named error
 * — then hands the call to the sponsored sender, which checks the per-kind ceiling against the
 * bundler's own callGasLimit. There is deliberately no `estimateContractGas` here: it runs as
 * the passkey owner, and Monad refuses the estimate for a sender who cannot afford the worst
 * case — a passkey owner holds 0 MON, so every send would fail before the sponsor was asked.
 * And there is no self-pay fallback for the same reason. SponsorDidNotPay and SponsorPending
 * propagate untouched; the flow shows the first as a plain refusal and the second as pending
 * with the operation hash, and never retries on its own.
 */
export interface SponsoredWriteContext {
  publicClient: PublicClient
  account: LocalAccount
  deployment: Deployment
  sponsor: SponsoredSender
}

export async function sendSponsoredOnly(
  context: SponsoredWriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  kind: TxKind,
): Promise<SponsoredReceipt> {
  try {
    await context.publicClient.simulateContract({
      account: context.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
  } catch (error) {
    throw toMidaError(error)
  }
  return context.sponsor.send(call, kind)
}
