// M3-B item 2: the payment policy, unit-tested rule by rule. Every rule gets a passing case at
// its boundary and a refusal one step over — plus the adversarial cases the brief calls out:
// a chain-id-0 authorization, a batch poisoned by one third-contract call, garbage calldata that
// must refuse rather than throw, and an `authorization` field smuggled under the other wire name.

import { describe, expect, it } from "vitest"
import { createClient, custom } from "viem"
import type { Hex } from "viem"
import { toSimple7702SmartAccount } from "viem/account-abstraction"
import { privateKeyToAccount } from "viem/accounts"
import { to7702SimpleSmartAccount } from "permissionless/accounts"
import { monadTestnet } from "viem/chains"
import {
  ALLOWED_INNER_SELECTORS,
  CALL_OVERHEAD_PER_CALL,
  GAS_KIND_BY_FUNCTION,
  INNER_CALL_GAS,
  checkUserOperation,
  checkedParams,
  decodeCalls,
} from "../src/policy.js"
import type { ChainQueries, PolicyEnv } from "../src/policy.js"
import { GAS_CEILINGS, capabilityRegistryAbi, contextRegistryAbi } from "@mida/chain"
import { toFunctionSelector } from "viem"
import {
  CAP,
  CHAIN_ID,
  CHAIN_ID_HEX,
  CTX,
  ENTRY_POINT,
  IMPL,
  THIRD_CONTRACT,
  ZERO,
  batchCall,
  executeCall,
  midaCallData,
  policyEnv,
  randomAddress,
  runtimeWrapped,
  validAuth,
  validUserOp,
} from "./helpers.js"

const delegated = (impl = IMPL): ChainQueries => ({
  getCode: async () => `0xef0100${impl.slice(2)}`,
})
const neverCalled: ChainQueries = {
  getCode: async () => {
    throw new Error("getCode must not be called when an authorization is present")
  },
}

async function refused(op: Record<string, unknown>, chain: ChainQueries = neverCalled, env: PolicyEnv = policyEnv): Promise<string> {
  const refusal = await checkUserOperation(op, env, chain)
  expect(refusal).not.toBeNull()
  return refusal!.rule
}

describe("decodeCalls", () => {
  it("decodes execute and executeBatch", () => {
    const single = decodeCalls(executeCall(CAP, 0n, midaCallData()))
    expect(single).toEqual({ kind: "execute", calls: [{ target: CAP, value: 0n, data: midaCallData() }] })
    const batch = decodeCalls(batchCall([{ target: CTX, value: 0n, data: midaCallData("register") }]))
    expect(batch.kind).toBe("executeBatch")
    expect(batch.calls[0]?.target).toBe(CTX)
  })

  it("decodes Alchemy's runtime-validation wrapper exactly one level", () => {
    const inner = executeCall(CAP, 0n, midaCallData())
    expect(decodeCalls(runtimeWrapped(inner)).calls[0]?.target).toBe(CAP)
    // A wrapper around a wrapper is refused — one level, no deeper.
    expect(() => decodeCalls(runtimeWrapped(runtimeWrapped(inner)))).toThrow(/nested/)
  })

  it("refuses trailing bytes after the ABI payload", () => {
    const call = `${executeCall(CAP, 0n, midaCallData())}00` as Hex
    expect(() => decodeCalls(call)).toThrow(/canonical/)
  })

  it("refuses a valid selector with a garbage body — a refusal, not an exception type leak", () => {
    expect(() => decodeCalls(`0xb61d27f6${"ff".repeat(100)}`)).toThrow(/does not decode/)
  })

  it("refuses an unrecognised account selector", () => {
    expect(() => decodeCalls(`0xdeadbeef${"00".repeat(64)}`)).toThrow(/not execute or executeBatch/)
  })
})

const EIP7702_MARKER = "0x7702"
const EIP7702_MARKER_PADDED = "0x7702000000000000000000000000000000000000"

