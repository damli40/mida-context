import {
  MidaError,
  agentId as deriveAgentId,
  agentRegistrationTypedData,
  canonicalizeOrigin,
  isMidaError,
  originHash,
} from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { createPublicClient, createWalletClient } from "viem"
import type { Abi, Account, LocalAccount, PublicClient, TransactionReceipt, WalletClient } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import { chainFor } from "./deployment.js"
import type { Deployment } from "./deployment.js"
import { GAS_CEILINGS, contractGas, valueGas } from "./gas.js"
import type { TxKind } from "./gas.js"
import { toMidaError } from "./registry.js"
import type { ChainContext } from "./registry.js"
import { SponsorDidNotPay } from "./sponsored.js"
import type { SponsoredSender } from "./sponsored.js"
import { rpcTransport } from "./transport.js"

/**
 * The fee fields a send carries — the answer of `estimateFeesPerGas`, forwarded verbatim into
 * the transaction so the number the balance guard checked is the number the node checks (R5-9).
 * An EIP-1559 chain sets `maxFeePerGas`/`maxPriorityFeePerGas`; a legacy chain sets `gasPrice`.
 */
export interface SendFee {
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasPrice?: bigint
}

/** What a send is about to cost the payer, handed to `beforeSend` after the estimates. */
export interface SendCost {
  payer: Address
  gasLimit: bigint
  /**
   * The exact fee values the transaction goes out with. The node verifies the payer against
   * `gasLimit × maxFeePerGas` — checking a fresh (cheaper) gas price instead let a wallet
   * through that the send itself then refused (R5-9).
   */
  fee: SendFee
  /** A plain transfer's moved value — part of the payer's total exposure, absent on contract calls. */
  value?: bigint
  /**
   * Set when `gasLimit` is a bound, not a measured estimate: the node's own `eth_estimateGas`
   * refused to run, so the send was priced at the kind's ceiling. A balance guard phrases the
   * refusal "needs up to X MON" rather than claiming a precision the bound does not have (M3-D6).
   */
  upperBound?: boolean
}

export interface WriteContext extends ChainContext {
  walletClient: WalletClient
  account: Account
  /**
   * Runs between the gas estimate and the send: the payer's balance can be checked against the
   * estimated cost and topped up, or the send refused before a transaction the wallet cannot
   * pay for goes out (R4-4). Only the owner's context wires this; agent signers keep the bare
   * node error, exactly as before. On the sponsored path it never runs — the user pays nothing.
   * The `gate` it is handed is THIS send's abandonment gate: a guard that sends a transaction
   * of its own (an owner top-up) must pass it down, so the nested send stops too when the
   * outer send's cap already fired (in-18 S4).
   */
  beforeSend?: (cost: SendCost, gate: SendGate) => Promise<void>
  /**
   * When set, `sendContract` asks this sender to pay the gas first (the user still signs; the
   * sponsor pays). A SponsorDidNotPay falls back to the self-paid path — or refuses, when
   * SPONSOR_FALLBACK_TO_SELF_PAY is off. Any other error (an included-but-reverted operation
   * among them) propagates untouched: the sponsor did pay and the call itself failed.
   */
  sponsor?: SponsoredSender
  /**
   * One plain line while a slow step runs — where the sponsor fallback explains itself. Wired by
   * the runtime to its own progress channel; unset means silent code paths stay silent.
   */
  progress?: (line: string) => void
  /**
   * The bounded wait every send runs under (in-15 J-4): while the chain stays silent a
   * "still waiting for Monad (N s)…" line ticks on `progress` every `everyMs`, and once `capMs`
   * passes the send throws SEND_TIMEOUT — the error says whether a transaction hash exists, so
   * "sent but unconfirmed" and "nothing left the process" are never the same line. Timer
   * callbacks are injectable so a test runs the clock; defaults below.
   */
  sendWatch?: {
    everyMs?: number
    capMs?: number
    setTimeout?: (fn: () => void, ms: number) => unknown
    clearTimeout?: (timer: unknown) => void
  }
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
    publicClient: createPublicClient({ chain, batch: { multicall: true }, transport: rpcTransport(input.rpcUrl) }),
    walletClient: createWalletClient({ chain, account: input.account, transport: rpcTransport(input.rpcUrl) }),
  }
}

/** A mined receipt plus the gas limit the transaction was actually sent with — the number Monad bills. */
export type SentReceipt = TransactionReceipt & { gasLimit: bigint }

