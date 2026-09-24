import {
  MidaError,
  agentId as deriveAgentId,
  agentRegistrationTypedData,
  canonicalizeOrigin,
  isMidaError,
  originHash,
} from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { createPublicClient, createWalletClient, http } from "viem"
import type { Abi, Account, LocalAccount, PublicClient, TransactionReceipt, WalletClient } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import { chainFor } from "./deployment.js"
import type { Deployment } from "./deployment.js"
import { GAS_CEILINGS, contractGas, valueGas } from "./gas.js"
import type { TxKind } from "./gas.js"
import { toMidaError } from "./registry.js"
import type { ChainContext } from "./registry.js"
import { SponsorDidNotPay } from "./sponsored.js"
import type { SponsoredSender } from "./sponsored.js"

/**
 * The fee fields a send carries — the answer of `estimateFeesPerGas`, forwarded verbatim into
 * the transaction so the number the balance guard checked is the number the node checks (R5-9).
 * An EIP-1559 chain sets `maxFeePerGas`/`maxPriorityFeePerGas`; a legacy chain sets `gasPrice`.
 */
export interface SendFee {
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasPrice?: bigint
}

/** What a send is about to cost the payer, handed to `beforeSend` after the estimates. */
export interface SendCost {
  payer: Address
  gasLimit: bigint
  /**
   * The exact fee values the transaction goes out with. The node verifies the payer against
   * `gasLimit × maxFeePerGas` — checking a fresh (cheaper) gas price instead let a wallet
   * through that the send itself then refused (R5-9).
   */
  fee: SendFee
  /** A plain transfer's moved value — part of the payer's total exposure, absent on contract calls. */
  value?: bigint
  /**
   * Set when `gasLimit` is a bound, not a measured estimate: the node's own `eth_estimateGas`
   * refused to run, so the send was priced at the kind's ceiling. A balance guard phrases the
   * refusal "needs up to X MON" rather than claiming a precision the bound does not have (M3-D6).
   */
  upperBound?: boolean
}

export interface WriteContext extends ChainContext {
  walletClient: WalletClient
  account: Account
  /**
   * Runs between the gas estimate and the send: the payer's balance can be checked against the
   * estimated cost and topped up, or the send refused before a transaction the wallet cannot
   * pay for goes out (R4-4). Only the owner's context wires this; agent signers keep the bare
   * node error, exactly as before. On the sponsored path it never runs — the user pays nothing.
   */
  beforeSend?: (cost: SendCost) => Promise<void>
  /**
   * When set, `sendContract` asks this sender to pay the gas first (the user still signs; the
   * sponsor pays). A SponsorDidNotPay falls back to the self-paid path — or refuses, when
   * SPONSOR_FALLBACK_TO_SELF_PAY is off. Any other error (an included-but-reverted operation
   * among them) propagates untouched: the sponsor did pay and the call itself failed.
   */
  sponsor?: SponsoredSender
  /**
   * One plain line while a slow step runs — where the sponsor fallback explains itself. Wired by
   * the runtime to its own progress channel; unset means silent code paths stay silent.
   */
  progress?: (line: string) => void
}

/** A write context whose account can sign typed data locally (operators, owners and agent signers in tests and the CLI). */
export interface LocalWriteContext extends WriteContext {
  account: LocalAccount
}

export function createWriteContext(input: { rpcUrl: string; deployment: Deployment; account: LocalAccount }): LocalWriteContext {
  const chain = chainFor(input.deployment.chainId)
  return {
    deployment: input.deployment,
    account: input.account,
    publicClient: createPublicClient({ chain, transport: http(input.rpcUrl) }),
    walletClient: createWalletClient({ chain, account: input.account, transport: http(input.rpcUrl) }),
  }
}

/** A mined receipt plus the gas limit the transaction was actually sent with — the number Monad bills. */
export type SentReceipt = TransactionReceipt & { gasLimit: bigint }

/**
 * `sent === false` on a thrown error marks a failure from BEFORE any transaction left the
 * process — simulation, gas estimation, the fee estimate, the balance guard. A caller that
 * requeues work on failure (the batcher) reads it here to tell "nothing was sent", a plain
 * size or availability signal that is safe to resubmit, from "the send's answer was lost",
 * where the transaction may already have landed. A failure thrown after `writeContract` —
 * including the sponsor's own send, whose operation may still be in flight — is never marked.
 */
export function failedBeforeSend(error: unknown): boolean {
  return error instanceof Error && (error as { sent?: boolean }).sent === false
}

const markUnsent = <T>(error: T): T => {
  if (error instanceof Error) (error as { sent?: boolean }).sent = false
  return error
}

/**
 * The fee a send will offer, estimated once per transaction. viem's EIP-1559 default multiplies
 * the base fee (×1.2) into `maxFeePerGas`, which is exactly the product the node verifies the
 * payer's balance against — so the guard must see THIS number, not the raw gas price (R5-9).
 */
