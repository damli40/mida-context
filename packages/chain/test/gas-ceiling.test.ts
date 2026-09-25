import { describe, expect, it } from "vitest"
import { isMidaError } from "@mida/protocol"
import type { Address, Hex, MidaError } from "@mida/protocol"
import { GAS_CEILINGS, failedBeforeSend, sendContract, sendValue } from "@mida/chain"
import type { WriteContext } from "@mida/chain"

const ADDRESS: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
const HASH: Hex = `0x${"ab".repeat(32)}`

/**
 * A WriteContext whose chain calls are stubs: simulate always succeeds, the estimate is
 * scripted, and writeContract/sendTransaction record the exact request they were given so
 * the test can assert the `gas` field the transaction was sent with.
 */
function stubContext(estimate: bigint | (() => Promise<bigint>)) {
  const sent: { gas?: bigint }[] = []
  const context = {
    account: { address: ADDRESS },
    publicClient: {
      simulateContract: async () => ({ request: { address: ADDRESS, functionName: "register" } }),
      estimateContractGas: typeof estimate === "function" ? estimate : async () => estimate,
      estimateGas: typeof estimate === "function" ? estimate : async () => estimate,
      // every send now prices its fee once (R5-9) — the stub answers a fixed EIP-1559 pair
      estimateFeesPerGas: async () => ({ maxFeePerGas: 12n, maxPriorityFeePerGas: 1n }),
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: HASH, gasUsed: 1n }),
    },
    walletClient: {
      chain: { id: 31337 },
      writeContract: async (request: { gas?: bigint }) => {
        sent.push(request)
        return HASH
      },
      sendTransaction: async (request: { gas?: bigint }) => {
        sent.push(request)
        return HASH
      },
    },
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
  return { context, sent }
}

describe("the shared gas ceiling (R3-1)", () => {
  it("sends with gas set explicitly to the estimate when it is under the ceiling", async () => {
    const estimate = 300_000n // under the context.register ceiling
    const { context, sent } = stubContext(estimate)
    const receipt = await sendContract(context, { address: ADDRESS, abi: [], functionName: "register", args: [] }, "context.register")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.gas).toBe(estimate)
    expect(receipt.gasLimit).toBe(estimate)
  })

  it("refuses to send when the estimate is above the ceiling, naming kind, estimate and ceiling", async () => {
    const over = GAS_CEILINGS["context.register"] + 1n
    const { context, sent } = stubContext(over)
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "register", args: [] }, "context.register").then(
      () => null,
      (e: unknown) => e,
    )
    expect(isMidaError(error, "GAS_CEILING_EXCEEDED")).toBe(true)
    expect((error as Error).message).toContain("context.register")
    expect((error as Error).message).toContain(over.toString())
    expect((error as Error).message).toContain(GAS_CEILINGS["context.register"].toString())
    expect(sent).toHaveLength(0) // nothing was sent — on Monad the limit itself is billed
  })

  it("an estimate call that fails surfaces the original error and sends nothing", async () => {
    const boom = new Error("node exploded")
    const { context, sent } = stubContext(async () => {
      throw boom
    })
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "register", args: [] }, "context.register").then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBe(boom)
    expect(sent).toHaveLength(0)
  })

  it("every ceiling is a positive bigint above the raw 21,000 transfer floor", () => {
    for (const [kind, ceiling] of Object.entries(GAS_CEILINGS)) {
      expect(typeof ceiling, kind).toBe("bigint")
      expect(ceiling, kind).toBeGreaterThanOrEqual(21_000n)
    }
  })

  it('"batch.submit" is its own kind, sized under Monad\'s 30M per-transaction gas limit', () => {
    // Monad refuses any transaction over 30,000,000 gas; 28M leaves 2M of headroom because the
    // estimate is taken before inclusion. The Sep 24 sweep measured ~61k gas per save, so a
    // batch-submit ceiling near the wall is what lets batches grow past the old 60-save cap.
    expect(GAS_CEILINGS["batch.submit"]).toBe(28_000_000n)
  })

  it("a batch submit whose estimate crosses the ceiling is refused before send", async () => {
    const estimate = 29_000_000n // under Monad's 30M wall but over the 28M batch-submit budget
    const { context, sent } = stubContext(estimate)
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "submitBatch", args: [] }, "batch.submit").then(
      () => null,
      (e: unknown) => e,
    )
    expect(isMidaError(error, "GAS_CEILING_EXCEEDED")).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it("a refusal carries the estimate and ceiling it compared, so a caller re-sizes from numbers not text", async () => {
    const estimate = 29_000_000n
    const { context } = stubContext(estimate)
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "submitBatch", args: [] }, "batch.submit").then(
      () => null,
      (e: unknown) => e,
    )
    expect(isMidaError(error, "GAS_CEILING_EXCEEDED")).toBe(true)
    // The batcher divides estimate by its take to learn the per-save cost the node computed —
    // parsing the message would break on any wording change, so the numbers ride the error itself.
    expect((error as MidaError).estimate).toBe(estimate)
    expect((error as MidaError).ceiling).toBe(GAS_CEILINGS["batch.submit"])
  })

  it("a simulation failure is marked sent:false — no transaction left the process", async () => {
    const { context, sent } = stubContext(300_000n)
    ;(context.publicClient as { simulateContract: unknown }).simulateContract = async () => {
      throw new Error("execution reverted: BatchExists")
    }
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "register", args: [] }, "context.register").then(
      () => null,
      (e: unknown) => e,
    )
    expect(failedBeforeSend(error)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it("a ceiling refusal is marked sent:false — the estimate ran before the send", async () => {
    const { context, sent } = stubContext(GAS_CEILINGS["batch.submit"] + 1n)
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "submitBatch", args: [] }, "batch.submit").then(
      () => null,
      (e: unknown) => e,
    )
    expect(failedBeforeSend(error)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it("a failure after writeContract is NOT marked — the transaction may already have landed", async () => {
    const { context, sent } = stubContext(300_000n)
    ;(context.publicClient as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt = async () => {
      throw new Error("the receipt never arrived")
    }
    const error = await sendContract(context, { address: ADDRESS, abi: [], functionName: "register", args: [] }, "context.register").then(
      () => null,
      (e: unknown) => e,
    )
    expect(failedBeforeSend(error)).toBe(false)
    expect(sent).toHaveLength(1) // the send went out — its answer was what got lost
  })

  it("the plain value transfer is bounded by its own kind and sent with the explicit estimate", async () => {
    const estimate = 21_000n
    const { context, sent } = stubContext(estimate)
    await sendValue(context, { to: ADDRESS, value: 10n }, "funding")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.gas).toBe(estimate)
  })

  it("a funding estimate over its ceiling refuses the transfer", async () => {
    const { context, sent } = stubContext(GAS_CEILINGS.funding + 1n)
    const error = await sendValue(context, { to: ADDRESS, value: 10n }, "funding").then(
      () => null,
      (e: unknown) => e,
    )
    expect(isMidaError(error, "GAS_CEILING_EXCEEDED")).toBe(true)
    expect(sent).toHaveLength(0)
  })
})
