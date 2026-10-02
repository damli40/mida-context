import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { decodePayload, encodePayload } from "@mida/crypto"
import type { ContextPayload } from "@mida/protocol"
import {
  MidaHome,
  Runtime,
  approve,
  attachEnvelope,
  init,
  movedOnSuffix,
  readCheckpoints,
  readEnvelope,
  readOwnerFacts,
  readOwnerUniverse,
  requestAccess,
  saveCheckpoint,
  unwrapCheckpoint,
  validateMigrationEnvelope,
  wrapCheckpoint,
} from "@mida/midad"
import type { MigrationEnvelope, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

/**
 * The envelope every migrated record carries — where it came from, who wrote it there, and
 * when the move happened. `originalChainId` is the old contract's chain as a decimal string;
 * `migratedAt` is what every reader's "(moved on <date>)" suffix is built from.
 */
const MIGRATION: MigrationEnvelope = {
  version: 1,
  originalChainId: "10143",
  originalContract: "0x1111111111111111111111111111111111111111",
  originalRecordId: `0x${"22".repeat(32)}`,
  originalCommitment: `0x${"33".repeat(32)}`,
  originalAuthor: `0x${"44".repeat(32)}`,
  originalCreatedAt: "2026-09-18T10:00:00.000Z",
  migratedAt: "2026-09-25T10:00:00.000Z",
}

const REQUIRED = [
  "version",
  "originalChainId",
  "originalContract",
  "originalRecordId",
  "originalCommitment",
  "originalAuthor",
  "originalCreatedAt",
  "migratedAt",
] as const

describe("validateMigrationEnvelope", () => {
  it("accepts the example envelope and returns it field-for-field", () => {
    const checked = validateMigrationEnvelope(MIGRATION)
    expect(checked).toEqual({ ok: true, value: MIGRATION })
  })

  it("rejects a missing field, naming it — one case per required field", () => {
    for (const field of REQUIRED) {
      const rest = Object.fromEntries(Object.entries(MIGRATION).filter(([key]) => key !== field))
      const checked = validateMigrationEnvelope(rest)
      expect(checked.ok).toBe(false)
      if (checked.ok) continue
      expect(checked.errors.join("; ")).toContain(field)
    }
  })

  it("rejects version 2 — only version 1 exists", () => {
    const checked = validateMigrationEnvelope({ ...MIGRATION, version: 2 })
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.errors.join("; ")).toContain("version")
  })

  it("rejects wrong field types and shapes, and non-objects", () => {
    expect(validateMigrationEnvelope({ ...MIGRATION, originalChainId: 10143 }).ok).toBe(false)
    expect(validateMigrationEnvelope({ ...MIGRATION, originalContract: "not-hex" }).ok).toBe(false)
    expect(validateMigrationEnvelope({ ...MIGRATION, originalRecordId: "0x1234" }).ok).toBe(false)
    expect(validateMigrationEnvelope({ ...MIGRATION, originalCommitment: `0x${"33".repeat(20)}` }).ok).toBe(false)
    expect(validateMigrationEnvelope({ ...MIGRATION, originalAuthor: "owner" }).ok).toBe(false)
    expect(validateMigrationEnvelope({ ...MIGRATION, originalCreatedAt: "yesterday" }).ok).toBe(false)
    expect(validateMigrationEnvelope({ ...MIGRATION, migratedAt: 1_758_000_000 }).ok).toBe(false)
    expect(validateMigrationEnvelope("moved")).toMatchObject({ ok: false })
    expect(validateMigrationEnvelope(null)).toMatchObject({ ok: false })
    expect(validateMigrationEnvelope(undefined)).toMatchObject({ ok: false })
    expect(validateMigrationEnvelope([])).toMatchObject({ ok: false })
  })

  it("rejects an unknown field — the envelope is a closed shape, not a grab bag", () => {
    const checked = validateMigrationEnvelope({ ...MIGRATION, extra: "x" })
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.errors.join("; ")).toContain("extra")
  })
})