async function estimateSendFee(context: WriteContext): Promise<SendFee> {
  const estimated = await context.publicClient.estimateFeesPerGas()
  const fee: SendFee = {}
  if (estimated.gasPrice !== undefined) fee.gasPrice = estimated.gasPrice
  if (estimated.maxFeePerGas !== undefined) fee.maxFeePerGas = estimated.maxFeePerGas
  if (estimated.maxPriorityFeePerGas !== undefined) fee.maxPriorityFeePerGas = estimated.maxPriorityFeePerGas
  return fee
}

/**
 * Whether a sponsor failure falls back to paying gas from the user's own wallet. The testnet
 * probe's step f (docs/evidence/m3-sponsor-probe.json, Sep 21) measured that a 7702-delegated
 * address holding under 10 MON CAN still pay its own gas, so the fallback is safe — the
 * reviewer flips this constant if a later probe or a Monad change breaks that finding, and the
 * fallback message becomes a refusal with instructions instead.
 */
export const SPONSOR_FALLBACK_TO_SELF_PAY = true

/**
 * Simulates first so a revert surfaces as a named contract error mapped to a protocol code. The
 * simulate is an `eth_call` carrying no gas field — it runs from a wallet holding nothing, which
 * is exactly why it may stay on the sponsored path (M3-D3). With a sponsor set the sponsor is
 * asked next, with NO owner-side `estimateContractGas`: that estimate is `eth_estimateGas` with
 * the owner as sender, which Monad refuses for a wallet that cannot afford the worst case — the
 * very wallet a sponsor exists for. The bundler estimates the operation instead, and the kind's
 * ceiling is checked inside the sponsored sender against the bundler's own `callGasLimit`.
 *
 * Only the self-paid path — no sponsor, or a sponsor that refused before accepting — runs the
 * estimate, the ceiling check and the balance guard: the send is refused above the kind's
 * ceiling (Monad bills the limit, not the usage), and within it goes out with `gas` set
 * explicitly to the estimate — no padding. A receipt with status "reverted" (for example a
 * Monad reserve-balance revert after inclusion) is an error, never a silent success.
 */
