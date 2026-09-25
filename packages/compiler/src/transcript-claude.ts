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
// content is a plain string or has a `text` part AND is not Claude Code
// scaffolding — a bare `tool_result` does not count (resumed sessions open
// with tool output, not the request), and neither do isMeta/isCompactSummary
// lines or the injected <local-command-caveat>/<command-name>/… tags a
// /compact puts ahead of the human's words. It is scrubbed and hard-capped at
// 6,000 chars *including* the ellipsis, so it always fits the schema's
// originalRequest cap. unknown-tail → null.
//
// Reads are bounded: the file is opened once and never loaded whole (see
// transcript-lines.ts). A transcript no bigger than HEAD_BYTES + TAIL_BYTES
// is read in one shot — byte-for-byte the old behaviour. A bigger one gets
// the first HEAD_BYTES (the original request lives at the top) and the last
// TAIL_BYTES (the newest messages live at the bottom); only the windowed
// lines are parsed, so messagesTotal and cwds then count only the lines that
// were read. A truncated file still gets one streamed pass over the middle —
// lastCompactSummaryLine, bounded chunks — to find the last /compact summary
// wherever it sits; the middle is never held in memory or read as
// conversation.

import { scrubSecrets, scrubTranscript, scrubValue } from "./scrub.js"
import {
  FIRST_USER_CHARS,
  PART_CHARS,
  TAIL_BYTES,
  cut,
  hardCut,
  fitMessages,
  lastCompactSummaryLine,
  readTranscriptLines,
} from "./transcript-lines.js"

const THINKING_CHARS = 1_000

// A /compact summary carries its newest state — pending tasks, current work,
// the next step — at the END, so a one-sided cut kept the stale opening and
// dropped exactly what the next session needs. Keep both ends: the first
// 2,000 and the last 4,000 chars joined by a marked gap (~6,050 total, the
// same ~6 KB the request cap budgets for).
const SUMMARY_HEAD_CHARS = 2_000
const SUMMARY_TAIL_CHARS = 4_000
const cutSummary = (s: string): string =>
  s.length <= SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS
    ? s
    : `${s.slice(0, SUMMARY_HEAD_CHARS)}\n[… middle of the summary cut …]\n${s.slice(-SUMMARY_TAIL_CHARS)}`

export interface Conversation {
  format: "claude-jsonl" | "codex-jsonl" | "unknown-tail"
  text: string // "L<n> <role>:" blocks, ≤ maxChars
  firstUserMessage: string | null // verbatim, scrubbed, ≤ 6000 chars incl. "…"
  /**
   * True when a user-role line was skipped before firstUserMessage was picked
   * — the transcript opened on injected context, a compact summary, a command
   * echo or a resumed tool_result. That makes this compile's pick a
   * CONTINUATION line, not the session's original ask (G3): compile.ts keeps
   * the previous checkpoint's originalRequest over it.
   */
  openedWithScaffolding: boolean
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

// One line of the JSONL transcript, typed only as far as the reader looks.
interface TranscriptLine {
  type?: string
  cwd?: unknown
  /** Claude Code's own bookkeeping flag — caveat and command-echo lines carry it. */
  isMeta?: unknown
  /** Set on the condensed-history line Claude Code writes into the transcript at compact time. */
  isCompactSummary?: unknown
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

// Claude Code's own commands. An echo of one is never the user's ask — args or
// not: "/model sonnet" and "/compact focus on parser" are the tool's plumbing.
const BUILTIN_COMMANDS = new Set([
  "compact", "clear", "model", "init", "help", "cost", "resume", "config",
  "login", "logout", "memory", "mcp", "permissions", "doctor", "status",
  "agents", "hooks", "context", "export", "exit", "rewind", "statusline",
  "add-dir", "bug", "vim", "terminal-setup", "ide", "upgrade",
  "release-notes", "privacy-settings", "output-style", "todos",
])

// A custom slash command's real ask hides inside its echo: Claude Code logs
// `/brainstorm build a login page` as <command-name>/<command-message>/
// <command-args>, so the request is "/name args" — or just "/name" when the
// command takes no arguments. A line counts as an echo only when, after
// leading whitespace, it OPENS on <command-message> or <command-name> — a
// prompt that merely quotes the tags mid-sentence is the user's prose, and
// their words stay the request (L4). The real echo can put <command-message>
// FIRST, so the name tag is searched anywhere in the line, not only at the
// start.
// Returns null for a built-in, whether the name list catches it or the plumbing
// does: Claude Code answers built-ins with a <local-command-caveat> or
// <local-command-stdout>/<stderr> block on a NEIGHBOURING user line, so the
// caller also passes whether one sits at the neighbouring positions.
function slashCommandRequest(text: string, neighbourLocalCommand: boolean): string | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("<command-message>") && !trimmed.startsWith("<command-name>")) return null
  const name = /<command-name>\s*(\/\S+)\s*<\/command-name>/.exec(text)?.[1]
  if (name === undefined) return null
  if (BUILTIN_COMMANDS.has(name.slice(1))) return null
  if (
    neighbourLocalCommand ||
    text.includes("<local-command-caveat>") ||
    text.includes("<local-command-stdout>") ||
    text.includes("<local-command-stderr>")
  ) {
    return null
  }
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args === undefined || args === "" ? name : `${name} ${args}`
}

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

