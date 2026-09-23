import { GAS_CEILINGS, capabilityRegistryAbi, contextRegistryAbi } from "@mida/chain"
import type { TxKind } from "@mida/chain"
import { decodeFunctionData, encodeFunctionData, keccak256, toFunctionSelector } from "viem"
import { recoverAuthorizationAddress } from "viem/utils"
import type { Address, Hex } from "viem"

/**
 * The payment policy, in plain words: this endpoint pays gas only for user operations that are
 * provably Mida calls — every inner call hits one of the two registries, moves no MON, and calls
 * a state-changing function from their ABIs. Anything the decoder does not fully recognise is a
 * refusal, never a pass. `checkUserOperation` returns `null` when the operation is payable and a
 * `Refusal` naming the rule otherwise.
 */

/** EntryPoint v0.8 — the only version Monad's sponsored stack supports today. */
export const ENTRY_POINT_V0_8 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108"

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
export const EIP7702_DELEGATION_PREFIX = "0xef0100"
/**
 * The factory marker a FIRST user operation carries when its accompanying EIP-7702 authorization
 * deploys the sender's account in the same transaction. viem emits it bare (`0x7702`) and packs it
 * right-padded to 20 bytes inside `initCode` — both forms confirmed in the installed source at
 * `node_modules/viem/_esm/account-abstraction/utils/userOperation/getInitCode.js` lines 5–14.
 * It is only meaningful alongside a real `eip7702Auth`, and `factoryData` must stay empty — with
 * the marker, EntryPoint calls the SENDER with those bytes as an initialisation call the
 * inner-call rules would never see.
 */
const EIP7702_FACTORY_MARKER = "0x7702"
const EIP7702_FACTORY_MARKER_PADDED = "0x7702000000000000000000000000000000000000"
export const MAX_INNER_CALLS = 8

/**
 * `execute(address,uint256,bytes)` and `executeBatch((address,uint256,bytes)[])` — identical on
 * the Pimlico Simple account and Alchemy's SemiModularAccount7702. Alchemy wraps either inside
 * `executeWithRuntimeValidation(bytes,bytes)`; the decoder unwraps exactly one level.
 */
const EXECUTE = "0xb61d27f6"
const EXECUTE_BATCH = "0x34fcd5be"
const EXECUTE_WITH_RUNTIME_VALIDATION = toFunctionSelector("executeWithRuntimeValidation(bytes,bytes)") // 0xf2680c0f

export const ACCOUNT_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeWithRuntimeValidation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "callData", type: "bytes" },
      { name: "authorizationData", type: "bytes" },
    ],
    outputs: [],
  },
] as const

/**
 * Every state-changing registry function names the TxKind whose measured ceiling it bills under —
 * the same GAS_CEILINGS table the SDK's own sends use. A function absent here is absent from the
 * payable set: a contract upgrade cannot make a new selector payable by accident.
 *
 * The four agent-admin functions with no measured kind ride on the measured envelopes of their
 * shape: the two signature-free setters (rotateAgentEncryptionKey, setAgentCallbackOrigin — an
 * operator check, a couple of writes, an event) bill like `revoke`, and the two that also recover
 * a signature (rotateAgentSigner, updateAgentCapabilityManifest) bill like `revokeAndRotate`.
 */
export const GAS_KIND_BY_FUNCTION: Readonly<Record<string, TxKind>> = {
  grantBatch: "grant.batch",
  initializeReadEpoch: "epoch.init",
  registerAgent: "agent.register",
  registerP256Key: "owner.key",
  revoke: "revoke.capability",
  revokeAgentAndRotate: "revoke.agent",
  revokeAndRotate: "revoke.rotate",
  rotateAgentEncryptionKey: "revoke.capability",
  rotateAgentSigner: "revoke.rotate",
  rotateExpiredEpoch: "epoch.rotateExpired",
  rotateP256Key: "owner.keyRotate",
  setAgentCallbackOrigin: "revoke.capability",
  updateAgentCapabilityManifest: "revoke.rotate",
  register: "context.register",
}

