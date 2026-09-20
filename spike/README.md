# mida-spike

Throwaway feasibility spike for "Mida": can one AI coding agent hand a task to
another via compact checkpoints instead of a fresh start? Compares two capture
methods (agent calls an MCP tool vs. a hook compiles the transcript) and two
delivery methods (SessionStart hook inject vs. a fetch tool), plus a baseline.

## Layout

- `server/` — checkpoint schema (`schema.mjs`), JSONL file store (`store.mjs`),
  stdio MCP server `mida-toy` (`mida-toy.mjs`, tools `mida_checkpoint` /
  `mida_handoff`).
- `hooks/` — `capture.mjs` (hook → scrub transcript → cheap extractor model →
  store), `inject.mjs` (prints latest handoff on session start), `scrub.mjs`,
  `extract-prompt.txt`, `lib.mjs` (fail-open helpers).
- `toy-task/` — the task both agents work on: a `TokenBucket` rate limiter,
  stub + step-1 tests + `TASK.md`.
- `harness/run.mjs` — builds a run dir under `results/`, writes the per-variant
  agent configs, spawns agent A then agent B, writes `run.json`.
- `test/` — node:test suite + stub extractors.

## Run

```sh
npm install
npm test

# dry-run a variant (prints the two agent commands, writes configs only)
node harness/run.mjs --capture tool --deliver inject --run 1 --dry-run
node harness/run.mjs --capture none --deliver none --run 1 --dry-run
```

All hooks fail open (exit 0, log to `$MIDA_SPIKE_STORE/errors.jsonl`).
Store files: `checkpoints.jsonl`, `calls.jsonl`, `hook-events.jsonl`,
`errors.jsonl`, `last-capture.json`.
