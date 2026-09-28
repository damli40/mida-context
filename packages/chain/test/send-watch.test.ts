// in-15 J-4 — Sep 27 live: `mida approve devin` sat at "sending the grant (about 5 seconds)…"
// for over a minute with nothing broadcast (the owner's nonce never moved); Ctrl-C and a retry
// worked. Every send now runs under a bounded wait: a "still waiting for Monad (N s)…" line
// every ~15 s, and a give-up after the cap that says only what the send can vouch for —
// a hash means "sent, not confirmed", an in-flight attempt means "maybe out", and a hang
// before the write call means "nothing was sent". Timers are injected; the clock here is fake.
import { describe, expect, it } from "vitest"
import { MidaError, isMidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { SponsorDidNotPay, failedBeforeSend, sendContract, sendValue } from "@mida/chain"
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
  beforeSend?: WriteContext["beforeSend"]
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
    beforeSend: overrides.beforeSend,
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
      `sent as ${HASH}, not confirmed yet. Wait a minute, then run \`mida doctor\`. Don't run the command again until it shows the result, or it may be sent twice.`,
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
      "the send may still have gone out without a hash to show for it — run `mida doctor` to check, and don't run the command again until it shows the result, or it may be sent twice",
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

// in-16 K-1 — the in-15 watchdog refused at the cap but never STOPPED the send: a slow pre-send
// step (simulate, estimate, the top-up inside `beforeSend`, or a sponsor answering late with
// SponsorDidNotPay) finished after the refusal and the write call still ran — exactly the
// double-send the "nothing was sent" line denied. The cap now abandons the send: every broadcast
// point checks the gate first, and the abandoned error is still marked sent:false so the batcher
// may resubmit the batch without the orphaned send ever broadcasting.
describe("a timed-out send is abandoned, not orphaned (in-16 K-1)", () => {
  /** A promise the test resolves by hand after the cap has fired — the late answer. */
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it("a simulate answering after the cap never reaches writeContract", async () => {
    const clock = fakeClock()
    const late = deferred<{ request: unknown }>()
    let writes = 0
    const { context } = stubContext({
      simulateContract: () => late.promise as Promise<unknown>,
      writeContract: async () => {
        writes += 1
        return HASH
      },
    })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    clock.fire() // the cap fires while the simulate is still out
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect(failedBeforeSend(error)).toBe(true)
    // The simulate answers late — the orphaned work must stop at the gate, not broadcast.
    late.resolve({ request: { address: ADDRESS } })
    await flush()
    await flush()
    expect(writes).toBe(0)
  })

  it("a top-up inside beforeSend answering after the cap never reaches writeContract", async () => {
    const clock = fakeClock()
    const late = deferred<void>()
    let writes = 0
    const { context } = stubContext({
      beforeSend: () => late.promise,
      writeContract: async () => {
        writes += 1
        return HASH
      },
    })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    await flush() // let the body reach the balance guard
    clock.fire() // the cap fires while the top-up's own receipt wait is still out
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect(failedBeforeSend(error)).toBe(true)
    late.resolve()
    await flush()
    await flush()
    expect(writes).toBe(0)
  })

  it("a sponsor refusing after the cap cannot fall back into a self-paid send", async () => {
    const clock = fakeClock()
    const late = deferred<never>()
    let writes = 0
    const sponsor = {
      send: () => late.promise,
    } as unknown as NonNullable<WriteContext["sponsor"]>
    const { context } = stubContext({
      sponsor,
      writeContract: async () => {
        writes += 1
        return HASH
      },
    })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    await flush() // the sponsor call is in flight — attempted, no hash
    clock.fire() // the cap fires
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect(failedBeforeSend(error)).toBe(false)
    // The sponsor answers "did not pay" after the refusal — the self-paid fallback must not send.
    late.reject(new SponsorDidNotPay("sponsor offline"))
    await flush()
    await flush()
    expect(writes).toBe(0)
  })

  it("a sendValue estimate answering after the cap never reaches sendTransaction", async () => {
    const clock = fakeClock()
    const late = deferred<void>()
    let sends = 0
    const { context } = stubContext({
      beforeSend: () => late.promise,
      sendTransaction: async () => {
        sends += 1
        return HASH
      },
    })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendValue(context, { to: ADDRESS, value: 10n }, "funding").then(() => null, (error: unknown) => error)
    await flush()
    clock.fire() // the cap fires inside the balance guard
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect(failedBeforeSend(error)).toBe(true)
    late.resolve()
    await flush()
    await flush()
    expect(sends).toBe(0)
  })

  it("a simulate answering after the cap never starts the top-up — no funding send, no main send (in-18 S4)", async () => {
    // The balance guard's top-up is itself a send — without a gate check ahead of `beforeSend`,
    // a simulate resolving after the refusal would still run the guard, and its nested sendValue
    // would broadcast the top-up for a send that was already abandoned.
    const clock = fakeClock()
    const innerClock = fakeClock()
    const late = deferred<{ request: unknown }>()
    let funds = 0
    let writes = 0
    const inner = stubContext({
      sendTransaction: async () => {
        funds += 1
        return HASH
      },
    })
    inner.context.sendWatch = watch(innerClock, 15_000, 60_000)
    const { context } = stubContext({
      simulateContract: () => late.promise as Promise<unknown>,
      // the real wiring: the guard hands the gate it is given down to the nested sendValue
      beforeSend: async (_cost, gate) => {
        await sendValue(inner.context, { to: ADDRESS, value: 1n }, "funding", gate)
      },
      writeContract: async () => {
        writes += 1
        return HASH
      },
    })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    clock.fire() // the cap fires while the outer simulate is still out
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect(failedBeforeSend(error)).toBe(true)
    // The simulate answers late — the orphaned continuation must stop at the gate BEFORE the
    // guard can fund anything: no top-up transaction, and no main send.
    late.resolve({ request: { address: ADDRESS } })
    await flush()
    await flush()
    expect(funds).toBe(0)
    expect(writes).toBe(0)
  })

  it("a nested top-up still in flight when the cap fires cannot broadcast afterwards (in-18 S4)", async () => {
    // The other half: the cap fires WHILE the nested sendValue is already running — its own
    // watch has a longer cap and never fires, so only the inherited outer gate stops it.
    const outerClock = fakeClock()
    const innerClock = fakeClock()
    const lateEstimate = deferred<bigint>()
    let funds = 0
    let writes = 0
    const inner = stubContext({
      sendTransaction: async () => {
        funds += 1
        return HASH
      },
    })
    inner.context.publicClient.estimateGas = () => lateEstimate.promise as Promise<bigint>
    inner.context.sendWatch = watch(innerClock, 15_000, 60_000)
    const outer = stubContext({
      beforeSend: async (_cost, gate) => {
        await sendValue(inner.context, { to: ADDRESS, value: 1n }, "funding", gate)
      },
      writeContract: async () => {
        writes += 1
        return HASH
      },
    })
    outer.context.sendWatch = watch(outerClock, 15_000, 15_000)
    const outcome = sendContract(
      outer.context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    await flush() // outer reaches the guard; the inner send is hung in its estimate
    await flush()
    outerClock.fire() // the outer cap fires — the send is abandoned mid-top-up
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    expect(failedBeforeSend(error)).toBe(true)
    // The inner estimate answers late: the inherited gate must refuse the broadcast.
    lateEstimate.resolve(21_000n)
    await flush()
    await flush()
    expect(funds).toBe(0)
    expect(writes).toBe(0)
  })

  it("a nested send does not print a second 'still waiting' stream (in-16 K-8)", async () => {
    // The reported case: an operator send whose balance guard waits on an owner top-up — two
    // watchdogs ran and the user saw the same line twice per interval. Only the oldest
    // progress-bearing watch prints; the nested send keeps its own cap and gate.
    const outerClock = fakeClock()
    const innerClock = fakeClock()
    const inner = stubContext({ waitForTransactionReceipt: () => never() })
    inner.context.sendWatch = watch(innerClock, 15_000, 60_000)
    const outer = stubContext({
      beforeSend: () => sendValue(inner.context, { to: ADDRESS, value: 1n }, "funding").then(() => undefined),
    })
    outer.context.sendWatch = watch(outerClock, 15_000, 60_000)
    const outcome = sendContract(
      outer.context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    await flush()
    await flush()
    outerClock.fire() // 15 s — both watches are in flight now
    innerClock.fire()
    expect(outer.progress).toEqual(["still waiting for Monad (15 s)…"])
    expect(inner.progress).toEqual([])
    // the outer cap abandons it; the inner watch, now the oldest printer, ticks again
    outerClock.fire() // 30 s
    outerClock.fire() // 45 s
    outerClock.fire() // 60 s — the cap
    const error = await outcome
    expect(isMidaError(error, "SEND_TIMEOUT")).toBe(true)
    innerClock.fire() // 30 s for the inner send — its clock kept running while it was muted
    expect(inner.progress).toEqual(["still waiting for Monad (30 s)…"])
  })

  it("an abandoned send is requeue-safe for the batcher — marked unsent and never broadcast", async () => {
    // The batcher reads `sent === false` and resubmits the rows: safe only because the gate makes
    // the abandoned send provably unable to broadcast. This is the exact race a resubmit would
    // otherwise have turned into a second anchor on the chain.
    const clock = fakeClock()
    const late = deferred<{ request: unknown }>()
    let writes = 0
    const { context } = stubContext({
      simulateContract: () => late.promise as Promise<unknown>,
      writeContract: async () => {
        writes += 1
        return HASH
      },
    })
    context.sendWatch = watch(clock, 15_000, 15_000)
    const outcome = sendContract(
      context,
      { address: ADDRESS, abi: [], functionName: "register", args: [] },
      "context.register",
    ).then(() => null, (error: unknown) => error)
    clock.fire()
    const error = await outcome
    // the batcher will requeue on this mark — the late continuation below must not broadcast
    expect(failedBeforeSend(error)).toBe(true)
    late.resolve({ request: { address: ADDRESS } })
    await flush()
    await flush()
    expect(writes).toBe(0)
  })
})
