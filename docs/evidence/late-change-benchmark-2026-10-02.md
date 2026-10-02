# The late-change benchmark: 15 runs (Oct 2, 2026)

**Question.** An agent is already working. In a different agent's session, the owner changes one decision. Nothing on disk records the change. Does the working agent learn of it?

This is the case a pasted transcript cannot cover: the information does not exist yet when the paste is made.

**Result.**

| What the second agent had | Runs | Applied the late change |
|---|---|---|
| Mida | 5 | **5** |
| Nothing | 5 | **0** |
| The first session's transcript, pasted when it started | 5 | **0** |

- **With Mida, the second agent applied the change in all five runs.** It renamed the class in the source, the tests and the README; no mention of the old name was left anywhere, and the tests pass.
- **Without Mida it never learned of the change.** With nothing, it reported no unfinished work. With the transcript pasted at its start, it had built the limiter under the old name and reported the job complete.
- In all fifteen runs the session that received the change touched no file, so the new name existed only in that session and, in the Mida condition, in Mida's store.

**Read this result for what it is.** The two conditions without Mida have no channel for the change, so they cannot succeed; they were run to confirm that the agent does not guess, and it did not. What the benchmark measures is whether Mida's channel delivers: a decision made in one agent's session reached another agent's running session in 5 of 5 runs.

**How.**
- **The task** and the first two phases are those of the [continuation benchmark](continuation-benchmark-2026-10-02.md): Claude Code (2.1.287, Sonnet) starts the five-step rate-limiter task and is stopped after step 1; a fresh Codex (0.159.2, `gpt-6.1-sol`) in the same folder is told "Continue." and does its first turn.
- **The late change.** A second Claude Code session is then opened in the same folder and told: "The owner changed one decision for this project: the keyed limiter class must be named KeyedRateLimiter, not KeyedLimiter, everywhere (source, tests and README). Reply with one sentence confirming you have noted it." It runs with read-only tools, so it cannot edit. The benchmark compares the folder before and after it: no file changed in any run.
- **The second turn.** Codex's own session is resumed and told "Continue." again.
- **In the Mida condition** the real 0.1.2 service (commit `22d79d99`) runs on a local chain with the same session-start and per-prompt hooks a normal install sets up. It saves the second Claude session like any other, and Codex's resumed session gets a rebuilt handoff (3,549 to 3,725 characters, from three checkpoints).
- **Applied** means: `KeyedRateLimiter` is exported from the library, `KeyedLimiter` is no longer exported, and the project's tests pass. The five Mida runs were also checked by hand for any leftover mention of the old name: none.
- **Isolation** as in the first benchmark: the agents work in a temporary folder outside the repository. In all fifteen runs the second agent's output mentions none of the benchmark's own files.
- Runner: `bench/continuation/run.ts --late-change`; count: `node --import tsx bench/continuation/summary.ts --runs-root bench/continuation/runs-late-change`.

**Limits.**
- **The comparison is one-sided by design**, as said above. A person could carry the change across by hand; the benchmark gives the conditions without Mida no such person.
- **Which channel delivered.** Mida has two ways to bring news to a running agent: the handoff it rebuilds when a session is resumed, and a short note on every prompt. Here the change arrived through the rebuilt handoff in all five runs; the per-prompt note reported nothing new each time, because the handoff had just covered it. The per-prompt note on its own was not tested. It carries another session's latest progress, next action and new files, not its list of decisions.
- **The wording of the change mattered.** In a pilot round the prompt to the second Claude session also said "Do not open, create or change any file in this session". Mida carried that sentence to Codex as a standing rule. Codex learned the new name and then asked whether it was allowed to edit, and changed nothing. An instruction meant for one session can reach the next agent as a rule. The counted runs use a prompt that states only the decision.
- Five runs per condition, one task, one kind of change (a rename), one direction (Claude Code to Codex), one machine, one afternoon.
- The summaries were written by Claude's small model called directly by the benchmark, not through Mida's saved choice of summary model.
- Scored by pattern (the export and the tests), plus a search of the five Mida runs for the old name. No second blind scorer for this benchmark.

**Pilot runs, not counted.** Three runs (one per condition) with the earlier prompt wording described above. With Mida the change arrived and was not applied; without Mida it did not arrive.

**Status.** Shown once at 5 runs per condition.

**Raw data.** [`late-change-benchmark-2026-10-02.json`](late-change-benchmark-2026-10-02.json): one row per run with the timings of all four agent turns, whether the middle session changed a file, what was exported at the end, the tests, and, for the Mida runs, the handoffs and per-prompt notes served to the second agent.
