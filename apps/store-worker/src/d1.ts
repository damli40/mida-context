import { MidaError, assertHex } from "@mida/protocol"
import type { Address, Hex, ReaderEpochWrap, StorageRef } from "@mida/protocol"
import { contentHash, verifyContent } from "@mida/storage"
import type { ContextStorage } from "@mida/storage"
import { REQUEST_WINDOW_SECONDS, SWEEP_MAX_OBJECTS_PER_RUN } from "@mida/api"
import type {
  BatchedSaveWire,
  BatchSaveRow,
  BatchSaveState,
  BatchStore,
  ContextStores,
  DenyStore,
  ManifestIndexEntry,
  NonceStore,
  ObjectStore,
  RevocationIntent,
  StoredObject,
  WrapKey,
} from "@mida/api"

/**
 * The slice of the Cloudflare D1 API these stores use, declared structurally so this package needs no Workers
 * types: a real `D1Database` (from the binding, or from Miniflare in tests) satisfies it.
 */
export interface D1RunResult {
  success: boolean
  meta: { changes?: number; rows_written?: number }
}
export interface D1AllResult<T> {
  success: boolean
  results: T[]
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<D1RunResult>
  first<T>(column?: string): Promise<T | null>
  all<T>(): Promise<D1AllResult<T>>
}
export interface D1Like {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown[]>
}

/** D1 `.run()` reports how many rows a statement changed; INSERT OR IGNORE and UPDATE both rely on it. */
function changes(result: D1RunResult): number {
  return result.meta.changes ?? result.meta.rows_written ?? 0
}

interface ObjectRow {
  context_id: string
  owner: string
  uploader: string
  namespace_id: string
  author_id: string
  object_nonce: string
  expected_parent_id: string
  manifest: string
  manifest_hash: string
  ciphertext_hash: string
  uploaded_at: string
  anchored_at: string | null
}

function objectFrom(row: ObjectRow): StoredObject {
  return {
    contextId: row.context_id as Hex,
    owner: row.owner as Address,
    uploader: row.uploader as Address,
    namespaceId: row.namespace_id as Hex,
    authorId: row.author_id as Hex,
    objectNonce: row.object_nonce as Hex,
    expectedParentId: row.expected_parent_id as Hex,
    manifest: JSON.parse(row.manifest) as StoredObject["manifest"],
    manifestHash: row.manifest_hash as Hex,
    uploadedAt: row.uploaded_at,
    anchoredAt: row.anchored_at,
  }
}

interface DenyRow {
  id: string
  owner: string
  target_kind: "capability" | "agent"
  target_id: string
  state: RevocationIntent["state"]
  agent_epoch_at_intent: string | null
  cancellation_nonce: string | null
}

function denyFrom(row: DenyRow): RevocationIntent {
  return {
    id: row.id as Hex,
    owner: row.owner as Address,
    target:
      row.target_kind === "capability"
        ? { kind: "capability", capabilityId: row.target_id as Hex }
        : { kind: "agent", agentId: row.target_id as Hex },
    state: row.state,
    agentEpochAtIntent: row.agent_epoch_at_intent,
    cancellationNonce: row.cancellation_nonce,
  }
}

/**
 * The §9.2 blob store as one D1 table: ciphertext and manifest envelopes live in a BLOB column keyed by their
 * sha256. `get` still runs the same verify-the-bytes-against-the-hash check every implementation must.
 * `created_at` records when the blob entered the store — the sweep's young-blob grace reads it.
 */
export class D1BlobStorage implements ContextStorage {
  constructor(readonly db: D1Like) {}

  async put(blob: Uint8Array): Promise<StorageRef[]> {
    const hash = contentHash(blob)
    await this.db.prepare("INSERT OR IGNORE INTO blobs (hash, bytes, created_at) VALUES (?, ?, ?)").bind(hash, blob, new Date().toISOString()).run()
    return [{ provider: "mida-api", locator: hash }]
  }

  async get(hash: Hex, _hints?: StorageRef[]): Promise<Uint8Array> {
    const key = assertHex(hash, 32)
    const row = await this.db.prepare("SELECT bytes FROM blobs WHERE hash = ?").bind(key).first<{ bytes: ArrayBuffer | Uint8Array }>()
    if (row === null) throw new MidaError("NOT_FOUND", `no blob ${key}`)
    return verifyContent(key, new Uint8Array(row.bytes))
  }
}

