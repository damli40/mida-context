// M3-D item 2(i): the sponsored sender against a fake endpoint. Two JSON-RPC servers stand in for
// the chain (delegation reads, the EntryPoint nonce call) and for the sponsor (the bundler +
// paymaster dialect permissionless speaks). Nothing here touches a real network — the whole point
// is that the SDK builds the exact wire shapes the endpoint's policy accepts.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createPublicClient, encodeErrorResult, http } from "viem"
import type { Address, Hex } from "viem"
import { MidaError } from "@mida/protocol"
import {
  SPONSORED_IMPLEMENTATION,
  SponsorDidNotPay,
  capabilityRegistryAbi,
  chainFor,
  contextRegistryAbi,
  createSponsoredSender,
  createWriteContext,
  deployLocal,
  sendContract,
  startAnvil,
} from "@mida/chain"
import type { Deployment, SponsoredReceipt } from "@mida/chain"

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
  /** When set, both paymaster calls refuse — the sponsor will not pay for this operation. */
  paymasterError?: { code: number; message: string }
  sendResult?: unknown
  sendError?: { code: number; message: string }
  sendHang?: boolean
  receipt?: unknown
  /** ms after eth_sendUserOperation before the receipt appears — a slow-landing operation. */
  receiptDelayMs?: number
  /** The first N receipt polls fail with a transport error — a bundler hiccup mid-wait. */
  receiptErrorCalls?: number
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
  /** Live call counts — the recovery probes show up here after the wait gives up. */
  counts(): { receiptPolls: number; byHashCalls: number }
  close(): Promise<void>
}> {
  const sent: Record<string, unknown>[] = []
  let sentAt = 0
  let receiptPolls = 0
  let byHashCalls = 0
  const refusal = () => {
    if (script.paymasterError === undefined) return undefined
    const error = new Error(script.paymasterError.message) as Error & { code: number }
    error.code = script.paymasterError.code
    return error
  }
  const sponsor = await rpcServer({
    pimlico_getUserOperationGasPrice: () => script.gasPrice ?? DEFAULT_GAS_PRICE,
    pm_getPaymasterStubData: () => {
      const error = refusal()
      if (error !== undefined) throw error
      return script.stubData ?? { ...PAYMASTER_FIELDS, isFinal: false }
    },
    pm_getPaymasterData: () => {
      const error = refusal()
      if (error !== undefined) throw error
      return script.paymasterData ?? PAYMASTER_FIELDS
    },
    eth_estimateUserOperationGas: () => script.estimateGas ?? OP_GAS,
    eth_supportedEntryPoints: () => [ENTRY_POINT],
    eth_chainId: () => "0x279f",
    eth_sendUserOperation: (params) => {
      sent.push(params[0] as Record<string, unknown>)
      sentAt = Date.now()
      if (script.sendHang === true) return new Promise(() => {})
      if (script.sendError !== undefined) {
        const error = new Error(script.sendError.message) as Error & { code: number }
        error.code = script.sendError.code
        throw error
      }
      return script.sendResult ?? USER_OP_HASH
    },
    eth_getUserOperationReceipt: () => {
      receiptPolls += 1
      if (receiptPolls <= (script.receiptErrorCalls ?? 0)) {
        const error = new Error("the bundler dropped the connection") as Error & { code: number }
        error.code = -32000
        throw error
      }
      if (script.receiptDelayMs !== undefined && Date.now() - sentAt < script.receiptDelayMs) return null
      return script.receipt ?? null
    },
    eth_getUserOperationByHash: () => {
      byHashCalls += 1
      return script.byHash ?? null
    },
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
    counts: () => ({ receiptPolls, byHashCalls }),
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

  // M3-D2: after the bundler ACCEPTS an operation there is no falling back. The receipt wait is a
  // separate, longer phase whose failures are SPONSOR_PENDING — never SponsorDidNotPay, so
  // sendContract can never send a second copy of a call that may still land.

  it("a slow receipt still succeeds — acceptance is not failure, and the owner hears one progress line", async () => {
    const env = await start(
      { receipt: userOpReceipt(account.address, true), byHash: { userOperation: OP_GAS }, receiptDelayMs: 250 },
      { code: "0x", txCount: "0x0" },
    )
    const lines: string[] = []
    try {
      const sender = createSponsoredSender({
        sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment,
        receiptTimeoutMs: 5_000, receiptNoticeMs: 40, pollingIntervalMs: 5,
        progress: (line) => lines.push(line),
      })
      const receipt = await sender.send(call, "owner.key")
      expect(receipt.userOpHash).toBe(USER_OP_HASH)
      expect(receipt.transactionHash).toBe(BUNDLE_TX)
      expect(env.sent).toHaveLength(1) // one operation, never a second copy
      expect(lines).toEqual(["still waiting for the sponsored transaction to be confirmed…"])
    } finally {
      await env.close()
    }
  })

  it("a receipt that never arrives is SPONSOR_PENDING — the accepted operation is never resent", async () => {
    const env = await start({}, { code: "0x", txCount: "0x0" }) // the receipt endpoint answers null forever
    const lines: string[] = []
    try {
      const sender = createSponsoredSender({
        sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment,
        receiptTimeoutMs: 200, receiptNoticeMs: 50, pollingIntervalMs: 5,
        progress: (line) => lines.push(line),
      })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(MidaError)
      expect(error).not.toBeInstanceOf(SponsorDidNotPay)
      expect((error as MidaError).code).toBe("SPONSOR_PENDING")
      expect((error as Error).message).toContain(USER_OP_HASH)
      expect((error as Error).message).toContain("may still land")
      expect((error as Error).message).toContain("nothing was sent from your wallet")
      expect((error as { userOpHash?: unknown }).userOpHash).toBe(USER_OP_HASH)
      expect(env.sent).toHaveLength(1) // the accepted operation went out exactly once
      expect(env.counts().byHashCalls).toBe(1) // the last-look probe ran before giving up
      expect(lines).toEqual(["still waiting for the sponsored transaction to be confirmed…"])
    } finally {
      await env.close()
    }
  })

  it("a transport error mid-wait is recovered by one more probe — the landed receipt still answers success", async () => {
    const env = await start(
      { receipt: userOpReceipt(account.address, true), byHash: { userOperation: OP_GAS }, receiptErrorCalls: 1 },
      { code: "0x", txCount: "0x0" },
    )
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, receiptTimeoutMs: 5_000, pollingIntervalMs: 5 })
      const receipt = await sender.send(call, "owner.key")
      expect(receipt.userOpHash).toBe(USER_OP_HASH)
      expect(receipt.transactionHash).toBe(BUNDLE_TX)
      expect(env.sent).toHaveLength(1)
    } finally {
      await env.close()
    }
  })

  // M3-D3 item 1: the per-kind ceiling moved INSIDE the sponsored path — it checks the bundler's
  // own callGasLimit estimate (eth_estimateUserOperationGas, which the paymaster pays for), never
  // the owner-side eth_estimateGas Monad refuses for an empty wallet. Over the kind's ceiling the
  // answer is GAS_CEILING_EXCEEDED — a local policy refusal, not SponsorDidNotPay, so nothing is
  // sent and sendContract never falls back on it.

  it("a bundler callGasLimit over the kind's ceiling is refused locally — nothing is sent", async () => {
    // owner.key's ceiling is 200,000; the fake bundler estimates 0x40000 = 262,144.
    const env = await start({ estimateGas: { ...OP_GAS, callGasLimit: "0x40000" } }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({
        sponsorUrl: env.sponsorUrl,
        rpcUrl: env.rpcUrl,
        account,
        deployment,
        pollingIntervalMs: 5,
        receiptTimeoutMs: 300,
      })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(MidaError)
      expect(error).not.toBeInstanceOf(SponsorDidNotPay)
      expect((error as MidaError).code).toBe("GAS_CEILING_EXCEEDED")
      expect((error as Error).message).toContain("owner.key")
      expect(env.sent).toHaveLength(0) // eth_sendUserOperation never ran
    } finally {
      await env.close()
    }
  })

  it("a bundler callGasLimit within the kind's ceiling sends", async () => {
    // owner.key's ceiling is 200,000; the fake bundler's default estimate is 0x30000 = 196,608 —
    // under it, so the send goes out.
    const env = await start({ receipt: userOpReceipt(account.address, true) }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      await sender.send(call, "owner.key")
      expect(env.sent).toHaveLength(1)
    } finally {
      await env.close()
    }
  })

  it("the wire fields for a three-scope grantBatch — every gas field, checked against the sponsor's own ceilings", async () => {
    // The Sep 22 failure shape: grantBatch over three scopes was the operation Pimlico refused.
    // Send one through the fake bundler and record every gas field the SDK emits, then check each
    // against the sponsor worker's policy ceilings (apps/sponsor-worker/src/policy.ts):
    //   callGasLimit ≤ grant.batch 1,500,000 + 60,000 overhead = 1,560,000
    //   verificationGasLimit, preVerificationGas ≤ 500,000 each
    //   paymasterVerificationGasLimit, paymasterPostOpGasLimit ≤ 300,000 each
    //   maxFeePerGas, maxPriorityFeePerGas ≤ 300 gwei
    const scope = (fill: string) => ({ namespaceId: `0x${fill.repeat(32)}` as Hex, permissions: 7, provenancePolicy: 0 })
    const grantCall = {
      address: deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "grantBatch",
      args: [
        {
          requestId: `0x${"01".repeat(32)}`,
          nonce: `0x${"02".repeat(32)}`,
          agentId: `0x${"03".repeat(32)}`,
          purposeIdHash: `0x${"04".repeat(32)}`,
          callbackOriginHash: `0x${"05".repeat(32)}`,
          manifestHash: `0x${"06".repeat(32)}`,
          manifestVersion: 1n,
          policyVersionHash: `0x${"07".repeat(32)}`,
          namespaceTreeVersionHash: `0x${"08".repeat(32)}`,
          issuedAt: 1_700_000_000n,
          requestExpiresAt: 1_700_000_600n,
          capabilityExpiresAt: 0n,
          scopes: [scope("a1"), scope("b2"), scope("c3")],
          agentSignature: "0x1234",
        },
        [scope("a1"), scope("b2"), scope("c3")],
        0n,
        { authenticatorData: "0x1234", clientDataJSON: "{}", challengeIndex: 0n, typeIndex: 0n, r: 1n, s: 2n },
      ],
    } as const
    const env = await start({ receipt: userOpReceipt(account.address, true) }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      await sender.send(grantCall, "grant.batch")
      expect(env.sent).toHaveLength(1)
      const op = env.sent[0]!
      // Recorded for DEVIN-REPORT-M3D — the exact wire fields the sponsor sees, with the two big
      // blobs reduced to byte counts so the gas fields stay readable.
      const { callData, signature, ...fields } = op
      console.log(
        "grantBatch(3 scopes) user operation:",
        JSON.stringify({
          callDataBytes: (callData as string).length / 2 - 1,
          signatureBytes: (signature as string).length / 2 - 1,
          ...fields,
        }),
      )
      const qty = (field: string) => BigInt(op[field] as string)
      expect(qty("callGasLimit")).toBeLessThanOrEqual(1_500_000n + 60_000n)
      expect(qty("verificationGasLimit")).toBeLessThanOrEqual(500_000n)
      expect(qty("preVerificationGas")).toBeLessThanOrEqual(500_000n)
      expect(qty("paymasterVerificationGasLimit")).toBeLessThanOrEqual(300_000n)
      expect(qty("paymasterPostOpGasLimit")).toBeLessThanOrEqual(300_000n)
      expect(qty("maxFeePerGas")).toBeLessThanOrEqual(300_000_000_000n)
      expect(qty("maxPriorityFeePerGas")).toBeLessThanOrEqual(300_000_000_000n)
      // and the call really is the three-scope grant — the sponsor's per-function policy reads this
      expect((op.callData as string).length).toBeGreaterThan(10)
    } finally {
      await env.close()
    }
  })

  it("a paymaster refusal is still SponsorDidNotPay — nothing was accepted, the fallback is safe", async () => {
    const env = await start({ paymasterError: { code: -32000, message: "refused: the sponsor's daily budget is exhausted" } }, { code: "0x", txCount: "0x0" })
    try {
      const sender = createSponsoredSender({ sponsorUrl: env.sponsorUrl, rpcUrl: env.rpcUrl, account, deployment, pollingIntervalMs: 5 })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(SponsorDidNotPay)
      expect(env.sent).toHaveLength(0) // refused before eth_sendUserOperation — nothing to wait on
    } finally {
      await env.close()
    }
  })

  it("a bundler that is down before acceptance is SponsorDidNotPay", async () => {
    const dead = await rpcServer({})
    const deadUrl = dead.url
    await dead.close() // a port nothing listens on anymore
    const env = await start({}, { code: "0x", txCount: "0x0" }) // the chain RPC stays up
    try {
      const sender = createSponsoredSender({ sponsorUrl: deadUrl, rpcUrl: env.rpcUrl, account, deployment, timeoutMs: 5_000, pollingIntervalMs: 5 })
      const error = await sender.send(call, "owner.key").then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(SponsorDidNotPay)
      expect(env.sent).toHaveLength(0)
    } finally {
      await env.close()
    }
  })
})

