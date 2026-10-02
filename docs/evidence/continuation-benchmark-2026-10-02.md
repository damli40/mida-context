# The continuation benchmark: 15 runs (Oct 2, 2026)

**Question.** One agent starts a job and is cut off. A fresh agent in the same folder is told one word, "Continue." Does it finish the job, and does it matter what it was handed?

**Result.**

| What the second agent was handed | Runs | Finished | Tests passed, job not finished |
|---|---|---|---|
| A Mida handoff | 5 | **5** | 0 |
| Nothing | 5 | **0** | 5 |
| The first session's whole transcript, pasted as readable text | 5 | **5** | 0 |

- **With nothing, the second agent never finished and never knew it.** In all five runs its tests passed and it reported the work complete or carried on with small additions. Steps 2 to 5 of the task were never built, because nothing on disk said they existed.
- **With a Mida handoff it finished all five.** The handoffs were 3,943 to 4,478 characters.
- **With the transcript pasted it also finished all five.** The first agent had run for 8 to 86 seconds, so its whole session was 3,105 to 3,647 characters and fit in the paste. For a session this short, pasting works as well as Mida.
- **The second agent used more tokens with Mida than with the paste**: a median of 29,470 against 17,016 (nothing given: 18,325). The cause was not investigated.
- Seconds for the second agent, median: 151 with Mida, 129 with the paste, 59 with nothing.

**Scored twice.** An automatic scorer read the finished files of each run. Then a second scorer read and ran all fifteen finished folders without knowing which condition each came from (the folders were shuffled and renamed). The two agree on all 15: the ten finished runs are complete and correct, and the five others are missing steps 2 to 5. The second scorer checked what the automatic one cannot: that each limiter keeps one bucket per key, caps the number of keys and evicts the least recently used one (16,000 calls per folder against a reference, 0 mismatches), that time comes only from the injected clock, and that each README's example runs and prints what it says.

**How.**
- **The task** is the one from the first measurement on Sep 20: a small rate-limiter library built in five ordered steps under four constraints ([`bench/fixtures/continuation-task/TASK.md`](../../bench/fixtures/continuation-task/TASK.md)). The second agent never sees the task file.
- **The first agent** is Claude Code 2.1.287 on Sonnet. It is stopped as soon as step 1 is written, so steps 2 to 5 are left. In all fifteen runs it was stopped with those steps unbuilt.
- **The second agent** is Codex 0.159.2 (model `gpt-6.1-sol`), started fresh in the same folder with the single word "Continue."
- **The three conditions differ only in what the second agent receives when its session starts**: Mida's handoff from the real 0.1.2 service (commit `22d79d99`) running on a local chain; nothing; or the readable text of the first agent's session, up to 8,000 characters.
- **Finished** means a keyed limiter is exported from the library, the README has a usage section, and the project's tests pass.
- **Isolation.** The agents work in a temporary folder outside the repository, so the second agent cannot read the task file, the first agent's output or any other run. In all fifteen runs its output mentions none of them.
- **Order.** The runs were interleaved (Mida, nothing, paste, five times) on one afternoon.
- Runner: [`bench/continuation/run.ts`](../../bench/continuation/run.ts); count: `pnpm bench:summary`.

**Limits.**
- Five runs per condition, one task, one direction (Claude Code to Codex), one machine, one day.
- **The session was short.** A transcript that fits in a paste is the easy case. This benchmark says nothing about a long session, where the transcript no longer fits and a paste means choosing what to leave out. That is the case Mida is built for, and it is not measured here.
- Pasting a transcript is something a person has to do by hand, in every tool, every time. The benchmark gives that step to the paste condition for free.
- The summary in the Mida condition was written by Claude's small model called directly by the benchmark, not through Mida's saved choice of summary model with its fallback to Codex.
- The first agent's stop point varies from run to run (8 to 86 seconds), and in the Mida condition it runs with Mida's hooks attached.
- "Rules kept" (no timers) was 5 of 5 in every condition, including the runs that built nothing new, so it does not separate the conditions.
- The second scorer found one rounding weakness shared, in rare cases, by all ten finished libraries (waiting exactly the advised time can leave a bucket a hair short). It was not counted against any run.
- The task is the one Mida's handoff was designed against in September.

**Pilot runs, not counted.** Five earlier runs and two refused starts are kept beside the counted ones and named here so nothing is hidden:
- 1 run on the wrong task: the benchmark pointed at a different task file, so the first agent was never stopped and the scorer crashed.
- 1 run with the first agent stopped at step 3, the September stop point: by then it had already built step 4, leaving only the README.
- 3 runs with the first agent stopped after step 1 but the work folder inside the repository. In one, the second agent searched the first agent's output file for the task. In the paste run, the pasted text was the tail of the raw session file, which is mostly encoded data, not conversation. Results of those three: Mida finished; nothing did not; the unreadable paste did not.
- 2 starts refused by the runner before any agent ran (a mistake in the loop script).

Each of these led to a repair of the benchmark before the counted runs began. All fifteen counted runs used one version of the runner, the one in this repository.

**Status.** Shown at the planned size for the first time. It replaces the Sep 20 figure ("3 of 3 with Mida, 0 of 6 without").

**Raw data.** [`continuation-benchmark-2026-10-02.json`](continuation-benchmark-2026-10-02.json): one row per run with what was built at the stop and at the end, seconds, tokens, handoff or paste size, and the second scorer's fourteen checks.
