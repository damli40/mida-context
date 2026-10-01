// Plan Task 10 (docs/superpowers/plans/2026-09-24-batch-anchor.md): the batched checkpoint lane
// end to end on a real local Anvil — deployLocal runs Deploy.s.sol + DeployBatchAnchor.s.sol, the
// Context API serves in-process with the real Node batcher on a 200 ms wait window. Each scenario
// is its own `it` on a fresh Mida home (fresh owner, fresh agents) over the shared chain and store.
//
// env.batcher.pauseTimer()/resumeTimer() hold the batcher's wait window: while paused a queued
// save provably stays QUEUED — never racing 200 ms of wall clock — and an anchor that still
// happens could only have come from a flush, not the timer.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http } from "viem"
import type { AbiEvent, PublicClient } from "viem"
import { namespaceId, verifyMerkleProof } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { batchAnchorAbi, chainFor, getLogsChunked } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  NAMESPACE,
  Runtime,
  approve,
  init,
  migrate,
  readCheckpoints,
  requestAccess,
  revoke,
  runCli,
  runDoctor,
  saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import type { Checkpoint } from "@mida/checkpoint"
import { followPendingAnchors, pendingAnchors, rejectedAnchors } from "../src/batching.js"
import { readSavedNetwork } from "../src/network.js"
import { sampleCheckpoint } from "./helpers.js"

const AGENTS = ["claude-code", "codex"] as const
const STEP_TIMEOUT = 120_000
/** How long a settle loop waits for the chain's answer to a submitted batch. */
const SETTLE_MS = 5_000

const envelope = (projectId: string, checkpoint: Checkpoint, sessionId = "s1") => ({
  projectId,
  sessionId,
  continuesSession: null,
  compiledBy: "test",
  checkpoint,
})

const BATCH_ANCHORED = batchAnchorAbi.find((entry) => entry.type === "event" && entry.name === "BatchAnchored") as AbiEvent
const SAVE_ANCHORED = batchAnchorAbi.find((entry) => entry.type === "event" && entry.name === "SaveAnchored") as AbiEvent

