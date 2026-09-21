import { describe, expect, it } from "vitest"
import { sendContract, sendValue } from "@mida/chain"
import type { SendCost } from "@mida/chain"
import type { Address } from "@mida/protocol"
import { formatMon, makeOwnerBalanceGuard } from "@mida/midad"

/**
 * R4-4/R5-9 — before an owner transaction goes out, the wallet is checked against
 * gasLimit × the maxFeePerGas THE SEND WILL CARRY (not a fresh, cheaper gas-price
 * read). A network with a funder tops the wallet up first — and the balance is
 * re-read afterwards, because a fixed top-up can under-shoot a large send;
 * without a funder the send is refused with OWNER_WALLET_LOW and the balance,
 * the cost and the shortfall all named in MON.
 */

const PAYER = `0x${"ab".repeat(20)}` as Address
const EIP1559 = { maxFeePerGas: 120n, maxPriorityFeePerGas: 2n }

function chainWith(balances: bigint[], extras: Record<string, unknown> = {}) {
  // balance reads in call order — the guard reads once before and once after a top-up
  let read = 0
  return {
    account: { address: PAYER },
    publicClient: {
      getBalance: async () => balances[Math.min(read++, balances.length - 1)],
      ...extras,
    },
  } as never
}

const guardOver = (balances: bigint[], over: Record<string, unknown> = {}) =>
  makeOwnerBalanceGuard({ chain: chainWith(balances), ...over } as never)

