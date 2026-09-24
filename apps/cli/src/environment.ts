import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Address, Hex } from "@mida/protocol"
import {
  ANVIL_PRIVATE_KEYS,
  MONAD_TESTNET_CHAIN_ID,
  batchAnchorAbi,
  chainFor,
  createWriteContext,
  deployLocal,
  fundLocal,
  getLogsChunked,
  loadDeployment,
  sendValue,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalWriteContext } from "@mida/chain"
import { Batcher, FsBatchJournal, FsBatchStore, RegistryReader, createBatcherChain, createContextApi, createNodeTimer } from "@mida/api"
import type { AnchoredLog, BatcherChain, BatcherTimer, BatchingOptions, RejectedLog } from "@mida/api"
import { serve } from "@hono/node-server"
import { createPublicClient, http } from "viem"
import type { AbiEvent, LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"

/** One network the §16 scenario can run against. Every actor is generated fresh per run and funded through `fund`. */
export interface ScenarioEnvironment {
  name: string
  rpcUrl: string
  deployment: Deployment
  apiBaseUrl: string
  /**
   * Test handle on the batcher's wait window — present only when the deployment carries a
   * BatchAnchor. `pauseTimer` holds queued saves QUEUED: the armed window is remembered, not
   * fired. `resumeTimer` schedules the last requested wakeup — an instant already past fires at
   * once. A store `flush()` still runs a submission immediately, so a paused timer is also how a
   * test proves the flush — not the window — anchored a save.
   */
  batcher?: { pauseTimer(): void; resumeTimer(): void }
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
}): Promise<{ baseUrl: string; close(): Promise<void>; batcher?: { pauseTimer(): void; resumeTimer(): void } }> {
  const publicClient = createPublicClient({ chain: chainFor(input.deployment.chainId), transport: http(input.rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment: input.deployment })
  const dataDir = mkdtempSync(join(tmpdir(), "mida-api-"))
  let batching: BatchingOptions | undefined
  let batcher: { pauseTimer(): void; resumeTimer(): void } | undefined
  if (input.deployment.batchAnchor !== undefined) {
    const store = new FsBatchStore(dataDir)
    const submitter = input.batching?.submitter ?? privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]!)
    // The pausable timer: while held, `set` only records the wakeup the batcher asked for and
    // `pending` still answers true, so the batcher never re-arms; `resumeTimer` schedules the
    // recorded instant — already past means the batcher runs at once. `clear` (flush's first
    // move) drops the record too, so a flush inside a pause is not re-run on resume.
    let held = false
    let heldAt: number | undefined
    const inner = createNodeTimer(() => {
      heldAt = undefined
      void engine.run().catch((error) => console.log(JSON.stringify({ component: "batcher", event: "timer-run-failed", error: String(error) })))
    })
    const timer: BatcherTimer = {
      set: (atMs) => {
        heldAt = atMs
        if (!held) inner.set(atMs)
      },
      clear: () => {
        heldAt = undefined
        inner.clear()
      },
      pending: () => heldAt !== undefined,
    }
    batcher = {
      pauseTimer: () => {
        held = true
        inner.clear()
      },
      resumeTimer: () => {
        held = false
        if (heldAt !== undefined) inner.set(heldAt)
      },
    }
    const engine = new Batcher({
      store,
      chain: freshHeadBatcherChain({ rpcUrl: input.rpcUrl, deployment: input.deployment, account: submitter }),
      timer,
      now: () => Date.now(),
      cap: input.batching?.cap ?? 60,
      waitMs: input.batching?.waitMs ?? 2_000,
      minGapMs: input.batching?.minGapMs ?? 1_000,
      submitter: submitter.address,
      journal: new FsBatchJournal(join(dataDir, "batch-journal.json")),
      log: (record) => console.log(JSON.stringify({ component: "batcher", ...record })),
    })
    await engine.recover()
    batching = {
      enabled: true,
      batchAnchor: input.deployment.batchAnchor,
      store,
      receiptAccount: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!),
      notify: () => {
        void engine.notify().catch((error) => console.log(JSON.stringify({ component: "batcher", event: "notify-failed", error: String(error) })))
      },
      flush: () => engine.flush(),
    }
  }
  const { app } = createContextApi({ reader, deployment: input.deployment, dataDir, ...(batching === undefined ? {} : { batching }) })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
        ...(batcher === undefined ? {} : { batcher }),
      })
    })
  })
}

