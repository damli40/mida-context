// The bounded transcript read shared by the per-format readers, moved out of
// transcript-claude.ts unchanged: the file is opened once and never loaded
// whole. A transcript no bigger than HEAD_BYTES + TAIL_BYTES is read in one
// shot; a bigger one gets the first HEAD_BYTES (the original request lives at
// the top) and the last TAIL_BYTES (the newest messages live at the bottom),
// and only the windowed lines are parsed — messagesTotal and cwds then count
// only the lines that were read. A truncated file still gets ONE streamed
// pass over the middle (lastCompactSummaryLine below — bounded chunks, the
// line under construction dropped past a cap) to find the last /compact
// summary wherever it sits; the middle is never held in memory or read as
// conversation.
//
// Also shared here: the small render helpers both readers use — cut/hardCut,
// the part/first-message caps, and the budgeted pin-first-user assembly that
// fills the remaining maxChars from the most recent message backwards.

import fs from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { scrubSecrets } from "./scrub.js"

export const HEAD_BYTES = 64 * 1024 // bounded head — the first user message lives at the top
export const TAIL_BYTES = 60_000 // tail window — the newest messages live at the bottom
export const PART_CHARS = 600
export const FIRST_USER_CHARS = 6_000
// A line the format's cheap check flags as a possible typed user message is
// not parsed past this size — it is counted and marked, never read whole.
export const USER_LINE_BYTES = 256 * 1024
// The pinned block of later typed messages gets its own share of the budget,
// charged before the newest-first fill.
export const USER_GROUP_CHARS = 8_000
// A typed user message renders as its first 1,200 and last 600 chars — a
// pasted log keeps its start and its end instead of only its first lines.
export const USER_HEAD_CHARS = 1_200
export const USER_TAIL_CHARS = 600
// Room kept aside for the "[… N earlier messages omitted …]" marker so the
// final text stays under maxChars even when the marker is needed.
export const MARKER_RESERVE = 96

export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s)
// Unlike cut(), the ellipsis is counted INSIDE the limit: the result is at
// most n chars, so it can never trip the schema's 6,000-char cap.
export const hardCut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

/**
 * The user's own words get a wider, two-sided cut than a tool block: the first
 * USER_HEAD_CHARS and the last USER_TAIL_CHARS joined by a marker. Scrub the
 * text BEFORE this runs — a secret straddling the cut must already be gone.
 */
export function twoEndedCut(text: string): string {
  if (text.length <= USER_HEAD_CHARS + USER_TAIL_CHARS) return text
  return `${text.slice(0, USER_HEAD_CHARS)}\n[… middle of your message cut …]\n${text.slice(-USER_TAIL_CHARS)}`
}

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

/** Chunk size for the whole-file scan below — bounded, never the file at once. */
const SCAN_CHUNK_BYTES = 64 * 1024
/** A compact-summary line longer than this is skipped, not retained. */
export const SUMMARY_LINE_BYTES = 400 * 1024
/** How much of an over-cap line's start is kept for the cheap candidate check. */
const SCAN_PREFIX_CHARS = 4 * 1024

/**
 * What one format needs the streamed pass to know about its lines. Every hook
 * sees the line's raw text; JSON parsing stays inside the format's code so a
 * hook can run its cheap string check first and skip the parse entirely.
 */
export interface ScanHooks {
  /** Cheap pre-check — a line failing it is never parsed for typed text. */
  candidate(text: string): boolean
  /**
   * The line's raw user-role text (tags intact), or "" when the line is not a
   * candidate or carries none. Feeds the neighbour checks — formats whose
   * command echoes are decided by the lines around them read this, never the
   * rendered text.
   */
  userText(text: string): string
  /**
   * A candidate's typed text — the user's own words as the reader's shared
   * classifier sees them — or null when the line is not a typed message.
   * `neighbours.prev` is the previous line's userText; `neighbours.next` is up
   * to two following lines' userText — the window a command-echo rule needs.
   */
  typedText(text: string, neighbours: { prev: string; next: string[] }): string | null
  /** The format's compact-summary test, when it has one — the last true wins. */
  summary?(text: string): boolean
}

