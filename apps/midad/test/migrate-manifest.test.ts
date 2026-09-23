import { describe, expect, it } from "vitest"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { canonicalBytes, MAX_PAYLOAD_BYTES } from "@mida/protocol"
import type { ContextPayload, Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { zeroHash } from "viem"
import {
  MAX_VALUE_BYTES,
  attachEnvelope,
  buildManifest,
  preflight,
  replayOrder,
} from "@mida/midad"
import type { CheckpointEnvelope, Manifest, MigrationEnvelope, SourceRecord } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

/**
 * Pure tests for the migration manifest (migrate B4): one entry per source record, a content
 * fingerprint, the replay dependency order and the exact destination-size preflight. No chain,
 * no files — every SourceRecord is built by hand, exactly the way Task 3's readOwnerUniverse
 * hands them over.
 */
const MIGRATED_AT = "2026-09-25T10:00:00.000Z"
const HMAC_KEY = new Uint8Array(32).fill(7)

const SOURCE: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x1111111111111111111111111111111111111111",
  contextRegistry: "0x2222222222222222222222222222222222222222",
  deploymentBlock: 1n,
  policyHashV1: `0x${"aa".repeat(32)}`,
  vaultRpId: "mida.local",
  vaultRpIdHash: `0x${"bb".repeat(32)}`,
}
const TARGET: Deployment = { ...SOURCE, contextRegistry: "0x3333333333333333333333333333333333333333" }

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex
const AGENT = id(0xa1)
const AUTHORS = { [AGENT]: "claude-code" }

let seq = 0
/** A SourceRecord shaped exactly like owner-read.ts returns: chain fields plus the decrypted payload. */
function record(over: Partial<SourceRecord> = {}): SourceRecord {
  seq += 1
  const contextId = over.contextId ?? id(seq)
  return {
    contextId,
    namespaceId: id(0x900),
    namespace: "preferences.communication",
    authorId: zeroHash,
    recordType: 0,
    kind: 1,
    provenanceSource: 1,
    lineagePolicy: 0,
    lineageId: contextId,
    parentId: zeroHash,
    version: 1,
    readEpoch: 1n,
    createdAt: 1_758_000_000n,
    expiresAt: 0n,
    manifestHash: id(0x5000 + seq),
    payload: {
      v: 1,
      kind: "FACT",
      provenance: { source: "USER_ASSERTED" },
      value: { text: `fact ${seq}`, assertedAt: "2026-09-18T10:00:00.000Z" },
    },
    references: [],
    ...over,
  }
}

/** The envelope buildManifest must seal beside every record's content. */
function expectedEnvelope(rec: SourceRecord, originalCreatedAt: string): MigrationEnvelope {
  return {
    version: 1,
    originalChainId: SOURCE.chainId.toString(10),
    originalContract: SOURCE.contextRegistry,
    originalRecordId: rec.contextId,
    originalCommitment: rec.manifestHash,
    originalAuthor: rec.authorId,
    originalCreatedAt,
    migratedAt: MIGRATED_AT,
  }
}

const CHECKPOINT_CREATED_AT = sampleCheckpoint().createdAt

function checkpointPayload(value: CheckpointEnvelope): ContextPayload {
  return { v: 1, kind: "EPISODE", provenance: { source: "AGENT_INFERRED" }, value: { ...value } }
}

/**
 * A checkpoint envelope whose destination size — `value` plus the migration envelope, encoded
 * canonically — lands exactly on `targetBytes`. Padding goes into `originalRequest` (one field,
 * up to 6000 chars) after 2000-char progress items close most of the gap, so the result is a
 * fully valid checkpoint: the manifest must see it as a checkpoint and measure it against
 * MAX_VALUE_BYTES, not the payload cap.
 */