describe("attachEnvelope / readEnvelope", () => {
  const factPayload = (): ContextPayload => ({
    v: 1,
    kind: "PREFERENCE",
    provenance: { source: "USER_ASSERTED" },
    value: { text: "answers in lowercase", assertedAt: "2026-09-18T10:00:00.000Z" },
  })

  it("a fact payload carries the envelope beside text and assertedAt, and the input is not mutated", () => {
    const payload = factPayload()
    const attached = attachEnvelope(payload, MIGRATION)
    expect(attached.value).toMatchObject({ text: "answers in lowercase", assertedAt: "2026-09-18T10:00:00.000Z" })
    expect((attached.value as Record<string, unknown>).migration).toEqual(MIGRATION)
    expect(readEnvelope(attached)).toEqual(MIGRATION)
    expect((payload.value as Record<string, unknown>).migration).toBeUndefined()
  })

  it("a string payload value carries the envelope beside its content — payload.migration, the value never changed", () => {
    const payload: ContextPayload = { v: 1, kind: "NONE", provenance: { source: "NONE" }, value: "just text" }
    const attached = attachEnvelope(payload, MIGRATION)
    expect(attached.value).toBe("just text")
    expect(attached.migration).toEqual(MIGRATION)
    expect(readEnvelope(attached)).toEqual(MIGRATION)
    // the input is not mutated, and attaching again replaces the sibling — the re-migration path
    expect(payload.migration).toBeUndefined()
    const movedAgain = attachEnvelope(attached, { ...MIGRATION, migratedAt: "2026-10-01T00:00:00.000Z" })
    expect(movedAgain.migration).toEqual({ ...MIGRATION, migratedAt: "2026-10-01T00:00:00.000Z" })
    expect(movedAgain.value).toBe("just text")
  })

  it("decodePayload hands the sibling back whole — encode → decode keeps payload.migration", () => {
    const attached = attachEnvelope(
      { v: 1, kind: "NONE", provenance: { source: "NONE" }, value: "supporting document" },
      MIGRATION,
    )
    const decoded = decodePayload(encodePayload(attached))
    expect(decoded.migration).toEqual(MIGRATION)
    expect(decoded.value).toBe("supporting document")
  })

  it("a payload carrying the envelope in BOTH places is invalid — readEnvelope throws invalid-migration-envelope", () => {
    const both: ContextPayload = {
      v: 1,
      kind: "FACT",
      provenance: { source: "USER_ASSERTED" },
      value: { text: "answers in lowercase", assertedAt: "2026-09-18T10:00:00.000Z", migration: MIGRATION },
      migration: MIGRATION,
    }
    expect(() => readEnvelope(both)).toThrowError(/invalid-migration-envelope/)
  })

  it("attachEnvelope refuses an object-valued payload already carrying the sibling — it would carry the envelope twice", () => {
    const payload: ContextPayload = { ...factPayload(), migration: MIGRATION }
    expect(() => attachEnvelope(payload, MIGRATION)).toThrowError(/invalid-migration-envelope/)
  })

  it("a checkpoint payload's value is the CheckpointEnvelope — the envelope lands beside checkpoint", () => {
    const wrapped = wrapCheckpoint({ projectId: "p", sessionId: "s", continuesSession: null, compiledBy: "t", checkpoint: sampleCheckpoint() })
    const payload: ContextPayload = {
      v: 1,
      kind: "EPISODE",
      provenance: { source: "AGENT_INFERRED" },
      value: { ...wrapped },
    }
    const attached = attachEnvelope(payload, MIGRATION)
    expect(readEnvelope(attached)).toEqual(MIGRATION)
    const unwrapped = unwrapCheckpoint(attached.value)
    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.migration).toEqual(MIGRATION)
  })

  it("readEnvelope is undefined when the key is absent or the envelope is invalid", () => {
    const payload = factPayload()
    expect(readEnvelope(payload)).toBeUndefined()
    const bad: ContextPayload = { ...payload, value: { ...(payload.value as Record<string, unknown>), migration: { version: 9 } } }
    expect(readEnvelope(bad)).toBeUndefined()
  })
})