export interface TranscriptScan {
  /** Every typed user line, in file order, each with its real 1-based number. */
  typed: { line: number; text: string }[]
  /** Line numbers of candidate lines too long to parse — counted, never dropped silently. */
  tooLong: number[]
  /** The last compact-summary line, or null — same answer lastCompactSummaryLine gave. */
  summary: { label: string; text: string } | null
}

/**
 * One streamed pass over the whole file — SCAN_CHUNK_BYTES at a time, never
 * more than one capped line in memory — returning BOTH the last compact
 * summary (unchanged behaviour) and every line the format's classifier calls
 * typed, each with its real 1-based line number. The typed decision may need
 * the neighbouring lines' userText (one back, up to two ahead), so a line is
 * classified once two more have passed; over-cap candidates are counted in
 * `tooLong` instead of parsed.
 */
export function scanTranscript(path: string, hooks: ScanHooks): TranscriptScan {
  const fd = fs.openSync(path, "r")
  try {
    const size = fs.fstatSync(fd).size
    const buf = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
    const decoder = new StringDecoder("utf8")
    let position = 0
    let lineNo = 0
    let piece = "" // the line so far — emptied the moment it outgrows the cap
    let overflow = false // the line under construction already passed the cap
    let prefix = "" // the line's first bytes — kept even after the cap drops the rest
    const typed: { line: number; text: string }[] = []
    const tooLong: number[] = []
    let summary: { label: string; text: string } | null = null
    // A candidate's neighbour rule needs the lines around it, so a line waits
    // in a 3-deep window until its two next neighbours have passed; prevUt is
    // the userText of the line just ahead of the window's head.
    let prevUt = ""
    const window: { text: string; ut: string; cand: boolean; big: boolean; lineNo: number }[] = []
    const classify = (entry: { text: string; ut: string; cand: boolean; big: boolean; lineNo: number }, next: string[]): void => {
      if (!entry.cand) return
      if (entry.big) {
        tooLong.push(entry.lineNo)
        return
      }
      const text = hooks.typedText(entry.text, { prev: prevUt, next })
      if (text !== null) typed.push({ line: entry.lineNo, text })
    }
    const push = (entry: { text: string; ut: string; cand: boolean; big: boolean; lineNo: number }): void => {
      window.push(entry)
      if (window.length === 3) {
        const head = window.shift()!
        classify(head, [window[0]!.ut, window[1]!.ut])
        prevUt = head.ut
      }
    }
    const finish = (text: string, tooLongLine: boolean): void => {
      lineNo += 1
      if (tooLongLine || text.length > SUMMARY_LINE_BYTES) {
        // the line itself is gone — the kept prefix still answers the cheap check
        push({ text: "", ut: "", cand: hooks.candidate(prefix), big: true, lineNo })
        return
      }
      if (hooks.summary !== undefined && hooks.summary(text)) summary = { label: `${lineNo}`, text }
      const cand = hooks.candidate(text)
      const big = cand && text.length > USER_LINE_BYTES
      push({ text, ut: cand && !big ? hooks.userText(text) : "", cand, big, lineNo })
    }
    while (position < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(SCAN_CHUNK_BYTES, size - position), position)
      if (n <= 0) break // the file shrank between stat and read
      position += n
      const text = decoder.write(buf.subarray(0, n))
      let start = 0
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue
        finish(overflow ? "" : piece + text.slice(start, i), overflow)
        piece = ""
        prefix = ""
        overflow = false
        start = i + 1
      }
      const rest = text.slice(start)
      if (prefix.length < SCAN_PREFIX_CHARS) prefix = (prefix + rest).slice(0, SCAN_PREFIX_CHARS)
      if (overflow || piece.length + rest.length > SUMMARY_LINE_BYTES) {
        piece = ""
        overflow = true
      } else {
        piece += rest
      }
    }
    piece += decoder.end()
    if (piece !== "" || overflow) finish(piece, overflow) // a final line without its newline counts
    while (window.length > 0) {
      const head = window.shift()!
      classify(head, window.map((entry) => entry.ut))
      prevUt = head.ut
    }
    return { typed, tooLong, summary }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The summary half of scanTranscript kept under its old name: the LAST line
 * whose parsed JSON carries `"isCompactSummary": true`, wherever it sits.
 * Callers that need the typed lines too should take the one-pass scanTranscript
 * instead of scanning twice.
 */
