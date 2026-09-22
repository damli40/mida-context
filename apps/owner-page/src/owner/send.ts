import { MidaError } from "@mida/protocol"
import type { Abi, Address, LocalAccount, PublicClient } from "viem"
import { GAS_CEILINGS, toMidaError } from "@mida/chain/browser"
import type { Deployment, SponsoredReceipt, SponsoredSender, TxKind } from "@mida/chain/browser"

/**
 * The owner page's ONLY write path. `sendContract` in @mida/chain does the same first two steps
 * (simulate so a revert surfaces as a named error, then the per-kind gas ceiling) but falls back
 * to paying from the user's wallet when the sponsor refuses — correct for the CLI's key-file
 * owner, wrong here: a passkey owner holds no MON, so a fallback send could only fail after the
 * sponsor already refused. SponsorDidNotPay and SponsorPending propagate untouched; the flow
 * shows the first as a plain failure and the second as pending with the operation hash, and
 * never retries on its own.
 *
 * The ceiling check mirrors `contractGas` in packages/chain/src/gas.ts (an unpadded node
 * estimate refused above GAS_CEILINGS[kind]) — the sponsored op carries the bundler's own gas
 * fields, but a call over its kind's ceiling is refused locally before the sponsor sees it.
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
  let estimate: bigint
  try {
    estimate = await context.publicClient.estimateContractGas({
      account: context.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
  } catch (error) {
    throw toMidaError(error)
  }
  const ceiling = GAS_CEILINGS[kind]
  if (estimate > ceiling) {
    throw new MidaError("GAS_CEILING_EXCEEDED", `${kind}: estimate ${estimate} exceeds ceiling ${ceiling}`)
  }
  return context.sponsor.send(call, kind)
}
