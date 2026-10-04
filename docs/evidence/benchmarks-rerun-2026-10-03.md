# Both benchmarks re-run on the Oct 3 build, Mida condition (Oct 3, 2026)

**Question.** The Oct 3 fixes change what the summary model reads: a message the owner types while Claude Code is working now counts as the owner's, and a long session now gives the model a short trail of the assistant's steps. Do the two Oct 2 results with Mida still hold on that build?

**Result.** Yes, both.

| Benchmark | Oct 2 (with Mida) | Oct 3 build (with Mida) |
|---|---|---|
| Test 1: Claude Code is stopped after step 1, Codex hears "Continue." ([Oct 2 file](continuation-benchmark-2026-10-02.md)) | 5 of 5 finished, rules kept 5 of 5 | **5 of 5 finished, rules kept 5 of 5** |
| Test 2: a decision is changed in another session after Codex started ([Oct 2 file](late-change-benchmark-2026-10-02.md)) | 5 of 5 applied the change | **5 of 5 applied the change** |

In Test 2 every run exports `KeyedRateLimiter`, no file in the source, tests or README mentions `KeyedLimiter`, and the project's tests pass (7 to 10 tests per run, 0 failures). The middle session changed no file in any run. Codex took 128 to 142 seconds per run in Test 1.

**Build measured.** Commit `56322c5` on branch `rehearsal-013`: the approve fixes up to `2337c2a` plus the 14 reader commits of Oct 3 (PROV-17, PROV-18, CAP-41 and their review fixes). The approve fixes committed after it change only what approve does when a step fails; neither benchmark takes that path. This is the build the owner's machine ran from Oct 3, 15:45 UTC. The commits named here are on Mida's development branches; all of them ship in release 0.1.3.

**How.** The same runner and settings as Oct 2 (`bench/continuation/run.ts`, `--stop-at tryTake`, `--late-change` for Test 2, real Claude Code and Codex, a local chain, a throwaway Mida home per run), driven by one script that stops if an agent fails to run. Test 1 was scored by the runner's own summary (`bench/continuation/summary.ts`). Test 2 by the Oct 2 rule: the new name exported, the old name gone from source, tests and README, the tests passing.

**Limits.**

- Only the Mida condition was re-run. The two conditions without Mida run no Mida code, so the build cannot change them; their Oct 2 results stand as measured.
- Five runs per test on one machine. This checks that the Oct 2 numbers survive the new build; it is not a new rate.
- Test 2 was scored by pattern and a search for the old name, with no second scorer.

**Raw data.** [`benchmarks-rerun-2026-10-03.json`](benchmarks-rerun-2026-10-03.json): one row per run, timings and checks only.
