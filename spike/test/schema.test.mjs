import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCheckpoint } from "../server/schema.mjs";
import { validCp } from "./helpers.mjs";

test("schema: a valid checkpoint passes", () => {
  const r = validateCheckpoint(validCp());
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.equal(r.value.objective, "Implement the TokenBucket rate limiter");
});

test("schema: missing objective fails", () => {
  const cp = validCp();
  delete cp.objective;
    const r = validateCheckpoint(cp);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("objective")));
});

test("schema: unknown top-level key fails", () => {
  const r = validateCheckpoint(validCp({ extraField: "nope" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("extraField")));
});

test("schema: oversize string fails", () => {
  const r = validateCheckpoint(validCp({ objective: "x".repeat(2001) }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("2000")));
});

test("schema: wrong types fail", () => {
  const r = validateCheckpoint(validCp({ progress: "not an array", nextAction: 42 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("progress")));
  assert.ok(r.errors.some((e) => e.includes("nextAction")));
});

test("schema: bad source fails", () => {
  const r = validateCheckpoint(validCp({ source: "mystery" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("source")));
});

test("schema: malformed nested items fail", () => {
  const r = validateCheckpoint(validCp({ decisions: [{ decision: "x" }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("rationale")));
});

test("schema: remainingPlan accepts a string list and defaults to [] (H2)", () => {
  const plan = ["4. KeyedLimiter with max keys + LRU eviction", "5. README usage section"];
  const r = validateCheckpoint(validCp({ remainingPlan: plan }));
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.deepEqual(r.value.remainingPlan, plan);
  assert.deepEqual(validateCheckpoint(validCp()).value.remainingPlan, []);
});

test("schema: remainingPlan is capped like the other arrays (H2)", () => {
  assert.equal(validateCheckpoint(validCp({ remainingPlan: Array(51).fill("x") })).ok, false);
  assert.equal(validateCheckpoint(validCp({ remainingPlan: [42] })).ok, false);
});
