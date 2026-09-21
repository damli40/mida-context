import { MidaError } from "@mida/protocol"
import { createPublicClient, encodeFunctionData, http } from "viem"
import type { Abi, Address, Hex, LocalAccount } from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { createSmartAccountClient } from "permissionless"
import { to7702SimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { chainFor } from "./deployment.js"
import type { Deployment } from "./deployment.js"
import type { TxKind } from "./gas.js"
import { REVERT_CODES, revertNameFromData } from "./registry.js"
import type { SentReceipt } from "./writes.js"

/**
 * The account implementation the SDK's first sponsored operation delegates to — Pimlico's
 * Simple7702Account, the default inside `to7702SimpleSmartAccount`. The sponsor endpoint's
 * ALLOWED_IMPLEMENTATIONS must contain this address or every first operation is refused.
 */
export const SPONSORED_IMPLEMENTATION: Address = "0xe6Cae83BdE06E4c305530e199D7217f42808555B"

/** A sponsored attempt gets this long end to end; past it the caller falls back or refuses. */
export const SPONSOR_TIMEOUT_MS = 20_000

/** EIP-7702 delegated code on an address starts with this designator followed by the implementation. */
const DELEGATION_PREFIX = "0xef0100"

/**
 * Every way a sponsored send can fail before the operation lands: refusal, unreachable endpoint,
 * timeout, malformed answer. `sendContract` falls back to self-pay only on this type — an operation
 * that was included and reverted is a different outcome (the sponsor DID pay) and is never retried.
 */
export class SponsorDidNotPay extends MidaError {
  constructor(detail: string) {
    super("SPONSOR_FAILED", detail)
    this.name = "SponsorDidNotPay"
  }
}

/**
 * A sponsored send's answer, shaped like the self-paid `SentReceipt`: `transactionHash` is the
 * bundle transaction, `gasLimit` the sum of the operation's gas fields (Monad bills the sponsor
 * for the limit on every field, not the usage), plus the `userOpHash` the bundle carries.
 */
export type SponsoredReceipt = SentReceipt & { userOpHash: Hex }

export interface SponsoredSender {
  /**
   * Sends one contract call as a sponsored user operation. `kind` is already enforced by the
   * caller's ceiling check before this is asked — it is part of the signature so the seam reads
   * the same as the self-paid send, and so a future per-kind op-level check needs no new shape.
   */
  send(
    call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
    kind: TxKind,
  ): Promise<SponsoredReceipt>
}

/**
 * A sender whose gas is paid by the Mida sponsor endpoint while `sender` stays the user's own
 * address — the contracts still see the user as msg.sender. `sponsorUrl` speaks the Pimlico
 * bundler+paymaster JSON-RPC dialect our sponsor worker proxies (EntryPoint v0.8). The user's
 * first operation signs an EIP-7702 authorization for `implementation`; later ones carry none,
 * because the delegation is already on chain.
 */
export async function createSponsoredSender(input: {
  sponsorUrl: string
  rpcUrl: string
  account: LocalAccount
  deployment: Deployment
  /** Override the delegated implementation — must be on the endpoint's allow list. */
  implementation?: Address
  /** Whole-attempt deadline, default SPONSOR_TIMEOUT_MS; tests pass less. */
  timeoutMs?: number
  /** Receipt polling interval; viem's default when unset. */
  pollingIntervalMs?: number
}): Promise<SponsoredSender> {
  const chain = chainFor(input.deployment.chainId)
  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl) })
  const pimlico = createPimlicoClient({
    chain,
    transport: http(input.sponsorUrl),
    entryPoint: { address: entryPoint08Address, version: "0.8" },
  })
  const smartAccount = await to7702SimpleSmartAccount({ client: publicClient, owner: input.account })
  const bundler = createSmartAccountClient({
    account: smartAccount,
    chain,
    bundlerTransport: http(input.sponsorUrl),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })
  const implementation = input.implementation ?? SPONSORED_IMPLEMENTATION
  const timeoutMs = input.timeoutMs ?? SPONSOR_TIMEOUT_MS

  return {
    async send(call, _kind) {
      const work = (async (): Promise<SponsoredReceipt> => {
        const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never)
        // A delegated sender needs no authorization — the endpoint reads the delegation from
        // chain instead; carrying a fresh one anyway would spend a signature for nothing.
        const code = await publicClient.getCode({ address: input.account.address })
        const delegated = typeof code === "string" && code.toLowerCase().startsWith(DELEGATION_PREFIX)
        if (!delegated && input.account.signAuthorization === undefined) {
          throw new SponsorDidNotPay("this account cannot sign an EIP-7702 authorization")
        }
        const authorization = delegated
          ? undefined
          : // The bundler sends the transaction, so the authorization nonce is the address's
            // CURRENT transaction count — the probe found count+1 refused by the bundler.
            await input.account.signAuthorization!({
              address: implementation,
              chainId: Number(input.deployment.chainId),
              nonce: await publicClient.getTransactionCount({ address: input.account.address }),
            })
        const userOpHash = (await bundler.sendUserOperation({
          calls: [{ to: call.address, value: 0n, data }],
          authorization,
        })) as Hex
        const receipt = await bundler.waitForUserOperationReceipt({
          hash: userOpHash,
          timeout: timeoutMs,
          pollingInterval: input.pollingIntervalMs,
        })
        if (!receipt.success) {
          // The sponsor paid and the call still reverted — the same failure a reverted
          // transaction is today, never a silent success and never a fallback candidate.
          const reason = (receipt as { reason?: unknown }).reason
          const decoded = typeof reason === "string" && reason.startsWith("0x") ? revertNameFromData(reason as Hex) : undefined
          const mapped = decoded === undefined ? undefined : REVERT_CODES[decoded]
          if (mapped !== undefined) throw new MidaError(mapped, `contract reverted ${decoded}`)
          throw new MidaError(
            "CAPABILITY_DENIED",
            `${call.functionName} user operation ${userOpHash} reverted on-chain${typeof reason === "string" ? ` (${reason})` : ""}`,
          )
        }
        return { ...receipt.receipt, gasLimit: await operationGasLimit(pimlico, userOpHash, receipt), userOpHash }
      })()
      try {
        return await within(work, timeoutMs)
      } catch (error) {
        // MidaError passes through untouched: reverts keep their mapped code and an already-wrapped
        // sponsor failure is not wrapped twice. Everything else — refused, down, timeout, a shape
        // the client could not parse — becomes SponsorDidNotPay, the only error the seam falls back on.
        if (error instanceof MidaError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new SponsorDidNotPay(message.length > 200 ? `${message.slice(0, 200)}…` : message)
      }
    },
  }
}

