// Turn a Codex rollout file (one JSON object per line, {timestamp, type,
// payload}) into the same compact Conversation the Claude reader produces.
// The conversation lives in `response_item` records; everything around it —
// session_meta, turn_context, world_state, event_msg, token_usage_record —
// is bookkeeping. Read from a real rollout captured in spike S2 on 2026-09-23
// (test/fixtures/codex-rollout-real.jsonl): Codex injects its own scaffolding
// ahead of the human's first request — developer-role instructions, a user
// message opening with <recommended_plugins> or <environment_context>, and
// Mida's handoff arriving as a developer message starting "MIDA HANDOFF" —
// and none of it may reach the extractor or become firstUserMessage.
//
// Rendering matches the Claude reader: each kept record becomes one block
// headed "L<n> <role>:" with the real line number ("~n" inside a tail
// window), tool calls render as "tool:" and their outputs as "tool-result:",
// and every part is scrubbed BEFORE it is cut at PART_CHARS — the other order
// leaves a secret straddling the boundary as an unredactable fragment.
// Reasoning records are dropped entirely — S2 saw them carry only
// encrypted_content.
// A file with no Codex conversation records answers the unknown-tail shape,
// same as the Claude reader's fallback.

import { scrubSecrets, scrubTranscript, scrubValue } from "./scrub.js"
import { readConversation } from "./transcript-claude.js"
import type { Conversation } from "./transcript-claude.js"
import {
  FIRST_USER_CHARS,
  PART_CHARS,
  TAIL_BYTES,
  cut,
  hardCut,
  fitMessages,
  readTranscriptLines,
} from "./transcript-lines.js"

// User-role messages Codex or Mida inject ahead of the real request — a kept
// user message whose joined text opens with one of these is scaffolding, not
// the human's words.
const INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<recommended_plugins>",
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
  "MIDA HANDOFF",
  "Mida:",
]

// Content part types that carry renderable text in a Codex message record.
const TEXT_PARTS = new Set(["input_text", "output_text"])

// One response_item payload, typed only as far as the reader looks.
interface CodexPayload {
  type?: unknown
  role?: unknown
  content?: unknown
  name?: unknown
  arguments?: unknown
  input?: unknown
  output?: unknown
  cwd?: unknown
}

// The text parts of one message record's content array (a bare string
// content is taken whole — Codex always writes arrays, but a hand-built
// line is still readable).
function messageParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== "object") continue
    const p = part as { type?: unknown; text?: unknown }
    if (typeof p.type === "string" && TEXT_PARTS.has(p.type) && typeof p.text === "string")
      out.push(p.text)
  }
  return out
}

// A tool call's detail field is usually a string; anything else is rendered
// through scrubValue so a secret under a sensitive key name is redacted on
// the object before it is stringified.
function callDetail(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(scrubValue(v ?? null)) ?? ""
  } catch {
    return ""
  }
}

// A tool output is either a string or an array of { type, text } parts — S2
// saw the array form on custom_tool_call_output.
function outputText(output: unknown): string {
  if (typeof output === "string") return output
  if (!Array.isArray(output)) return ""
  const out: string[] = []
  for (const part of output) {
    if (part === null || typeof part !== "object") continue
    const t = (part as { text?: unknown }).text
    if (typeof t === "string" && t) out.push(t)
  }
  return out.join("\n")
}

export function readCodexConversation(
  transcriptPath: string,
  options: { maxChars?: number } = {},
): Conversation {
  const { maxChars = 40_000 } = options
  const { lines, truncated, head: headWindow, tail: tailWindow } = readTranscriptLines(transcriptPath)

  const msgs: { role: string; block: string }[] = []
  const cwds: string[] = []
  let messagesTotal = 0
  let firstUserMessage: string | null = null
  for (const { label, text: line } of lines) {
    if (!line.trim()) continue
    let obj: { type?: unknown; payload?: unknown }
    try {
      obj = JSON.parse(line)
    } catch {
      continue // truncated or non-JSON line — skip
    }
    if (obj === null || typeof obj !== "object" || typeof obj.type !== "string") continue

    if (obj.type === "session_meta" || obj.type === "turn_context") {
      const folder = (obj.payload as CodexPayload | null)?.cwd
      if (typeof folder === "string" && folder !== "" && !cwds.includes(folder)) cwds.push(folder)
      continue
    }
    if (obj.type !== "response_item") continue
    const payload = obj.payload
    if (payload === null || typeof payload !== "object") continue
    const p = payload as CodexPayload

    if (p.type === "message") {
      const role = p.role
      if (role === "developer" || role === "system") continue
      if (role !== "user" && role !== "assistant") continue
      const parts = messageParts(p.content)
      const text = parts.join("\n")
      if (role === "user" && INJECTED_PREFIXES.some((pre) => text.trimStart().startsWith(pre))) continue
      messagesTotal++
      if (role === "user" && firstUserMessage === null && text)
        firstUserMessage = hardCut(scrubSecrets(text), FIRST_USER_CHARS)
      const body = parts
        // scrub before the cut: a secret straddling the boundary would otherwise
        // no longer match the scrubber and most of it would reach the model
        .map((t) => cut(scrubSecrets(t), PART_CHARS))
        .filter((t) => t.length)
        .join("\n")
      if (body) msgs.push({ role, block: `L${label} ${role}:\n${body}` })
      continue
    }

    if (p.type === "function_call" || p.type === "custom_tool_call") {
      messagesTotal++
      const detail = callDetail(p.type === "function_call" ? p.arguments : p.input)
      const name = typeof p.name === "string" ? p.name : "?"
      msgs.push({ role: "tool", block: `L${label} tool:\n${cut(scrubSecrets(`${name} ${detail}`.trimEnd()), PART_CHARS)}` })
      continue
    }

    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      messagesTotal++
      msgs.push({ role: "tool-result", block: `L${label} tool-result:\n${cut(scrubSecrets(outputText(p.output)), PART_CHARS)}` })
      continue
    }
    // reasoning (encrypted_content is never rendered), compacted and every
    // other payload type are bookkeeping — skipped.
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

  const fitted = fitMessages(msgs, maxChars, truncated)
  return {
    format: "codex-jsonl",
    text: fitted.text,
    firstUserMessage,
    cwds,
    messagesKept: fitted.messagesKept,
    messagesTotal,
    omitted: fitted.omitted,
  }
}

/**
 * The reader a job's transcript needs, chosen by the agent that wrote it.
 * An agent with no reader answers null — the caller refuses, never guesses.
 */
export function readTranscriptFor(agent: string, path: string): Conversation | null {
  if (agent === "codex") return readCodexConversation(path)
  if (agent === "claude-code") return readConversation(path)
  return null
}
