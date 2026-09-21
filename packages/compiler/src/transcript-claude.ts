// Turn a Claude Code session transcript (one JSON object per line) into the
// compact text the extractor actually needs. Ported from
// spike/hooks/transcript-claude.mjs.
//
// Why this exists: a measured headless transcript was 175 KB in 32 lines of
// which ~75% was a single "prompt_snapshot" attachment and ~25 KB other
// bookkeeping; the real conversation was 752 bytes. Sending the raw tail
// feeds the model noise and — worse — drops the FIRST user message, which
// is where the objective and constraints live.
//
// readConversation(path, { maxChars }) →
//   claude format: { format: "claude-jsonl", text, messagesKept,
//                    messagesTotal, omitted }
//   anything else (e.g. a Codex transcript — its format is unverified, do
//   not guess it): the old behaviour, a scrubbed last-60 KB tail:
//   { format: "unknown-tail", text, messagesKept: 0, messagesTotal: 0,
//     omitted: 0 }
//
// Rendering: each kept message becomes one block headed "L<n> <role>:" where
// <n> is the real 1-based line number in the file, so the extractor can cite
// evidence as transcript:L<n>. In a truncated file the tail lines' absolute
// numbers are unknowable without reading the middle, so they are headed
// "L~<n> <role>:" — <n> counts the tail window's lines, flagging the number
// as relative rather than a file line number. Secrets are scrubbed on the
// DECODED text of every rendered part (this replaces the raw-line
// scrubTranscript call for this format).
//
// The result also carries firstUserMessage: the first `user` line whose
// content is a plain string or has a `text` part (a bare `tool_result` does
// not count — resumed sessions open with tool output, not the request). It
// is scrubbed and hard-capped at 6,000 chars *including* the ellipsis, so it
// always fits the schema's originalRequest cap. unknown-tail → null.
//
// Reads are bounded: the file is opened once and never loaded whole. A
// transcript no bigger than HEAD_BYTES + TAIL_BYTES is read in one shot —
// byte-for-byte the old behaviour. A bigger one gets the first HEAD_BYTES
// (the original request lives at the top) and the last TAIL_BYTES (the
// newest messages live at the bottom), and the middle is never touched:
// messagesTotal and cwds then count only the lines that were read.

import fs from "node:fs"
import { scrubSecrets, scrubTranscript, scrubValue } from "./scrub.js"

const HEAD_BYTES = 64 * 1024 // bounded head — the first user message lives at the top
const TAIL_BYTES = 60_000 // tail window — the newest messages live at the bottom
const THINKING_CHARS = 1_000
const PART_CHARS = 600
const FIRST_USER_CHARS = 6_000
// Room kept aside for the "[… N earlier messages omitted …]" marker so the
// final text stays under maxChars even when the marker is needed.
const MARKER_RESERVE = 96

export interface Conversation {
  format: "claude-jsonl" | "unknown-tail"
  text: string // "L<n> <role>:" blocks, ≤ maxChars
  firstUserMessage: string | null // verbatim, scrubbed, ≤ 6000 chars incl. "…"
  /**
   * Every distinct working folder the transcript itself records — Claude Code stamps a `cwd`
   * field on each line — unique, in first-seen order. A file whose lines record none answers []:
   * "no record", never a guess.
   */
  cwds: string[]
  messagesKept: number
  messagesTotal: number
  omitted: number
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s)
// Unlike cut(), the ellipsis is counted INSIDE the limit: the result is at
// most n chars, so it can never trip the schema's 6,000-char cap.
const hardCut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

// One line of the JSONL transcript, typed only as far as the reader looks.
interface TranscriptLine {
  type?: string
  cwd?: unknown
  message?: { content?: unknown }
}

// One content part inside message.content, typed only as far as the reader
// looks: text/thinking strings, a tool_use name/input, a tool_result content.
interface ContentPart {
  type?: unknown
  text?: unknown
  thinking?: unknown
  name?: unknown
  input?: unknown
  content?: unknown
}

const isPart = (p: unknown): p is ContentPart => p !== null && typeof p === "object"

// The request text of one user line: the string content, or the joined
// `text` parts of array content. Returns "" for a bare tool_result (or
// anything without real text) so the caller keeps looking at later lines.
function userRequestText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is ContentPart => isPart(p) && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
  }
  return ""
}

// tool_result content is either a string or an array of {type:"text"} parts.
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is ContentPart => isPart(p) && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
  }
  return ""
}

// Render one user/assistant line as "L<label> <role>:\n<parts>" — the label
// is the real line number, or "~<n>" for a tail line whose absolute number is
// unknowable. Returns null when the message renders to nothing (empty content).
function renderMessage(label: string, obj: TranscriptLine): string | null {
  const content = obj.message?.content
  const parts: string[] = []
  if (typeof content === "string") {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (!isPart(p)) continue
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text)
      else if (p.type === "thinking" && typeof p.thinking === "string")
        parts.push(`[thinking] ${cut(p.thinking, THINKING_CHARS)}`)
      else if (p.type === "tool_use") {
        let input = ""
        try {
          // scrubValue first: a secret under a sensitive key name survives
          // the string-level scrub once JSON-escaped (its value may contain
          // spaces), so key-name redaction has to happen on the object.
          input = JSON.stringify(scrubValue(p.input ?? null)) ?? ""
        } catch {
          input = ""
        }
        parts.push(`[tool ${String(p.name ?? "?")}] ${cut(input, PART_CHARS)}`)
      } else if (p.type === "tool_result") {
        parts.push(`[result] ${cut(toolResultText(scrubValue(p.content)), PART_CHARS)}`)
      }
    }
  }
  const body = parts
    .map((p) => scrubSecrets(p))
    .filter((p) => p.length)
    .join("\n")
  if (!body) return null
  return `L${label} ${obj.type}:\n${body}`
}

