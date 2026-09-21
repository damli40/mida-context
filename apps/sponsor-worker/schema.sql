-- M3-B sponsor worker: daily sponsored-operation budgets. Counted on eth_sendUserOperation only,
-- atomically (INSERT ... ON CONFLICT DO UPDATE ... RETURNING count) so concurrent Worker instances
-- cannot both squeeze under a limit.
CREATE TABLE IF NOT EXISTS sponsor_sender_ops (
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, sender)
);

CREATE TABLE IF NOT EXISTS sponsor_global_ops (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