/**
 * Selector → billed ceiling, built by walking the two registry ABIs so it can never drift from
 * them: every state-changing function contributes exactly its GAS_KIND_BY_FUNCTION ceiling, and
 * nothing else is in the map.
 */
export const INNER_CALL_GAS: ReadonlyMap<string, bigint> = new Map(
  [...capabilityRegistryAbi, ...contextRegistryAbi]
    .filter(
      (item): item is Extract<(typeof item), { type: "function" }> =>
        item.type === "function" && (item.stateMutability as string) !== "view" && (item.stateMutability as string) !== "pure",
    )
    .flatMap((item) => {
      const kind = GAS_KIND_BY_FUNCTION[item.name]
      return kind === undefined ? [] : [[toFunctionSelector(item).toLowerCase(), GAS_CEILINGS[kind]] as const]
    }),
)

/** Every state-changing function of the two registries — the complete inner-selector allowlist. */
export const ALLOWED_INNER_SELECTORS: ReadonlySet<string> = new Set(INNER_CALL_GAS.keys())

/**
 * The account's own execution cost per inner call, billed on top of the call's ceiling — the
 * Simple account's execute loop, calldata handling and per-call frame. callGasLimit may reach at
 * most sum(inner ceilings) + this × the call count.
 */
export const CALL_OVERHEAD_PER_CALL = 60_000n

/** Monad bills the gas LIMIT, not gas used — every field gets a hard ceiling. */
export const VERIFICATION_GAS_CEILING = 500_000n
/**
 * preVerificationGas grows with calldata bytes. A three-scope grantBatch carrying the signed
 * manifest and the owner's passkey assertion measured 547,190 on Monad testnet (Sep 22, live) —
 * the old 500,000 refused every grant while sponsoring everything smaller. 1,200,000 leaves room
 * for larger manifests. The money bound no longer comes from this ceiling alone: each fee field
 * is also capped at 1.5× the live `fast` gas price, and every signing reserves its worst-case
 * cost against a daily wei budget — so a big preVerificationGas at an inflated fee is refused by
 * the live-price cap, and a flood of them is refused by the spend budget.
 */
export const PRE_VERIFICATION_GAS_CEILING = 1_200_000n
export const PAYMASTER_GAS_CEILING = 300_000n
/**
 * Beyond the brief's fields: a user operation also names its own fee caps, and the paymaster is
 * charged gasPrice = min(maxFeePerGas, baseFee + maxPriorityFeePerGas). A huge priority fee would
 * be paid in full — so both fee fields are capped twice: at this fixed ceiling and at 1.5× the
 * live `fast` price the provider reports, whichever is lower.
 */
export const FEE_CEILING = 300_000_000_000n // 300 gwei
/** Each fee field must stay within this multiple of the live `fast` gas price. */
const LIVE_FEE_NUMERATOR = 3n
const LIVE_FEE_DENOMINATOR = 2n

/** The four fixed ceilings an operation is billed against, resolved per deployment. */
export interface GasCeilings {
  verificationGas: bigint
  preVerificationGas: bigint
  paymasterGas: bigint
  /** Wei — caps both maxFeePerGas and maxPriorityFeePerGas. */
  fee: bigint
}

export const DEFAULT_GAS_CEILINGS: GasCeilings = {
  verificationGas: VERIFICATION_GAS_CEILING,
  preVerificationGas: PRE_VERIFICATION_GAS_CEILING,
  paymasterGas: PAYMASTER_GAS_CEILING,
  fee: FEE_CEILING,
}

/** Methods that carry a user operation in params[0] — the only methods the policy engine sees. */
export const USER_OP_METHODS = new Set([
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
])

export interface Refusal {
  /** Short machine-readable rule name for the log line — never the request body. */
  rule: string
  /** Plain message for the client: which rule, and what to do. */
  message: string
}

