import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { MidaHome } from "./home.js"

/**
 * One JSON line appended to `logs/<name>.jsonl`. Logging is observability only — it never throws, and
 * callers pass key names, ids, counts and timings, never transcript text or secret values.
 */
export function appendLog(home: MidaHome, name: "hook" | "drain" | "daemon", record: Record<string, unknown>): void {
  try {
    const file = home.path(`logs/${name}.jsonl`)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
  } catch {
    // a log that cannot be written must not break capture
  }
}

/**
 * The store client's `warn` sink for daemon-side callers (in-12 N-7): a line like
 * "store-predates-write-check" fired inside midad lands on stderr of a detached daemon —
 * read by no one — so the client takes a sink and this one writes it to the daemon log the
 * owner actually reads, with the client's own wording kept in `detail`.
 */
export function daemonWarning(home: MidaHome): (message: string) => void {
  return (message) => appendLog(home, "daemon", { event: "store-warning", detail: message })
}
