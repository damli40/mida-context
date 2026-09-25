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
// TAIL_BYTES (the newest messages live at the bottom), and the middle is
// never touched: messagesTotal and cwds then count only the lines that were
// read.

import { scrubSecrets, scrubTranscript, scrubValue } from "./scrub.js"
import {
  FIRST_USER_CHARS,
  PART_CHARS,
  TAIL_BYTES,
  cut,
  hardCut,
  fitMessages,
  readTranscriptLines,
} from "./transcript-lines.js"

const THINKING_CHARS = 1_000

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
// /compact caveat, slash-command echoes, hook and reminder blocks. A line that
// opens with one of these tags is the tool's scaffolding, never the request.
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
]

// A line whose text opens with an injected tag is the tool's scaffolding —
// never the request, and dropped from the rendered conversation entirely:
// what the model gets is the human's conversation, not Claude Code's plumbing.
// (The isCompactSummary line is NOT in this set — the condensed history is
// real session context and still renders; it just may not be the request.)
function isScaffoldText(text: string): boolean {
  const t = text.trimStart()
  return CLAUDE_SCAFFOLD_PREFIXES.some((pre) => t.startsWith(pre))
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
// command takes no arguments. The real echo puts <command-message> FIRST, so
// the name tag is searched anywhere in the line, not only at the start.
// Returns null for a built-in, whether the name list catches it or the plumbing
// does: Claude Code answers built-ins with a <local-command-caveat> or
// <local-command-stdout>/<stderr> block on a NEIGHBOURING user line, so the
// caller also passes whether such a line sits within two lines of this one.
function slashCommandRequest(text: string, neighbourLocalCommand: boolean): string | null {
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
  options: { maxChars?: number } = {},
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

  // True when a user line within two lines of index i carries the
  // caveat/stdout block Claude Code emits around a built-in command.
  const neighbourLocalCommand = (i: number): boolean => {
    for (let j = Math.max(0, i - 2); j <= Math.min(entries.length - 1, i + 2); j++) {
      if (j === i) continue
      const other = entries[j]!.obj
      if (other?.type !== "user") continue
      const t = userRequestText(other.message?.content)
      if (t.includes("<local-command-caveat>") || t.includes("<local-command-stdout>")) return true
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
    if (firstUserMessage === null && isUser) {
      // A slash-command echo is scaffolding-shaped, but a custom command's
      // <command-args> ARE the ask — try that extraction before the
      // scaffolding test drops the line. isMeta/isCompactSummary lines never
      // yield a request either way.
      const meta = obj.isMeta === true || obj.isCompactSummary === true
      const request =
        userText !== "" && !meta
          ? (slashCommandRequest(userText, neighbourLocalCommand(i)) ?? (isScaffoldText(userText) ? null : userText))
          : null
      if (request !== null) {
        firstUserMessage = hardCut(scrubSecrets(request), FIRST_USER_CHARS)
        picked = true
      } else {
        openedWithScaffolding = true
      }
    }
    // Scaffolding is dropped from the rendered conversation too, not only
    // from the request pick: isMeta bookkeeping lines and any user line whose
    // text opens with an injected tag render nothing at all.
    const dropped = isUser && (obj.isMeta === true || (userText !== "" && isScaffoldText(userText)))
    const block = dropped ? null : renderMessage(label, obj)
    if (block) {
      msgs.push({ role: obj.type, block })
      if (picked) pinIdx = msgs.length - 1
    }
  }

  if (messagesTotal === 0) {
    const tailText = (tailWindow ?? headWindow.subarray(Math.max(0, headWindow.length - TAIL_BYTES))).toString("utf8")
    return {
      format: "unknown-tail",
      text: scrubTranscript(tailText),
      firstUserMessage: null,
      openedWithScaffolding: false,
      cwds,
      messagesKept: 0,
      messagesTotal: 0,
      omitted: 0,
    }
  }

  const fitted = fitMessages(msgs, maxChars, truncated, pinIdx)
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
