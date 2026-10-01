// in-3 (I5): a batched save queued BEFORE a revoke must not anchor while that revoke is pending
// on Monad. The store's deny list is the only thing that knows the revoke is coming — the
// contract cannot see it — so the batcher itself must consult it: a row whose author sits on the
// active deny list is HELD instead of sent, and every tick re-checks held rows — deny still
// active → keep holding; the revoke landed → REJECTED NO_AUTHORITY; the deny cleared and the
// grant still valid → send.
//
// These runs drive a real Batcher over a real Anvil deployment with a manual timer and a
// submittable-hangable chain adapter, so every step is provable: QUEUED → HELD across repeated
// ticks and across a crash/restart/replay, HELD → REJECTED when the revoke lands, HELD →
// ANCHORED when the deny is cancelled, and an unrelated agent's save submits the whole time.
//
// Fail-first seam: `createBatchDenyGate` does not exist on the unfixed code — the `?.` below then
// builds no gate and the batcher runs exactly as it did before in-3, which is what makes every
// "HELD" assertion come back ANCHORED instead of merely failing to compile.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { serve } from "@hono/node-server"
import { ANVIL_PRIVATE_KEYS, chainFor, deployLocal, fundLocal, startAnvil } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { Batcher, FsBatchJournal, FsBatchStore, RegistryReader, createBatcherChain, createContextApi } from "@mida/api"
import type { BatcherChain, BatcherTimer } from "@mida/api"
import type { Address, Hex } from "@mida/protocol"
import { MidaHome, NAMESPACE, Runtime, approve, init, loadAgentIdentity, readCheckpoints, requestAccess, revoke, runCli, saveCheckpoint } from "@mida/midad"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const AGENTS = ["claude-code", "codex"] as const
const T = 180_000

const env = (projectId: string, eventId: string, sessionId = "s1") => ({
  projectId,
  sessionId,
  continuesSession: null,
  compiledBy: "test",
  checkpoint: sampleCheckpoint({ eventId }),
})

const codeOf = (error: unknown): string => (error as { code?: string })?.code ?? String(error)

