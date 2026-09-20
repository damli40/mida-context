# Task: TokenBucket rate limiter

Implement a small dependency-free rate-limiter library in `src/bucket.mjs`.
Work through the steps **in order**, and keep `npm test` green after each step.

## Constraints

- No dependencies.
- No timers (`setTimeout`, `setInterval`, etc.) inside the library.
- All time comes from the injected clock (a `now()` function; the default may be `Date.now`).
- The public API is synchronous.
- Tests must pass after every step.

## Steps

1. `TokenBucket(capacity, refillPerSec)` with `tryTake(n) -> boolean`.
   Starts full. `tryTake(n)` consumes `n` tokens and returns `true` if enough are
   available, otherwise consumes nothing and returns `false`. Non-positive `n`
   returns `false`.
2. Injectable clock: `new TokenBucket(capacity, refillPerSec, now)` where `now`
   is a function returning milliseconds (defaults provided internally so tests
   never sleep).
3. `msUntilAvailable(n)` — milliseconds until `n` tokens can be taken
   (`0` if already available).
4. `KeyedLimiter` — holds one `TokenBucket` per key, capped at a maximum number
   of keys; when the cap is hit, evict the least-recently-used key.
5. Add a usage section to `README.md`.

## Design fork — decide and justify

For refill, choose between **lazy refill computed on each call** and a
**background interval**. Record which you chose and why. (Hint: one of the
constraints above makes one choice wrong. That is deliberate — say so.)