// The user's own words on one line, ready to be the request: each text part
// with its leading injected blocks stripped, parts that empty out dropped.
// "" means the line held no text or nothing but scaffolding.
function userVisibleText(content: unknown): string {
  if (typeof content === "string") return stripLeadingScaffolds(content)
  if (Array.isArray(content)) {
    return content
      .filter((p): p is ContentPart => isPart(p) && p.type === "text" && typeof p.text === "string")
      .map((p) => stripLeadingScaffolds(p.text as string))
      .filter((t) => t !== "")
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
  const isUser = obj.type === "user"
  const parts: string[] = []
  // a user text keeps its words after a leading injected block — the reminder
  // goes, the ask stays; a part that was all scaffolding contributes nothing
  const pushText = (text: string) => {
    const t = isUser ? stripLeadingScaffolds(text) : text
    if (t !== "") parts.push(t)
  }
  if (typeof content === "string") {
    pushText(content)
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (!isPart(p)) continue
      if (p.type === "text" && typeof p.text === "string") pushText(p.text)
      else if (p.type === "thinking" && typeof p.thinking === "string")
        // scrub before the cut, like the Codex reader: a secret straddling
        // the 1,000-char boundary would otherwise leak an unredactable fragment
        parts.push(`[thinking] ${cut(scrubSecrets(p.thinking), THINKING_CHARS)}`)
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

export function readConversation(
  transcriptPath: string,
  options: {
    maxChars?: number
    /**
     * The earlier checkpoint's originalRequest, already re-checked for
     * scaffolding by the caller. When this file opened on scaffolding — or
     * pinned no request of its own — its own firstUserMessage is a
     * continuation line, so the kept request heads the render instead and the
     * file's pick competes for the tail like any other message (M1).
     */
    preferRequest?: string | null
  } = {},
): Conversation {
  const { maxChars = 40_000 } = options

  // Bounded reads from one descriptor: a file that fits inside head+tail is
  // read once end to end; anything bigger gets only its head and tail windows.
  const { lines, truncated, head: headWindow, tail: tailWindow } = readTranscriptLines(transcriptPath)

  // Every line parsed up front, so a command echo can be judged against its
  // NEIGHBOURING user lines: Claude Code writes a built-in's caveat/stdout on
  // their own lines next to the echo, never inside it.
  const entries: { label: string; obj: TranscriptLine | null }[] = []
  for (const { label, text: line } of lines) {
    if (!line.trim()) {
      entries.push({ label, obj: null })
      continue
    }
    try {
      const obj = JSON.parse(line) as TranscriptLine | null
      entries.push({ label, obj: obj !== null && typeof obj === "object" ? obj : null })
    } catch {
      entries.push({ label, obj: null }) // truncated or non-JSON line — skip
    }
  }

  // A command echo is local plumbing when Claude Code's own bookkeeping sits at
  // the exact places it writes it: a <local-command-caveat> on the line right
  // BEFORE the echo (i−1), or a <local-command-stdout> right AFTER it (i+1 or
  // i+2 — a line can sit between the echo and its output).
  // Anything wider hides real commands: the previous built-in's stdout would
  // otherwise count as this echo's neighbour and a custom command following it
  // would vanish. And a line on the other side of the head/tail cut is never a
  // neighbour — "~" labels mark the tail window, so the boundary is checked
  // before anything is compared.
  const inSameWindow = (i: number, j: number): boolean =>
    j >= 0 && j < entries.length && entries[j]!.label.startsWith("~") === entries[i]!.label.startsWith("~")
  const userTextAt = (j: number): string => {
    const other = entries[j]?.obj
    if (other?.type !== "user") return ""
    return userRequestText(other.message?.content)
  }
  const neighbourLocalCommand = (i: number): boolean => {
    if (inSameWindow(i, i - 1) && userTextAt(i - 1).includes("<local-command-caveat>")) return true
    for (const j of [i + 1, i + 2]) {
      if (inSameWindow(i, j) && userTextAt(j).includes("<local-command-stdout>")) return true
    }
    return false
  }

  // messagesTotal counts every user/assistant line read (even ones that
  // render empty); msgs holds only those that produced a rendered block.
  const msgs: { role: string; block: string }[] = []
  const cwds: string[] = []
  let messagesTotal = 0
  let firstUserMessage: string | null = null
  // set when a user line is skipped before the pick — the transcript opened on
  // scaffolding, so its first real user line is a continuation, not the ask
  let openedWithScaffolding = false
  // the index in `msgs` of the block firstUserMessage came from — fitMessages
  // pins exactly it, not whichever user block happens to render first
  let pinIdx: number | undefined
  // the isCompactSummary line's text, pinned beside the request as its own
  // labelled block rather than left to the newest-first fill
  let compactSummary: { label: string; text: string } | null = null
  for (let i = 0; i < entries.length; i++) {
    const { label, obj } = entries[i]!
    if (obj === null) continue
    const folder = obj.cwd
    if (typeof folder === "string" && folder !== "" && !cwds.includes(folder)) cwds.push(folder)
    if (obj.type !== "user" && obj.type !== "assistant") continue
    messagesTotal++
    const isUser = obj.type === "user"
    const userText = isUser ? userRequestText(obj.message?.content) : ""
    let picked = false
    let requestText: string | null = null
    if (firstUserMessage === null && isUser) {
      // A slash-command echo is scaffolding-shaped, but a custom command's
      // <command-args> ARE the ask — try that extraction before the
      // scaffolding test drops the line. isMeta/isCompactSummary lines never
      // yield a request either way.
      const meta = obj.isMeta === true || obj.isCompactSummary === true
      requestText =
        userText !== "" && !meta
          ? (slashCommandRequest(userText, neighbourLocalCommand(i)) ?? (userVisibleText(obj.message?.content) || null))
          : null
      if (requestText !== null) {
        firstUserMessage = hardCut(scrubSecrets(requestText), FIRST_USER_CHARS)
        picked = true
      } else {
        openedWithScaffolding = true
      }
    }
    // The /compact summary is real context, not conversation: it renders as
    // its own labelled block pinned beside the request, never competing with
    // the newest turns for the budget. The LAST one wins — a session compacted
    // twice keeps only its newest condensed history.
    if (isUser && obj.isCompactSummary === true) {
      compactSummary = { label, text: userText }
    }
    // The pinned block renders the REQUEST text — a picked command echo shows
    // "/name args", never its raw tags. isMeta bookkeeping lines and the
    // summary line render nothing in the fill; other scaffolding drops
    // itself — a user line whose text parts all strip to nothing produces no
    // block, while a reminder next to a tool_result leaves the result behind.
    const dropped = isUser && (obj.isMeta === true || obj.isCompactSummary === true)
    // A custom slash command that is NOT the pinned request is still a user
    // turn — rendered as "/name args" so the model sees the ask, never the raw
    // echo tags (L8). Built-ins return null from the same check and stay
    // hidden, and a picked echo already rendered once as the pinned request.
    const laterCommand =
      !picked && !dropped && userText !== ""
        ? slashCommandRequest(userText, neighbourLocalCommand(i))
        : null
    const block = picked
      ? `L${label} user:\n${scrubSecrets(requestText!)}`
      : dropped
        ? null
        : laterCommand !== null
          ? `L${label} user:\n${scrubSecrets(laterCommand)}`
          : renderMessage(label, obj)
    if (block) {
      msgs.push({ role: obj.type, block })
      if (picked) pinIdx = msgs.length - 1
    }
  }

  // The kept earlier request rendered as the head block — it is not a line in
  // this file, so its heading names it instead of an L<n> label. The same
  // keep-over-continuation rule compile.ts uses for the saved field decides
  // here: the kept request heads the render only when the file opened on
  // scaffolding or pinned no request at all.
  const keptHead =
    options.preferRequest !== undefined &&
    options.preferRequest !== null &&
    (openedWithScaffolding || firstUserMessage === null)
      ? `user — original request (kept from the earlier checkpoint):\n${hardCut(scrubSecrets(options.preferRequest), FIRST_USER_CHARS)}`
      : null

  if (messagesTotal === 0) {
    const tailText = (tailWindow ?? headWindow.subarray(Math.max(0, headWindow.length - TAIL_BYTES))).toString("utf8")
    return {
      format: "unknown-tail",
      text: keptHead === null ? scrubTranscript(tailText) : `${keptHead}\n\n${scrubTranscript(tailText)}`,
      firstUserMessage: null,
      openedWithScaffolding: false,
      cwds,
      messagesKept: 0,
      messagesTotal: 0,
      omitted: 0,
    }
  }

  // The head/tail windows see only part of a truncated file — a /compact that
  // ran more than TAIL_BYTES before the end leaves its summary in the unread
  // middle. One streamed pass finds the LAST isCompactSummary line wherever it
  // sits (a line over SUMMARY_LINE_BYTES is skipped, not read whole). It is the
  // file's true last summary, so it replaces whatever the windows pinned — and
  // its label is the real line number even when the windows never saw the line.
  // A file that fit the windows was already read end to end, so the windows'
  // pick IS the last summary — no second pass.
  const scannedSummary = truncated ? lastCompactSummaryLine(transcriptPath) : null
  if (scannedSummary !== null) {
    try {
      const obj = JSON.parse(scannedSummary.text) as TranscriptLine | null
      if (obj !== null && typeof obj === "object" && obj.type === "user" && obj.isCompactSummary === true) {
        compactSummary = { label: scannedSummary.label, text: userRequestText(obj.message?.content) }
      }
    } catch {
      // the scan already parsed this line once; a second failure just leaves
      // whatever the windows found
    }
  }

  const summaryBlock =
    compactSummary === null
      ? null
      : `L${compactSummary.label} user — Summary of the earlier session (from /compact):\n${cutSummary(scrubSecrets(compactSummary.text))}`
  const fitted = fitMessages(msgs, maxChars, truncated, keptHead === null ? pinIdx : undefined, summaryBlock, keptHead)
  return {
    format: "claude-jsonl",
    text: fitted.text,
    firstUserMessage,
    openedWithScaffolding,
    cwds,
    messagesKept: fitted.messagesKept,
    messagesTotal,
    omitted: fitted.omitted,
  }
}
