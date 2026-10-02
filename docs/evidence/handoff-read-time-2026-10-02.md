# Handoff read time as saves pile up, on one real setup (Sep 21 to Oct 2, 2026)

**Question.** How long does a new agent session wait for its handoff as the number of saved checkpoints grows, and how often is the read refused for being too slow?

**Result.** Read time rose from 3.4 s at 26 checkpoints to 6.6 s at 334, against a limit of 7.5 s. Of 196 handoff reads that got as far as reading, 44 were refused as too slow (`read-slow`): the new session then starts with "Mida: could not load context".

| Day (UTC) | Handoffs served | Refused, too slow | Median read time of the served ones | Largest checkpoint count read that day |
|---|---|---|---|---|
| 2026-09-21 | 5 | 0 | 3.5 s | 3 |
| 2026-09-22 | 1 | 1 | 5.9 s | 1 |
| 2026-09-23 | 0 | 13 | none served | 0 |
| 2026-09-24 | 4 | 0 | 3.4 s | 26 |
| 2026-09-25 | 29 | 0 | 4.2 s | 79 |
| 2026-09-26 | 0 | 0 | none served | 0 |
| 2026-09-27 | 19 | 3 | 6.8 s | 83 |
| 2026-09-29 | 16 | 13 | 6.0 s | 155 |
| 2026-09-30 | 15 | 5 | 5.7 s | 214 |
| 2026-10-01 | 46 | 8 | 6.2 s | 294 |
| 2026-10-02 | 17 | 1 | 6.6 s | 334 |

**A second measurement, with this round's fix.** On Oct 1, on the same data (298 stored objects) and commit `caecfdb`, which keeps opened read keys in memory: the first read after the service starts took 6.3 s, the next two 3.3 s and 2.8 s. About 2 s of every read had been two key fetches for keys that never change.

**How.** The table is counted from the service's own log on the owner's machine (`~/.mida/logs/daemon.jsonl`, records with `event: "handoff"`): `readMs`, `checkpoints` and the refusal `reason`. The service was running commit `cb8294a` (npm 0.1.1) against the hosted store and the public Monad testnet endpoint. "Refused for other reasons" (not a Mida project, revoked, and so on) is in the JSON file and left out of the table.

**Limits.** One machine, one owner, one network connection; the days differ in how much was running at once. The checkpoint count is the largest a single read reported that day, not a controlled variable. The second measurement is three reads, not a distribution. Nothing here measures the fix on a live service over days: the running service did not have it.

**What it means for a new user.** A new install is fast. An estimate, drawn through two points and not measured: with the fix, the first read after a service start crosses the limit at roughly 400 saved checkpoints, later reads at roughly 600 to 700.

**Status.** Accepted limit (register row CHAIN-04). The planned fix, an index so a read lists one project and not every project, is not built.

**Raw data.** `handoff-read-time-2026-10-02.json` (one row per day; counts and milliseconds only).
