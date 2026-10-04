# Tool output labelled as the user, before and after the PROV-19 fix (Oct 4, 2026)

**Question.** A session reading Mida's handoff for the owner's task found a hook's refusal ("Before the first Bash command this session, present these facts…") among the standing constraints. In the session's transcript that text sits only in tool results, never in anything the owner typed. Did Mida show tool output to the summary model as the owner's words, and does the fix change what the model saves?

**Result.** The reader did label tool output as the user's. The fix changes the label. On the model's output this test shows no improvement, and the original mix-up was not reproduced.

| Build | How the summary model sees the hook's refusal | Hook rule saved as a constraint (DeepSeek) | (Claude Haiku) |
|---|---|---|---|
| before (`4235cc9`) | under `user:` | 0 of 3 | 0 of 3 |
| after (`e29657f` + `026f381`) | under `tool result:` | 1 of 3 | 0 of 3 |

The one hit after the fix is a plain constraint, "Fact-Forcing Gate: before creating a new file, present the required facts…", whose evidence points at the line labelled `tool result`. Mida's handoff never claims a constraint is the owner's: only facts saved with `mida remember` are marked "stated by you". So the earlier reading, "Mida recorded it as a standing rule from you", overstated what the handoff says. What the handoff does lack is where each constraint came from, so a hook's rule and an owner's rule look the same.

**Why it happened.** Claude Code saves a tool's result as a record of type `user`. Mida's reader labelled every record by that type, so a tool result reached the model as `L<n> user:` followed by `[result] …`.

**The fix.** Commit `e29657f`: a record that holds only tool results is labelled `tool result`, a record that mixes typed text and results is shown as two blocks, and the summary prompt says lines labelled `tool result` are output from tools and hooks, never the user's words. The Codex and Devin readers already labelled tool output correctly.

**How.** One script read a copy of the owner's real Claude Code session cut at 03:30 UTC on Oct 4, two lines after the latest of its 204 hook refusals, so the refusal sits in the part of the session the reader shows in full. For each build it recorded the label in front of the refusal, then ran the full summary step three times with DeepSeek and three times with Claude Haiku. "Saved as a constraint" means a constraint or decision names the gate or its rule.

**Limits.**
- One session, three runs per cell. The before column shows the mix-up did not happen on this cut, so the test cannot show the fix preventing it.
- The constraint that started this was saved earlier in the task and is kept by the merge, which never drops a constraint. The fix does not remove it from saves already made.
- Whether a hook's rule should be saved as a constraint at all is open: it is a real rule of that machine, but the next agent cannot tell it from one the owner set.

**Commits.** The hashes above are on Mida's development branches. The fix ships in release 0.1.3.

**Raw data.** [`prov19-tool-output-label-2026-10-04.json`](prov19-tool-output-label-2026-10-04.json): labels, booleans and timings only. No session text beyond the one constraint quoted above.
