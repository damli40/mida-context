# The gas sponsor's daily limit, seen on one real setup (Sep 27 to Oct 2, 2026)

**Question.** Why did saves stop reaching Monad partway through each day, and what did it cost?

**Result.** The hosted sponsor stopped paying one agent after about 60 saves in a UTC day. Refused saves were retried eight times and then dropped. On Oct 1 the sponsor paid for 60 saves by 01:38 UTC and for none after that until its limit was raised that evening; the first save after the change landed at 18:49 UTC, and 51 more followed that day.

| Day (UTC) | Sponsored saves | Last sponsored save | Failed tries, by the label the service gave them | Saves dropped |
|---|---|---|---|---|
| 2026-09-27 | 0 | none | chain-error 118, model-failed 5, no-json 2, chain-busy 7 | gave-up 17 |
| 2026-09-28 | 0 | none | chain-error 21, model-failed 2 | gave-up 5 |
| 2026-09-29 | 60 | 10:26 UTC | chain-error 119, model-failed 13, no-json 7, invalid-checkpoint 1 | gave-up 9, invalid-checkpoint 1 |
| 2026-09-30 | 71 | 14:01 UTC | model-failed 24, no-json 4, chain-error 33, chain-busy 12 | unknown-transcript-format 1, gave-up 6 |
| 2026-10-01 | 111 | 23:55 UTC | model-failed 36, no-json 12, chain-error 253, chain-busy 1 | gave-up 28 |
| 2026-10-02 | 41 | 02:30 UTC | model-failed 4, no-json 2 | none |

**Why.** The sponsor allowed each sender 300 signings a day but only 120 "free calls", and one save makes two of them (a stub-data call and a gas estimate), so the real cap was 60 saves. The free-call limit had never been set on the live service. After a refusal the client tried the agent's own wallet, which is empty; the chain refused the gas estimate; the service logged that as `chain-error` with no detail, which is why the table shows chain errors and not a limit.

**What a save costs the sponsor.** 283 sponsored saves: mean 0.067 MON, median 0.067 MON each (gas limit times the price paid; Monad bills the limit).

**The fix.** The owner set `FREE_PER_SENDER_DAILY_LIMIT=900` on the live sponsor on Oct 1; the sponsor's public limits read 120 before and 900 after. In code (release 0.1.2): a refused save is labelled as a sponsor limit, waits for the 00:00 UTC reset and is never dropped for it; the handoff and `mida doctor` say saves are waiting; the free-call limit follows the signing limit when unset.

**How.** Counted from the service's own log on the owner's machine (`~/.mida/logs/drain.jsonl`): lines with `outcome: "saved"` and `sponsored: true`, `outcome: "failed"` by `reason`, and `outcome: "bad"` (dropped). The service was running commit `cb8294a` (npm 0.1.1).

**Limits.** One owner and, in practice, one busy agent. Sep 30 shows 71 sponsored saves, more than the 60 the mechanism predicts; that difference is not explained. The failed tries on these days are not all sponsor refusals: `model-failed` and `no-json` are summary failures, and some chain errors may be ordinary. The dropped saves were not recovered.

**Raw data.** `sponsor-daily-limit-2026-10-01.json` (one row per day; counts, times and MON only).
