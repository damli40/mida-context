// The ONE shared "is this stored request only Claude Code scaffolding" decision
// and the tag list behind it. They live in @mida/checkpoint — not next to the
// transcript reader — because mergeCheckpoints must ask the same question the
// compile-time kept-request check asks, and @mida/compiler already depends on
// this package (the reverse edge is forbidden). The list exists once, here.

// Claude Code injects its own user-role lines around the human's words — the
// /compact caveat, slash-command echoes, hook and reminder blocks. Text that
// OPENS on one of these tags is scaffolding up to that tag's close; whatever
// follows it is still the user's.
const CLAUDE_SCAFFOLD_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<system-reminder>",
  "<user-prompt-submit-hook>",
  // IDE-injected context — a file path or selection is bookkeeping, never the
  // user's words, and must not become the saved request (L8)
  "<ide_opened_file>",
  "<ide_selection>",
]

// The scaffold prefixes as bare tag names, for block stripping below.
const CLAUDE_SCAFFOLD_TAGS = new Set(CLAUDE_SCAFFOLD_PREFIXES.map((p) => p.slice(1, -1)))
// Tag names can carry underscores (ide_opened_file) — the class must too.
const SCAFFOLD_OPEN = /^<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>/

// Strip leading injected <tag>…</tag> blocks (plus whitespace between) from a
// user text. A real prompt may OPEN on a <system-reminder> — the reminder is
// scaffolding but the words after it are the ask, so the block goes and the
// rest stays. Returns "" when the text was scaffolding all the way down — the
// whole line is then plumbing, never the request and never rendered — or when
// an unclosed scaffold tag swallows the remainder.
// (The isCompactSummary line is NOT in this set — the condensed history is
// real session context and still renders; it just may not be the request.)
// Exported so compile.ts can run a saved previous request through the same
// test the reader uses — an empty return means the text was all scaffolding.
export function stripLeadingScaffolds(text: string): string {
  let t = text.trimStart()
  for (;;) {
    const open = SCAFFOLD_OPEN.exec(t)?.[1]
    if (open === undefined || !CLAUDE_SCAFFOLD_TAGS.has(open)) return t
    const close = `</${open}>`
    const end = t.indexOf(close)
    if (end === -1) return ""
    t = t.slice(end + close.length).trimStart()
  }
}

// The one decision both callers share — mergeCheckpoints' pick and compile.ts's
// kept-request check: this stored request is only scaffolding, nothing the user
// ever wrote.
export function onlyScaffolding(text: string): boolean {
  return stripLeadingScaffolds(text) === ""
}