/** The D1-backed ObjectStore: the object metadata, wraps and manifest index as SQLite rows. */
export class D1ObjectStore implements ObjectStore {
  readonly blobs: D1BlobStorage

  constructor(readonly db: D1Like) {
    this.blobs = new D1BlobStorage(db)
  }

  async putObject(object: StoredObject): Promise<void> {
    // One atomic write attempt; the existing row's manifest hash decides whether this PUT was a repeat
    // (free no-op) or a commitment attack (rejected), regardless of which instance won the race.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO objects
           (context_id, owner, uploader, namespace_id, author_id, object_nonce, expected_parent_id, manifest, manifest_hash, ciphertext_hash, size, uploaded_at, anchored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        object.contextId.toLowerCase(),
        object.owner.toLowerCase(),
        object.uploader.toLowerCase(),
        object.namespaceId.toLowerCase(),
        object.authorId.toLowerCase(),
        object.objectNonce.toLowerCase(),
        object.expectedParentId.toLowerCase(),
        JSON.stringify(object.manifest),
        object.manifestHash.toLowerCase(),
        object.manifest.ciphertextHash.toLowerCase(),
        object.manifest.ciphertextSize,
        object.uploadedAt,
        object.anchoredAt,
      )
      .run()
    const row = await this.db.prepare("SELECT manifest_hash FROM objects WHERE context_id = ?").bind(object.contextId.toLowerCase()).first<{ manifest_hash: string }>()
    if (row === null) throw new Error("object write did not persist")
    if (row.manifest_hash !== object.manifestHash.toLowerCase()) {
      throw new MidaError("COMMITMENT_MISMATCH", "a different manifest is already stored for this contextId")
    }
  }

  async getObject(contextId: Hex): Promise<StoredObject | undefined> {
    const row = await this.db.prepare("SELECT * FROM objects WHERE context_id = ?").bind(contextId.toLowerCase()).first<ObjectRow>()
    return row === null ? undefined : objectFrom(row)
  }

