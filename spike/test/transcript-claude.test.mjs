import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, tmpdir, runHook, readJsonl, waitFor, capturesSettled } from "./helpers.mjs";
import { readConversation } from "../hooks/transcript-claude.mjs";

// All fixtures are built with JSON.stringify — never hand-escaped.

function writeTranscript(dir, lines) {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, lines.join("\n"));
  return p;
}

// A transcript shaped like the measured real one: a huge prompt_snapshot
// attachment (~75% of bytes), other bookkeeping lines, and a small real
// conversation carrying a constraint in the FIRST user message.
function measuredShape(dir) {
  let payload = "";
  for (let i = 0; payload.length < 120_000; i++) payload += `snapshot-row-${i}-pad `;
  const p = writeTranscript(dir, [
    JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", text: payload } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Build a TokenBucket rate limiter. Hard constraint: no timers anywhere." } }),
    JSON.stringify({ type: "attachment", attachment: { type: "skill_listing", text: "many skills listed" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "planning the steps" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/bucket.mjs", content: "code" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file written ok" }] } }),
    JSON.stringify({ type: "system", subtype: "init", data: "bookkeeping" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done — all three tests pass." }] } }),
  ]);
  return { path: p, payload };
}

test("readConversation: bookkeeping is skipped, constraint + final answer kept (G1)", () => {
  const dir = tmpdir();
  const { path: t, payload } = measuredShape(dir);
  const r = readConversation(t, { maxChars: 40_000 });

  assert.equal(r.format, "claude-jsonl");
  assert.ok(r.text.includes("no timers anywhere"), "the constraint in the first user message is missing");
  assert.ok(r.text.includes("Done — all three tests pass."), "final assistant text is missing");
  for (const off of [0, 60_000, payload.length - 40]) {
    assert.ok(!r.text.includes(payload.slice(off, off + 40)), "prompt_snapshot payload leaked into text");
  }
  assert.ok(r.text.length <= 40_000, `text ${r.text.length} exceeds maxChars`);
  assert.equal(r.messagesTotal, 5); // user + user(tool_result) + 3 assistant lines
  assert.equal(r.omitted, 0);
});

test("readConversation: first user message pinned, middle omitted with marker (G1)", () => {
  const dir = tmpdir();
  const body = (tag) => `${tag} ` + "m".repeat(500);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: body("FIRST-REQUEST") } }),
  ];
  for (let i = 1; i < 300; i++) {
    const role = i % 2 ? "assistant" : "user";
    lines.push(JSON.stringify({ type: role, message: { role, content: body(`MSG-${i}`) } }));
  }
  const t = writeTranscript(dir, lines);
  const r = readConversation(t, { maxChars: 40_000 });

  assert.equal(r.messagesTotal, 300);
  assert.ok(r.text.includes("FIRST-REQUEST"), "first user message must be kept in full");
  assert.ok(r.text.includes("MSG-299"), "the most recent message must be kept");
  assert.ok(r.text.length <= 40_000, `text ${r.text.length} exceeds maxChars`);
  assert.ok(r.omitted > 0, "middle messages should have been dropped");
  assert.equal(r.omitted, r.messagesTotal - r.messagesKept);
  assert.ok(
    r.text.includes(`[… ${r.omitted} earlier messages omitted …]`),
    "omitted marker with the right count is missing",
  );
});

test("readConversation: long tool_result and tool_use input are cut with … (G1)", () => {
  const dir = tmpdir();
  const bigResult = "R".repeat(20_000);
  const bigInput = { code: "x".repeat(5_000) };
  const t = writeTranscript(dir, [
    JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: bigInput }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: bigResult }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "final" }] } }),
  ]);
  const r = readConversation(t, { maxChars: 40_000 });

  assert.ok(!r.text.includes(bigResult), "full 20k tool_result must not appear");
  assert.ok(!r.text.includes("x".repeat(5_000)), "full tool_use input must not appear");
  assert.ok(r.text.includes("[result] " + "R".repeat(600) + "…"), "tool_result should be cut at 600 chars with …");
  assert.ok(
    r.text.split("\n").some((l) => l.startsWith("[tool Write]") && l.endsWith("…")),
    "tool_use input should be cut with …",
  );
});

test("readConversation: secrets inside tool_result are redacted; L<n> are real line numbers (G1)", () => {
  const dir = tmpdir();
  const secret = "sk-test-abc123def456ghi789";
  const t = writeTranscript(dir, [
    JSON.stringify({ type: "attachment", attachment: { type: "environment", text: "noise" } }),
    JSON.stringify({ type: "attachment", attachment: { type: "date", text: "noise" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "please fix the flaky test" } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `token is ${secret}` }] } }),
  ]);
  const r = readConversation(t, { maxChars: 40_000 });

  assert.ok(r.text.startsWith("L3 user:"), "first user message sits on file line 3");
  assert.ok(r.text.includes("L4 user:"), "tool_result line sits on file line 4");
  assert.ok(r.text.includes("[REDACTED]"), "secret must be redacted");
  assert.ok(!r.text.includes(secret), "raw secret leaked");
});

test("readConversation: no user/assistant lines → unknown-tail fallback (G1)", () => {
  const dir = tmpdir();
  const t = writeTranscript(dir, [
    JSON.stringify({ type: "attachment", attachment: { text: "tail-content-marker" } }),
    "not json at all",
    JSON.stringify({ type: "system", subtype: "init" }),
  ]);
  const r = readConversation(t, { maxChars: 40_000 });

  assert.equal(r.format, "unknown-tail");
  assert.ok(r.text.includes("tail-content-marker"), "fallback should still carry the scrubbed tail");
  assert.equal(r.messagesTotal, 0);
});

test("worker sends the conversation, not the bookkeeping (G1 end to end)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const stubOut = path.join(dir, "stub-stdin.txt");
  const { path: transcript, payload } = measuredShape(dir);

  const r = runHook("capture.mjs", {
    env: {
      MIDA_SPIKE_STORE: store,
      MIDA_SPIKE_AGENT: "claude-code",
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify(["node", path.join(ROOT, "test", "stub-extractor.mjs")]),
      MIDA_STUB_OUT: stubOut,
    },
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  assert.ok(
    await waitFor(() => readJsonl(path.join(store, "checkpoints.jsonl")).length >= 1 || capturesSettled(store), 10_000),
    "worker never finished",
  );

  const stdin = fs.readFileSync(stubOut, "utf8");
  assert.ok(stdin.includes("no timers anywhere"), "constraint sentence missing from extractor stdin");
  assert.ok(!stdin.includes(payload.slice(0, 40)), "snapshot payload reached the extractor");

  const ev = readJsonl(path.join(store, "worker-events.jsonl"))[0];
  assert.equal(ev.format, "claude-jsonl");
  assert.equal(ev.messagesTotal, 5);
  assert.ok(ev.messagesKept >= 1);
  assert.ok(typeof ev.charsSent === "number" && ev.charsSent <= 40_000);
});