/**
 * createBatcherChain's log scans end at `getBlockNumber()`, which viem answers from a per-client
 * cache for client.cacheTime ms — and the receipt wait inside submitBatch can leave a pre-mining
 * head in that cache. A resolve scan inheriting it misses the batch's own logs and reports a
 * false ROOT_MISMATCH, stranding the rows SUBMITTED. The local lane keeps the adapter's submit and
 * batchOf but re-runs the three scans with `toBlock` pinned to a head fetched with the cache off.
 */
function freshHeadBatcherChain(input: { rpcUrl: string; deployment: Deployment; account: LocalAccount }): BatcherChain {
  const { deployment } = input
  const batchAnchor = deployment.batchAnchor
  if (batchAnchor === undefined) throw new Error("this deployment has no BatchAnchor")
  const inner = createBatcherChain(input)
  const scanClient = createPublicClient({ chain: chainFor(deployment.chainId), transport: http(input.rpcUrl) })
  const saveAnchored = batchAnchorAbi.find((item) => item.type === "event" && item.name === "SaveAnchored") as AbiEvent
  const saveRejected = batchAnchorAbi.find((item) => item.type === "event" && item.name === "SaveRejected") as AbiEvent
  const fromBlock = deployment.batchAnchorBlock ?? deployment.deploymentBlock
  const head = () => scanClient.getBlockNumber({ cacheTime: 0 })
  return {
    submit: inner.submit,
    batchOf: inner.batchOf,
    async anchoredLogs(batchId): Promise<AnchoredLog[]> {
      const logs = await getLogsChunked(scanClient, { address: batchAnchor, event: saveAnchored, args: { batchId }, fromBlock, toBlock: await head() })
      return logs.map((log) => {
        const args = log.args as { contextId: Hex; author: Hex; position: number; lineageId: Hex; version: number; leafHash: Hex }
        return {
          contextId: args.contextId.toLowerCase() as Hex,
          agentId: args.author.toLowerCase() as Hex,
          position: Number(args.position),
          lineageId: args.lineageId.toLowerCase() as Hex,
          version: Number(args.version),
          leafHash: args.leafHash.toLowerCase() as Hex,
        }
      })
    },
    async rejectedLogs(batchId): Promise<RejectedLog[]> {
      const logs = await getLogsChunked(scanClient, { address: batchAnchor, event: saveRejected, args: { batchId }, fromBlock, toBlock: await head() })
      return logs.map((log) => {
        const args = log.args as { index: number; reason: number }
        return { index: Number(args.index), reason: Number(args.reason) }
      })
    },
    async findAnchoring(contextId): Promise<Hex | null> {
      const logs = await getLogsChunked(scanClient, { address: batchAnchor, event: saveAnchored, args: { contextId }, fromBlock, toBlock: await head() })
      const first = logs[0]
      if (first === undefined) return null
      return ((first.args as { batchId: Hex }).batchId).toLowerCase() as Hex
    },
  }
}

/** Fresh Anvil, Deploy.s.sol, and an in-process API server. hardfork "prague" forces the Solidity P256 fallback. `batching` tunes the batch lane's wait window and caps for tests. */
export async function localEnvironment(options: {
  hardfork?: string
  batching?: { cap?: number; waitMs?: number; minGapMs?: number; submitter?: LocalAccount }
} = {}): Promise<ScenarioEnvironment> {
  const node = await startAnvil(options)
  const deployment = await deployLocal({ rpcUrl: node.rpcUrl })
  const server = await startApiServer({ rpcUrl: node.rpcUrl, deployment, ...(options.batching === undefined ? {} : { batching: options.batching }) })
  return {
    name: `local-${node.hardfork}`,
    rpcUrl: node.rpcUrl,
    deployment,
    apiBaseUrl: server.baseUrl,
    ...(server.batcher === undefined ? {} : { batcher: server.batcher }),
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
