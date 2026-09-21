import { describe, expect, it } from "vitest"
import { buildEthCallBody, callP256Precompile, interpretEthCallResult } from "../src/check/rpc.js"
import { P256_PRECOMPILE } from "../src/check/constants.js"

const OK = `0x${"0".repeat(62)}01`

describe("interpretEthCallResult", () => {
  it("reads the canonical 32-byte true", () => {
    expect(interpretEthCallResult(OK)).toBe("verified")
    expect(interpretEthCallResult(`${"0".repeat(63)}1`)).toBe("verified") // no 0x prefix
  })
  it("reads empty output as rejection", () => {
    expect(interpretEthCallResult("0x")).toBe("rejected")
    expect(interpretEthCallResult("")).toBe("rejected")
  })
  it("treats anything else as an RPC anomaly", () => {
    expect(interpretEthCallResult(`0x${"0".repeat(64)}`)).toBe("rpc-error") // 32 bytes of zero
    expect(interpretEthCallResult(`0x${"0".repeat(60)}0101`)).toBe("rpc-error") // non-canonical true
    expect(interpretEthCallResult("0x1234")).toBe("rpc-error")
  })
})

describe("buildEthCallBody", () => {
  it("builds a read-only eth_call to the P256 precompile", () => {
    const input = new Uint8Array(160).fill(0xab)
    const body = JSON.parse(buildEthCallBody(input)) as {
      method: string
      params: [{ to: string; data: string }, string]
    }
    expect(body.method).toBe("eth_call")
    expect(body.params[0].to).toBe(P256_PRECOMPILE)
    expect(body.params[0].data).toBe(`0x${"ab".repeat(160)}`)
    expect(body.params[1]).toBe("latest")
  })
})

describe("callP256Precompile", () => {
  const input = new Uint8Array(160).fill(1)

  it("reports verified when the chain returns 1", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ result: OK }))
    const result = await callP256Precompile(input, fetchFn as typeof fetch, "https://rpc.test")
    expect(result.outcome).toBe("verified")
  })

  it("reports rejected when the chain returns empty output", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ result: "0x" }))
    const result = await callP256Precompile(input, fetchFn as typeof fetch, "https://rpc.test")
    expect(result.outcome).toBe("rejected")
  })

  it("reports an RPC error when the endpoint answers with an error object", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ error: { message: "execution reverted" } }))
    const result = await callP256Precompile(input, fetchFn as typeof fetch, "https://rpc.test")
    expect(result.outcome).toBe("rpc-error")
    expect(result.detail).toContain("execution reverted")
  })

  it("reports unreachable when fetch throws", async () => {
    const fetchFn = async () => {
      throw new Error("network down")
    }
    const result = await callP256Precompile(input, fetchFn as typeof fetch, "https://rpc.test")
    expect(result.outcome).toBe("unreachable")
    expect(result.detail).toContain("network down")
  })
})
