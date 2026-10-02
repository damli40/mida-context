// Brief in-1: "current" is decided by Monad's time, never by a date the saver writes.
// checkpoint.createdAt is encrypted content the saving agent sets itself — format-checked only.
// Ordering must come from the record's chain placement: the ContextRegistry row's createdAt for a
// direct save, the anchor block's timestamp for a batched one, then (block, logIndex) for ties.
//
// Real local Anvil through `localEnvironment` (batching enabled so the pending lane exists). The
// evm_setAutomine/evm_mine calls below land several sends in ONE block, which is the only way two
// saves can share a second AND a block — the exact case the contextId tie-break used to decide.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http } from "viem"
import type { AbiEvent, PublicClient } from "viem"
import { chainFor, contextRegistryAbi, getLogsChunked } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  approve,
  buildHandoff,
  init,
  readCheckpoints,
  requestAccess,
  runCli,
  saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import type { Hex } from "@mida/protocol"
import { PENDING_ANCHOR_LINE } from "../src/handoff.js"
import { followPendingAnchors, pendingAnchors } from "../src/batching.js"
import { sampleCheckpoint } from "./helpers.js"
import type { Checkpoint } from "@mida/checkpoint"

const AGENTS = ["claude-code", "codex"] as const
const STEP_TIMEOUT = 240_000
const SETTLE_MS = 5_000

const CONTEXT_REGISTERED = contextRegistryAbi.find(
  (entry) => entry.type === "event" && entry.name === "ContextRegistered",
) as AbiEvent

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

const envelope = (projectId: string, checkpoint: Checkpoint, sessionId: string) => ({
  projectId,
  sessionId,
  continuesSession: null,
  compiledBy: "test",
  checkpoint,
})

/** A raw Anvil JSON-RPC call — evm_setAutomine, evm_mine — shared by the same-block tests. */
const anvil = async (rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await response.json()) as { error?: unknown; result?: unknown }
  if (body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
  return body.result
}

/** How many transactions wait in the local chain's pool for the next block. */
const pendingCount = async (rpcUrl: string): Promise<number> => {
  const status = (await anvil(rpcUrl, "txpool_status")) as { pending?: string }
  return Number.parseInt(status.pending ?? "0x0", 16)
}

/** The Objective: line inside the rendered handoff — the save Monad calls current. */
const objectiveLine = (text: string): string | undefined => /^Objective: (.*)$/m.exec(text)?.[1]

