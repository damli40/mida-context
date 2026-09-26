import { describe, expect, it } from "vitest"
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } from "viem"
import { ChainBusyError } from "@mida/chain"
import { MidaError } from "@mida/protocol"
import { contextRegistryAbi } from "@mida/chain"
import { debugLine, refusalCode } from "../src/debug-line.js"

/**
 * CHAIN-09 — every refusal a `mida` command prints gets a real name: the error's own code, else
 * CHAIN_CALL_FAILED for a viem chain error, else UNEXPECTED — never the word ERROR. The debug
 * line is the MIDA_DEBUG=1 detail: the error's own fields and its cause chain, long hex masked.
 * in-6 R4 adds chain-busy: a chain that could not be ASKED (busy RPC, transport failure) is not
 * the same answer as a chain that answered with a revert.
 */
describe("refusalCode (CHAIN-09)", () => {
  it("returns the error's own string code", () => {
    const error = Object.assign(new Error("inner detail never shown"), { code: "SOME_CODE" })
    expect(refusalCode(error)).toBe("SOME_CODE")
  })

  it("a chain that could not be asked is chain-busy, never an authorization code (in-6 R4)", () => {
    // a bare viem transport failure, a wrapped ChainBusyError, and the store's CHAIN_UNAVAILABLE
    expect(refusalCode(new BaseError("request failed"))).toBe("chain-busy")
    expect(refusalCode(new HttpRequestError({ url: "http://rpc.test", cause: new ChainBusyError() }))).toBe("chain-busy")
    expect(refusalCode(new MidaError("CHAIN_UNAVAILABLE", "busy"))).toBe("chain-busy")
    expect(refusalCode(new ChainBusyError())).toBe("chain-busy")
  })

  it("a real contract revert still says CHAIN_CALL_FAILED — the chain answered, it was not unreachable", () => {
    const reverted = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: contextRegistryAbi, functionName: "getRecord" }),
      { abi: contextRegistryAbi, args: [`0x${"1".repeat(64)}`], contractAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", functionName: "getRecord" },
    )
    expect(refusalCode(reverted)).toBe("CHAIN_CALL_FAILED")
  })

  it("a plain error, a non-error and nothing at all are UNEXPECTED, never ERROR", () => {
    expect(refusalCode(new Error("x"))).toBe("UNEXPECTED")
    expect(refusalCode("not even an error")).toBe("UNEXPECTED")
    expect(refusalCode(undefined)).toBe("UNEXPECTED")
    expect(refusalCode(null)).toBe("UNEXPECTED")
  })
})

describe("debugLine (CHAIN-09)", () => {
  it("matches the old inline block for an error with no cause", () => {
    // the shape existing tests pin: name, shortMessage ?? message, details — " | "-joined,
    // newline-lines " / "-joined, hex runs masked, prefixed "debug: "
    expect(debugLine(new Error("plain"))).toBe("debug: Error | plain")
    const error = Object.assign(new Error("the message"), { details: "the details" })
    expect(debugLine(error)).toBe("debug: Error | the message | the details")
  })

  it("masks a 64-hex run as <hex>", () => {
    const hex = `0x${"ab".repeat(32)}`
    const line = debugLine(new Error(`execution reverted: ${hex} with more data`))
    expect(line).toContain("<hex>")
    expect(line).not.toContain(hex)
  })

  it("walks the cause chain — a two-level cause names both errors", () => {
    const error = Object.assign(new Error("outer failure"), { cause: new BaseError("inner cause") })
    const line = debugLine(error)
    expect(line.startsWith("debug: ")).toBe(true)
    expect(line).toContain("outer failure")
    expect(line).toContain("inner cause")
    expect(line).toContain(" / ")
  })

  it("stops walking after five levels", () => {
    let error = new Error("level 6")
    for (let depth = 5; depth >= 1; depth -= 1) {
      error = Object.assign(new Error(`level ${depth}`), { cause: error })
    }
    const line = debugLine(error)
    expect(line).toContain("level 5")
    expect(line).not.toContain("level 6")
  })

  it("caps the detail at 900 characters", () => {
    const line = debugLine(new Error("x".repeat(2_000)))
    expect(line.startsWith("debug: ")).toBe(true)
    expect(line.length).toBeLessThanOrEqual("debug: ".length + 900)
  })
})
