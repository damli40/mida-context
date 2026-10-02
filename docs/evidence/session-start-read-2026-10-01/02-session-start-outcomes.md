# 02. What real session starts got

**What it measures.** For every Claude Code session start in the log of one owner's Mida service:
did the session get its memory?

**Result (log up to Oct 1 2026).** 139 logged starts, in time order. Mida answered 17 with "not
approved" or "not a Mida project"; they are left out (Limits covers ten of them). The other 122
began a read.

The log covers two versions of the read. On Sep 29 a fix made the read check checkpoints on Monad in
batched calls ([the Sep 29 evidence](../live-tests-2026-09-27-to-29.md#sep-29-the-session-start-read-in-a-busy-project)).
The table splits the 122 starts at that fix.

| Outcome | After the fix | Before the fix | Whole log |
|---|---|---|---|
| Starts that began a read | 26 | 96 | 122 |
| Full memory loaded | 17 (65%) | 41 (43%) | 58 (48%) |
| Part of the memory loaded | 3 (12%) | 13 (14%) | 16 (13%) |
| Nothing saved for this task yet | 3 (12%) | 3 (3%) | 6 (5%) |
| Read failed | 0 | 9 (9%) | 9 (7%) |
| Timed out at 7.5 s: started with no memory | 3 (12%) | 30 (31%) | 33 (27%) |
| Median time, every start counted | 6.6 s | 7.2 s | 6.9 s |

After the fix, a full load took 5.0 to 7.1 s (median 6.2 s) with 8 to 238 checkpoints in the
project. The three partial loads had 155, 162 and 189 and took 7.6 to 8.1 s.

**What it decides.** After the fix, 6 of 26 starts did not get their full memory: 3 got part of it
and 3 got none. A timed read of the owner's largest project has a median of 6.1 s (file 01), so a
live start has little room for a slow moment on the machine or the chain connection. Report the
timed-out share and a median over every start. A median over the reads that finished (6.2 s) hides
the starts that got nothing.

**How it was measured.** A script read the service's log lines for session starts: a duration, an
outcome code and a checkpoint count per line, no content. The script is on a development branch and
not in this repository yet. The raw file is here, and
[`charts/tools/recount.py`](charts/tools/recount.py) recomputes every number in this file from it.

**How the split was made.** The raw file keeps no dates. Row 112 is a complete read of 155
checkpoints with a read time of 5.1 s, which the Sep 29 evidence names as the first read after the
fix. No other row matches it. The seven rows before it are the seven timeouts in a row that
evidence describes. `recount.py` checks both facts before it counts.

**Limits.**
- One owner, one machine, every project mixed together.
- 26 starts is a small sample. One timeout more or fewer moves its share by 4 points.
- The log does not say why a load was partial. "Partial" means the store left some checkpoints
  unchecked against Monad when its chain-read budget for the request ran out, or the table of
  batched saves could not be read. All 16 partial starts took 7.6 to 8.4 s in total, close to the
  7.5 s limit.
- "Before the fix" spans more than one earlier build, and it includes a run of 9 failed reads. It
  is history across several builds.
- Before the fix, 5 of the 41 full loads read 83 to 87 checkpoints from a project that showed 155
  at the first read after the fix. The old build may have missed some cut-short reads, so the
  before-fix full count may be high.
- Ten of the 17 starts left out were answered "not approved" only after 1.9 to 4.5 s of work, all
  before the fix. The other seven were refused within 4 ms. The chain client's own notes say a
  rate-limited chain can answer "not approved" for an approved agent. If those ten were real starts
  that failed, the before-fix group is 106 starts.
- The log records a checkpoint count only for a read that loaded something, so the timeouts cannot
  be split by project size.
- The count is the project's. The read opens every checkpoint the owner has saved in every project
  and then keeps the project's. One start in a project with 8 checkpoints took 6.9 s.
- "Nothing saved for this task yet" means the read finished and found no checkpoint for the
  session's task in this project. The project may hold checkpoints for other tasks, or none; the
  log does not record which. The three after the fix each ran a read of 5.3 to 6.0 s.

**Status.** Reviewed Oct 2 2026: every number recomputed from the raw file by a second reader.

**Files.** Raw: [`02-session-start-outcomes.json`](02-session-start-outcomes.json) (`runs` holds
the 139 starts in log order; the summary fields beside it cover only the 58 full loads). Chart:
[`charts/02-session-start-outcomes-light.svg`](charts/02-session-start-outcomes-light.svg) (dark:
`-dark.svg`, editable: `.excalidraw`).
