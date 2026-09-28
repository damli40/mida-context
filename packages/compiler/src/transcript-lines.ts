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
export function readWindows(path: string): { head: Buffer; tail: Buffer | null; size: number } {
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
    if (size <= HEAD_BYTES + TAIL_BYTES) return { head: read(0, size), tail: null, size }
    return { head: read(0, HEAD_BYTES), tail: read(size - TAIL_BYTES, TAIL_BYTES), size }
  } finally {
    fs.closeSync(fd)
  }
}

export interface TranscriptLines {
  /**
   * One (label, text, offset) triple per line read — real 1-based numbers in
   * the head, "~n" in the tail. `offset` is the line's first byte in the file
   * at snapshot `size` — the identity the streamed scan pairs against, immune
   * to lines shifting position when the file is appended to between reads.
   */
  lines: { label: string; text: string; offset: number }[]
  /** True when the file was bigger than the windows and the middle was never read. */
  truncated: boolean
  /** The raw windows, for a reader's unknown-format tail fallback. */
  head: Buffer
  tail: Buffer | null
  /**
   * The file's byte size as fstat'd during the window read. A reader passes
   * it to scanTranscript so the scan describes exactly the bytes the windows
   * saw — a live transcript appending between the two reads stays invisible
   * to the pairing, which is what keeps one message from rendering twice.
   */
  size: number
}

/**
 * Split a window buffer into lines, tracking each line's byte offset from
 * `base`. Splitting the BYTES (not the decoded string) is exact: \n is 0x0A
 * and can never appear inside a multibyte UTF-8 character.
 */
function splitOffsets(buf: Buffer, base: number): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = []
  let start = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, start)
    if (nl === -1) {
      out.push({ offset: base + start, text: buf.subarray(start).toString("utf8") })
      return out
    }
    out.push({ offset: base + start, text: buf.subarray(start, nl).toString("utf8") })
    start = nl + 1
  }
}

/**
 * readWindows plus the line labelling. Head lines keep their real 1-based
 * numbers; tail lines are labelled "~n" — the line's place inside the tail
 * window, since its absolute number is unknowable without the middle.
 */
