import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, tmpdir, runHook, readJsonl, countOccurrences, waitFor, capturesSettled } from "./helpers.mjs";

const SECRETS = {
  openai: "sk-test-abc123def456ghi789",
  github: "ghp_test1234567890abcdef",
  hexkey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  barehex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  envassign: "API_KEY=hunter2",
  envquoted: "hunter2-real-secret",
  jsonKv: "plainApiKeyValue42",
  bearer: "tok-live-bearer-abc123",
};

// A real JSONL transcript: every line is JSON.stringify output (secrets sit
// inside JSON strings, so quotes arrive backslash-escaped) EXCEPT the first
// line, which is cut mid-JSON like a real 60 KB tail read.
function fixtureTranscript(dir) {
  const p = path.join(dir, "transcript.jsonl");
  const lines = [
    `cut mid-line: API_KEY=\\"${SECRETS.envquoted}\\" && run`,
    JSON.stringify({ role: "assistant", content: "I will implement the TokenBucket now." }),
    JSON.stringify({ role: "assistant", content: `export API_KEY="${SECRETS.envquoted}" && run` }),
    JSON.stringify({ role: "assistant", content: `using key ${SECRETS.openai} for the call` }),
    JSON.stringify({ role: "assistant", content: `github token ${SECRETS.github}` }),
    JSON.stringify({ role: "assistant", content: `env says ${SECRETS.envassign}` }),
    JSON.stringify({ role: "assistant", content: `wallet key ${SECRETS.hexkey}` }),
    JSON.stringify({ role: "assistant", content: `bare hex ${SECRETS.barehex} seen` }),
    JSON.stringify({ role: "tool", content: `Authorization: Bearer ${SECRETS.bearer}` }),
    JSON.stringify({ cfg: { privateKey: SECRETS.barehex, apiKey: SECRETS.jsonKv } }),
    JSON.stringify({ role: "assistant", content: "the key idea is simple" }),
    JSON.stringify({ role: "assistant", content: 'key: "user:42" survives' }),
    JSON.stringify({ role: "assistant", content: "step 1 done, tests pass." }),
  ];
  fs.writeFileSync(p, lines.join("\n"));
  return p;
}

function captureEnv(store, extra = {}) {
  return {
    MIDA_SPIKE_STORE: store,
    MIDA_SPIKE_AGENT: "claude-code",
    MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-extractor.mjs")]),
    ...extra,
  };
}

test("capture: stores a hook-compiler checkpoint with secrets scrubbed", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const stubOut = path.join(dir, "stub-stdin.txt");
  const transcript = fixtureTranscript(dir);

  const r = runHook("capture.mjs", {
    env: captureEnv(store, { MIDA_STUB_OUT: stubOut }),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");

  // The hook only queues a job; the detached worker stores the checkpoint.
  await waitFor(() => readJsonl(path.join(store, "checkpoints.jsonl")).length >= 1 || capturesSettled(store), 10_000);
  const cps = readJsonl(path.join(store, "checkpoints.jsonl"));
  assert.equal(cps.length, 1);
  assert.equal(cps[0].source, "hook-compiler");
  assert.equal(cps[0].agent, "claude-code");
  assert.equal(cps[0].objective, "Implement the TokenBucket rate limiter");
  assert.equal(cps[0].eventId.length, 32);

  const stubStdin = fs.readFileSync(stubOut, "utf8");
  assert.ok(stubStdin.includes("[REDACTED]"));
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(!stubStdin.includes(secret), `${name} secret leaked into extractor stdin`);
  }
  // "hunter2" is a substring of both env-secret values — belt and braces
  assert.ok(!stubStdin.includes("hunter2"), "env-assignment secret leaked");
  assert.ok(stubStdin.includes("API_KEY=[REDACTED]"), "name should be kept, value redacted");
  // non-secret sentences must pass through unscathed
  assert.ok(stubStdin.includes("the key idea is simple"), "ordinary prose was shredded");
  assert.ok(stubStdin.includes("user:42"), "short non-secret value was shredded");
});

