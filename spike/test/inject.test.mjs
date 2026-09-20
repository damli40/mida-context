import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir, runHook, validCp } from "./helpers.mjs";
import { appendCheckpoint } from "../server/store.mjs";

const ENV = (store) => ({ MIDA_SPIKE_STORE: store });

const REQUEST =
  "Implement a rate limiter in src/bucket.mjs in 5 steps: " +
  "1) TokenBucket(capacity, refillPerSec) with tryTake(n); " +
  "2) an injectable clock so tests never sleep; " +
  "3) msUntilAvailable(n); " +
  "4) a KeyedLimiter with a max number of keys and LRU eviction; " +
  "5) a README usage section. No timers, no dependencies, synchronous API.";

function seed(store, cps) {
  const prev = process.env.MIDA_SPIKE_STORE;
  process.env.MIDA_SPIKE_STORE = store;
  try {
    for (const cp of cps) appendCheckpoint(cp);
  } finally {
    if (prev === undefined) delete process.env.MIDA_SPIKE_STORE;
    else process.env.MIDA_SPIKE_STORE = prev;
  }
}

test("inject: empty store prints nothing", () => {
  const store = tmpdir();
  const r = runHook("inject.mjs", { env: ENV(store), input: { hook_event_name: "SessionStart" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("inject: prints a handoff block with objective and next action", () => {
  const store = tmpdir();
  const prev = process.env.MIDA_SPIKE_STORE;
  process.env.MIDA_SPIKE_STORE = store;
  try {
    appendCheckpoint(validCp({ agent: "claude-code", source: "hook-compiler" }));
  } finally {
    if (prev === undefined) delete process.env.MIDA_SPIKE_STORE;
    else process.env.MIDA_SPIKE_STORE = prev;
  }

  const r = runHook("inject.mjs", { env: ENV(store), input: { hook_event_name: "SessionStart" } });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith("MIDA HANDOFF (saved by claude-code"));
  assert.match(r.stdout, /source hook-compiler/);
  assert.match(r.stdout, /Implement the TokenBucket rate limiter/);
  assert.match(r.stdout, /implement step 2/);
  assert.match(r.stdout, /If the user asks you to continue, continue from here\./);
  assert.ok(r.stdout.length < 6000);
});

test("inject: handoff prints the original request verbatim, before the objective (H3)", () => {
  const store = tmpdir();
  seed(store, [
    validCp({ originalRequest: REQUEST, source: "hook-compiler" }),
  ]);
  const r = runHook("inject.mjs", { env: ENV(store), input: { hook_event_name: "SessionStart" } });
  assert.equal(r.status, 0);
  assert.ok(
    r.stdout.includes(
      "ORIGINAL REQUEST (the user's own words, copied from the first message — not a summary):",
    ),
    "the ORIGINAL REQUEST section header is missing",
  );
  assert.ok(r.stdout.includes(REQUEST), "the request must appear verbatim");
  assert.ok(
    r.stdout.indexOf(REQUEST) < r.stdout.indexOf("Objective:"),
    "the request must come before the objective",
  );
});

test("inject: a newest checkpoint without originalRequest falls back to an older save (H3)", () => {
  const store = tmpdir();
  seed(store, [
    validCp({ eventId: "evt-00000001", originalRequest: REQUEST }),
    // a delta save from an agent that did not carry the request must not erase it
    validCp({ eventId: "evt-00000002", objective: "delta save: only step 3 left" }),
  ]);
  const r = runHook("inject.mjs", { env: ENV(store), input: { hook_event_name: "SessionStart" } });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(REQUEST), "the older checkpoint's request should be shown");
  assert.ok(r.stdout.includes("delta save: only step 3 left"), "the newest objective is still shown");
});

test("inject: Remaining plan renders right before Next action (H3)", () => {
  const store = tmpdir();
  seed(store, [
    validCp({
      remainingPlan: ["4. KeyedLimiter with max keys + LRU eviction", "5. README usage section"],
    }),
  ]);
  const r = runHook("inject.mjs", { env: ENV(store), input: { hook_event_name: "SessionStart" } });
  assert.equal(r.status, 0);
  const planIdx = r.stdout.indexOf("Remaining plan:");
  const nextIdx = r.stdout.indexOf("Next action:");
  assert.ok(planIdx > -1, "Remaining plan section missing");
  assert.ok(r.stdout.includes("4. KeyedLimiter"), "plan items missing");
  assert.ok(planIdx < nextIdx, "Remaining plan must come before Next action");
  assert.match(r.stdout, /Remaining plan:[\s\S]*?\n\nNext action:/, "Remaining plan must sit right before Next action");
});

test("inject: stays under 12,000 chars with 50 long decisions; the request is never trimmed (H3)", () => {
  const store = tmpdir();
  const longRequest = `${REQUEST} ${"padding ".repeat(700)}END-OF-REQUEST`;
  seed(store, [
    validCp({
      originalRequest: longRequest,
      progress: Array.from({ length: 50 }, (_, i) => `progress ${i} ${"p".repeat(1500)}`),
      decisions: Array.from({ length: 50 }, (_, i) => ({
        decision: `decision ${i} ${"d".repeat(1500)}`,
        rationale: "r".repeat(1500),
      })),
      evidence: Array.from({ length: 50 }, (_, i) => ({
        field: `decisions[${i}]`,
        ref: `transcript:L${i} ${"e".repeat(1500)}`,
      })),
    }),
  ]);
  const r = runHook("inject.mjs", { env: ENV(store), input: { hook_event_name: "SessionStart" } });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith("MIDA HANDOFF"));
  assert.ok(r.stdout.length <= 12_000, `got ${r.stdout.length} chars`);
  assert.ok(r.stdout.includes("END-OF-REQUEST"), "the original request must never be trimmed");
});
