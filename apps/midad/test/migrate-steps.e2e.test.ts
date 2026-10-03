import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http, zeroHash } from "viem"
import type { AbiEvent, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { MAX_PAYLOAD_BYTES, canonicalBytes, namespaceId } from "@mida/protocol"
import type { Hex, ObjectManifest } from "@mida/protocol"
import { capabilityRegistryAbi, chainFor, contextRegistryAbi, deployLocal, getLogsChunked } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, RegistryReader } from "@mida/api"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  isCapabilityLive,
  loadAgentIdentity,
  loadOwnerAddress,
  migrate,
  readEnvelope,
  readOwnerUniverse,
} from "@mida/midad"
import type { Manifest, MigrateDeps, MigrateStep } from "@mida/midad"
import { seedMigrateUniverse } from "./helpers-migrate.js"
import type { MigrateSeed } from "./helpers-migrate.js"

const TIMEOUT = 300_000
const MIGRATED_AT = "2026-09-23T12:00:00.000Z"
// the ISO stamp as it appears in file and folder names: ":" is not a Windows filename
const MIGRATED_STAMP = MIGRATED_AT.replace(/:/g, "-")

const AGENT_REGISTERED = capabilityRegistryAbi.find((e) => e.type === "event" && e.name === "AgentRegistered") as AbiEvent
const CAPABILITY_GRANTED = capabilityRegistryAbi.find((e) => e.type === "event" && e.name === "CapabilityGranted") as AbiEvent
const CONTEXT_REGISTERED = contextRegistryAbi.find((e) => e.type === "event" && e.name === "ContextRegistered") as AbiEvent
const EVIDENCE_REGISTERED = contextRegistryAbi.find((e) => e.type === "event" && e.name === "EvidenceRegistered") as AbiEvent

interface Seeded {
  home: MidaHome
  seed: MigrateSeed
  owner: `0x${string}`
}

interface TargetLogs {
  agentRegistrations: number
  grantTxs: number
  records: number
  recordIds: Hex[]
}

/**
 * Task 5's state machine on local Anvil: `localEnvironment` deploys the SOURCE contracts, a second
 * `deployLocal` on the same node is the TARGET (injected as `MigrateDeps.target`). Every test seeds
 * a fresh home with the Task 3 universe, runs `migrate` — straight through or interrupted by
 * `stopAfter`, which throws a `migrate-stopped` error where a real run would have died — and counts
 * what the TARGET chain actually recorded from its logs.
 */
