// capture-worker.mjs — the slow half of capture. capture.mjs writes a job
// file to $MIDA_SPIKE_STORE/inflight/ and spawns this script DETACHED so the
// hook returns immediately; this worker renders the transcript via
// transcript-claude.mjs (the conversation, not the bookkeeping), calls the
// extractor model, and appends to the store, then ALWAYS deletes its job
// file (the harness waits for inflight/ to drain before starting Agent B).
// FAILS OPEN: never throws, exits 0, logs timing to worker-events.jsonl.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendCheckpoint } from "../server/store.mjs";
import { readConversation } from "./transcript-claude.mjs";
import { appendJsonl, logError, envMs } from "./lib.mjs";

// The only fields taken from extractor output. The schema rejects unknown
// top-level keys, so a model that adds "notes" would otherwise lose the
// entire checkpoint — pick known fields, log the dropped NAMES (never
// values), and let validation stay strict on what remains.
const CONTENT_FIELDS = [
  "objective", "progress", "decisions", "rejected", "constraints",
  "artifacts", "unresolvedIssue", "nextAction", "remainingPlan", "evidence",
];
const PROMPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "extract-prompt.txt");

// Extract the first parseable top-level JSON object from model output,
// tolerating prose and code fences around it.
function extractJsonObject(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(i, j + 1));
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
        } catch { /* keep scanning */ }
        break;
      }
    }
  }
  return null;
}

function main() {
  const t0 = Date.now();
  const jobFile = process.argv[2];
  let event = null;
  let stored = false;
  let convo = null;
  try {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    event = job.event ?? null;
    const sessionId = job.sessionId ?? null;
    const cwd = typeof job.cwd === "string" ? job.cwd : null;
    const transcriptPath = job.transcriptPath;
    if (typeof transcriptPath !== "string" || !fs.existsSync(transcriptPath)) return;

    // Full file size feeds the eventId (it must change whenever the
    // transcript grows); readConversation picks the conversation out of the
    // bookkeeping and scrubs decoded text itself.
    let fileSize;
    try {
      fileSize = fs.statSync(transcriptPath).size;
      convo = readConversation(transcriptPath);
    } catch {
      return;
    }

    let cmd;
    try {
      cmd = JSON.parse(process.env.MIDA_SPIKE_EXTRACTOR_CMD || "");
      if (!Array.isArray(cmd) || !cmd.length) throw new Error("not an argv array");
    } catch (err) {
      logError("capture.extractor-cmd", `MIDA_SPIKE_EXTRACTOR_CMD invalid: ${err.message}`);
      return;
    }

    // A shell-exported Anthropic key would override the extractor's normal
    // login — strip both names (values are never logged).
    const childEnv = { ...process.env, MIDA_SPIKE_INNER: "1" };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    const prompt = fs.readFileSync(PROMPT_FILE, "utf8") + "\n" + convo.text;
    const res = spawnSync(cmd[0], cmd.slice(1), {
      input: prompt,
      encoding: "utf8",
      cwd: os.tmpdir(),
      env: childEnv,
      timeout: envMs("MIDA_SPIKE_EXTRACTOR_TIMEOUT_MS", 90_000),
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${res.status} signal ${res.signal}`;
      logError("capture.extractor", why);
      return;
    }

    const parsed = extractJsonObject(res.stdout || "");
    if (!parsed) {
      logError("capture.parse", "extractor produced no JSON object");
      return;
    }

    const picked = {};
    const dropped = [];
    for (const k of Object.keys(parsed)) {
      if (CONTENT_FIELDS.includes(k)) picked[k] = parsed[k];
      else dropped.push(k);
    }
    if (dropped.length) {
      logError("capture.dropped-keys", `extractor keys dropped: ${dropped.join(",")}`);
    }

    // The user's own words must never depend on the summariser — the field
    // is set deterministically from the transcript, AFTER the model's picks.
    // (originalRequest is deliberately absent from CONTENT_FIELDS: a model
    // that returns it gets it dropped + named above like any unknown key.)
    picked.originalRequest = convo.firstUserMessage ?? null;

    // Stored paths must not leak the local folder layout: strip the project
    // cwd the hook input carried; a path still absolute under the user's
    // home becomes "~/…".
    const home = os.homedir();
    const rel = (p) => {
      if (typeof p !== "string") return p;
      if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
      if (path.isAbsolute(p) && home.length > 1 && (p === home || p.startsWith(home + "/")))
        return "~" + p.slice(home.length);
      return p;
    };
    if (Array.isArray(picked.artifacts)) picked.artifacts = picked.artifacts.map(rel);
    if (Array.isArray(picked.evidence)) {
      picked.evidence = picked.evidence.map((e) =>
        e && typeof e === "object" && typeof e.ref === "string" && e.ref.startsWith("file:")
          ? { ...e, ref: "file:" + rel(e.ref.slice(5)) }
          : e,
      );
    }

    const eventId = crypto
      .createHash("sha256")
      .update(`${sessionId ?? ""}${event ?? ""}${fileSize}`)
      .digest("hex")
      .slice(0, 32);

    const result = appendCheckpoint({
      ...picked,
      eventId,
      agent: process.env.MIDA_SPIKE_AGENT || "unknown",
      source: "hook-compiler",
    });
    if (result.stored) {
      stored = true;
    } else if (result.duplicate) {
      // A frozen store is silent data loss — make it visible.
      logError("capture.duplicate", `duplicate eventId ${eventId}`);
    } else {
      logError("capture.validate", (result.errors || []).join("; "));
    }
  } catch (err) {
    logError("capture.worker", err);
  } finally {
    appendJsonl("worker-events.jsonl", {
      at: new Date().toISOString(),
      event,
      workerMs: Date.now() - t0,
      stored,
      format: convo?.format ?? null,
      messagesKept: convo?.messagesKept ?? 0,
      messagesTotal: convo?.messagesTotal ?? 0,
      charsSent: convo ? convo.text.length : 0,
    });
    // The job file is the harness's signal that this capture is done —
    // delete it on every path, success or failure.
    try {
      fs.unlinkSync(jobFile);
    } catch { /* already gone */ }
  }
}

main();
process.exit(0);