export async function sendContract(
  context: WriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  kind: TxKind,
): Promise<SentReceipt> {
  let request: unknown
  try {
    ;({ request } = await context.publicClient.simulateContract({
      account: context.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never))
  } catch (error) {
    // The simulation failing means nothing was broadcast — the error is marked sent:false so a
    // retrying caller knows resubmission cannot double-send.
    throw markUnsent(toMidaError(error))
  }
  let sponsorReason: string | undefined
  if (context.sponsor !== undefined) {
    try {
      return await context.sponsor.send(call, kind)
    } catch (error) {
      // SPONSOR_PENDING leaves through this line untouched: the operation was accepted and may
      // still land, so a self-paid copy is exactly the double-send this seam must never create.
      // A GAS_CEILING_EXCEEDED from the sponsored path's own bundler-estimate check leaves the
      // same way — a local policy refusal, never a fallback candidate.
      if (!(error instanceof SponsorDidNotPay)) throw error
      if (!SPONSOR_FALLBACK_TO_SELF_PAY) {
        // The probe (m3-sponsor-probe step f, Sep 21) measured that a delegated address under
        // 10 MON CAN pay its own gas — while that stays true the fallback below is safe and this
        // branch is unreachable. If a Monad change ever makes self-pay impossible for delegated
        // addresses, flipping the constant turns the silent failure mode into this refusal.
        throw new MidaError(
          "SPONSOR_FAILED",
          `the gas sponsor did not pay (${error.reason}) and this build cannot fall back to self-pay — fund the wallet or try the sponsor again later`,
        )
      }
      sponsorReason = error.reason
      context.progress?.(`the gas sponsor did not pay (${error.reason}); paying from your own wallet…`)
      // falls through to the self-paid path — exactly one attempt, never a retry loop
    }
  }
  let gas: bigint
  let fee: SendFee | undefined
  // Everything between the simulation and writeContract is still pre-send — estimate, fee, and the
  // balance guard all run before a transaction can exist. Whatever they throw is marked sent:false;
  // the sponsor block above is deliberately outside this marking because its send may be in flight.
  try {
    try {
      // The per-kind ceiling on the self-paid path: the node's estimate is refused over the kind's
      // ceiling, locally, before the send is priced (M3-D). This estimate is deliberately absent
      // from the sponsored path above — the payer there is the sponsor, and the bundler's own
      // callGasLimit is what gets checked.
      gas = await contractGas(context, call, kind)
    } catch (error) {
      // The ceiling refusal stays a ceiling refusal — that is the estimate succeeding with a
      // number, not the estimate itself being refused.
      if (isMidaError(error, "GAS_CEILING_EXCEEDED")) throw error
      ;({ gas, fee } = await estimateAfterRefusal(context, call, kind, sponsorReason, error))
    }
    if (fee === undefined) {
      try {
        // The fee is estimated ONCE here and forwarded into the send below: the balance guard checks
        // gasLimit × this maxFeePerGas, the node checks the same product, and no second estimate can
        // drift between the two reads (R5-9).
        fee = await estimateSendFee(context)
      } catch (error) {
        throw toMidaError(error)
      }
    }
    await context.beforeSend?.({ payer: context.account.address, gasLimit: gas, fee })
  } catch (error) {
    throw markUnsent(error)
  }
  const hash = await context.walletClient.writeContract({ ...(request as object), gas, ...fee } as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") {
    throw new MidaError("CAPABILITY_DENIED", `${call.functionName} transaction ${hash} reverted on-chain`)
  }
  return { ...receipt, gasLimit: gas }
}

/**
 * Recovery for a gas ESTIMATE that itself was refused (M3-D6 item 1). On Monad,
 * `eth_estimateGas` rejects for a wallet that cannot afford the worst case — before `beforeSend`
 * could run, so the owner saw the node's raw error instead of the wallet sentence. Here the
 * balance guard is asked against an UPPER BOUND — the kind's ceiling × the current max fee —
 * instead. A wallet that cannot pay even the bound refuses with the plain OWNER_WALLET_LOW
 * sentence (the sponsor's one-line reason kept in front of it); a wallet that CAN pay the
 * bound — typically because a funder just topped it up — gets the estimate retried, and the
 * send then runs through the ordinary check with the real numbers.
 */
async function estimateAfterRefusal(
  context: WriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  kind: TxKind,
  sponsorReason: string | undefined,
  error: unknown,
): Promise<{ gas: bigint; fee: SendFee }> {
  if (context.beforeSend === undefined) throw toMidaError(error)
  let fee: SendFee
  try {
    fee = await estimateSendFee(context)
  } catch (feeError) {
    throw toMidaError(feeError)
  }
  try {
    await context.beforeSend({ payer: context.account.address, gasLimit: GAS_CEILINGS[kind], fee, upperBound: true })
  } catch (low) {
    if (isMidaError(low, "OWNER_WALLET_LOW") && sponsorReason !== undefined) {
      // the sentence stays intact — the sponsor's one-line reason goes in front of it, so the
      // owner learns both who refused to pay and what their own wallet lacks
      const sentence = low.message.startsWith(`${low.code}: `) ? low.message.slice(low.code.length + 2) : low.message
      throw new MidaError("OWNER_WALLET_LOW", `the gas sponsor did not pay (${sponsorReason}); ${sentence}`)
    }
    throw low
  }
  try {
    return { gas: await contractGas(context, call, kind), fee }
  } catch (retried) {
    throw toMidaError(retried)
  }
}

/**
 * A plain value transfer under the same ceiling rule: the node's estimate is the explicit `gas`
 * on the send, refused above the kind's ceiling. Used for environment funding (R3-1).
 */
export async function sendValue(
  context: WriteContext,
  transfer: { to: Address; value: bigint },
  kind: TxKind,
): Promise<SentReceipt> {
  let gas: bigint
  let fee: SendFee
  try {
    ;[gas, fee] = await Promise.all([valueGas(context, transfer, kind), estimateSendFee(context)])
  } catch (error) {
    throw toMidaError(error)
  }
  await context.beforeSend?.({ payer: context.account.address, gasLimit: gas, fee, value: transfer.value })
  const hash = await context.walletClient.sendTransaction({
    account: context.account,
    chain: context.walletClient.chain,
    to: transfer.to,
    value: transfer.value,
    gas,
    ...fee,
  } as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") {
    throw new MidaError("CAPABILITY_DENIED", `funding transaction ${hash} reverted on-chain`)
  }
  return { ...receipt, gasLimit: gas }
}

/**
 * Operator-side agent registration (§4.3). The proposed signer signs MidaAgentRegistrationV1 over every field;
 * the contract fixes encryptionKeyVersion and capabilityManifestVersion at 1.
 */
export async function registerAgent(
  context: WriteContext,
  input: { agentSalt: Hex; signer: LocalAccount; encryptionPublicKey: Hex; callbackOrigin: string; capabilityManifestHash: Hex },
): Promise<{ agentId: Hex; receipt: TransactionReceipt }> {
  const { deployment } = context
  const operator = context.account.address
  const agentId = deriveAgentId({
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    operator,
    agentSalt: input.agentSalt,
  })
  const callbackOriginHash = originHash(canonicalizeOrigin(input.callbackOrigin, { allowLocalhost: true }))
  const signature = await input.signer.signTypedData(
    agentRegistrationTypedData({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      agentId,
      operator,
      signer: input.signer.address,
      encryptionPublicKey: input.encryptionPublicKey,
      encryptionKeyVersion: 1,
      callbackOriginHash,
      capabilityManifestHash: input.capabilityManifestHash,
      capabilityManifestVersion: 1n,
    }) as never,
  )
  const receipt = await sendContract(
    context,
    {
      address: deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "registerAgent",
      args: [input.agentSalt, input.signer.address, input.encryptionPublicKey, callbackOriginHash, input.capabilityManifestHash, signature],
    },
    "agent.register",
  )
  return { agentId, receipt }
}
