import { describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import type { Abi, Address } from "viem"
import { SponsorDidNotPay, SponsorPending } from "@mida/chain/browser"
import type { Deployment, SponsoredReceipt } from "@mida/chain/browser"
import { sendSponsoredOnly } from "../src/owner/send.js"
import type { SponsoredWriteContext } from "../src/owner/send.js"
import { describeError } from "../src/owner/session.js"

/**
 * The sponsored-only send contract. A passkey owner holds no MON, so the page must never run an
 * owner-side gas estimate — Monad refuses one for a sender who cannot afford the worst case —
 * and must never fall back to self-pay. Simulation is an eth_call and needs no balance; the
 * per-kind ceiling is the bundler's own callGasLimit, checked inside the sponsored sender.
 */

const OWNER_KEY = `0x${"11".repeat(32)}` as const
const TX_HASH = `0x${"aa".repeat(32)}` as const
const OP_HASH = `0x${"bb".repeat(32)}` as const
const REGISTRY = "0x00000000000000000000000000000000000000c1" as Address

const CALL = {
  address: REGISTRY,
  abi: [] as unknown as Abi,
  functionName: "registerP256Key",
  args: ["0x01", 1n, 2n] as readonly unknown[],
}

function context(overrides: { sponsor?: SponsoredWriteContext["sponsor"] } = {}) {
  const estimated: string[] = []
  const publicClient = {
    async simulateContract() {
      return { result: undefined }
    },
    async estimateContractGas() {
      estimated.push("estimateContractGas")
      return 100_000n
    },
  }
  const ctx: SponsoredWriteContext = {
    publicClient: publicClient as never,
    account: privateKeyToAccount(OWNER_KEY),
    deployment: { chainId: 10_143n, capabilityRegistry: REGISTRY } as unknown as Deployment,
    sponsor: overrides.sponsor ?? {
      async send(): Promise<SponsoredReceipt> {
        return { transactionHash: TX_HASH, gasLimit: 1n, userOpHash: OP_HASH } as SponsoredReceipt
      },
    },
  }
  return { ctx, estimated }
}

describe("sendSponsoredOnly", () => {
  it("simulates, then hands the call to the sponsor — estimateContractGas is never called", async () => {
    const { ctx, estimated } = context()
    const receipt = await sendSponsoredOnly(ctx, CALL, "owner.key")
    expect(receipt.userOpHash).toBe(OP_HASH)
    expect(estimated).toEqual([])
  })

  it("a sponsor refusal propagates untouched — no self-pay retry, no second sponsor call", async () => {
    let sends = 0
    const { ctx } = context({
      sponsor: {
        async send(): Promise<SponsoredReceipt> {
          sends += 1
          throw new SponsorDidNotPay("quota exhausted")
        },
      },
    })
    await expect(sendSponsoredOnly(ctx, CALL, "owner.key")).rejects.toBeInstanceOf(SponsorDidNotPay)
    expect(sends).toBe(1)
  })
})

describe("describeError — the sponsor lines the owner reads", () => {
  it("a refusal reads: the gas sponsor refused: <one-line reason>", () => {
    expect(describeError(new SponsorDidNotPay("quota exhausted"))).toBe(
      "the gas sponsor refused: quota exhausted",
    )
  })

  it("a pending operation reads: accepted, still landing — check again in a minute", () => {
    expect(describeError(new SponsorPending(OP_HASH))).toBe(
      "accepted, still landing — check again in a minute",
    )
  })
})
