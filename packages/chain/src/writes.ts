import {
  MidaError,
  agentId as deriveAgentId,
  agentRegistrationTypedData,
  canonicalizeOrigin,
  originHash,
} from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { createPublicClient, createWalletClient, http } from "viem"
import type { Abi, Account, LocalAccount, PublicClient, TransactionReceipt, WalletClient } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import { chainFor } from "./deployment.js"
import type { Deployment } from "./deployment.js"
import { contractGas, valueGas } from "./gas.js"
import type { TxKind } from "./gas.js"
import { toMidaError } from "./registry.js"
import type { ChainContext } from "./registry.js"

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
}

export interface WriteContext extends ChainContext {
  walletClient: WalletClient
  account: Account
  /**
   * Runs between the gas estimate and the send: the payer's balance can be checked against the
   * estimated cost and topped up, or the send refused before a transaction the wallet cannot
   * pay for goes out (R4-4). Only the owner's context wires this; agent signers keep the bare
   * node error, exactly as before.
   */
  beforeSend?: (cost: SendCost) => Promise<void>
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
 * Simulates first so a revert surfaces as a named contract error mapped to a protocol code, then
 * estimates the gas and refuses the send when the estimate exceeds the kind's ceiling (Monad bills
 * the limit, not the usage). Within the ceiling the transaction is sent with `gas` set explicitly
 * to the estimate — no padding — and the receipt comes back carrying that limit as `gasLimit`.
 * A receipt with status "reverted" (for example a Monad reserve-balance revert after inclusion)
 * is an error, never a silent success.
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
    throw toMidaError(error)
  }
  let gas: bigint
  let fee: SendFee
  try {
    // The fee is estimated ONCE here and forwarded into the send below: the balance guard checks
    // gasLimit × this maxFeePerGas, the node checks the same product, and no second estimate can
    // drift between the two reads (R5-9).
    ;[gas, fee] = await Promise.all([contractGas(context, call, kind), estimateSendFee(context)])
  } catch (error) {
    throw toMidaError(error)
  }
  await context.beforeSend?.({ payer: context.account.address, gasLimit: gas, fee })
  const hash = await context.walletClient.writeContract({ ...(request as object), gas, ...fee } as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") {
    throw new MidaError("CAPABILITY_DENIED", `${call.functionName} transaction ${hash} reverted on-chain`)
  }
  return { ...receipt, gasLimit: gas }
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
