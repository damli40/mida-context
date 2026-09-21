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

export interface WriteContext extends ChainContext {
  walletClient: WalletClient
  account: Account
  /**
   * Runs between the gas estimate and the send: the payer's balance can be checked against the
   * estimated cost and topped up, or the send refused before a transaction the wallet cannot
   * pay for goes out (R4-4). Only the owner's context wires this; agent signers keep the bare
   * node error, exactly as before.
   */
  beforeSend?: (cost: { payer: Address; gasLimit: bigint }) => Promise<void>
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
  try {
    gas = await contractGas(context, call, kind)
  } catch (error) {
    throw toMidaError(error)
  }
  await context.beforeSend?.({ payer: context.account.address, gasLimit: gas })
  const hash = await context.walletClient.writeContract({ ...(request as object), gas } as never)
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
  try {
    gas = await valueGas(context, transfer, kind)
  } catch (error) {
    throw toMidaError(error)
  }
  await context.beforeSend?.({ payer: context.account.address, gasLimit: gas })
  const hash = await context.walletClient.sendTransaction({
    account: context.account,
    chain: context.walletClient.chain,
    to: transfer.to,
    value: transfer.value,
    gas,
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
