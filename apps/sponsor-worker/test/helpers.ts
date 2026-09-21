import { encodeFunctionData, zeroAddress } from "viem"
import type { Address, Hex } from "viem"
import { capabilityRegistryAbi, contextRegistryAbi } from "@mida/chain"
import { randomBytes } from "node:crypto"
import { ACCOUNT_ABI } from "../src/policy.js"
import type { PolicyEnv } from "../src/policy.js"

/**
 * Shared fixtures: a fake deployment on chain 10143, one valid user operation built the way the
 * SDK builds it — `execute(registry, 0, midaCall)` inside an eip7702Auth-delegated sender — plus
 * encoders that mutate one thing at a time for the boundary tests.
 */

export const CAP = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
export const CTX = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"
export const THIRD_CONTRACT = "0x9999999999999999999999999999999999999999"
export const IMPL = "0xe6cae83bde06e4c305530e199d7217f42808555b"
export const ENTRY_POINT = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108"
export const CHAIN_ID = 10143n
export const CHAIN_ID_HEX = "0x279f"
export const ZERO = zeroAddress

export const policyEnv: PolicyEnv = {
  chainId: CHAIN_ID,
  capabilityRegistry: CAP,
  contextRegistry: CTX,
  allowedImplementations: new Set([IMPL]),
}

export function randomAddress(): string {
  return `0x${Buffer.from(randomBytes(20)).toString("hex")}`
}

/** A real Mida call — registerP256Key on the capability registry, register on the context registry. */
export function midaCallData(fn: "registerP256Key" | "register" = "registerP256Key"): Hex {
  if (fn === "registerP256Key") {
    return encodeFunctionData({ abi: capabilityRegistryAbi, functionName: "registerP256Key", args: [1n, 2n] })
  }
  return encodeFunctionData({
    abi: contextRegistryAbi,
    functionName: "register",
    args: [
      randomAddress() as Address,
      [
        {
          contextId: `0x${"11".repeat(32)}`,
          objectNonce: `0x${"22".repeat(32)}`,
          namespaceId: `0x${"33".repeat(32)}`,
          expectedParentId: `0x${"00".repeat(32)}`,
          manifestHash: `0x${"44".repeat(32)}`,
          ciphertextCommitment: `0x${"55".repeat(32)}`,
          evidenceCommitment: `0x${"66".repeat(32)}`,
          readEpoch: 1n,
          expiresAt: 0n,
          recordType: 0,
          lineagePolicy: 0,
          kind: 0,
          provenanceSource: 0,
        },
      ],
    ],
  })
}

export function executeCall(target: Address | string, value: bigint, data: Hex): Hex {
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [target as Address, value, data] })
}

export function batchCall(calls: readonly { target: string; value: bigint; data: Hex }[]): Hex {
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "executeBatch", args: [calls as never] })
}

export function runtimeWrapped(inner: Hex): Hex {
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "executeWithRuntimeValidation", args: [inner, "0x1234"] })
}

/** A valid authorization for chain 10143 delegating to IMPL. */
export function validAuth(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    address: IMPL,
    chainId: CHAIN_ID_HEX,
    nonce: "0x0",
    r: `0x${"ab".repeat(32)}`,
    s: `0x${"cd".repeat(32)}`,
    yParity: "0x0",
    ...overrides,
  }
}

/** A complete, policy-passing user operation; override any field per test. */
export function validUserOp(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sender: randomAddress(),
    nonce: "0x0",
    callData: executeCall(CAP, 0n, midaCallData()),
    callGasLimit: "0x100000",
    verificationGasLimit: "0x40000",
    preVerificationGas: "0x20000",
    maxFeePerGas: "0x1000",
    maxPriorityFeePerGas: "0x100",
    signature: "0xdeadbeef",
    eip7702Auth: validAuth(),
    ...overrides,
  }
}
