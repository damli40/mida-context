// in-6 R4 — "the chain could not be asked" is never mislabeled an authorization answer.
// On Sep 25 every unknown failure inside a route answered 500 CAPABILITY_DENIED "internal
// error; request denied": a rate-limited RPC read inside the access check made an approved
// agent look refused — the owner re-approved a grant that was live all along. Now chain-busy
// answers 503 CHAIN_UNAVAILABLE and a truly unknown failure answers 500 INTERNAL_ERROR. Both
// still return no data — fail closed — but the name says what really happened.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { BaseError, ContractFunctionExecutionError, ContractFunctionZeroDataError, HttpRequestError } from "viem"
import { MidaError, namespaceId } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { ChainBusyError, capabilityRegistryAbi } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, RegistryReader, createContextApi } from "@mida/api"
import { ChainReadBudgetExceeded } from "../src/chain-budget.js"
import { toErrorBody } from "../src/errors.js"

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}
const NOW = 1_800_000_000n
const NAMESPACE = namespaceId("goals.career")
const account = privateKeyToAccount(generatePrivateKey())

/** The shape a rate-limited RPC leaves behind inside viem: the typed error under the wrap. */
const wrappedBusy = () => new HttpRequestError({ url: "http://rpc.test", cause: new ChainBusyError() })

describe("toErrorBody (in-6 R4)", () => {
  it("a ChainBusyError — bare or inside viem's wrap — answers 503 CHAIN_UNAVAILABLE", () => {
    for (const error of [new ChainBusyError(), wrappedBusy()]) {
      const { status, body } = toErrorBody(error)
      expect(status).toBe(503)
      expect(body.error.code).toBe("CHAIN_UNAVAILABLE")
    }
  })

  it("a genuinely unreachable transport answers 503 CHAIN_UNAVAILABLE — the chain could not be asked", () => {
    for (const error of [
      new HttpRequestError({ url: "http://rpc.test", status: 503, body: {}, details: "unavailable" }),
      new HttpRequestError({ url: "http://rpc.test", status: 429, body: {}, details: "limited" }),
      new HttpRequestError({ url: "http://rpc.test" }), // no status: never reached a server
    ]) {
      const { status, body } = toErrorBody(error)
      expect(status).toBe(503)
      expect(body.error.code).toBe("CHAIN_UNAVAILABLE")
    }
  })

  // in-11 R-8 — a setup the owner must fix is not "unavailable": the RPC answered but found no
  // contract, or the provider refused the key. Both are non-retryable 502s with their own codes.
  it("an RPC that answered but found no contract answers 502 CHAIN_MISCONFIGURED, naming the store's RPC_URL", () => {
    const error = new ContractFunctionExecutionError(
      new ContractFunctionZeroDataError({ functionName: "getAgent" }),
      { abi: capabilityRegistryAbi, functionName: "getAgent", args: [], contractAddress: "0x2222222222222222222222222222222222222222" } as never,
    )
    // in-13b M-7: the hosted store is a Worker — its RPC endpoint is the RPC_URL variable, which
    // it passes as its rpcHint (in-14 F-4). A message naming MONAD_TESTNET_RPC / network.json
    // sends the operator looking in the wrong place (those are the owner's-side settings).
    const { status, body } = toErrorBody(error, { rpcHint: "RPC_URL" })
    expect(status).toBe(502)
    expect(body.error.code).toBe("CHAIN_MISCONFIGURED")
    expect(body.error.message).toContain("RPC_URL")
    expect(body.error.message).not.toContain("MONAD_TESTNET_RPC")
    expect(body.error.message).not.toContain("network.json")
  })

  // in-14 F-4: the same toErrorBody also serves the local persistent store, which has no RPC_URL
  // — its RPC endpoint is the rpcUrl key in network.json. The hint is per-store, and a caller
  // that declares none gets a neutral wording rather than a setting that does not exist there.
  it("the RPC hint names the store's own setting — network.json rpcUrl on a laptop store, neutral with no hint", () => {
    const error = new ContractFunctionExecutionError(
      new ContractFunctionZeroDataError({ functionName: "getAgent" }),
      { abi: capabilityRegistryAbi, functionName: "getAgent", args: [], contractAddress: "0x2222222222222222222222222222222222222222" } as never,
    )
    const local = toErrorBody(error, { rpcHint: "network.json rpcUrl" })
    expect(local.body.error.message).toContain("network.json rpcUrl")
    expect(local.body.error.message).not.toContain("RPC_URL")
    const bare = toErrorBody(error)
    expect(bare.body.error.message).toContain("RPC endpoint")
    expect(bare.body.error.message).not.toContain("RPC_URL")
    const auth = toErrorBody(new HttpRequestError({ url: "http://rpc.test", status: 401, body: {}, details: "no" }), { rpcHint: "network.json rpcUrl" })
    expect(auth.body.error.message).toContain("network.json rpcUrl")
    expect(auth.body.error.message).not.toContain("RPC_URL")
  })

  it("createContextApi threads the store's rpcHint into the wire answer", async () => {
    // a misconfigured-RPC answer through the real route — the hint the store declared, verbatim
    const reader = {
      agentIdOfSigner: async () => {
        throw new ContractFunctionExecutionError(
          new ContractFunctionZeroDataError({ functionName: "getAgent" }),
          { abi: capabilityRegistryAbi, functionName: "getAgent", args: [], contractAddress: "0x2222222222222222222222222222222222222222" } as never,
        )
      },
      getAgent: async () => null,
      getRecord: async () => null,
      now: async () => NOW,
      requiredReadEpoch: async () => 1n,
      isWriteEpochValid: async () => true,
    } as unknown as RegistryReader
    const { app } = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-errors-")), clock: () => NOW, rpcHint: "network.json rpcUrl" })
    let last: Response | undefined
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => NOW,
      fetch: async (url, init) => {
        const res = await app.request(url, init)
        last = res.clone()
        return res
      },
    })
    const otherOwner = `0x${"9".repeat(40)}` as Address
    await expect(client.request("GET", `/objects?owner=${otherOwner}&namespaceId=${NAMESPACE}`)).rejects.toMatchObject({ code: "CHAIN_MISCONFIGURED" })
    expect(last!.status).toBe(502)
    const body = (await last!.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("network.json rpcUrl")
    expect(body.error?.message).not.toContain("RPC_URL")
  })

  it("an RPC that refused the credential (401/403) answers 502 RPC_AUTH_REJECTED, naming the store's RPC_URL", () => {
    for (const s of [401, 403]) {
      const { status, body } = toErrorBody(new HttpRequestError({ url: "http://rpc.test", status: s, body: {}, details: "no" }), { rpcHint: "RPC_URL" })
      expect(status, `status ${s}`).toBe(502)
      expect(body.error.code).toBe("RPC_AUTH_REJECTED")
      expect(body.error.message).toContain("RPC_URL")
    }
  })

  it("a viem failure that is none of those — the chain answered something unexpected — is 500 INTERNAL_ERROR, not a 503 that lies 'unreachable'", () => {
    const { status, body } = toErrorBody(new BaseError("request failed"))
    expect(status).toBe(500)
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })

  it("the request's own chain-read budget error answers 503 CHAIN_UNAVAILABLE too", () => {
    const { status, body } = toErrorBody(new ChainReadBudgetExceeded())
    expect(status).toBe(503)
    expect(body.error.code).toBe("CHAIN_UNAVAILABLE")
  })

  it("a truly unknown failure answers 500 INTERNAL_ERROR — never an authorization code", () => {
    const { status, body } = toErrorBody(new Error("disk exploded"))
    expect(status).toBe(500)
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })

  it("a typed refusal keeps its own code and status — authorization answers are untouched", () => {
    const { status, body } = toErrorBody(new MidaError("CAPABILITY_DENIED", "no grant"))
    expect(status).toBe(403)
    expect(body.error.code).toBe("CAPABILITY_DENIED")
  })
})

