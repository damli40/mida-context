-- Mida hosted store, Cloudflare D1 (SQLite). The database holds exactly what the
-- file tree held: ciphertext blobs, object metadata, reader wraps, the manifest
-- index, replay nonces, revocation intents and per-signer PUT counts. Every
-- address and hash is stored lowercase; every lookup lowercases its input.
-- Primary keys mirror the file names the local store used.

-- §9.2 content-addressed blobs: ciphertext and signed manifest envelopes.
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,            -- 0x-prefixed lowercase sha256 of `bytes`
  bytes BLOB NOT NULL
);

-- §12.2 pending/anchored objects: immutable manifest metadata per contextId.
CREATE TABLE IF NOT EXISTS objects (
  context_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  uploader TEXT NOT NULL,           -- authenticated signer; feeds the per-signer quotas
  namespace_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  object_nonce TEXT NOT NULL,
  expected_parent_id TEXT NOT NULL,
  manifest TEXT NOT NULL,           -- JSON ObjectManifest
  manifest_hash TEXT NOT NULL,
  uploaded_at TEXT NOT NULL         -- ISO-8601 UTC, sorts lexicographically
);
CREATE INDEX IF NOT EXISTS objects_owner_ns ON objects (owner, namespace_id);
CREATE INDEX IF NOT EXISTS objects_uploader ON objects (uploader);
CREATE INDEX IF NOT EXISTS objects_uploaded ON objects (uploaded_at);

-- §12.4 reader-epoch wraps: one per (owner, namespace, epoch, agent key version).
CREATE TABLE IF NOT EXISTS wraps (
  owner TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  read_epoch TEXT NOT NULL,         -- base-10 uint64
  agent_id TEXT NOT NULL,
  agent_key_version INTEGER NOT NULL,
  wrap TEXT NOT NULL,               -- JSON ReaderEpochWrap
  PRIMARY KEY (owner, namespace_id, read_epoch, agent_id, agent_key_version)
);

-- §14.1 agent manifest body-hash → envelope-hash index.
CREATE TABLE IF NOT EXISTS manifest_index (
  body_hash TEXT PRIMARY KEY,
  envelope_hash TEXT NOT NULL
);

-- §12.1 replay record. The primary key IS the check-and-record: INSERT ON
-- CONFLICT DO NOTHING reporting 0 changes means this request was seen before,
-- and that holds across every Worker instance sharing the database.
CREATE TABLE IF NOT EXISTS nonces (
  signer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  signed_at INTEGER NOT NULL,       -- unix seconds of the signed timestamp
  PRIMARY KEY (signer, nonce)
);
CREATE INDEX IF NOT EXISTS nonces_signed_at ON nonces (signed_at);

-- §12.5 deny overlay intents.
CREATE TABLE IF NOT EXISTS denies (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('capability', 'agent')),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'anchored', 'cancelled')),
  agent_epoch_at_intent TEXT,       -- base-10 uint256, null for capability targets
  cancellation_nonce TEXT           -- base-10 uint256, null once consumed
);

-- Per-signer accepted PUTs per UTC day, for maxPutsPerSignerPerDay.
CREATE TABLE IF NOT EXISTS puts (
  signer TEXT NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (signer, day)
);