export function lastCompactSummaryLine(path: string): { label: string; text: string } | null {
  return scanTranscript(path, {
    candidate: () => false,
    userText: () => "",
    typedText: () => null,
    summary: (text) => {
      if (!text.includes('"isCompactSummary"')) return false
      try {
        const obj = JSON.parse(text) as { isCompactSummary?: unknown } | null
        return obj !== null && typeof obj === "object" && obj.isCompactSummary === true
      } catch {
        // a line that merely mentions the flag inside a value is not the summary
        return false
      }
    },
  }).summary
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
 * Absent or out of range, NOTHING is pinned: with no real request picked, the
 * first user block is not a stand-in for one.
 *
 * `extraPinned` is a second already-rendered block the reader needs to keep —
 * the /compact session summary. It sits right after the pinned request and
 * before the omitted marker, costs its length out of the budget, and the
 * newest-first fill never touches it.
 *
 * `leadPinned` is a rendered head block that is NOT a line in this file —
 * the earlier checkpoint's kept originalRequest (M1). It takes the head
 * slot whole (the caller already capped it), and the file's own pinIdx
 * pick is then an ordinary message that competes for the tail like every
 * other, never silently dropped.
 */
/**
 * One message the user typed, carried beside its rendered block (or found only
 * by the streamed scan): `label` is its display label — "L812", "N3", "L~5" —
 * `order` its place in the file (the real line number, or the chain position;
 * an unpaired tail mark keeps TAIL_ORDER so it sorts after every numbered
 * line), and `text` the classifier's typed words, unscrubbed.
 */
export interface TypedMark {
  label: string
  order: number
  text: string
  /** The scanned line this tail-window mark stands for — fills in its real label/order. */
  pair?: TypedMark
}

/** Order key for a tail-window mark whose real line number is unknowable. */
export const TAIL_ORDER = Number.MAX_SAFE_INTEGER

/** The typed lines a truncated file's scan found plus the too-long count — the group's scan half. */
export interface ScannedMarks {
  marks: TypedMark[]
  tooLong: number
}

/**
 * The pinned group P-1 adds: every typed user message the newest-first fill
 * would lose — dropped by the fill, or found only in the unread middle — as
 * one block between the pinned request/summary and the omitted marker:
 *
 *   user — later messages you typed, oldest first (outside the recent messages below):
 *   [… N older messages of yours omitted …]
 *   L812: <text>
 *   L1403: <text>
 *   [2 messages of yours were too long to read here]
 *
 * Newest messages win inside the USER_GROUP_CHARS cap; older ones collapse
 * into the count line. Returns null when there is nothing to pin.
 */
function buildUserGroup(candidates: TypedMark[], tooLong: number): string | null {
  if (candidates.length === 0 && tooLong === 0) return null
  const lines = candidates
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((m) => `${m.label}: ${twoEndedCut(scrubSecrets(m.text))}`)
  const tooLongLine =
    tooLong === 0
      ? null
      : `[${tooLong} message${tooLong === 1 ? " of yours was" : "s of yours were"} too long to read here]`
  const kept: string[] = []
  let used = tooLongLine === null ? 0 : tooLongLine.length
  let dropped = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + (used > 0 ? 1 : 0)
    if (used + cost > USER_GROUP_CHARS) {
      dropped = i + 1
      break
    }
    kept.unshift(lines[i]!)
    used += cost
  }
  const parts = ["user — later messages you typed, oldest first (outside the recent messages below):"]
  if (dropped > 0) parts.push(`[… ${dropped} older messages of yours omitted …]`)
  parts.push(...kept)
  if (tooLongLine !== null) parts.push(tooLongLine)
  return parts.join("\n")
}

