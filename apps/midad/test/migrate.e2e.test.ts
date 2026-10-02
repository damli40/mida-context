import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, http } from "viem"
import type { AbiEvent, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { canonicalBytes } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { capabilityRegistryAbi, chainFor, contextRegistryAbi, deployLocal, fundLocal, getLogsChunked } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { RegistryReader } from "@mida/api"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { Checkpoint } from "@mida/checkpoint"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  MAX_VALUE_BYTES,
  MidaHome,
  Runtime,
  ServiceRuntime,
  approve,
  attachEnvelope,
  authorNamesFor,
  buildHandoff,
  drainOnce,
  init,
  listJobs,
  loadAgentIdentity,
  loadOrCreateOperatorSecrets,
  loadOwnerAddress,
  migrate,
  migrateUndo,
  readEnvelope,
  readOwnerFacts,
  readOwnerUniverse,
  requestAccess,
  revoke,
  saveCheckpoint,
  wrapCheckpoint,
} from "@mida/midad"
import type { HandoffResult, Manifest, MigrateDeps, MigrationEnvelope, OwnerFact, SourceRecord } from "@mida/midad"
import { seedMigrateUniverse } from "./helpers-migrate.js"
import type { MigrateSeed } from "./helpers-migrate.js"
import { sampleCheckpoint } from "./helpers.js"

const TIMEOUT = 300_000
const MIGRATED_AT = "2026-09-23T12:00:00.000Z"
const MOVED_ON = "(moved on 2026-09-23)"
const HOOK_MAIN = fileURLToPath(new URL("../src/hook-main.ts", import.meta.url))
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

const AGENT_REGISTERED = capabilityRegistryAbi.find((e) => e.type === "event" && e.name === "AgentRegistered") as AbiEvent
const CONTEXT_REGISTERED = contextRegistryAbi.find((e) => e.type === "event" && e.name === "ContextRegistered") as AbiEvent

interface Seeded {
  home: MidaHome
  seed: MigrateSeed
  owner: `0x${string}`
}

/**
 * Task 7 on local Anvil — the end-to-end and crash suite. `localEnvironment` deploys the SOURCE
 * contracts, a second `deployLocal` on the same node is the TARGET (injected as
 * `MigrateDeps.target`), and the seeded universe is the Task 3 fixture. The five groups the spec
 * asks for: (1) a full migration read back through the real reader paths — handoff, approved
 * folders, ordered owner facts, supersession and evidence shapes; (2) a crash between PREPARE and
 * COMMIT and between COMMIT and VERIFY for an agent registration, a fact and a checkpoint, each
 * re-run to convergence with orphan/duplicate counts taken from the TARGET's logs; (3) a hook
 * firing mid-migration — queued, no service, saved on the target after the switch; (4) --undo
 * back to a working old setup; (5) the size preflight at and one byte over the envelope limit.
 */
