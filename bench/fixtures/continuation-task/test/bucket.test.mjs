import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/bucket.mjs";

// Basic capacity + tryTake semantics.

test("tryTake consumes tokens up to capacity", () => {
  const b = new TokenBucket(3, 10);
  assert.equal(b.tryTake(2), true);
  assert.equal(b.tryTake(2), false);
  assert.equal(b.tryTake(1), true);
});

test("tryTake refuses a request larger than capacity", () => {
  const b = new TokenBucket(5, 10);
  assert.equal(b.tryTake(6), false);
  assert.equal(b.tryTake(5), true);
});

test("tryTake refuses non-positive amounts", () => {
  const b = new TokenBucket(5, 10);
  assert.equal(b.tryTake(0), false);
  assert.equal(b.tryTake(-2), false);
});