  async listObjects(owner: Address, namespaceId: Hex): Promise<StoredObject[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM objects WHERE owner = ? AND namespace_id = ?")
      .bind(owner.toLowerCase(), namespaceId.toLowerCase())
      .all<ObjectRow>()
    return results
      .map(objectFrom)
      .sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.contextId < b.contextId ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1))
  }

  async putObjectWithinPending(object: StoredObject, maxPendingBytes: number, blob: Uint8Array, pendingSince?: Date): Promise<"stored" | "repeat" | "over-cap"> {
    verifyContent(object.manifest.ciphertextHash, blob)
    // The row and its blob land in ONE batch — a sweep can never land between them and delete the
    // blob of a row about to exist. The blob insert follows the row insert and writes only when a
    // matching row is there afterwards ("stored" or "repeat"), so a refused or mismatched PUT leaves
    // no orphan blob behind. Inside one transaction the ordering is cosmetic; the guard — not the
    // order — is what stops a blob the quota did not admit. `pendingSince` restricts the pending sum
    // to uploads at or after it — the app's quota-window cutoff, so orphans past the window cannot
    // block new writes here either; omitted, every unmarked row counts as before.
    const pendingFilter = pendingSince === undefined ? "" : "AND uploaded_at >= ?"
    const inserted = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO objects
             (context_id, owner, uploader, namespace_id, author_id, object_nonce, expected_parent_id, manifest, manifest_hash, ciphertext_hash, size, uploaded_at, anchored_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM objects WHERE context_id = ?)
             AND (SELECT COALESCE(SUM(size), 0) FROM objects WHERE uploader = ? AND anchored_at IS NULL ${pendingFilter}) + ? <= ?`,
        )
        .bind(
          object.contextId.toLowerCase(),
          object.owner.toLowerCase(),
          object.uploader.toLowerCase(),
          object.namespaceId.toLowerCase(),
          object.authorId.toLowerCase(),
          object.objectNonce.toLowerCase(),
          object.expectedParentId.toLowerCase(),
          JSON.stringify(object.manifest),
          object.manifestHash.toLowerCase(),
          object.manifest.ciphertextHash.toLowerCase(),
          object.manifest.ciphertextSize,
          object.uploadedAt,
          object.anchoredAt,
          object.contextId.toLowerCase(),
          object.uploader.toLowerCase(),
          ...(pendingSince === undefined ? [] : [pendingSince.toISOString()]),
          object.manifest.ciphertextSize,
          maxPendingBytes,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO blobs (hash, bytes, created_at)
           SELECT ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM objects WHERE context_id = ? AND manifest_hash = ?)`,
        )
        .bind(
          object.manifest.ciphertextHash.toLowerCase(),
          blob,
          object.uploadedAt,
          object.contextId.toLowerCase(),
          object.manifestHash.toLowerCase(),
        ),
    ]) as D1RunResult[]
    if (changes(inserted[0]!) > 0) return "stored"
    // 0 changes is ambiguous by design of WHERE-guarded inserts: the row either already exists
    // (repeat or commitment attack) or the sum refused the cap — the stored row decides which.
    const row = await this.db.prepare("SELECT manifest_hash FROM objects WHERE context_id = ?").bind(object.contextId.toLowerCase()).first<{ manifest_hash: string }>()
    if (row === null) return "over-cap"
    if (row.manifest_hash !== object.manifestHash.toLowerCase()) {
      throw new MidaError("COMMITMENT_MISMATCH", "a different manifest is already stored for this contextId")
    }
    return "repeat"
  }

  async pendingByUploader(uploader: Address): Promise<StoredObject[]> {
    // Only never-anchored rows feed the quota scan — marked rows are proven permanently and are
    // excluded here, which is what bounds the scan to work that is still outstanding.
    const { results } = await this.db
      .prepare("SELECT * FROM objects WHERE uploader = ? AND anchored_at IS NULL ORDER BY uploaded_at ASC")
      .bind(uploader.toLowerCase())
      .all<ObjectRow>()
    return results.map(objectFrom)
  }

  async markAnchored(contextId: Hex, anchoredAt: string): Promise<void> {
    // AND anchored_at IS NULL makes the mark first-write-wins: set once, never updated, never cleared.
    await this.db
      .prepare("UPDATE objects SET anchored_at = ? WHERE context_id = ? AND anchored_at IS NULL")
      .bind(anchoredAt, contextId.toLowerCase())
      .run()
  }

  async putWrap(wrap: ReaderEpochWrap): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO wraps (owner, namespace_id, read_epoch, agent_id, agent_key_version, wrap)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        wrap.owner.toLowerCase(),
        wrap.namespaceId.toLowerCase(),
        wrap.readEpoch,
        wrap.agentId.toLowerCase(),
        wrap.agentKeyVersion,
        JSON.stringify(wrap),
      )
      .run()
  }

  async getWrap(key: WrapKey): Promise<ReaderEpochWrap | undefined> {
    const row = await this.db
      .prepare("SELECT wrap FROM wraps WHERE owner = ? AND namespace_id = ? AND read_epoch = ? AND agent_id = ? AND agent_key_version = ?")
      .bind(key.owner.toLowerCase(), key.namespaceId.toLowerCase(), key.readEpoch, key.agentId.toLowerCase(), key.agentKeyVersion)
      .first<{ wrap: string }>()
    return row === null ? undefined : (JSON.parse(row.wrap) as ReaderEpochWrap)
  }

  async setManifestIndex(bodyHash: Hex, envelopeHash: Hex, opts?: { storedAt?: string; verifiedAt?: string | null }): Promise<void> {
    // stored_at is set only on the row's first write: a repointing PUT or a re-upload keeps the original
    // store time, so re-uploading cannot keep unverified staging bytes alive past the 24 h window.
    await this.db
      .prepare(
        `INSERT INTO manifest_index (body_hash, envelope_hash, stored_at, verified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (body_hash) DO UPDATE SET envelope_hash = excluded.envelope_hash, verified_at = excluded.verified_at`,
      )
      .bind(bodyHash.toLowerCase(), envelopeHash.toLowerCase(), opts?.storedAt ?? new Date().toISOString(), opts?.verifiedAt ?? null)
      .run()
  }

  async getManifestIndex(bodyHash: Hex): Promise<ManifestIndexEntry | undefined> {
    const row = await this.db
      .prepare("SELECT envelope_hash, stored_at, verified_at FROM manifest_index WHERE body_hash = ?")
      .bind(bodyHash.toLowerCase())
      .first<{ envelope_hash: string; stored_at: string; verified_at: string | null }>()
    return row === null ? undefined : { envelopeHash: row.envelope_hash as Hex, storedAt: row.stored_at, verifiedAt: row.verified_at }
  }

  /** One statement, atomic across instances: the insert-or-increment happens inside SQLite, not read-then-write. */
  async recordPut(signer: Address, day: string): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO puts (signer, day, count) VALUES (?, ?, 1)
         ON CONFLICT (signer, day) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(signer.toLowerCase(), day)
      .first<{ count: number }>()
    if (row === null) throw new Error("the PUT counter did not return a count")
    return row.count
  }

  /** Same one-statement atomic count as `recordPut`, on the separate manifest table. */
  async recordManifestPut(signer: Address, day: string): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO manifest_puts (signer, day, count) VALUES (?, ?, 1)
         ON CONFLICT (signer, day) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(signer.toLowerCase(), day)
      .first<{ count: number }>()
    if (row === null) throw new Error("the manifest PUT counter did not return a count")
    return row.count
  }

  async sweepPending(olderThan: Date, stillPending: (object: StoredObject) => Promise<boolean>, blobGraceCutoff?: Date): Promise<number> {
    // With no grace asked for, a cutoff far in the future keeps every blob deletable — same as today.
    const blobCutoff = blobGraceCutoff?.toISOString() ?? "9999-12-31T23:59:59.999Z"
    // ISO-8601 UTC strings sort chronologically, so the cutoff is a plain string comparison. Marked
    // rows are skipped outright — the anchoring fact is permanent — and an unmarked row stillPending
    // reports anchored gets its mark here, so the next sweep never asks about it again. LIMIT bounds
    // the chain reads one invocation can spend; oldest-first plus the 15-minute cron drains a backlog
    // in tranches instead of dying against the platform subrequest limit at the same row every day.
    const { results } = await this.db
      .prepare("SELECT * FROM objects WHERE uploaded_at < ? AND anchored_at IS NULL ORDER BY uploaded_at ASC LIMIT ?")
      .bind(olderThan.toISOString(), SWEEP_MAX_OBJECTS_PER_RUN)
      .all<ObjectRow>()
    const deletable: ObjectRow[] = []
    const anchored: string[] = []
    for (const row of results) {
      let pending: boolean
      try {
        pending = await stillPending(objectFrom(row))
      } catch {
        // A failed chain read skips the row entirely — not deleted, not marked — so the next run
        // retries it, and the failure cannot freeze the sweep on one row for every later run.
        continue
      }
      if (pending) deletable.push(row)
      else anchored.push(row.context_id)
    }
    if (deletable.length === 0 && anchored.length === 0) return 0
    const markedAt = new Date().toISOString()
    const statements = [
      // AND anchored_at IS NULL is the race guard: a row that anchored between our SELECT and this
      // statement reports 0 changes and survives — its blob then survives the reference guard below.
      ...deletable.map((row) => this.db.prepare("DELETE FROM objects WHERE context_id = ? AND anchored_at IS NULL").bind(row.context_id)),
      // The row's ciphertext blob dies with it, but only when no remaining row references the hash:
      // another object (two uploads of identical ciphertext share one blob) or a manifest_index row
      // (an envelope with identical bytes). These run after every object delete in the same batch,
      // so the guards see the final row set. created_at is the young-blob grace: a fresh blob belongs
      // to a PUT still landing its row, and outlives this delete.
      ...deletable.map((row) =>
        this.db
          .prepare(
            `DELETE FROM blobs WHERE hash = ? AND created_at < ?
             AND NOT EXISTS (SELECT 1 FROM objects WHERE ciphertext_hash = ?)
             AND NOT EXISTS (SELECT 1 FROM manifest_index WHERE envelope_hash = ?)`,
          )
          .bind(row.ciphertext_hash, blobCutoff, row.ciphertext_hash, row.ciphertext_hash),
      ),
      ...anchored.map((id) => this.db.prepare("UPDATE objects SET anchored_at = ? WHERE context_id = ? AND anchored_at IS NULL").bind(markedAt, id)),
    ]
    const settled = (await this.db.batch(statements)) as D1RunResult[]
    // Report rows actually deleted — a race-marked row's DELETE changes nothing and is not counted.
    return settled.slice(0, deletable.length).reduce((total, result) => total + changes(result), 0)
  }

  async sweepManifests(olderThan: Date, blobGraceCutoff?: Date): Promise<number> {
    const { results } = await this.db
      .prepare("SELECT body_hash, envelope_hash FROM manifest_index WHERE verified_at IS NULL AND stored_at < ?")
      .bind(olderThan.toISOString())
      .all<{ body_hash: string; envelope_hash: string }>()
    if (results.length === 0) return 0
    // With no grace asked for, a cutoff far in the future keeps every blob deletable — same as today.
    const blobCutoff = blobGraceCutoff?.toISOString() ?? "9999-12-31T23:59:59.999Z"
    // The blob survives if anything still references its hash: another index row (same envelope can sit under
    // another body hash in principle) or an object's ciphertext_hash — never a dangling-content delete.
    // The created_at clause is the same young-blob grace the object sweep applies.
    await this.db.batch([
      ...results.map((row) => this.db.prepare("DELETE FROM manifest_index WHERE body_hash = ?").bind(row.body_hash)),
      ...results.map((row) =>
        this.db
          .prepare(
            `DELETE FROM blobs WHERE hash = ? AND created_at < ?
             AND NOT EXISTS (SELECT 1 FROM manifest_index WHERE envelope_hash = ?)
             AND NOT EXISTS (SELECT 1 FROM objects WHERE ciphertext_hash = ?)`,
          )
          .bind(row.envelope_hash, blobCutoff, row.envelope_hash, row.envelope_hash),
      ),
    ])
    return results.length
  }
}

