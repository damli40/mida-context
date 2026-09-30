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
  ANSWER_MARK,
  FIRST_USER_CHARS,
  PART_CHARS,
  TAIL_BYTES,
  TAIL_ORDER,
  cut,
  fitMessages,
  hardCut,
  readTranscriptLines,
  scanTranscript,
  twoEndedCut,
  type ScanHooks,
  type TypedMark,
} from "./transcript-lines.js"

const THINKING_CHARS = 1_000

// A /compact summary carries its newest state — pending tasks, current work,
// the next step — at the END, so a one-sided cut kept the stale opening and
// dropped exactly what the next session needs. Keep both ends: the first
// 2,000 and the last 4,000 chars joined by a marked gap (~6,050 total, the
// same ~6 KB the request cap budgets for).
const SUMMARY_HEAD_CHARS = 2_000
const SUMMARY_TAIL_CHARS = 4_000
/** Two-ended summary cut shared by the devin reader's compaction pin — keep both ends. */
export const cutSummary = (s: string): string =>
  s.length <= SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS
    ? s
    : `${s.slice(0, SUMMARY_HEAD_CHARS)}\n[… middle of the summary cut …]\n${s.slice(-SUMMARY_TAIL_CHARS)}`

export interface Conversation {
  format: "claude-jsonl" | "codex-jsonl" | "devin-sqlite" | "unknown-tail"
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
  /** Claude Code's structured copy of a tool's result — the question tool's answers live here. */
  toolUseResult?: unknown
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
  /** tool_use carries `id`; its tool_result carries `tool_use_id` — the pair a rejection-to-call match needs (in-20 T-2). */
  id?: unknown
  tool_use_id?: unknown
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

// in-20 T-2 — quitting Claude Code while a tool call waits on the permission
// prompt leaves bookkeeping under the USER role: a plain-text marker line and
// the rejected call's tool_result. They are never the user's typed words.
const CLAUDE_INTERRUPTIONS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
])
const isInterruptionMarker = (text: string): boolean => CLAUDE_INTERRUPTIONS.has(text.trim())

// The boilerplate a permission-prompt rejection's tool_result opens with.
const TOOL_REJECTION_PREFIX = "The user doesn't want to proceed with this tool use."

// The interruption block names at most this many rejected calls — the rest fold into
// "and N more", exact count preserved, so a mass rejection stays inside the budget (in-23 R-2).
const REJECTED_NAMED_MAX = 10

/**
 * A user-role line that is pure interrupt bookkeeping (in-20 T-2): the
 * "[Request interrupted…]" marker, or a tool_result that carries the rejection
 * boilerplate and nothing else. Any real content beside the artifact — typed
 * words, an ordinary result — means the line is conversation, not bookkeeping.
 * Returns the rejected call's tool_use_id when the artifact carries one, and
 * `rejected` when a rejection tool_result was among its parts — the two endings
 * the collapse below renders differently.
 */
