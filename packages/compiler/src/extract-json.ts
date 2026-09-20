// Extract the first parseable top-level JSON object from model output,
// tolerating prose and code fences around it. Ported from
// spike/hooks/capture-worker.mjs:31-53 — returns undefined instead of null
// when nothing parses.
export function extractJsonObject(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    let depth = 0,
      inStr = false,
      esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === "\\") esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === "{") depth++
      else if (c === "}" && --depth === 0) {
        try {
          const obj: unknown = JSON.parse(text.slice(i, j + 1))
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj
        } catch {
          /* keep scanning */
        }
        break
      }
    }
  }
  return undefined
}
