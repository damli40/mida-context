import type { MergedHandoff } from "./merge.js"

// Renders a merged handoff as plain text for the receiving agent.
// The ORIGINAL REQUEST section leads the block — the user's own words, not a
// summary — and is never trimmed. When the output would exceed maxChars the
// oldest progress entries collapse into a count line; nothing else is cut
// silently, and a still-oversize result says so in the text itself.
export function renderHandoff(merged: MergedHandoff, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 8000
  const cut = (s: string) => (s.length > 300 ? s.slice(0, 299) + "…" : s)
  const list = (title: string, items: string[]): string | null =>
    items.length ? `${title}:\n${items.map((i) => `- ${cut(i)}`).join("\n")}` : null

  const build = (dropped: number): string => {
    const parts: string[] = ["MIDA HANDOFF"]
    if (merged.originalRequest !== null) {
      parts.push(
        "ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):\n" +
          merged.originalRequest,
      )
    }
    const push = (s: string | null) => {
      if (s !== null) parts.push(s)
    }
    push(list("Remaining plan", merged.remainingPlan))
    parts.push(`Next action: ${merged.nextAction}`)
    parts.push(`Objective: ${merged.objective}`)
    parts.push(`Unresolved issue: ${merged.unresolvedIssue ?? "none"}`)
    push(list("Decisions", merged.decisions.map((d) => `${d.decision} — because: ${d.rationale}`)))
    push(list("Rejected approaches", merged.rejected.map((r) => `${r.approach} — ${r.why}`)))
    push(list("Constraints", merged.constraints))
    push(list("Artifacts", merged.artifacts))
    if (merged.progress.length > 0) {
      const lines = merged.progress.slice(dropped).map((p) => `- ${cut(p)}`)
      if (dropped > 0) lines.unshift(`- (${dropped} earlier progress entries left out)`)
      parts.push(`Progress:\n${lines.join("\n")}`)
    }
    push(list("Saved by", merged.provenance.map(
      (p) => `${p.agent} at ${p.createdAt}, compiled by ${p.compiledBy}, record ${p.contextId}`,
    )))
    return parts.join("\n\n")
  }

  let dropped = 0
  let out = build(0)
  while (out.length > maxChars && merged.progress.length - dropped > 1) {
    dropped += 1
    out = build(dropped)
  }
  if (out.length > maxChars) out += "\n\n(handoff longer than the limit; nothing further was cut)"
  return out
}