test("capture: garbage extractor output -> exit 0, nothing stored, error logged, inflight drained", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const transcript = fixtureTranscript(dir);
  const r = runHook("capture.mjs", {
    env: captureEnv(store, {
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-garbage.mjs")]),
    }),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  // the worker deletes its job file even when the extractor fails
  assert.ok(await waitFor(() => capturesSettled(store), 10_000), "inflight/ must drain on failure");
  assert.equal(readJsonl(path.join(store, "checkpoints.jsonl")).length, 0);
  const errors = readJsonl(path.join(store, "errors.jsonl"));
  assert.equal(errors.length, 1);
});

test("capture: hanging extractor is killed by the shortened timeout", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const transcript = fixtureTranscript(dir);
  const started = Date.now();
  const r = runHook("capture.mjs", {
    env: captureEnv(store, {
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-hang.mjs")]),
      MIDA_SPIKE_EXTRACTOR_TIMEOUT_MS: "1500",
    }),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - started < 1_500, "hook must return fast — the worker owns the slow call");
  // the worker is killed by the timeout, then still deletes its job file
  assert.ok(await waitFor(() => capturesSettled(store), 15_000), "inflight/ must drain");
  assert.equal(readJsonl(path.join(store, "checkpoints.jsonl")).length, 0);
  assert.ok(readJsonl(path.join(store, "errors.jsonl")).length >= 1);
});

test("capture: MIDA_SPIKE_INNER=1 exits immediately, no extractor, no writes", () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const stubOut = path.join(dir, "stub-stdin.txt");
  const transcript = fixtureTranscript(dir);
  const r = runHook("capture.mjs", {
    env: captureEnv(store, { MIDA_SPIKE_INNER: "1", MIDA_STUB_OUT: stubOut }),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(store, "checkpoints.jsonl")));
  assert.ok(!fs.existsSync(path.join(store, "hook-events.jsonl")));
  assert.ok(!fs.existsSync(stubOut));
});

test("capture: debounce skips a second Stop but always runs PreCompact", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const stubOut = path.join(dir, "stub-stdin.txt");
  const transcript = fixtureTranscript(dir);
  const env = captureEnv(store, { MIDA_STUB_OUT: stubOut });
  const input = (event) => ({
    hook_event_name: event,
    session_id: "s1",
    transcript_path: transcript,
  });

  assert.equal(runHook("capture.mjs", { env, input: input("Stop") }).status, 0);
  assert.equal(runHook("capture.mjs", { env, input: input("Stop") }).status, 0);
  assert.equal(runHook("capture.mjs", { env, input: input("PreCompact") }).status, 0);

  assert.ok(await waitFor(() => capturesSettled(store), 10_000), "inflight/ must drain");
  const calls = fs.readFileSync(stubOut, "utf8");
  assert.equal(countOccurrences(calls, "===CALL==="), 2, "extractor ran for Stop #1 and PreCompact only");
  const cps = readJsonl(path.join(store, "checkpoints.jsonl"));
  assert.equal(cps.length, 2);
});

test("capture: >60KB transcripts get distinct eventIds; a true duplicate is logged (F1)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  // Both tails clamp to the same 60,000 bytes — the eventId must NOT come
  // from the tail length or the second capture would collapse into the first.
  const t1 = path.join(dir, "transcript-a.jsonl");
  const t2 = path.join(dir, "transcript-b.jsonl");
  fs.writeFileSync(t1, "a".repeat(80_000));
  fs.writeFileSync(t2, "b".repeat(120_000));
  const env = captureEnv(store, { MIDA_SPIKE_DEBOUNCE_MS: "0" });
  const stop = (tp) => ({ hook_event_name: "Stop", session_id: "s1", transcript_path: tp });
  const cpFile = path.join(store, "checkpoints.jsonl");
  const errFile = path.join(store, "errors.jsonl");

  runHook("capture.mjs", { env, input: stop(t1) });
  runHook("capture.mjs", { env, input: stop(t2) });
  await waitFor(() => readJsonl(cpFile).length >= 2 || capturesSettled(store), 10_000);
  const cps = readJsonl(cpFile);
  assert.equal(cps.length, 2, "two different transcript sizes must store two checkpoints");
  assert.notEqual(cps[0].eventId, cps[1].eventId);

  // Re-capturing the identical transcript+event is a real duplicate:
  // nothing stored, but it must be visible in errors.jsonl.
  runHook("capture.mjs", { env, input: stop(t1) });
  await waitFor(
    () => readJsonl(errFile).some((e) => e.where === "capture.duplicate") || capturesSettled(store),
    10_000,
  );
  const dup = readJsonl(errFile).find((e) => e.where === "capture.duplicate");
  assert.ok(dup, "duplicate capture should log a capture.duplicate line");
  assert.ok(dup.message.includes(cps[0].eventId), "duplicate line names the eventId");
  assert.equal(readJsonl(cpFile).length, 2, "duplicate must not add a third record");
});

