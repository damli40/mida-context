# Benchmark scenario: Orbital Mission Control (drafted Sep 22)

**What this is.** One task, run twice per condition, that answers one question: *can a second agent act on decisions the user told the first agent,
that never reached the code?* The dashboard is the stage, not the product. The product is the
moment Codex writes `RETURN WINDOW` when every file it can read would say `LOW FUEL`.

**Rules of the experiment (fixed before the first run, never tuned after):**
1. Scoring reads the finished files and the recording, never the agent's self-report — same rule
   as `bench/fixtures/toy-task/score.json`.
2. Record whatever happens, including misses. A 6/8 with two honest misses is a better video and
   a better benchmark than a rehearsed 8/8.
3. Say the sample size out loud whenever a number is quoted.

---

## 1. The task the first agent (Claude Code) is given

Prompt, typed as the very first message (the compiler copies the first request word for word,
by code, so every line below is protected):

> Build an orbital mission-control dashboard: a single-page web app (plain HTML/CSS/JS, no
> framework, no network calls) with an animated map of spacecraft moving between planets and
> stations, and a telemetry panel for the selected spacecraft. Design decisions:
>
> * A spacecraft called **Asteria** is the priority mission.
> * Asteria's destination is **Europa Station**.
> * Mission time is called **MET**, never "elapsed time".
> * Clicking a spacecraft freezes **only its telemetry panel**, not the simulation.
>
> Build the simulation/data layer and a basic interface first. Do not do the final visual
> treatment yet; I will give you more design decisions as we go.

### The four decisions that must exist ONLY in Mida when Claude dies

Given later, one at a time, as ordinary sentences while Claude is working (they are what the
video is about). Each is said as a decision and Claude must **acknowledge** it before the next:

| # | Said to Claude (mid-session) | Why it can't be inferred from the repo |
|---|---|---|
| D5 | "One change: when fuel drops below 18%, the status must read **RETURN WINDOW**, not LOW FUEL." | Any model would write LOW FUEL |
| D6 | "Actually, don't use red for emergencies. Make the spacecraft **pulse** and show an **EMERGENCY** label. Status shouldn't depend on color." | Red is the universal default |
| D7 | "Completed missions should leave a **faint orbital trail** instead of disappearing." | Disappearing is the default |
| D8 | "The final success state says **ORBIT SECURED**." | Arbitrary copy |

Claude implements D1–D4 (they are in the first prompt and will be in the code). D5–D8 are given
*after* the last thing Claude will be allowed to implement. Verify before the kill: `rg -n
"RETURN WINDOW|pulse|trail|ORBIT SECURED" <project>` must return **nothing**. If any leaked into
the code, that decision is scored as "in repo", not "recovered".

## 2. The kill

- Kill only **after a Mida save that contains D5–D8**. Check in a second pane:
  `tail -F $MIDA_HOME/logs/drain.jsonl` — wait for an `"outcome":"saved"` line whose timestamp is
  after the D8 acknowledgement. First save lands ~10 s into a session; later saves coalesce, so
  allow 30–60 s after D8. (For the video this wait is invisible: Claude is still visibly working.)
- Kill the process, don't `/exit`: the point is that no clean shutdown ran.
- Keep the screen showing the unfinished UI.

## 3. The second agent (Codex), fresh

A **new** Codex session in the same project folder. No file pasted, no explanation. Type:

> Continue.

Nothing else until Codex stops. If Codex asks a question, answer only "Continue." once more, and
record that it asked (it counts against "manual explanation").

Second pane, for the camera and for scoring: `mida read --as codex` shows the handoff Codex
actually received. That is the "how did it know" reveal; Codex itself will not print a bullet
list unless asked.

## 4. What is scored (both conditions)

| Metric | How measured | Manual handoff | Mida |
|---|---|---|---|
| Decisions recovered, D5–D8 | finished code/copy: `RETURN WINDOW` string at <18%; pulse animation + text label and NO red fill for emergency; trail element for completed; `ORBIT SECURED` string | /4 | /4 |
| Decisions kept, D1–D4 | Asteria priority; Europa destination; "MET" label, no "elapsed"; click freezes panel only | /4 | /4 |
| Incorrect assumptions | count of D1–D8 done the *default* way (LOW FUEL, red, disappear, other copy) | n | n |
| Unsupported additions | things the second agent did that nobody asked for (counted, not penalised twice) | n | n |
| Context supplied by the user after the kill | characters typed into Codex (screen recording) | n chars | 9 (`Continue.`) |
| Manual explanations | user messages to Codex after the first | n | n |
| Time to first useful action | kill → Codex's first file write (recording timestamps) | mm:ss | mm:ss |
| Task completed | dashboard runs, Asteria reaches Europa, success state shown | yes/no | yes/no |

**Manual handoff condition (the "without Mida" column):** same kill, same fresh Codex, but the
user does what people do today: explains the project, pastes the requirements they remember,
corrects mistakes. Time it. Count the characters. This is the honest cost of being the API
between your AIs; don't shortcut it.

### The headline number: the runs, and how many finished

The first thing the benchmark reports is a count. It is the number to quote, and it replaces
"3 of 3 against 0 of 6".

| Condition | Runs started | Finished | Checks passed, job not finished | Stopped early (and why) |
|---|---|---|---|---|
| With Mida (`Continue.`) | | | | |
| Without Mida, nothing given | | | | |
| Without Mida, manual handoff or transcript pasted | | | | |

Rules for the count:

- **Every run that was started counts.** A run that crashed, was stopped, or hit a usage limit is
  a row in the log with its reason, and it counts as not finished. No run is dropped afterwards.
- **Finished** means the task was completed AND nothing was done the default way: for this
  scenario, "Task completed" is yes and "Incorrect assumptions" is 0. A dashboard that runs but
  says `LOW FUEL` is not finished.
- **"Checks passed, job not finished"** is counted on its own, because it is the failure the
  first measurement found: the agent's own tests were green and it said it was done.
- Decide the number of runs per condition before the first run and write it here: ____. (The
  plan is 15 runs.)
- Quote counts, never only a percentage ("7 of 8 runs finished"), with the task, the models and
  who scored it.

Where the count comes from:

- **The automated benchmark** (`bench/continuation/run.ts`, the toy task, conditions `mida`,
  `none` and `raw`): `pnpm bench:summary` reads every run's `run.json` and prints this table and
  two sentences, "With Mida: N of M runs finished." and "Without Mida: N of M runs finished."
  There, finished means every step was built and every check passed.
- **This scenario's dry runs**: one `docs/evidence/orbital-<date>-<n>.json` per run,
  the failed ones included; fill the table from those files.

**Until the table is filled, the old figure stays, with its sample size said every time:** on a
toy task, 3 runs per setup and one scorer, a fresh Codex with the Mida handoff finished 3 of 3;
without it **0 of 6 completed the requirements; 6 of 6 reported completion**
([method and runs](../evidence/handoff-design-and-benchmark-2026-09-20.md)). When the new count
exists, it replaces that sentence in the README, the quickstart and the pitch.