describe("a rate-limited access check (in-6 R4)", () => {
  it("GET /objects answers 503 CHAIN_UNAVAILABLE and carries no object data", async () => {
    // The chain read authorization makes is the call that cannot be answered — exactly the
    // Sep 25 shape: the RPC stayed rate-limited, the store must not call that a denial.
    const reader = {
      agentIdOfSigner: async () => {
        throw wrappedBusy()
      },
      getAgent: async () => null,
      getRecord: async () => null,
      now: async () => NOW,
      requiredReadEpoch: async () => 1n,
      isWriteEpochValid: async () => true,
    } as unknown as RegistryReader
    const { app } = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-errors-")), clock: () => NOW })
    let last: Response | undefined
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => NOW,
      fetch: async (url, init) => {
        const res = await app.request(url, init)
        last = res.clone()
        return res
      },
    })
    // signer ≠ the queried owner, so authorizeAgent's chain read runs — and it is the failing call.
    const otherOwner = `0x${"9".repeat(40)}` as Address
    await expect(
      client.request("GET", `/objects?owner=${otherOwner}&namespaceId=${NAMESPACE}`),
    ).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" })
    expect(last!.status).toBe(503)
    const body = (await last!.json()) as { error?: { code?: string }; objects?: unknown }
    expect(body.error?.code).toBe("CHAIN_UNAVAILABLE")
    // fail closed: the refusal carries an error and nothing that could pass for data
    expect(body.objects).toBeUndefined()
  })
})
