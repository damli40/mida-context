// transcript-claude.mjs — turn a Claude Code session transcript (one JSON
// object per line) into the compact text the extractor actually needs.
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
// evidence as transcript:L<n>. Secrets are scrubbed on the DECODED text of
// every rendered part (this replaces the raw-line scrubTranscript call for
// this format).
//
// The result also carries firstUserMessage: the first `user` line whose
// content is a plain string or has a `text` part (a bare `tool_result` does
// not count — resumed sessions open with tool output, not the request). It
// is scrubbed and hard-capped at 6,000 chars *including* the ellipsis, so it
// always fits the schema's originalRequest cap. unknown-tail → null.

import fs from "node:fs";
import { scrubSecrets, scrubTranscript } from "./scrub.mjs";

const TAIL_BYTES = 60_000; // fallback tail size for unknown formats
const THINKING_CHARS = 1_000;
const PART_CHARS = 600;
const FIRST_USER_CHARS = 6_000;
// Room kept aside for the "[… N earlier messages omitted …]" marker so the
// final text stays under maxChars even when the marker is needed.
const MARKER_RESERVE = 96;

const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
// Unlike cut(), the ellipsis is counted INSIDE the limit: the result is at
// most n chars, so it can never trip the schema's 6,000-char cap.
const hardCut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// The request text of one user line: the string content, or the joined
// `text` parts of array content. Returns "" for a bare tool_result (or
// anything without real text) so the caller keeps looking at later lines.
function userRequestText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// tool_result content is either a string or an array of {type:"text"} parts.
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// Render one user/assistant line as "L<lineNo> <role>:\n<parts>".
// Returns null when the message renders to nothing (empty content).
function renderMessage(lineNo, obj) {
  const content = obj.message?.content;
  const parts = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
      else if (p.type === "thinking" && typeof p.thinking === "string")
        parts.push(`[thinking] ${cut(p.thinking, THINKING_CHARS)}`);
      else if (p.type === "tool_use") {
        let input = "";
        try {
          input = JSON.stringify(p.input ?? null) ?? "";
        } catch {
          input = "";
        }
        parts.push(`[tool ${p.name ?? "?"}] ${cut(input, PART_CHARS)}`);
      } else if (p.type === "tool_result") {
        parts.push(`[result] ${cut(toolResultText(p.content), PART_CHARS)}`);
      }
    }
  }
  const body = parts
    .map((p) => scrubSecrets(p))
    .filter((p) => p.length)
    .join("\n");
  if (!body) return null;
  return `L${lineNo} ${obj.type}:\n${body}`;
}

export function readConversation(file, { maxChars = 40_000 } = {}) {
  const buf = fs.readFileSync(file);
  const raw = buf.toString("utf8");

  // messagesTotal counts every user/assistant line (even ones that render
  // empty); msgs holds only those that produced a rendered block.
  const msgs = [];
  let messagesTotal = 0;
  let firstUserMessage = null;
  raw.split("\n").forEach((line, idx) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // truncated or non-JSON line — skip
    }
    if (obj?.type !== "user" && obj?.type !== "assistant") return;
    messagesTotal++;
    if (firstUserMessage === null && obj.type === "user") {
      const t = userRequestText(obj.message?.content);
      if (t) firstUserMessage = hardCut(scrubSecrets(t), FIRST_USER_CHARS);
    }
    const block = renderMessage(idx + 1, obj);
    if (block) msgs.push({ role: obj.type, block });
  });

  if (messagesTotal === 0) {
    const tail = buf.subarray(Math.max(0, buf.length - TAIL_BYTES)).toString("utf8");
    return {
      format: "unknown-tail",
      text: scrubTranscript(tail),
      firstUserMessage: null,
      messagesKept: 0,
      messagesTotal: 0,
      omitted: 0,
    };
  }

  // The first user message carries the objective and constraints — pin it
  // (cut at 6,000 chars). Everything else competes for the remaining budget,
  // filled from the most recent backwards.
  const pinIdx = msgs.findIndex((m) => m.role === "user");
  const head = pinIdx >= 0 ? cut(msgs[pinIdx].block, FIRST_USER_CHARS) : null;
  const rest = msgs.filter((_, i) => i !== pinIdx);

  const budget = Math.max(0, maxChars - (head ? head.length + 2 : 0) - MARKER_RESERVE);
  const keptTail = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = rest[i].block.length + (keptTail.length ? 2 : 0);
    if (used + cost > budget) break;
    keptTail.unshift(rest[i]);
    used += cost;
  }
  const omitted = rest.length - keptTail.length;

  const blocks = [];
  if (head) blocks.push(head);
  if (omitted) blocks.push(`[… ${omitted} earlier messages omitted …]`);
  for (const m of keptTail) blocks.push(m.block);

  return {
    format: "claude-jsonl",
    text: blocks.join("\n\n"),
    firstUserMessage,
    messagesKept: (head ? 1 : 0) + keptTail.length,
    messagesTotal,
    omitted,
  };
}