function checkpointValueAt(targetBytes: number, migration: MigrationEnvelope): CheckpointEnvelope {
  const checkpoint = sampleCheckpoint({ objective: "x", progress: [], originalRequest: null })
  const value = (): CheckpointEnvelope => ({
    type: "mida.checkpoint.v1",
    projectId: "proj",
    sessionId: "s",
    continuesSession: null,
    compiledBy: "test",
    checkpoint,
  })
  const size = () => canonicalBytes({ ...value(), migration }).length
  while (size() + 2003 <= targetBytes) checkpoint.progress.push("x".repeat(2000))
  const remaining = targetBytes - size()
  // originalRequest renders `null` (4 bytes); a k-char string renders k+2 — so k = remaining + 2.
  if (remaining > 0) checkpoint.originalRequest = "x".repeat(remaining + 2)
  if (size() !== targetBytes) throw new Error(`checkpoint fixture landed on ${size()}, wanted ${targetBytes}`)
  return value()
}

/** A checkpoint record whose destination serialization is exactly `targetBytes`. */
function checkpointRecord(targetBytes: number): SourceRecord {
  const rec = record({ authorId: AGENT })
  const value = checkpointValueAt(targetBytes, expectedEnvelope(rec, CHECKPOINT_CREATED_AT))
  rec.payload = checkpointPayload(value)
  return rec
}