export interface PolicyEnv {
  chainId: bigint
  /** Lowercase hex addresses. */
  capabilityRegistry: string
  contextRegistry: string
  allowedImplementations: ReadonlySet<string>
  /** The fixed ceilings as deployed — env may have tightened them below the built-ins. */
  ceilings: GasCeilings
  /**
   * Whether a zero-address authorization may buy the exact delegation-clearing operation. Off by
   * default: whether a delegated account can even validate the operation that clears its own code
   * is unproven until the probe says so — an unproven exception is only attack surface.
   */
  allowClearing: boolean
}

/** Injected so the policy stays pure — the Worker wires env.RPC_URL here; tests wire a stub. */
export interface ChainQueries {
  getCode(address: string): Promise<string>
  /**
   * The live `fast` gas price in wei, read once per request through the provider's
   * `pimlico_getUserOperationGasPrice` (the Worker caches it for 30 s per instance). Called only
   * when the operation carries fee fields — an operation without them skips the read entirely.
   */
  gasPrice(): Promise<bigint>
}

export interface InnerCall {
  target: string
  value: bigint
  data: string
}

export class PolicyRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
  }
}

function refuse(rule: string, message: string): never {
  throw new PolicyRefusal({ rule, message })
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)
}

function isAddress(value: unknown): value is string {
  return isHex(value) && value.length === 42
}

/** JSON-RPC quantities arrive as hex strings; be tolerant of numbers and decimal strings too. */
function quantity(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "bigint") return value
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) refuse("params", `refused: ${field} is not a valid quantity`)
    return BigInt(value)
  }
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value)
    if (value === "0x") return 0n
    if (/^[0-9]+$/.test(value)) return BigInt(value)
  }
  refuse("params", `refused: ${field} is not a valid quantity`)
}

/**
 * Decode `execute`/`executeBatch` calldata — or Alchemy's runtime-validation wrapper around one of
 * them, one level and no deeper. The round-trip check (decode → re-encode → byte equality) refuses
 * trailing garbage and any non-canonical encoding instead of trusting what the decoder tolerated.
 */
export function decodeCalls(callData: unknown, wrapped = false): { kind: "execute" | "executeBatch"; calls: InnerCall[] } {
  if (!isHex(callData) || callData.length < 10) {
    refuse("calldata", "refused: callData is not recognisable — this endpoint only pays for calls built by the Mida SDK")
  }
  const selector = callData.slice(0, 10).toLowerCase()

  if (selector === EXECUTE_WITH_RUNTIME_VALIDATION) {
    if (wrapped) refuse("calldata", "refused: nested executeWithRuntimeValidation is not supported")
    let inner: Hex
    try {
      const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: callData as Hex })
      if (decoded.functionName !== "executeWithRuntimeValidation") refuse("calldata", "refused: unrecognised account call")
      if (encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "executeWithRuntimeValidation", args: decoded.args }) !== callData.toLowerCase()) {
        refuse("calldata", "refused: callData is not canonically ABI-encoded")
      }
      inner = decoded.args[0]
    } catch (e) {
      if (e instanceof PolicyRefusal) throw e
      refuse("calldata", "refused: callData has a valid selector but its body does not decode — check the SDK version")
    }
    return decodeCalls(inner!, true)
  }

  if (selector !== EXECUTE && selector !== EXECUTE_BATCH) {
    refuse("calldata", "refused: the account call is not execute or executeBatch — this endpoint only pays for calls built by the Mida SDK")
  }
  try {
    const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: callData as Hex })
    const reencoded = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: decoded.functionName, args: decoded.args })
    if (reencoded !== callData.toLowerCase()) refuse("calldata", "refused: callData is not canonically ABI-encoded")
    if (decoded.functionName === "execute") {
      const [target, value, data] = decoded.args as [Address, bigint, Hex]
      return { kind: "execute", calls: [{ target: target.toLowerCase(), value, data: data.toLowerCase() }] }
    }
    const [calls] = decoded.args as [readonly { target: Address; value: bigint; data: Hex }[]]
    return { kind: "executeBatch", calls: calls.map((c) => ({ target: c.target.toLowerCase(), value: c.value, data: c.data.toLowerCase() })) }
  } catch (e) {
    if (e instanceof PolicyRefusal) throw e
    refuse("calldata", "refused: callData has a valid selector but its body does not decode — check the SDK version")
  }
}

