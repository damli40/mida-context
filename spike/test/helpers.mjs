import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function tmpdir(prefix = "mida-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function validCp(overrides = {}) {
  return {
    eventId: "evt-00000001",
    agent: "claude-code",
    source: "agent-tool",
    objective: "Implement the TokenBucket rate limiter",
    progress: ["step 1 done"],
    decisions: [{ decision: "lazy refill", rationale: "no timers allowed" }],
    rejected: [{ approach: "setInterval refill", why: "violates no-timers constraint" }],
    constraints: ["no dependencies"],
    artifacts: ["src/bucket.mjs"],
    unresolvedIssue: null,
    nextAction: "implement step 2 (injectable clock)",
    evidence: [{ field: "decisions[0]", ref: "transcript:L10-L12" }],
    ...overrides,
  };
}

// Spawn a hook script with the given env + stdin payload; return spawnSync result.
export function runHook(script, { env = {}, input = {} } = {}) {
  return spawnSync("node", [path.join(ROOT, "hooks", script)], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

// Poll fn until it returns truthy or the timeout elapses. Used because the
// capture hook stores checkpoints via a detached worker — the checkpoint
// appears after the hook process has already exited.
export async function waitFor(fn, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

// True once the capture worker queue has drained: the inflight dir exists
// and holds no job files (the worker deletes its job file last).
export function capturesSettled(store) {
  const d = path.join(store, "inflight");
  try {
    return fs.existsSync(d) && fs.readdirSync(d).length === 0;
  } catch {
    return false;
  }
}
