// Shared helpers for hook scripts. Every function here is fail-open:
// hooks must exit 0 no matter what, so these never throw.

import fs from "node:fs";
import path from "node:path";

export const storeDir = () => process.env.MIDA_SPIKE_STORE || null;

// Append one JSON line to <store>/<name>. Silently no-ops on any failure.
export function appendJsonl(name, obj) {
  try {
    const dir = storeDir();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, name), JSON.stringify(obj) + "\n");
  } catch {
    // fail-open
  }
}

// Numeric env var with a default. Unlike `Number(env) || def`, an explicit
// "0" is honoured — tests rely on MIDA_SPIKE_DEBOUNCE_MS=0 meaning "off".
export function envMs(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function logError(where, err) {
  appendJsonl("errors.jsonl", {
    at: new Date().toISOString(),
    where,
    message: String(err?.message ?? err).slice(0, 500),
  });
}

// Record which hook event fired — the reviewer reads this file to learn
// which events each agent CLI actually emits.
export function logHookEvent(event, sessionId, extra = {}) {
  appendJsonl("hook-events.jsonl", {
    at: new Date().toISOString(),
    event: event ?? null,
    sessionId: sessionId ?? null,
    ...extra,
  });
}

// Read one JSON object from stdin (capped). Returns {} on any failure.
export async function readStdinJson(limit = 1_000_000) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > limit) break;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