interface Authorization {
  chainId?: unknown
  address?: unknown
  nonce?: unknown
  r?: unknown
  s?: unknown
  yParity?: unknown
}

/**
 * Collect every authorization-shaped field. `eip7702Auth` is the wire name the bundler acts on;
 * `authorization` is a second name some tooling emits. Both are validated — a bad one under
 * either name refuses — but only `eip7702Auth` counts as a real authorization below, because a
 * field the provider ignores proves nothing about the code the sender will actually run.
 */
function authorizations(op: Record<string, unknown>): Authorization[] {
  const auths: Authorization[] = []
  for (const key of ["eip7702Auth", "authorization"]) {
    const value = op[key]
    if (value === undefined || value === null) continue
    if (typeof value !== "object" || Array.isArray(value)) refuse("auth", "refused: the authorization field is malformed")
    auths.push(value as Authorization)
  }
  return auths
}

function checkAuthorization(auth: Authorization, env: PolicyEnv): void {
  const chainId = quantity(auth.chainId, "eip7702Auth.chainId")
  if (chainId === 0n) {
    refuse("auth", "refused: a chain-id-0 authorization is valid on every chain and is never accepted here")
  }
  if (chainId !== env.chainId) {
    refuse("auth", `refused: this endpoint sponsors chain ${env.chainId} only — sign the authorization for that chain`)
  }
  if (!isAddress(auth.address)) {
    refuse("auth", "refused: the authorization address is malformed")
  }
  const address = (auth.address as string).toLowerCase()
  if (address !== ZERO_ADDRESS && !env.allowedImplementations.has(address)) {
    refuse("auth", "refused: the delegation target is not an allowed smart-account implementation")
  }
}

/**
 * The delegation must be signed BY THE SENDER. Before this check an authorization-shaped object
 * passed on chain id and address alone — the attacker could staple any valid-looking delegation
 * to a sender that was their own contract, and the sponsor paid for whatever it ran. nonce, r,
 * s and yParity are required; the authorizer recovered from the signature must equal the sender.
 */
async function checkAuthorizationSignature(auth: Authorization, sender: string): Promise<void> {
  for (const field of ["nonce", "r", "s", "yParity"] as const) {
    if (auth[field] === undefined || auth[field] === null) {
      refuse("auth", `refused: the authorization is missing ${field} — the delegation must be signed by the sender`)
    }
  }
  const nonce = quantity(auth.nonce, "eip7702Auth.nonce")
  const yParity = quantity(auth.yParity, "eip7702Auth.yParity")
  const chainId = quantity(auth.chainId, "eip7702Auth.chainId")
  if (nonce === undefined || yParity === undefined || chainId === undefined || !isHex(auth.r) || !isHex(auth.s)) {
    refuse("auth", "refused: the authorization signature is malformed — the delegation must be signed by the sender")
  }
  let authorizer: Address
  try {
    authorizer = await recoverAuthorizationAddress({
      authorization: {
        address: auth.address as Address,
        chainId: Number(chainId),
        nonce: nonce as unknown as number,
        r: auth.r as Hex,
        s: auth.s as Hex,
        yParity: Number(yParity),
      },
    })
  } catch {
    refuse("auth", "refused: the delegation is not signed by the sender")
  }
  if (authorizer!.toLowerCase() !== sender) {
    refuse("auth", "refused: the delegation is not signed by the sender")
  }
}

function emptyField(value: unknown): boolean {
  return value === undefined || value === null || value === "0x" || value === "" || value === ZERO_ADDRESS
}

/**
 * The whole payment policy for one user operation. Returns null when payable; throws PolicyRefusal
 * with a client-facing message otherwise. The sender's code is always read — a signed eip7702Auth
 * only delegates a plain EOA. `options.requireGasFields` is set on the sign and send paths, where
 * a missing gas field would skip its ceiling and the spend reservation; the stub and estimate
 * methods leave it off and keep tolerating partial operations.
 */
