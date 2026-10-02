# Live tests on Monad testnet, Sep 27 to Sep 29, 2026

What ran for real, on real agents and the live testnet contracts, and what each run proved. Anything
that only ran in automated tests is not listed here.

**Contracts (chain 10143):** CapabilityRegistry `0xADFbeBC7A653E4287ae30c87D32D7aD647D7039b`,
ContextRegistry `0x75fB6dB9af93A8d823e51c488CaA913ca711FB78`, BatchAnchor
`0xe5dcf76B1109906A16587cD2FE02c1e6f4a7a9E1`. Hosted store `store.midacontext.xyz`, gas sponsor
`sponsor.midacontext.xyz`.

## Sep 27: the handoff loop across real agents

Build `0586957`, a fresh project folder, both agents approved in the owner's terminal.

| Run | What happened | Result |
|---|---|---|
| Claude Code to Codex | Claude Code worked on a small task with one rule, then quit. A fresh Codex typed "Continue." | ✅ The handoff was 44 s old and named claude-code as author. Codex kept the rule and caught a slip the first agent had made against it. |
| Codex to Claude Code | Codex did one more step and quit. A fresh Claude Code typed "Continue." | ✅ The handoff named codex and showed its step as the newest. |
| Devin | Devin continued the same project through its own hooks. | ✅ It received the handoff, and its answer disclosed a save that was still queued. |
| Revoke | The owner ran `mida revoke devin`. Devin started a new session. | ✅ Mida shared nothing and said the owner had revoked the agent. |
| Claude Desktop | Claude Desktop, through the MCP server, called `mida_handoff` and then `mida_save`. | ✅ Both worked; the saved checkpoint read back through `mida read`. |
| Hosted setup | A new setup on the hosted store and gas sponsor, from `mida init` to a handoff. | ✅ The sponsor paid for every transaction. |
| The Codex app | The Codex tab of the ChatGPT desktop app, working in a local folder. | ✅ Its Mida hooks ran, including saves. |

A plain ChatGPT chat is not supported: it cannot run local hooks or a local MCP server.

## Sep 28: a change of plan mid-session reaches the next agent

The defect: when you changed the plan in the middle of a long session, the next agent's checkpoint
kept the old goal and credited the change to the agent. The session reader only saw the start and the
end of a long session file.

The check: a synthetic session larger than the reader's windows, with the change of plan in the
middle, compiled by the default model (DeepSeek). Two conditions put the change out of the old
reader's view, three runs each:

| | Goal updated to the change | Change credited to the user |
|---|---|---|
| Before the fix | 0 of 6 | 1 of 6 |
| After the fix (build `73e6d26` and later) | 6 of 6 | 6 of 6 |

A third condition, where a save happened while the change was still in view, scored 3 of 3 before
and after.

## Sep 29: batching, live

Build `5f795b3`, the demo owner `0x0ba02302f4fa477821f89a5e16f9a23565168715` on the hosted setup, batching
turned on with `mida batching on`.

| Save | Anchored in | Block |
|---|---|---|
| `0x606d6eba…6f6936` | `0x1191bd1f93562597a0432bdbb664480e481b9cb1190fe02980751e701bebae92` | 66,580,489 |
| A Claude Code session save | `0x308ba853eaace7e19c5a7b4da41ad5003a4cfb77e899e4c3088f78675ce90935` | 66,581,167 |
| A Claude Code session save | `0x91fc0eb3d4115650e3d8b4cd65805dff0391e0370f630228e18e210f03a37f44` | 66,581,203 |
| A Claude Code session save | `0x9185075e404ec09a48b20098151d1a7b2dbeaf9245f474a717c194c08f970d02` | 66,581,414 |

Every transaction came from Mida's batcher `0xF25e32700b2275CC00A93d728A17013bc2CE2eB8`, went to the
BatchAnchor contract, succeeded, and carries a save event naming the owner. The
batcher paid the gas (251,383 for the first). The owner's wallet held 0 MON throughout.

**What this does not show.** Each of these batches held one save. The batcher waits 2 seconds before
anchoring, and one person's saves arrive 15 to 90 seconds apart, so a single user's saves do not share
a transaction today. Sharing happens when many users save within the same few seconds. The contract
accepts up to 400 saves in one transaction ([sweep](batch-anchor-sweep-2026-09-24.json)).

## Sep 29: the session-start read in a busy project

The defect: when a session starts, Mida reads the project's saved checkpoints and checks each one on
Monad, within a 7.5-second limit. The old read checked the records one chain request at a time, and Mida
sends at most 10 chain requests a second. In the owner's busiest project the read found 83 to 87
checkpoints in 7.0 to 7.5 seconds and stopped before reading them all; from 06:35 WAT on, every session
start timed out, seven in a row.

The fix (`91ea961`, and `50cb4e2` for the owner's facts) checks the listed records in batched calls.

The check: the same session-start read, same project, same agent, after the owner's service moved to
the fixed build. Numbers from the service's own log.

| | Checkpoints read | Complete | Read time (limit 7.5 s) |
|---|---|---|---|
| Before the fix | 83 to 87 | no: cut short, then 7 timeouts in a row | 7.0 to 7.5 s |
| After the fix | 155 | yes | 5.1 s |

**What this does not show.** One project and one run after the fix. We have not measured where the
5.1 seconds go, so we do not know whether the read time grows with the number of saves; a much larger
project could reach the limit again.

**Oct 1 update.** We timed each step of the read at 250 checkpoints and counted what the session
starts after this fix got: [session-start-read-2026-10-01](session-start-read-2026-10-01/README.md).
The raw log published there holds 13 cut-short reads from before the fix, at 7.0 to 7.5 s. This
section said 7.1 to 7.2 s until Oct 2.
