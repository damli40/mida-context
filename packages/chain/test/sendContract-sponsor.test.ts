// M3-D item 2(ii), reworked by M3-D3 item 1: the sendContract seam. With a sponsor set, the
// simulate runs and the sponsor is asked FIRST — no `estimateContractGas` (Monad refuses that
// call for a wallet that cannot afford the worst case, which is exactly the wallet the sponsor
// exists for). The estimate, the fee read and the balance guard run only on the self-paid path:
// no sponsor at all, or after a SponsorDidNotPay. The per-kind ceiling on the sponsored path is
// enforced inside the sponsored sender against the bundler's own callGasLimit estimate.

import { describe, expect, it } from "vitest"
import { MidaError, isMidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { SPONSOR_FALLBACK_TO_SELF_PAY, SponsorDidNotPay, sendContract } from "@mida/chain"
import type { SponsoredSender, WriteContext } from "@mida/chain"

const ADDRESS: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
const HASH: Hex = `0x${"ab".repeat(32)}`
const USER_OP_HASH: Hex = `0x${"cd".repeat(32)}`

const call = { address: ADDRESS, abi: [], functionName: "register", args: [] } as const

function stubContext(over: {
  estimate?: bigint
  sponsor?: SponsoredSender
  progress?: (line: string) => void
  beforeSend?: () => Promise<void>
}) {
  const sent: { gas?: bigint }[] = []
  let feeEstimates = 0
  let gasEstimates = 0
  const context = {
    account: { address: ADDRESS },
    publicClient: {
      simulateContract: async () => ({ request: { address: ADDRESS, functionName: "register" } }),
      estimateContractGas: async () => {
        gasEstimates += 1
        return over.estimate ?? 300_000n
      },
      estimateFeesPerGas: async () => {
        feeEstimates += 1
        return { maxFeePerGas: 12n, maxPriorityFeePerGas: 1n }
      },
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: HASH, gasUsed: 1n }),
    },
    walletClient: {
      chain: { id: 31337 },
      writeContract: async (request: { gas?: bigint }) => {
        sent.push(request)
        return HASH
      },
    },
    beforeSend: over.beforeSend,
    sponsor: over.sponsor,
    progress: over.progress,
    deployment: {
      chainId: 31337n,
      capabilityRegistry: ADDRESS,
      contextRegistry: ADDRESS,
      deploymentBlock: 0n,
      policyHashV1: `0x${"00".repeat(32)}` as Hex,
      vaultRpId: "vault.mida.xyz",
      vaultRpIdHash: `0x${"00".repeat(32)}` as Hex,
    },
  } as unknown as WriteContext
  return { context, sent, feeEstimates: () => feeEstimates, gasEstimates: () => gasEstimates }
}

const successfulSponsor = (send?: SponsoredSender["send"]): SponsoredSender => ({
  send:
    send ??
    (async () => ({
      status: "success",
      transactionHash: HASH,
      gasUsed: 1n,
      gasLimit: 500_000n,
      userOpHash: USER_OP_HASH,
    })) as unknown as SponsoredSender["send"],
})