/**
 * `sent === false` on a thrown error marks a failure from BEFORE any transaction left the
 * process — simulation, gas estimation, the fee estimate, the balance guard. A caller that
 * requeues work on failure (the batcher) reads it here to tell "nothing was sent", a plain
 * size or availability signal that is safe to resubmit, from "the send's answer was lost",
 * where the transaction may already have landed. A failure thrown after `writeContract` —
 * including the sponsor's own send, whose operation may still be in flight — is never marked.
 */
export function failedBeforeSend(error: unknown): boolean {
  return error instanceof Error && (error as { sent?: boolean }).sent === false
}

const markUnsent = <T>(error: T): T => {
  if (error instanceof Error) (error as { sent?: boolean }).sent = false
  return error
}

/**
 * The sponsor's daily-limit reason a failed self-paid fallback carries — set by `sendContract`
 * when the sponsor refused on a daily limit and the wallet could not pay either. Undefined on
 * every other error.
 */
export function sponsorDailyLimitOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const value = (error as { sponsorDailyLimit?: unknown }).sponsorDailyLimit
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** A "still waiting for Monad" line ticks this often while a send is in flight (in-15 J-4). */
export const SEND_PROGRESS_EVERY_MS = 15_000
/** The most a send waits on Monad before reporting what it honestly knows (in-15 J-4). */
export const SEND_CAP_MS = 120_000

/**
 * The gate a send checks in the same synchronous stretch as every broadcast point — once the
 * watchdog's cap has fired, a slow pre-send step (a simulate, an estimate, a top-up's own
 * receipt wait) resolving late must not turn the refusal the caller already saw into a real
 * send (in-16 K-1). The check and the send call sit back to back so no timer can run between
 * them; after it throws, the abandoned work promise unwinds without broadcasting.
 */
export interface SendGate {
  checkAbandoned(): void
}

/**
 * Ids of the in-flight watches that carry a progress channel — insertion order, so the oldest
 * owns the "still waiting" line. A send nested inside another send's `beforeSend` (an operator
 * send triggering an owner top-up) runs its own cap and gate but does not print a second,
 * identical tick stream (in-16 K-8); when the oldest watch finishes, the next-oldest resumes
 * printing on its own next tick. A watch with no progress channel never joins — otherwise its
 * slot would silence a nested send whose ticks are the only ones the user could see.
 */
const printingSends = new Set<symbol>()

/**
 * The race every owner send runs: work against a tick chain that prints `still waiting for
 * Monad (N s)…` each `everyMs` and gives up at `capMs`. The give-up error names only what the
 * caller can vouch for — three states, in order of knowledge:
 *
 * - a hash exists: the transaction left, its receipt is what is missing;
 * - no hash but a send was attempted (the write call or the sponsor is still in flight): the
 *   transaction may be out there without a hash to show, so the line cannot claim "nothing
 *   was sent" — that would send the owner into a possible double-send;
 * - no attempt yet (the hang was in the simulate/estimate/guard steps): nothing was sent.
 *
 * The cap also SETS `gaveUp`, and every broadcast point in the send body gates on it — a timed-out
 * send can never go out after its refusal was already reported.
 */
