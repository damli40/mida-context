import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Address, Hex } from "@mida/protocol"
import {
  ANVIL_PRIVATE_KEYS,
  MONAD_TESTNET_CHAIN_ID,
  chainFor,
  createWriteContext,
  deployLocal,
  fundLocal,
  loadDeployment,
  sendValue,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalWriteContext } from "@mida/chain"
import { Batcher, FsBatchJournal, FsBatchStore, RegistryReader, createBatcherChain, createContextApi, createNodeTimer } from "@mida/api"
import type { BatchingOptions } from "@mida/api"
import { serve } from "@hono/node-server"
import { createPublicClient, http } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"

/** One network the §16 scenario can run against. Every actor is generated fresh per run and funded through `fund`. */
export interface ScenarioEnvironment {
  name: string
  rpcUrl: string
  deployment: Deployment
  apiBaseUrl: string
  fund(address: Address): Promise<void>
  writeContext(account: LocalAccount): LocalWriteContext
  stop(): Promise<void>
}

/**
 * Runs the Context API as a real HTTP server on a free localhost port. When the deployment carries
 * a BatchAnchor the batch lane comes up with it — a real Batcher over the file store, its journal a
 * JSON file beside `batch/`, `recover()` awaited before the port opens. `batching` tunes the wait
 * window and caps for tests; `submitter` overrides the account that pays for submitBatch (defaults
 * to the funded Anvil deployer key — local runs only).
 */
export async function startApiServer(input: {
  rpcUrl: string
  deployment: Deployment
  batching?: { cap?: number; waitMs?: number; minGapMs?: number; submitter?: LocalAccount }
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const publicClient = createPublicClient({ chain: chainFor(input.deployment.chainId), transport: http(input.rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment: input.deployment })
  const dataDir = mkdtempSync(join(tmpdir(), "mida-api-"))
  let batching: BatchingOptions | undefined
  if (input.deployment.batchAnchor !== undefined) {
    const store = new FsBatchStore(dataDir)
    const submitter = input.batching?.submitter ?? privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]!)
    const batcher = new Batcher({
      store,
      chain: createBatcherChain({ rpcUrl: input.rpcUrl, deployment: input.deployment, account: submitter }),
      timer: createNodeTimer(() => {
        void batcher.run().catch((error) => console.log(JSON.stringify({ component: "batcher", event: "timer-run-failed", error: String(error) })))
      }),
      now: () => Date.now(),
      cap: input.batching?.cap ?? 60,
      waitMs: input.batching?.waitMs ?? 2_000,
      minGapMs: input.batching?.minGapMs ?? 1_000,
      submitter: submitter.address,
      journal: new FsBatchJournal(join(dataDir, "batch-journal.json")),
      log: (record) => console.log(JSON.stringify({ component: "batcher", ...record })),
    })
    await batcher.recover()
    batching = {
      enabled: true,
      batchAnchor: input.deployment.batchAnchor,
      store,
      receiptAccount: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!),
      notify: () => {
        void batcher.notify().catch((error) => console.log(JSON.stringify({ component: "batcher", event: "notify-failed", error: String(error) })))
      },
      flush: () => batcher.flush(),
    }
  }
  const { app } = createContextApi({ reader, deployment: input.deployment, dataDir, ...(batching === undefined ? {} : { batching }) })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** Fresh Anvil, Deploy.s.sol, and an in-process API server. hardfork "prague" forces the Solidity P256 fallback. */
export async function localEnvironment(options: { hardfork?: string } = {}): Promise<ScenarioEnvironment> {
  const node = await startAnvil(options)
  const deployment = await deployLocal({ rpcUrl: node.rpcUrl })
  const server = await startApiServer({ rpcUrl: node.rpcUrl, deployment })
  return {
    name: `local-${node.hardfork}`,
    rpcUrl: node.rpcUrl,
    deployment,
    apiBaseUrl: server.baseUrl,
    fund: (address) => fundLocal(node.rpcUrl, address),
    writeContext: (account) => createWriteContext({ rpcUrl: node.rpcUrl, deployment, account }),
    stop: async () => {
      await server.close()
      await node.stop()
    },
  }
}

export const DEFAULT_TESTNET_FUNDING_WEI = 200_000_000_000_000_000n

/**
 * Monad testnet (chain 10143). Needs contracts/deployments/10143.json from the Task 27 deploy and one funded
 * DEPLOYER_PRIVATE_KEY in .env; every other actor is generated and funded from it. The API still runs locally.
 */
export async function monadTestnetEnvironment(env: Record<string, string | undefined> = process.env): Promise<ScenarioEnvironment> {
  const key = env.DEPLOYER_PRIVATE_KEY
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("DEPLOYER_PRIVATE_KEY (a funded Monad testnet key) is required in .env for the testnet run")
  }
  const rpcUrl = env.MONAD_TESTNET_RPC ?? monadTestnet.rpcUrls.default.http[0]
  const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID)
  const funder = createWriteContext({ rpcUrl, deployment, account: privateKeyToAccount(key as Hex) })
  const chainId = await funder.publicClient.getChainId()
  if (BigInt(chainId) !== MONAD_TESTNET_CHAIN_ID) throw new Error(`RPC ${rpcUrl} is chain ${chainId}, not Monad testnet 10143`)
  const funding = BigInt(env.TESTNET_FUNDING_WEI ?? DEFAULT_TESTNET_FUNDING_WEI)
  const server = await startApiServer({ rpcUrl, deployment })
  return {
    name: "monad-testnet",
    rpcUrl,
    deployment,
    apiBaseUrl: server.baseUrl,
    fund: async (address) => {
      const receipt = await sendValue(funder, { to: address, value: funding }, "funding")
      // Monad's asynchronous execution budgets an EOA's inflight gas spend against state from k=3 blocks ago, and a
      // funder below the 10 MON reserve may transfer value only in an "emptying transaction" (no other send within k
      // blocks). Waiting past the lag lets the lagged state see the new balance and keeps consecutive funds eligible.
      const lag = 4n
      while ((await funder.publicClient.getBlockNumber()) < receipt.blockNumber + lag) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    },
    writeContext: (account) => createWriteContext({ rpcUrl, deployment, account }),
    stop: () => server.close(),
  }
}
