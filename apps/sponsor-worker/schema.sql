-- M3-B2 sponsor worker: daily budgets are counted on pm_getPaymasterData — the signing step,
-- because a returned paymaster signature is spendable on chain through ANY bundler. Counting on
-- eth_sendUserOperation would let an attacker sign here and submit elsewhere, unbounded.
-- All counters increment atomically (INSERT ... ON CONFLICT DO UPDATE ... RETURNING count) so
-- concurrent Worker instances cannot both squeeze under a limit.
CREATE TABLE IF NOT EXISTS sponsor_sender_signings (
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, sender)
);

CREATE TABLE IF NOT EXISTS sponsor_global_signings (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- pm_getPaymasterStubData and eth_estimateUserOperationGas carry no signature, so they cannot
-- spend — but they still cost a provider call, so each sender gets a small daily allowance.
CREATE TABLE IF NOT EXISTS sponsor_free_calls (
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, sender)
);

-- The identifying tuple of every operation this endpoint signed today. eth_sendUserOperation is
-- forwarded only when (day, sender, nonce, callData hash) is here — we never relay a paymaster
-- sponsorship we did not issue.
CREATE TABLE IF NOT EXISTS sponsor_issued (
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  nonce TEXT NOT NULL,
  calldata_hash TEXT NOT NULL,
  PRIMARY KEY (day, sender, nonce, calldata_hash)
);