describe("makeOwnerBalanceGuard (R4-4/R5-9)", () => {
  it("a wallet that can pay needs no funder and no progress line", async () => {
    let funded = 0
    let progress = 0
    const guard = makeOwnerBalanceGuard({
      chain: chainWith([1_080n]),
      fund: async () => {
        funded += 1
      },
      progress: () => {
        progress += 1
      },
    })
    await guard({ payer: PAYER, gasLimit: 9n, fee: EIP1559 }) // cost 9×120 = 1080
    expect(funded).toBe(0)
    expect(progress).toBe(0)
  })

  it("a balance exactly gasLimit × maxFeePerGas pays — one wei less is refused (R5-9)", async () => {
    await guardOver([1_080n])({ payer: PAYER, gasLimit: 9n, fee: EIP1559 })
    const error = await guardOver([1_079n])({ payer: PAYER, gasLimit: 9n, fee: EIP1559 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
  })

  it("the check prices the fee the send will carry — not the cheaper raw gas price (R5-9)", async () => {
    // the node answers gasPrice 100 but the send goes out offering maxFeePerGas 120
    // (viem's default multiplier); the wallet holds 1,000 — the OLD formula passed
    // (9×100 = 900 ≤ 1000) and the node then refused inside the send
    const chain = chainWith([1_000n], { getGasPrice: async () => 100n })
    const guard = makeOwnerBalanceGuard({ chain })
    const error = await guard({ payer: PAYER, gasLimit: 9n, fee: EIP1559 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
  })

  it("a legacy gasPrice-only fee is priced the same way", async () => {
    await guardOver([900n])({ payer: PAYER, gasLimit: 9n, fee: { gasPrice: 100n } })
    const error = await guardOver([899n])({ payer: PAYER, gasLimit: 9n, fee: { gasPrice: 100n } }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
  })

  it("a plain transfer's value counts toward what the payer must cover (R5-9)", async () => {
    // gas alone would pass (9×120 = 1080 ≤ 1100) but the send also moves 200 of value
    const error = await guardOver([1_100n])({ payer: PAYER, gasLimit: 9n, fee: EIP1559, value: 200n }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
    await guardOver([1_280n])({ payer: PAYER, gasLimit: 9n, fee: EIP1559, value: 200n })
  })

  it("a low wallet on a funded network is topped up with a progress line, then the send continues", async () => {
    const order: string[] = []
    const guard = makeOwnerBalanceGuard({
      chain: chainWith([10n, 700n]), // 10 before, 700 after the top-up
      fund: async (address) => {
        order.push(`fund ${address}`)
      },
      progress: (line) => order.push(line),
    })
    await guard({ payer: PAYER, gasLimit: 5n, fee: EIP1559 }) // cost 600
    expect(order).toEqual(["topping up your wallet…", `fund ${PAYER}`])
  })

  it("a top-up that still cannot pay is refused — and the funder ran exactly once (R5-9)", async () => {
    let funded = 0
    const guard = makeOwnerBalanceGuard({
      chain: chainWith([10n, 500n]), // the top-up left 500: still short of 600
      fund: async () => {
        funded += 1
      },
    })
    const error = await guard({ payer: PAYER, gasLimit: 5n, fee: EIP1559 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
    expect(funded).toBe(1) // never a top-up loop
    const message = (error as Error).message
    expect(message).toContain(formatMon(500n)) // the POST-top-up balance, not the stale one
    expect(message).toContain(formatMon(600n)) // the cost
    expect(message).toContain(formatMon(100n)) // the shortfall
  })

  it("a low wallet with no funder refuses with OWNER_WALLET_LOW naming balance, cost and shortfall", async () => {
    const MON = 1_000_000_000_000_000_000n
    const guard = makeOwnerBalanceGuard({
      chain: chainWith([MON / 20n]), // 0.05 MON
    })
    const error = await guard({ payer: PAYER, gasLimit: 832_470n, fee: { maxFeePerGas: 100_000_000_000n } }).then(
      () => {
        throw new Error("should have thrown")
      },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: "OWNER_WALLET_LOW" })
    const message = (error as Error).message
    // cost = 832,470 × 100 gwei = 0.0832470... MON → 0.0832; shortfall = 0.0332
    expect(message).toContain("0.0500")
    expect(message).toContain("0.0832")
    expect(message).toContain("0.0332")
  })
})

describe("formatMon", () => {
  it("prints wei as MON to four decimals, truncating — never rounding up", () => {
    expect(formatMon(0n)).toBe("0.0000")
    expect(formatMon(1_500_000_000_000_000_000n)).toBe("1.5000")
    expect(formatMon(83_247_000_000_000_000n)).toBe("0.0832")
    expect(formatMon(1_999_999_999_999_999_999n)).toBe("1.9999")
  })
})

describe("sendContract runs beforeSend between the estimate and the send (R4-4/R5-9)", () => {
  const call = { address: `0x${"cc".repeat(20)}` as Address, abi: [] as never, functionName: "f", args: [] as const }

  function context(over: Record<string, unknown> = {}) {
    const sent: Record<string, unknown>[] = []
    const ctx = {
      deployment: { chainId: 1n, capabilityRegistry: `0x${"11".repeat(20)}`, contextRegistry: `0x${"22".repeat(20)}`, deploymentBlock: 0n },
      account: { address: PAYER },
      publicClient: {
        simulateContract: async () => ({ request: {} }),
        estimateContractGas: async () => 21_000n,
        estimateGas: async () => 21_000n,
        estimateFeesPerGas: async () => ({ ...EIP1559 }),
        waitForTransactionReceipt: async () => ({ status: "success", transactionHash: `0x${"dd".repeat(32)}` }),
      },
      walletClient: {
        writeContract: async (req: Record<string, unknown>) => {
          sent.push(req)
          return `0x${"dd".repeat(32)}`
        },
        sendTransaction: async (req: Record<string, unknown>) => {
          sent.push(req)
          return `0x${"dd".repeat(32)}`
        },
        chain: { id: 1 },
      },
      ...over,
    } as never
    return { ctx, sent }
  }

  it("receives the payer, the gas limit and the send's own fee before the write (R5-9)", async () => {
    const seen: Partial<SendCost> = {}
    const { ctx, sent } = context({
      beforeSend: async (cost: SendCost) => {
        seen.payer = cost.payer
        seen.gasLimit = cost.gasLimit
        seen.fee = cost.fee
      },
    })
    await sendContract(ctx, call, "funding")
    expect(seen).toEqual({ payer: PAYER, gasLimit: 21_000n, fee: EIP1559 })
    expect(sent).toHaveLength(1)
  })

  it("sends the exact fee values the guard checked — estimated once, checked once, sent once (R5-9)", async () => {
    const seen: { fee?: unknown } = {}
    const { ctx, sent } = context({
      beforeSend: async (cost: SendCost) => {
        seen.fee = cost.fee
      },
    })
    await sendContract(ctx, call, "funding")
    // the transaction goes out offering the same maxFeePerGas the balance was checked against —
    // the number checked IS the number sent
    expect(sent[0]).toMatchObject({ gas: 21_000n, maxFeePerGas: EIP1559.maxFeePerGas, maxPriorityFeePerGas: EIP1559.maxPriorityFeePerGas })
    expect(seen.fee).toEqual(EIP1559)
  })

  it("a value transfer tells the guard the value and sends the same fee (R5-9)", async () => {
    const seen: { fee?: unknown; value?: bigint } = {}
    const { ctx, sent } = context({
      beforeSend: async (cost: SendCost) => {
        seen.fee = cost.fee
        seen.value = cost.value
      },
    })
    await sendValue(ctx, { to: `0x${"bb".repeat(20)}` as Address, value: 7n }, "funding")
    expect(seen).toEqual({ fee: EIP1559, value: 7n })
    expect(sent[0]).toMatchObject({ value: 7n, maxFeePerGas: EIP1559.maxFeePerGas })
  })

  it("a refusing beforeSend means the transaction never leaves", async () => {
    const { ctx, sent } = context({
      beforeSend: async () => {
        const error = new Error("cannot pay") as Error & { code: string }
        error.code = "OWNER_WALLET_LOW"
        throw error
      },
    })
    await expect(sendContract(ctx, call, "funding")).rejects.toMatchObject({ code: "OWNER_WALLET_LOW" })
    expect(sent).toHaveLength(0)
  })
})