/**
 * What Monad billed the sponsor for the operation: the sum of its gas LIMIT fields. Read back from
 * `eth_getUserOperationByHash` — the same shape the probe's gas-fields step used; when the bundler
 * no longer has the operation the receipt's `actualGasUsed` stands in, which under-reads honestly
 * rather than inventing fields.
 */
async function operationGasLimit(
  pimlico: ReturnType<typeof createPimlicoClient>,
  userOpHash: Hex,
  receipt: { actualGasUsed?: bigint },
): Promise<bigint> {
  const record = await pimlico.getUserOperation({ hash: userOpHash }).catch(() => null)
  const operation = (record as { userOperation?: Record<string, unknown> } | null)?.userOperation
  if (operation === undefined) return receipt.actualGasUsed ?? 0n
  let sum = 0n
  for (const key of ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]) {
    const value = operation[key]
    if (typeof value === "string" && value.startsWith("0x")) sum += BigInt(value)
    else if (typeof value === "bigint") sum += value
    else if (typeof value === "number") sum += BigInt(value)
  }
  return sum
}

/** Races the sponsored attempt against its deadline; a timeout is a SponsorDidNotPay. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SponsorDidNotPay(`the sponsor did not answer within ${ms} ms`)), ms)
    if (typeof timer.unref === "function") timer.unref()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