export async function checkUserOperation(
  op: unknown,
  env: PolicyEnv,
  chain: ChainQueries,
  options?: { requireGasFields?: boolean },
): Promise<Refusal | null> {
  try {
    if (typeof op !== "object" || op === null || Array.isArray(op)) {
      refuse("params", "refused: the user operation must be a JSON object")
    }
    const uo = op as Record<string, unknown>
    if (!isAddress(uo.sender)) {
      refuse("sender", "refused: sender must be the user's own address")
    }
    const sender = (uo.sender as string).toLowerCase()

    // Rule 3: every authorization present must name this chain and an allowed implementation
    // (or the zero address for a delegation-clearing op); with none, the sender must already be
    // delegated on-chain to an allowed implementation.
    const auths = authorizations(uo)
    for (const auth of auths) checkAuthorization(auth, env)
    // Only a real `eip7702Auth` stands in for the on-chain delegation read and only it confers
    // the zero-address clearing privilege — it is the field the bundler applies. (The malformed
    // case already refused inside `authorizations`, so a non-null value here is an object whose
    // fields passed checkAuthorization.)
    const eipAuth = uo.eip7702Auth as Authorization | null | undefined
    const hasValidEipAuth = eipAuth !== undefined && eipAuth !== null
    const authZeroDelegation =
      eipAuth != null && isAddress(eipAuth.address) && (eipAuth.address as string).toLowerCase() === ZERO_ADDRESS
    // An eip7702Auth must be signed by the sender it names — then the sender's code is read
    // ALWAYS, authorization or not: an authorization only delegates a plain EOA, so a sender
    // that already runs its own contract code is refused either way.
    if (hasValidEipAuth) {
      await checkAuthorizationSignature(eipAuth!, sender)
    }
    let code: string
    try {
      code = await chain.getCode(sender)
    } catch {
      refuse("auth", "refused: the sender's delegation could not be read — try again, or include an eip7702Auth")
    }
    const delegated =
      isHex(code) &&
      code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX) &&
      code.length === EIP7702_DELEGATION_PREFIX.length + 40 &&
      env.allowedImplementations.has(`0x${code.slice(EIP7702_DELEGATION_PREFIX.length)}`.toLowerCase())
    if (!delegated && !(hasValidEipAuth && (code === "0x" || code === ""))) {
      refuse(
        "auth",
        hasValidEipAuth
          ? "refused: the sender already runs contract code — a signed authorization can only delegate a plain account"
          : "refused: the sender is not delegated to an allowed smart-account implementation — include an eip7702Auth",
      )
    }

    // Rule 4: factory fields stay empty — except the EIP-7702 marker, bare or right-padded to 20
    // bytes, and only when a valid eip7702Auth rides along. An on-chain delegation does not unlock
    // it: the marker means "apply this authorization", so the authorization must be in the op.
    if (!emptyField(uo.factory)) {
      const factory = isHex(uo.factory) ? (uo.factory as string).toLowerCase() : ""
      const isMarker = factory === EIP7702_FACTORY_MARKER || factory === EIP7702_FACTORY_MARKER_PADDED
      if (!isMarker || !hasValidEipAuth) {
        refuse(
          "factory",
          "refused: factory must be empty — or exactly the EIP-7702 marker alongside a valid authorization",
        )
      }
    }
    if (!emptyField(uo.initCode)) {
      const initCode = isHex(uo.initCode) ? (uo.initCode as string).toLowerCase() : ""
      if (initCode !== EIP7702_FACTORY_MARKER_PADDED || !hasValidEipAuth) {
        refuse("factory", "refused: initCode must be empty — or exactly the 20-byte EIP-7702 marker, nothing appended")
      }
    }
    // With the marker, EntryPoint calls the sender with factoryData as an initialisation call —
    // bytes the inner-call rules never see. It stays empty, always.
    if (!emptyField(uo.factoryData)) {
      refuse("factory", "refused: factoryData must be empty — a delegated user operation is never initialised by a factory call")
    }

    // Rules 1–2: decode the account call; every inner call must be a zero-value Mida call, except
    // the single delegation-clearing shape (execute to self, empty data, zero-address authorization).
    const { kind, calls } = decodeCalls(uo.callData)
    if (calls.length === 0) refuse("calldata", "refused: an empty batch buys nothing — send a real call")
    if (calls.length > MAX_INNER_CALLS) {
      refuse("calldata", `refused: ${calls.length} inner calls is over the limit of ${MAX_INNER_CALLS}`)
    }
    const only = calls[0]
    const clearing =
      kind === "execute" && calls.length === 1 && only !== undefined && only.target === sender && only.data === "0x" && authZeroDelegation
    // A zero-address authorization erases the sender's code in the same transaction — allowed only
    // for the exact clearing shape, and only when this endpoint opted in. An ordinary Mida call
    // riding along would clear the delegation and still fail on chain at the sponsor's expense.
    if (authZeroDelegation) {
      if (!env.allowClearing) {
        refuse("auth", "refused: this endpoint does not sponsor delegation clearing")
      }
      if (!clearing) {
        refuse(
          "auth",
          "refused: a zero-address authorization buys only the delegation-clearing operation — one execute to the sender's own address with empty data",
        )
      }
    }
    if (!clearing) {
      for (const call of calls) {
        if (call.target !== env.capabilityRegistry && call.target !== env.contextRegistry) {
          refuse("target", "refused: this endpoint only pays for calls to the Mida contracts")
        }
        if (call.value !== 0n) {
          refuse("value", "refused: sponsored calls move no MON — set the call value to 0")
        }
        const selector = isHex(call.data) && call.data.length >= 10 ? call.data.slice(0, 10) : undefined
        if (selector === undefined || !ALLOWED_INNER_SELECTORS.has(selector)) {
          refuse("selector", "refused: this endpoint only pays for Mida contract calls")
        }
      }
    }

    // Rule 5: Monad bills the gas limit in full, so every gas field is capped — the fixed fields
    // against the deployed ceilings, and callGasLimit against what the decoded calls may bill:
    // the sum of their per-function ceilings plus the account's per-call overhead. A cheap call
    // can no longer bill like the most expensive one. On the sign and send paths every field is
    // REQUIRED — a missing field would skip its ceiling and the spend reservation.
    const strict = options?.requireGasFields === true
    const paymasterSet = !emptyField(uo.paymaster) || !emptyField(uo.paymasterAndData)
    const seen = new Map<string, bigint>()
    for (const [field, ceiling, paymasterField] of [
      ["verificationGasLimit", env.ceilings.verificationGas, false],
      ["preVerificationGas", env.ceilings.preVerificationGas, false],
      ["paymasterVerificationGasLimit", env.ceilings.paymasterGas, true],
      ["paymasterPostOpGasLimit", env.ceilings.paymasterGas, true],
      ["maxFeePerGas", env.ceilings.fee, false],
      ["maxPriorityFeePerGas", env.ceilings.fee, false],
    ] as const) {
      const value = quantity(uo[field], field)
      if (value === undefined) {
        if (strict && (!paymasterField || paymasterSet)) {
          refuse("gas", `refused: ${field} is missing — a sponsored operation must carry every gas field`)
        }
        continue
      }
      seen.set(field, value)
      if (value > ceiling) {
        refuse("gas", `refused: ${field} ${value} is over this endpoint's ceiling of ${ceiling}`)
      }
    }
    const callGas = quantity(uo.callGasLimit, "callGasLimit")
    if (callGas === undefined) {
      if (strict) {
        refuse("gas", "refused: callGasLimit is missing — a sponsored operation must carry every gas field")
      }
    } else {
      let ceiling = CALL_OVERHEAD_PER_CALL * BigInt(calls.length)
      if (!clearing) {
        for (const call of calls) {
          const selector = call.data.slice(0, 10)
          const billed = INNER_CALL_GAS.get(selector)
          if (billed === undefined) {
            refuse("gas", "refused: an inner call has no gas ceiling — it cannot be sponsored")
          }
          ceiling += billed
        }
      }
      if (callGas > ceiling) {
        refuse("gas", `refused: callGasLimit ${callGas} is over this operation's ceiling of ${ceiling}`)
      }
    }

    // The fee fields are also capped at 1.5× the live `fast` gas price — the fixed ceiling alone
    // let a caller name 300 gwei whatever the market did. The price is fetched only when the op
    // carries a fee field, and an unreadable price fails CLOSED: no live price, no sponsorship.
    const maxFee = seen.get("maxFeePerGas")
    const maxPriorityFee = seen.get("maxPriorityFeePerGas")
    if (maxFee !== undefined || maxPriorityFee !== undefined) {
      let live: bigint
      try {
        live = await chain.gasPrice()
      } catch {
        refuse("fee", "refused: the gas price could not be checked — try again")
      }
      const cap = (live! * LIVE_FEE_NUMERATOR) / LIVE_FEE_DENOMINATOR
      if (maxFee !== undefined && maxFee > cap) {
        refuse("fee", `refused: maxFeePerGas ${maxFee} is over 1.5x the live gas price (${cap})`)
      }
      if (maxPriorityFee !== undefined && maxPriorityFee > cap) {
        refuse("fee", `refused: maxPriorityFeePerGas ${maxPriorityFee} is over 1.5x the live gas price (${cap})`)
      }
    }
    return null
  } catch (e) {
    if (e instanceof PolicyRefusal) return e.refusal
    throw e
  }
}