/**
 * The §12.1 replay record. `consume` is the primary key's job: INSERT ON CONFLICT DO NOTHING reports 0 changes
 * exactly when another Worker instance already recorded this (signer, nonce) — that is what makes the check
 * atomic across machines, which an in-memory Map could never be.
 */
export class D1NonceStore implements NonceStore {
  constructor(readonly db: D1Like) {}

  async consume(signer: Address, nonce: Hex, signedAt: bigint, _now: bigint): Promise<void> {
    const result = await this.db
      .prepare("INSERT OR IGNORE INTO nonces (signer, nonce, signed_at) VALUES (?, ?, ?)")
      .bind(signer.toLowerCase(), nonce.toLowerCase(), Number(signedAt))
      .run()
    if (changes(result) === 0) throw new MidaError("REPLAY", "request nonce was already used")
  }

  async sweep(now: bigint): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM nonces WHERE signed_at < ?")
      .bind(Number(now - REQUEST_WINDOW_SECONDS))
      .run()
    return changes(result)
  }
}

/** The §12.5 deny overlay rows; the same fail-closed semantics as the file, as SQLite rows. */
export class D1DenyStore implements DenyStore {
  constructor(readonly db: D1Like) {}

  async list(): Promise<RevocationIntent[]> {
    const { results } = await this.db.prepare("SELECT * FROM denies").all<DenyRow>()
    return results.map(denyFrom)
  }

