// M3-D item 2(i): the sponsored sender against a fake endpoint. Two JSON-RPC servers stand in for
// the chain (delegation reads, the EntryPoint nonce call) and for the sponsor (the bundler +
// paymaster dialect permissionless speaks). Nothing here touches a real network — the whole point
// is that the SDK builds the exact wire shapes the endpoint's policy accepts.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { encodeErrorResult } from "viem"
import type { Address, Hex } from "viem"
import { MidaError } from "@mida/protocol"
import { SPONSORED_IMPLEMENTATION, SponsorDidNotPay, capabilityRegistryAbi, contextRegistryAbi, createSponsoredSender } from "@mida/chain"
import type { Deployment } from "@mida/chain"

const IMPL = SPONSORED_IMPLEMENTATION
const ENTRY_POINT = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address
const PAYMASTER = "0x7777777777777777777777777777777777777777" as Address
const USER_OP_HASH: Hex = `0x${"5a".repeat(32)}`
const BUNDLE_TX: Hex = `0x${"6b".repeat(32)}`

const deployment: Deployment = {
  chainId: 10143n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: `0x${"00".repeat(32)}` as Hex,
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"00".repeat(32)}` as Hex,
}

type RpcHandler = (params: unknown[]) => unknown

/** A JSON-RPC server on an ephemeral localhost port; `methods[method]` answers, anything else -32601. */
async function rpcServer(methods: Record<string, RpcHandler>): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      void (async () => {
        let id: unknown = null
        try {
          const call = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] }
          id = call.id
          const handler = methods[call.method]
          if (handler === undefined) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${call.method}` } }))
            return
          }
          const result = await handler(call.params ?? [])
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
        } catch (error) {
          const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32000
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } }))
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    // A hung request would keep close() waiting on its socket forever — drop every connection first.
    close: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

/** Records every user operation the SDK sends, and scripts each sponsor answer. */
interface SponsorScript {
  gasPrice?: unknown
  stubData?: unknown
  estimateGas?: unknown
  paymasterData?: unknown
  sendResult?: unknown
  sendError?: { code: number; message: string }
  sendHang?: boolean
  receipt?: unknown
  byHash?: unknown
}

const DEFAULT_GAS_PRICE = {
  slow: { maxFeePerGas: "0x64000000", maxPriorityFeePerGas: "0x100000" },
  standard: { maxFeePerGas: "0x64000000", maxPriorityFeePerGas: "0x100000" },
  fast: { maxFeePerGas: "0x64000000", maxPriorityFeePerGas: "0x100000" },
}
const PAYMASTER_FIELDS = {
  paymaster: PAYMASTER,
  paymasterData: "0x1234",
  paymasterVerificationGasLimit: "0x30000",
  paymasterPostOpGasLimit: "0x10000",
}
const OP_GAS = {
  callGasLimit: "0x30000",
  verificationGasLimit: "0x40000",
  preVerificationGas: "0x20000",
  paymasterVerificationGasLimit: "0x30000",
  paymasterPostOpGasLimit: "0x10000",
}

function userOpReceipt(sender: string, success: boolean, reason?: string) {
  return {
    userOpHash: USER_OP_HASH,
    entryPoint: ENTRY_POINT,
    sender,
    nonce: "0x0",
    paymaster: PAYMASTER,
    actualGasUsed: "0x15000",
    actualGasCost: "0x9c0000",
    success,
    ...(reason === undefined ? {} : { reason }),
    logs: [],
    receipt: {
      transactionHash: BUNDLE_TX,
      transactionIndex: "0x0",
      blockHash: `0x${"7c".repeat(32)}`,
      blockNumber: "0x64",
      from: "0x8888888888888888888888888888888888888888",
      to: ENTRY_POINT,
      cumulativeGasUsed: "0x15000",
      gasUsed: "0x15000",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      effectiveGasPrice: "0x64000000",
      type: "0x2",
    },
  }
}

