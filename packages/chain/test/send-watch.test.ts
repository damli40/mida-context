// in-15 J-4 — Sep 27 live: `mida approve devin` sat at "sending the grant (about 5 seconds)…"
// for over a minute with nothing broadcast (the owner's nonce never moved); Ctrl-C and a retry
// worked. Every send now runs under a bounded wait: a "still waiting for Monad (N s)…" line
// every ~15 s, and a give-up after the cap that says only what the send can vouch for —
// a hash means "sent, not confirmed", an in-flight attempt means "maybe out", and a hang
// before the write call means "nothing was sent". Timers are injected; the clock here is fake.
import { describe, expect, it } from "vitest"
import { MidaError, isMidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { failedBeforeSend, sendContract, sendValue } from "@mida/chain"
import type { WriteContext } from "@mida/chain"

const ADDRESS: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
const HASH: Hex = `0x${"ab".repeat(32)}`
const never = (): Promise<never> => new Promise<never>(() => {})

/** Let the send's async body settle into whatever step it hangs on before the clock runs. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** The injected clock: timers queue, they never fire on their own — `fire()` runs the next one. */
function fakeClock() {
  const timers: { fn: () => void; ms: number }[] = []
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { fn, ms }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer: unknown) => {
      const index = timers.indexOf(timer as { fn: () => void; ms: number })
      if (index >= 0) timers.splice(index, 1)
    },
    fire(): void {
      const timer = timers.shift()
      if (timer === undefined) throw new Error("the send left no timer queued — the watch is not running")
      timer.fn()
    },
  }
}

/**
 * A WriteContext whose chain calls are stubs; any step can be replaced with `never()` to hang
 * the send where the live run hung.
 */
function stubContext(overrides: {
  simulateContract?: () => Promise<unknown>
  writeContract?: () => Promise<Hex>
  sendTransaction?: () => Promise<Hex>
  waitForTransactionReceipt?: () => Promise<unknown>
  sponsor?: WriteContext["sponsor"]
} = {}) {
  const progress: string[] = []
  const context = {
    account: { address: ADDRESS },
    publicClient: {
      simulateContract: overrides.simulateContract ?? (async () => ({ request: { address: ADDRESS } })),
      estimateContractGas: async () => 300_000n,
      estimateGas: async () => 21_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 12n, maxPriorityFeePerGas: 1n }),
      waitForTransactionReceipt: overrides.waitForTransactionReceipt ?? (async () => ({ status: "success", transactionHash: HASH, gasUsed: 1n })),
    },
    walletClient: {
      chain: { id: 31337 },
      writeContract: overrides.writeContract ?? (async () => HASH),
      sendTransaction: overrides.sendTransaction ?? (async () => HASH),
    },
    sponsor: overrides.sponsor,
    progress: (line: string) => progress.push(line),
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
  return { context, progress }
}

function watch(clock: ReturnType<typeof fakeClock>, everyMs = 15_000, capMs = 45_000): NonNullable<WriteContext["sendWatch"]> {
  return { everyMs, capMs, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
}

describe("the bounded send (in-15 J-4)", () => {
  it("a hang before broadcast ticks every interval and gives up with 'nothing was sent'", async () => {
    // The live case: the RPC call before any broadcast went quiet — here it is the simulate.
    const clock = fakeClock()
    const { context, progress } = stubContext({ simulateContract: () => never() })
    context.sendWatch = watch(clock)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    clock.fire() // 15 s
    clock.fire() // 30 s
    clock.fire() // 45 s — the cap
    const error = await outcome
    expect(progress).toEqual(["still waiting for Monad (15 s)…", "still waiting for Monad (30 s)…"])
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect((error as Error).message).toContain("nothing was sent: run the same command again")
    // provably pre-write: a caller may resubmit without any double-send risk
    expect(failedBeforeSend(error)).toBe(true)
  })

  it("a broadcast whose receipt never comes reports its hash and the safe retry", async () => {
    const clock = fakeClock()
    const { context, progress } = stubContext({ waitForTransactionReceipt: () => never() })
    context.sendWatch = watch(clock, 15_000, 30_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    // let the async body reach the receipt wait before the clock runs — the hash exists by then
    await flush()
    clock.fire() // 15 s
    clock.fire() // 30 s — the cap
    const error = await outcome
    expect(progress).toEqual(["still waiting for Monad (15 s)…"])
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect((error as Error).message).toContain(
      `sent as ${HASH}, not confirmed yet: run \`mida doctor\`, or run the same command again (it checks the chain first, so nothing is sent twice)`,
    )
    // the transaction may have landed — never mark it safe-to-resubmit
    expect(failedBeforeSend(error)).toBe(false)
  })

  it("a write call that never answered cannot claim 'nothing was sent'", async () => {
    // Between calling writeContract and its answer the transaction may already be out — the
    // honest line checks the chain first rather than inviting a blind double-send.
    const clock = fakeClock()
    const { context } = stubContext({ writeContract: () => never() })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    await flush()
    clock.fire() // 15 s — the cap
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect((error as Error).message).toContain(
      "the send may still have gone out without a hash to show for it — run `mida doctor` to check before running the command again",
    )
    expect(failedBeforeSend(error)).toBe(false)
  })

  it("the sponsored path is under the same bound — a sponsor that goes quiet cannot hang the send", async () => {
    const clock = fakeClock()
    const sponsor = { send: () => never() } as unknown as NonNullable<WriteContext["sponsor"]>
    const { context } = stubContext({ sponsor })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    await flush()
    clock.fire()
    const error = await outcome
    // an accepted-or-not sponsor operation may still land — the maybe-out line, not "nothing was sent"
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect((error as Error).message).toContain("may still have gone out")
    expect(failedBeforeSend(error)).toBe(false)
  })

  it("sendValue is under the same bound — a receipt that never comes reports its hash", async () => {
    const clock = fakeClock()
    const { context } = stubContext({ waitForTransactionReceipt: () => never() })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendValue(context, { to: ADDRESS, value: 10n }, "funding").then(() => null, (error: unknown) => error)
    await flush()
    clock.fire()
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect((error as Error).message).toContain(`sent as ${HASH}, not confirmed yet`)
  })

  it("a send that completes inside the window ticks nothing and clears its timers", async () => {
    const clock = fakeClock()
    const { context, progress } = stubContext()
    context.sendWatch = watch(clock)
    const receipt = await sendContract(context, { address: ADDRESS, abi: [], functionName: "register", args: [] }, "context.register")
    expect(receipt.gasLimit).toBe(300_000n)
    expect(progress).toEqual([])
    expect(clock.timers).toHaveLength(0)
  })

  it("a send that fails before broadcast surfaces its real error, not the timeout", async () => {
    const clock = fakeClock()
    const { context } = stubContext({
      simulateContract: async () => {
        throw new MidaError("CAPABILITY_DENIED", "contract reverted BatchExists")
      },
    })
    context.sendWatch = watch(clock)
    const error = await sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (e: unknown) => e)
    expect(isMidaError(error, "CAPABILITY_DENIED")).toBe(true)
    expect(clock.timers).toHaveLength(0)
  })
})
