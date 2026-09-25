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
import { Batcher, DenyOverlay, FsBatchJournal, FsBatchStore, RegistryReader, createBatcherChain, createBatchDenyGate, createContextApi, createNodeTimer, fileStores } from "@mida/api"
import type { BatcherTimer, BatchingOptions } from "@mida/api"
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
  const stores = fileStores(dataDir)
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
      chain: createBatcherChain({ rpcUrl: input.rpcUrl, deployment: input.deployment, account: submitter }),
      // The send-time deny gate (in-3 I5): a second overlay over the SAME deny store the API
      // serves — FileDenyStore keeps its intents in memory, so two stores over one file would
      // not see each other's writes. What the routes stage is what the next tick holds.
      gate: createBatchDenyGate({ reader, overlay: new DenyOverlay(stores.denies) }),
      timer,
      now: () => Date.now(),
      // Hard bound 432 = floor(28,000,000 × 0.95 / 61,457) — the "batch.submit" ceiling at 95%
      // over the sweep's lowest measured gas per save, a ONE-OWNER figure. First-time-owner
      // saves run ~166k gas each on testnet (docs/evidence/batch-anchor-multi-owner-2026-09-24.json),
      // so mixed/new-owner batches rely on the learned budget and refusal shrink, not this bound.
      cap: input.batching?.cap ?? 432,
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
  const { app } = createContextApi({ reader, deployment: input.deployment, stores, ...(batching === undefined ? {} : { batching }) })
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