test("capture: unknown extractor fields are dropped, not fatal (F3)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const transcript = fixtureTranscript(dir);
  const cpFile = path.join(store, "checkpoints.jsonl");
  const errFile = path.join(store, "errors.jsonl");
  const r = runHook("capture.mjs", {
    env: captureEnv(store, {
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-extra-keys.mjs")]),
    }),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  await waitFor(() => readJsonl(cpFile).length >= 1 || capturesSettled(store), 10_000);
  const cps = readJsonl(cpFile);
  assert.equal(cps.length, 1, "extra model fields must not discard the checkpoint");
  assert.equal(cps[0].objective, "Implement the TokenBucket rate limiter");
  assert.ok(!("notes" in cps[0]) && !("confidence" in cps[0]), "unknown keys must be dropped");
  const dropped = readJsonl(errFile).filter((e) => e.where === "capture.dropped-keys");
  assert.equal(dropped.length, 1, "one capture.dropped-keys line expected");
  assert.ok(dropped[0].message.includes("notes") && dropped[0].message.includes("confidence"));
});

test("capture: hook returns in <1.5s while the worker stores asynchronously (F4)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const transcript = fixtureTranscript(dir);
  const t0 = Date.now();
  const r = runHook("capture.mjs", {
    env: captureEnv(store, {
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-sleep.mjs")]),
      MIDA_STUB_SLEEP_MS: "3000",
    }),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  const hookMs = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.ok(hookMs < 1500, `hook blocked for ${hookMs}ms — extractor must run in the worker`);

  // the hook's own wall time lands on the hook-events line
  const ev = readJsonl(path.join(store, "hook-events.jsonl"))[0];
  assert.ok(typeof ev.hookMs === "number" && ev.hookMs < 1500, "hookMs must be logged and small");

  // the checkpoint appears once the sleeping worker finishes (<= 6s)
  const cpFile = path.join(store, "checkpoints.jsonl");
  assert.ok(
    await waitFor(() => readJsonl(cpFile).length === 1, 6_000),
    "checkpoint should appear within 6s of the hook returning",
  );
  assert.ok(await waitFor(() => capturesSettled(store), 6_000), "inflight/ must end empty");

  const worker = readJsonl(path.join(store, "worker-events.jsonl"))[0];
  assert.equal(worker.event, "Stop");
  assert.equal(worker.stored, true);
  assert.ok(worker.workerMs >= 2500, "workerMs should reflect the 3s extractor call");
});

test("capture: remainingPlan from the extractor is stored (H2)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const transcript = fixtureTranscript(dir);
  const r = runHook("capture.mjs", {
    env: captureEnv(store),
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  const cpFile = path.join(store, "checkpoints.jsonl");
  await waitFor(() => readJsonl(cpFile).length >= 1 || capturesSettled(store), 10_000);
  const cps = readJsonl(cpFile);
  assert.equal(cps.length, 1);
  assert.deepEqual(cps[0].remainingPlan, [
    "4. KeyedLimiter with max keys + LRU eviction",
    "5. README usage section",
  ]);
});

test("capture: absolute paths are stored relative to cwd or ~ (H4)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const transcript = fixtureTranscript(dir);
  const r = runHook("capture.mjs", {
    env: captureEnv(store, {
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-paths.mjs")]),
      MIDA_STUB_CWD: dir,
    }),
    input: {
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: transcript,
      cwd: dir,
    },
  });
  assert.equal(r.status, 0);
  const cpFile = path.join(store, "checkpoints.jsonl");
  await waitFor(() => readJsonl(cpFile).length >= 1 || capturesSettled(store), 10_000);
  const cps = readJsonl(cpFile);
  assert.equal(cps.length, 1);
  assert.deepEqual(cps[0].artifacts, ["src/a.mjs", "src/b.mjs", "~/other/c.txt"]);
  assert.deepEqual(cps[0].evidence, [
    { field: "artifacts[0]", ref: "file:src/a.mjs" },
    { field: "objective", ref: "transcript:L2" },
  ]);
});

test("capture: missing transcript still logs the hook event and exits 0", () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const r = runHook("capture.mjs", {
    env: captureEnv(store),
    input: { hook_event_name: "Stop", session_id: "s1" },
  });
  assert.equal(r.status, 0);
  const events = readJsonl(path.join(store, "hook-events.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "Stop");
  assert.equal(events[0].hasTranscript, false);
});
