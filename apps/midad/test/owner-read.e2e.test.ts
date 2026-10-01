import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zeroHash } from "viem"
import {
  CONTEXT_KIND,
  OWNER_AUTHOR_ID,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  namespaceId,
} from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, Runtime, attachEnvelope, init, readOwnerUniverse } from "@mida/midad"
import type { MigrationEnvelope, Network, SourceRecord } from "@mida/midad"
import { seedMigrateUniverse } from "./helpers-migrate.js"
import type { MigrateSeed } from "./helpers-migrate.js"

/**
 * Plan B Task 3 on local Anvil: `readOwnerUniverse` rebuilds the owner's whole record set from
 * owner-filtered `ContextRegistered` logs plus the owner-signed store list, decrypting each object
 * with keys derived from the owner seed — no agent capability or reader wrap involved. The seeded
 * universe spans four namespaces (one no agent can read), two record types, an agent author and
 * two read epochs.
 */
describe("readOwnerUniverse on local Anvil (migrate B3)", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  let seed: MigrateSeed
  let universe: SourceRecord[]

  const byId = (id: Hex): SourceRecord => {
    const found = universe.find((r) => r.contextId === id)
    expect(found, `record ${id} missing from the owner universe`).toBeDefined()
    return found!
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-owner-read-")))
    runtime = await Runtime.open(home, network)
    seed = await seedMigrateUniverse(runtime)
    universe = await readOwnerUniverse(runtime)
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("returns every record the owner has — the whole seeded universe, nothing missing and nothing extra", () => {
    expect(universe.map((r) => r.contextId).sort()).toEqual([...seed.allIds].sort())
    expect(universe).toHaveLength(10)
  })

  it("the two identical-text facts come back as TWO records — identity is the contextId, not the content", () => {
    const pair = seed.identicalFactIds.map(byId)
    expect(pair[0]!.contextId).not.toBe(pair[1]!.contextId)
    for (const record of pair) {
      expect(record.namespace).toBe("preferences.communication")
      expect(record.namespaceId).toBe(namespaceId("preferences.communication"))
      expect(record.authorId).toBe(OWNER_AUTHOR_ID)
      expect(record.kind).toBe(CONTEXT_KIND.PREFERENCE)
      expect(record.provenanceSource).toBe(PROVENANCE_SOURCE.USER_ASSERTED)
      expect((record.payload.value as { text: string }).text).toBe(seed.identicalText)
    }
  })

  it("the superseded chain keeps one lineageId, a parentId chain and versions 1-3", () => {
    const v1 = byId(seed.supersedeIds[0])
    const v2 = byId(seed.supersedeIds[1])
    const v3 = byId(seed.supersedeIds[2])
    expect(v1.parentId).toBe(zeroHash)
    expect(v1.lineageId).toBe(v1.contextId)
    expect(v1.version).toBe(1)
    expect(v2.parentId).toBe(v1.contextId)
    expect(v2.lineageId).toBe(v1.lineageId)
    expect(v2.version).toBe(2)
    expect(v3.parentId).toBe(v2.contextId)
    expect(v3.lineageId).toBe(v1.lineageId)
    expect(v3.version).toBe(3)
    for (const record of [v1, v2, v3]) {
      expect(record.namespace).toBe("profile.skills")
      expect(record.recordType).toBe(RECORD_TYPE.CONTEXT)
    }
  })

  it("authors and record types are the chain's truth, not the payload's", () => {
    const checkpoint = byId(seed.checkpointId)
    expect(checkpoint.authorId).toBe(seed.agentId)
    expect(checkpoint.recordType).toBe(RECORD_TYPE.CONTEXT)
    expect(checkpoint.kind).toBe(CONTEXT_KIND.EPISODE)
    expect(checkpoint.provenanceSource).toBe(PROVENANCE_SOURCE.AGENT_INFERRED)
    expect(checkpoint.namespace).toBe("projects.current")

    const evidence = byId(seed.evidenceId)
    expect(evidence.recordType).toBe(RECORD_TYPE.EVIDENCE)
    expect(evidence.kind).toBe(CONTEXT_KIND.NONE)
    expect(evidence.provenanceSource).toBe(PROVENANCE_SOURCE.NONE)
    expect(evidence.authorId).toBe(OWNER_AUTHOR_ID)
    // evidence anchors no lineage
    expect(evidence.lineageId).toBe(zeroHash)
    expect(evidence.parentId).toBe(zeroHash)
    expect(evidence.version).toBe(1)
  })

  it("references come from the decrypted payload — the referrer points at the evidence record", () => {
    const referrer = byId(seed.referrerId)
    expect(referrer.provenanceSource).toBe(PROVENANCE_SOURCE.USER_CONFIRMED)
    expect(referrer.references).toEqual([...seed.references])
    expect(referrer.references[0]!.recordId).toBe(seed.evidenceId)
    // records without references carry an empty list, not undefined
    expect(byId(seed.checkpointId).references).toEqual([])
  })

  it("records in a namespace no agent can read are included — discovered from the logs, not a list in code", () => {
    const goal = byId(seed.privateGoalId)
    expect(goal.namespace).toBe("goals.personal")
    expect(goal.namespaceId).toBe(namespaceId("goals.personal"))
    expect((goal.payload.value as { text: string }).text).toBe("a goal no agent can see")
    // all three goals.personal records are there
    for (const id of [seed.privateGoalId, seed.evidenceId, seed.referrerId]) {
      expect(byId(id).namespace).toBe("goals.personal")
    }
  })

  it("records sealed under the old read epoch still decrypt — and the post-rotation record reports epoch 2", () => {
    expect(byId(seed.checkpointId).readEpoch).toBe(1n)
    expect(byId(seed.privateGoalId).readEpoch).toBe(1n)
    expect(byId(seed.postRotationId).readEpoch).toBe(2n)
    // the payload really decrypted: the post-rotation fact's text is readable
    expect((byId(seed.postRotationId).payload.value as { text: string }).text).toBe("written after the rotation")
  })

  it("chain metadata matches getRecord exactly — the manifestHash is the on-chain commitment", async () => {
    for (const id of seed.allIds) {
      const record = await runtime.reader.getRecord(id)
      const source = byId(id)
      expect(source.manifestHash).toBe(record!.manifestHash)
      expect(source.createdAt).toBe(record!.createdAt)
      expect(source.expiresAt).toBe(record!.expiresAt)
      expect(source.authorId).toBe(record!.author)
    }
  })

  it("an owner with no records gets an empty universe — not an error", async () => {
    const emptyHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-owner-read-empty-")))
    const emptyRuntime = await Runtime.open(emptyHome, network)
    try {
      await init(emptyRuntime, [])
      expect(await readOwnerUniverse(emptyRuntime)).toEqual([])
    } finally {
      await emptyRuntime.close()
    }
  })

  it("a string-valued record's migration envelope sits beside the content — the sibling survives the owner read intact", async () => {
    // The seeded evidence record's `value` is a plain string; a moved record like it carries
    // the envelope at `payload.migration`, and the read path must hand it back whole.
    const migration: MigrationEnvelope = {
      version: 1,
      originalChainId: network.deployment.chainId.toString(10),
      originalContract: network.deployment.contextRegistry,
      originalRecordId: `0x${"55".repeat(32)}`,
      originalCommitment: `0x${"66".repeat(32)}`,
      originalAuthor: `0x${"77".repeat(32)}`,
      originalCreatedAt: "2026-09-18T10:00:00.000Z",
      migratedAt: "2026-09-25T10:00:00.000Z",
    }
    const payload = attachEnvelope(
      { v: 1, kind: "NONE", provenance: { source: "NONE" }, value: "a plain-text record that moved" },
      migration,
    )
    const written = await runtime.vault.createOwnerContext({
      namespace: "goals.personal",
      recordType: "EVIDENCE",
      payload,
    })
    const reread = await readOwnerUniverse(runtime)
    const found = reread.find((record) => record.contextId === written.contextId)
    expect(found).toBeDefined()
    expect(found!.payload.value).toBe("a plain-text record that moved")
    expect(found!.payload.migration).toEqual(migration)
  })

  it("a record on chain whose object is gone from the store throws owner-read-incomplete naming it", async () => {
    // the last test in the file — it deletes a row from the local store's object dir for good
    home.remove(`data/objects/${seed.checkpointId}.json`)
    const failure = await readOwnerUniverse(runtime).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: "owner-read-incomplete" })
    const ids = (failure as { contextIds?: string[] }).contextIds ?? []
    expect(ids).toContain(seed.checkpointId)
    expect((failure as Error).message).toContain(seed.checkpointId)
  })
})
