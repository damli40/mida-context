import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendCheckpoint, latestHandoff, logCall } from "../server/store.mjs";
import { tmpdir, validCp, readJsonl } from "./helpers.mjs";

function withStore(fn) {
  const dir = tmpdir();
  const prev = process.env.MIDA_SPIKE_STORE;
  process.env.MIDA_SPIKE_STORE = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MIDA_SPIKE_STORE;
    else process.env.MIDA_SPIKE_STORE = prev;
  }
}

test("store: append + latestHandoff round trip", () => {
  withStore(() => {
    const r = appendCheckpoint(validCp());
    assert.equal(r.stored, true);
    const h = latestHandoff();
    assert.equal(h.checkpoint.objective, "Implement the TokenBucket rate limiter");
    assert.equal(h.history.count, 1);
    assert.equal(h.history.recent[0].eventId, "evt-00000001");
    assert.ok(h.checkpoint.createdAt, "store stamps createdAt");
  });
});

test("store: same eventId twice stores once and reports duplicate", () => {
  withStore((dir) => {
    assert.equal(appendCheckpoint(validCp()).stored, true);
    const second = appendCheckpoint(validCp());
    assert.equal(second.stored, false);
    assert.equal(second.duplicate, true);
    const lines = readJsonl(path.join(dir, "checkpoints.jsonl"));
    assert.equal(lines.length, 1);
  });
});

test("store: empty store returns null", () => {
  withStore(() => {
    assert.equal(latestHandoff(), null);
  });
});

test("store: unset MIDA_SPIKE_STORE throws a clear error", () => {
  const prev = process.env.MIDA_SPIKE_STORE;
  delete process.env.MIDA_SPIKE_STORE;
  try {
    assert.throws(() => latestHandoff(), /MIDA_SPIKE_STORE/);
  } finally {
    if (prev !== undefined) process.env.MIDA_SPIKE_STORE = prev;
  }
});

test("store: logCall writes at/tool/agent/ok and nothing else", () => {
  withStore((dir) => {
    logCall({ tool: "mida_handoff", agent: "codex", ok: true });
    const lines = readJsonl(path.join(dir, "calls.jsonl"));
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["agent", "at", "ok", "tool"]);
    assert.equal(lines[0].agent, "codex");
    assert.equal(lines[0].ok, true);
    assert.ok(fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").length < 500);
  });
});