export function fitMessages(
  msgs: { role: string; block: string; typed?: TypedMark }[],
  maxChars: number,
  truncated: boolean,
  pinIdx?: number,
  extraPinned?: string | null,
  leadPinned?: string | null,
  scanned?: ScannedMarks | null,
): { text: string; messagesKept: number; omitted: number } {
  const lead = leadPinned ?? null
  const pin = lead === null && pinIdx !== undefined && pinIdx >= 0 && pinIdx < msgs.length ? pinIdx : -1
  const headCap = Math.min(FIRST_USER_CHARS, Math.max(0, maxChars - 200))
  const head = lead ?? (pin >= 0 ? cut(msgs[pin]!.block, headCap) : null)
  const rest = msgs.filter((_, i) => i !== pin)

  // The scan saw every typed line in the file; the marks carry the ones the
  // windows rendered. Dedupe by identity: a scanned line whose order matches a
  // numbered mark is that mark; the LAST K scanned lines pair positionally
  // with the K tail marks (the tail window is the file's end), giving each
  // tail mark its real label. Whatever remains lives only in the group.
  const marks = msgs.map((m) => m.typed)
  const tailMarkIdx: number[] = []
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] !== undefined && marks[i]!.order === TAIL_ORDER) tailMarkIdx.push(i)
  }
  const numbered = new Set<number>()
  for (const m of marks) if (m !== undefined && m.order !== TAIL_ORDER) numbered.add(m.order)
  let scanOnly: TypedMark[] = []
  if (scanned !== null && scanned !== undefined) {
    const avail = scanned.marks.filter((s) => !numbered.has(s.order))
    if (tailMarkIdx.length > 0) {
      const base = Math.max(0, avail.length - tailMarkIdx.length)
      for (let j = 0; j < tailMarkIdx.length && base + j < avail.length; j++) {
        const mark = marks[tailMarkIdx[j]!]!
        mark.pair = avail[base + j]
        mark.label = mark.pair!.label
        mark.order = mark.pair!.order
      }
      scanOnly = avail.slice(0, base)
    } else {
      scanOnly = avail
    }
  }

  const headCost = (head ? head.length + 2 : 0) + (extraPinned ? extraPinned.length + 2 : 0) + MARKER_RESERVE
  const fill = (budget: number): number[] => {
    const kept: number[] = []
    let used = 0
    for (let i = rest.length - 1; i >= 0; i--) {
      const cost = rest[i]!.block.length + (kept.length ? 2 : 0)
      if (used + cost > budget) break
      kept.unshift(i)
      used += cost
    }
    return kept
  }

  // The group's members depend on the fill; the fill's budget depends on the
  // group. Seed it with every typed mark as a candidate, then let survivors
  // leave the group — strictly shrinking, so a couple of passes settles it.
  const hasGroupWork = scanOnly.length > 0 || (scanned?.tooLong ?? 0) > 0 || marks.some((m) => m !== undefined)
  const dropped = new Set<number>()
  for (let i = 0; i < rest.length; i++) if (rest[i]!.typed !== undefined) dropped.add(i)
  let group: string | null = null
  let keptIdx: number[] = []
  if (hasGroupWork) {
    for (let iter = 0; iter < 8; iter++) {
      const candidates = [...scanOnly, ...[...dropped].map((i) => rest[i]!.typed!)]
      const next = buildUserGroup(candidates, scanned?.tooLong ?? 0)
      const budget = Math.max(0, maxChars - headCost - (next === null ? 0 : next.length + 2))
      keptIdx = fill(budget)
      const survivors = new Set(keptIdx)
      const before = dropped.size
      for (const i of [...dropped]) if (survivors.has(i)) dropped.delete(i)
      group = next
      if (dropped.size === before) break
    }
  } else {
    keptIdx = fill(Math.max(0, maxChars - headCost))
  }
  const keptTail = keptIdx.map((i) => rest[i]!)
  const omitted = rest.length - keptTail.length

  const blocks: string[] = []
  if (head) blocks.push(head)
  if (extraPinned) blocks.push(extraPinned)
  if (group !== null) blocks.push(group)
  if (truncated) blocks.push(`[… earlier messages omitted …]`)
  else if (omitted) blocks.push(`[… ${omitted} earlier messages omitted …]`)
  for (const m of keptTail) blocks.push(m.block)

  return {
    text: blocks.join("\n\n"),
    // the group is a synthetic block, not a transcript message — counting it
    // would break the omitted = total − kept invariant the callers rely on
    messagesKept: (head ? 1 : 0) + (extraPinned ? 1 : 0) + keptTail.length,
    omitted,
  }
}