/**
 * One open descriptor, at most HEAD_BYTES + TAIL_BYTES read: the whole file when it fits,
 * else {head: first HEAD_BYTES, tail: last TAIL_BYTES} — the middle stays on disk.
 */
function readWindows(path: string): { head: Buffer; tail: Buffer | null } {
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

export function readConversation(
  transcriptPath: string,
  options: { maxChars?: number } = {},
): Conversation {
  const { maxChars = 40_000 } = options

  // Bounded reads from one descriptor: a file that fits inside head+tail is
  // read once end to end; anything bigger gets only its head and tail windows.
  const { head: headWindow, tail: tailWindow } = readWindows(transcriptPath)
  const truncated = tailWindow !== null

  // One (label, text) pair per line. Head lines keep their real 1-based
  // numbers; tail lines are labelled "~n" — the line's place inside the tail
  // window, since its absolute number is unknowable without the middle.
  const lines: { label: string; text: string }[] = []
  if (!truncated) {
    headWindow.toString("utf8").split("\n").forEach((line, idx) => lines.push({ label: String(idx + 1), text: line }))
  } else {
    const headLines = headWindow.toString("utf8").split("\n")
    // a last segment without its terminator is a partial line — its rest sits in the unread middle
    if (headWindow.length > 0 && headWindow[headWindow.length - 1] !== 10) headLines.pop()
    headLines.forEach((line, idx) => lines.push({ label: String(idx + 1), text: line }))
    const tailLines = tailWindow.toString("utf8").split("\n")
    tailLines.shift() // the first segment began before the window — a partial line
    tailLines.forEach((line, idx) => lines.push({ label: `~${idx + 1}`, text: line }))
  }

  // messagesTotal counts every user/assistant line read (even ones that
  // render empty); msgs holds only those that produced a rendered block.
  const msgs: { role: string; block: string }[] = []
  const cwds: string[] = []
  let messagesTotal = 0
  let firstUserMessage: string | null = null
  for (const { label, text: line } of lines) {
    if (!line.trim()) continue
    let obj: TranscriptLine
    try {
      obj = JSON.parse(line)
    } catch {
      continue // truncated or non-JSON line — skip
    }
    const folder = obj?.cwd
    if (typeof folder === "string" && folder !== "" && !cwds.includes(folder)) cwds.push(folder)
    if (obj?.type !== "user" && obj?.type !== "assistant") continue
    messagesTotal++
    if (firstUserMessage === null && obj.type === "user") {
      const t = userRequestText(obj.message?.content)
      if (t) firstUserMessage = hardCut(scrubSecrets(t), FIRST_USER_CHARS)
    }
    const block = renderMessage(label, obj)
    if (block) msgs.push({ role: obj.type, block })
  }

  if (messagesTotal === 0) {
    const tailText = (tailWindow ?? headWindow.subarray(Math.max(0, headWindow.length - TAIL_BYTES))).toString("utf8")
    return {
      format: "unknown-tail",
      text: scrubTranscript(tailText),
      firstUserMessage: null,
      cwds,
      messagesKept: 0,
      messagesTotal: 0,
      omitted: 0,
    }
  }

  // The first user message carries the objective and constraints — pin it
  // (cut at 6,000 chars). Everything else competes for the remaining budget,
  // filled from the most recent backwards. When the pinned block ALONE is
  // bigger than maxChars it is cut to maxChars − 200 so the final text still
  // fits (firstUserMessage itself is unaffected — it has its own 6,000 cap).
  const pinIdx = msgs.findIndex((m) => m.role === "user")
  const headCap = Math.min(FIRST_USER_CHARS, Math.max(0, maxChars - 200))
  const head = pinIdx >= 0 ? cut(msgs[pinIdx]!.block, headCap) : null
  const rest = msgs.filter((_, i) => i !== pinIdx)

  const budget = Math.max(0, maxChars - (head ? head.length + 2 : 0) - MARKER_RESERVE)
  const keptTail: { role: string; block: string }[] = []
  let used = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = rest[i]!.block.length + (keptTail.length ? 2 : 0)
    if (used + cost > budget) break
    keptTail.unshift(rest[i]!)
    used += cost
  }
  // When the middle was never read the true omitted count is unknowable —
  // count only the lines that were read but did not fit, and say so.
  const omitted = rest.length - keptTail.length

  const blocks: string[] = []
  if (head) blocks.push(head)
  if (truncated) blocks.push(`[… earlier messages omitted …]`)
  else if (omitted) blocks.push(`[… ${omitted} earlier messages omitted …]`)
  for (const m of keptTail) blocks.push(m.block)

  return {
    format: "claude-jsonl",
    text: blocks.join("\n\n"),
    firstUserMessage,
    cwds,
    messagesKept: (head ? 1 : 0) + keptTail.length,
    messagesTotal,
    omitted,
  }
}
