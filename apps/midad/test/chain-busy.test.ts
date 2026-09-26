// in-11 R-8 — "busy" only when it is busy. The old classifier called ANY viem error without a
// contract revert "chain-busy": a call to an address with no contract (wrong RPC / wrong
// deployment) and a provider that rejected the key (HTTP 401) both told the owner "wait, it
// tries again" when the real fix was the setup. The classifier now names the reasons —
// chain-busy, chain-misconfigured, rpc-auth — and stays silent on everything else.
// in-12 N-8 adds the store-* pair: when the STORE is whose RPC broke (its own CHAIN_MISCONFIGURED
// / RPC_AUTH_REJECTED code), the reason names the store operator's problem — never the owner's
// local MONAD_TESTNET_RPC.

import { describe, expect, it } from "vitest"
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
} from "viem"
import { MidaError } from "@mida/protocol"
import { ChainBusyError, capabilityRegistryAbi, chainErrorKind } from "@mida/chain"
import { chainRefusalReason, isChainBusyError } from "../src/chain-busy.js"

const zeroData = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionZeroDataError({ functionName: "getAgent" }),
    {
      abi: capabilityRegistryAbi,
      functionName: "getAgent",
      args: [],
      contractAddress: "0x2222222222222222222222222222222222222222",
    } as never,
  )

const httpStatus = (status: number | undefined) =>
  new HttpRequestError({ url: "https://rpc.example/v2/KEY", status, body: {}, details: "response" })

describe("chainRefusalReason: misconfiguration is not busy", () => {
  it("a call to an address with no contract (wrong RPC / wrong deployment) is 'chain-misconfigured', never 'chain-busy'", () => {
    const error = zeroData()
    expect(isChainBusyError(error)).toBe(false)
    expect(chainRefusalReason(error)).toBe("chain-misconfigured")
  })

  it("the store's own CHAIN_MISCONFIGURED answer names the store's problem, not the owner's (in-12 N-8)", () => {
    // the literal code exists only in the store's error mapper — carrying it means the store's
    // Monad connection found no contract; the owner's rpcUrl was never asked
    expect(chainRefusalReason(new MidaError("CHAIN_MISCONFIGURED", "no contract"))).toBe("store-misconfigured")
  })

  it("a store error still names the store when another layer wraps it", () => {
    expect(chainRefusalReason(new Error("read failed", { cause: new MidaError("CHAIN_MISCONFIGURED", "no contract") }))).toBe(
      "store-misconfigured",
    )
  })
})

describe("chainRefusalReason: a refused credential is not busy", () => {
  it("an RPC that rejects the key (HTTP 401) is 'rpc-auth', never 'chain-busy'", () => {
    const error = httpStatus(401)
    expect(isChainBusyError(error)).toBe(false)
    expect(chainRefusalReason(error)).toBe("rpc-auth")
  })

  it("HTTP 403 classifies the same way", () => {
    expect(chainRefusalReason(httpStatus(403))).toBe("rpc-auth")
  })

  it("the store's own RPC_AUTH_REJECTED answer names the store's problem, not the owner's (in-12 N-8)", () => {
    expect(chainRefusalReason(new MidaError("RPC_AUTH_REJECTED", "bad key"))).toBe("store-rpc-auth")
  })
})

describe("chainRefusalReason: what still counts as busy", () => {
  it("the transport's own ChainBusyError — bare or inside viem's wrap", () => {
    expect(chainRefusalReason(new ChainBusyError())).toBe("chain-busy")
    expect(chainRefusalReason(new HttpRequestError({ url: "http://rpc.test", cause: new ChainBusyError() }))).toBe("chain-busy")
  })

  it("the store's CHAIN_UNAVAILABLE answer and a spent read budget", () => {
    expect(chainRefusalReason(new MidaError("CHAIN_UNAVAILABLE", "busy"))).toBe("chain-busy")
    expect(chainRefusalReason(Object.assign(new Error("budget"), { code: "CHAIN_READ_BUDGET_EXHAUSTED" }))).toBe("chain-busy")
  })

  it("a transient transport answer: 429, 408 and 5xx statuses", () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(chainRefusalReason(httpStatus(status)), `status ${status}`).toBe("chain-busy")
    }
  })

  it("a network failure with no status — the request never reached a server", () => {
    expect(chainRefusalReason(httpStatus(undefined))).toBe("chain-busy")
  })

  it("a viem TimeoutError and RPC overload codes -32005/-32603", () => {
    expect(chainRefusalReason(new TimeoutError({ body: {}, url: "http://rpc.test" }))).toBe("chain-busy")
    for (const code of [-32005, -32603]) {
      const error = new RpcRequestError({ body: {}, error: { code, message: "rpc" }, url: "http://rpc.test" })
      expect(chainRefusalReason(error), `code ${code}`).toBe("chain-busy")
    }
  })
})

describe("chainRefusalReason: everything else keeps its own name", () => {
  it("a wrapped contract revert is a real answer, not a transport failure", () => {
    const error = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: capabilityRegistryAbi, functionName: "getAgent" }),
      {
        abi: capabilityRegistryAbi,
        functionName: "getAgent",
        args: [],
        contractAddress: "0x2222222222222222222222222222222222222222",
      } as never,
    )
    expect(chainRefusalReason(error)).toBeUndefined()
    expect(isChainBusyError(error)).toBe(false)
  })

  it("a bare viem error with no classification signal and a plain Error are unnamed", () => {
    expect(chainRefusalReason(new BaseError("request failed"))).toBeUndefined()
    expect(chainRefusalReason(new Error("disk exploded"))).toBeUndefined()
  })
})

describe("chainErrorKind (the shared classifier @mida/api maps to HTTP)", () => {
  it("kind vocabulary: busy / misconfigured / rpc-auth / undefined", () => {
    expect(chainErrorKind(zeroData())).toBe("misconfigured")
    expect(chainErrorKind(httpStatus(401))).toBe("rpc-auth")
    expect(chainErrorKind(httpStatus(503))).toBe("busy")
    expect(chainErrorKind(new Error("nope"))).toBeUndefined()
  })
})