async function start(script: SponsorScript, chain: { code: string; txCount: string }): Promise<{
  sponsorUrl: string
  rpcUrl: string
  sent: Record<string, unknown>[]
  close(): Promise<void>
}> {
  const sent: Record<string, unknown>[] = []
  const sponsor = await rpcServer({
    pimlico_getUserOperationGasPrice: () => script.gasPrice ?? DEFAULT_GAS_PRICE,
    pm_getPaymasterStubData: () => script.stubData ?? { ...PAYMASTER_FIELDS, isFinal: false },
    pm_getPaymasterData: () => script.paymasterData ?? PAYMASTER_FIELDS,
    eth_estimateUserOperationGas: () => script.estimateGas ?? OP_GAS,
    eth_supportedEntryPoints: () => [ENTRY_POINT],
    eth_chainId: () => "0x279f",
    eth_sendUserOperation: (params) => {
      sent.push(params[0] as Record<string, unknown>)
      if (script.sendHang === true) return new Promise(() => {})
      if (script.sendError !== undefined) {
        const error = new Error(script.sendError.message) as Error & { code: number }
        error.code = script.sendError.code
        throw error
      }
      return script.sendResult ?? USER_OP_HASH
    },
    eth_getUserOperationReceipt: () => script.receipt ?? null,
    eth_getUserOperationByHash: () => script.byHash ?? null,
  })
  const chainRpc = await rpcServer({
    eth_chainId: () => "0x279f",
    eth_getCode: () => chain.code,
    eth_getTransactionCount: () => chain.txCount,
    // EntryPoint.getNonce(sender, key) — the account's user-op nonce, zero on a fresh address.
    eth_call: () => `0x${"0".repeat(64)}`,
    eth_blockNumber: () => "0x1",
  })
  return {
    sponsorUrl: sponsor.url,
    rpcUrl: chainRpc.url,
    sent,
    close: async () => {
      await sponsor.close()
      await chainRpc.close()
    },
  }
}

const account = privateKeyToAccount(generatePrivateKey())

const call = {
  address: deployment.capabilityRegistry,
  abi: capabilityRegistryAbi,
  functionName: "registerP256Key",
  args: [1n, 2n],
} as const

describe("createSponsoredSender", () => {
  it("sends one sponsored operation whose sender IS the user's address", async () => {
    const env = await start(
      {
        receipt: userOpReceipt(account.address, true),
        byHash: {
          userOperation: { sender: account.address, ...OP_GAS },
          entryPoint: ENTRY_POINT,
          blockNumber: "0x64",
          blockHash: `0x${"7c".repeat(32)}`,
          transactionHash: BUNDLE_TX,
        },
      },
      { code: "0x", txCount: "0x0" },
    )
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      const receipt = await sender.send(call, "owner.key")
      expect(env.sent).toHaveLength(1)
      const op = env.sent[0]!
      // The whole point of 7702+4337: the payer changed, the sender did not.
      expect(op.sender).toBe(account.address)
      // First op on a fresh address: the signed authorization rides inside the operation.
      const auth = op.eip7702Auth as Record<string, unknown> | undefined
      expect(auth).toBeDefined()
      expect((auth!.address as string).toLowerCase()).toBe(IMPL.toLowerCase())
      expect(receipt.userOpHash).toBe(USER_OP_HASH)
      expect(receipt.transactionHash).toBe(BUNDLE_TX)
      // gasLimit = the sum of the operation's gas fields: what Monad billed the sponsor.
      expect(receipt.gasLimit).toBe(0x30000n + 0x40000n + 0x20000n + 0x30000n + 0x10000n)
    } finally {
      await env.close()
    }
  })

  it("an already-delegated address sends no authorization", async () => {
    const delegated = `0xef0100${IMPL.slice(2)}`
    const env = await start({ receipt: userOpReceipt(account.address, true), byHash: { userOperation: OP_GAS } }, { code: delegated, txCount: "0x3" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      await sender.send(call, "owner.key")
      expect(env.sent[0]!.sender).toBe(account.address)
      expect(env.sent[0]!.eip7702Auth).toBeUndefined()
    } finally {
      await env.close()
    }
  })

  it("a sponsor refusal becomes SponsorDidNotPay", async () => {
    const env = await start({ sendError: { code: -32000, message: "refused: this endpoint only pays for calls to the Mida contracts" } }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(SponsorDidNotPay)
      expect((error as MidaError).code).toBe("SPONSOR_FAILED")
    } finally {
      await env.close()
    }
  })

  it("a sponsor that never answers becomes SponsorDidNotPay after the deadline", async () => {
    const env = await start({ sendHang: true }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, timeoutMs: 300 })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(SponsorDidNotPay)
      expect((error as Error).message).toContain("did not answer")
    } finally {
      await env.close()
    }
  })

  it("a reverted operation is an error, not SponsorDidNotPay — the sponsor did pay", async () => {
    const env = await start({ receipt: userOpReceipt(account.address, false, "execution reverted") }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(MidaError)
      expect(error).not.toBeInstanceOf(SponsorDidNotPay)
      expect((error as MidaError).code).toBe("CAPABILITY_DENIED")
    } finally {
      await env.close()
    }
  })

  it("a reverted operation carrying contract error data maps through the revert table", async () => {
    // The revert data is ABI-encoded from the real ABI — the fixture cannot drift from it.
    const reason = encodeErrorResult({ abi: contextRegistryAbi, errorName: "ContextNotFound", args: [`0x${"11".repeat(32)}`] })
    const env = await start({ receipt: userOpReceipt(account.address, false, reason) }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).not.toBeInstanceOf(SponsorDidNotPay)
      expect((error as MidaError).code).toBe("NOT_FOUND")
    } finally {
      await env.close()
    }
  })
})
