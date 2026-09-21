import { GAS_CEILINGS, capabilityRegistryAbi, contextRegistryAbi } from "@mida/chain"
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from "viem"
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

/** Every state-changing function of the two registries — the complete inner-selector allowlist. */
export const ALLOWED_INNER_SELECTORS: ReadonlySet<string> = new Set(
  [...capabilityRegistryAbi, ...contextRegistryAbi]
    .filter(
      (item): item is Extract<(typeof item), { type: "function" }> =>
        item.type === "function" && (item.stateMutability as string) !== "view" && (item.stateMutability as string) !== "pure",
    )
    .map((item) => toFunctionSelector(item)),
)

/** Monad bills the gas LIMIT, not gas used — every field gets a hard ceiling. */
export const CALL_GAS_CEILING = Object.values(GAS_CEILINGS).reduce((a, b) => (b > a ? b : a))
export const VERIFICATION_GAS_CEILING = 500_000n
export const PRE_VERIFICATION_GAS_CEILING = 500_000n
export const PAYMASTER_GAS_CEILING = 300_000n
/**
 * Beyond the brief's fields: a user operation also names its own fee caps, and the paymaster is
 * charged gasPrice = min(maxFeePerGas, baseFee + maxPriorityFeePerGas). A huge priority fee would
 * be paid in full — so both fee fields are capped at a very generous 500 gwei for Monad testnet.
 */
export const FEE_CEILING = 500_000_000_000n // 500 gwei

const GAS_LIMITS: ReadonlyArray<[field: string, ceiling: bigint]> = [
  ["callGasLimit", CALL_GAS_CEILING],
  ["verificationGasLimit", VERIFICATION_GAS_CEILING],
  ["preVerificationGas", PRE_VERIFICATION_GAS_CEILING],
  ["paymasterVerificationGasLimit", PAYMASTER_GAS_CEILING],
  ["paymasterPostOpGasLimit", PAYMASTER_GAS_CEILING],
  ["maxFeePerGas", FEE_CEILING],
  ["maxPriorityFeePerGas", FEE_CEILING],
]

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
}

/** Injected so the policy stays pure — the Worker wires env.RPC_URL here; tests wire a stub. */
export interface ChainQueries {
  getCode(address: string): Promise<string>
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
}

/**
 * Collect every authorization-shaped field. `eip7702Auth` is the wire name; `authorization` is
 * checked too so a client cannot smuggle a second, unchecked authorization past the policy.
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

function emptyField(value: unknown): boolean {
  return value === undefined || value === null || value === "0x" || value === "" || value === ZERO_ADDRESS
}

/**
 * The whole payment policy for one user operation. Returns null when payable; throws PolicyRefusal
 * with a client-facing message otherwise. `getCode` is only called when no authorization is present.
 */
export async function checkUserOperation(op: unknown, env: PolicyEnv, chain: ChainQueries): Promise<Refusal | null> {
  try {
    if (typeof op !== "object" || op === null || Array.isArray(op)) {
      refuse("params", "refused: the user operation must be a JSON object")
    }
    const uo = op as Record<string, unknown>
    if (!isAddress(uo.sender)) {
      refuse("sender", "refused: sender must be the user's own address")
    }
    const sender = (uo.sender as string).toLowerCase()

    // Rule 4: a 7702 sender is never deployed by a factory.
    for (const field of ["factory", "initCode", "factoryData"]) {
      if (!emptyField(uo[field])) {
        refuse("factory", `refused: ${field} must be empty — a delegated user operation is never deployed by a factory`)
      }
    }

    // Rule 3: every authorization present must name this chain and an allowed implementation
    // (or the zero address for a delegation-clearing op); with none, the sender must already be
    // delegated on-chain to an allowed implementation.
    const auths = authorizations(uo)
    for (const auth of auths) checkAuthorization(auth, env)
    const authZeroDelegation = auths.some((a) => isAddress(a.address) && (a.address as string).toLowerCase() === ZERO_ADDRESS)
    if (auths.length === 0) {
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
      if (!delegated) {
        refuse("auth", "refused: the sender is not delegated to an allowed smart-account implementation — include an eip7702Auth")
      }
    }

    // Rule 5: Monad bills the gas limit in full, so every gas field is capped.
    for (const [field, ceiling] of GAS_LIMITS) {
      const value = quantity(uo[field], field)
      if (value !== undefined && value > ceiling) {
        refuse("gas", `refused: ${field} ${value} is over this endpoint's ceiling of ${ceiling}`)
      }
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
    return null
  } catch (e) {
    if (e instanceof PolicyRefusal) return e.refusal
    throw e
  }
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