describe("buildManifest", () => {
  it("zero records → empty entries, and agents still land in agentMap (the setup still moves)", () => {
    const manifest = buildManifest([], AUTHORS, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.version).toBe(1)
    expect(manifest.entries).toEqual([])
    expect(manifest.agentMap["claude-code"]).toEqual({ oldAgentId: AGENT })
    expect(manifest.source).toEqual({ chainId: "31337", contextRegistry: SOURCE.contextRegistry })
    expect(manifest.target).toEqual({ chainId: "31337", contextRegistry: TARGET.contextRegistry })
  })

  it("identical payloads are two entries — identity is the sourceId, never the content", () => {
    const value = { text: "the owner prefers plain language", assertedAt: "2026-09-18T10:00:00.000Z" }
    const a = record({ payload: { v: 1, kind: "FACT", provenance: { source: "USER_ASSERTED" }, value } })
    const b = record({ payload: { v: 1, kind: "FACT", provenance: { source: "USER_ASSERTED" }, value: { ...value } } })
    const manifest = buildManifest([a, b], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries.length).toBe(2)
    expect(manifest.entries[0]!.sourceId).toBe(a.contextId)
    expect(manifest.entries[1]!.sourceId).toBe(b.contextId)
    expect(manifest.entries[0]!.sourceId).not.toBe(manifest.entries[1]!.sourceId)
    expect(manifest.entries[0]!.fingerprint).toBe(manifest.entries[1]!.fingerprint)
    expect(manifest.entries[0]!.fingerprint).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("names the owner for owner-authored records and the local agent for agent-authored ones", () => {
    const ownerFact = record()
    const agentFact = record({ authorId: AGENT })
    const manifest = buildManifest([ownerFact, agentFact], AUTHORS, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[0]!.authorName).toBe("owner")
    expect(manifest.entries[1]!.authorName).toBe("claude-code")
    expect(manifest.entries.every((entry) => entry.status === "pending")).toBe(true)
  })

  it("a checkpoint's createdAt is the payload's own; every other record's is the chain record's", () => {
    const cp = record({
      authorId: AGENT,
      payload: checkpointPayload({
        type: "mida.checkpoint.v1",
        projectId: "proj",
        sessionId: "s",
        continuesSession: null,
        compiledBy: "test",
        checkpoint: sampleCheckpoint({ createdAt: "2026-09-01T08:00:00.000Z" }),
      }),
    })
    const fact = record({ createdAt: 1_758_000_000n })
    const manifest = buildManifest([cp, fact], AUTHORS, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[0]!.createdAt).toBe("2026-09-01T08:00:00.000Z")
    expect(manifest.entries[1]!.createdAt).toBe(new Date(1_758_000_000 * 1000).toISOString())
  })

  it("lists a record's references as relations, carrying the source ids", () => {
    const evidence = record({ recordType: 1 })
    const referrer = record({
      references: [
        { relation: "confirmed_from", recordId: evidence.contextId },
        { relation: "supports", recordId: id(0xf00d) },
      ],
    })
    const manifest = buildManifest([evidence, referrer], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[1]!.relations).toEqual([
      { relation: "confirmed_from", sourceId: evidence.contextId },
      { relation: "supports", sourceId: id(0xf00d) },
    ])
  })
})

describe("fingerprint", () => {
  const payload = (): ContextPayload => ({
    v: 1,
    kind: "FACT",
    provenance: { source: "USER_ASSERTED" },
    value: { text: "fingerprint me", assertedAt: "2026-09-18T10:00:00.000Z" },
  })

  it("is HMAC-SHA256 over the canonical payload, keyed by the migration key", () => {
    const rec = record({ payload: payload() })
    const manifest = buildManifest([rec], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[0]!.fingerprint).toBe(`0x${bytesToHex(hmac(sha256, HMAC_KEY, canonicalBytes(rec.payload)))}`)
    const other = buildManifest([rec], {}, SOURCE, TARGET, new Uint8Array(32).fill(9), MIGRATED_AT)
    expect(other.entries[0]!.fingerprint).not.toBe(manifest.entries[0]!.fingerprint)
  })

  it("excludes the migration envelope — a record that moved before fingerprints the same", () => {
    const rec = record({ payload: payload() })
    const enveloped = record({ payload: attachEnvelope(payload(), expectedEnvelope(rec, "2026-09-18T10:00:00.000Z")) })
    const manifest = buildManifest([rec, enveloped], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[0]!.fingerprint).toBe(manifest.entries[1]!.fingerprint)
  })
})

describe("replayOrder", () => {
  it("puts roots before their supersedes (by version) and referenced records before referrers", () => {
    const v1 = record()
    const v2 = record({ parentId: v1.contextId, lineageId: v1.lineageId, version: 2 })
    const v3 = record({ parentId: v2.contextId, lineageId: v1.lineageId, version: 3 })
    const evidence = record({ recordType: 1 })
    const referrer = record({ references: [{ relation: "confirmed_from", recordId: evidence.contextId }] })
    // Deliberately scrambled: the order must come from the graph, not the input order.
    const manifest = buildManifest([v3, referrer, v1, evidence, v2], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    const order = replayOrder(manifest).map((entry) => entry.sourceId)
    expect(order.length).toBe(5)
    expect(order.indexOf(v1.contextId)).toBeLessThan(order.indexOf(v2.contextId))
    expect(order.indexOf(v2.contextId)).toBeLessThan(order.indexOf(v3.contextId))
    expect(order.indexOf(evidence.contextId)).toBeLessThan(order.indexOf(referrer.contextId))
  })

  it("throws relation-cycle when records point at each other", () => {
    const a = record()
    const b = record()
    a.references = [{ relation: "supports", recordId: b.contextId }]
    b.references = [{ relation: "supports", recordId: a.contextId }]
    const manifest = buildManifest([a, b], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(() => replayOrder(manifest)).toThrowError(/relation-cycle/)
  })

  it("a reference to a record outside the manifest orders freely — it is not a dependency", () => {
    const external = record({ references: [{ relation: "supports", recordId: id(0xf00d) }] })
    const plain = record()
    const manifest = buildManifest([external, plain], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(replayOrder(manifest).length).toBe(2)
    expect(manifest.entries[0]!.status).toBe("pending")
  })
})

describe("preflight — the exact size check", () => {
  it("a checkpoint one byte over MAX_VALUE_BYTES after the envelope → one row with bytes and limit", () => {
    const rec = checkpointRecord(MAX_VALUE_BYTES + 1)
    const manifest = buildManifest([rec], AUTHORS, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[0]!.destinationBytes).toBe(MAX_VALUE_BYTES + 1)
    expect(manifest.entries[0]!.limit).toBe(MAX_VALUE_BYTES)
    expect(preflight(manifest)).toEqual([
      { sourceId: rec.contextId, namespace: rec.namespace, bytes: MAX_VALUE_BYTES + 1, limit: MAX_VALUE_BYTES, reason: "too-large" },
    ])
  })

  it("a checkpoint exactly at MAX_VALUE_BYTES → no row", () => {
    const rec = checkpointRecord(MAX_VALUE_BYTES)
    const manifest = buildManifest([rec], AUTHORS, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    expect(manifest.entries[0]!.destinationBytes).toBe(MAX_VALUE_BYTES)
    expect(preflight(manifest)).toEqual([])
  })

  it("a non-checkpoint record over MAX_PAYLOAD_BYTES → too-large row against the payload cap", () => {
    const rec = record({
      payload: { v: 1, kind: "FACT", provenance: { source: "USER_ASSERTED" }, value: { text: "x".repeat(70_000) } },
    })
    const manifest = buildManifest([rec], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    const rows = preflight(manifest)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ sourceId: rec.contextId, reason: "too-large", limit: MAX_PAYLOAD_BYTES })
    expect(rows[0]!.bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES)
  })

  it("a string-valued record cannot carry an envelope → envelope-unplaceable row", () => {
    const rec = record({
      recordType: 1,
      payload: { v: 1, kind: "NONE", provenance: { source: "NONE" }, value: "supporting document" },
    })
    const manifest = buildManifest([rec], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    const rows = preflight(manifest)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ sourceId: rec.contextId, namespace: rec.namespace, reason: "envelope-unplaceable" })
    expect(rows[0]!.bytes).toBe(manifest.entries[0]!.destinationBytes)
    expect(rows[0]!.limit).toBe(manifest.entries[0]!.limit)
  })

  it("every oversized record is named — a pass means zero rows, not a shorter list", () => {
    const big = checkpointRecord(MAX_VALUE_BYTES + 1)
    const bigger = record({
      payload: { v: 1, kind: "FACT", provenance: { source: "USER_ASSERTED" }, value: { text: "y".repeat(70_000) } },
    })
    const fine = record()
    const manifest = buildManifest([big, fine, bigger], AUTHORS, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    const rows = preflight(manifest)
    expect(rows.map((row) => row.sourceId)).toEqual([big.contextId, bigger.contextId])
  })
})

describe("skipped records", () => {
  it("an author with no local identity → skipped:unknown-author; referrers and supersedes dangle, transitively", () => {
    const ghost = record({ authorId: id(0xdead) })
    const viaReference = record({ references: [{ relation: "supports", recordId: ghost.contextId }] })
    const viaSupersede = record({ parentId: ghost.contextId, lineageId: ghost.lineageId, version: 2 })
    const transitive = record({ references: [{ relation: "derived_from", recordId: viaReference.contextId }] })
    const clean = record()
    const manifest = buildManifest(
      [ghost, viaReference, viaSupersede, transitive, clean],
      AUTHORS,
      SOURCE,
      TARGET,
      HMAC_KEY,
      MIGRATED_AT,
    )
    const byId = new Map(manifest.entries.map((entry) => [entry.sourceId, entry]))
    expect(byId.get(ghost.contextId)!.status).toBe("skipped:unknown-author")
    expect(byId.get(ghost.contextId)!.authorName).toBeNull()
    expect(byId.get(viaReference.contextId)!.status).toBe("skipped:dangling-relation")
    expect(byId.get(viaSupersede.contextId)!.status).toBe("skipped:dangling-relation")
    expect(byId.get(transitive.contextId)!.status).toBe("skipped:dangling-relation")
    expect(byId.get(clean.contextId)!.status).toBe("pending")
  })

  it("skipped entries still come back in replayOrder — Task 5 lists them, it does not write them", () => {
    const ghost = record({ authorId: id(0xdead) })
    const dangling = record({ references: [{ relation: "supports", recordId: ghost.contextId }] })
    const manifest = buildManifest([ghost, dangling], {}, SOURCE, TARGET, HMAC_KEY, MIGRATED_AT)
    const order = replayOrder(manifest).map((entry) => entry.sourceId)
    expect(order).toEqual([ghost.contextId, dangling.contextId])
  })
})