describe("batched checkpoint lane end to end on local Anvil (Task 10)", () => {
  let env: ScenarioEnvironment
  let network: Network
  let publicClient: PublicClient
  let batchAnchor: Address

  beforeAll(async () => {
    env = await localEnvironment({ batching: { waitMs: 200 } })
    if (env.deployment.batchAnchor === undefined) throw new Error("deployLocal did not deploy a BatchAnchor")
    if (env.batcher === undefined) throw new Error("localEnvironment did not expose the batch timer handle")
    batchAnchor = env.deployment.batchAnchor
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    publicClient = createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) })
  }, 600_000)

  afterAll(async () => {
    await env?.stop()
  })

  /** A fresh home on the shared chain: init registers both agents, then each is approved. */
  const newHome = async (): Promise<{ home: MidaHome; runtime: Runtime }> => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-batch-")))
    const runtime = await Runtime.open(home, network)
    await init(runtime, AGENTS)
    for (const name of AGENTS) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }
    return { home, runtime }
  }

  /** `mida batching on|off` through the real CLI dispatch — the terminal check and the yes answer are injected. */
  const batching = async (home: MidaHome, on: boolean): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = []
    const code = await runCli(["batching", on ? "on" : "off"], {
      home,
      network,
      print: (line) => lines.push(line),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: async () => "yes",
      drainInput: () => {},
      kickDaemon: () => {},
    })
    return { code, lines }
  }

  /** Every BatchAnchored the contract has emitted — one per submitBatch transaction. */
  const batchAnchoredEvents = async () => {
    // cacheTime: 0 — a cached head from seconds ago can sit below the block the batch just mined
    // into, and the scan would report "no new batch" for a transaction that already resolved.
    const head = await publicClient.getBlockNumber({ cacheTime: 0 })
    return getLogsChunked(publicClient, { address: batchAnchor, event: BATCH_ANCHORED, fromBlock: env.deployment.batchAnchorBlock ?? env.deployment.deploymentBlock, toBlock: head })
  }

  /**
   * Drives the pending ledger to final states: each pass asks the store where every queued save
   * stands; ANCHORED and REJECTED entries leave the ledger. Bounded by `ms` — returns what
   * accumulated so a stuck batch fails the caller's assertion with real counts, not a timeout.
   */
  const settlePending = async (runtime: Runtime, home: MidaHome, ms = SETTLE_MS) => {
    const log: Record<string, unknown>[] = []
    const total = { anchored: 0, rejected: 0 }
    const deadline = Date.now() + ms
    while (Date.now() < deadline && pendingAnchors(home).length > 0) {
      const step = await followPendingAnchors(runtime, (record) => log.push(record))
      total.anchored += step.anchored
      total.rejected += step.rejected
      if (pendingAnchors(home).length > 0) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { ...total, left: pendingAnchors(home).length, log }
  }

  it(
    "1. batching on: a save returns QUEUED, reads back PENDING_ANCHOR, then anchors",
    async () => {
      const { home, runtime } = await newHome()
      try {
        const on = await batching(home, true)
        expect(on.code).toBe(0)
        expect(on.lines).toContain("batching is on")
        expect(readSavedNetwork(home)?.batching).toBe(true)

        // The window is held so the QUEUED receipt and the PENDING_ANCHOR read are asserted
        // against a save that cannot already have anchored behind the test's back.
        env.batcher!.pauseTimer()
        const input = envelope("proj-b1", sampleCheckpoint({ eventId: "cp-b1-01" }))
        let saved!: Awaited<ReturnType<typeof saveCheckpoint>>
        let pendingRead!: Awaited<ReturnType<typeof readCheckpoints>>
        try {
          saved = await saveCheckpoint(runtime, "claude-code", input)
          pendingRead = await readCheckpoints(runtime, "claude-code", "proj-b1")
        } finally {
          env.batcher!.resumeTimer()
        }

        expect(saved.lane).toBe("batched")
        expect(saved.batched?.state).toBe("QUEUED")
        expect(saved.transactionHash).toBeNull()
        // the store's receipt proves it took responsibility for the save — never that it anchored
        // (in-14 F-3: the receipt is optional — an ALREADY_QUEUED answer carries none)
        expect(saved.batched?.receipt?.contextId).toBe(saved.contextId)

        // the saving agent's own immediate read: verified content, marked PENDING_ANCHOR — and
        // because the pending item is the reader's own, no flush was asked for
        expect(pendingRead.checkpoints).toHaveLength(1)
        expect(pendingRead.checkpoints[0]!.contextId).toBe(saved.contextId)
        expect(pendingRead.checkpoints[0]!.anchor).toBe("PENDING_ANCHOR")
        expect(pendingRead.checkpoints[0]!.checkpoint).toEqual(input.checkpoint)
        expect(pendingRead.partial).toBe(false)

        // the released window submits the batch; the ledger follow-up sees ANCHORED within 5 s
        const settled = await settlePending(runtime, home)
        expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })

        const anchored = await readCheckpoints(runtime, "claude-code", "proj-b1")
        expect(anchored.checkpoints).toHaveLength(1)
        expect(anchored.checkpoints[0]!.contextId).toBe(saved.contextId)
        expect(anchored.checkpoints[0]!.anchor).toBe("ANCHORED")
        expect(anchored.checkpoints[0]!.checkpoint).toEqual(input.checkpoint)
        expect(anchored.partial).toBe(false)
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "2. another agent's read flushes the queue — the save is ANCHORED when the read returns",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })

        // Held window: the ONLY way claude-code's save can anchor is the flush readCheckpoints
        // fires for a pending save belonging to a different agent (Amendment B.4).
        env.batcher!.pauseTimer()
        const batchesBefore = (await batchAnchoredEvents()).length
        try {
          const input = envelope("proj-b2", sampleCheckpoint({ eventId: "cp-b2-01" }))
          const saved = await saveCheckpoint(runtime, "claude-code", input)
          expect(saved.batched?.state).toBe("QUEUED")

          const read = await readCheckpoints(runtime, "codex", "proj-b2")

          // exactly one submitBatch transaction, and it landed before the read returned —
          // readCheckpoints waits at most flushWaitMs (3 s) for the foreign save to anchor, so an
          // ANCHORED answer here is an answer inside that wait
          expect((await batchAnchoredEvents()).length - batchesBefore).toBe(1)
          expect(read.checkpoints).toHaveLength(1)
          expect(read.checkpoints[0]!.contextId).toBe(saved.contextId)
          expect(read.checkpoints[0]!.anchor).toBe("ANCHORED")
          expect(read.checkpoints[0]!.checkpoint).toEqual(input.checkpoint)
        } finally {
          env.batcher!.resumeTimer()
        }
        const settled = await settlePending(runtime, home)
        expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "3. an agent revoked while its save is queued: REJECTED NO_AUTHORITY, gone from reads, PROBLEM in doctor",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })

        // Hold the window, queue the save, then take the agent's authority away before the batch
        // can submit — the contract sees no live CREATE grant and must reject NO_AUTHORITY.
        env.batcher!.pauseTimer()
        let contextId!: Hex
        try {
          const saved = await saveCheckpoint(runtime, "claude-code", envelope("proj-b3", sampleCheckpoint({ eventId: "cp-b3-01" })))
          expect(saved.batched?.state).toBe("QUEUED")
          contextId = saved.contextId
          const revoked = await revoke(runtime, "claude-code")
          // codex's wraps must have been republished for the rotated read epoch, or the read
          // below fails for the wrong reason
          expect(revoked.failed).toEqual([])
        } finally {
          env.batcher!.resumeTimer()
        }

        const settled = await settlePending(runtime, home)
        expect(settled).toMatchObject({ anchored: 0, rejected: 1, left: 0 })
        expect(rejectedAnchors(home)).toMatchObject([{ contextId, reason: "NO_AUTHORITY" }])

        // REJECTED rows are never served to a reader — the save is simply absent
        const read = await readCheckpoints(runtime, "codex", "proj-b3")
        expect(read.checkpoints).toHaveLength(0)

        const lines: string[] = []
        await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
        expect(lines.some((line) => line.startsWith("PROBLEM: a checkpoint save was rejected on chain (NO_AUTHORITY"))).toBe(true)
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "4. mida migrate refuses batched-saves-present once the owner has batched saves",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })
        const saved = await saveCheckpoint(runtime, "claude-code", envelope("proj-b4", sampleCheckpoint({ eventId: "cp-b4-01" })))
        expect(saved.batched?.state).toBe("QUEUED")
        // hasBatchedSaves(owner) is set by the contract on the owner's first ACCEPTED save —
        // wait for the anchor so the migrate guard has something to find
        const settled = await settlePending(runtime, home)
        expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })
        expect(
          await publicClient.readContract({ address: batchAnchor, abi: batchAnchorAbi, functionName: "hasBatchedSaves", args: [runtime.owner] }),
        ).toBe(true)

        const lines: string[] = []
        const result = await migrate({
          home,
          env: {},
          print: (line) => lines.push(line),
          now: () => new Date(),
          confirm: async () => true,
          startService: () => {},
        })
        expect(result).toMatchObject({ outcome: "refused", code: "batched-saves-present" })
        expect(lines).toContain("this setup has batched checkpoint saves; migrate cannot move them yet")
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "5. batching off: the next save is a direct ContextRegistry save, read back ANCHORED",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })
        const queued = await saveCheckpoint(runtime, "claude-code", envelope("proj-b5", sampleCheckpoint({ eventId: "cp-b5-01" })))
        expect(queued.lane).toBe("batched")
        const settled = await settlePending(runtime, home)
        expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })

        const off = await batching(home, false)
        expect(off.code).toBe(0)
        expect(off.lines).toContain("batching is off; saves already queued will still finish")
        expect(readSavedNetwork(home)?.batching).toBe(false)

        const input = envelope("proj-b5", sampleCheckpoint({ eventId: "cp-b5-02" }))
        const direct = await saveCheckpoint(runtime, "claude-code", input)
        expect(direct.lane).toBe("direct")
        expect(direct.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)

        const read = await readCheckpoints(runtime, "claude-code", "proj-b5")
        const found = read.checkpoints.find((checkpoint) => checkpoint.contextId === direct.contextId)
        expect(found?.anchor).toBe("ANCHORED")
        expect(found?.checkpoint).toEqual(input.checkpoint)
        // the earlier batched save is still there, anchored by the batch before the switch
        expect(read.checkpoints).toHaveLength(2)
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "6. no batching key in network.json: the direct lane, and hasBatchedSaves(owner) stays false",
    async () => {
      const { home, runtime } = await newHome()
      try {
        const savedFile = home.readJson<Record<string, unknown>>("network.json")
        expect(Object.hasOwn(savedFile ?? {}, "batching"), "network.json unexpectedly carries a batching key").toBe(false)
        expect(readSavedNetwork(home)?.batching).toBeUndefined()

        const input = envelope("proj-b6", sampleCheckpoint({ eventId: "cp-b6-01" }))
        const saved = await saveCheckpoint(runtime, "claude-code", input)
        expect(saved.lane).toBe("direct")
        expect(saved.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)

        expect(
          await publicClient.readContract({ address: batchAnchor, abi: batchAnchorAbi, functionName: "hasBatchedSaves", args: [runtime.owner] }),
        ).toBe(false)

        const read = await readCheckpoints(runtime, "claude-code", "proj-b6")
        expect(read.checkpoints).toHaveLength(1)
        expect(read.checkpoints[0]!.anchor).toBe("ANCHORED")
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "7. twenty saves from two agents share one batch transaction — all ANCHORED, every proof verified against the chain root",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })

        // The window is held while all twenty queue — one release, one submission, one
        // transaction. Twenty is under the batcher's learned gas cap (~401 at the sweep's
        // measured per-save cost), so nothing submits early.
        env.batcher!.pauseTimer()
        const batchesBefore = (await batchAnchoredEvents()).length
        const contextIds: Hex[] = []
        try {
          for (let i = 0; i < 20; i += 1) {
            const agent = AGENTS[i % 2]!
            const saved = await saveCheckpoint(runtime, agent, envelope("proj-b7", sampleCheckpoint({ eventId: `cp-b7-${String(i).padStart(2, "0")}` })))
            expect(saved.batched?.state).toBe("QUEUED")
            contextIds.push(saved.contextId)
          }
        } finally {
          env.batcher!.resumeTimer()
        }

        const settled = await settlePending(runtime, home, 15_000)
        expect(settled).toMatchObject({ anchored: 20, rejected: 0, left: 0 })

        // one submitBatch transaction, twenty accepted, zero rejected
        const batches = await batchAnchoredEvents()
        expect(batches.length - batchesBefore).toBe(1)
        const batchEvent = batches[batches.length - 1]!.args as { batchId: Hex; acceptedCount: number; rejectedCount: number }
        expect(batchEvent.acceptedCount).toBe(20)
        expect(batchEvent.rejectedCount).toBe(0)

        const { items } = await runtime.ownerApi.listBatchSaves({ owner: runtime.owner, namespaceId: namespaceId(NAMESPACE) })
        const wanted = new Set(contextIds.map((id) => id.toLowerCase()))
        const anchored = items.filter((item) => item.state === "ANCHORED" && wanted.has(item.contextId.toLowerCase()))
        expect(anchored).toHaveLength(20)
        for (const item of anchored) expect(item.batchId).toBe(batchEvent.batchId)

        // the merged reader view — all twenty ANCHORED, none pending
        const read = await readCheckpoints(runtime, "codex", "proj-b7")
        expect(read.checkpoints).toHaveLength(20)
        for (const checkpoint of read.checkpoints) expect(checkpoint.anchor).toBe("ANCHORED")
        expect(read.partial).toBe(false)

        // Every proof against the chain's own root: the leaf is the one BatchAnchor emitted in
        // its SaveAnchored log, the root is batchOf(batchId).root, the proof is what the store
        // serves. A proof minted under any other root fails here.
        const [root, , acceptedOnChain] = await publicClient.readContract({
          address: batchAnchor,
          abi: batchAnchorAbi,
          functionName: "batchOf",
          args: [batchEvent.batchId],
        })
        expect(acceptedOnChain).toBe(20)
        const anchoredLogs = await getLogsChunked(publicClient, {
          address: batchAnchor,
          event: SAVE_ANCHORED,
          args: { batchId: batchEvent.batchId },
          fromBlock: env.deployment.batchAnchorBlock ?? env.deployment.deploymentBlock,
          toBlock: await publicClient.getBlockNumber({ cacheTime: 0 }),
        })
        expect(anchoredLogs).toHaveLength(20)
        for (const item of anchored) {
          const log = anchoredLogs.find((entry) => (entry.args as { contextId: Hex }).contextId.toLowerCase() === item.contextId.toLowerCase())
          expect(log, `no SaveAnchored log for ${item.contextId}`).toBeDefined()
          const event = log!.args as unknown as { leafHash: Hex; position: number; lineageId: Hex; version: number }
          expect(item.position).toBe(event.position)
          expect(item.lineageId).toBe(event.lineageId)
          expect(item.version).toBe(event.version)
          expect(item.proof, `no Merkle proof stored for ${item.contextId}`).toBeDefined()
          expect(verifyMerkleProof(event.leafHash, item.proof!, root), `Merkle proof failed for ${item.contextId}`).toBe(true)
        }
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "8. an epoch rotation under a queued save: re-sealed, resubmitted and ANCHORED — never a lost checkpoint (in-2 I3)",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })

        // codex queues under the current read epoch while the batch window is held; the owner
        // then revokes claude-code, which rotates the namespace's key version. codex is still
        // authorized — but its queued save is sealed under the rotated-away epoch, so the
        // contract rejects it BAD_EPOCH. The follow-up must re-seal the kept plaintext under
        // the current epoch and resubmit — codex silently losing its checkpoint is the bug.
        env.batcher!.pauseTimer()
        let contextId!: Hex
        const input = envelope("proj-b8", sampleCheckpoint({ eventId: "cp-b8-01", objective: "codex's surviving checkpoint" }))
        try {
          const saved = await saveCheckpoint(runtime, "codex", input)
          expect(saved.batched?.state).toBe("QUEUED")
          contextId = saved.contextId
          // the pending save's plaintext rides inside the home from the moment it is queued —
          // a secret file, user-only (0600), named for the save it can rebuild
          const kept = home.path(`state/batch-plaintext/${contextId}.json`)
          expect(existsSync(kept), "no kept plaintext for the queued save").toBe(true)
          expect(statSync(kept).mode & 0o777).toBe(0o600)

          const revoked = await revoke(runtime, "claude-code")
          // codex's reader wraps must be republished for the rotated epoch — a failed wrap would
          // fail the reads below for the wrong reason
          expect(revoked.failed).toEqual([])
        } finally {
          env.batcher!.resumeTimer()
        }

        // first submission rejects BAD_EPOCH; the follow-up resubmits and the next batch anchors
        const settled = await settlePending(runtime, home, 20_000)
        expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })

        // the checkpoint landed — re-sealed under a fresh contextId, never the stale one
        const read = await readCheckpoints(runtime, "codex", "proj-b8")
        const landed = read.checkpoints.find((cp) => cp.checkpoint.eventId === "cp-b8-01")
        expect(landed, "codex's checkpoint is not readable").toBeDefined()
        expect(landed!.anchor).toBe("ANCHORED")
        expect(landed!.checkpoint).toEqual(input.checkpoint)
        expect(landed!.contextId).not.toBe(contextId)

        // the stale-epoch answer was a retry, not a refusal — no rejected-ledger entry, and the
        // kept plaintext went away with the anchor it made possible
        expect(rejectedAnchors(home)).toEqual([])
        expect(home.list("state/batch-plaintext").filter((name) => name.endsWith(".json"))).toEqual([])
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "9. a revoked author's rejected save is never resubmitted — and its kept plaintext is gone (in-2 I3)",
    async () => {
      const { home, runtime } = await newHome()
      try {
        expect(await batching(home, true)).toMatchObject({ code: 0 })

        env.batcher!.pauseTimer()
        let contextId!: Hex
        try {
          const saved = await saveCheckpoint(runtime, "claude-code", envelope("proj-b9", sampleCheckpoint({ eventId: "cp-b9-01" })))
          expect(saved.batched?.state).toBe("QUEUED")
          contextId = saved.contextId
          expect(existsSync(home.path(`state/batch-plaintext/${contextId}.json`))).toBe(true)
          await revoke(runtime, "claude-code")
        } finally {
          env.batcher!.resumeTimer()
        }

        // authority rejections are never retried: the row stays refused, no second QUEUED row
        // for the save appears at the store, and the plaintext died with the final answer
        const settled = await settlePending(runtime, home)
        expect(settled).toMatchObject({ anchored: 0, rejected: 1, left: 0 })
        expect(rejectedAnchors(home)).toMatchObject([{ contextId, reason: "NO_AUTHORITY" }])
        expect(existsSync(home.path(`state/batch-plaintext/${contextId}.json`))).toBe(false)
        const { items } = await runtime.ownerApi.listBatchSaves({ owner: runtime.owner, namespaceId: namespaceId(NAMESPACE) })
        expect(items.filter((item) => item.state === "QUEUED" || item.state === "SUBMITTED")).toEqual([])
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )
})
