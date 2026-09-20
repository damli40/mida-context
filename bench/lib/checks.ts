// The one-JSON-line-per-check contract shared by every deterministic group.
// A group file builds a list of checks, runs them in order, prints exactly one
// JSON line per check to stdout, and exits with the number of failed checks
// capped at 9. Nothing else may reach stdout — diagnostics go to stderr.

export interface CheckOutcome {
  pass: boolean
  /** The measured value — a number, a count, or a "threw:<code>" string on failure. */
  value?: unknown
  /** The budget copied from docs/issue-register.md, or null when the register gives none. */
  limit?: number | null
  unit?: string
  /** Extra measured numbers that are not the pass/fail driver (medians, counts). */
  detail?: unknown
}

export interface Check {
  id: string
  run: () => Promise<CheckOutcome> | CheckOutcome
}

export interface Skipped {
  id: string
  skipped: "needs-real-model" | "needs-testnet" | "needs-real-agents"
}

export const needsRealModel = (id: string): Skipped => ({ id, skipped: "needs-real-model" })
export const needsTestnet = (id: string): Skipped => ({ id, skipped: "needs-testnet" })

/** A thrown check reports a stable code — never error.message, which can carry data. */
function thrownCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,48}$/.test(code)) return code
  const name = error instanceof Error ? error.name : ""
  return /^[A-Za-z0-9_]{1,32}$/.test(name) && name !== "" ? name : "error"
}

const emit = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

/**
 * Runs one group's checks in order. A check that throws is a failed check with
 * "threw:<stable code>" — it never takes the rest of the group down. The exit
 * code is the number of failed checks, capped at 9.
 */
export async function runGroup(checks: readonly (Check | Skipped)[]): Promise<void> {
  let failed = 0
  for (const check of checks) {
    if ("skipped" in check) {
      emit({ id: check.id, pass: null, skipped: check.skipped })
      continue
    }
    try {
      const outcome = await check.run()
      emit({ id: check.id, ...outcome })
      if (!outcome.pass) failed += 1
    } catch (error) {
      emit({ id: check.id, pass: false, value: `threw:${thrownCode(error)}` })
      failed += 1
    }
  }
  process.exitCode = Math.min(failed, 9)
}

/** Median of a list of numbers; used by every timing check. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