describe("checkUserOperation — sender and factory", () => {
  it("accepts a valid operation", async () => {
    expect(await checkUserOperation(validUserOp(), policyEnv, neverCalled)).toBeNull()
  })

  it("refuses a malformed sender", async () => {
    expect(await refused(validUserOp({ sender: "0x1234" }))).toBe("sender")
    expect(await refused(validUserOp({ sender: 42 }))).toBe("sender")
  })

  it("accepts the EIP-7702 factory marker — bare or 20-byte padded — with a valid authorization", async () => {
    expect(await checkUserOperation(validUserOp({ factory: EIP7702_MARKER }), policyEnv, neverCalled)).toBeNull()
    expect(await checkUserOperation(validUserOp({ factory: EIP7702_MARKER_PADDED }), policyEnv, neverCalled)).toBeNull()
  })

  it("accepts the packed initCode marker with a valid authorization — and nothing appended", async () => {
    expect(await checkUserOperation(validUserOp({ initCode: EIP7702_MARKER_PADDED }), policyEnv, neverCalled)).toBeNull()
    expect(await refused(validUserOp({ initCode: `${EIP7702_MARKER_PADDED}abcd` }))).toBe("factory")
    expect(await refused(validUserOp({ initCode: EIP7702_MARKER }))).toBe("factory")
  })

  it("refuses the marker without an eip7702Auth — on-chain delegation is not a substitute", async () => {
    expect(await refused(validUserOp({ factory: EIP7702_MARKER, eip7702Auth: undefined }), delegated())).toBe("factory")
    // An `authorization` field under the other wire name does not unlock the marker either.
    expect(
      await refused(validUserOp({ factory: EIP7702_MARKER, eip7702Auth: undefined, authorization: validAuth() }), delegated()),
    ).toBe("factory")
  })

  it("refuses factoryData even alongside the marker — EntryPoint would call the sender with it", async () => {
    expect(await refused(validUserOp({ factory: EIP7702_MARKER, factoryData: "0x1234" }))).toBe("factory")
    expect(await refused(validUserOp({ initCode: EIP7702_MARKER_PADDED, factoryData: "0x1234" }))).toBe("factory")
  })

  it("refuses a marker-looking prefix on a longer factory address, and any other non-empty factory", async () => {
    expect(await refused(validUserOp({ factory: `0x7702${"dead".repeat(9)}` }))).toBe("factory")
    expect(await refused(validUserOp({ factory: "0x7702aa" }))).toBe("factory")
    expect(await refused(validUserOp({ factory: randomAddress() }))).toBe("factory")
    expect(await refused(validUserOp({ initCode: "0x1234" }))).toBe("factory")
    expect(await refused(validUserOp({ factoryData: "0x1234" }))).toBe("factory")
  })

  it("accepts empty factory fields", async () => {
    expect(await checkUserOperation(validUserOp({ factory: ZERO, factoryData: "0x", initCode: "0x" }), policyEnv, neverCalled)).toBeNull()
  })
})

describe("checkUserOperation — operations built by the real account libraries", () => {
  const owner = privateKeyToAccount(`0x${"01".repeat(32)}`)
  // A chain stub answering the only reads the account builders make: getCode (undeployed) and ids.
  const fakeChain = createClient({
    chain: monadTestnet,
    transport: custom({
      async request({ method }) {
        if (method === "eth_getCode") return "0x"
        if (method === "eth_chainId") return CHAIN_ID_HEX
        if (method === "eth_getTransactionCount") return "0x0"
        throw new Error(`unexpected chain call: ${method}`)
      },
    }),
  })

  it("viem's toSimple7702SmartAccount emits the 0x7702 marker — and the policy accepts the op it builds", async () => {
    const account = await toSimple7702SmartAccount({ client: fakeChain, owner })
    const { factory, factoryData } = await account.getFactoryArgs()
    expect(factory).toBe(EIP7702_MARKER)
    expect(factoryData).toBe("0x")
    const op = validUserOp({
      sender: await account.getAddress(),
      callData: await account.encodeCalls([{ to: CAP, value: 0n, data: midaCallData() }]),
      factory,
      factoryData,
      // The signed authorization object, passed through exactly as the library produced it.
      eip7702Auth: await owner.signAuthorization({ contractAddress: IMPL, chainId: 10143, nonce: 0 }),
    })
    expect(await checkUserOperation(op, policyEnv, neverCalled)).toBeNull()
  })

  it("permissionless's to7702SimpleSmartAccount emits no factory — the authorization carries it", async () => {
    const account = await to7702SimpleSmartAccount({ client: fakeChain, owner })
    const { factory, factoryData } = await account.getFactoryArgs()
    expect(factory).toBeUndefined()
    expect(factoryData).toBeUndefined()
    const op = validUserOp({
      sender: await account.getAddress(),
      callData: await account.encodeCalls([{ to: CAP, value: 0n, data: midaCallData() }]),
      factory,
      factoryData,
      eip7702Auth: await owner.signAuthorization({ contractAddress: IMPL, chainId: 10143, nonce: 0 }),
    })
    expect(await checkUserOperation(op, policyEnv, neverCalled)).toBeNull()
  })
})