async function watchSend<T>(
  context: WriteContext,
  state: { hashOf(): Hex | undefined; attempted(): boolean },
  work: (gate: SendGate) => Promise<T>,
  /**
   * A send nested inside another send's `beforeSend` (an owner top-up inside an operator's
   * balance guard) carries the OUTER send's gate here — the parent's cap firing abandons this
   * send's broadcast points too, so a timed-out send can never pay for work after its refusal
   * was already reported (in-18 S4).
   */
  outerGate?: SendGate,
): Promise<T> {
  const watch = context.sendWatch
  const setTimer = watch?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = watch?.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as never))
  const everyMs = watch?.everyMs ?? SEND_PROGRESS_EVERY_MS
  const capMs = watch?.capMs ?? SEND_CAP_MS
  const timeout = (): MidaError => {
    const hash = state.hashOf()
    if (hash !== undefined) {
      // A rerun only sees MINED state — a still-pending first transaction is invisible to it, so
      // the retry advice must say "don't" until `mida doctor` shows the result (in-16 K-4).
      return new MidaError(
        "SEND_TIMEOUT",
        `sent as ${hash}, not confirmed yet. Wait a minute, then run \`mida doctor\`. Don't run the command again until it shows the result, or it may be sent twice.`,
      )
    }
    return state.attempted()
      ? new MidaError(
          "SEND_TIMEOUT",
          "the send may still have gone out without a hash to show for it — run `mida doctor` to check, and don't run the command again until it shows the result, or it may be sent twice",
        )
      : // pre-attempt is provably unsent — the gate below keeps it that way, so the batcher may
        // resubmit it like any pre-send failure without risking a double-send
        markUnsent(new MidaError("SEND_TIMEOUT", "nothing was sent: run the same command again"))
  }
  let gaveUp = false
  const gate: SendGate = {
    checkAbandoned() {
      if (gaveUp) throw timeout()
      // the inherited check: an outer send already abandoned means this nested send is paying
      // for work nobody is waiting on — its timeout error is the outer send's own
      outerGate?.checkAbandoned()
    },
  }
  const id = context.progress === undefined ? undefined : Symbol()
  if (id !== undefined) printingSends.add(id)
  let timer: unknown
  try {
    return await Promise.race([
      work(gate),
      new Promise<never>((_resolve, reject) => {
        // `waited` is advanced when each timer is SCHEDULED, so it always names the moment the
        // timer that is firing was aimed at — the cap is a tick that refuses instead of prints.
        let waited = 0
        const tick = (): void => {
          if (waited >= capMs) {
            // Past the cap the send is abandoned, not just unanswered: the flag makes every
            // broadcast point in the work body throw instead of sending (in-16 K-1).
            gaveUp = true
            reject(timeout())
            return
          }
          // Only the oldest progress-bearing watch prints — a nested send's watchdog would
          // otherwise interleave a second, identical line per interval.
          if (id !== undefined && printingSends.values().next().value === id) {
            context.progress?.(`still waiting for Monad (${Math.round(waited / 1_000)} s)…`)
          }
          const nextIn = Math.min(everyMs, capMs - waited)
          waited += nextIn
          timer = setTimer(tick, nextIn)
          if (typeof (timer as { unref?: unknown }).unref === "function") (timer as { unref(): void }).unref()
        }
        const firstIn = Math.min(everyMs, capMs)
        waited = firstIn
        timer = setTimer(tick, firstIn)
        if (typeof (timer as { unref?: unknown }).unref === "function") (timer as { unref(): void }).unref()
      }),
    ])
  } finally {
    if (id !== undefined) printingSends.delete(id)
    if (timer !== undefined) clearTimer(timer)
  }
}

/**
 * The fee a send will offer, estimated once per transaction. viem's EIP-1559 default multiplies
 * the base fee (×1.2) into `maxFeePerGas`, which is exactly the product the node verifies the
 * payer's balance against — so the guard must see THIS number, not the raw gas price (R5-9).
 */
async function estimateSendFee(context: WriteContext): Promise<SendFee> {
  const estimated = await context.publicClient.estimateFeesPerGas()
  const fee: SendFee = {}
  if (estimated.gasPrice !== undefined) fee.gasPrice = estimated.gasPrice
  if (estimated.maxFeePerGas !== undefined) fee.maxFeePerGas = estimated.maxFeePerGas
  if (estimated.maxPriorityFeePerGas !== undefined) fee.maxPriorityFeePerGas = estimated.maxPriorityFeePerGas
  return fee
}

/**
 * Whether a sponsor failure falls back to paying gas from the user's own wallet. The testnet
 * probe's step f (docs/evidence/m3-sponsor-probe.json, Sep 21) measured that a 7702-delegated
 * address holding under 10 MON CAN still pay its own gas, so the fallback is safe — the
 * reviewer flips this constant if a later probe or a Monad change breaks that finding, and the
 * fallback message becomes a refusal with instructions instead.
 */
export const SPONSOR_FALLBACK_TO_SELF_PAY = true

/**
 * Simulates first so a revert surfaces as a named contract error mapped to a protocol code. The
 * simulate is an `eth_call` carrying no gas field — it runs from a wallet holding nothing, which
 * is exactly why it may stay on the sponsored path (M3-D3). With a sponsor set the sponsor is
 * asked next, with NO owner-side `estimateContractGas`: that estimate is `eth_estimateGas` with
 * the owner as sender, which Monad refuses for a wallet that cannot afford the worst case — the
 * very wallet a sponsor exists for. The bundler estimates the operation instead, and the kind's
 * ceiling is checked inside the sponsored sender against the bundler's own `callGasLimit`.
 *
 * Only the self-paid path — no sponsor, or a sponsor that refused before accepting — runs the
 * estimate, the ceiling check and the balance guard: the send is refused above the kind's
 * ceiling (Monad bills the limit, not the usage), and within it goes out with `gas` set
 * explicitly to the estimate — no padding. A receipt with status "reverted" (for example a
 * Monad reserve-balance revert after inclusion) is an error, never a silent success.
 */
