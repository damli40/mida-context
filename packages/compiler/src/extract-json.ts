// Extract the first parseable top-level JSON object from model output,
// tolerating prose and code fences around it. Ported from
// spike/hooks/capture-worker.mjs:31-53 — returns undefined instead of null
// when nothing parses.
//
// Two bounds keep this linear on adversarial output: only the first
// SCAN_LIMIT characters are considered, and a scan that reaches the end
// without closing its "{" returns at once — every "{" inside that unclosed
// span would rescan the same tail, which made megabyte inputs quadratic.
const SCAN_LIMIT = 2_000_000

export function extractJsonObject(text: string): unknown {
  const limit = Math.min(text.length, SCAN_LIMIT)
  for (let i = 0; i < limit; i++) {
    if (text[i] !== "{") continue
    let depth = 0,
      inStr = false,
      esc = false,
      closed = false
    for (let j = i; j < limit; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === "\\") esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === "{") depth++
      else if (c === "}" && --depth === 0) {
        closed = true
        try {
          const obj: unknown = JSON.parse(text.slice(i, j + 1))
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj
        } catch {
          /* keep scanning */
        }
        break
      }
    }
    if (!closed) return undefined
  }
  return undefined
}
