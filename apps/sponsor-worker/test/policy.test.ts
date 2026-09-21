// M3-B item 2: the payment policy, unit-tested rule by rule. Every rule gets a passing case at
// its boundary and a refusal one step over — plus the adversarial cases the brief calls out:
// a chain-id-0 authorization, a batch poisoned by one third-contract call, garbage calldata that
// must refuse rather than throw, and an `authorization` field smuggled under the other wire name.

import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import { checkUserOperation, checkedParams, decodeCalls } from "../src/policy.js"
import type { ChainQueries } from "../src/policy.js"
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

async function refused(op: Record<string, unknown>, chain: ChainQueries = neverCalled): Promise<string> {
  const refusal = await checkUserOperation(op, policyEnv, chain)
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

describe("checkUserOperation — sender and factory", () => {
  it("accepts a valid operation", async () => {
    expect(await checkUserOperation(validUserOp(), policyEnv, neverCalled)).toBeNull()
  })

  it("refuses a malformed sender", async () => {
    expect(await refused(validUserOp({ sender: "0x1234" }))).toBe("sender")
    expect(await refused(validUserOp({ sender: 42 }))).toBe("sender")
  })

  it("refuses any factory or initCode", async () => {
    expect(await refused(validUserOp({ factory: randomAddress() }))).toBe("factory")
    expect(await refused(validUserOp({ initCode: "0x1234" }))).toBe("factory")
    expect(await refused(validUserOp({ factoryData: "0x1234" }))).toBe("factory")
  })

  it("accepts empty factory fields", async () => {
    expect(await checkUserOperation(validUserOp({ factory: ZERO, factoryData: "0x", initCode: "0x" }), policyEnv, neverCalled)).toBeNull()
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

  it("accepts the zero address — the delegation-clearing authorization", async () => {
    expect(await checkUserOperation(validUserOp({ eip7702Auth: validAuth({ address: ZERO }) }), policyEnv, neverCalled)).toBeNull()
  })

  it("checks an `authorization` field too — the other wire name cannot smuggle a bad auth", async () => {
    expect(await refused(validUserOp({ authorization: validAuth({ chainId: "0x0" }) }))).toBe("auth")
    expect(await refused(validUserOp({ eip7702Auth: validAuth(), authorization: validAuth({ address: randomAddress() }) }))).toBe("auth")
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
    ["callGasLimit", "0x5b8d80" /* 6_000_000 */, "0x5b8d81"],
    ["verificationGasLimit", "0x7a120" /* 500_000 */, "0x7a121"],
    ["preVerificationGas", "0x7a120", "0x7a121"],
    ["paymasterVerificationGasLimit", "0x493e0" /* 300_000 */, "0x493e1"],
    ["paymasterPostOpGasLimit", "0x493e0", "0x493e1"],
    ["maxFeePerGas", "0x746a528800" /* 500 gwei */, "0x746a528801"],
    ["maxPriorityFeePerGas", "0x746a528800", "0x746a528801"],
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

  it("the delegation-clearing case: execute to self, empty data, zero-address auth — and only that", async () => {
    const sender = randomAddress()
    const clearing = validUserOp({
      sender,
      callData: executeCall(sender, 0n, "0x"),
      eip7702Auth: validAuth({ address: ZERO }),
    })
    expect(await checkUserOperation(clearing, policyEnv, neverCalled)).toBeNull()

    // Same shape without the zero-address authorization is just a non-Mida call — refused.
    expect(await refused(validUserOp({ sender, callData: executeCall(sender, 0n, "0x") }))).toBe("target")
    // Empty data to self inside a batch is not the clearing case.
    expect(
      await refused(
        validUserOp({
          sender,
          callData: batchCall([{ target: sender, value: 0n, data: "0x" as Hex }]),
          eip7702Auth: validAuth({ address: ZERO }),
        }),
      ),
    ).toBe("target")
    // And self-call with non-empty data is not clearing either.
    expect(
      await refused(
        validUserOp({ sender, callData: executeCall(sender, 0n, midaCallData()), eip7702Auth: validAuth({ address: ZERO }) }),
      ),
    ).toBe("target")
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
