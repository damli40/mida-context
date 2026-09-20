// capture.mjs — the fast half of the capture path. Invoked by agent CLI
// hook events (Stop / PreCompact / SessionEnd / PostToolUse / ...). Reads
// one JSON object on stdin, logs the event, debounces, then writes a job
// file to $MIDA_SPIKE_STORE/inflight/ and spawns capture-worker.mjs
// DETACHED — the transcript read, scrub, and extractor call happen there.
// The hook returns in well under a second; a headless agent that dies
// mid-turn still leaves checkpoints behind via PostToolUse events.
// FAILS OPEN: always exits 0, never prints.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readStdinJson, logHookEvent, logError, storeDir, envMs } from "./lib.mjs";

const ALWAYS_RUN = new Set(["PreCompact", "SessionEnd", "StopFailure"]);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-worker.mjs");

function debounced(sessionKey, event, debounceMs) {
  if (ALWAYS_RUN.has(event)) return false;
  try {
    const last = JSON.parse(
      fs.readFileSync(path.join(storeDir(), "last-capture.json"), "utf8"),
    );
    if (last.sessionKey === sessionKey && Date.now() - last.at < debounceMs) return true;
  } catch {
    // no prior capture — proceed
  }
  return false;
}

async function main() {
  // Guard: the extractor is itself an agent CLI — its hook events must not
  // re-enter this script and loop forever.
  if (process.env.MIDA_SPIKE_INNER === "1") return;

  const t0 = Date.now();
  const input = await readStdinJson();
  const event = input.hook_event_name ?? null;
  const sessionId = input.session_id ?? null;
  const transcriptPath = input.transcript_path;
  const hasTranscript =
    typeof transcriptPath === "string" && fs.existsSync(transcriptPath);

  try {
    if (!hasTranscript) return;

    const debounceMs = envMs("MIDA_SPIKE_DEBOUNCE_MS", 45_000);
    const sessionKey = sessionId ?? transcriptPath;
    if (debounced(sessionKey, event, debounceMs)) return;

    const dir = storeDir();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });

    // Mark the capture before queueing so concurrent hook fires debounce too.
    try {
      fs.writeFileSync(
        path.join(dir, "last-capture.json"),
        JSON.stringify({ sessionKey, at: Date.now(), event }),
      );
    } catch {
      // proceed anyway — debounce is best-effort
    }

    const inflight = path.join(dir, "inflight");
    fs.mkdirSync(inflight, { recursive: true });
    const jobFile = path.join(inflight, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(
      jobFile,
      // cwd travels with the job so the worker can store artifact paths
      // relative to the project instead of leaking the local layout.
      JSON.stringify({
        event,
        sessionId,
        transcriptPath,
        cwd: input.cwd ?? null,
        at: new Date().toISOString(),
      }),
    );

    const child = spawn(process.execPath, [WORKER, jobFile], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      logError("capture.spawn", err);
      try {
        fs.unlinkSync(jobFile);
      } catch { /* best effort */ }
    });
    child.unref();
  } catch (err) {
    logError("capture.main", err);
  } finally {
    logHookEvent(event, sessionId, { hasTranscript, hookMs: Date.now() - t0 });
  }
}

main().finally(() => process.exit(0));