describe("checkUserOperation — eip7702Auth", () => {
  it("refuses a chain-id-0 authorization — valid on every chain", async () => {
    expect(await refused(validUserOp({ eip7702Auth: validAuth({ chainId: "0x0" }) }))).toBe("auth")
    expect(await refused(validUserOp({ eip7702Auth: validAuth({ chainId: 0 }) }))).toBe("auth")
  })

  it("refuses an authorization for another chain", async () => {
    expect(await refused(validUserOp({ eip7702Auth: validAuth({ chainId: "0x1" }) }))).toBe("auth")
  })

  it("refuses an implementation outside the allowlist", async () => {
    expect(await refused(validUserOp({ eip7702Auth: validAuth({ address: randomAddress() }) }))).toBe("auth")
  })

  it("refuses the zero address when it accompanies ordinary calls — a clearing authorization buys only the clearing shape", async () => {
    expect(await refused(validUserOp({ eip7702Auth: validAuth({ address: ZERO }) }))).toBe("auth")
  })

  it("checks an `authorization` field too — the other wire name cannot smuggle a bad auth", async () => {
    expect(await refused(validUserOp({ authorization: validAuth({ chainId: "0x0" }) }))).toBe("auth")
    expect(await refused(validUserOp({ eip7702Auth: validAuth(), authorization: validAuth({ address: randomAddress() }) }))).toBe("auth")
  })

  it("an `authorization` field alone never stands in for eip7702Auth — the bundler ignores it", async () => {
    // Valid under the other name, but the sender runs whatever code it actually has on-chain:
    // not delegated → refused; delegated to the allowed impl → payable.
    const op = validUserOp({ eip7702Auth: undefined, authorization: validAuth() })
    expect(await refused(op, { getCode: async () => "0x" })).toBe("auth")
    expect(await checkUserOperation(op, policyEnv, delegated())).toBeNull()
    // And a zero address under the other name confers no clearing privilege — the self-call is
    // still just a non-Mida call.
    const sender = randomAddress()
    expect(
      await refused(
        validUserOp({
          sender,
          eip7702Auth: undefined,
          authorization: validAuth({ address: ZERO }),
          callData: executeCall(sender, 0n, "0x"),
        }),
        delegated(),
      ),
    ).toBe("target")
  })

  it("with no authorization, the sender must already be delegated to an allowed implementation", async () => {
    const op = validUserOp({ eip7702Auth: undefined })
    expect(await checkUserOperation(op, policyEnv, delegated())).toBeNull()
    expect(await refused(op, { getCode: async () => "0x" })).toBe("auth")
    expect(await refused(op, { getCode: async () => "0x6080604052" })).toBe("auth")
    expect(await refused(op, delegated(randomAddress()))).toBe("auth")
    expect(await refused(op, { getCode: async () => "0xef0100" })).toBe("auth") // prefix with no address
    expect(await refused(op, { getCode: async () => { throw new Error("rpc down") } })).toBe("auth")
  })
})

