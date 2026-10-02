# Evidence

Each file here is one measurement or one live run: what was asked, the result, how it was done, what it does
not show, and the raw data beside it. A number quoted in the README or anywhere else should point at one of these.

## Oct 1 to 2, 2026 (the fix round before 0.1.2)

| File | What it shows | Sample |
|---|---|---|
| [`handoff-read-time-2026-10-02.md`](handoff-read-time-2026-10-02.md) | How long a new session waits for its handoff as saves pile up, and how often the read is refused as too slow | 196 reads on one setup, Sep 21 to Oct 2 |
| [`sponsor-daily-limit-2026-10-01.md`](sponsor-daily-limit-2026-10-01.md) | The gas sponsor stopped paying after about 60 saves a day; what was lost; what a save costs | One setup, 6 days; cost from 283 sponsored saves |
| [`session-start-read-2026-10-01/`](session-start-read-2026-10-01/01-session-start-read-busy-project.md) | One session-start read timed step by step, and what 26 real session starts got | 5 timed reads; 26 starts, one owner |
| [`linux-first-run-2026-10-02.md`](linux-first-run-2026-10-02.md) | Whether the published package installs, sets up, saves, hands off and revokes on a clean Linux machine | One run on Ubuntu 24.04, no agent on the machine |
| [`quickstart-fresh-install-2026-10-02.md`](quickstart-fresh-install-2026-10-02.md) | Whether a new user can follow the README from install to a second agent that continues, how long it takes, and what the README got wrong | One run in a throwaway home, 0.1.2 from npm |
| [`summariser-probe-2026-10-01.md`](summariser-probe-2026-10-01.md) | Whether Claude Code's and Codex's small models can write Mida's summaries, and what each call costs | One sample session, run for real on both tools |

Raw data sits next to each file: a `.json` of the same name, or a folder of the same name.

## Earlier files

The files dated Sep 17 to Sep 29 are not indexed here yet. The public README links the ones it quotes;
[`live-tests-2026-09-27-to-29.md`](live-tests-2026-09-27-to-29.md) lists the live runs and
[`handoff-design-and-benchmark-2026-09-20.md`](handoff-design-and-benchmark-2026-09-20.md) holds the first
`Continue.` measurement (3 runs with Mida, 6 without).