export function readTranscriptLines(path: string): TranscriptLines {
  const { head, tail, size } = readWindows(path)
  const truncated = tail !== null
  const lines: { label: string; text: string; offset: number }[] = []
  if (!truncated) {
    splitOffsets(head, 0).forEach((line, idx) => lines.push({ label: String(idx + 1), text: line.text, offset: line.offset }))
  } else {
    const headLines = splitOffsets(head, 0)
    // a last segment without its terminator is a partial line — its rest sits in the unread middle
    if (head.length > 0 && head[head.length - 1] !== 10) headLines.pop()
    headLines.forEach((line, idx) => lines.push({ label: String(idx + 1), text: line.text, offset: line.offset }))
    const tailLines = splitOffsets(tail, size - tail.length)
    tailLines.shift() // the first segment began before the window — a partial line
    tailLines.forEach((line, idx) => lines.push({ label: `~${idx + 1}`, text: line.text, offset: line.offset }))
  }
  return { lines, truncated, head, tail, size }
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
  /** Every typed user line, in file order, each with its real 1-based number and byte offset. */
  typed: { line: number; offset: number; text: string }[]
  /** Line numbers of candidate lines too long to parse — counted, never dropped silently. */
  tooLong: number[]
  /** The last compact-summary line, or null — same answer lastCompactSummaryLine gave. */
  summary: { label: string; text: string } | null
  /**
   * How many bytes of the file the scan actually covered — the `size` bound
   * the caller passed, or fewer when the file shrank under the read. A
   * window-read line at offset ≥ bound was never seen by this scan.
   */
  bound: number
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
export function scanTranscript(path: string, hooks: ScanHooks, size?: number): TranscriptScan {
  const fd = fs.openSync(path, "r")
  try {
    // `size` is the byte bound the caller's window read fstat'd — read only
    // [0, size) so the scan describes the SAME bytes the windows did (B2/S1):
    // lines appended to a live transcript between the two reads are out of
    // scope here, and a line's byte offset pairs it to its window mark.
    const bound0 = size ?? fs.fstatSync(fd).size
    const buf = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
    const decoder = new StringDecoder("utf8")
    let position = 0
    let lineNo = 0
    let lineStart = 0 // byte offset of the line under construction
    let lineBytes = 0 // bytes of the current line consumed so far
    let piece = "" // the line so far — emptied the moment it outgrows the cap
    let overflow = false // the line under construction already passed the cap
    let prefix = "" // the line's first bytes — kept even after the cap drops the rest
    const typed: { line: number; offset: number; text: string }[] = []
    const tooLong: number[] = []
    let summary: { label: string; text: string } | null = null
    // A candidate's neighbour rule needs the lines around it, so a line waits
    // in a 3-deep window until its two next neighbours have passed; prevUt is
    // the userText of the line just ahead of the window's head.
    let prevUt = ""
    const window: { text: string; ut: string; cand: boolean; big: boolean; lineNo: number; offset: number }[] = []
    const classify = (entry: { text: string; ut: string; cand: boolean; big: boolean; lineNo: number; offset: number }, next: string[]): void => {
      if (!entry.cand) return
      if (entry.big) {
        tooLong.push(entry.lineNo)
        return
      }
      const text = hooks.typedText(entry.text, { prev: prevUt, next })
      if (text !== null) typed.push({ line: entry.lineNo, offset: entry.offset, text })
    }
    const push = (entry: { text: string; ut: string; cand: boolean; big: boolean; lineNo: number; offset: number }): void => {
      window.push(entry)
      if (window.length === 3) {
        const head = window.shift()!
        classify(head, [window[0]!.ut, window[1]!.ut])
        prevUt = head.ut
      }
    }
    const finish = (text: string, tooLongLine: boolean, offset: number): void => {
      lineNo += 1
      if (tooLongLine || text.length > SUMMARY_LINE_BYTES) {
        // the line itself is gone — the kept prefix still answers the cheap check
        push({ text: "", ut: "", cand: hooks.candidate(prefix), big: true, lineNo, offset })
        return
      }
      if (hooks.summary !== undefined && hooks.summary(text)) summary = { label: `${lineNo}`, text }
      const cand = hooks.candidate(text)
      const big = cand && text.length > USER_LINE_BYTES
      push({ text, ut: cand && !big ? hooks.userText(text) : "", cand, big, lineNo, offset })
    }
    while (position < bound0) {
      const n = fs.readSync(fd, buf, 0, Math.min(SCAN_CHUNK_BYTES, bound0 - position), position)
      if (n <= 0) break // the file shrank between stat and read
      position += n
      const text = decoder.write(buf.subarray(0, n))
      let start = 0
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue
        // the segment's byte length is exact — a held multibyte split reports
        // its bytes when the decoder emits the completed character later
        const segBytes = Buffer.byteLength(text.slice(start, i))
        finish(overflow ? "" : piece + text.slice(start, i), overflow, lineStart)
        piece = ""
        prefix = ""
        overflow = false
        lineStart += lineBytes + segBytes + 1
        lineBytes = 0
        start = i + 1
      }
      const rest = text.slice(start)
      lineBytes += Buffer.byteLength(rest)
      if (prefix.length < SCAN_PREFIX_CHARS) prefix = (prefix + rest).slice(0, SCAN_PREFIX_CHARS)
      if (overflow || piece.length + rest.length > SUMMARY_LINE_BYTES) {
        piece = ""
        overflow = true
      } else {
        piece += rest
      }
    }
    piece += decoder.end()
    if (piece !== "" || overflow) finish(piece, overflow, lineStart) // a final line without its newline counts
    while (window.length > 0) {
      const head = window.shift()!
      classify(head, window.map((entry) => entry.ut))
      prevUt = head.ut
    }
    return { typed, tooLong, summary, bound: position }
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
  /**
   * The line's byte offset inside the transcript at the snapshot the reader
   * took — the identity the scan pairs on. Absent for marks built without a
   * file position (synthetic callers, the devin reader's DB-sourced lines).
   */
  offset?: number
  /** The scanned line this tail-window mark stands for — fills in its real label/order. */
  pair?: TypedMark
}

/** Order key for a tail-window mark whose real line number is unknowable. */
export const TAIL_ORDER = Number.MAX_SAFE_INTEGER

/** The typed lines a truncated file's scan found, the too-long count, and how far the scan read. */
export interface ScannedMarks {
  marks: TypedMark[]
  tooLong: number
  /** Bytes of the file the scan covered — see TranscriptScan.bound. */
  bound: number
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
  const sorted = candidates.slice().sort((a, b) => a.order - b.order)
  const tooLongLine =
    tooLong === 0
      ? null
      : `[${tooLong} message${tooLong === 1 ? " of yours was" : "s of yours were"} too long to read here]`
  const kept: string[] = []
  let used = tooLongLine === null ? 0 : tooLongLine.length
  let dropped = 0
  // Rendered newest-first and lazily — the settle loop above calls this per
  // candidate set, and only the admitted few need the scrub + two-sided cut.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const line = `${sorted[i]!.label}: ${twoEndedCut(scrubSecrets(sorted[i]!.text))}`
    const cost = line.length + (used > 0 ? 1 : 0)
    if (used + cost > USER_GROUP_CHARS) {
      dropped = i + 1
      break
    }
    kept.unshift(line)
    used += cost
  }
  const parts = ["user — later messages you typed, oldest first (outside the recent messages below):"]
  if (dropped > 0) parts.push(`[… ${dropped} older messages of yours omitted …]`)
  parts.push(...kept)
  if (tooLongLine !== null) parts.push(tooLongLine)
  return parts.join("\n")
}

