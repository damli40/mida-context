/**
 * Daily sponsored-operation budgets as SQLite counters. Many copies of a Worker run at once, so the
 * check is never a read-then-write: `INSERT … ON CONFLICT DO UPDATE … RETURNING count` does the
 * increment inside D1 and the returned count is the atomic truth. A refused sender still costs the
 * provider nothing — the refusal happens before forwarding — but the counter ticks, which is the
 * honest accounting of attempts.
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
 * Count one `eth_sendUserOperation`. The sender budget is ticked first so a spammy sender burns
 * only its own allowance once exhausted — the global budget is never touched by a refused sender.
 * `day` is the UTC date (YYYY-MM-DD), so the tables reset naturally at midnight UTC.
 */
export async function consumeSendBudget(
  db: D1Like,
  input: { day: string; sender: string; perSender: number; global: number },
): Promise<BudgetResult> {
  const senderRow = await db
    .prepare(
      `INSERT INTO sponsor_sender_ops (day, sender, count) VALUES (?, ?, 1)
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
      `INSERT INTO sponsor_global_ops (day, count) VALUES (?, 1)
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

/** The UTC day key both tables are keyed by — resets at midnight UTC, like the provider policies. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}
