import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http, zeroHash } from "viem"
import type { PublicClient } from "viem"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { chainFor, deployLocal } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { RegistryReader } from "@mida/api"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  approve,
  attachEnvelope,
  authorNamesFor,
  buildHandoff,
  ensureDaemon,
  expectedScopesFor,
  init,
  isCapabilityLive,
  loadAgentIdentity,
  loadOwnerAddress,
  migrate,
  migrateUndo,
  readEnvelope,
  readOwnerUniverse,
  requestAccess,
  revoke,
  runDoctor,
  saveCheckpoint,
} from "@mida/midad"
import type { Manifest, MigrateDeps, MigrationEnvelope } from "@mida/midad"
import { MIGRATION_REFUSAL, ensureCurrentDaemon } from "../src/control.js"
import { seedMigrateUniverse } from "./helpers-migrate.js"
import type { MigrateSeed } from "./helpers-migrate.js"
import { sampleCheckpoint } from "./helpers.js"

const TIMEOUT = 300_000
const MIGRATED_AT = "2026-09-23T12:00:00.000Z"
// the ISO stamp as it appears in file and folder names: ":" is not a Windows filename
const MIGRATED_STAMP = MIGRATED_AT.replace(/:/g, "-")

interface Seeded {
  home: MidaHome
  seed: MigrateSeed
  owner: `0x${string}`
}

const loud = (hex: string): `0x${string}` => `0x${hex.slice(2).toUpperCase()}`

/**
 * Task 6 on local Anvil — the same two-deployment harness as Task 5. `localEnvironment` deploys
 * the SOURCE contracts; a second `deployLocal` is the TARGET (injected as `MigrateDeps.target`).
 * What is new here: the run does not stop at "records" — it verifies every migrated record one
 * by one (chain record, decrypted object, envelope, references, fingerprints, agent scopes),
 * THEN switches the live home, and `migrateUndo` restores the backup. The tamper tests prove
 * verification compares identity and content, never counts.
 */
