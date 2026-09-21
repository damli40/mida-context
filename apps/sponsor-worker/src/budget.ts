/**
 * Daily sponsorship budgets and signing records as SQLite counters. Many copies of a Worker run
 * at once, so the check is never a read-then-write: `INSERT … ON CONFLICT DO UPDATE … RETURNING
 * count` does the increment inside D1 and the returned count is the atomic truth.
 *
 * The counters tick on `pm_getPaymasterData` — the signing step — not `eth_sendUserOperation`.
 * A paymaster signature is spendable on chain through any bundler once issued, so the spend must
 * be accounted before the provider is asked to sign. A refused sender still costs the provider
 * nothing — the refusal happens before forwarding — but the counter ticks, which is the honest
 * accounting of attempts. When the provider then refuses or errors, the consumed ticks are given
 * back: no signature exists to spend, so nothing was spent.
 */

/** The slice of the Cloudflare D1 API this uses — a real D1Database (or Miniflare's) satisfies it. */
export interface D1RunResult {
  success: boolean
  meta: { changes?: number; rows_written?: number }
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<D1RunResult>
  first<T>(column?: string): Promise<T | null>
}
export interface D1Like {
  prepare(sql: string): D1Statement
}

export interface BudgetResult {
  allowed: boolean
  /** Which budget refused, for the refusal message and log line. */
  reason?: "sender" | "global"
  senderCount: number
  globalCount: number
}

/**
 * Count one sponsored signing (`pm_getPaymasterData`). The sender budget is ticked first so a
 * spammy sender burns only its own allowance once exhausted — the global budget is never touched
 * by a refused sender. `day` is the UTC date (YYYY-MM-DD), so the tables reset naturally at
 * midnight UTC.
 */
export async function consumeSignBudget(
  db: D1Like,
  input: { day: string; sender: string; perSender: number; global: number },
): Promise<BudgetResult> {
  const senderRow = await db
    .prepare(
      `INSERT INTO sponsor_sender_signings (day, sender, count) VALUES (?, ?, 1)
       ON CONFLICT (day, sender) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(input.day, input.sender)
    .first<{ count: number }>()
  const senderCount = senderRow?.count ?? 0
  if (senderCount > input.perSender) {
    return { allowed: false, reason: "sender", senderCount, globalCount: 0 }
  }

  const globalRow = await db
    .prepare(
      `INSERT INTO sponsor_global_signings (day, count) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(input.day)
    .first<{ count: number }>()
  const globalCount = globalRow?.count ?? 0
  if (globalCount > input.global) {
    return { allowed: false, reason: "global", senderCount, globalCount }
  }
  return { allowed: true, senderCount, globalCount }
}

/**
 * Give back a consumed signing when the provider never produced one — a compensating decrement
 * on both counters, never below zero. Only called after `consumeSignBudget` returned allowed,
 * so each decrement undoes exactly one increment.
 */
export async function refundSignBudget(db: D1Like, input: { day: string; sender: string }): Promise<void> {
  await db
    .prepare(`UPDATE sponsor_sender_signings SET count = MAX(count - 1, 0) WHERE day = ? AND sender = ?`)
    .bind(input.day, input.sender)
    .run()
  await db
    .prepare(`UPDATE sponsor_global_signings SET count = MAX(count - 1, 0) WHERE day = ?`)
    .bind(input.day)
    .run()
}

/**
 * Count one free call (`pm_getPaymasterStubData` or `eth_estimateUserOperationGas`). These carry
 * no signature and cannot spend the sponsorship budget, but each still costs a provider call —
 * so a sender gets a small daily allowance and no more.
 */
export async function consumeFreeCalls(
  db: D1Like,
  input: { day: string; sender: string; perSender: number },
): Promise<{ allowed: boolean; senderCount: number }> {
  const row = await db
    .prepare(
      `INSERT INTO sponsor_free_calls (day, sender, count) VALUES (?, ?, 1)
       ON CONFLICT (day, sender) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(input.day, input.sender)
    .first<{ count: number }>()
  const senderCount = row?.count ?? 0
  return { allowed: senderCount <= input.perSender, senderCount }
}

/**
 * Remember that this endpoint signed this operation today. `INSERT OR IGNORE` keeps it
 * idempotent: signing the same operation twice records one row but still consumed two budget
 * ticks — two signatures were issued.
 */
export async function recordIssued(
  db: D1Like,
  input: { day: string; sender: string; nonce: string; callDataHash: string },
): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO sponsor_issued (day, sender, nonce, calldata_hash) VALUES (?, ?, ?, ?)`)
    .bind(input.day, input.sender, input.nonce, input.callDataHash)
    .run()
}

/**
 * Whether this endpoint signed an operation with this identifying tuple today — or yesterday.
 * A signing that lands at 23:59:59 UTC is recorded under that day; the send that follows at
 * 00:00:01 must still find it, so both UTC days count. Older records do not — the window stays
 * one day back, not a rolling set.
 */
export async function wasIssued(
  db: D1Like,
  input: { day: string; sender: string; nonce: string; callDataHash: string },
): Promise<boolean> {
  const yesterday = utcDay(new Date(Date.parse(`${input.day}T00:00:00.000Z`) - 86_400_000))
  const row = await db
    .prepare(`SELECT 1 AS found FROM sponsor_issued WHERE day IN (?, ?) AND sender = ? AND nonce = ? AND calldata_hash = ?`)
    .bind(input.day, yesterday, input.sender, input.nonce, input.callDataHash)
    .first<{ found: number }>()
  return row !== null
}

/** The UTC day key every table is keyed by — resets at midnight UTC, like the provider policies. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}
