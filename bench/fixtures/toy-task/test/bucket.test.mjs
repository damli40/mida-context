import { test } from "node:test"
import assert from "node:assert/strict"
import { TokenBucket } from "../src/bucket.mjs"

test("a full bucket lets a burst through, then refuses", () => {
  const bucket = new TokenBucket(1, 3)
  assert.equal(bucket.take(), true)
  assert.equal(bucket.take(), true)
  assert.equal(bucket.take(), true)
  assert.equal(bucket.take(), false)
})

test("tokens are refilled lazily at read time, never on a timer", async () => {
  const bucket = new TokenBucket(50, 1)
  assert.equal(bucket.take(), true)
  assert.equal(bucket.take(), false)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(bucket.take(), true)
})
