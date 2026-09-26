-- in-11 R-2: batch_saves gains the HELD state (in-3 I5's park state for a save whose author sits
-- on the active deny list). The table the deployed schema.sql created refuses 'HELD' in its CHECK
-- constraint, and SQLite cannot ALTER a CHECK — so the table is rebuilt under a new name, every
-- row copied across, and the old table dropped. The three indexes the original schema created are
-- recreated under the same names (they ride the table, so they died with it).
--
-- Run once against the deployed database:
--   wrangler d1 execute mida-context-store --remote --file=migrations/0001_batch_saves_held.sql
-- (or `wrangler d1 migrations apply mida-context-store --remote` — same statements, tracked.)

CREATE TABLE batch_saves_new (
  context_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  signer TEXT NOT NULL,
  save_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'SUBMITTED', 'ANCHORED', 'REJECTED', 'HELD')),
  reason TEXT,
  batch_id TEXT,
  position INTEGER,
  lineage_id TEXT,
  version INTEGER,
  proof_json TEXT,
  received_at INTEGER NOT NULL,
  anchored_at INTEGER
);

INSERT INTO batch_saves_new
  (context_id, owner, namespace_id, signer, save_json, state, reason,
   batch_id, position, lineage_id, version, proof_json, received_at, anchored_at)
SELECT context_id, owner, namespace_id, signer, save_json, state, reason,
       batch_id, position, lineage_id, version, proof_json, received_at, anchored_at
FROM batch_saves;

DROP TABLE batch_saves;

ALTER TABLE batch_saves_new RENAME TO batch_saves;

CREATE INDEX IF NOT EXISTS batch_saves_state ON batch_saves (state, received_at);
CREATE INDEX IF NOT EXISTS batch_saves_owner_ns ON batch_saves (owner, namespace_id, state);
CREATE INDEX IF NOT EXISTS batch_saves_batch ON batch_saves (batch_id);
