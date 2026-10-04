# A change the owner typed while Claude Code was working, before and after the PROV-17 fix (Oct 3, 2026)

**Question.** During the Oct 3 demo rehearsal the owner typed a change of concept while Claude Code was busy, and the handoff Codex received kept the old objective and called the change "the assistant's own latest plan". Does the fix make the summary carry the change as the owner's?

**Result.** Before the fix, the summary model never saw the owner's message. After it, the message reaches the model as the owner's words, and every run credited the change to the owner.

| Build | Summary model | Owner's message shown to the model | Objective includes the change | Change credited to the owner |
|---|---|---|---|---|
| before (`c2fa977`) | DeepSeek (`deepseek-flash`) | no | 0 of 3 | 0 of 3 |
| after (`b24b7de`) | DeepSeek (`deepseek-flash`) | yes, as a `user` block | 3 of 3 | 3 of 3 |
| before (`c2fa977`) | Claude Haiku | no | 0 of 3 | 0 of 3 |
| after (`b24b7de`) | Claude Haiku | yes, as a `user` block | 3 of 3 | 3 of 3 |

One decision from each side, DeepSeek run 1:

- Before: "Proposed adding an `author` field … because: Assistant's plan to distinguish memories by author; not yet approved or implemented."
- After: "Add an `author` field … because: The user asked the world to show provenance of which agent wrote each memory."

The same check on the build that also adds the work trail (`4f4e3d6`, register CAP-41), which shows the summary model one short line per assistant step from the part of a long session it cannot read: 3 of 3 runs per model still put the change in the objective and credit it to the owner. The text sent to the model grew from 1,809 to 2,757 characters. On this session the trail added detail rather than new facts: the assistant's last message already listed the four files it had written, so runs without the trail recorded them too. With the trail, runs also recorded the CSS fix, the JSON check and the "static site, no install step" decision. A session whose last message does not recap the work was not tested.

On the rehearsal build (`56322c5` on branch `rehearsal-013`: the approve fixes up to `2337c2a` plus every reader fix above, including the review fixes to the trail), 6 of 6 runs put the change in the objective and none credits it to the assistant. DeepSeek gave the user's request as the reason in 3 of 3. Haiku did in 2 of 3. Its run 2 names no one in its reasons and writes "Obtained user approval for provenance concept" in its progress list, which is wrong (the owner proposed the change and had not said go). The same summary's next action correctly says to wait for the user's go.

Two of the three Haiku runs before the fix also reported the change as already built ("Added author field to each memory") when no file had changed.

**Why it happened.** Claude Code does not save a message typed mid-turn as an ordinary user message. It saves it as a different record type (an `attachment` of type `queued_command`). Mida's reader only read ordinary user messages, so the owner's words never reached the summary. All the model saw was the assistant repeating the idea back as "Plan: I'll …", and it credited the idea to the assistant.

**The fix.** Commits `b24b7de` and `fb82e34` (review fixes) on branch `uf-prov17`: a message the user typed mid-turn now counts everywhere an ordinary typed message counts (the conversation shown to the model, the list of later messages the user typed, the first-request pick). Records saved the same way that are not the user's (a subagent's report, a background task's notice, a coordinator message) are never counted as the user's. The same message saved twice appears once. Register row PROV-17.

**How.** One script read the rehearsal's real Claude Code session (1,257,310 bytes) with each build. For each build it checked whether the owner's message appears in the text sent to the summary model and under which label. It then ran the full summary step three times per build and model, on the owner's machine, with the same model setup the demo uses for DeepSeek and the default for Haiku. "Objective includes the change" means the objective mentions provenance or which agent wrote a memory. "Credited to the owner" means at least one decision gives the user's request as its reason. Claude scored that by reading each run; "awaiting the user's go" does not count.

**Limits.**

- One session and three runs per cell. This shows the fix works on the case that failed; it is not a rate.
- Codex was not re-run end to end. The check stops at the summary Codex would have received.
- Codex itself records mid-turn input as ordinary user messages, so it has no matching gap (checked in code, not on a live session).
- The session took the reader's short path for long sessions: of 1.26 MB, about 1,800 characters reached the model, namely the first request, the messages the user typed, and the assistant's last messages. On the first fixed build (`b24b7de`), everything the assistant did in between was not shown. The work trail (register CAP-41, also in 0.1.3) adds one short line per assistant step from that part; its effect on this session is in the paragraph on `4f4e3d6` above.
- The review's open questions were settled from the owner's own sessions (276 messages typed mid-turn, 43 sessions), not from a broader sample: none carried a flag that could hide it, no two shared an id, none started with `/`, and Claude Code never also saved one as an ordinary user message. So a rule that dropped such a second copy was removed in review (`fb82e34`); it never fired on real data and made long and short sessions disagree.

**Commits.** The hashes above are on Mida's development branches. Every fix measured here ships in release 0.1.3.

**Raw data.** [`prov17-queued-message-2026-10-03.json`](prov17-queued-message-2026-10-03.json): one row per run, booleans, character counts and timings only. No session text.