describe("checkUserOperation — gas ceilings", () => {
  // Boundary: exactly at the ceiling passes, one over refuses and names the field.
  const cases: [field: string, at: string, over: string][] = [
    ["verificationGasLimit", "0x7a120" /* 500_000 */, "0x7a121"],
    ["preVerificationGas", "0x124f80" /* 1_200_000 */, "0x124f81"],
    ["paymasterVerificationGasLimit", "0x493e0" /* 300_000 */, "0x493e1"],
    ["paymasterPostOpGasLimit", "0x493e0", "0x493e1"],
    ["maxFeePerGas", "0x45d964b800" /* 300 gwei */, "0x45d964b801"],
    ["maxPriorityFeePerGas", "0x45d964b800", "0x45d964b801"],
  ]
  for (const [field, at, over] of cases) {
    it(`${field}: ceiling passes, one over refuses`, async () => {
      expect(await checkUserOperation(validUserOp({ [field]: at }), policyEnv, neverCalled)).toBeNull()
      const refusal = await checkUserOperation(validUserOp({ [field]: over }), policyEnv, neverCalled)
      expect(refusal?.rule).toBe("gas")
      expect(refusal?.message).toContain(field)
    })
  }
})

describe("checkUserOperation — callGasLimit is billed per inner function", () => {
  const stateChanging = (abi: readonly unknown[]) =>
    abi.filter(
      (item): item is { type: "function"; name: string; stateMutability?: string } =>
        (item as { type: string }).type === "function" &&
        ((item as { stateMutability?: string }).stateMutability ?? "") !== "view" &&
        ((item as { stateMutability?: string }).stateMutability ?? "") !== "pure",
    )

  it("every state-changing ABI function maps to a TxKind and a ceiling — nothing unmapped can become payable", () => {
    const expected = new Set<string>()
    for (const fn of [...stateChanging(capabilityRegistryAbi), ...stateChanging(contextRegistryAbi)]) {
      const kind = GAS_KIND_BY_FUNCTION[fn.name]
      expect(kind, `${fn.name} has no TxKind mapping`).toBeDefined()
      const selector = toFunctionSelector(fn as never)
      expected.add(selector)
      expect(INNER_CALL_GAS.get(selector)).toBe(GAS_CEILINGS[kind!])
    }
    // And the payable set is exactly the mapped set — no stray selectors on either side.
    expect(new Set(INNER_CALL_GAS.keys())).toEqual(expected)
    expect(new Set(ALLOWED_INNER_SELECTORS)).toEqual(expected)
  })

  // A single call of each function may bill its own ceiling plus the account's per-call overhead —
  // and nothing more. The selector alone is enough: inner data is never argument-decoded.
  const fnCalls: { registry: string; fn: { name: string } }[] = [
    ...stateChanging(capabilityRegistryAbi).map((fn) => ({ registry: CAP, fn })),
    ...stateChanging(contextRegistryAbi).map((fn) => ({ registry: CTX, fn })),
  ]
  for (const { registry, fn } of fnCalls) {
    it(`${fn.name}: bills up to ${GAS_KIND_BY_FUNCTION[fn.name]} + overhead, refuses one over`, async () => {
      const ceiling = GAS_CEILINGS[GAS_KIND_BY_FUNCTION[fn.name]!]
      const selector = toFunctionSelector(fn as never)
      const op = (callGasLimit: bigint) =>
        validUserOp({ callData: executeCall(registry, 0n, selector), callGasLimit: `0x${callGasLimit.toString(16)}` })
      expect(await checkUserOperation(op(ceiling + CALL_OVERHEAD_PER_CALL), policyEnv, neverCalled)).toBeNull()
      const refusal = await checkUserOperation(op(ceiling + CALL_OVERHEAD_PER_CALL + 1n), policyEnv, neverCalled)
      expect(refusal?.rule).toBe("gas")
      expect(refusal?.message).toContain("callGasLimit")
    })
  }

  it("a batch bills the SUM of its inner ceilings plus overhead per call", async () => {
    // registerP256Key (200k) + register (650k) + 2×60k overhead = 970,000.
    const callData = batchCall([
      { target: CAP, value: 0n, data: midaCallData() },
      { target: CTX, value: 0n, data: midaCallData("register") },
    ])
    const op = (callGasLimit: bigint) => validUserOp({ callData, callGasLimit: `0x${callGasLimit.toString(16)}` })
    expect(await checkUserOperation(op(970_000n), policyEnv, neverCalled)).toBeNull()
    expect((await checkUserOperation(op(970_001n), policyEnv, neverCalled))?.rule).toBe("gas")
  })

  it("a cheap call can no longer bill like a full agent revoke", async () => {
    // registerP256Key at the old flat 6,000,000 ceiling: refused now.
    const op = validUserOp({ callGasLimit: "0x5b8d80" /* 6_000_000 */ })
    expect((await checkUserOperation(op, policyEnv, neverCalled))?.rule).toBe("gas")
  })
})