describe("movedOnSuffix", () => {
  it("renders exactly (moved on <YYYY-MM-DD>) taken from migratedAt", () => {
    expect(movedOnSuffix(MIGRATION)).toBe("(moved on 2026-09-25)")
    expect(movedOnSuffix({ ...MIGRATION, migratedAt: "2027-01-02T23:59:59.999Z" })).toBe("(moved on 2027-01-02)")
  })
})

/**
 * The destination round trip (Task 2 step 1): a migrated checkpoint and a migrated fact are
 * written to a local Anvil deployment, read back, re-saved — the checkpoint through
 * wrapCheckpoint(unwrapCheckpoint(x)), the fact as the same payload — and read again. The
 * envelope must be byte-identical at both reads: a read → re-save that drops it is the defect
 * this task fixes.
 */
describe("destination round trip on local Anvil", () => {
  let env: ScenarioEnvironment
  let runtime: Runtime

  beforeAll(async () => {
    env = await localEnvironment()
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    runtime = await Runtime.open(new MidaHome(mkdtempSync(join(tmpdir(), "mida-mig-"))), network)
    await init(runtime, ["claude-code"])
    await requestAccess(runtime, "claude-code")
    await approve(runtime, "claude-code")
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("a migrated checkpoint survives write → read → re-save → read, envelope identical at both reads", async () => {
    const checkpoint = sampleCheckpoint({ eventId: "cp-migrated-01", objective: "the checkpoint that moved" })
    const saved = await saveCheckpoint(runtime, "claude-code", {
      projectId: "proj-migrated",
      sessionId: "s1",
      continuesSession: null,
      compiledBy: "test",
      checkpoint,
      migration: MIGRATION,
    })
    const agent = runtime.agent("claude-code")

    // first read: the sealed value carries the envelope, and readCheckpoints hands it over as a typed field
    const objects1 = await agent.read(runtime.owner, "projects.current")
    const stored1 = objects1.find((object) => object.contextId === saved.contextId)
    expect(stored1).toBeDefined()
    expect(readEnvelope(stored1!.payload)).toEqual(MIGRATION)
    const read1 = await readCheckpoints(runtime, "claude-code", "proj-migrated")
    const carried1 = read1.checkpoints.find((cp) => cp.contextId === saved.contextId)
    expect(carried1).toBeDefined()
    expect(carried1!.migration).toEqual(MIGRATION)

    // re-save: unwrap → wrap → write again, then read — the envelope must come back byte-identical
    const unwrapped = unwrapCheckpoint(stored1!.payload.value)
    expect(unwrapped).not.toBeNull()
    const rewrapped = wrapCheckpoint(unwrapped!)
    expect(rewrapped.migration).toEqual(MIGRATION)
    const resaved = await agent.create(runtime.owner, "projects.current", {
      value: { ...rewrapped },
      kind: "EPISODE",
      source: "AGENT_INFERRED",
      tags: ["mida-checkpoint", checkpoint.eventId],
    })
    const objects2 = await agent.read(runtime.owner, "projects.current")
    const stored2 = objects2.find((object) => object.contextId === resaved.contextId)
    expect(stored2).toBeDefined()
    expect(readEnvelope(stored2!.payload)).toEqual(MIGRATION)
    expect(
      JSON.stringify((stored2!.payload.value as Record<string, unknown>).migration),
    ).toBe(JSON.stringify((stored1!.payload.value as Record<string, unknown>).migration))
    const read2 = await readCheckpoints(runtime, "claude-code", "proj-migrated")
    const carried2 = read2.checkpoints.find((cp) => cp.contextId === resaved.contextId)
    expect(carried2).toBeDefined()
    expect(carried2!.migration).toEqual(MIGRATION)
  })

  it("a migrated fact survives write → read → re-save → read, envelope identical, and its text shows the move date", async () => {
    const payload = attachEnvelope(
      {
        v: 1,
        kind: "PREFERENCE",
        provenance: { source: "USER_ASSERTED" },
        value: { text: "answers in lowercase", assertedAt: "2026-09-18T10:00:00.000Z" },
      },
      MIGRATION,
    )
    await runtime.vault.createOwnerContext({ namespace: "preferences.communication", payload })

    const facts1 = await readOwnerFacts(runtime, "claude-code")
    const moved1 = facts1.find((fact) => fact.text.includes("answers in lowercase"))
    expect(moved1).toBeDefined()
    expect(moved1!.text).toContain("(moved on 2026-09-25)")

    // the fact written again with the same payload — a second record, the same envelope
    await runtime.vault.createOwnerContext({ namespace: "preferences.communication", payload })
    const objects = await runtime.agent("claude-code").read(runtime.owner, "preferences.communication")
    const carried = objects
      .map((object) => (object.payload.value as Record<string, unknown>).migration)
      .filter((migration) => migration !== undefined)
    expect(carried.length).toBeGreaterThanOrEqual(2)
    for (const migration of carried) expect(JSON.stringify(migration)).toBe(JSON.stringify(carried[0]))
    for (const migration of carried) expect(migration).toEqual(MIGRATION)

    const facts2 = await readOwnerFacts(runtime, "claude-code")
    const moved2 = facts2.filter((fact) => fact.text.includes("answers in lowercase"))
    expect(moved2.length).toBeGreaterThanOrEqual(2)
    for (const fact of moved2) expect(fact.text).toContain("(moved on 2026-09-25)")
  })

  it("a migrated string-valued owner record survives write → read → re-save → read, envelope identical", async () => {
    const payload = attachEnvelope(
      { v: 1, kind: "NONE", provenance: { source: "NONE" }, value: "supporting document" },
      MIGRATION,
    )
    const first = await runtime.vault.createOwnerContext({
      namespace: "preferences.communication",
      recordType: "EVIDENCE",
      payload,
    })

    // first read: the sealed payload carries the envelope BESIDE the string value
    const universe1 = await readOwnerUniverse(runtime)
    const stored1 = universe1.find((record) => record.contextId === first.contextId)
    expect(stored1).toBeDefined()
    expect(stored1!.payload.value).toBe("supporting document")
    expect(stored1!.payload.migration).toEqual(MIGRATION)
    expect(readEnvelope(stored1!.payload)).toEqual(MIGRATION)

    // re-save the payload exactly as it was read — the sibling must ride through the read path
    const resaved = await runtime.vault.createOwnerContext({
      namespace: "preferences.communication",
      recordType: "EVIDENCE",
      payload: stored1!.payload,
    })
    const universe2 = await readOwnerUniverse(runtime)
    const stored2 = universe2.find((record) => record.contextId === resaved.contextId)
    expect(stored2).toBeDefined()
    expect(stored2!.payload.value).toBe("supporting document")
    expect(stored2!.payload.migration).toEqual(MIGRATION)
    expect(JSON.stringify(stored2!.payload.migration)).toBe(JSON.stringify(stored1!.payload.migration))
  })

  it("an ordinary record written after the migrated ones reads back with no envelope at all", async () => {
    const checkpoint = sampleCheckpoint({ eventId: "cp-ordinary-01", objective: "never moved" })
    const saved = await saveCheckpoint(runtime, "claude-code", {
      projectId: "proj-migrated",
      sessionId: "s2",
      continuesSession: null,
      compiledBy: "test",
      checkpoint,
    })
    const objects = await runtime.agent("claude-code").read(runtime.owner, "projects.current")
    const stored = objects.find((object) => object.contextId === saved.contextId)
    expect(stored).toBeDefined()
    expect(readEnvelope(stored!.payload)).toBeUndefined()
    expect("migration" in (stored!.payload.value as Record<string, unknown>)).toBe(false)
    const read = await readCheckpoints(runtime, "claude-code", "proj-migrated")
    const carried = read.checkpoints.find((cp) => cp.contextId === saved.contextId)
    expect(carried).toBeDefined()
    expect(carried!.migration).toBeUndefined()
    expect("migration" in carried!).toBe(false)
  })
})