export async function sendContract(
  context: WriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  kind: TxKind,
  /** A nested send inherits the outer send's abandonment through this — see watchSend. */
  outerGate?: SendGate,
): Promise<SentReceipt> {
  // What the watchdog's timeout can vouch for: a hash exists only once writeContract answered;
  // `sentAttempted` marks the stretch where a transaction may be in flight without one — the
  // write call itself hung, or the sponsor went quiet after accepting.
  let hash: Hex | undefined
  let sentAttempted = false
  return watchSend(context, { hashOf: () => hash, attempted: () => sentAttempted }, async (gate) => {
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
      // The simulation failing means nothing was broadcast — the error is marked sent:false so a
      // retrying caller knows resubmission cannot double-send.
      throw markUnsent(toMidaError(error))
    }
    let sponsorReason: string | undefined
    let sponsorDailyLimit = false
    if (context.sponsor !== undefined) {
      // If the cap already fired while the simulate was out, this must not become a broadcast —
      // the refusal the caller saw was the last word (in-16 K-1).
      gate.checkAbandoned()
      sentAttempted = true
      try {
        return await context.sponsor.send(call, kind)
      } catch (error) {
        // SPONSOR_PENDING leaves through this line untouched: the operation was accepted and may
        // still land, so a self-paid copy is exactly the double-send this seam must never create.
        // A GAS_CEILING_EXCEEDED from the sponsored path's own bundler-estimate check leaves the
        // same way — a local policy refusal, never a fallback candidate.
        if (!(error instanceof SponsorDidNotPay)) throw error
        if (!SPONSOR_FALLBACK_TO_SELF_PAY) {
          // The probe (m3-sponsor-probe step f, Sep 21) measured that a delegated address under
          // 10 MON CAN pay its own gas — while that stays true the fallback below is safe and this
          // branch is unreachable. If a Monad change ever makes self-pay impossible for delegated
          // addresses, flipping the constant turns the silent failure mode into this refusal.
          throw new MidaError(
            "SPONSOR_FAILED",
            `the gas sponsor did not pay (${error.reason}) and this build cannot fall back to self-pay — fund the wallet or try the sponsor again later`,
          )
        }
        // SponsorDidNotPay means refused BEFORE accepting — nothing of it is in flight, so the
        // timeout message can honestly fall back to "nothing was sent" while we self-pay.
        sentAttempted = false
        sponsorReason = error.reason
        sponsorDailyLimit = error.dailyLimit === true
        context.progress?.(`the gas sponsor did not pay (${error.reason}); paying from your own wallet…`)
        // falls through to the self-paid path — exactly one attempt, never a retry loop
      }
    }
    let gas: bigint
    let fee: SendFee | undefined
    // Everything between the simulation and writeContract is still pre-send — estimate, fee, and the
    // balance guard all run before a transaction can exist. Whatever they throw is marked sent:false;
    // the sponsor block above is deliberately outside this marking because its send may be in flight.
    try {
      try {
        // The per-kind ceiling on the self-paid path: the node's estimate is refused over the kind's
        // ceiling, locally, before the send is priced (M3-D). This estimate is deliberately absent
        // from the sponsored path above — the payer there is the sponsor, and the bundler's own
        // callGasLimit is what gets checked.
        gas = await contractGas(context, call, kind)
      } catch (error) {
        // The ceiling refusal stays a ceiling refusal — that is the estimate succeeding with a
        // number, not the estimate itself being refused.
        if (isMidaError(error, "GAS_CEILING_EXCEEDED")) throw error
        ;({ gas, fee } = await estimateAfterRefusal(context, call, kind, sponsorReason, error, gate))
      }
      if (fee === undefined) {
        try {
          // The fee is estimated ONCE here and forwarded into the send below: the balance guard checks
          // gasLimit × this maxFeePerGas, the node checks the same product, and no second estimate can
          // drift between the two reads (R5-9).
          fee = await estimateSendFee(context)
        } catch (error) {
          throw toMidaError(error)
        }
      }
      // The guard can top the payer up — a slow funder must not reach the send past the cap:
      // the gate is checked BEFORE it runs and is handed in, so a nested send it starts
      // inherits this send's abandonment (in-18 S4).
      gate.checkAbandoned()
      await context.beforeSend?.({ payer: context.account.address, gasLimit: gas, fee }, gate)
    } catch (error) {
      // The sponsor refused on its daily limit AND the wallet fallback failed before sending:
      // carry the sponsor's reason on the error so a caller (the daemon's drain) can tell
      // "wait for the UTC reset" from a real chain failure. A GAS_CEILING_EXCEEDED is a local
      // policy refusal, not the limit — it stays clean. Class, code and message never change.
      if (sponsorDailyLimit && error !== null && typeof error === "object" && !isMidaError(error, "GAS_CEILING_EXCEEDED")) {
        ;(error as { sponsorDailyLimit?: string }).sponsorDailyLimit = sponsorReason
      }
      throw markUnsent(error)
    }
    // The gate and the write call are one synchronous stretch — after the cap there is no send.
    gate.checkAbandoned()
    sentAttempted = true
    hash = await context.walletClient.writeContract({ ...(request as object), gas, ...fee } as never)
    const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") {
      throw new MidaError("CAPABILITY_DENIED", `${call.functionName} transaction ${hash} reverted on-chain`)
    }
    return { ...receipt, gasLimit: gas }
  }, outerGate)
}