/**
 * The most an operation can bill the paymaster: every gas limit as sent × maxFeePerGas. This is
 * what the signing step reserves against the daily wei budget — Monad charges the LIMIT, so the
 * worst case is the honest one. Fields missing from the op count as zero; on the paths this is
 * used, the strict gas-field check has already required them.
 */
export function operationMaxCostWei(op: Record<string, unknown>): bigint {
  let units = 0n
  for (const field of [
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "paymasterVerificationGasLimit",
    "paymasterPostOpGasLimit",
  ]) {
    units += quantity(op[field], field) ?? 0n
  }
  return units * (quantity(op.maxFeePerGas, "maxFeePerGas") ?? 0n)
}

/**
 * The identifying tuple the Worker stores when it signs an operation and requires before it will
 * send one: sender, nonce, and the callData hash — the fields that decide what the paymaster
 * signature can buy. Normalised the same way on both paths so a signed operation always finds
 * its own record. A malformed nonce is a refusal here too, because an operation whose nonce we
 * cannot compare is an operation we cannot say we signed.
 */
export function operationIdentity(op: Record<string, unknown>): { sender: string; nonce: string; callDataHash: string } {
  const sender = (op.sender as string).toLowerCase()
  const nonce = quantity(op.nonce, "nonce")
  const callDataHash = keccak256((op.callData as string).toLowerCase() as Hex)
  return { sender, nonce: nonce === undefined ? "" : nonce.toString(10), callDataHash }
}

/**
 * The params that reach the provider. For pm_* calls the worker rebuilds them as
 * [userOp, entryPoint, chainId, providerContext] — the client's context argument never survives.
 */
export function checkedParams(method: string, params: unknown, env: PolicyEnv, context?: unknown): unknown[] {
  const list = Array.isArray(params) ? params : params === undefined ? [] : undefined
  if (list === undefined) {
    return refuseAndReturn("params", "refused: params must be a JSON array")
  }
  const entryPoint = list[1]
  if (list.length < 2 || !isAddress(entryPoint) || entryPoint.toLowerCase() !== ENTRY_POINT_V0_8) {
    return refuseAndReturn("entrypoint", "refused: this endpoint sponsors EntryPoint v0.8 user operations only")
  }
  if (method === "pm_getPaymasterStubData" || method === "pm_getPaymasterData") {
    const chainId = quantity(list[2], "params[2] (chainId)")
    if (chainId !== env.chainId) {
      return refuseAndReturn("chain", `refused: this endpoint sponsors chain ${env.chainId} only`)
    }
    return [list[0], list[1], list[2], context]
  }
  return [list[0], list[1]]
}

function refuseAndReturn(rule: string, message: string): never {
  throw new PolicyRefusal({ rule, message })
}
