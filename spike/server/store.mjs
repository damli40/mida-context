// File-backed checkpoint store. Directory comes from MIDA_SPIKE_STORE.
// Layout: checkpoints.jsonl (one record per line), calls.jsonl (tool calls),
// errors.jsonl, hook-events.jsonl, last-capture.json.

import fs from "node:fs";
import path from "node:path";
import { validateCheckpoint } from "./schema.mjs";

export function storeDir() {
  const dir = process.env.MIDA_SPIKE_STORE;
  if (!dir) throw new Error("MIDA_SPIKE_STORE env var is not set (checkpoint store directory)");
  return dir;
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

export function checkpointsFile() {
  return path.join(storeDir(), "checkpoints.jsonl");
}

// Validates, stamps createdAt, appends one JSON line. Idempotent on eventId.
// NOTE (spike-grade concurrency): the duplicate check re-reads the file right
// before appending, and the append itself is an atomic-ish appendFileSync("a").
// Two racing writers could still both pass the check and both append; for a
// spike that is acceptable — the eventId is still recorded for dedup at read
// time by the reviewer.
export function appendCheckpoint(cp) {
  const record = { ...cp, createdAt: new Date().toISOString() };
  const v = validateCheckpoint(record);
  if (!v.ok) return { stored: false, errors: v.errors };

  const file = checkpointsFile();
  const exists = readJsonl(file).some((r) => r.eventId === record.eventId);
  if (exists) return { stored: false, duplicate: true };

  appendLine(file, v.value);
  return { stored: true, value: v.value };
}

// Newest checkpoint by createdAt (file order breaks ties), plus a history
// summary: total count and the last 10 records' identity fields.
// `originalRequest` is resolved across the store: when the newest record is
// a delta save that did not carry the request, the most recent record that
// has one supplies it — a delta save must not erase the user's own words.
export function latestHandoff() {
  const all = readJsonl(checkpointsFile());
  if (!all.length) return null;
  let newest = all[0];
  for (const r of all) if (r.createdAt >= newest.createdAt) newest = r;
  let originalRequest = newest.originalRequest || null;
  if (!originalRequest) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].originalRequest) {
        originalRequest = all[i].originalRequest;
        break;
      }
    }
  }
  return {
    checkpoint: newest,
    originalRequest,
    history: {
      count: all.length,
      recent: all
        .slice(-10)
        .map(({ eventId, agent, source, createdAt }) => ({ eventId, agent, source, createdAt })),
    },
  };
}

// One line per MCP tool call: { at, tool, agent, ok }. Never log argument
// text — the reviewer only needs to know whether Agent B called the tool.
export function logCall({ tool, agent, ok }) {
  appendLine(path.join(storeDir(), "calls.jsonl"), {
    at: new Date().toISOString(),
    tool,
    agent,
    ok: Boolean(ok),
  });
}

// One line in errors.jsonl. Fail-open by design: never throws.
export function logError(where, message) {
  try {
    appendLine(path.join(storeDir(), "errors.jsonl"), {
      at: new Date().toISOString(),
      where,
      message: String(message).slice(0, 500),
    });
  } catch {
    // nowhere to log — swallow
  }
}

// Readable rendering of a checkpoint, shared by the inject hook and the
// mida_handoff tool. The ORIGINAL REQUEST section leads the block — the
// user's own words, not a summary — and is NEVER trimmed. When the output
// would exceed maxChars, list items are dropped oldest-first from evidence,
// then progress, then decisions; a hard slice is the last resort (and still
// cannot reach the request, which sits at the top of the block).
export function renderHandoff(
  cp,
  { maxChars = 11_800, maxItems = 12, originalRequest } = {},
) {
  // Callers that resolved the request across the store (latestHandoff) pass
  // it explicitly; undefined falls back to the checkpoint's own field.
  const request =
    originalRequest === undefined ? (cp.originalRequest ?? null) : originalRequest;
  const cut = (s) => (s.length > 200 ? s.slice(0, 197) + "..." : s);
  const list = (title, items, fmt = (x) => x) => {
    if (!items?.length) return `${title}: (none)`;
    const lines = items.slice(0, maxItems).map((x) => `- ${cut(fmt(x))}`);
    if (items.length > maxItems) lines.push(`- ... (+${items.length - maxItems} more)`);
    return `${title}:\n${lines.join("\n")}`;
  };
  const build = (evidence, progress, decisions) => {
    const parts = [
      `MIDA HANDOFF (saved by ${cp.agent} at ${cp.createdAt}, source ${cp.source})`,
    ];
    if (request) {
      parts.push(
        "ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):\n" +
          request,
      );
    }
    parts.push(
      `Objective: ${cp.objective}`,
      list("Progress", progress),
      list("Decisions", decisions, (d) => `${d.decision} — because: ${d.rationale}`),
      list("Rejected approaches", cp.rejected, (r) => `${r.approach} — ${r.why}`),
      list("Constraints", cp.constraints),
      list("Artifacts", cp.artifacts),
      `Unresolved issue: ${cp.unresolvedIssue ?? "none"}`,
      list("Remaining plan", cp.remainingPlan),
      `Next action: ${cp.nextAction}`,
    );
    if (evidence?.length) parts.push(list("Evidence", evidence, (e) => `${e.field}: ${e.ref}`));
    return parts.join("\n\n");
  };

  let evidence = cp.evidence ?? [];
  let progress = cp.progress ?? [];
  let decisions = cp.decisions ?? [];
  let out = build(evidence, progress, decisions);
  while (out.length > maxChars && (evidence.length || progress.length || decisions.length)) {
    if (evidence.length) evidence = evidence.slice(1);
    else if (progress.length) progress = progress.slice(1);
    else decisions = decisions.slice(1);
    out = build(evidence, progress, decisions);
  }
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n... (truncated)";
  return out;
}