describe("in-3 I5 — the batcher holds a queued save whose author is under a pending revoke", () => {
  let stopAnvil: () => Promise<void>
  let closeServer: () => Promise<void>
  let network: Network
  let deployment: Deployment
  let store: FsBatchStore
  let engine: Batcher
  let makeEngine: () => Batcher
  let hang = false

  beforeAll(async () => {
    const node = await startAnvil()
    stopAnvil = node.stop
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    const publicClient = createPublicClient({ chain: chainFor(deployment.chainId), transport: http(node.rpcUrl) })
    const reader = new RegistryReader({ publicClient, deployment })
    const dataDir = mkdtempSync(join(tmpdir(), "mida-in3-i5-api-"))
    store = new FsBatchStore(dataDir)
    const journalFile = join(dataDir, "batch-journal.json")
    const submitter = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]!)
    const real = createBatcherChain({ rpcUrl: node.rpcUrl, deployment, account: submitter })
    const chain: BatcherChain = {
      ...real,
      // hang = the process died after journaling + marking rows SUBMITTED, before the tx went out
      submit: (batchId, saves) => (hang ? new Promise(() => {}) : real.submit(batchId, saves)),
    }
    const timer: BatcherTimer = { set: () => {}, clear: () => {}, pending: () => false }
    const { app, overlay } = createContextApi({
      reader,
      deployment,
      dataDir,
      batching: {
        enabled: true,
        batchAnchor: deployment.batchAnchor!,
        store,
        receiptAccount: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!),
        notify: () => {},
        flush: () => engine.flush(),
      },
    })
    // The deny overlay the API itself serves — the gate shares it, so a deny staged through
    // POST /revocations is exactly what the batcher's hold check sees.
    const gateFactory = (await import("@mida/api")).createBatchDenyGate
    const gate = gateFactory?.({ reader, overlay })
    makeEngine = () =>
      new Batcher({
        store,
        chain,
        timer,
        now: () => Date.now(),
        cap: 432,
        waitMs: 200,
        minGapMs: 0,
        submitter: submitter.address,
        journal: new FsBatchJournal(journalFile),
        ...(gate === undefined ? {} : { gate }),
        log: (record) => console.log(JSON.stringify({ component: "i5-batcher", ...record })),
      })
    engine = makeEngine()
    await engine.recover()
    const baseUrl = await new Promise<string>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        closeServer = () => new Promise((done) => server.close(() => done()))
        resolve(`http://127.0.0.1:${info.port}`)
      })
    })
    network = { rpcUrl: node.rpcUrl, deployment, fund: (a: Address) => fundLocal(node.rpcUrl, a), storageUrl: baseUrl }
  }, 600_000)

  afterAll(async () => {
    await closeServer?.()
    await stopAnvil?.()
  })

  const newHome = async (batchingOn: boolean) => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-in3-i5-")))
    const runtime = await Runtime.open(home, network)
    await init(runtime, AGENTS)
    for (const name of AGENTS) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }
    if (batchingOn) {
      const code = await runCli(["batching", "on"], {
        home,
        network,
        print: () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        prompt: async () => "yes",
        drainInput: () => {},
        kickDaemon: () => {},
      })
      expect(code).toBe(0)
    }
    const agentId = loadAgentIdentity(home, "claude-code")!.agentId
    return { home, runtime, agentId }
  }

  /** The "revoke pending on Monad" state: the owner's deny is staged at the store, the chain tx has not landed. */
  const stageDenyOnly = (runtime: Runtime, agentId: Hex) => runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })

  const rowState = async (contextId: Hex) => {
    const row = await store.get(contextId)
    return row === null ? null : { state: row.state, reason: row.reason }
  }

  it("a save queued before the deny is held while pending, then rejected NO_AUTHORITY once the revoke lands", async () => {
    const { runtime, agentId } = await newHome(true)
    try {
      const saved = await saveCheckpoint(runtime, "claude-code", env("proj-hold", "cp-i5-A-0001"))
      expect(saved.batched?.state).toBe("QUEUED")

      await stageDenyOnly(runtime, agentId)
      // The batcher ticks — the denied save is held, not sent, and stays held on every later tick.
      await engine.run()
      expect((await rowState(saved.contextId))?.state).toBe("HELD")
      await engine.run()
      expect((await rowState(saved.contextId))?.state).toBe("HELD")

      // The revoke lands: the next tick finds the deny anchored and no authority left — the row
      // dies as REJECTED NO_AUTHORITY, the same reason the contract would have given.
      await revoke(runtime, "claude-code")
      await engine.run()
      expect(await rowState(saved.contextId)).toEqual({ state: "REJECTED", reason: "NO_AUTHORITY" })

      const read = await readCheckpoints(runtime, "codex", "proj-hold")
      expect(read.checkpoints).toHaveLength(0)
    } finally {
      await runtime.close()
    }
  }, T)

  it("a crash mid-submit followed by restart + replay keeps the row held while the deny is pending", async () => {
    const { runtime, agentId } = await newHome(true)
    try {
      const saved = await saveCheckpoint(runtime, "claude-code", env("proj-replay", "cp-i5-C2-0001"))
      hang = true
      void engine.run() // journals, marks SUBMITTED, then hangs in submit — the "crash"
      for (let i = 0; i < 50 && (await rowState(saved.contextId))?.state !== "SUBMITTED"; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect((await rowState(saved.contextId))?.state).toBe("SUBMITTED")

      await stageDenyOnly(runtime, agentId)
      hang = false
      engine = makeEngine() // restart over the same store + journal
      await engine.recover() // the journaled batch never landed — its rows go back to QUEUED
      await engine.run()
      expect((await rowState(saved.contextId))?.state).toBe("HELD")

      // A second restart while the revoke is still pending replays to the same answer: held.
      engine = makeEngine()
      await engine.recover()
      await engine.run()
      expect((await rowState(saved.contextId))?.state).toBe("HELD")

      await revoke(runtime, "claude-code")
      await engine.run()
      expect(await rowState(saved.contextId)).toEqual({ state: "REJECTED", reason: "NO_AUTHORITY" })
    } finally {
      hang = false
      await runtime.close()
    }
  }, T)

  it("a held row is sent and anchored once the deny is cancelled and the grant is still valid", async () => {
    const { runtime, agentId } = await newHome(true)
    try {
      const saved = await saveCheckpoint(runtime, "claude-code", env("proj-release", "cp-i5-R-0001"))
      expect(saved.batched?.state).toBe("QUEUED")

      const { intentId } = await stageDenyOnly(runtime, agentId)
      await engine.run()
      expect((await rowState(saved.contextId))?.state).toBe("HELD")

      // The owner cancels the staged deny (the same P256-approved cancel `mida approve` runs for a
      // stale deny): the next tick releases the row and the batcher anchors it normally.
      const reissued = await runtime.ownerApi.reissueRevocationNonce(intentId)
      const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + 300n
      const assertion = runtime.vault.approveDenyCancellation({
        revocationIntentId: intentId,
        apiCancellationNonce: BigInt(reissued.cancellationNonce!),
        expiresAt,
      })
      await runtime.ownerApi.cancelRevocation(intentId, { expiresAt, assertion })

      await engine.run()
      expect((await rowState(saved.contextId))?.state).toBe("ANCHORED")
    } finally {
      await runtime.close()
    }
  }, T)

  it("a denied agent's held save does not hold an unrelated agent's save", async () => {
    const { runtime, agentId } = await newHome(true)
    try {
      const claude = await saveCheckpoint(runtime, "claude-code", env("proj-mix", "cp-i5-F-0001"))
      const codex = await saveCheckpoint(runtime, "codex", env("proj-mix", "cp-i5-F-0002", "sF2"))
      expect(claude.batched?.state).toBe("QUEUED")
      expect(codex.batched?.state).toBe("QUEUED")

      await stageDenyOnly(runtime, agentId)
      await engine.run()
      expect((await rowState(claude.contextId))?.state).toBe("HELD")
      // One batch can carry both kinds: the hold is per-row, so codex's save anchored in the same run.
      expect((await rowState(codex.contextId))?.state).toBe("ANCHORED")
    } finally {
      await runtime.close()
    }
  }, T)
})