describe("migrate end-to-end + crash recovery on local Anvil (migrate B7)", () => {
  let env: ScenarioEnvironment
  let source: Deployment
  let target: Deployment
  let publicClient: PublicClient

  const reader = () => new RegistryReader({ publicClient, deployment: target })

  const seedHome = async (): Promise<Seeded> => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-")))
    const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
    try {
      const seed = await seedMigrateUniverse(runtime)
      return { home, seed, owner: loadOwnerAddress(home)! }
    } finally {
      await runtime.close()
    }
  }

  const runMigrate = (
    home: MidaHome,
    over: Partial<MigrateDeps> = {},
  ): Promise<{ outcome: string; lines: string[] } | { stopped: true }> =>
    migrate({
      home,
      env: {},
      confirm: async () => true,
      print: () => {},
      now: () => new Date(MIGRATED_AT),
      target,
      startService: () => {},
      ...over,
    }).then(
      (result) => result,
      (error: unknown) => {
        if ((error as { code?: unknown })?.code === "migrate-stopped") return { stopped: true }
        throw error
      },
    )

  /** Re-runs migrate until it reports an outcome — a simulated crash just means run it again. */
  const untilDone = async (home: MidaHome, over: Partial<MigrateDeps> = {}) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await runMigrate(home, over)
      if ("outcome" in result) return result
    }
    throw new Error("migrate never finished after 60 resumes")
  }

  const stateManifest = (home: MidaHome): Manifest => {
    const state = home.readJson<{ manifest: Manifest }>("migrate/state.json")
    expect(state, "migrate/state.json missing").toBeDefined()
    return state!.manifest
  }

  /** A fresh project folder carrying the marker for the seeded checkpoint's project. */
  const projectDir = (projectId: string): string => {
    const cwd = mkdtempSync(join(tmpdir(), "mida-work-"))
    mkdirSync(join(cwd, ".mida"))
    writeFileSync(join(cwd, ".mida", "project.json"), JSON.stringify({ projectId }))
    return cwd
  }

  /**
   * A second live agent, approved for the seeded checkpoint's project folder — the reader whose
   * handoff/facts view the moved universe and the agent a mid-migration hook can fire for.
   */
  const approveCodex = async (seeded: Seeded, workDir: string): Promise<void> => {
    const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
    try {
      await init(runtime, ["codex"])
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir, async () => true)
    } finally {
      await runtime.close()
    }
  }

  /** The account every agent registration this home makes goes through — the orphan filter. */
  const operatorOf = (home: MidaHome): `0x${string}` =>
    privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey).address

  /** Every AgentRegistered this home's operator emitted on the TARGET — orphan registrations included. */
  const agentRegistrations = async (home: MidaHome): Promise<Hex[]> => {
    const head = await publicClient.getBlockNumber()
    const logs = await getLogsChunked(publicClient, {
      address: target.capabilityRegistry,
      event: AGENT_REGISTERED,
      args: { operator: operatorOf(home) },
      fromBlock: target.deploymentBlock,
      toBlock: head,
    })
    return logs.map((log) => (log.args as { agentId: Hex }).agentId.toLowerCase() as Hex)
  }

  /** The owner's ContextRegistered logs on the TARGET — the moved-records truth, never local files. */
  const targetRecords = async (owner: `0x${string}`, contextId?: Hex): Promise<Hex[]> => {
    const head = await publicClient.getBlockNumber()
    const logs = await getLogsChunked(publicClient, {
      address: target.contextRegistry,
      event: CONTEXT_REGISTERED,
      args: contextId === undefined ? { owner } : { owner, contextId },
      fromBlock: target.deploymentBlock,
      toBlock: head,
    })
    return logs.map((log) => (log.args as { contextId: Hex }).contextId.toLowerCase() as Hex)
  }

  /**
   * What "converged" means for every crash case — all of it read off the TARGET chain: every
   * manifest entry verified, the target holding exactly the manifest's records with each contextId
   * registered once, and no agent registration beyond the manifest's own new ids (zero orphans).
   */
  const assertConverged = async (seeded: Seeded, singleRegistrationIds: Hex[] = []): Promise<Manifest> => {
    const manifest = stateManifest(seeded.home)
    expect(manifest.entries.filter((entry) => entry.status === "verified")).toHaveLength(manifest.entries.length)
    const expectedIds = manifest.entries.map((entry) => entry.targetId!.toLowerCase()).sort()
    const records = (await targetRecords(seeded.owner)).sort()
    expect(records, "the target's record set is not exactly the manifest's — missing or duplicate records").toEqual(expectedIds)
    for (const id of singleRegistrationIds) {
      expect(
        await targetRecords(seeded.owner, id),
        `record ${id} anchored more than once on the target`,
      ).toHaveLength(1)
    }
    const expectedAgents = Object.values(manifest.agentMap).map((map) => map.newAgentId!.toLowerCase()).sort()
    const registrations = (await agentRegistrations(seeded.home)).sort()
    expect(registrations, "operator registrations beyond the manifest's agents — orphan agents").toEqual(expectedAgents)
    return manifest
  }

  beforeAll(async () => {
    env = await localEnvironment()
    source = env.deployment
    target = await deployLocal({ rpcUrl: env.rpcUrl })
    publicClient = createPublicClient({ chain: chainFor(source.chainId), transport: http(env.rpcUrl) })
  }, 1_200_000)

  afterAll(async () => {
    await env?.stop()
  })

  it(
    "the moved universe reads identically — handoff, approved folders, ordered facts, supersession, evidence link",
    async () => {
      const seeded = await seedHome()
      const workDir = projectDir("proj-migrate")
      await approveCodex(seeded, workDir)

      // Capture what a reader gets BEFORE the move — from the source deployment.
      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      let factsBefore: OwnerFact[]
      let handoffBefore: HandoffResult
      let foldersBefore: unknown
      try {
        factsBefore = await readOwnerFacts(runtime, "codex")
        handoffBefore = await buildHandoff(runtime, { agent: "codex", cwd: workDir, authorNames: authorNamesFor(runtime) })
        foldersBefore = seeded.home.readJson<unknown>("approved-projects.json")
      } finally {
        await runtime.close()
      }

      const moved = await untilDone(seeded.home)
      expect(moved).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(seeded.home)

      // The same reads AFTER — against the target deployment on the switched home.
      const runtime2 = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: target, fund: env.fund })
      let factsAfter: OwnerFact[]
      let handoffAfter: HandoffResult
      let universeAfter: SourceRecord[]
      try {
        factsAfter = await readOwnerFacts(runtime2, "codex")
        handoffAfter = await buildHandoff(runtime2, { agent: "codex", cwd: workDir, authorNames: authorNamesFor(runtime2) })
        universeAfter = await readOwnerUniverse(runtime2)
      } finally {
        await runtime2.close()
      }
      const foldersAfter = seeded.home.readJson<unknown>("approved-projects.json")

      // Approved folders: the owner-signed list crosses the move unchanged, signature included.
      expect(foldersAfter).toEqual(foldersBefore)
      const listed = (foldersBefore as { entries?: { agent: string; projectId: string }[] })?.entries ?? []
      expect(listed.some((entry) => entry.agent === "codex" && entry.projectId === "proj-migrate")).toBe(true)

      // The handoff builds on the target and carries the original author and save time.
      if (handoffBefore.kind !== "handoff" || handoffAfter.kind !== "handoff") {
        throw new Error(`handoff did not build on both sides: before=${handoffBefore.kind} after=${handoffAfter.kind}`)
      }
      expect(handoffAfter.text).toContain(MOVED_ON)
      expect(handoffAfter.text).toContain("claude-code")
      // The moved record's displayed instant is its ORIGINAL write day — the time the owner
      // sealed into the migration envelope, read back off the TARGET record itself (in-12 N-1:
      // on the source the same record displays its chain stamp, so before/after instants
      // legitimately differ; the envelope is the only place a writer's claim participates).
      const movedHead = universeAfter.find(
        (record) =>
          record.contextId.toLowerCase() ===
          manifest.entries.find((entry) => entry.sourceId.toLowerCase() === seeded.seed.checkpointId.toLowerCase())!.targetId!.toLowerCase(),
      )!
      const envelope = readEnvelope(movedHead.payload)
      expect(envelope).not.toBeUndefined()
      const originalWriteInstant = new Date(Date.parse(envelope!.originalCreatedAt)).toISOString()
      expect(handoffAfter.text).toContain(originalWriteInstant)
      expect(handoffAfter.savedBy).toBe(handoffBefore.savedBy)
      expect(handoffAfter.savedAt).toBe(originalWriteInstant)

      // "What moved", read back off the TARGET contract — never a value the test seeded itself.
      expect(universeAfter).toHaveLength(10)
      const targetIdOf = (sourceId: Hex): Hex =>
        manifest.entries.find((entry) => entry.sourceId.toLowerCase() === sourceId.toLowerCase())!.targetId!
      const onTarget = (sourceId: Hex): SourceRecord =>
        universeAfter.find((record) => record.contextId.toLowerCase() === targetIdOf(sourceId).toLowerCase())!
      const valueText = (record: SourceRecord): unknown =>
        typeof record.payload.value === "object" && record.payload.value !== null
          ? (record.payload.value as { text?: unknown }).text
          : record.payload.value

      // Identical text is still two distinct records.
      const identicals = universeAfter.filter((record) => valueText(record) === seeded.seed.identicalText)
      expect(identicals).toHaveLength(2)
      expect(new Set(identicals.map((record) => record.contextId.toLowerCase())).size).toBe(2)

      // The v1→v2→v3 supersession chain keeps its shape on the target's own record ids.
      const [v1, v2, v3] = seeded.seed.supersedeIds.map(onTarget) as [SourceRecord, SourceRecord, SourceRecord]
      expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3])
      expect(v2.parentId.toLowerCase()).toBe(v1.contextId.toLowerCase())
      expect(v3.parentId.toLowerCase()).toBe(v2.contextId.toLowerCase())
      expect(v1.lineageId.toLowerCase()).toBe(v1.contextId.toLowerCase())
      expect(v2.lineageId.toLowerCase()).toBe(v1.lineageId.toLowerCase())
      expect(v3.lineageId.toLowerCase()).toBe(v1.lineageId.toLowerCase())

      // in-14 F-2 — the check that can actually fail, replacing the per-lineage one: "current"
      // is what the HANDOFF opens with, not the newest member inside one lineage (in the seeded
      // universe every checkpoint is its own one-record lineage, so that comparison could never
      // move). `seen` is the covered-record list the handoff produced, oldest first — its last
      // entry is the head — so mapped through the manifest it must come back element-for-element:
      // the same records, in the same order, under their target ids.
      expect(
        handoffAfter.seen.map((id) => id.toLowerCase()),
        "the records a handoff covers — and which one it opens with — changed across the move",
      ).toEqual(handoffBefore.seen.map((id) => targetIdOf(id as Hex).toLowerCase()))

      // The referrer still points at the evidence — at the evidence's TARGET id, not the source's.
      const referrer = onTarget(seeded.seed.referrerId)
      expect(referrer.references).toHaveLength(1)
      expect(referrer.references[0]!.relation).toBe("confirmed_from")
      expect(referrer.references[0]!.recordId.toLowerCase()).toBe(targetIdOf(seeded.seed.evidenceId).toLowerCase())

      // The ordered owner-fact list a reader receives — identical, element by element, on both
      // sides (each moved fact's text carries the "(moved on …)" marker). Per the plan this is a
      // strict same-order comparison: a different order is a Tasks 1–6 defect, not a test change.
      const shape = (facts: OwnerFact[]) => facts.map((fact) => ({ namespace: fact.namespace, text: fact.text }))
      expect(shape(factsAfter)).toEqual(shape(factsBefore).map((fact) => ({ ...fact, text: `${fact.text} ${MOVED_ON}` })))

      // The handoff text: original author, plus the "(moved on …)" marker — everything else
      // identical, so stripping the marker, the new record ids and the rendered instants must
      // reproduce the pre-move text exactly. Times are masked rather than compared (in-12 N-1):
      // on the source every record displays its chain stamp, while on the target a moved record
      // displays min(envelope originalCreatedAt, target stamp) — the original write day, asserted
      // precisely against the envelope above — so "saved …", "as they were at …", per-fact
      // instants and relative ages legitimately differ.
      const normalize = (text: string): string =>
        text
          .replace(/ \(moved on \d{4}-\d{2}-\d{2}\)/g, "")
          // a fact's stamp renders `id <8 hex>` WITHOUT the 0x prefix — mask it too, since the
          // moved records carry new target ids the same way the Saved-by `record 0x…` ids do
          .replace(/id [0-9a-fA-F]{8}\b/g, "id *")
          .replace(/0x[0-9a-fA-F]+/g, "0x*")
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<iso>")
          .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, "<day-time>")
          .replace(/\b\d{2}:\d{2} UTC\b/g, "<time>")
          .replace(/\((just now|\d+ \w+ ago)\)/g, "(<ago>)")
      expect(normalize(handoffAfter.text)).toBe(normalize(handoffBefore.text))
    },
    TIMEOUT,
  )

  it(
    "a writer's slow or forged createdAt claim cannot reorder the move — the source's current stays current (in-13b M-1)",
    async () => {
      const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-")))
      const workDir = projectDir("proj-migrate")
      const now = Date.now()
      let handoffBefore!: HandoffResult
      const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      try {
        await init(runtime, ["claude-code"])
        await requestAccess(runtime, "claude-code")
        await approve(runtime, "claude-code", workDir, async () => true)
        const save = (sessionId: string, eventId: string, claim: string, objective: string) =>
          saveCheckpoint(runtime, "claude-code", {
            projectId: "proj-migrate",
            sessionId,
            continuesSession: null,
            compiledBy: "test",
            checkpoint: sampleCheckpoint({ eventId, createdAt: claim, objective }),
          })
        // Landing order on the source chain: the honest clock first, the forged 2027 claim
        // second, the two-minutes-slow clock LAST — by the chain's own stamps s-slow is the
        // newest checkpoint and owns the handoff head before the move.
        await save("s-real", "cp-clock-01", new Date(now).toISOString(), "real-clock session")
        await save("s-forged", "cp-clock-02", "2027-06-01T00:00:00.000Z", "forged-clock session")
        await save("s-slow", "cp-clock-03", new Date(now - 120_000).toISOString(), "slow-clock session")
        handoffBefore = await buildHandoff(runtime, { agent: "claude-code", cwd: workDir, authorNames: authorNamesFor(runtime) })
      } finally {
        await runtime.close()
      }
      if (handoffBefore.kind !== "handoff") throw new Error(`handoff did not build on the source: ${handoffBefore.kind}`)
      expect(handoffBefore.text).toContain("Objective: slow-clock session")

      const moved = await untilDone(home)
      expect(moved).toMatchObject({ outcome: "moved" })

      const runtime2 = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: target, fund: env.fund })
      let handoffAfter!: HandoffResult
      try {
        handoffAfter = await buildHandoff(runtime2, { agent: "claude-code", cwd: workDir, authorNames: authorNamesFor(runtime2) })
      } finally {
        await runtime2.close()
      }
      if (handoffAfter.kind !== "handoff") throw new Error(`handoff did not build on the target: ${handoffAfter.kind}`)
      // Same head on both sides: the slow-clock save landed last on the source and keeps the
      // newest effective instant through the move. On the buggy code the forged claim went into
      // the envelope (2027, collapsing onto its replay stamp) and crowned s-forged; without the
      // forged save, the slow claim would have lost to s-real — both reviewer cases.
      expect(handoffAfter.savedAt).toBe(handoffBefore.savedAt)
      expect(handoffAfter.text).toContain("Objective: slow-clock session")
    },
    TIMEOUT,
  )

  it(
    "crash between PREPARE and COMMIT of the agent registration: the prepared id commits once on re-run",
    async () => {
      const seeded = await seedHome()
      const crashed = await runMigrate(seeded.home, { stopAfter: "agents" })
      expect(crashed).toEqual({ stopped: true })

      // The id and salt were persisted; nothing was sent — the chain must not know the agent yet.
      const manifest = stateManifest(seeded.home)
      const newAgentId = manifest.agentMap["claude-code"]!.newAgentId!
      expect(manifest.agentMap["claude-code"]!.preparedSalt).toBeDefined()
      expect(await reader().getAgent(newAgentId)).toBeNull()
      expect(await agentRegistrations(seeded.home)).toHaveLength(0)

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded)
    },
    TIMEOUT,
  )

  it(
    "crash between COMMIT and VERIFY of the agent registration: the landed registration is re-read, never re-sent",
    async () => {
      const seeded = await seedHome()
      // throwAfterSend fires right after registerAgent lands — before getAgent VERIFY and before
      // the bookkeeping that lets a resume see it. stopAfter cannot reach this window.
      const crashed = await runMigrate(seeded.home, { throwAfterSend: { kind: "agent", nth: 1 } })
      expect(crashed).toEqual({ stopped: true })

      // The send landed; the step never finished — the registration is on chain, unbookkept.
      const manifest = stateManifest(seeded.home)
      const newAgentId = manifest.agentMap["claude-code"]!.newAgentId!
      expect(await reader().getAgent(newAgentId)).not.toBeNull()
      expect(await agentRegistrations(seeded.home)).toEqual([newAgentId.toLowerCase() as Hex])
      expect(seeded.home.readJson<{ step: string }>("migrate/state.json")!.step).toBe("target-setup")

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded)
      // …and the re-run registered no second agent for that id.
      expect(await agentRegistrations(seeded.home)).toEqual([newAgentId.toLowerCase() as Hex])
    },
    TIMEOUT,
  )

  it(
    "crash between PREPARE and COMMIT of a checkpoint: the sealed bytes are committed once on re-run",
    async () => {
      const seeded = await seedHome()
      const crashed = await runMigrate(seeded.home, { stopAfter: "records" })
      expect(crashed).toEqual({ stopped: true })

      // The checkpoint is the first record replayed: prepared (sealed bytes + predicted id
      // persisted) but never sent — the target holds nothing of this owner yet.
      const manifest = stateManifest(seeded.home)
      const entry = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.checkpointId.toLowerCase())!
      expect(entry.preparedNonce).toBeDefined()
      expect(entry.targetId).toBeDefined()
      expect(entry.status).toBe("pending")
      expect(await targetRecords(seeded.owner)).toHaveLength(0)

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded, [entry.targetId!])
    },
    TIMEOUT,
  )

  it(
    "crash between COMMIT and VERIFY of a checkpoint: the anchored record is re-read, never re-registered",
    async () => {
      const seeded = await seedHome()
      // The checkpoint is replay-order first — nth:1 is its sendSealed.
      const crashed = await runMigrate(seeded.home, { throwAfterSend: { kind: "record", nth: 1 } })
      expect(crashed).toEqual({ stopped: true })

      const manifest = stateManifest(seeded.home)
      const entry = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.checkpointId.toLowerCase())!
      expect(entry.status).toBe("pending")
      // The record landed on the target without its status write — exactly once, already.
      expect(await reader().getRecord(entry.targetId!)).not.toBeNull()
      expect(await targetRecords(seeded.owner, entry.targetId!)).toHaveLength(1)

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded, [entry.targetId!])
    },
    TIMEOUT,
  )

  it(
    "crash between PREPARE and COMMIT of a fact: the earlier record is committed, the fact prepared, on re-run",
    async () => {
      const seeded = await seedHome()
      // First crash: the checkpoint's PREPARE. Second run commits it, then crashes at the next
      // record's PREPARE — the owner-authored fact is second in replay order.
      for (let run = 0; run < 2; run += 1) {
        const crashed = await runMigrate(seeded.home, { stopAfter: "records" })
        expect(crashed).toEqual({ stopped: true })
      }

      const manifest = stateManifest(seeded.home)
      const checkpoint = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.checkpointId.toLowerCase())!
      const fact = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.identicalFactIds[0].toLowerCase())!
      expect(checkpoint.status).toBe("sent")
      expect(fact.preparedNonce).toBeDefined()
      expect(fact.targetId).toBeDefined()
      expect(fact.status).toBe("pending")
      // The chain shows the same picture: only the checkpoint was sent.
      expect(await targetRecords(seeded.owner)).toEqual([checkpoint.targetId!.toLowerCase() as Hex])

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded, [fact.targetId!])
    },
    TIMEOUT,
  )

  it(
    "crash between COMMIT and VERIFY of a fact: the anchored fact is re-read, never re-registered",
    async () => {
      const seeded = await seedHome()
      // Replay order: checkpoint (1st send), factA (2nd send — the owner-authored path).
      const crashed = await runMigrate(seeded.home, { throwAfterSend: { kind: "record", nth: 2 } })
      expect(crashed).toEqual({ stopped: true })

      const manifest = stateManifest(seeded.home)
      const checkpoint = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.checkpointId.toLowerCase())!
      const fact = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.identicalFactIds[0].toLowerCase())!
      expect(checkpoint.status).toBe("sent")
      expect(fact.status).toBe("pending")
      // The fact's send landed; its status write did not.
      expect(await reader().getRecord(fact.targetId!)).not.toBeNull()
      expect(await targetRecords(seeded.owner, fact.targetId!)).toHaveLength(1)

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded, [fact.targetId!])
    },
    TIMEOUT,
  )

  it(
    "a hook mid-migration queues the job and starts nothing; after the switch the drain saves it on the TARGET",
    async () => {
      const seeded = await seedHome()
      const workDir = projectDir("proj-migrate")
      await approveCodex(seeded, workDir)
      const homeDir = mkdtempSync(join(tmpdir(), "mida-userhome-"))
      const sessionsDir = join(homeDir, ".codex", "sessions", "2026", "09", "23")
      mkdirSync(sessionsDir, { recursive: true })
      const transcript = join(sessionsDir, "rollout-hook.jsonl")
      writeFileSync(
        transcript,
        [
          JSON.stringify({ timestamp: "2026-09-23T10:00:00.000Z", type: "session_meta", payload: { cwd: workDir } }),
          JSON.stringify({ timestamp: "2026-09-23T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hook fired mid-migration" }] } }),
        ].join("\n") + "\n",
      )

      // Interrupt mid-flight — the marker is up, so no service may start.
      const crashed = await runMigrate(seeded.home, { stopAfter: "records" })
      expect(crashed).toEqual({ stopped: true })
      expect(seeded.home.has("migrate/in-progress")).toBe(true)

      // The real hook path: a real process invocation, the real suppression check inside it.
      const res = spawnSync(process.execPath, ["--import", "tsx", HOOK_MAIN, "codex"], {
        input: JSON.stringify({
          hook_event_name: "Stop",
          session_id: "hook-s1",
          transcript_path: transcript,
          cwd: workDir,
        }),
        env: { ...process.env, MIDA_HOME: seeded.home.root, HOME: homeDir },
        encoding: "utf8",
        timeout: 20_000,
        cwd: REPO_ROOT,
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toBe("")

      // Queued — and nothing started: the suppression log is the hook's own record of refusing
      // to spawn, and no daemon socket or pointer exists to connect to.
      const jobs = listJobs(seeded.home)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({ agent: "codex", sessionId: "hook-s1", event: "Stop" })
      const hookLog = existsSync(seeded.home.path("logs/hook.jsonl"))
        ? readFileSync(seeded.home.path("logs/hook.jsonl"), "utf8")
        : ""
      expect(hookLog).toContain("migration-in-progress")
      expect(seeded.home.has("midad.sock")).toBe(false)
      expect(seeded.home.has("midad.sock.path")).toBe(false)

      const moved = await untilDone(seeded.home)
      expect(moved).toMatchObject({ outcome: "moved" })
      expect(listJobs(seeded.home)).toHaveLength(1)

      // Now the queued job drains — on the switched home, against the TARGET contract.
      const compile = async (input: CompileInput): Promise<CompileResult> => ({
        ok: true,
        checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
        compiledBy: "stub",
        droppedKeys: [],
        trimmed: [],
        attempts: 1,
        retried: 0,
        format: "claude-jsonl",
        messagesKept: 1,
        messagesTotal: 1,
        charsSent: 0,
        modelMs: 0,
      })
      const drained = await drainOnce({
        home: seeded.home,
        open: () => ServiceRuntime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: target, fund: env.fund }),
        compile,
        homeDir,
        minGapMs: 0,
        firstGapMs: 0,
      })
      expect(drained).toMatchObject({ saved: 1, failed: 0 })

      // The drain's checkpoint landed on the TARGET — the 10 moved records plus this one,
      // and it is a NEW contextId, not a replayed one.
      const manifest = stateManifest(seeded.home)
      const movedIds = new Set(manifest.entries.map((entry) => entry.targetId!.toLowerCase()))
      const records = await targetRecords(seeded.owner)
      expect(records).toHaveLength(11)
      const fresh = records.filter((id) => !movedIds.has(id))
      expect(fresh).toHaveLength(1)
      // …and the source deployment gained nothing from the drain.
      const sourceLogs = await getLogsChunked(publicClient, {
        address: source.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { owner: seeded.owner },
        fromBlock: source.deploymentBlock,
      })
      expect(sourceLogs).toHaveLength(10)
    },
    TIMEOUT,
  )

  it(
    "migrateUndo puts the old setup back — the handoff builds on the source deployment again",
    async () => {
      const seeded = await seedHome()
      const workDir = projectDir("proj-migrate")
      await approveCodex(seeded, workDir)
      const moved = await untilDone(seeded.home)
      expect(moved).toMatchObject({ outcome: "moved" })

      const undone = await migrateUndo({
        home: seeded.home,
        env: {},
        print: () => {},
        now: () => new Date(MIGRATED_AT),
        startService: () => {},
      })
      expect(undone).toMatchObject({ outcome: "restored" })
      const net = seeded.home.readJson<{ deployment: { contextRegistry: string } }>("network.json")!
      expect(net.deployment.contextRegistry.toLowerCase()).toBe(source.contextRegistry.toLowerCase())

      // The restored setup is a working old setup: the handoff builds against the SOURCE and the
      // records read back without a move marker — they were never moved from its point of view.
      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      try {
        const handoff = await buildHandoff(runtime, { agent: "codex", cwd: workDir, authorNames: authorNamesFor(runtime) })
        if (handoff.kind !== "handoff") {
          throw new Error(`handoff did not build on the restored source: ${handoff.kind} (${handoff.text})`)
        }
        expect(handoff.text).toContain("prove owner reads everything")
        expect(handoff.text).not.toContain("moved on")
        expect(await readOwnerUniverse(runtime)).toHaveLength(10)
      } finally {
        await runtime.close()
      }
    },
    TIMEOUT,
  )

  // ── size preflight ──────────────────────────────────────────────────────────────────────────
  // The write path measures a checkpoint on its envelope (payload.value) against MAX_VALUE_BYTES,
  // with the migration envelope already attached. The tuner pads progress entries until the
  // canonical size is exact — one entry of N chars costs N+3 bytes (the `,"` wrapper) and a grown
  // last entry one byte per char, so the loop converges exactly rather than estimating.

  const probeEnvelope: MigrationEnvelope = {
    version: 1,
    originalChainId: "31337",
    originalContract: "0x0000000000000000000000000000000000000001",
    originalRecordId: `0x${"00".repeat(32)}` as Hex,
    originalCommitment: `0x${"00".repeat(32)}` as Hex,
    originalAuthor: `0x${"00".repeat(32)}` as Hex,
    originalCreatedAt: "2026-09-23T00:00:00.000Z",
    migratedAt: MIGRATED_AT,
  }

  /** The `migration` member's exact cost on a wrapped checkpoint envelope, in canonical bytes. */
  const migrationCost = canonicalBytes({ k: 1, migration: probeEnvelope }).length - canonicalBytes({ k: 1 }).length

  const wrappedSize = (checkpoint: Checkpoint): number =>
    canonicalBytes(
      wrapCheckpoint({
        projectId: "proj-migrate",
        sessionId: "s-size",
        continuesSession: null,
        compiledBy: "preflight",
        checkpoint,
      }),
    ).length

  const sizedCheckpoint = (wantBytes: number): Checkpoint => {
    const checkpoint = sampleCheckpoint({ eventId: "cp-size-01", objective: "a checkpoint padded to the byte" })
    checkpoint.progress = []
    for (let step = 0; step < 200; step += 1) {
      const gap = wantBytes - wrappedSize(checkpoint)
      if (gap === 0) return checkpoint
      if (gap < 0) {
        const last = checkpoint.progress.length - 1
        if (last < 0) throw new Error("size tuner overshot with nothing to shrink")
        checkpoint.progress[last] = checkpoint.progress[last]!.slice(0, checkpoint.progress[last]!.length + gap)
        continue
      }
      const last = checkpoint.progress.length - 1
      if (last >= 0 && gap <= 3) {
        // Too little room for a new entry — grow the last one; every added char is a byte.
        if (checkpoint.progress[last]!.length + gap <= 2000) {
          checkpoint.progress[last] += "x".repeat(gap)
          continue
        }
        // The last entry is full: shrink it just enough that a new 1-char entry lands exactly.
        checkpoint.progress[last] = checkpoint.progress[last]!.slice(0, 2000 - (4 - gap))
        checkpoint.progress.push("x")
        continue
      }
      const overhead = last < 0 ? 2 : 3
      if (gap <= overhead) throw new Error(`size tuner stuck: gap ${gap} with no entry to grow`)
      checkpoint.progress.push("x".repeat(Math.min(2000, gap - overhead)))
    }
    throw new Error(`size tuner did not converge: ${wrappedSize(checkpoint)} vs ${wantBytes}`)
  }

  /** Writes a sized checkpoint as an owner record in the checkpoint namespace; returns its id. */
  const writeSizedCheckpoint = async (seeded: Seeded, wantBytes: number): Promise<Hex> => {
    const checkpoint = sizedCheckpoint(wantBytes)
    const wrapped = wrapCheckpoint({
      projectId: "proj-migrate",
      sessionId: "s-size",
      continuesSession: null,
      compiledBy: "preflight",
      checkpoint,
    })
    // Sanity: the size the manifest will measure — canonical bytes with the envelope attached —
    // is exactly wantBytes + the migration member's cost.
    const withMigration = attachEnvelope(
      { v: 1, value: wrapped as unknown as Record<string, unknown>, kind: "EPISODE", provenance: { source: "USER_ASSERTED" }, tags: [] },
      probeEnvelope,
    )
    expect(canonicalBytes(withMigration.value).length).toBe(wantBytes + migrationCost)
    const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
    try {
      const written = await runtime.vault.createOwnerContext({
        namespace: "projects.current",
        payload: {
          v: 1,
          value: wrapped as unknown as Record<string, unknown>,
          kind: "EPISODE",
          provenance: { source: "USER_ASSERTED" },
          tags: ["preflight"],
        },
      })
      return written.contextId
    } finally {
      await runtime.close()
    }
  }

  it(
    "a checkpoint one byte over the envelope-adjusted limit is refused before any side effect",
    async () => {
      const seeded = await seedHome()
      const sourceId = await writeSizedCheckpoint(seeded, MAX_VALUE_BYTES + 1 - migrationCost)

      let confirms = 0
      const result = await runMigrate(seeded.home, {
        confirm: async () => {
          confirms += 1
          return true
        },
      })
      expect(result).toMatchObject({ outcome: "refused" })
      const lines = "lines" in result ? result.lines.join("\n") : ""
      // The refusal names the record, its namespace and both byte counts — and it never asked.
      expect(lines).toContain(sourceId.toLowerCase())
      expect(lines).toContain("projects.current")
      expect(lines).toContain("bytes")
      expect(confirms).toBe(0)

      // No side effect at all: no migration state, no marker, and nothing on the TARGET chain.
      expect(existsSync(seeded.home.path("migrate"))).toBe(false)
      expect(await targetRecords(seeded.owner)).toHaveLength(0)
      expect(await agentRegistrations(seeded.home)).toHaveLength(0)
    },
    TIMEOUT,
  )

  it(
    "a checkpoint exactly at the envelope-adjusted limit passes the preflight and moves",
    async () => {
      const seeded = await seedHome()
      await writeSizedCheckpoint(seeded, MAX_VALUE_BYTES - migrationCost)

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      expect(await targetRecords(seeded.owner)).toHaveLength(11)
      const manifest = stateManifest(seeded.home)
      expect(manifest.entries.filter((entry) => entry.status === "verified")).toHaveLength(11)
    },
    TIMEOUT,
  )

  // ── Sep 24 fix: a self-paid agent wallet is topped up before each record it replays ──────────
  // The real failure: claude-code's wallet was funded once in the agents step, then a dozen
  // replays drained it and the records step died on `Signer had insufficient balance` — forever,
  // because a resume skips the agents step. These three tests pin the records-step guard.

  it(
    "an agent wallet drained mid-replay is topped up before EACH of its remaining records",
    async () => {
      const seeded = await seedHome()
      // A second agent-authored record: re-approve the seed agent, write one more checkpoint,
      // re-revoke — the replay grant then has to carry both sends from the same wallet.
      const writer = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      try {
        await requestAccess(writer, "claude-code")
        await approve(writer, "claude-code")
        await saveCheckpoint(writer, "claude-code", {
          projectId: "proj-migrate",
          sessionId: "s2",
          continuesSession: null,
          compiledBy: "test",
          checkpoint: sampleCheckpoint({ eventId: "cp-migrate-02", objective: "a second record the same agent replays" }),
        })
        await revoke(writer, "claude-code")
      } finally {
        await writer.close()
      }

      // Crash after the FIRST record send — replay-order first is the seed checkpoint (its
      // createdAt predates every owner record's), so its sendSealed already landed on the target.
      const crashed = await runMigrate(seeded.home, { throwAfterSend: { kind: "record", nth: 1 } })
      expect(crashed).toEqual({ stopped: true })
      const manifest = stateManifest(seeded.home)
      const first = manifest.entries.find((e) => e.sourceId.toLowerCase() === seeded.seed.checkpointId.toLowerCase())!
      expect(await reader().getRecord(first.targetId!)).not.toBeNull()

      // The Sep 24 shape: the agents step funded the wallet once, the replay drained it.
      const identity = loadAgentIdentity(new MidaHome(seeded.home.path("migrate/target")), "claude-code")!
      const agentAddress = privateKeyToAccount(identity.signerPrivateKey).address
      await fundLocal(env.rpcUrl, agentAddress, 0n)
      expect(await publicClient.getBalance({ address: agentAddress })).toBe(0n)

      // One funding check per agent-authored COMMIT — the resend of the first record plus the
      // second record's real send — and without them the drained wallet kills the second send.
      const funded = vi.spyOn(Runtime.prototype, "ensureFunded")
      try {
        const result = await untilDone(seeded.home)
        expect(result).toMatchObject({ outcome: "moved" })
        const topUps = funded.mock.calls.filter((call) => call[1] === "claude-code's wallet")
        expect(topUps).toHaveLength(2)
      } finally {
        funded.mockRestore()
      }
      await assertConverged(seeded)
    },
    TIMEOUT,
  )

  it(
    "a resume that begins at the records step re-funds the drained agent wallet instead of dying on it",
    async () => {
      const seeded = await seedHome()
      // stopAfter fires inside the first record's PREPARE — the agents step is finished, so the
      // resume begins at the records step and the agents-step funding never runs again.
      const crashed = await runMigrate(seeded.home, { stopAfter: "records" })
      expect(crashed).toEqual({ stopped: true })

      const identity = loadAgentIdentity(new MidaHome(seeded.home.path("migrate/target")), "claude-code")!
      const agentAddress = privateKeyToAccount(identity.signerPrivateKey).address
      await fundLocal(env.rpcUrl, agentAddress, 0n)

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      await assertConverged(seeded)
    },
    TIMEOUT,
  )

  it(
    "a reachable sponsor pays instead — the records step never calls ensureFunded",
    async () => {
      const seeded = await seedHome()
      // Reachable (GET answers 200) but refusing (POST 500): the reachability probe says the
      // sponsor is up, so no wallet is topped up; every send falls back to self-pay, which lands
      // because the seed left the owner, operator and agent wallets funded on the local node.
      const sponsor = createServer((request, response) => {
        if (request.method === "GET") {
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify({ name: "mida-gas-sponsor" }))
          return
        }
        response.statusCode = 500
        response.end("{}")
      })
      await new Promise<void>((resolve) => sponsor.listen(0, "127.0.0.1", () => resolve()))
      const address = sponsor.address()
      const sponsorUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`

      const funded = vi.spyOn(Runtime.prototype, "ensureFunded")
      try {
        const result = await untilDone(seeded.home, { env: { MIDA_SPONSOR_URL: sponsorUrl } })
        expect(result).toMatchObject({ outcome: "moved" })
        expect(funded).not.toHaveBeenCalled()
      } finally {
        funded.mockRestore()
        await new Promise<void>((resolve) => sponsor.close(() => resolve()))
      }
      await assertConverged(seeded)
    },
    TIMEOUT,
  )
})