export function fitMessages(
  msgs: { role: string; block: string; typed?: TypedMark; offset?: number }[],
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

  // The scan is AUTHORITATIVE for every line within its `bound` — it saw the
  // full neighbour context the truncated windows lacked (B2). Each mark pairs
  // with the scanned line that IS its line: matched on byte offset — the same
  // byte identity from the same snapshot — so a boundary-adjacent echo the two
  // passes classify differently can never shift every later label, and an
  // append between the reads cannot slide the pairing (S1). A mark the scan
  // saw but did not call typed loses its mark (it renders untyped in the
  // fill); a mark past the scan's bound — the file shrank between the reads —
  // keeps the window's own call. A scanned typed line no mark claimed lands in
  // the group under its real label, and one that sits inside a rendered
  // window line attaches there. Marks built with no byte offset at all keep
  // the pre-offset behaviour: order-keyed for numbered marks, positional for
  // tail marks.
  const restMarks = rest.map((m) => m.typed)
  let scanOnly: TypedMark[] = []
  if (scanned !== null && scanned !== undefined) {
    const byOffset = new Map<number, TypedMark>()
    const byOrder = new Map<number, TypedMark>()
    for (const s of scanned.marks) {
      if (s.offset !== undefined) byOffset.set(s.offset, s)
      if (s.order !== TAIL_ORDER) byOrder.set(s.order, s)
    }
    const consumed = new Set<TypedMark>()
    const offsetlessTail: TypedMark[] = []
    for (let i = 0; i < rest.length; i++) {
      const mark = restMarks[i]
      if (mark === undefined) continue
      let hit: TypedMark | undefined
      if (mark.offset !== undefined) hit = byOffset.get(mark.offset)
      else if (mark.order !== TAIL_ORDER) hit = byOrder.get(mark.order)
      if (hit !== undefined) {
        mark.pair = hit
        mark.label = hit.label
        mark.order = hit.order
        mark.text = hit.text
        consumed.add(hit)
      } else if (mark.offset === undefined && mark.order === TAIL_ORDER) {
        offsetlessTail.push(mark)
      } else if (mark.offset === undefined || mark.offset < scanned.bound) {
        restMarks[i] = undefined // the scan saw this line and said it is not typed
      }
      // else: the file shrank past the mark between the reads — the scan never
      // saw the line, so the window's call stands, unpaired
    }
    if (offsetlessTail.length > 0) {
      const avail = scanned.marks.filter((s) => !consumed.has(s))
      const base = Math.max(0, avail.length - offsetlessTail.length)
      for (let j = 0; j < offsetlessTail.length && base + j < avail.length; j++) {
        const mark = offsetlessTail[j]!
        mark.pair = avail[base + j]!
        mark.label = mark.pair.label
        mark.order = mark.pair.order
        mark.text = mark.pair.text
        consumed.add(mark.pair)
      }
    }
    // Upgrade pass: a line the scan calls typed but the window did not mark —
    // the scan saw neighbours the truncated window lacked — gets its mark back
    // under the scan's real label, attached to the window-rendered message at
    // the same byte offset. Whatever matches nothing rendered lives in the
    // group alone (scanOnly).
    const restByOffset = new Map<number, number>()
    for (let i = 0; i < rest.length; i++) {
      const offset = rest[i]!.offset
      if (offset !== undefined) restByOffset.set(offset, i)
    }
    const pinOffset = pin >= 0 ? msgs[pin]!.offset : undefined
    const pinOrder = pin >= 0 ? msgs[pin]!.typed?.order : undefined
    for (const s of scanned.marks) {
      if (consumed.has(s)) continue
      if (pinOffset !== undefined && s.offset === pinOffset) continue // the pinned request is never group content
      if (s.offset === undefined && pinOrder !== undefined && pinOrder !== TAIL_ORDER && s.order === pinOrder) continue
      const idx = s.offset === undefined ? undefined : restByOffset.get(s.offset)
      if (idx === undefined) {
        scanOnly.push(s)
      } else {
        if (restMarks[idx] === undefined) {
          restMarks[idx] = { label: s.label, order: s.order, offset: s.offset, text: s.text }
        }
        consumed.add(s)
      }
    }
  }

  const headCost = (head ? head.length + 2 : 0) + (extraPinned ? extraPinned.length + 2 : 0) + MARKER_RESERVE
  // The fill always keeps a SUFFIX of rest (newest-first until the next block
  // no longer fits); `m` is that suffix's left edge — rest[m..] are kept,
  // rest[0..m) are not.
  const fill = (budget: number): number => {
    let m = rest.length
    let used = 0
    while (m > 0) {
      const cost = rest[m - 1]!.block.length + (m < rest.length ? 2 : 0)
      if (used + cost > budget) break
      m -= 1
      used += cost
    }
    return m
  }
  const keptCost = (m: number): number => {
    if (m >= rest.length) return 0
    let used = rest[m]!.block.length
    for (let i = m + 1; i < rest.length; i++) used += rest[i]!.block.length + 2
    return used
  }
  // Every typed mark left of the fill edge is a group candidate — recomputed
  // from scratch, so an index displaced in either direction is seen again.
  const droppedFor = (m: number): Set<number> => {
    const dropped = new Set<number>()
    for (let i = 0; i < m; i++) if (restMarks[i] !== undefined) dropped.add(i)
    return dropped
  }
  const groupFor = (dropped: Set<number>): string | null =>
    buildUserGroup([...scanOnly, ...[...dropped].map((i) => restMarks[i]!)], scanned?.tooLong ?? 0)

  // The group's members depend on the fill; the fill's budget depends on the
  // group — in BOTH directions: a member the fill keeps leaves the group, but
  // the cap then admits an older member that was collapsed into the count
  // line, so the group can GROW and displace a message the fill just kept
  // (B1). Iterating toward a fixed point finds a consistent pair when one is
  // reachable quickly; the reconcile loop afterwards is the guarantee — it
  // rebuilds the group from the fill's true dropped set and releases fill →
  // group until the pair fits. Each reconcile round that does not finish has
  // released at least one typed message, so the group is rebuilt at most once
  // per typed message and the kept set only ever shrinks — the loop always
  // terminates with every typed message in exactly one place.
  const hasGroupWork = scanOnly.length > 0 || (scanned?.tooLong ?? 0) > 0 || restMarks.some((m) => m !== undefined)
  let group: string | null = null
  let m = rest.length
  if (hasGroupWork) {
    let dropped = droppedFor(m)
    for (let iter = 0; iter < 8; iter++) {
      group = groupFor(dropped)
      const budget = Math.max(0, maxChars - headCost - (group === null ? 0 : group.length + 2))
      m = fill(budget)
      const after = droppedFor(m)
      if (after.size === dropped.size && [...after].every((i) => dropped.has(i))) break
      dropped = after
    }
    for (;;) {
      dropped = droppedFor(m)
      group = groupFor(dropped)
      const budget = Math.max(0, maxChars - headCost - (group === null ? 0 : group.length + 2))
      let used = keptCost(m)
      if (used <= budget || m >= rest.length) break
      // Release the oldest kept messages until this gap is closed. Releasing a
      // typed message grows the group (the next round re-accounts its cost);
      // releasing untyped ones is pure progress. Fill → group only.
      let releasedTyped = false
      while (used > budget && m < rest.length) {
        if (restMarks[m] !== undefined) releasedTyped = true
        used -= rest[m]!.block.length + (rest.length - m > 1 ? 2 : 0)
        m += 1
      }
      if (!releasedTyped) break // group cannot grow — done even if still over
    }
  } else {
    m = fill(Math.max(0, maxChars - headCost))
  }
  const keptTail = rest.slice(m)
  const omitted = m

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
