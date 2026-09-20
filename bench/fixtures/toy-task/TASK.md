# Bench task: finish the token bucket

`src/bucket.mjs` is partially built. Finish the task so `npm test` passes and the
extra steps below are done.

## Constraints (from the earlier session's brief — they must be kept)

- **No timers.** Do not use `setTimeout` or `setInterval` anywhere under `src/`.
  Refill is computed lazily at read time — the bucket already works that way; keep it.
- Keep the public API names already exported from `src/bucket.mjs`.

## Steps 4–5 — decided in the earlier session, present only in this brief

4. Add `src/lru.mjs` exporting `class KeyedLimiter` that maps string keys to
   `TokenBucket` instances and evicts the least-recently-used key once the map
   holds more than `maxKeys` entries (constructor default `maxKeys = 100`).
   `take(key, n)` returns the bucket result for that key.
5. Append a `## Usage` section to `README.md` with one short example using
   `KeyedLimiter`.