  async get(id: Hex): Promise<RevocationIntent | undefined> {
    const row = await this.db.prepare("SELECT * FROM denies WHERE id = ?").bind(id.toLowerCase()).first<DenyRow>()
    return row === null ? undefined : denyFrom(row)
  }

  async insert(intent: RevocationIntent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO denies (id, owner, target_kind, target_id, state, agent_epoch_at_intent, cancellation_nonce)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        intent.id.toLowerCase(),
        intent.owner.toLowerCase(),
        intent.target.kind,
        intent.target.kind === "capability" ? intent.target.capabilityId.toLowerCase() : intent.target.agentId.toLowerCase(),
        intent.state,
        intent.agentEpochAtIntent,
        intent.cancellationNonce,
      )
      .run()
  }

  async update(intent: RevocationIntent): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE denies SET owner = ?, target_kind = ?, target_id = ?, state = ?, agent_epoch_at_intent = ?, cancellation_nonce = ?
         WHERE id = ?`,
      )
      .bind(
        intent.owner.toLowerCase(),
        intent.target.kind,
        intent.target.kind === "capability" ? intent.target.capabilityId.toLowerCase() : intent.target.agentId.toLowerCase(),
        intent.state,
        intent.agentEpochAtIntent,
        intent.cancellationNonce,
        intent.id.toLowerCase(),
      )
      .run()
    if (changes(result) === 0) throw new MidaError("NOT_FOUND", "revocation intent not found")
  }
}

/** The three stores the Context API needs, bound to one D1 database — what the worker hands `createContextApi`. */
export function d1Stores(db: D1Like): ContextStores {
  return { objects: new D1ObjectStore(db), nonces: new D1NonceStore(db), denies: new D1DenyStore(db) }
}

// ---------- BatchAnchor Task 5: the hosted half of the batch queue ----------

interface BatchRow {
  context_id: string
  owner: string
  namespace_id: string
  signer: string
  save_json: string
  state: string
  reason: string | null
  batch_id: string | null
  position: number | null
  lineage_id: string | null
  version: number | null
  proof_json: string | null
  received_at: number
  anchored_at: number | null
}

function batchRowFrom(row: BatchRow): BatchSaveRow {
  return {
    contextId: row.context_id as Hex,
    owner: row.owner as Address,
    namespaceId: row.namespace_id as Hex,
    signer: row.signer as Address,
    save: JSON.parse(row.save_json) as BatchedSaveWire,
    state: row.state as BatchSaveState,
    reason: row.reason,
    batchId: row.batch_id as Hex | null,
    position: row.position,
    lineageId: row.lineage_id as Hex | null,
    version: row.version,
    proof: row.proof_json === null ? null : (JSON.parse(row.proof_json) as Hex[]),
    receivedAt: row.received_at,
    anchoredAt: row.anchored_at,
  }
}

/**
 * The batch queue on D1. The one rule that matters: `takeQueued` is a single UPDATE ... RETURNING —
 * the claim and the state flip happen inside one statement, so two workers (or a worker and the
 * Durable Object alarm) can never take the same row. Sequence and flush marks live in batch_meta as
 * single-row values for the same reason.
 */
export class D1BatchStore implements BatchStore {
  constructor(readonly db: D1Like) {}

  async insert(row: BatchSaveRow): Promise<"inserted" | "exists"> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO batch_saves
           (context_id, owner, namespace_id, signer, save_json, state, reason,
            batch_id, position, lineage_id, version, proof_json, received_at, anchored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.contextId.toLowerCase(),
        row.owner.toLowerCase(),
        row.namespaceId.toLowerCase(),
        row.signer.toLowerCase(),
        JSON.stringify(row.save),
        row.state,
        row.reason,
        row.batchId?.toLowerCase() ?? null,
        row.position,
        row.lineageId?.toLowerCase() ?? null,
        row.version,
        row.proof === null ? null : JSON.stringify(row.proof),
        row.receivedAt,
        row.anchoredAt,
      )
      .run()
    return changes(result) > 0 ? "inserted" : "exists"
  }

  async get(contextId: Hex): Promise<BatchSaveRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM batch_saves WHERE context_id = ?")
      .bind(contextId.toLowerCase())
      .first<BatchRow>()
    return row === null ? null : batchRowFrom(row)
  }

  async listForReader(owner: Address, namespaceId: Hex): Promise<BatchSaveRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM batch_saves
         WHERE owner = ? AND namespace_id = ? AND state IN ('QUEUED', 'SUBMITTED', 'ANCHORED', 'HELD')
         ORDER BY received_at, context_id`,
      )
      .bind(owner.toLowerCase(), namespaceId.toLowerCase())
      .all<BatchRow>()
    return results.map(batchRowFrom)
  }

  /** One statement: the IN-subselect re-reads state inside the UPDATE, so a row taken by a racing run is invisible here. */
  async takeQueued(limit: number, batchId: Hex): Promise<BatchSaveRow[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE batch_saves SET state = 'SUBMITTED', batch_id = ?
         WHERE context_id IN (
           SELECT context_id FROM batch_saves WHERE state = 'QUEUED' ORDER BY received_at, context_id LIMIT ?
         )
         RETURNING *`,
      )
      .bind(batchId.toLowerCase(), limit)
      .all<BatchRow>()
    return results.map(batchRowFrom).sort((a, b) => a.receivedAt - b.receivedAt || a.contextId.localeCompare(b.contextId))
  }

  async markAnchored(
    contextId: Hex,
    fields: { batchId: Hex; position: number; lineageId: Hex; version: number; proof: Hex[]; anchoredAt: number },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE batch_saves
         SET state = 'ANCHORED', batch_id = ?, position = ?, lineage_id = ?, version = ?, proof_json = ?, anchored_at = ?
         WHERE context_id = ? AND state <> 'ANCHORED'`,
      )
      .bind(
        fields.batchId.toLowerCase(),
        fields.position,
        fields.lineageId.toLowerCase(),
        fields.version,
        JSON.stringify(fields.proof),
        fields.anchoredAt,
        contextId.toLowerCase(),
      )
      .run()
  }

  async markRejected(contextId: Hex, reason: string): Promise<void> {
    // An anchored row is final: a late-arriving rejection for a save the chain accepted is a bug
    // signal, not a state change — same first-write-wins rule as markAnchored.
    await this.db
      .prepare("UPDATE batch_saves SET state = 'REJECTED', reason = ? WHERE context_id = ? AND state <> 'ANCHORED'")
      .bind(reason, contextId.toLowerCase())
      .run()
  }

  async requeue(batchId: Hex): Promise<number> {
    const result = await this.db
      .prepare("UPDATE batch_saves SET state = 'QUEUED', batch_id = NULL WHERE batch_id = ? AND state = 'SUBMITTED'")
      .bind(batchId.toLowerCase())
      .run()
    return changes(result)
  }

  async requeueRow(contextId: Hex): Promise<void> {
    await this.db
      .prepare("UPDATE batch_saves SET state = 'QUEUED', batch_id = NULL WHERE context_id = ? AND state = 'SUBMITTED'")
      .bind(contextId.toLowerCase())
      .run()
  }

  async listHeld(): Promise<BatchSaveRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM batch_saves WHERE state = 'HELD' ORDER BY received_at, context_id")
      .all<BatchRow>()
    return results.map(batchRowFrom)
  }

  async hold(contextId: Hex): Promise<void> {
    // Only an in-flight state may hold: an anchored or rejected row is final — same
    // first-write-wins rule as markAnchored/markRejected — and the batch tag clears so a
    // requeue-by-batch can never revive the row behind the hold's back.
    await this.db
      .prepare("UPDATE batch_saves SET state = 'HELD', batch_id = NULL WHERE context_id = ? AND state IN ('QUEUED', 'SUBMITTED')")
      .bind(contextId.toLowerCase())
      .run()
  }

  async releaseHeld(contextId: Hex): Promise<void> {
    await this.db
      .prepare("UPDATE batch_saves SET state = 'QUEUED' WHERE context_id = ? AND state = 'HELD'")
      .bind(contextId.toLowerCase())
      .run()
  }

  async nextSequence(): Promise<bigint> {
    const row = await this.db
      .prepare(
        `INSERT INTO batch_meta (key, value) VALUES ('sequence', '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
         RETURNING value`,
      )
      .first<{ value: string }>()
    if (row === null) throw new MidaError("NOT_FOUND", "the batch sequence row did not return a value")
    return BigInt(row.value)
  }

  async countQueued(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM batch_saves WHERE state = 'QUEUED'").first<{ n: number }>()
    return row?.n ?? 0
  }

  async lastFlush(signer: Address): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT value FROM batch_meta WHERE key = ?")
      .bind(`flush:${signer.toLowerCase()}`)
      .first<{ value: string }>()
    return row === null ? null : Number(row.value)
  }

  async setLastFlush(signer: Address, atMs: number): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO batch_meta (key, value) VALUES (?, ?)")
      .bind(`flush:${signer.toLowerCase()}`, String(atMs))
      .run()
  }
}
