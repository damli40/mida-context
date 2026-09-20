// Replace common secret shapes with [REDACTED] before transcript text is
// sent to the extractor model. Spike-grade coverage, not exhaustive.
// Ported from spike/hooks/scrub.mjs; the regular expressions are copied
// character for character — the 48-character bound on key names is what
// stops an 80 KB single-token line from taking 7.7 s (spike bug F2).
//
// scrubSecrets(text)  — string-level API, works on raw text.
// scrubTranscript(text) — transcript-level API for JSONL transcripts: each
//   line is JSON.parse'd, every string in the decoded value is scrubbed, and
//   the value is re-serialized. This matters because scrubbing the RAW line
//   leaves secrets visible behind escaped quotes: JSON.parse first, then
//   scrub the decoded text. Lines that fail to parse (e.g. the first line of
//   a tail read, cut mid-JSON) are scrubbed raw.

const PATTERNS = [
  // private key blocks (multiline, before the single-line rules)
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack tokens
  /\bxox[abp]-[A-Za-z0-9-]+\b/g,
  // GitHub personal access tokens (classic + fine-grained)
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // OpenAI-style keys
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  // hex private keys (0x + 64 hex chars)
  /\b0x[0-9a-fA-F]{64}\b/g,
  // bare 64-hex-char strings (private keys without the 0x prefix)
  /\b[0-9a-fA-F]{64}\b/g,
]

// "Authorization: Bearer <token>" and bare "Bearer <token>". Keeps the word
// Bearer, redacts the token.
const BEARER = /\b(Bearer)[ \t]+[^\s"'\\]{8,}/gi

// NAME=value assignments where NAME ends with KEY/TOKEN/SECRET/PASSWORD.
// Keeps the name, redacts the value — including values wrapped in escaped
// quotes (\"v\"), which appear in raw transcript fragments.
const ENV_ASSIGN =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password))(=)(\\"(?:\\.|[^"\\])*\\"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"]+)/gi

// JSON/YAML-style key/value pairs whose key name contains a sensitive word:
//   "apiKey": "v"   privateKey: v   'client_secret' : 'v'   api_token=v
// Only fires when the value is 8+ chars with no spaces, so ordinary prose
// ("the key: everything") and short values ('key: "user:42"') survive.
// NOTE: the key-name halves are bounded ({0,48}) — with `*` the greedy match
// backtracks over every long word in the transcript (base64 blobs, minified
// code), which is quadratic. Key names are never that long.
const KV_SECRET =
  /(["']?)([A-Za-z0-9_.$-]{0,48}(?:key|token|secret|password|passwd|private|credential)[A-Za-z0-9_.$-]{0,48})\1(\s*[:=]\s*)("[^"\s]{8,}"|'[^'\s]{8,}'|[^\s"',\]\[{}();]{8,})/gi

// Key names that mark a JSON/YAML value as secret. Used when walking decoded
// transcript lines — a secret value that matches no string-level pattern
// (e.g. {"apiKey": "plainWordsHere"}) still gets redacted by its key name.
const SENSITIVE_KEY = /key|token|secret|password|passwd|private|credential|authorization/i

export function scrubSecrets(text: string): string {
  let out = String(text)
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]")
  out = out.replace(BEARER, (_m, b) => `${b} [REDACTED]`)
  // ENV_ASSIGN before KV_SECRET: env assignments keep their historic
  // `NAME=[REDACTED]` form, and already-redacted values can't re-match.
  out = out.replace(ENV_ASSIGN, (_m, name, eq) => `${name}${eq}[REDACTED]`)
  out = out.replace(KV_SECRET, (_m, q, key, sep) => `${q}${key}${q}${sep}"[REDACTED]"`)
  return out
}

// Recursive form of scrubSecrets for decoded JSON values: strings are
// scrubbed, and any string sitting under a sensitive-looking KEY NAME is
// redacted outright — that catches secrets whose value matches no pattern
// (e.g. {"password": "correct horse battery staple"}).
export function scrubValue(v: unknown): unknown {
  if (typeof v === "string") return scrubSecrets(v)
  if (Array.isArray(v)) return v.map(scrubValue)
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof val === "string" ? "[REDACTED]" : scrubValue(val)
    }
    return out
  }
  return v
}

export function scrubTranscript(jsonlText: string): string {
  return String(jsonlText)
    .split("\n")
    .map((line) => {
      try {
        return JSON.stringify(scrubValue(JSON.parse(line)))
      } catch {
        return scrubSecrets(line)
      }
    })
    .join("\n")
}
