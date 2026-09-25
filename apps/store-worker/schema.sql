-- Mida hosted store, Cloudflare D1 (SQLite). The database holds exactly what the
-- file tree held: ciphertext blobs, object metadata, reader wraps, the manifest
-- index, replay nonces, revocation intents and per-signer PUT counts. Every
-- address and hash is stored lowercase; every lookup lowercases its input.
-- Primary keys mirror the file names the local store used.

-- §9.2 content-addressed blobs: ciphertext and signed manifest envelopes.
-- On a database created before created_at existed:
--   ALTER TABLE blobs ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
-- (empty created_at sorts before every real timestamp, so old blobs stay sweepable).
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,            -- 0x-prefixed lowercase sha256 of `bytes`
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL          -- ISO-8601 UTC; the sweep's young-blob grace reads it
);

-- §12.2 pending/anchored objects: immutable manifest metadata per contextId. anchored_at is set
-- once, the first time any code path observes the row matching its Monad record — anchoring cannot
-- un-happen, so a marked row is never re-checked and never swept. NULL = still pending.
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
  ciphertext_hash TEXT NOT NULL,    -- manifest.ciphertextHash, the row's blob reference; indexed so the
                                    -- sweep's blob-reference guard is a lookup, not a json_extract scan
  size INTEGER NOT NULL,            -- manifest.ciphertextSize; SUM(size) feeds the atomic pending cap
  uploaded_at TEXT NOT NULL,        -- ISO-8601 UTC, sorts lexicographically
  anchored_at TEXT                  -- ISO-8601 UTC of the first verified chain match, NULL = pending
);
CREATE INDEX IF NOT EXISTS objects_owner_ns ON objects (owner, namespace_id);
CREATE INDEX IF NOT EXISTS objects_uploader ON objects (uploader);
CREATE INDEX IF NOT EXISTS objects_uploaded ON objects (uploaded_at);
CREATE INDEX IF NOT EXISTS objects_ciphertext ON objects (ciphertext_hash);

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

-- §14.1 agent manifest body-hash → envelope-hash index. stored_at starts the 24 h
-- staging window; verified_at records the last time the envelope verified against the
-- agent's chain record (NULL = the agent never registered → the sweep reclaims the row).
CREATE TABLE IF NOT EXISTS manifest_index (
  body_hash TEXT PRIMARY KEY,
  envelope_hash TEXT NOT NULL,
  stored_at TEXT NOT NULL,        -- ISO-8601 UTC
  verified_at TEXT                -- ISO-8601 UTC, NULL while unverified
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

-- Same atomic counter on its own table, for maxManifestPutsPerSignerPerDay.
CREATE TABLE IF NOT EXISTS manifest_puts (
  signer TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (signer, day)
);

-- BatchAnchor batched saves. Amendment A.4: the ciphertext travels inside save_json (the whole
-- signed BatchedSaveWire), never in objects — the objects sweep must never touch these bytes.
-- States: QUEUED (admitted, awaiting a batch) → SUBMITTED (claimed by an in-flight batch, batch_id
-- set) → ANCHORED (contract accepted; position/lineage/version/proof filled) or REJECTED (contract
-- refused; reason names the code). REJECTED rows stay for direct status lookups but never list.
CREATE TABLE IF NOT EXISTS batch_saves (
  context_id TEXT PRIMARY KEY,      -- the contract's batch context id, lowercase
  owner TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  signer TEXT NOT NULL,             -- the request signer (the agent that uploaded), lowercase
  save_json TEXT NOT NULL,          -- JSON BatchedSaveWire: message, signature, manifest, ciphertext
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'SUBMITTED', 'ANCHORED', 'REJECTED')),
  reason TEXT,                      -- rejection reason for REJECTED rows, else NULL
  batch_id TEXT,                    -- batch that claimed/anchored this save, lowercase
  position INTEGER,                 -- index inside the batch's accepted leaves
  lineage_id TEXT,
  version INTEGER,
  proof_json TEXT,                  -- JSON Hex[] Merkle proof, filled at ANCHORED
  received_at INTEGER NOT NULL,     -- ms since epoch the store admitted the save
  anchored_at INTEGER               -- ms since epoch the anchor was observed, NULL until then
);
CREATE INDEX IF NOT EXISTS batch_saves_state ON batch_saves (state, received_at);
CREATE INDEX IF NOT EXISTS batch_saves_owner_ns ON batch_saves (owner, namespace_id, state);
CREATE INDEX IF NOT EXISTS batch_saves_batch ON batch_saves (batch_id);

-- Monotonic receipt sequence (key 'sequence', decimal string) and per-signer last-flush marks
-- (key 'flush:<signer>', ms decimal). Single row updates keep both race-free across workers.
CREATE TABLE IF NOT EXISTS batch_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
