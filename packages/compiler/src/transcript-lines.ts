// The bounded transcript read shared by the per-format readers, moved out of
// transcript-claude.ts unchanged: the file is opened once and never loaded
// whole. A transcript no bigger than HEAD_BYTES + TAIL_BYTES is read in one
// shot; a bigger one gets the first HEAD_BYTES (the original request lives at
// the top) and the last TAIL_BYTES (the newest messages live at the bottom),
// and the middle is never touched — messagesTotal and cwds then count only
// the lines that were read.
//
// Also shared here: the small render helpers both readers use — cut/hardCut,
// the part/first-message caps, and the budgeted pin-first-user assembly that
// fills the remaining maxChars from the most recent message backwards.

import fs from "node:fs"

export const HEAD_BYTES = 64 * 1024 // bounded head — the first user message lives at the top
export const TAIL_BYTES = 60_000 // tail window — the newest messages live at the bottom
export const PART_CHARS = 600
export const FIRST_USER_CHARS = 6_000
// Room kept aside for the "[… N earlier messages omitted …]" marker so the
// final text stays under maxChars even when the marker is needed.
export const MARKER_RESERVE = 96

export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s)
// Unlike cut(), the ellipsis is counted INSIDE the limit: the result is at
// most n chars, so it can never trip the schema's 6,000-char cap.
export const hardCut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

/**
 * One open descriptor, at most HEAD_BYTES + TAIL_BYTES read: the whole file when it fits,
 * else {head: first HEAD_BYTES, tail: last TAIL_BYTES} — the middle stays on disk.
 */
export function readWindows(path: string): { head: Buffer; tail: Buffer | null } {
  const fd = fs.openSync(path, "r")
  try {
    const size = fs.fstatSync(fd).size
    const read = (position: number, length: number): Buffer => {
      const buf = Buffer.alloc(length)
      let got = 0
      while (got < length) {
        const n = fs.readSync(fd, buf, got, length - got, position + got)
        if (n === 0) break // the file shrank between stat and read
        got += n
      }
      return buf.subarray(0, got)
    }
    if (size <= HEAD_BYTES + TAIL_BYTES) return { head: read(0, size), tail: null }
    return { head: read(0, HEAD_BYTES), tail: read(size - TAIL_BYTES, TAIL_BYTES) }
  } finally {
    fs.closeSync(fd)
  }
}

export interface TranscriptLines {
  /** One (label, text) pair per line read — real 1-based numbers in the head, "~n" in the tail. */
  lines: { label: string; text: string }[]
  /** True when the file was bigger than the windows and the middle was never read. */
  truncated: boolean
  /** The raw windows, for a reader's unknown-format tail fallback. */
  head: Buffer
  tail: Buffer | null
}

/**
 * readWindows plus the line labelling. Head lines keep their real 1-based
 * numbers; tail lines are labelled "~n" — the line's place inside the tail
 * window, since its absolute number is unknowable without the middle.
 */
export function readTranscriptLines(path: string): TranscriptLines {
  const { head, tail } = readWindows(path)
  const truncated = tail !== null
  const lines: { label: string; text: string }[] = []
  if (!truncated) {
    head.toString("utf8").split("\n").forEach((line, idx) => lines.push({ label: String(idx + 1), text: line }))
  } else {
    const headLines = head.toString("utf8").split("\n")
    // a last segment without its terminator is a partial line — its rest sits in the unread middle
    if (head.length > 0 && head[head.length - 1] !== 10) headLines.pop()
    headLines.forEach((line, idx) => lines.push({ label: String(idx + 1), text: line }))
    const tailLines = tail.toString("utf8").split("\n")
    tailLines.shift() // the first segment began before the window — a partial line
    tailLines.forEach((line, idx) => lines.push({ label: `~${idx + 1}`, text: line }))
  }
  return { lines, truncated, head, tail }
}

/**
 * The first user message carries the objective and constraints — pin it
 * (cut at 6,000 chars). Everything else competes for the remaining budget,
 * filled from the most recent backwards. When the pinned block ALONE is
 * bigger than maxChars it is cut to maxChars − 200 so the final text still
 * fits. When the middle was never read the true omitted count is unknowable —
 * only the lines that were read but did not fit are counted, and the marker
 * says so.
 *
 * `pinIdx` names the block the reader took firstUserMessage from. The pin must
 * follow THAT line — a transcript can hold an earlier user-role block that
 * carries no request (Claude Code scaffolding, a bare tool_result), and
 * pinning it would headline the file with text that is not the request.
 * Absent or out of range, the first user block is pinned as before.
 */
export function fitMessages(
  msgs: { role: string; block: string }[],
  maxChars: number,
  truncated: boolean,
  pinIdx?: number,
): { text: string; messagesKept: number; omitted: number } {
  const pin = pinIdx !== undefined && pinIdx >= 0 && pinIdx < msgs.length ? pinIdx : msgs.findIndex((m) => m.role === "user")
  const headCap = Math.min(FIRST_USER_CHARS, Math.max(0, maxChars - 200))
  const head = pin >= 0 ? cut(msgs[pin]!.block, headCap) : null
  const rest = msgs.filter((_, i) => i !== pin)

  const budget = Math.max(0, maxChars - (head ? head.length + 2 : 0) - MARKER_RESERVE)
  const keptTail: { role: string; block: string }[] = []
  let used = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = rest[i]!.block.length + (keptTail.length ? 2 : 0)
    if (used + cost > budget) break
    keptTail.unshift(rest[i]!)
    used += cost
  }
  const omitted = rest.length - keptTail.length

  const blocks: string[] = []
  if (head) blocks.push(head)
  if (truncated) blocks.push(`[… earlier messages omitted …]`)
  else if (omitted) blocks.push(`[… ${omitted} earlier messages omitted …]`)
  for (const m of keptTail) blocks.push(m.block)

  return { text: blocks.join("\n\n"), messagesKept: (head ? 1 : 0) + keptTail.length, omitted }
}
