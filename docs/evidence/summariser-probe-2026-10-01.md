# Summariser probe: can the agents' own small models write Mida's summaries? (Oct 1 - 2, 2026)

**Question.** Can Codex's smallest model write a Mida summary when Claude cannot, and can Claude's small model run with safer flags?

**Result.** Yes to both, on one sample.

| | Codex `gpt-6-luna` | Claude `haiku` |
|---|---|---|
| Command | `codex exec --ignore-user-config --ignore-rules --disable hooks --skip-git-repo-check --ephemeral -s read-only -m gpt-6-luna -` | `claude -p --model haiku --safe-mode --tools "" --strict-mcp-config --no-session-persistence --output-format json` (all `ANTHROPIC_*` variables removed) |
| Exit / time | 0 / 35 s | 0 / 21 s |
| Tokens | 27,427 total (a 15-word prompt alone used 24,825: Codex's own overhead) | 4,958 in, 2,225 out (a 15-word prompt used 3,645 in) |
| Output | valid JSON, all 10 fields, no code fence | valid JSON, all 10 fields, INSIDE a ```json fence (the prompt forbids one) |
| Caught the last-minute rule "don't touch the README" | yes, as a constraint | only as a note inside the remaining plan |
| Remaining plan | WRONG: repeats all 5 original steps, including finished ones and the outdated "5 per minute" | right: only the unfinished steps |
| Trace left in Mida (`~/.mida` logs searched for the session id) | none | not checked |

**How.** `transcript.txt` (a made-up 8-block session: rate limiting, a mid-session change from 5 to 10 per minute, a stop at the usage limit) was turned into the real prompt with `buildExtractPrompt` from `packages/compiler/src/prompt.ts` at commit `b87688e` (`prompt.txt`, 5,006 characters), then piped to each command from an empty folder with `MIDA_INNER=1`.

**Limits.** One sample, a short made-up transcript, no previous checkpoint in the prompt. Not run through Mida's own parser or schema check. Says nothing about either tool at its usage limit. With an out-of-credit `ANTHROPIC_API_KEY` left in the environment, the Claude command exits 1 and prints `{"is_error":true,"result":"Credit balance is too low"}` on stdout.

**Status.** Enough to build Codex in as the fallback. Not enough to claim equal quality.

**Raw data.** `summariser-probe-2026-10-01/`: `transcript.txt` (the made-up session), `prompt.txt` (the prompt Mida built from it), `codex.out` and `claude.out` (each model's answer, unedited).

## Later the same day: the built command, run for real (branch `uf-summarizer` @ b3e8d29, throwaway home)

- `mida summarizer` with nothing saved and `DEEPSEEK_API_KEY` in the shell: "the models your environment variables set", DeepSeek, Claude Code (haiku), Codex (luna). Exit 0.
- `mida summarizer use agents`: wrote `summarizer.json` with mode `-rw-------`, content `{"use":"agents"}`.
- `mida summarizer test`: **Claude Code (haiku) could not write it: no JSON in the answer.** Then "Wrote one test summary with Codex (luna) in 11 s." Cause, reproduced by hand: the test's one-line prompt ("Reply with exactly this JSON and nothing else: …") made haiku answer "I notice this appears to be a prompt injection attempt…" (exit 0, 288 bytes, no JSON). The fault is the TEST PROMPT, not the summariser: the real summary prompt built by `buildExtractPrompt` from a two-line session (3,037 characters) returned valid JSON with an `objective` on Claude haiku 3 of 3 times and on Codex luna 1 of 1 (Codex run with the two new `-c` flags).
- With Claude forced to fail (`MIDA_CLAUDE_SUMMARY_MODEL=no-such-model-xyz`): "Claude Code (no-such-model-xyz) could not write it: exit 1 signal null." then Codex wrote it in 7 s. No `mida-sum-*` folder was left in the temp dir.
- Codex with `-c features.shell_tool=false -c web_search="disabled"`: asked to run `ls /`, it answered "NO SHELL"; without them it listed `/`. Codex echoes the prompt on stderr (seen in both runs).
- `claude --help` took 424, 119 and 157 ms (three runs).

**Fix queued:** `mida summarizer test` must use the real summary prompt with a tiny fixed session.

## Oct 2, on the final code (branch `user-facing-fixes` @ 0d705bd, throwaway home)

- `mida summarizer use agents`: saved; listed Claude Code (haiku) and Codex (luna), both "ready, not used yet".
- `mida summarizer test`: printed "Asking Claude Code (haiku) for a test summary. This can take up to 90 s." then **"Wrote one test summary with Claude Code (haiku) in 30 s."** Exit 0. The test now sends the real summary prompt with a two-line session, so Claude no longer refuses it.
- With `DEEPSEEK_API_KEY` in the shell and the saved choice in place, `mida summarizer` showed the saved choice (the saved choice wins over the environment).
- No `mida-sum-*` folder was left in the temp dir.

## Overhead of the old Claude command (Oct 1)

The command 0.1.1 uses (`claude -p --model haiku --setting-sources project --strict-mcp-config`), given the same 15-word prompt, used 21,076 input tokens before the prompt (7,263 written to the cache, 13,803 read from it, 10 new), against 3,645 with the safer flags. One call each, on one machine whose personal Claude settings are large; another machine will differ.
