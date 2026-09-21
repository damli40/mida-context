// M3-D item 2(ii): the sendContract seam. The sponsor gets one attempt after the ceiling check;
// SponsorDidNotPay falls back to self-pay with a progress line, every other error propagates.

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
  const context = {
    account: { address: ADDRESS },
    publicClient: {
      simulateContract: async () => ({ request: { address: ADDRESS, functionName: "register" } }),
      estimateContractGas: async () => over.estimate ?? 300_000n,
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
  return { context, sent, feeEstimates: () => feeEstimates }
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

  it("a paying sponsor answers the send — no self-paid transaction, no balance guard, no fee read", async () => {
    let guarded = 0
    const { context, sent, feeEstimates } = stubContext({
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
  })

  it("SponsorDidNotPay falls back to self-pay and says so on the progress line", async () => {
    const lines: string[] = []
    let guarded = 0
    const sponsor = successfulSponsor(async () => {
      throw new SponsorDidNotPay("refused: the sponsor's daily budget is exhausted")
    })
    const { context, sent } = stubContext({
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
    expect(lines).toEqual(["the gas sponsor did not pay (refused: the sponsor's daily budget is exhausted); paying from your own wallet…"])
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

  it("the gas ceiling refuses before the sponsor is ever asked", async () => {
    let asked = 0
    const sponsor = successfulSponsor(async () => {
      asked += 1
      return {} as never
    })
    const { context, sent } = stubContext({ sponsor, estimate: 6_500_000n }) // over every ceiling
    const error = await sendContract(context, call, "context.register").then(() => null, (e: unknown) => e)
    expect(isMidaError(error, "GAS_CEILING_EXCEEDED")).toBe(true)
    expect(asked).toBe(0)
    expect(sent).toHaveLength(0)
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