describe("checkUserOperation — inner calls", () => {
  it("a batch of Mida calls on both registries passes", async () => {
    const op = validUserOp({
      callData: batchCall([
        { target: CAP, value: 0n, data: midaCallData() },
        { target: CTX, value: 0n, data: midaCallData("register") },
      ]),
    })
    expect(await checkUserOperation(op, policyEnv, neverCalled)).toBeNull()
  })

  it("one third-contract call inside a batch of valid calls refuses the WHOLE operation", async () => {
    const op = validUserOp({
      callData: batchCall([
        { target: CAP, value: 0n, data: midaCallData() },
        { target: THIRD_CONTRACT, value: 0n, data: midaCallData() },
        { target: CTX, value: 0n, data: midaCallData("register") },
      ]),
    })
    expect(await refused(op)).toBe("target")
  })

  it("refuses a Mida selector aimed at the wrong contract", async () => {
    expect(await refused(validUserOp({ callData: executeCall(THIRD_CONTRACT, 0n, midaCallData()) }))).toBe("target")
  })

  it("value 0 passes, 1 wei refuses", async () => {
    expect(await checkUserOperation(validUserOp({ callData: executeCall(CAP, 0n, midaCallData()) }), policyEnv, neverCalled)).toBeNull()
    expect(await refused(validUserOp({ callData: executeCall(CAP, 1n, midaCallData()) }))).toBe("value")
  })

  it("refuses an inner selector that is not a Mida state-changing function", async () => {
    // A view function's selector is not in the state-changing allowlist.
    const viewCall = "0x" + "deadbeef" + "00".repeat(32)
    expect(await refused(validUserOp({ callData: executeCall(CAP, 0n, viewCall as Hex) }))).toBe("selector")
    // Empty inner data on a registry call is not a function call at all.
    expect(await refused(validUserOp({ callData: executeCall(CAP, 0n, "0x") }))).toBe("selector")
  })

  it("8 inner calls pass, 9 refuse", async () => {
    const call = { target: CAP, value: 0n, data: midaCallData() }
    expect(
      await checkUserOperation(validUserOp({ callData: batchCall(Array(8).fill(call)) }), policyEnv, neverCalled),
    ).toBeNull()
    expect(await refused(validUserOp({ callData: batchCall(Array(9).fill(call)) }))).toBe("calldata")
  })

  it("refuses an empty batch", async () => {
    expect(await refused(validUserOp({ callData: batchCall([]) }))).toBe("calldata")
  })

  it("the delegation-clearing case is off by default and exact even when enabled", async () => {
    const sender = randomAddress()
    const clearing = validUserOp({
      sender,
      callData: executeCall(sender, 0n, "0x"),
      eip7702Auth: validAuth({ address: ZERO }),
      // The clearing call buys no function — its ceiling is the per-call overhead alone, 60,000.
      callGasLimit: "0xea60",
    })
    const clearingOn: PolicyEnv = { ...policyEnv, allowClearing: true }

    // Default: off. The exact clearing shape is refused until the endpoint opts in.
    expect(await refused(clearing)).toBe("auth")
    // Enabled: the exact shape passes — and still bills only the 60,000 overhead.
    expect(await checkUserOperation(clearing, clearingOn, neverCalled)).toBeNull()
    expect((await checkUserOperation(validUserOp({ ...clearing, callGasLimit: "0xea61" }), clearingOn, neverCalled))?.rule).toBe("gas")

    // Enabled or not, a zero-address authorization never accompanies an ordinary Mida call —
    // today it would clear the delegation and the calls would still fail on chain at our expense.
    for (const env of [policyEnv, clearingOn]) {
      expect(
        await refused(validUserOp({ sender, eip7702Auth: validAuth({ address: ZERO }) }), neverCalled, env),
      ).toBe("auth")
    }

    // Same shape without the zero-address authorization is just a non-Mida call — refused.
    expect(await refused(validUserOp({ sender, callData: executeCall(sender, 0n, "0x") }))).toBe("target")
    // Empty data to self inside a batch is not the clearing case.
    for (const env of [policyEnv, clearingOn]) {
      expect(
        await refused(
          validUserOp({
            sender,
            callData: batchCall([{ target: sender, value: 0n, data: "0x" as Hex }]),
            eip7702Auth: validAuth({ address: ZERO }),
            callGasLimit: "0xea60",
          }),
          neverCalled,
          env,
        ),
      ).toBe("auth")
    }
    // And self-call with non-empty data is not clearing either.
    for (const env of [policyEnv, clearingOn]) {
      expect(
        await refused(
          validUserOp({ sender, callData: executeCall(sender, 0n, midaCallData()), eip7702Auth: validAuth({ address: ZERO }) }),
          neverCalled,
          env,
        ),
      ).toBe("auth")
    }
  })

  it("garbage callData is a refusal, never a throw", async () => {
    for (const callData of ["0x", "0x1234", "0xb61d27f6", `0xb61d27f6${"ab".repeat(10)}`, "not-hex", 42, null]) {
      const refusal = await checkUserOperation(validUserOp({ callData }), policyEnv, neverCalled)
      expect(refusal).not.toBeNull()
      expect(refusal!.rule).toBe("calldata")
    }
  })
})

