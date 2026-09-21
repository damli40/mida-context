import { MidaError, assertHex } from "@mida/protocol"
import type { Address, Hex, ReaderEpochWrap, StorageRef } from "@mida/protocol"
import { contentHash, verifyContent } from "@mida/storage"
import type { ContextStorage } from "@mida/storage"
import { REQUEST_WINDOW_SECONDS } from "@mida/api"
import type { ContextStores, DenyStore, NonceStore, ObjectStore, RevocationIntent, StoredObject, WrapKey } from "@mida/api"

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
  uploaded_at: string
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
 */
export class D1BlobStorage implements ContextStorage {
  constructor(readonly db: D1Like) {}

  async put(blob: Uint8Array): Promise<StorageRef[]> {
    const hash = contentHash(blob)
    await this.db.prepare("INSERT OR IGNORE INTO blobs (hash, bytes) VALUES (?, ?)").bind(hash, blob).run()
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
           (context_id, owner, uploader, namespace_id, author_id, object_nonce, expected_parent_id, manifest, manifest_hash, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        object.uploadedAt,
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

  async objectsByUploader(uploader: Address): Promise<StoredObject[]> {
    const { results } = await this.db.prepare("SELECT * FROM objects WHERE uploader = ?").bind(uploader.toLowerCase()).all<ObjectRow>()
    return results.map(objectFrom)
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

  async setManifestIndex(bodyHash: Hex, envelopeHash: Hex): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO manifest_index (body_hash, envelope_hash) VALUES (?, ?)")
      .bind(bodyHash.toLowerCase(), envelopeHash.toLowerCase())
      .run()
  }

  async getManifestIndex(bodyHash: Hex): Promise<Hex | undefined> {
    const row = await this.db.prepare("SELECT envelope_hash FROM manifest_index WHERE body_hash = ?").bind(bodyHash.toLowerCase()).first<{ envelope_hash: string }>()
    return row === null ? undefined : (row.envelope_hash as Hex)
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

  async sweepPending(olderThan: Date, stillPending: (object: StoredObject) => Promise<boolean>): Promise<number> {
    // ISO-8601 UTC strings sort chronologically, so the cutoff is a plain string comparison.
    const { results } = await this.db.prepare("SELECT * FROM objects WHERE uploaded_at < ?").bind(olderThan.toISOString()).all<ObjectRow>()
    const deletable: string[] = []
    for (const row of results) {
      const object = objectFrom(row)
      if (await stillPending(object)) deletable.push(object.contextId)
    }
    if (deletable.length === 0) return 0
    await this.db.batch(deletable.map((id) => this.db.prepare("DELETE FROM objects WHERE context_id = ?").bind(id)))
    return deletable.length
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