/**
 * Recovery for a gas ESTIMATE that itself was refused (M3-D6 item 1). On Monad,
 * `eth_estimateGas` rejects for a wallet that cannot afford the worst case — before `beforeSend`
 * could run, so the owner saw the node's raw error instead of the wallet sentence. Here the
 * balance guard is asked against an UPPER BOUND — the kind's ceiling × the current max fee —
 * instead. A wallet that cannot pay even the bound refuses with the plain OWNER_WALLET_LOW
 * sentence (the sponsor's one-line reason kept in front of it); a wallet that CAN pay the
 * bound — typically because a funder just topped it up — gets the estimate retried, and the
 * send then runs through the ordinary check with the real numbers.
 */
async function estimateAfterRefusal(
  context: WriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  kind: TxKind,
  sponsorReason: string | undefined,
  error: unknown,
  gate: SendGate,
): Promise<{ gas: bigint; fee: SendFee }> {
  if (context.beforeSend === undefined) throw toMidaError(error)
  let fee: SendFee
  try {
    fee = await estimateSendFee(context)
  } catch (feeError) {
    throw toMidaError(feeError)
  }
  try {
    gate.checkAbandoned()
    await context.beforeSend({ payer: context.account.address, gasLimit: GAS_CEILINGS[kind], fee, upperBound: true }, gate)
  } catch (low) {
    if (isMidaError(low, "OWNER_WALLET_LOW") && sponsorReason !== undefined) {
      // the sentence stays intact — the sponsor's one-line reason goes in front of it, so the
      // owner learns both who refused to pay and what their own wallet lacks
      const sentence = low.message.startsWith(`${low.code}: `) ? low.message.slice(low.code.length + 2) : low.message
      throw new MidaError("OWNER_WALLET_LOW", `the gas sponsor did not pay (${sponsorReason}); ${sentence}`)
    }
    throw low
  }
  try {
    return { gas: await contractGas(context, call, kind), fee }
  } catch (retried) {
    throw toMidaError(retried)
  }
}

/**
 * A plain value transfer under the same ceiling rule: the node's estimate is the explicit `gas`
 * on the send, refused above the kind's ceiling. Used for environment funding (R3-1).
 */
export async function sendValue(
  context: WriteContext,
  transfer: { to: Address; value: bigint },
  kind: TxKind,
  /** A nested send inherits the outer send's abandonment through this — see watchSend. */
  outerGate?: SendGate,
): Promise<SentReceipt> {
  let hash: Hex | undefined
  let sentAttempted = false
  return watchSend(context, { hashOf: () => hash, attempted: () => sentAttempted }, async (gate) => {
    let gas: bigint
    let fee: SendFee
    // Everything before sendTransaction is still pre-send — estimate, fee, and the balance guard
    // all run before a transaction can exist, so their failures are marked sent:false like
    // sendContract's (the batcher's resubmit rule counts on that marker).
    try {
      ;[gas, fee] = await Promise.all([valueGas(context, transfer, kind), estimateSendFee(context)])
      // The guard itself can send (an owner top-up): check the gate BEFORE it runs and hand it
      // in, so its nested send inherits this send's abandonment (in-18 S4).
      gate.checkAbandoned()
      await context.beforeSend?.({ payer: context.account.address, gasLimit: gas, fee, value: transfer.value }, gate)
    } catch (error) {
      throw markUnsent(toMidaError(error))
    }
    // The gate and the send call are one synchronous stretch — after the cap there is no send.
    gate.checkAbandoned()
    sentAttempted = true
    hash = await context.walletClient.sendTransaction({
      account: context.account,
      chain: context.walletClient.chain,
      to: transfer.to,
      value: transfer.value,
      gas,
      ...fee,
    } as never)
    const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") {
      throw new MidaError("CAPABILITY_DENIED", `funding transaction ${hash} reverted on-chain`)
    }
    return { ...receipt, gasLimit: gas }
  }, outerGate)
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
