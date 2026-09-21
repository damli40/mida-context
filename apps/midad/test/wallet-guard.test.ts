import { describe, expect, it } from "vitest"
import { sendContract } from "@mida/chain"
import type { Address } from "@mida/protocol"
import { formatMon, makeOwnerBalanceGuard } from "@mida/midad"

/**
 * R4-4 — before an owner transaction goes out, the wallet is checked against estimate × gas
 * price. A network with a funder tops the wallet up first; without one the send is refused with
 * OWNER_WALLET_LOW and the balance, the cost and the shortfall all named in MON.
 */

const PAYER = `0x${"ab".repeat(20)}` as Address

function chainWith(balance: bigint, gasPrice: bigint) {
  return {
    account: { address: PAYER },
    publicClient: {
      getBalance: async () => balance,
      getGasPrice: async () => gasPrice,
    },
  } as never
}

describe("makeOwnerBalanceGuard (R4-4)", () => {
  it("a wallet that can pay needs no funder and no progress line", async () => {
    let funded = 0
    let progress = 0
    const guard = makeOwnerBalanceGuard({
      chain: chainWith(1_000n, 1n),
      fund: async () => {
        funded += 1
      },
      progress: () => {
        progress += 1
      },
    })
    await guard({ payer: PAYER, gasLimit: 900n }) // cost 900 <= balance 1000
    expect(funded).toBe(0)
    expect(progress).toBe(0)
  })

  it("a low wallet on a funded network is topped up with a progress line, then the send continues", async () => {
    const order: string[] = []
    const guard = makeOwnerBalanceGuard({
      chain: chainWith(10n, 1n),
      fund: async (address) => {
        order.push(`fund ${address}`)
      },
      progress: (line) => order.push(line),
    })
    await guard({ payer: PAYER, gasLimit: 500n })
    expect(order).toEqual(["topping up your wallet…", `fund ${PAYER}`])
  })

  it("a low wallet with no funder refuses with OWNER_WALLET_LOW naming balance, cost and shortfall", async () => {
    const MON = 1_000_000_000_000_000_000n
    const guard = makeOwnerBalanceGuard({
      chain: chainWith(MON / 20n, 100_000_000_000n), // 0.05 MON, 100 gwei
    })
    const error = await guard({ payer: PAYER, gasLimit: 832_470n }).then(
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

describe("sendContract runs beforeSend between the estimate and the send (R4-4)", () => {
  const call = { address: `0x${"cc".repeat(20)}` as Address, abi: [] as never, functionName: "f", args: [] as const }

  function context(over: Record<string, unknown> = {}) {
    const sent: unknown[] = []
    const ctx = {
      deployment: { chainId: 1n, capabilityRegistry: `0x${"11".repeat(20)}`, contextRegistry: `0x${"22".repeat(20)}`, deploymentBlock: 0n },
      account: { address: PAYER },
      publicClient: {
        simulateContract: async () => ({ request: {} }),
        estimateContractGas: async () => 21_000n,
        waitForTransactionReceipt: async () => ({ status: "success", transactionHash: `0x${"dd".repeat(32)}` }),
      },
      walletClient: {
        writeContract: async (req: unknown) => {
          sent.push(req)
          return `0x${"dd".repeat(32)}`
        },
      },
      ...over,
    } as never
    return { ctx, sent }
  }

  it("receives the payer and the estimated gas limit before the write", async () => {
    const seen: { payer?: Address; gasLimit?: bigint } = {}
    const { ctx, sent } = context({
      beforeSend: async (cost: { payer: Address; gasLimit: bigint }) => {
        seen.payer = cost.payer
        seen.gasLimit = cost.gasLimit
      },
    })
    await sendContract(ctx, call, "funding")
    expect(seen).toEqual({ payer: PAYER, gasLimit: 21_000n })
    expect(sent).toHaveLength(1)
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