describe("sendContract with a sponsor wired", () => {
  it("the constant stays true — the Sep 21 probe showed a delegated address under 10 MON can self-pay", () => {
    expect(SPONSOR_FALLBACK_TO_SELF_PAY).toBe(true)
  })

  it("a paying sponsor answers the send — no self-paid transaction, no balance guard, no fee read, NO gas estimate", async () => {
    let guarded = 0
    const { context, sent, feeEstimates, gasEstimates } = stubContext({
      sponsor: successfulSponsor(),
      beforeSend: async () => {
        guarded += 1
      },
    })
    const receipt = await sendContract(context, call, "context.register")
    expect((receipt as { userOpHash?: Hex }).userOpHash).toBe(USER_OP_HASH)
    expect(receipt.gasLimit).toBe(500_000n)
    expect(sent).toHaveLength(0) // no self-paid writeContract went out
    expect(guarded).toBe(0) // the wallet guard is skipped: the user pays nothing
    expect(feeEstimates()).toBe(0) // the self-paid fee is not needed on the sponsored path
    // The M3-D3 fix: estimateContractGas is eth_estimateGas with the owner as sender — Monad
    // refuses it for a wallet that cannot afford the worst case, which is exactly the wallet a
    // sponsor exists for. On the sponsored path it must never run; the bundler estimates.
    expect(gasEstimates()).toBe(0)
  })

  it("SponsorDidNotPay falls back to self-pay and says so on the progress line", async () => {
    const lines: string[] = []
    let guarded = 0
    const sponsor = successfulSponsor(async () => {
      throw new SponsorDidNotPay("refused: the sponsor's daily budget is exhausted")
    })
    const { context, sent, gasEstimates } = stubContext({
      sponsor,
      progress: (line) => lines.push(line),
      beforeSend: async () => {
        guarded += 1
      },
    })
    const receipt = await sendContract(context, call, "context.register")
    expect(receipt.transactionHash).toBe(HASH)
    expect(sent).toHaveLength(1) // the self-paid writeContract went out
    expect(guarded).toBe(1) // self-paid means the balance guard runs again
    expect(gasEstimates()).toBe(1) // the estimate is the self-paid path's — it runs only here
    expect(lines).toEqual(["the gas sponsor did not pay (refused: the sponsor's daily budget is exhausted); paying from your own wallet…"])
  })

  it("a sponsor refusal on an empty wallet surfaces the guard's plain low-balance message", async () => {
    const sponsor = successfulSponsor(async () => {
      throw new SponsorDidNotPay("refused: the sponsor's daily budget is exhausted")
    })
    const low = new MidaError("OWNER_WALLET_LOW", "your wallet holds 0.0000 MON but this transaction needs 0.0060 MON — 0.0060 MON short")
    const { context, sent, gasEstimates } = stubContext({
      sponsor,
      beforeSend: async () => {
        throw low
      },
    })
    const error = await sendContract(context, call, "context.register").then(() => null, (e: unknown) => e)
    expect(error).toBe(low) // the wallet guard's own message, unwrapped
    expect(isMidaError(error, "OWNER_WALLET_LOW")).toBe(true)
    expect(gasEstimates()).toBe(1) // the estimate ran — the fallback prices the send first
    expect(sent).toHaveLength(0) // the guard refused before anything went out
  })

  it("a sponsored operation that reverted is not a fallback candidate — the error propagates", async () => {
    const reverted = new MidaError("CAPABILITY_DENIED", "register user operation 0xabc reverted on-chain")
    const sponsor = successfulSponsor(async () => {
      throw reverted
    })
    const { context, sent } = stubContext({ sponsor })
    const error = await sendContract(context, call, "context.register").then(() => null, (e: unknown) => e)
    expect(error).toBe(reverted)
    expect(sent).toHaveLength(0) // no second, self-paid copy of a reverting call
  })

  it("a ceiling refusal from the sponsored path propagates — it is not a fallback candidate", async () => {
    // M3-D3: the ceiling on the sponsored path is the bundler's callGasLimit, checked inside the
    // sponsored sender — a different message from the self-paid ceiling and never SponsorDidNotPay.
    const over = new MidaError("GAS_CEILING_EXCEEDED", "context.register: the bundler's callGasLimit 7000000 exceeds ceiling 650000")
    let asked = 0
    const sponsor = successfulSponsor(async () => {
      asked += 1
      throw over
    })
    const { context, sent, gasEstimates } = stubContext({ sponsor })
    const error = await sendContract(context, call, "context.register").then(() => null, (e: unknown) => e)
    expect(error).toBe(over)
    expect(isMidaError(error, "GAS_CEILING_EXCEEDED")).toBe(true)
    expect(asked).toBe(1) // the sponsor is asked first — it owns the ceiling check now
    expect(gasEstimates()).toBe(0) // and the owner-side estimate still never ran
    expect(sent).toHaveLength(0)
  })

  it("SPONSOR_PENDING propagates untouched — an accepted operation never gets a self-paid copy", async () => {
    const pending = new MidaError(
      "SPONSOR_PENDING",
      `sponsored operation ${USER_OP_HASH} was accepted and may still land — check it before retrying; nothing was sent from your wallet`,
    ) as MidaError & { userOpHash: Hex }
    pending.userOpHash = USER_OP_HASH
    const sponsor = successfulSponsor(async () => {
      throw pending
    })
    const { context, sent } = stubContext({ sponsor })
    const error = await sendContract(context, call, "context.register").then(() => null, (e: unknown) => e)
    expect(error).toBe(pending)
    expect(sent).toHaveLength(0) // ZERO self-paid sends: the operation was accepted
  })

  it("a sponsor error that is not SponsorDidNotPay propagates untouched", async () => {
    const weird = new MidaError("NOT_FOUND", "contract reverted ContextNotFound")
    const sponsor = successfulSponsor(async () => {
      throw weird
    })
    const { context, sent } = stubContext({ sponsor })
    const error = await sendContract(context, call, "context.register").then(() => null, (e: unknown) => e)
    expect(error).toBe(weird)
    expect(sent).toHaveLength(0)
  })
})