function interruptionArtifact(obj: TranscriptLine): { toolUseId?: string; rejected?: boolean } | null {
  if (obj.type !== "user" || obj.isMeta === true || obj.isCompactSummary === true) return null
  const content = obj.message?.content
  if (typeof content === "string") return isInterruptionMarker(content) ? {} : null
  if (!Array.isArray(content)) return null
  let sawArtifact = false
  let toolUseId: string | undefined
  let rejected = false
  for (const p of content) {
    if (!isPart(p)) return null
    if (p.type === "text" && typeof p.text === "string") {
      if (!isInterruptionMarker(p.text)) return null
      sawArtifact = true
    } else if (p.type === "tool_result") {
      if (!toolResultText(p.content).trimStart().startsWith(TOOL_REJECTION_PREFIX)) return null
      sawArtifact = true
      rejected = true
      if (typeof p.tool_use_id === "string") toolUseId = p.tool_use_id
    } else {
      return null
    }
  }
  return sawArtifact ? { ...(toolUseId === undefined ? {} : { toolUseId }), ...(rejected ? { rejected } : {}) } : null
}
const BUILTIN_COMMANDS = new Set([
  "compact", "clear", "model", "init", "help", "cost", "resume", "config",
  "login", "logout", "memory", "mcp", "permissions", "doctor", "status",
  "agents", "hooks", "context", "export", "exit", "rewind", "statusline",
  "add-dir", "bug", "vim", "terminal-setup", "ide", "upgrade",
  "release-notes", "privacy-settings", "output-style", "todos", "usage",
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

// A command echo's local-plumbing neighbours, named as a rule rather than a
// position: caveat on the line before, stdout on either of the two after. The
// window read answers this from its entries (with the head/tail boundary as a
// wall); the streamed scan answers it from the same raw userText strings.
export function claudeCommandEchoNeighbour(prev: string, next: string[]): boolean {
  if (prev.includes("<local-command-caveat>")) return true
  return next.some((text) => text.includes("<local-command-stdout>"))
}

/**
 * ONE classifier for "did the user type this line", shared by the window read
 * and the streamed scan so they can never disagree: a type:user line that is
 * not isMeta/isCompactSummary, not a bare tool_result, and not all scaffolding
 * — a custom slash command returns its "/name args" form, a built-in's echo
 * stays hidden. Returns the user's words (unscrubbed), or null.
 */
export function claudeTypedUserText(obj: TranscriptLine | null, neighbourLocalCommand: boolean): string | null {
  if (obj === null || obj.type !== "user") return null
  if (obj.isMeta === true || obj.isCompactSummary === true) return null
  const userText = userRequestText(obj.message?.content)
  // an interrupt marker is bookkeeping, never typed words (in-20 T-2)
  if (userText === "" || isInterruptionMarker(userText)) return null
  return slashCommandRequest(userText, neighbourLocalCommand) ?? (userVisibleText(obj.message?.content) || null)
}

/** How much of a question the answer line repeats — enough to say what was asked. */
const ANSWER_QUESTION_CHARS = 120

/**
 * PROV-10: the user's answer to the agent's question tool (Claude Code's AskUserQuestion). The
 * choice comes back as a tool RESULT, not a typed message, and the result text puts the question
 * first — so a long question pushed the answer past the 600-char result cut, and nothing pinned
 * it. The line's structured `toolUseResult` carries `questions` and an `answers` map (question →
 * answer); that record is the signal, never the result text, whose wording varies by version.
 * Returns one "[answered the agent's question] <question> = <answer>" entry per string answer,
 * with any note the user typed beside it — the user's words, unscrubbed like the typed
 * classifier's — or null. Deliberately NOT part of claudeTypedUserText: the interruption
 * boundary logic keys on typed words only.
 */
export function claudeAnswerText(obj: TranscriptLine | null): string | null {
  if (obj === null || obj.type !== "user") return null
  if (obj.isMeta === true || obj.isCompactSummary === true) return null
  const record = obj.toolUseResult
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null
  const { answers, questions, annotations } = record as { answers?: unknown; questions?: unknown; annotations?: unknown }
  if (typeof answers !== "object" || answers === null || Array.isArray(answers) || !Array.isArray(questions)) return null
  const notesFor = (question: string): string | null => {
    if (typeof annotations !== "object" || annotations === null) return null
    const entry = (annotations as Record<string, unknown>)[question]
    const notes = typeof entry === "object" && entry !== null ? (entry as { notes?: unknown }).notes : undefined
    return typeof notes === "string" && notes.trim() !== "" ? notes : null
  }
  // PROV-10 review: the question and the option labels are the AGENT's words — a newline in them
  // could start a forged "L999: …" line inside the pinned group. Every part is flattened to one line.
  const flat = (text: string) => text.replace(/\s+/g, " ").trim()
  const entries: string[] = []
  for (const [rawQuestion, answer] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof answer !== "string" || answer.trim() === "") continue
    const question = [...flat(rawQuestion)]
    const asked = question.length <= ANSWER_QUESTION_CHARS ? question.join("") : `${question.slice(0, ANSWER_QUESTION_CHARS - 1).join("")}…`
    const notes = notesFor(rawQuestion)
    entries.push(`${ANSWER_MARK} ${asked} = ${flat(answer)}${notes === null ? "" : ` (note: ${flat(notes)})`}`)
  }
  return entries.length === 0 ? null : entries.join("; ")
}

/**
 * The Claude reader's half of the streamed pass: the cheap `"type":"user"`
 * string check keeps tool/output lines from ever reaching JSON.parse, the
 * summary test is the same one lastCompactSummaryLine always ran, and the
 * typed test is the shared classifier above with the 1-back/2-ahead neighbour
 * window the command-echo rule needs.
 */
export const claudeScanHooks: ScanHooks = {
  candidate: (text) => text.includes('"type":"user"'),
  userText: (text) => {
    try {
      const obj = JSON.parse(text) as TranscriptLine | null
      if (obj === null || typeof obj !== "object" || obj.type !== "user") return ""
      return userRequestText(obj.message?.content)
    } catch {
      return ""
    }
  },
  typedText: (text, neighbours) => {
    try {
      const obj = JSON.parse(text) as TranscriptLine | null
      const line = obj === null || typeof obj !== "object" ? null : obj
      // an answer to the agent's question is pinned like a typed message (PROV-10)
      return claudeTypedUserText(line, claudeCommandEchoNeighbour(neighbours.prev, neighbours.next)) ?? claudeAnswerText(line)
    } catch {
      return null
    }
  },
  summary: (text) => {
    if (!text.includes('"isCompactSummary"')) return false
    try {
      const obj = JSON.parse(text) as TranscriptLine | null
      return obj !== null && typeof obj === "object" && obj.isCompactSummary === true
    } catch {
      return false
    }
  },
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
    // a typed user part keeps both its ends (scrub before the cut, like every
    // other reader path); assistant text is not the user's words, no two-end cut
    if (t !== "") parts.push(isUser ? twoEndedCut(scrubSecrets(t)) : t)
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
  // `size` is the fstat snapshot of that read — passed to the streamed scan so
  // both passes describe the same bytes even if the file is still growing.
  const { lines, truncated, head: headWindow, tail: tailWindow, size } = readTranscriptLines(transcriptPath)

  // Every line parsed up front, so a command echo can be judged against its
  // NEIGHBOURING user lines: Claude Code writes a built-in's caveat/stdout on
  // their own lines next to the echo, never inside it. `offset` is the line's
  // byte offset in the file — the identity the scan's typed lines pair on.
  const entries: { label: string; obj: TranscriptLine | null; offset: number }[] = []
  for (const { label, text: line, offset } of lines) {
    if (!line.trim()) {
      entries.push({ label, obj: null, offset })
      continue
    }
    try {
      const obj = JSON.parse(line) as TranscriptLine | null
      entries.push({ label, obj: obj !== null && typeof obj === "object" ? obj : null, offset })
    } catch {
      entries.push({ label, obj: null, offset }) // truncated or non-JSON line — skip
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
  const neighbourLocalCommand = (i: number): boolean =>
    claudeCommandEchoNeighbour(
      inSameWindow(i, i - 1) ? userTextAt(i - 1) : "",
      [i + 1, i + 2].map((j) => (inSameWindow(i, j) ? userTextAt(j) : "")),
    )

  // messagesTotal counts every user/assistant line read (even ones that
  // render empty); msgs holds only those that produced a rendered block. A
  // typed mark rides on each user block whose line the shared classifier calls
  // the user's own words — fitMessages moves the ones the fill would lose into
  // the pinned group, labels and all.
  const msgs: { role: string; block: string; typed?: TypedMark; offset?: number }[] = []
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
    const { label, obj, offset } = entries[i]!
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
        userText !== "" && !meta && !isInterruptionMarker(userText)
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
    // PROV-10: the user's answer to the agent's question renders as the user's words, whole —
    // never as a [result] cut at 600 chars behind the question — and is pinned like a typed message
    const answer = isUser && !picked && !dropped && laterCommand === null ? claudeAnswerText(obj) : null
    // cut at both ends like a typed message (PROV-10 review: one real answer ran 11,240 chars);
    // a line that carries other parts beside the answer keeps them, rendered as before
    const answerText = answer === null ? null : twoEndedCut(scrubSecrets(answer))
    const content = obj.message?.content
    const answerOnly = Array.isArray(content) && content.length === 1
    const block = picked
      ? `L${label} user:\n${scrubSecrets(requestText!)}`
      : dropped
        ? null
        : laterCommand !== null
          ? `L${label} user:\n${scrubSecrets(laterCommand)}`
          : answerText !== null
            ? answerOnly
              ? `L${label} user:\n${answerText}`
              : `${renderMessage(label, obj) ?? `L${label} user:`}\n${answerText}`
            : renderMessage(label, obj)
    if (block) {
      const typed = isUser ? (claudeTypedUserText(obj, neighbourLocalCommand(i)) ?? answer) : null
      if (typed === null) {
        msgs.push({ role: obj.type, block, offset })
      } else {
        // "~" labels carry no absolute number — the mark's order is filled in
        // later by pairing with the streamed scan, matched on the byte offset
        msgs.push({
          role: obj.type,
          block,
          offset,
          typed: {
            label: `L${label}`,
            order: label.startsWith("~") ? TAIL_ORDER : Number(label),
            text: typed,
            offset,
          },
        })
      }
      if (picked) pinIdx = msgs.length - 1
    }
  }

  // in-20 T-2 — a transcript whose last user-side events are interrupt
  // bookkeeping ended on an interruption: the rejection tool_result and/or
  // "[Request interrupted…]" marker are bookkeeping, not words. Rendered
  // verbatim they read to the next agent as "stop and wait" instructions —
  // take 1's handoff did exactly that. The run collapses into ONE neutral
  // closing block. Non-message lines and Claude's own bookkeeping interleave
  // freely; a real user line after the artifacts is conversation, so the run
  // breaks there and both sides render as today.
  //
  // in-21 U-1 — the block claims only what the run proves. A run that holds a
  // rejection tool_result ended on an unapproved call (shape a: name it, call
  // it undecided — "no, and quit" writes the same bytes as a closed window,
  // so never a refusal and never "did not run"). A run of bare markers ended
  // mid-reply (shape b: no tool call is claimed at all). And a markers-only
  // run that follows the user's OWN typed words does not collapse — the typed
  // reply is the ending, and the stray marker renders verbatim like any
  // mid-session one.
  // in-22 V-1: the run must hold at least one real interruption ARTIFACT for anything to
  // collapse. The trailing newline every JSONL ends with, a summary line and a pending
  // tool_use all parse as skipped/non-message entries — none of them is an interruption, and
  // on the old `endIdx < entries.length` gate every ordinary ending collapsed.
  //
  // in-22 V-4: the run stops at the nearest real conversation line — the boundary. A boundary
  // of the user's own TYPED words keeps the ending conversational (in-21 N-2); a result line
  // or a pending tool_use followed by markers still ends on the interruption (N-A). One user
  // line can carry a real result AND a rejection together (N-B): it is the boundary, its
  // rejection parts are bookkeeping all the same — they are lifted out of the render and the
  // calls they rejected are named, while the rest of the line renders as it always did.
  let endIdx = entries.length
  let sawArtifact = false
  let boundaryIdx = -1
  let boundaryTyped = false
  while (endIdx > 0) {
    const obj = entries[endIdx - 1]!.obj
    if (obj === null || (obj.type !== "user" && obj.type !== "assistant")) {
      endIdx -= 1
      continue
    }
    if (obj.isMeta === true || obj.isCompactSummary === true) {
      endIdx -= 1
      continue
    }
    if (interruptionArtifact(obj) !== null) {
      sawArtifact = true
      endIdx -= 1
      continue
    }
    boundaryIdx = endIdx - 1
    boundaryTyped =
      obj.type === "user" && claudeTypedUserText(obj, neighbourLocalCommand(boundaryIdx)) !== null
    break
  }
  // The rejection parts of one line, as their tool_use_ids — a part with no id is still one
  // rejected call, it just cannot be named.
  const rejectionIds = (obj: TranscriptLine | null): (string | undefined)[] => {
    const content = obj?.message?.content
    if (!Array.isArray(content)) return []
    const ids: (string | undefined)[] = []
    for (const p of content) {
      if (!isPart(p) || p.type !== "tool_result") continue
      if (!toolResultText(p.content).trimStart().startsWith(TOOL_REJECTION_PREFIX)) continue
      ids.push(typeof p.tool_use_id === "string" ? p.tool_use_id : undefined)
    }
    return ids
  }
  // A typed boundary's own boilerplate stays conversational with its words; an untyped
  // boundary's rejections count toward the collapse even with no artifact run behind them.
  const boundaryRejects =
    !boundaryTyped && boundaryIdx >= 0 ? rejectionIds(entries[boundaryIdx]!.obj) : []
  // Every rejected call in file order — the boundary's first, then the run's — deduped by id.
  const rejectedCalls: (string | undefined)[] = []
  const collectRejected = (obj: TranscriptLine | null): void => {
    for (const id of rejectionIds(obj)) {
      if (id === undefined || !rejectedCalls.includes(id)) rejectedCalls.push(id)
    }
  }
  if (!boundaryTyped && boundaryIdx >= 0) collectRejected(entries[boundaryIdx]!.obj)
  for (let i = endIdx; i < entries.length; i++) collectRejected(entries[i]!.obj)
  // The collapse needs a reason: at least one rejected call, or a real artifact run that does
  // not end on the user's own typed words.
  if (rejectedCalls.length > 0 || (sawArtifact && !boundaryTyped)) {
    const gone = new Set(entries.slice(endIdx).map((e) => e.offset))
    for (let i = msgs.length - 1; i >= 0; i--) {
      const off = msgs[i]!.offset
      if (off !== undefined && gone.has(off)) msgs.splice(i, 1)
    }
    // A mixed boundary line keeps its real parts — re-render it without the rejection
    // boilerplate, so "STOP what you are doing and wait …" never lands in the handoff raw.
    if (boundaryRejects.length > 0 && boundaryIdx >= 0) {
      const boundary = entries[boundaryIdx]!
      const idx = msgs.findIndex((m) => m.offset === boundary.offset)
      if (idx !== -1 && boundary.obj !== null) {
        const content = boundary.obj.message?.content
        const kept = Array.isArray(content)
          ? content.filter(
              (p) =>
                !(
                  isPart(p) &&
                  p.type === "tool_result" &&
                  toolResultText(p.content).trimStart().startsWith(TOOL_REJECTION_PREFIX)
                ),
            )
          : content
        const block =
          boundary.obj.message === undefined
            ? renderMessage(boundary.label, boundary.obj)
            : renderMessage(boundary.label, { ...boundary.obj, message: { ...boundary.obj.message, content: kept } })
        if (block === null) msgs.splice(idx, 1)
        else msgs[idx]!.block = block
      }
    }
    if (pinIdx !== undefined && pinIdx >= msgs.length) pinIdx = undefined
    // Name every call left unapproved (G-4): each rejection's own tool_use when it is in view —
    // searched back over the contiguous assistant run above the boundary — else the last
    // tool_use of the nearest assistant line. A command or file path is cut to 120 chars.
    const describeCall = (call: ContentPart): string => {
      const input = isPart(call.input) ? (call.input as Record<string, unknown>) : null
      const target =
        typeof input?.file_path === "string" ? input.file_path
        : typeof input?.command === "string" ? input.command
        : ""
      const name = typeof call.name === "string" ? call.name : "?"
      return target === "" ? `(${name})` : `(${name} ${cut(scrubSecrets(target), 120)})`
    }
    // the assistant run that made the calls sits at or just above the boundary
    const searchFrom = boundaryIdx >= 0 && entries[boundaryIdx]!.obj?.type === "assistant" ? boundaryIdx : boundaryIdx - 1
    const findCall = (id: string | undefined): ContentPart | undefined => {
      for (let j = searchFrom; j >= 0; j--) {
        const obj = entries[j]!.obj
        if (obj === null || (obj.type !== "user" && obj.type !== "assistant")) continue
        if (obj.isMeta === true || obj.isCompactSummary === true) continue
        if (obj.type !== "assistant") break
        const content = obj.message?.content
        if (!Array.isArray(content)) break
        const uses = content.filter((p): p is ContentPart => isPart(p) && p.type === "tool_use")
        const call = id === undefined ? uses.at(-1) : uses.find((p) => p.id === id)
        if (call === undefined) {
          if (id !== undefined) continue // the call may sit further back
          break
        }
        return call
      }
      return undefined
    }
    let block: string
    if (rejectedCalls.length === 0) {
      block = "[interrupted here: the user interrupted the assistant's last reply.]"
    } else if (rejectedCalls.length === 1) {
      const call = findCall(rejectedCalls[0])
      const waiting = call === undefined ? null : describeCall(call)
      block =
        `[interrupted here: the last tool call${waiting === null ? "" : ` ${waiting}`} ` +
        `was not approved before the session stopped. It is undecided — neither a refusal nor an approval. Ask the user before running it.]`
    } else {
      const names = rejectedCalls.slice(0, REJECTED_NAMED_MAX).map((id) => {
        const call = findCall(id)
        return call === undefined ? "(a call the transcript does not name)" : describeCall(call)
      })
      const rest = rejectedCalls.length - names.length
      block =
        `[interrupted here: ${rejectedCalls.length} tool calls were not approved before the session stopped: ` +
        `${names.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}. They are undecided — neither refused nor approved. Ask the user before running any of them.]`
    }
    msgs.push({ role: "user", block })
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
  // pick IS the last summary — no second pass. The same ONE pass that finds
  // the summary also returns every typed line with its real line number and
  // the count of candidate lines too long to parse — the group's scan half.
  const scan = truncated ? scanTranscript(transcriptPath, claudeScanHooks, size) : null
  const scannedSummary = scan?.summary ?? null
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
  const fitted = fitMessages(
    msgs,
    maxChars,
    truncated,
    keptHead === null ? pinIdx : undefined,
    summaryBlock,
    keptHead,
    scan === null
      ? null
      : {
          marks: scan.typed.map((t) => ({ label: `L${t.line}`, order: t.line, offset: t.offset, text: t.text })),
          tooLong: scan.tooLong.length,
          bound: scan.bound,
        },
  )
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