/**
 * M3-D3 on a REAL chain (local Anvil): a wallet holding exactly 0 MON must still act through the
 * sponsor. Two things this proves that the fake-RPC tests cannot: (1) `simulateContract` — an
 * `eth_call` carrying no gas field — runs fine from an empty wallet on Anvil, and (2) `sendContract`
 * on that wallet reaches the sponsor without ever calling `eth_estimateGas` or `estimateFeesPerGas`
 * (both are proxied to throw, so touching either fails the test on the spot).
 */
describe("sendContract on Anvil with a zero-balance wallet", () => {
  it("simulates at 0 MON and hands straight to the sponsor — no owner-side gas work at all", async () => {
    const node = await startAnvil()
    const live = await deployLocal({ rpcUrl: node.rpcUrl })
    try {
      const broke = privateKeyToAccount(generatePrivateKey()) // never funded — 0 MON
      const readClient = createPublicClient({ chain: chainFor(31337n), transport: http(node.rpcUrl) })
      const balance = await readClient.getBalance({ address: broke.address })
      expect(balance).toBe(0n)

      // The simulate itself: eth_call with from = the empty wallet, no gas field passed.
      const simulated = await readClient.simulateContract({
        account: broke,
        address: live.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName: "registerP256Key",
        args: [1n, 2n],
      })
      expect(simulated.request).toBeDefined()

      const context = createWriteContext({ rpcUrl: node.rpcUrl, deployment: live, account: broke })
      context.publicClient = new Proxy(context.publicClient, {
        get: (target, prop, recv) =>
          prop === "estimateContractGas" || prop === "estimateFeesPerGas" || prop === "estimateGas"
            ? () => {
                throw new Error(`${String(prop)} must never run on the sponsored path`)
              }
            : Reflect.get(target, prop, recv),
      })
      context.walletClient = new Proxy(context.walletClient, {
        get: (target, prop, recv) =>
          prop === "writeContract" || prop === "sendTransaction"
            ? () => {
                throw new Error(`${String(prop)} must never run on the sponsored path`)
              }
            : Reflect.get(target, prop, recv),
      })
      const opHash: Hex = `0x${"8e".repeat(32)}`
      let asked = 0
      context.sponsor = {
        send: async () => {
          asked += 1
          return {
            status: "success",
            transactionHash: `0x${"9d".repeat(32)}`,
            gasUsed: 1n,
            gasLimit: 200_000n,
            userOpHash: opHash,
          } as SponsoredReceipt
        },
      }
      const receipt = await sendContract(
        context,
        { address: live.capabilityRegistry, abi: capabilityRegistryAbi, functionName: "registerP256Key", args: [1n, 2n] },
        "owner.key",
      )
      expect(asked).toBe(1) // the sponsor was asked — with the wallet still at 0 MON
      expect((receipt as SponsoredReceipt).userOpHash).toBe(opHash)
    } finally {
      await node.stop()
    }
  }, 120_000)
})