describe("migrate state machine on local Anvil (migrate B5)", () => {
  let env: ScenarioEnvironment
  let source: Deployment
  let target: Deployment

  const chain = (deployment: Deployment) => ({ publicClient, deployment })
  let publicClient: PublicClient

  const seedHome = async (): Promise<Seeded> => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-")))
    const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
    try {
      const seed = await seedMigrateUniverse(runtime)
      const owner = loadOwnerAddress(home)!
      return { home, seed, owner }
    } finally {
      await runtime.close()
    }
  }

  const runMigrate = (
    seeded: Seeded,
    over: Partial<MigrateDeps> = {},
  ): Promise<{ outcome: string; lines: string[] } | { stopped: true }> =>
    migrate({
      home: seeded.home,
      env: {},
      confirm: async () => true,
      print: () => {},
      now: () => new Date(MIGRATED_AT),
      target,
      ...over,
    }).then(
      (result) => result,
      (error: unknown) => {
        if ((error as { code?: unknown })?.code === "migrate-stopped") return { stopped: true }
        throw error
      },
    )

  /** Re-runs migrate until it reports "moved" — a crash (migrate-stopped) just means run it again. */
  const untilMoved = async (seeded: Seeded, over: Partial<MigrateDeps> = {}) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await runMigrate(seeded, over)
      if ("outcome" in result) return result
    }
    throw new Error("migrate never finished after 60 resumes")
  }

  /** Counts, from the TARGET contract's own logs, what the migration actually wrote. */
  const targetLogs = async (seeded: Seeded, newAgentId: Hex): Promise<TargetLogs> => {
    const head = await publicClient.getBlockNumber()
    const registrations = await getLogsChunked(publicClient, {
      address: target.capabilityRegistry,
      event: AGENT_REGISTERED,
      args: { agentId: newAgentId },
      fromBlock: target.deploymentBlock,
      toBlock: head,
    })
    const grants = await getLogsChunked(publicClient, {
      address: target.capabilityRegistry,
      event: CAPABILITY_GRANTED,
      args: { owner: seeded.owner, agentId: newAgentId },
      fromBlock: target.deploymentBlock,
      toBlock: head,
    })
    const contexts = await getLogsChunked(publicClient, {
      address: target.contextRegistry,
      event: CONTEXT_REGISTERED,
      args: { owner: seeded.owner },
      fromBlock: target.deploymentBlock,
      toBlock: head,
    })
    // `_store` emits ContextRegistered for every record — evidence emits EvidenceRegistered in
    // addition, so counting both events would double-count. ContextRegistered alone is the index.
    return {
      agentRegistrations: registrations.length,
      grantTxs: new Set(grants.map((log) => log.transactionHash)).size,
      records: contexts.length,
      recordIds: contexts.map((log) => (log.args as { contextId: Hex }).contextId.toLowerCase() as Hex),
    }
  }

  /** EvidenceRegistered fires alongside ContextRegistered for evidence records — asserted once. */
  const evidenceEvents = async (seeded: Seeded): Promise<number> => {
    const head = await publicClient.getBlockNumber()
    const logs = await getLogsChunked(publicClient, {
      address: target.contextRegistry,
      event: EVIDENCE_REGISTERED,
      args: { owner: seeded.owner },
      fromBlock: target.deploymentBlock,
      toBlock: head,
    })
    return logs.length
  }

  const stateManifest = (seeded: Seeded): Manifest => {
    const state = seeded.home.readJson<{ manifest: Manifest }>("migrate/state.json")
    expect(state, "migrate/state.json missing").toBeDefined()
    return state!.manifest
  }

  const liveCapabilities = async (deployment: Deployment, owner: `0x${string}`, agentId: Hex): Promise<number> => {
    const context = chain(deployment)
    const reader = new RegistryReader(context)
    let live = 0
    for (const id of await reader.activeCapabilityIds(owner, agentId)) {
      if (await isCapabilityLive(context, id)) live += 1
    }
    return live
  }

  /** The staging home after a run — `migrate/target/` under the real home. */
  const stagingHome = (seeded: Seeded): MidaHome => new MidaHome(seeded.home.path("migrate/target"))

  const pendingCount = (manifest: Manifest): number =>
    manifest.entries.filter((entry) => entry.status === "pending" || entry.status === "sent" || entry.status === "verified").length

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
    "moves the whole seeded universe: one registration, one grant, every record verified — then the switch lands",
    async () => {
      const seeded = await seedHome()
      const result = await untilMoved(seeded)
      expect(result).toMatchObject({ outcome: "moved" })

      const manifest = stateManifest(seeded)
      const newAgentId = manifest.agentMap["claude-code"]!.newAgentId!
      expect(newAgentId).toMatch(/^0x[0-9a-f]{64}$/)
      expect(newAgentId.toLowerCase()).not.toBe(manifest.agentMap["claude-code"]!.oldAgentId.toLowerCase())

      // Exactly one of each on the target — counted from its logs, not from the state file.
      const logs = await targetLogs(seeded, newAgentId)
      expect(logs.agentRegistrations).toBe(1)
      expect(logs.grantTxs).toBe(1)
      expect(logs.records).toBe(pendingCount(manifest))
      expect(logs.records).toBe(10)
      expect(await evidenceEvents(seeded)).toBe(1)

      // Every entry carries a target id, landed and verified; skipped entries are none for this seed.
      const targetReader = new RegistryReader(chain(target))
      for (const entry of manifest.entries) {
        expect(entry.status).toBe("verified")
        expect(entry.targetId).toMatch(/^0x[0-9a-f]{64}$/)
        const record = await targetReader.getRecord(entry.targetId!)
        expect(record, `no target record for ${entry.sourceId}`).not.toBeNull()
        expect(record!.namespaceId.toLowerCase()).toBe(namespaceId(entry.namespace).toLowerCase())
        expect(record!.kind).toBe(entry.kind)
        expect(record!.version).toBe(entry.version)
      }
      for (const id of logs.recordIds) {
        expect(manifest.entries.some((entry) => entry.targetId === id)).toBe(true)
      }

      // Author mapping: the checkpoint's target record names the NEW agent id, owner records name the owner marker.
      const checkpoint = manifest.entries.find((entry) => entry.sourceId === seeded.seed.checkpointId)!
      const checkpointRecord = (await targetReader.getRecord(checkpoint.targetId!))!
      expect(checkpointRecord.author.toLowerCase()).toBe(newAgentId.toLowerCase())
      const fact = manifest.entries.find((entry) => entry.sourceId === seeded.seed.identicalFactIds[0])!
      expect(((await targetReader.getRecord(fact.targetId!))!).author).toBe(zeroHash)

      // The supersede chain keeps its shape on the new ids.
      const chainEntries = seeded.seed.supersedeIds.map((id) => manifest.entries.find((entry) => entry.sourceId === id)!)
      const [v1, v2, v3] = await Promise.all(chainEntries.map((entry) => targetReader.getRecord(entry.targetId!)))
      expect(v1!.parentId).toBe(zeroHash)
      expect(v2!.parentId.toLowerCase()).toBe(chainEntries[0]!.targetId!.toLowerCase())
      expect(v3!.parentId.toLowerCase()).toBe(chainEntries[1]!.targetId!.toLowerCase())
      expect(v2!.lineageId.toLowerCase()).toBe(v1!.lineageId.toLowerCase())
      expect([v1!.version, v2!.version, v3!.version]).toEqual([1, 2, 3])

      // Decrypt the target side as the owner — post-switch that IS the real home: envelopes name
      // the SOURCE contract, the source id and the source commitment — the true origin.
      const switched = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: target })
      try {
        const moved = await readOwnerUniverse(switched)
        expect(moved).toHaveLength(10)
        const byTargetId = new Map(manifest.entries.map((entry) => [entry.targetId!.toLowerCase(), entry]))
        for (const record of moved) {
          const entry = byTargetId.get(record.contextId.toLowerCase())!
          expect(entry, `target record ${record.contextId} is not in the manifest`).toBeDefined()
          const envelope = readEnvelope(record.payload)
          expect(envelope, `no migration envelope on ${record.contextId}`).toBeDefined()
          expect(envelope!.originalRecordId.toLowerCase()).toBe(entry.sourceId.toLowerCase())
          expect(envelope!.originalContract.toLowerCase()).toBe(source.contextRegistry.toLowerCase())
          expect(envelope!.originalCommitment.toLowerCase()).toBe(entry.sourceCommitment.toLowerCase())
          expect(envelope!.originalAuthor.toLowerCase()).toBe(entry.authorId.toLowerCase())
          expect(envelope!.originalChainId).toBe(source.chainId.toString(10))
          expect(envelope!.migratedAt).toBe(MIGRATED_AT)
        }
        // The plain-text evidence record migrated; its envelope sits beside the string value.
        const evidence = moved.find((record) => record.contextId.toLowerCase() === manifest.entries.find((e) => e.sourceId === seeded.seed.evidenceId)!.targetId!.toLowerCase())!
        expect(evidence.payload.value).toBe("supporting document")
        // The referrer's reference was rewritten to the evidence record's TARGET id.
        const referrer = moved.find((record) => record.contextId.toLowerCase() === manifest.entries.find((e) => e.sourceId === seeded.seed.referrerId)!.targetId!.toLowerCase())!
        expect(referrer.references[0]!.recordId.toLowerCase()).toBe(evidence.contextId.toLowerCase())
        // The two identical-text facts arrived as two records.
        const identical = manifest.entries.filter((entry) => seeded.seed.identicalFactIds.includes(entry.sourceId))
        expect(identical.map((entry) => entry.targetId)).toHaveLength(2)
        expect(identical[0]!.targetId).not.toBe(identical[1]!.targetId)
      } finally {
        await switched.close()
      }

      // Rule 8b: the source-revoked agent was granted, copied and re-revoked — nothing live remains,
      // and the moved-in identity carries the local marker.
      expect(await liveCapabilities(target, seeded.owner, newAgentId)).toBe(0)
      expect(seeded.home.has("agents/claude-code/revoked.json")).toBe(true)

      // The switched home: the target contract in network.json, the new agent identity live,
      // owner secrets at 0600, the marker and the staging home gone, the backup kept.
      const realNetwork = seeded.home.readJson<{ deployment: { contextRegistry: string } }>("network.json")!
      expect(realNetwork.deployment.contextRegistry.toLowerCase()).toBe(target.contextRegistry.toLowerCase())
      expect(statSync(seeded.home.path("owner/secrets.json")).mode & 0o777).toBe(0o600)
      expect(loadAgentIdentity(seeded.home, "claude-code")!.agentId.toLowerCase()).toBe(newAgentId.toLowerCase())
      expect(existsSync(seeded.home.path("migrate/in-progress"))).toBe(false)
      expect(existsSync(seeded.home.path("migrate/target"))).toBe(false)
      const backup = `migrate/backup-${MIGRATED_STAMP}`
      expect(backup).not.toContain(":")
      expect(existsSync(seeded.home.path(`${backup}/network.json`))).toBe(true)

      // A home already on the target has nothing to move.
      const again = await runMigrate(seeded)
      expect(again).toMatchObject({ outcome: "nothing-to-move" })
    },
    TIMEOUT,
  )

  for (const step of ["agents", "approvals", "records"] as MigrateStep[]) {
    it(
      `a crash at "${step}" resumes without duplicating a single write`,
      async () => {
        const seeded = await seedHome()
        const first = await runMigrate(seeded, { stopAfter: step })
        expect(first).toEqual({ stopped: true })
        expect(seeded.home.has("migrate/state.json")).toBe(true)

        const result = await untilMoved(seeded)
        expect(result).toMatchObject({ outcome: "moved" })

        const manifest = stateManifest(seeded)
        const newAgentId = manifest.agentMap["claude-code"]!.newAgentId!
        const logs = await targetLogs(seeded, newAgentId)
        expect(logs.agentRegistrations).toBe(1)
        expect(logs.grantTxs).toBe(1)
        expect(logs.records).toBe(10)
        expect(new Set(logs.recordIds).size).toBe(10)
        for (const entry of manifest.entries) expect(entry.status).toBe("verified")
        expect(await liveCapabilities(target, seeded.owner, newAgentId)).toBe(0)
      },
      TIMEOUT,
    )
  }

  it(
    "a record uploaded to the store but never anchored commits exactly once on resume",
    async () => {
      const seeded = await seedHome()
      // Crash right after the first record's PREPARE: nonce + sealed bytes on disk, nothing sent.
      const first = await runMigrate(seeded, { stopAfter: "records" })
      expect(first).toEqual({ stopped: true })

      const manifest = stateManifest(seeded)
      const prepared = manifest.entries.find((entry) => entry.preparedNonce !== undefined)
      expect(prepared, "no prepared record after the records-step crash").toBeDefined()
      const sealedFile = `migrate/sealed/${prepared!.sourceId}.json`
      expect(seeded.home.has(sealedFile)).toBe(true)
      const sealed = seeded.home.readJson<{
        contextId: Hex
        namespaceId: Hex
        manifest: ObjectManifest
        ciphertext: Hex
        onChain: { objectNonce: Hex; expectedParentId: Hex }
      }>(sealedFile)!

      // Simulate the crashed send's first half: the store PUT landed, the chain register never did.
      const staging = stagingHome(seeded)
      const stagingRuntime = await Runtime.open(staging, { rpcUrl: env.rpcUrl, deployment: target })
      try {
        const upload = {
          owner: stagingRuntime.owner,
          namespaceId: sealed.namespaceId,
          objectNonce: sealed.onChain.objectNonce,
          expectedParentId: sealed.onChain.expectedParentId,
          manifest: sealed.manifest,
          ciphertext: sealed.ciphertext,
        }
        if (prepared!.authorName === "owner") {
          await stagingRuntime.ownerApi.putObject(upload)
        } else {
          const name = prepared!.authorName!
          const identity = loadAgentIdentity(staging, name)!
          const grants = staging.readJson<{ capabilities: { capabilityId: Hex; namespaceId: Hex; permissions: number }[] }[]>(`agents/${name}/grants.json`)!
          const capability = grants
            .flatMap((grant) => grant.capabilities)
            .find((cap) => cap.namespaceId.toLowerCase() === sealed.namespaceId.toLowerCase() && (cap.permissions & 2) === 2)
          const agentApi = new ContextApiClient({
            baseUrl: stagingRuntime.apiBaseUrl,
            account: privateKeyToAccount(identity.signerPrivateKey),
            chainId: target.chainId,
            capabilityRegistry: target.capabilityRegistry,
          })
          await agentApi.putObject({ ...upload, capabilityId: capability!.capabilityId })
        }
      } finally {
        await stagingRuntime.close()
      }
      // The object is in the store but the record is still absent from the chain.
      const targetReader = new RegistryReader(chain(target))
      expect(await targetReader.getRecord(sealed.contextId)).toBeNull()

      const result = await untilMoved(seeded)
      expect(result).toMatchObject({ outcome: "moved" })

      // Exactly one chain record for that context id — the persisted sealed bytes, never a re-seal.
      const head = await publicClient.getBlockNumber()
      const registrations = await getLogsChunked(publicClient, {
        address: target.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { owner: seeded.owner, contextId: sealed.contextId },
        fromBlock: target.deploymentBlock,
        toBlock: head,
      })
      expect(registrations).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    "a record too large for its destination refuses at the preview — no migrate/ folder, no target write",
    async () => {
      const seeded = await seedHome()
      const runtime = await Runtime.open(seeded.home, { rpcUrl: env.rpcUrl, deployment: source, fund: env.fund })
      try {
        // Size the fact so the source payload just fits but the destination — with the migration
        // envelope attached — exceeds MAX_PAYLOAD_BYTES. Preflight must refuse the whole run.
        const probe = {
          v: 1 as const,
          kind: "FACT" as const,
          provenance: { source: "USER_ASSERTED" as const },
          value: { text: "", assertedAt: "2026-09-23T00:00:00.000Z" },
          tags: ["preflight"],
        }
        const overhead = canonicalBytes(probe).length
        const text = "x".repeat(MAX_PAYLOAD_BYTES - overhead - 64)
        await runtime.vault.createOwnerContext({
          namespace: "preferences.communication",
          payload: { ...probe, value: { ...probe.value, text } },
        })
      } finally {
        await runtime.close()
      }

      const confirms: string[] = []
      const result = await runMigrate(seeded, { confirm: async (text) => (confirms.push(text), true) })
      expect(result).toMatchObject({ outcome: "refused" })
      // Preflight refused before the confirm was even asked.
      expect(confirms).toHaveLength(0)
      expect(existsSync(seeded.home.path("migrate"))).toBe(false)
      const head = await publicClient.getBlockNumber()
      const contexts = await getLogsChunked(publicClient, {
        address: target.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { owner: seeded.owner },
        fromBlock: target.deploymentBlock,
        toBlock: head,
      })
      expect(contexts).toHaveLength(0)
    },
    TIMEOUT,
  )

  it(
    "a declined preview writes nothing; a later accepted run still completes",
    async () => {
      const seeded = await seedHome()
      const declined = await runMigrate(seeded, { confirm: async () => false })
      expect(declined).toMatchObject({ outcome: "refused" })
      expect(existsSync(seeded.home.path("migrate"))).toBe(false)

      const result = await untilMoved(seeded)
      expect(result).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(seeded)
      const logs = await targetLogs(seeded, manifest.agentMap["claude-code"]!.newAgentId!)
      expect(logs.records).toBe(10)
      expect(logs.agentRegistrations).toBe(1)
    },
    TIMEOUT,
  )

  it(
    "the backup folder's name carries no ':' (a Windows filename cannot hold one)",
    async () => {
      const seeded = await seedHome()
      const first = await runMigrate(seeded, { stopAfter: "backed-up" })
      expect(first).toEqual({ stopped: true })
      const backups = seeded.home.list("migrate").filter((name) => name.startsWith("backup-"))
      expect(backups).toEqual([`backup-${MIGRATED_STAMP}`])
      expect(existsSync(seeded.home.path(`migrate/backup-${MIGRATED_STAMP}/network.json`))).toBe(true)
      // the stamp inside the data keeps its ISO colons; only the name lost them
      expect(seeded.home.readJson<{ migratedAt: string }>("migrate/state.json")!.migratedAt).toBe(MIGRATED_AT)
    },
    TIMEOUT,
  )

  it("refuses a passkey home before touching anything", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-migrate-passkey-")))
    home.writeSecretJson("owner/mode.json", { mode: "passkey" })
    const lines: string[] = []
    const result = await migrate({
      home,
      env: {},
      confirm: async () => true,
      print: (line) => lines.push(line),
      now: () => new Date(MIGRATED_AT),
      target,
    })
    expect(result.outcome).toBe("refused")
    expect(lines.join("\n")).toContain("software-key")
    expect(existsSync(home.path("migrate"))).toBe(false)
  })

  it(
    "a persisted state naming a different target refuses, naming both contracts",
    async () => {
      const seeded = await seedHome()
      const first = await runMigrate(seeded, { stopAfter: "preview" })
      expect(first).toEqual({ stopped: true })

      const other = await deployLocal({ rpcUrl: env.rpcUrl })
      const lines: string[] = []
      const result = await runMigrate(seeded, {
        target: other,
        print: (line) => lines.push(line),
      })
      expect(result).toMatchObject({ outcome: "refused" })
      expect(lines.join("\n")).toContain(target.capabilityRegistry.slice(0, 6))
      expect(lines.join("\n")).toContain(other.capabilityRegistry.slice(0, 6))

      // The original migration still completes against the real target.
      const finished = await untilMoved(seeded)
      expect(finished).toMatchObject({ outcome: "moved" })
      const manifest = stateManifest(seeded)
      const logs = await targetLogs(seeded, manifest.agentMap["claude-code"]!.newAgentId!)
      expect(logs.records).toBe(10)
    },
    600_000,
  )
})