describe("chain order decides 'current', never the checkpoint's claimed clock (in-1)", () => {
  let env: ScenarioEnvironment
  let network: Network
  let publicClient: PublicClient

  beforeAll(async () => {
    env = await localEnvironment({ batching: { waitMs: 200 } })
    if (env.deployment.batchAnchor === undefined) throw new Error("deployLocal did not deploy a BatchAnchor")
    if (env.batcher === undefined) throw new Error("localEnvironment did not expose the batch timer handle")
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    publicClient = createPublicClient({ chain: chainFor(env.deployment.chainId), transport: http(env.rpcUrl) })
  }, 600_000)

  afterAll(async () => {
    await env?.stop()
  })

  const newHome = async (): Promise<{ home: MidaHome; runtime: Runtime }> => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-chain-order-")))
    const runtime = await Runtime.open(home, network)
    await init(runtime, [...AGENTS])
    for (const name of AGENTS) await requestAccess(runtime, name)
    return { home, runtime }
  }

  /** `mida batching on` through the real CLI dispatch — the terminal check and the yes answer are injected. */
  const batchingOn = async (home: MidaHome): Promise<void> => {
    const lines: string[] = []
    const code = await runCli(["batching", "on"], {
      home,
      network,
      print: (line) => lines.push(line),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: async () => "yes",
      drainInput: () => {},
      kickDaemon: () => {},
    })
    expect(code).toBe(0)
    expect(lines).toContain("batching is on")
  }

  /** Drives the pending ledger to final states — the same helper shape batch.e2e uses. */
  const settlePending = async (runtime: Runtime, home: MidaHome, ms = SETTLE_MS) => {
    const total = { anchored: 0, rejected: 0 }
    const deadline = Date.now() + ms
    while (Date.now() < deadline && pendingAnchors(home).length > 0) {
      const step = await followPendingAnchors(runtime, () => {})
      total.anchored += step.anchored
      total.rejected += step.rejected
      if (pendingAnchors(home).length > 0) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { ...total, left: pendingAnchors(home).length }
  }

  /** Every ContextRegistered the registry emitted for this owner: contextId → (block, logIndex). */
  const placements = async (runtime: Runtime): Promise<Map<string, { block: bigint; index: number }>> => {
    const logs = await getLogsChunked(publicClient, {
      address: env.deployment.contextRegistry,
      event: CONTEXT_REGISTERED,
      args: { owner: runtime.owner },
      fromBlock: env.deployment.deploymentBlock,
      toBlock: await publicClient.getBlockNumber({ cacheTime: 0 }),
    })
    const map = new Map<string, { block: bigint; index: number }>()
    for (const log of logs) {
      const contextId = ((log.args as { contextId: Hex }).contextId).toLowerCase()
      map.set(contextId, { block: log.blockNumber!, index: log.logIndex! })
    }
    return map
  }

  it(
    "a checkpoint claiming 2099 loses the objective to the save Monad recorded last",
    async () => {
      const { runtime } = await newHome()
      try {
        const workDir = join(mkdtempSync(join(tmpdir(), "mida-order-work-")), "work")
        mark(workDir, "proj-order-2099")
        for (const name of AGENTS) await approve(runtime, name, workDir)

        // claude-code saves FIRST on chain but claims a createdAt in 2099 — content-level lie.
        const forged = await saveCheckpoint(runtime, "claude-code", envelope("proj-order-2099", sampleCheckpoint({
          eventId: "cp-2099-01",
          agent: "claude-code",
          createdAt: "2099-01-01T00:00:00.000Z",
          objective: "OBJECTIVE-FROM-EARLIER-SAVE (future-dated)",
          nextAction: "NEXT-FROM-EARLIER-SAVE",
        }), "s-old-but-future-dated"))
        expect(forged.lane).toBe("direct")

        const latest = await saveCheckpoint(runtime, "codex", envelope("proj-order-2099", sampleCheckpoint({
          eventId: "cp-2099-02",
          agent: "codex",
          createdAt: new Date().toISOString(),
          objective: "OBJECTIVE-FROM-LATEST-SAVE",
          nextAction: "NEXT-FROM-LATEST-SAVE",
        }), "s-new"))
        expect(latest.lane).toBe("direct")

        // the SDK's read carries Monad's placement: the registry row's createdAt per save
        const read = await readCheckpoints(runtime, "codex", "proj-order-2099")
        const placed = new Map(read.checkpoints.map((cp) => [cp.contextId, cp]))
        const forgedCp = placed.get(forged.contextId)
        const latestCp = placed.get(latest.contextId)
        expect(forgedCp?.chain?.at, "the earlier save must carry Monad's stamp").toBeTypeOf("bigint")
        expect(latestCp?.chain?.at, "the latest save must carry Monad's stamp").toBeTypeOf("bigint")
        expect(forgedCp!.chain!.at < latestCp!.chain!.at).toBe(true)

        const handoff = await buildHandoff(runtime, { agent: "codex", cwd: workDir, authorNames: {}, sessionId: "s-fresh" })
        expect(handoff.kind).toBe("handoff")
        if (handoff.kind !== "handoff") return
        expect(objectiveLine(handoff.text)).toBe("OBJECTIVE-FROM-LATEST-SAVE")
        expect(handoff.text).not.toContain("Objective: OBJECTIVE-FROM-EARLIER-SAVE")
        // the owner line's savedAt is Monad's stamp too — never the claimed 2099
        expect(handoff.savedAt).not.toContain("2099")
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "two saves landing in the same second order by their position in the block — never by contextId",
    async () => {
      const { runtime } = await newHome()
      try {
        const workDir = join(mkdtempSync(join(tmpdir(), "mida-order-work-")), "work")
        mark(workDir, "proj-order-tie")
        for (const name of AGENTS) await approve(runtime, name, workDir)

        // Each round puts one save per agent into the SAME automine-off block: same second, same
        // block, ordered only by log index. The id tie-break picks a random winner half the time;
        // rounds repeat until that arrangement diverges so the assertion below is decisive.
        let diverged = false
        await anvil(env.rpcUrl, "evm_setAutomine", [false])
        try {
          for (let round = 0; round < 8 && !diverged; round += 1) {
            const claim = new Date().toISOString()
            const saveA = saveCheckpoint(runtime, "claude-code", envelope("proj-order-tie", sampleCheckpoint({
              eventId: `cp-tie-${round}-a`,
              agent: "claude-code",
              createdAt: claim,
              objective: `ORDER-${round}-CLAUDE`,
            }), `s-tie-${round}-a`))
            const saveB = saveCheckpoint(runtime, "codex", envelope("proj-order-tie", sampleCheckpoint({
              eventId: `cp-tie-${round}-b`,
              agent: "codex",
              createdAt: claim,
              objective: `ORDER-${round}-CODEX`,
            }), `s-tie-${round}-b`))
            const both = Promise.allSettled([saveA, saveB])
            let settled = false
            void both.then(() => {
              settled = true
            })
            // Both sends must be in the pool BEFORE the first block is produced: that is what
            // puts the two saves in one block. The wait is bounded, so a save that fails before
            // it sends cannot hang the round.
            const sendsBy = Date.now() + 10_000
            while (!settled && Date.now() < sendsBy && (await pendingCount(env.rpcUrl)) < 2) {
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
            // Then keep producing blocks until both saves have returned, so a transaction sent
            // late still gets a block instead of waiting out the send timeout.
            while (!settled) {
              await anvil(env.rpcUrl, "evm_mine")
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            const [resultA, resultB] = await both
            if (resultA.status === "rejected") throw resultA.reason
            if (resultB.status === "rejected") throw resultB.reason
            const savedA = resultA.value
            const savedB = resultB.value

            const placed = await placements(runtime)
            const pA = placed.get(savedA.contextId.toLowerCase())
            const pB = placed.get(savedB.contextId.toLowerCase())
            expect(pA).toBeDefined()
            expect(pB).toBeDefined()
            const chainLatest = pB!.block > pA!.block || (pB!.block === pA!.block && pB!.index > pA!.index) ? savedB : savedA
            const chainEarliest = chainLatest === savedB ? savedA : savedB
            // the OLD rule's winner: equal claims order by the lowest contextId
            const idPicked = savedA.contextId < savedB.contextId ? savedA : savedB
            if (idPicked === chainEarliest) {
              diverged = true
              const handoff = await buildHandoff(runtime, {
                agent: "codex",
                cwd: workDir,
                authorNames: {},
                sessionId: "s-tie-fresh",
              })
              expect(handoff.kind).toBe("handoff")
              if (handoff.kind !== "handoff") return
              expect(objectiveLine(handoff.text)).toBe(
                `ORDER-${round}-${chainLatest === savedB ? "CODEX" : "CLAUDE"}`,
              )
            }
          }
        } finally {
          await anvil(env.rpcUrl, "evm_setAutomine", [true])
        }
        expect(diverged, "eight same-block rounds never produced an id-order/chain-order divergence").toBe(true)
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "a pending batched save claiming the newest time stays in the pending block — and once anchored it carries the anchor block's time",
    async () => {
      const { home, runtime } = await newHome()
      try {
        const workDir = join(mkdtempSync(join(tmpdir(), "mida-order-work-")), "work")
        mark(workDir, "proj-order-pending")
        for (const name of AGENTS) await approve(runtime, name, workDir)

        // an anchored direct save is the chain-latest — it must keep the objective. Saved while
        // batching is still off, so it lands on ContextRegistry directly.
        const anchored = await saveCheckpoint(runtime, "codex", envelope("proj-order-pending", sampleCheckpoint({
          eventId: "cp-pend-01",
          agent: "codex",
          createdAt: new Date().toISOString(),
          objective: "OBJECTIVE-ANCHORED-DIRECT",
        }), "s-anchored"))
        expect(anchored.lane).toBe("direct")
        await batchingOn(home)

        // the pending reads run INSIDE the held window — resumed, the 200 ms wait anchors the
        // batch behind the test's back and PENDING_ANCHOR is already gone. Reading as the saving
        // agent also means no foreign-pending flush fires.
        env.batcher!.pauseTimer()
        let queued: Awaited<ReturnType<typeof saveCheckpoint>>
        let anchoredRow: Awaited<ReturnType<typeof readCheckpoints>>["checkpoints"][number] | undefined
        try {
          queued = await saveCheckpoint(runtime, "claude-code", envelope("proj-order-pending", sampleCheckpoint({
            eventId: "cp-pend-02",
            agent: "claude-code",
            createdAt: "2099-01-01T00:00:00.000Z",
            objective: "OBJECTIVE-PENDING-FORGED",
          }), "s-pending"))
          expect(queued.lane).toBe("batched")
          expect(queued.batched?.state).toBe("QUEUED")

          const read = await readCheckpoints(runtime, "claude-code", "proj-order-pending")
          const pendingRow = read.checkpoints.find((cp) => cp.contextId === queued.contextId)
          anchoredRow = read.checkpoints.find((cp) => cp.contextId === anchored.contextId)
          expect(pendingRow?.anchor).toBe("PENDING_ANCHOR")
          // pending saves carry no chain placement — Monad has not placed them, whatever they claim
          expect(pendingRow?.chain).toBeUndefined()
          expect(anchoredRow?.chain?.at).toBeTypeOf("bigint")

          const handoff = await buildHandoff(runtime, {
            agent: "claude-code",
            cwd: workDir,
            authorNames: {},
            sessionId: "s-pending-fresh",
          })
          expect(handoff.kind).toBe("handoff")
          if (handoff.kind !== "handoff") return
          expect(objectiveLine(handoff.text)).toBe("OBJECTIVE-ANCHORED-DIRECT")
          expect(handoff.text).toContain(PENDING_ANCHOR_LINE)
          expect(handoff.text).toContain("objective: OBJECTIVE-PENDING-FORGED")
        } finally {
          env.batcher!.resumeTimer()
        }

        // once the batch anchors, the same save orders by the anchor block's time
        const settled = await settlePending(runtime, home, 15_000)
        expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })
        const after = await readCheckpoints(runtime, "codex", "proj-order-pending")
        const landed = after.checkpoints.find((cp) => cp.contextId === queued.contextId)
        expect(landed?.anchor).toBe("ANCHORED")
        expect(landed?.chain?.at).toBeTypeOf("bigint")
        expect(landed?.chain?.block).toBeTypeOf("bigint")
        expect(landed?.chain?.index).toBeTypeOf("number")
        expect(landed!.chain!.at >= anchoredRow!.chain!.at).toBe(true)
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )

  it(
    "a migration envelope can only age its record — a forged 2099 never wins, a moved save keeps its past (in-2 I0)",
    async () => {
      const { runtime } = await newHome()
      try {
        const workDir = join(mkdtempSync(join(tmpdir(), "mida-order-work-")), "work")
        mark(workDir, "proj-order-envelope")
        for (const name of AGENTS) await approve(runtime, name, workDir)

        const migration = (originalCreatedAt: string) => ({
          version: 1 as const,
          originalChainId: "31337",
          originalContract: `0x${"1".repeat(40)}` as `0x${string}`,
          originalRecordId: `0x${"2".repeat(64)}` as `0x${string}`,
          originalCommitment: `0x${"3".repeat(64)}` as `0x${string}`,
          originalAuthor: `0x${"4".repeat(64)}` as `0x${string}`,
          originalCreatedAt,
          migratedAt: new Date().toISOString(),
        })

        // The envelope is validated for shape only — its dates are claims inside the encrypted
        // payload, and an agent can write one into its own save. Ordering caps the claim at the
        // time Monad actually recorded for the record: older is allowed, newer is not. Three
        // saves share one session: (1) a save claiming a 2099 original — the chain placed it
        // FIRST, so capping it can never crown it; (2) the honest newest save; (3) a save whose
        // envelope honestly reports a 2023 original — Monad stamped it last, but its real place
        // is far behind the others.
        const forged = await saveCheckpoint(runtime, "claude-code", {
          ...envelope("proj-order-envelope", sampleCheckpoint({
            eventId: "cp-env-01",
            agent: "claude-code",
            createdAt: new Date().toISOString(),
            objective: "OBJECTIVE-FORGED-ENVELOPE",
          }), "s-envelope"),
          migration: migration("2099-01-01T00:00:00.000Z"),
        })
        expect(forged.lane).toBe("direct")

        const latest = await saveCheckpoint(runtime, "codex", envelope("proj-order-envelope", sampleCheckpoint({
          eventId: "cp-env-02",
          agent: "codex",
          createdAt: new Date().toISOString(),
          objective: "OBJECTIVE-HONEST-LATEST",
        }), "s-envelope"))
        expect(latest.lane).toBe("direct")

        const moved = await saveCheckpoint(runtime, "claude-code", {
          ...envelope("proj-order-envelope", sampleCheckpoint({
            eventId: "cp-env-03",
            agent: "claude-code",
            createdAt: new Date().toISOString(),
            objective: "OBJECTIVE-MOVED-OLDER",
          }), "s-envelope"),
          migration: migration("2023-10-01T00:00:00.000Z"),
        })
        expect(moved.lane).toBe("direct")

        // the envelopes reached the stored records — the reads carry them
        const read = await readCheckpoints(runtime, "codex", "proj-order-envelope")
        const forgedCp = read.checkpoints.find((cp) => cp.contextId === forged.contextId)
        expect(forgedCp?.migration?.originalCreatedAt).toBe("2099-01-01T00:00:00.000Z")
        const movedCp = read.checkpoints.find((cp) => cp.contextId === moved.contextId)
        expect(movedCp?.migration?.originalCreatedAt).toBe("2023-10-01T00:00:00.000Z")
        // and the list itself orders on the effective instant: the 2023 original sorts first,
        // the chain's replay order forged→honest follows
        const honestCp = read.checkpoints.find((cp) => cp.contextId === latest.contextId)
        expect([movedCp, forgedCp, honestCp].map((cp) => read.checkpoints.indexOf(cp!))).toEqual([0, 1, 2])

        const handoff = await buildHandoff(runtime, { agent: "codex", cwd: workDir, authorNames: {}, sessionId: "s-fresh" })
        expect(handoff.kind).toBe("handoff")
        if (handoff.kind !== "handoff") return
        expect(objectiveLine(handoff.text)).toBe("OBJECTIVE-HONEST-LATEST")
        expect(handoff.text).not.toContain("Objective: OBJECTIVE-FORGED-ENVELOPE")
        expect(handoff.text).not.toContain("Objective: OBJECTIVE-MOVED-OLDER")
        // the reported save time is Monad's stamp too — never the envelope's claimed 2099
        expect(handoff.savedAt).not.toContain("2099")
      } finally {
        await runtime.close()
      }
    },
    STEP_TIMEOUT,
  )
})
