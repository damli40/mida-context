import { MidaError } from "@mida/protocol"
import { createPublicClient, encodeFunctionData } from "viem"
import type { Abi, Address, Hex, LocalAccount } from "viem"
import { entryPoint08Address, prepareUserOperation } from "viem/account-abstraction"
import type { UserOperationReceipt } from "viem/account-abstraction"
import { createSmartAccountClient } from "permissionless"
import { to7702SimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { chainFor } from "./deployment.js"
import type { Deployment } from "./deployment.js"
import { GAS_CEILINGS } from "./gas.js"
import type { TxKind } from "./gas.js"
import { REVERT_CODES, revertNameFromData } from "./registry.js"
import { rpcTransport } from "./transport.js"
import type { SentReceipt } from "./writes.js"

/**
 * The account implementation the SDK's first sponsored operation delegates to — Pimlico's
 * Simple7702Account, the default inside `to7702SimpleSmartAccount`. The sponsor endpoint's
 * ALLOWED_IMPLEMENTATIONS must contain this address or every first operation is refused.
 */
export const SPONSORED_IMPLEMENTATION: Address = "0xe6Cae83BdE06E4c305530e199D7217f42808555B"

/** Phase 1 — up to the bundler answering with a hash — gets this long; past it the caller may fall back. */
export const SPONSOR_TIMEOUT_MS = 20_000

/** Phase 2 — waiting for the receipt of an ACCEPTED operation — gets its own, longer deadline. */
export const SPONSOR_RECEIPT_TIMEOUT_MS = 120_000

/**
 * The gas the bundler's `callGasLimit` does NOT count: that field prices the inner execution
 * only, while GAS_CEILINGS were measured as whole-transaction limits — verification,
 * pre-verification and paymaster gas ride on top. Comparing the raw numbers let the sponsored
 * path run tens of thousands of gas more permissive than the self-paid one (M3-D6 item 4), so
 * the kind's ceiling minus this overhead is the bound `callGasLimit` is checked against —
 * the same effective whole-transaction ceiling both paths enforce.
 */
export const CALL_OVERHEAD_GAS = 40_000n

/** Once the receipt wait runs this long the owner hears one progress line — silence is not pending. */
export const SPONSOR_RECEIPT_NOTICE_MS = 15_000

/** EIP-7702 delegated code on an address starts with this designator followed by the implementation. */
const DELEGATION_PREFIX = "0xef0100"

/**
 * The four daily-limit refusals of apps/sponsor-worker/src/worker.ts, matched by their text
 * because the worker sends no machine-readable reason. A test in the worker's suite pins the
 * two together.
 */
export function isSponsorDailyLimitReason(reason: string): boolean {
  return /refused: (?:this sender used its \d+ (?:sponsored signings|free calls) for today|the sponsor's daily budget is (?:exhausted|spent))/.test(
    reason,
  )
}

/**
 * Every way a sponsored send can fail before the operation lands: refusal, unreachable endpoint,
 * timeout, malformed answer. `sendContract` falls back to self-pay only on this type — an operation
 * that was included and reverted is a different outcome (the sponsor DID pay) and is never retried.
 */
export class SponsorDidNotPay extends MidaError {
  /** The short human reason, surfaced on the fallback progress line. */
  readonly reason: string
  /** Whether the refusal was the sponsor's daily limit — a wait-until-midnight failure, not an error. */
  readonly dailyLimit: boolean

  constructor(reason: string) {
    super("SPONSOR_FAILED", reason)
    this.name = "SponsorDidNotPay"
    this.reason = reason
    this.dailyLimit = isSponsorDailyLimitReason(reason)
  }
}

/**
 * The bundler accepted a user operation — a hash exists — but its receipt could not be confirmed
 * inside the receipt deadline. The operation may still land, so this is deliberately NOT
 * SponsorDidNotPay: `sendContract` falls back only on that type, and a self-paid copy of an
 * accepted call is the exact double-send this error exists to prevent.
 */
export class SponsorPending extends MidaError {
  /** The accepted operation's hash — surfaced to the owner so the outcome can be checked. */
  readonly userOpHash: Hex

  constructor(userOpHash: Hex) {
    super(
      "SPONSOR_PENDING",
      `sponsored operation ${userOpHash} was accepted and may still land — check it before retrying; nothing was sent from your wallet`,
    )
    this.name = "SponsorPending"
    this.userOpHash = userOpHash
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
   * Sends one contract call as a sponsored user operation. `kind` carries the per-kind gas
   * ceiling this sender enforces against the bundler's own `callGasLimit` estimate before the
   * operation is sent (M3-D3) — the owner-side `eth_estimateGas` never runs on this path.
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
export function createSponsoredSender(input: {
  sponsorUrl: string
  rpcUrl: string
  account: LocalAccount
  deployment: Deployment
  /** Override the delegated implementation — must be on the endpoint's allow list. */
  implementation?: Address
  /** Phase-1 deadline (paymaster + send, up to acceptance), default SPONSOR_TIMEOUT_MS; tests pass less. */
  timeoutMs?: number
  /** Phase-2 deadline (receipt confirmation after acceptance), default SPONSOR_RECEIPT_TIMEOUT_MS. */
  receiptTimeoutMs?: number
  /** Delay before the "still waiting" progress line, default SPONSOR_RECEIPT_NOTICE_MS. */
  receiptNoticeMs?: number
  /** Receipt polling interval; viem's default when unset. */
  pollingIntervalMs?: number
  /** Progress lines for the human running the command — fires once if the receipt wait runs long. */
  progress?: (line: string) => void
}): SponsoredSender {
  const chain = chainFor(input.deployment.chainId)
  const publicClient = createPublicClient({ chain, batch: { multicall: true }, transport: rpcTransport(input.rpcUrl) })
  const pimlico = createPimlicoClient({
    chain,
    transport: rpcTransport(input.sponsorUrl),
    entryPoint: { address: entryPoint08Address, version: "0.8" },
  })
  // The 7702 account and bundler client are built on first use — constructing a sender must stay
  // synchronous and free of network I/O so contexts can wire it at open time.
  let bundler: Promise<ReturnType<typeof createSmartAccountClient>> | undefined
  const getBundler = () =>
    (bundler ??= (async () =>
      createSmartAccountClient({
        account: await to7702SimpleSmartAccount({ client: publicClient, owner: input.account }),
        chain,
        bundlerTransport: rpcTransport(input.sponsorUrl),
        paymaster: pimlico,
        userOperation: {
          estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
        },
      }))())
  const implementation = input.implementation ?? SPONSORED_IMPLEMENTATION
  const timeoutMs = input.timeoutMs ?? SPONSOR_TIMEOUT_MS

  return {
    async send(call, kind) {
      // Phase 1 — everything up to the bundler answering with a user-operation hash. The
      // deadline is safe here: while no hash exists nothing was provably accepted, so a
      // SponsorDidNotPay lets sendContract send the same call from the owner's wallet.
      // One edge remains: the bundler can accept the operation yet never answer — then the
      // deadline fires with no hash to wait on and no way to check, and the fallback may send
      // a second copy. That residual risk has no fix without an identifier, so it stands.
      const phaseOne = (async (): Promise<Hex> => {
        const bundlerClient = await getBundler()
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
            // CURRENT transaction count. What the probe actually found: its first run failed
            // because NO real authorization was attached — the library only inserts a
            // placeholder — so this send signs one itself. It never tried count+1.
            await input.account.signAuthorization!({
              address: implementation,
              chainId: Number(input.deployment.chainId),
              nonce: await publicClient.getTransactionCount({ address: input.account.address }),
            })
        // Prepare first, send second (M3-D3): prepareUserOperation fills the operation through the
        // bundler — eth_estimateUserOperationGas, which the paymaster pays for — so the gas work
        // never touches the owner's wallet. The returned callGasLimit is what the per-kind ceiling
        // checks: refuse locally when the bundler's estimate exceeds it, before anything is sent.
        const prepared = (await prepareUserOperation(bundlerClient as never, {
          calls: [{ to: call.address, value: 0n, data }],
          authorization,
        } as never)) as { callGasLimit?: bigint }
        if (typeof prepared.callGasLimit !== "bigint") {
          throw new SponsorDidNotPay("the bundler's gas estimate carried no callGasLimit")
        }
        // The ceiling check: callGasLimit covers the inner call only (see CALL_OVERHEAD_GAS), so
        // the bound is the whole-transaction ceiling minus that overhead — the same limit the
        // self-paid path enforces on its whole-transaction estimate.
        const bound = GAS_CEILINGS[kind] - CALL_OVERHEAD_GAS
        if (prepared.callGasLimit > bound) {
          throw new MidaError(
            "GAS_CEILING_EXCEEDED",
            `${kind}: the bundler's callGasLimit ${prepared.callGasLimit} exceeds the effective ceiling ${bound} (ceiling ${GAS_CEILINGS[kind]} minus ${CALL_OVERHEAD_GAS} call overhead)`,
          )
        }
        // The prepared operation's `signature` is the account's stub, not a real signature — it
        // exists so the estimate has something shaped right to measure. Dropping it here (passing
        // undefined) makes sendUserOperation sign the final, fully-filled operation for real;
        // every other field is already filled, so no second estimate or paymaster call happens.
        return (await bundlerClient.sendUserOperation({
          ...prepared,
          authorization,
          signature: undefined,
        } as never)) as Hex
      })()
      let userOpHash: Hex
      try {
        userOpHash = await within(phaseOne, timeoutMs)
      } catch (error) {
        // MidaError passes through untouched: an already-wrapped sponsor failure is not wrapped
        // twice. Everything else — refused, down, timeout, a shape the client could not parse —
        // becomes SponsorDidNotPay, the only error the seam falls back on.
        if (error instanceof MidaError) throw error
        throw new SponsorDidNotPay(sponsorReason(error))
      }

      // Phase 2 — the bundler answered with a hash, so the operation is ACCEPTED and can land at
      // any moment. Nothing past this line may become SponsorDidNotPay: sendContract would send
      // a second copy of a call that may still succeed, and the contracts' duplicate refusal
      // turns that into a reverted transaction the owner paid for. Confirmation gets its own,
      // longer deadline; past it the answer is SPONSOR_PENDING, never a resend.
      const bundlerClient = await getBundler()
      const notice = setTimeout(
        () => input.progress?.("still waiting for the sponsored transaction to be confirmed…"),
        input.receiptNoticeMs ?? SPONSOR_RECEIPT_NOTICE_MS,
      )
      if (typeof notice.unref === "function") notice.unref()
      try {
        let receipt: UserOperationReceipt
        try {
          receipt = await bundlerClient.waitForUserOperationReceipt({
            hash: userOpHash,
            timeout: input.receiptTimeoutMs ?? SPONSOR_RECEIPT_TIMEOUT_MS,
            pollingInterval: input.pollingIntervalMs,
          })
        } catch {
          // A slow or dropped answer is not a refusal. Before giving up ask twice more — the
          // receipt, then the operation itself — and only then admit it is pending.
          const landed = await bundlerClient.getUserOperationReceipt({ hash: userOpHash }).catch(() => null)
          if (landed === null) {
            await bundlerClient.getUserOperation({ hash: userOpHash }).catch(() => null)
            throw new SponsorPending(userOpHash)
          }
          receipt = landed
        }
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
      } finally {
        clearTimeout(notice)
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

const REASON_MAX = 200

/**
 * What a sponsor failure tells the owner — ONE line: the provider's own message and, when it
 * sent one, its `data`. A viem request error keeps the provider's message under `details` while
 * `message` appends `URL:` (which can embed the provider's key) and `Request body:` (the whole
 * request the SDK sent) as meta lines — the Sep 22 refusal reached the owner as exactly that
 * dump. Those lines are stripped, what is left is flattened to a single line, and the total is
 * capped so a verbose provider cannot flood the progress output.
 */
function sponsorReason(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  for (
    let current: unknown = error;
    current !== null && typeof current === "object" && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current)
    const record = current as Record<string, unknown>
    const primary =
      typeof record.details === "string" && record.details.length > 0
        ? record.details
        : typeof record.shortMessage === "string" && record.shortMessage.length > 0
          ? record.shortMessage
          : typeof record.message === "string"
            ? record.message
            : undefined
    if (primary !== undefined && !parts.includes(primary)) parts.push(primary)
    const data = record.data
    if (data !== undefined && data !== null && data !== "") {
      let text: string
      try {
        text = (typeof data === "string" ? data : JSON.stringify(data)) ?? String(data)
      } catch {
        text = String(data)
      }
      if (!parts.includes(text)) parts.push(text)
    }
  }
  const raw = parts.length === 0 ? String(error) : parts.join(" — ")
  // A filtered header (URL:, Request body:, …) owns the INDENTED block under it — viem writes
  // the request's from/to/data there, and letting those lines through ate the whole reason
  // budget on Sep 22. Once a header is dropped, every following indented line goes with it until
  // the next line that starts in column zero (M3-D6 item 5).
  const header = /^\s*(URL|Request body|Request Arguments|Docs|Version):/
  const kept: string[] = []
  let dropping = false
  for (const row of raw.split("\n")) {
    if (header.test(row)) {
      dropping = true
      continue
    }
    if (dropping && /^\s/.test(row)) continue // a header's indented continuation
    dropping = false
    kept.push(row)
  }
  const line = kept.join(" ").replace(/\s+/g, " ").trim()
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}…` : line
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