describe("checkedParams — entry point, chain, and the injected policy context", () => {
  it("rebuilds pm_* params, replacing the client's context with the server's", () => {
    const op = validUserOp()
    const client = [op, ENTRY_POINT, CHAIN_ID_HEX, { sponsorshipPolicyId: "client-chosen" }]
    const out = checkedParams("pm_getPaymasterStubData", client, policyEnv, { sponsorshipPolicyId: "server-policy" })
    expect(out).toEqual([op, ENTRY_POINT, CHAIN_ID_HEX, { sponsorshipPolicyId: "server-policy" }])
  })

  it("refuses pm_* params naming another chain", () => {
    expect(() => checkedParams("pm_getPaymasterData", [validUserOp(), ENTRY_POINT, "0x1"], policyEnv, {})).toThrow(/chain/)
  })

  it("refuses any entry point but v0.8", () => {
    expect(() => checkedParams("eth_sendUserOperation", [validUserOp(), randomAddress()], policyEnv)).toThrow(/EntryPoint v0.8/)
    const out = checkedParams("eth_sendUserOperation", [validUserOp(), ENTRY_POINT], policyEnv)
    expect(out).toHaveLength(2)
  })

  it("refuses params that are not an array", () => {
    expect(() => checkedParams("eth_sendUserOperation", { sender: "0x" }, policyEnv)).toThrow(/array/)
    expect(() => checkedParams("eth_sendUserOperation", [], policyEnv)).toThrow(/EntryPoint v0.8/)
  })

  it("accepts the entry point case-insensitively", () => {
    const mixedCase = `0x${ENTRY_POINT.slice(2).toUpperCase()}`
    const out = checkedParams("eth_estimateUserOperationGas", [validUserOp(), mixedCase], policyEnv)
    expect(out).toHaveLength(2)
  })

  it("pm_* chain id may arrive decimal or hex", () => {
    const op = validUserOp()
    expect(() => checkedParams("pm_getPaymasterStubData", [op, ENTRY_POINT, CHAIN_ID.toString()], policyEnv, {})).not.toThrow()
  })
})
