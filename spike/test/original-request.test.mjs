// H1: every checkpoint carries the user's original request verbatim, taken
// from the transcript's first real user message — never from the model,
// because a summariser compresses away the remaining steps (observed live:
// the handoff said "5 steps" but named none, and the continuing agent
// stopped rather than invent them).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, tmpdir, runHook, readJsonl, waitFor, capturesSettled, validCp } from "./helpers.mjs";
import { readConversation } from "../hooks/transcript-claude.mjs";
import { validateCheckpoint } from "../server/schema.mjs";

// The request names the remaining work (KeyedLimiter, README) that the
// summarised objective compressed away in the real handoff.
const REQUEST =
  "Implement a rate limiter in src/bucket.mjs in 5 steps: " +
  "1) TokenBucket(capacity, refillPerSec) with tryTake(n); " +
  "2) an injectable clock so tests never sleep; " +
  "3) msUntilAvailable(n); " +
  "4) a KeyedLimiter with a max number of keys and LRU eviction; " +
  "5) a README usage section. No timers, no dependencies, synchronous API.";

const SECRET = "sk-test-abc123def456ghi789";

function writeTranscript(dir, lines) {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, lines.join("\n"));
  return p;
}

const userLine = (content) =>
  JSON.stringify({ type: "user", message: { role: "user", content } });
const assistantLine = (text) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

function workerEnv(store) {
  return {
    MIDA_SPIKE_STORE: store,
    MIDA_SPIKE_AGENT: "claude-code",
    MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify([
      "node",
      path.join(ROOT, "test", "stub-original-request.mjs"),
    ]),
  };
}

async function captureOne(dir, transcript) {
  const store = path.join(dir, "store");
  const r = runHook("capture.mjs", {
    env: workerEnv(store),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript, cwd: dir },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const cpFile = path.join(store, "checkpoints.jsonl");
  assert.ok(
    await waitFor(() => readJsonl(cpFile).length >= 1 || capturesSettled(store), 10_000),
    "worker never finished",
  );
  return { store, cps: readJsonl(cpFile) };
}

// --- readConversation: firstUserMessage ---

test("readConversation: firstUserMessage is the user's first message, verbatim", () => {
  const dir = tmpdir();
  const t = writeTranscript(dir, [
    JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", text: "noise" } }),
    userLine(REQUEST),
    assistantLine("working on it"),
  ]);
  const r = readConversation(t);
  assert.equal(r.format, "claude-jsonl");
  assert.equal(r.firstUserMessage, REQUEST);
});

test("readConversation: a first user line holding only a tool_result is skipped", () => {
  const dir = tmpdir();
  const t = writeTranscript(dir, [
    userLine([{ type: "tool_result", tool_use_id: "t1", content: "resumed output" }]),
    userLine([{ type: "text", text: REQUEST }]),
    assistantLine("ok"),
  ]);
  const r = readConversation(t);
  assert.equal(r.firstUserMessage, REQUEST, "the next real user message must be picked");
});

test("readConversation: a secret inside the first user message is redacted", () => {
  const dir = tmpdir();
  const t = writeTranscript(dir, [
    userLine(`build the limiter; my key is ${SECRET} in case you need it`),
  ]);
  const r = readConversation(t);
  assert.ok(r.firstUserMessage.includes("[REDACTED]"));
  assert.ok(!r.firstUserMessage.includes(SECRET));
});

test("readConversation: a 9,000-char first message is cut to 6,000 chars with …", () => {
  const dir = tmpdir();
  const t = writeTranscript(dir, [userLine("x".repeat(9_000))]);
  const r = readConversation(t);
  assert.equal(r.firstUserMessage.length, 6_000);
  assert.ok(r.firstUserMessage.endsWith("…"));
});

test("readConversation: unknown-tail transcripts get firstUserMessage null", () => {
  const dir = tmpdir();
  const t = writeTranscript(dir, ["not json at all", JSON.stringify({ type: "system" })]);
  const r = readConversation(t);
  assert.equal(r.format, "unknown-tail");
  assert.equal(r.firstUserMessage, null);
});

// --- schema: originalRequest is exempt from the 2,000-char cap ---

test("schema: originalRequest accepts null and a 3,000-char string", () => {
  assert.equal(validateCheckpoint(validCp({ originalRequest: null })).ok, true);
  const r = validateCheckpoint(validCp({ originalRequest: "y".repeat(3_000) }));
  assert.equal(r.ok, true, r.errors?.join("; "));
});

test("schema: originalRequest rejects over 6,000 chars and non-strings", () => {
  assert.equal(validateCheckpoint(validCp({ originalRequest: "y".repeat(6_001) })).ok, false);
  assert.equal(validateCheckpoint(validCp({ originalRequest: 42 })).ok, false);
});

// --- end to end through the capture worker ---

test("worker: originalRequest comes from the transcript, not the model (H1)", async () => {
  const dir = tmpdir();
  const transcript = writeTranscript(dir, [userLine(REQUEST), assistantLine("half done")]);
  const { store, cps } = await captureOne(dir, transcript);

  assert.equal(cps.length, 1, "checkpoint must store even though the model sent an unknown key");
  assert.equal(cps[0].originalRequest, REQUEST);
  assert.ok(cps[0].originalRequest.includes("KeyedLimiter"));
  assert.ok(cps[0].originalRequest.includes("README"));
  assert.ok(!JSON.stringify(cps[0]).includes("model wrote this"), "model's value must be dropped");

  const dropped = readJsonl(path.join(store, "errors.jsonl")).filter(
    (e) => e.where === "capture.dropped-keys",
  );
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].message.includes("originalRequest"), "dropped key must be named");
});

test("worker: a secret in the first user message is redacted before storing (H1)", async () => {
  const dir = tmpdir();
  const transcript = writeTranscript(dir, [
    userLine(`build the limiter; my key is ${SECRET} in case you need it`),
  ]);
  const { cps } = await captureOne(dir, transcript);
  assert.equal(cps.length, 1);
  assert.ok(cps[0].originalRequest.includes("[REDACTED]"));
  assert.ok(!cps[0].originalRequest.includes(SECRET));
});

test("worker: a 9,000-char first message stores 6,000 chars ending in … (H1)", async () => {
  const dir = tmpdir();
  const transcript = writeTranscript(dir, [userLine("z".repeat(9_000))]);
  const { cps } = await captureOne(dir, transcript);
  assert.equal(cps.length, 1, "the capped request must still validate");
  assert.equal(cps[0].originalRequest?.length, 6_000);
  assert.ok(cps[0].originalRequest?.endsWith("…"));
});

test("worker: unknown-tail transcript stores originalRequest null (H1)", async () => {
  const dir = tmpdir();
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcript, "not json at all\nstill not json\n");
  const { cps } = await captureOne(dir, transcript);
  assert.equal(cps.length, 1);
  assert.equal(cps[0].originalRequest, null);
});