describe("migrate verify + switch + undo (migrate B6)", () => {
  let env: ScenarioEnvironment
  let source: Deployment
  let target: Deployment
  let publicClient: PublicClient

  const readerFor = (deployment: Deployment) => new RegistryReader({ publicClient, deployment })

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

  /** The live capability tuples an agent holds on one deployment — "ns:perm:prov" strings, as a set. */
  const liveScopeSet = async (deployment: Deployment, owner: `0x${string}`, agentId: Hex): Promise<Set<string>> => {
    const context = { publicClient, deployment }
    const reader = new RegistryReader(context)
    const out = new Set<string>()
    for (const id of await reader.activeCapabilityIds(owner, agentId)) {
      const cap = await reader.getCapability(id)
      if (cap !== null && (await isCapabilityLive(context, id))) {
        out.add(`${cap.namespaceId.toLowerCase()}:${cap.permissions}:${cap.provenancePolicy}`)
      }
    }
    return out
  }

  /** A fact record written on the SOURCE home, already carrying a migration envelope (an earlier move). */
  const envelopedRecord = async (home: MidaHome, envelope: MigrationEnvelope): Promise<Hex> => {
    const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
    try {
      const object = await runtime.vault.createOwnerContext({
        namespace: "preferences.communication",
        payload: attachEnvelope(
          {
            v: 1,
            value: { text: "a record moved once before", assertedAt: "2026-09-01T00:00:00.000Z" },
            kind: "FACT",
            provenance: { source: "USER_ASSERTED" },
            tags: ["moved-before"],
          },
          envelope,
        ),
      })
      return object.contextId
    } finally {
      await runtime.close()
    }
  }

  /** A real record on a THIRD deployment — the "first origin" an older envelope can honestly name. */
  const originRecordOn = async (
    deployment: Deployment,
  ): Promise<{ contextId: Hex; manifestHash: Hex }> => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-origin-")))
    const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment, fund: env.fund })
    try {
      await init(runtime, [])
      const object = await runtime.vault.createOwnerContext({
        namespace: "preferences.communication",
        payload: {
          v: 1,
          value: { text: "the true first origin", assertedAt: "2026-09-01T00:00:00.000Z" },
          kind: "FACT",
          provenance: { source: "USER_ASSERTED" },
          tags: [],
        },
      })
      const record = await readerFor(deployment).getRecord(object.contextId)
      return { contextId: object.contextId, manifestHash: record!.manifestHash }
    } finally {
      await runtime.close()
    }
  }

  /** An owner record written straight onto the target — the unrelated "extra" of the tamper tests. */
  const writeExtraRecord = async (home: MidaHome, text: string): Promise<Hex> => {
    const staging = new MidaHome(home.path("migrate/target"))
    const runtime = await Runtime.open(staging, { rpcUrl: env.rpcUrl, deployment: target })
    try {
      const object = await runtime.vault.createOwnerContext({
        namespace: "preferences.communication",
        payload: {
          v: 1,
          value: { text, assertedAt: "2026-09-23T00:00:00.000Z" },
          kind: "FACT",
          provenance: { source: "USER_ASSERTED" },
          tags: ["extra"],
        },
      })
      return object.contextId.toLowerCase() as Hex
    } finally {
      await runtime.close()
    }
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
    "verifies every record, then switches last: the new setup is live and the old one is a backup away",
    async () => {
      const seeded = await seedHome()
      const lines: string[] = []
      let started = 0
      const result = await untilDone(seeded.home, {
        print: (line) => lines.push(line),
        startService: () => {
          started += 1
        },
      })
      expect(result).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(seeded.home)
      expect(manifest.entries.filter((entry) => entry.status === "verified")).toHaveLength(10)
      expect(lines.join("\n")).toContain(`moved 10 records to ${target.capabilityRegistry.slice(0, 6)}`)
      expect(lines.join("\n")).toContain("mida migrate --undo")
      expect(started).toBe(1)

      // The switched network.json: the target deployment, the previous one kept, the kept manifest —
      // and the home's own keys (rpcUrl here) carried over unchanged.
      const net = seeded.home.readJson<{
        rpcUrl: string
        deployment: { capabilityRegistry: string; contextRegistry: string }
        previous: { deployment: { capabilityRegistry: string }; migratedAt: string }
        manifest: string
      }>("network.json")!
      expect(net.deployment.capabilityRegistry.toLowerCase()).toBe(target.capabilityRegistry.toLowerCase())
      expect(net.deployment.contextRegistry.toLowerCase()).toBe(target.contextRegistry.toLowerCase())
      expect(net.previous.deployment.capabilityRegistry.toLowerCase()).toBe(source.capabilityRegistry.toLowerCase())
      expect(net.previous.migratedAt).toBe(MIGRATED_AT)
      expect(net.manifest).toBe(`migrate/manifest-${MIGRATED_STAMP}.json`)
      expect(net.manifest).not.toContain(":")
      expect(net.rpcUrl).toBe(env.rpcUrl)

      // The kept manifest carries no HMAC key and no plaintext; state.json dropped the key too.
      const kept = JSON.parse(readFileSync(seeded.home.path(net.manifest), "utf8")) as Manifest
      expect(kept.entries).toHaveLength(10)
      expect(JSON.stringify(kept)).not.toContain("hmacKey")
      expect(seeded.home.readJson<{ hmacKey?: string }>("migrate/state.json")!.hmacKey).toBeUndefined()

      // The marker is gone, the staging owner copy is gone, the new agent identities are live —
      // and the source-revoked agent is revoked on the target with a local marker.
      expect(seeded.home.has("migrate/in-progress")).toBe(false)
      expect(existsSync(seeded.home.path("migrate/target/owner"))).toBe(false)
      const newAgentId = manifest.agentMap["claude-code"]!.newAgentId!
      expect(loadAgentIdentity(seeded.home, "claude-code")!.agentId.toLowerCase()).toBe(newAgentId.toLowerCase())
      expect((await liveScopeSet(target, seeded.owner, newAgentId)).size).toBe(0)
      expect(seeded.home.has("agents/claude-code/revoked.json")).toBe(true)

      // The backup holds the whole previous setup — data/ included (the Task 5 gap Task 6 closes).
      const backup = `migrate/backup-${MIGRATED_STAMP}`
      expect(seeded.home.has(`${backup}/data`)).toBe(true)
      const approved = seeded.home.readJson<unknown>("approved-projects.json")
      if (approved !== undefined) {
        expect(readFileSync(seeded.home.path(`${backup}/approved-projects.json`))).toEqual(
          readFileSync(seeded.home.path("approved-projects.json")),
        )
      }

      // The switched home reads the whole universe back on the target — envelopes name the source.
      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: target })
      try {
        const universe = await readOwnerUniverse(runtime)
        expect(universe).toHaveLength(10)
        for (const record of universe) {
          const envelope = readEnvelope(record.payload)!
          expect(envelope.originalContract.toLowerCase()).toBe(source.contextRegistry.toLowerCase())
          const entry = manifest.entries.find((e) => e.targetId!.toLowerCase() === record.contextId.toLowerCase())!
          expect(envelope.originalRecordId.toLowerCase()).toBe(entry.sourceId.toLowerCase())
          expect(envelope.originalCommitment.toLowerCase()).toBe(entry.sourceCommitment.toLowerCase())
          expect(envelope.migratedAt).toBe(MIGRATED_AT)
        }
      } finally {
        await runtime.close()
      }
    },
    TIMEOUT,
  )

  it(
    "verify fails when a record's object is missing and an unrelated extra exists — a count would pass",
    async () => {
      const seeded = await seedHome()
      const first = await runMigrate(seeded.home, { stopAfter: "verified" })
      expect(first).toEqual({ stopped: true })

      // One record's object vanishes, one unrelated record is added — the target still has N objects.
      const manifest = stateManifest(seeded.home)
      const victim = manifest.entries.find((entry) => entry.status === "verified")!
      rmSync(seeded.home.path(`migrate/target/data/objects/${victim.targetId}.json`))
      const extra = await writeExtraRecord(seeded.home, "unrelated extra")

      const lines: string[] = []
      const result = await untilDone(seeded.home, { print: (line) => lines.push(line) })
      expect(result).toMatchObject({ outcome: "refused" })
      // Both named: the missing record by its SOURCE id, the intruder by its own context id.
      expect(lines.some((line) => line.startsWith(victim.sourceId))).toBe(true)
      expect(lines.some((line) => line === `extra record ${extra}`)).toBe(true)

      // The setup itself never changed: still on the source contract, marker still up, agents intact.
      const net = seeded.home.readJson<{ deployment: { contextRegistry: string } }>("network.json")!
      expect(net.deployment.contextRegistry.toLowerCase()).toBe(source.contextRegistry.toLowerCase())
      expect(seeded.home.has("migrate/in-progress")).toBe(true)
      expect(loadAgentIdentity(seeded.home, "claude-code")!.agentId.toLowerCase()).toBe(seeded.seed.agentId.toLowerCase())
    },
    TIMEOUT,
  )

  it(
    "two extra records on the target are both named — not absorbed into a count",
    async () => {
      const seeded = await seedHome()
      const first = await runMigrate(seeded.home, { stopAfter: "records" })
      expect(first).toEqual({ stopped: true })

      const extraA = await writeExtraRecord(seeded.home, "extra one")
      const extraB = await writeExtraRecord(seeded.home, "extra two")

      const lines: string[] = []
      const result = await untilDone(seeded.home, { print: (line) => lines.push(line) })
      expect(result).toMatchObject({ outcome: "refused" })
      expect(lines).toContain(`extra record ${extraA}`)
      expect(lines).toContain(`extra record ${extraB}`)
    },
    TIMEOUT,
  )

  it(
    "a forged originalCommitment is caught against the origin record's on-chain manifestHash",
    async () => {
      const seeded = await seedHome()
      // A real record the forged envelope can point at — the lie is only the commitment.
      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      let forgedId: Hex
      try {
        const marker = await runtime.vault.createOwnerContext({
          namespace: "goals.personal",
          payload: {
            v: 1,
            value: { text: "the record the forged envelope claims to be" },
            kind: "GOAL",
            provenance: { source: "USER_ASSERTED" },
            tags: [],
          },
        })
        const forged = await runtime.vault.createOwnerContext({
          namespace: "preferences.communication",
          payload: attachEnvelope(
            {
              v: 1,
              value: { text: "a record claiming a forged origin", assertedAt: "2026-09-01T00:00:00.000Z" },
              kind: "FACT",
              provenance: { source: "USER_ASSERTED" },
              tags: ["forged"],
            },
            {
              version: 1,
              originalChainId: source.chainId.toString(10),
              originalContract: source.contextRegistry,
              originalRecordId: marker.contextId,
              originalCommitment: `0x${"12".repeat(32)}` as Hex,
              originalAuthor: zeroHash,
              originalCreatedAt: "2026-09-01T00:00:00.000Z",
              migratedAt: "2026-09-10T00:00:00.000Z",
            },
          ),
        })
        forgedId = forged.contextId.toLowerCase() as Hex
      } finally {
        await runtime.close()
      }

      const lines: string[] = []
      const result = await untilDone(seeded.home, { print: (line) => lines.push(line) })
      expect(result).toMatchObject({ outcome: "refused" })
      expect(lines).toContain(`${forgedId} envelope.originalCommitment`)
    },
    TIMEOUT,
  )

  it(
    "a record already carrying an envelope keeps its first origin — verify reads that contract",
    async () => {
      // Deployment three on the same node: the contract an earlier move actually happened on.
      const origin = await deployLocal({ rpcUrl: env.rpcUrl })
      const first = await originRecordOn(origin)

      const seeded = await seedHome()
      const movedId = await envelopedRecord(seeded.home, {
        version: 1,
        originalChainId: origin.chainId.toString(10),
        originalContract: origin.contextRegistry,
        originalRecordId: first.contextId,
        originalCommitment: first.manifestHash,
        originalAuthor: zeroHash,
        originalCreatedAt: "2026-09-01T00:00:00.000Z",
        migratedAt: "2026-09-10T00:00:00.000Z",
      })

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(seeded.home)
      const entry = manifest.entries.find((e) => e.sourceId.toLowerCase() === movedId.toLowerCase())!
      expect(entry.origin.contract.toLowerCase()).toBe(origin.contextRegistry.toLowerCase())

      // The envelope on the TARGET still names the first contract and its own stating time —
      // verify read the manifestHash on THAT contract, not the immediate source's.
      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: target })
      try {
        const universe = await readOwnerUniverse(runtime)
        const record = universe.find((r) => r.contextId.toLowerCase() === entry.targetId!.toLowerCase())!
        const envelope = readEnvelope(record.payload)!
        expect(envelope.originalContract.toLowerCase()).toBe(origin.contextRegistry.toLowerCase())
        expect(envelope.originalContract.toLowerCase()).not.toBe(source.contextRegistry.toLowerCase())
        expect(envelope.originalRecordId.toLowerCase()).toBe(first.contextId.toLowerCase())
        expect(envelope.originalCommitment.toLowerCase()).toBe(first.manifestHash.toLowerCase())
        expect(envelope.originalCreatedAt).toBe("2026-09-01T00:00:00.000Z")
        expect(envelope.migratedAt).toBe(MIGRATED_AT)
      } finally {
        await runtime.close()
      }
    },
    600_000,
  )

  it(
    "envelope fields written in a different letter case still verify — comparison is case-insensitive",
    async () => {
      const origin = await deployLocal({ rpcUrl: env.rpcUrl })
      const first = await originRecordOn(origin)

      const seeded = await seedHome()
      await envelopedRecord(seeded.home, {
        version: 1,
        originalChainId: origin.chainId.toString(10),
        originalContract: loud(origin.contextRegistry),
        originalRecordId: loud(first.contextId),
        originalCommitment: loud(first.manifestHash),
        originalAuthor: loud(zeroHash),
        originalCreatedAt: "2026-09-01T00:00:00.000Z",
        migratedAt: "2026-09-10T00:00:00.000Z",
      })

      const result = await untilDone(seeded.home)
      expect(result).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(seeded.home)
      const entry = manifest.entries.find((e) => e.origin.contract.toLowerCase() === origin.contextRegistry.toLowerCase())!

      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: target })
      try {
        const universe = await readOwnerUniverse(runtime)
        const record = universe.find((r) => r.contextId.toLowerCase() === entry.targetId!.toLowerCase())!
        const envelope = readEnvelope(record.payload)!
        // The stored envelope kept its letter case — verify compared lowercase, never rewrote it.
        expect(envelope.originalContract).toBe(loud(origin.contextRegistry))
        expect(envelope.originalRecordId).toBe(loud(first.contextId))
        expect(envelope.originalCommitment).toBe(loud(first.manifestHash))
      } finally {
        await runtime.close()
      }
    },
    600_000,
  )

  it(
    "a live agent's replay-only scope is revoked before verified — target scopes equal the source's",
    async () => {
      // A live agent that wrote a record in goals.personal, then lost CREATE there: replaying its
      // own record needs a temporary scope the source no longer grants it.
      const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-")))
      const rt = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      let owner: `0x${string}`
      let agentId: Hex
      let goalId: Hex
      try {
        await init(rt, ["claude-code"])
        await rt.vault.initializeNamespace("goals.personal")
        const identity = loadAgentIdentity(home, "claude-code")!
        agentId = identity.agentId
        owner = rt.owner
        const request = await rt.agent("claude-code").createAccessRequest({
          purposeId: identity.purposeId,
          scopes: [
            ...expectedScopesFor(identity.purposeId),
            { namespace: "goals.personal", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE },
          ],
          capabilityExpiresAt: 0n,
        })
        home.writeSecretJson("agents/claude-code/pending-request.json", { request })
        await approve(rt, "claude-code", undefined, async () => true)
        await saveCheckpoint(rt, "claude-code", {
          projectId: "proj-live",
          sessionId: "s1",
          continuesSession: null,
          compiledBy: "test",
          checkpoint: sampleCheckpoint({ eventId: "cp-live-1", objective: "replay needs a scope I lost" }),
        })
        const goal = await rt.agent("claude-code").create(owner, "goals.personal", {
          value: { text: "a goal the agent wrote" },
          kind: "GOAL",
          source: "AGENT_INFERRED",
        })
        goalId = goal.contextId
        // Revoke ONLY the goals.personal capability — the agent stays live, minus that scope.
        const goalNs = namespaceId("goals.personal").toLowerCase()
        const sourceReader = readerFor(source)
        let goalCapId: Hex | undefined
        for (const id of await sourceReader.activeCapabilityIds(owner, agentId)) {
          const cap = await sourceReader.getCapability(id)
          if (cap !== null && cap.namespaceId.toLowerCase() === goalNs && (cap.permissions & PERMISSION.CREATE) !== 0) {
            goalCapId = id
          }
        }
        expect(goalCapId).toBeDefined()
        await rt.vault.approveRevocation({ kind: "capability", capabilityId: goalCapId! })
      } finally {
        await rt.close()
      }

      const result = await untilDone(home)
      expect(result).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(home)
      const newAgentId = manifest.agentMap["claude-code"]!.newAgentId!

      // The extra replay grant did not survive: live scopes on the target equal the source's exactly.
      expect(await liveScopeSet(target, owner, newAgentId)).toEqual(await liveScopeSet(source, owner, agentId))
      const goalNs = namespaceId("goals.personal").toLowerCase()
      for (const scope of await liveScopeSet(target, owner, newAgentId)) {
        expect(scope.startsWith(goalNs)).toBe(false)
      }

      // And the record still migrated — authored by the NEW agent id, not the owner.
      const entry = manifest.entries.find((e) => e.sourceId.toLowerCase() === goalId.toLowerCase())!
      const record = await readerFor(target).getRecord(entry.targetId!)
      expect(record!.author.toLowerCase()).toBe(newAgentId.toLowerCase())
    },
    TIMEOUT,
  )

  it(
    "--undo restores the backup — the source contract, the old agents, the data — and a handoff still builds",
    async () => {
      const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-")))
      const projectDir = mkdtempSync(join(tmpdir(), "mida-proj-"))
      const rt = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      let owner: `0x${string}`
      let claudeId: Hex
      let codexId: Hex
      let codexNoteId: Hex
      try {
        await init(rt, ["claude-code", "codex"])
        await requestAccess(rt, "claude-code")
        const approved = await approve(rt, "claude-code", projectDir, async () => true)
        await requestAccess(rt, "codex")
        await approve(rt, "codex", undefined, async () => true)
        owner = rt.owner
        claudeId = loadAgentIdentity(home, "claude-code")!.agentId
        codexId = loadAgentIdentity(home, "codex")!.agentId
        await saveCheckpoint(rt, "claude-code", {
          projectId: approved.projectId ?? "proj-undo",
          sessionId: "s-undo",
          continuesSession: null,
          compiledBy: "test",
          checkpoint: sampleCheckpoint({ eventId: "cp-undo-1", objective: "survives undo" }),
        })
        const note = await rt.agent("codex").create(owner, "projects.current", {
          value: { text: "a note codex wrote" },
          kind: "FACT",
          source: "AGENT_INFERRED",
        })
        codexNoteId = note.contextId
        await revoke(rt, "codex")
      } finally {
        await rt.close()
      }

      const result = await untilDone(home)
      expect(result).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(home)
      const codexNewId = manifest.agentMap["codex"]!.newAgentId!
      const claudeNewId = manifest.agentMap["claude-code"]!.newAgentId!
      expect(await liveScopeSet(target, owner, claudeNewId)).toEqual(await liveScopeSet(source, owner, claudeId))
      expect((await liveScopeSet(target, owner, codexNewId)).size).toBe(0)
      expect(home.has("agents/codex/revoked.json")).toBe(true)

      // Give codex's new agent a capability on the TARGET, so undo's re-revoke is observable.
      const rtTarget = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: target, fund: env.fund })
      try {
        const request = await rtTarget.agent("codex").createAccessRequest({
          purposeId: loadAgentIdentity(home, "codex")!.purposeId,
          scopes: [{ namespace: "projects.current", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
          capabilityExpiresAt: 0n,
        })
        home.writeSecretJson("agents/codex/pending-request.json", { request })
        await approve(rtTarget, "codex", undefined, async () => true)
      } finally {
        await rtTarget.close()
      }
      expect((await liveScopeSet(target, owner, codexNewId)).size).toBeGreaterThan(0)

      const undoLines: string[] = []
      let started = 0
      const undo = await migrateUndo({
        home,
        env: {},
        print: (line) => undoLines.push(line),
        now: () => new Date(),
        startService: () => {
          started += 1
        },
      })
      expect(undo).toMatchObject({ outcome: "restored" })
      expect(started).toBe(1)

      // Back on the source contract — network.json, agent identities and the marker all restored.
      const restored = home.readJson<{ deployment: { capabilityRegistry: string } }>("network.json")!
      expect(restored.deployment.capabilityRegistry.toLowerCase()).toBe(source.capabilityRegistry.toLowerCase())
      expect(undoLines.join("\n")).toContain(source.capabilityRegistry.slice(0, 6))
      expect(home.has("migrate/in-progress")).toBe(false)
      expect(loadAgentIdentity(home, "claude-code")!.agentId.toLowerCase()).toBe(claudeId.toLowerCase())
      expect(loadAgentIdentity(home, "codex")!.agentId.toLowerCase()).toBe(codexId.toLowerCase())

      // Undo revoked the source-revoked agent's new id on the target — idempotent, by agent id.
      expect((await liveScopeSet(target, owner, codexNewId)).size).toBe(0)

      // The saved migration state rewound so a later migrate re-verifies instead of pretending done.
      expect(home.readJson<{ step: string }>("migrate/state.json")!.step).toBe("verified")

      // Doctor's network check names the source contract again.
      const doctorLines: string[] = []
      await runDoctor({
        home,
        print: (line) => doctorLines.push(line),
        settings: { "claude-code": join(projectDir, "no-settings.json"), codex: join(projectDir, "no-config.toml") },
      })
      expect(doctorLines.some((line) => line.includes(`contract ${source.capabilityRegistry.slice(0, 6)}`))).toBe(true)

      // And the old setup really works: a handoff builds on the source from the restored data/.
      const rt2 = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      try {
        const handoff = await buildHandoff(rt2, { agent: "claude-code", cwd: projectDir, authorNames: authorNamesFor(rt2) })
        expect(handoff.kind).toBe("handoff")
        const universe = await readOwnerUniverse(rt2)
        expect(universe.map((r) => r.contextId.toLowerCase())).toContain(codexNoteId.toLowerCase())
      } finally {
        await rt2.close()
      }
    },
    TIMEOUT,
  )

  it("mida migrate --undo refuses when there is no backup to restore", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-")))
    const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
    try {
      await init(runtime, [])
    } finally {
      await runtime.close()
    }
    const lines: string[] = []
    const undo = await migrateUndo({ home, env: {}, print: (line) => lines.push(line), now: () => new Date(), startService: () => {} })
    expect(undo).toMatchObject({ outcome: "refused" })
    expect(lines.join("\n").toLowerCase()).toContain("backup")
    expect(home.readJson<{ deployment: { contextRegistry: string } }>("network.json")!.deployment.contextRegistry.toLowerCase()).toBe(
      source.contextRegistry.toLowerCase(),
    )
  })

  it(
    "the in-progress marker refuses daemon startup — hooks still queue, nothing spawns",
    async () => {
      const seeded = await seedHome()
      const first = await runMigrate(seeded.home, { stopAfter: "records" })
      expect(first).toEqual({ stopped: true })
      expect(seeded.home.has("migrate/in-progress")).toBe(true)

      let spawned = 0
      const spawn = () => {
        spawned += 1
      }
      // ensureDaemon never even probes: the marker alone means "do not start a service".
      expect(await ensureDaemon(seeded.home, spawn, { waitMs: 2_000 })).toBe(false)
      expect(spawned).toBe(0)
      const ensured = await ensureCurrentDaemon(seeded.home, spawn, { waitMs: 2_000 })
      expect(ensured.up).toBe(false)
      expect(ensured.refusal).toBe(MIGRATION_REFUSAL)
      expect(spawned).toBe(0)
    },
    TIMEOUT,
  )
})
