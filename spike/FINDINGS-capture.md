# Spike findings — capture half (Claude Code only), 2026-09-19

Six runs, three per method. Agent A = Claude Sonnet, headless, on the toy rate-limiter task, killed
the moment it began step 3. Raw data: `results/hook-none/{1,2,3}` and `results/tool-none/{1,2,3}`
(gitignored). Three runs per method shows a direction, not a statistic. Nothing here involves Codex.

## The two methods

- **Tool method:** Agent A is given a "save checkpoint" MCP tool and told to use it after each
  step and decision.
- **Hook method:** Agent A is told nothing. A hook fires after tool use and at session end, hands
  the job to a background worker, and a cheap model (Claude Haiku) writes the checkpoint from the
  structured transcript (human and agent messages and tool activity only; first message always kept).

## Scores

Each run's LATEST checkpoint — the thing a fresh Agent B would be handed — scored against what A
really did. Eight fields from the frozen design, 0 = missing or wrong, 1 = partly right, 2 = correct.
Scored by Claude reading A's own output and the files on disk; one scorer, no second rater.

| Field | hook 1 | hook 2 | hook 3 | tool 1 | tool 2 | tool 3 |
|---|---|---|---|---|---|---|
| Objective | 2 | 1 | 2 | 1 | 1 | 2 |
| Progress | 1 | 1 | 1 | 1 | 1 | 1 |
| Decision (the planted one: lazy refill) | 2 | 2 | 2 | 1 | 1 | 1 |
| Rationale / rejected approach | 2 | 1 | 1 | 0 | 0 | 0 |
| Constraints | 2 | 2 | 2 | 0 | 0 | 0 |
| Artifacts | 2 | 2 | 2 | 2 | 2 | 2 |
| Unresolved issue | 0 | 1 | 0 | 0 | 0 | 0 |
| Next action | 1 | 1 | 1 | 1 | 1 | 1 |
| **Total / 16** | **12** | **11** | **11** | **6** | **6** | **7** |
| Evidence references | 7 | 8 | 9 | 0 | 1 | 0 |
| Saves made | 3 | 3 | 3 | 2 | 2 | 2 |
| Longest the agent was held up | 4 ms | 4 ms | 4 ms | n/a (agent spends its own turns) | | |
| Cheap-model time per save (background) | 13–17 s | 15–19 s | 9–17 s | n/a | | |

Errors across all six runs: 0. Saves left unfinished at kill time: 0.

## Finding 1 — agents write deltas, the compiler writes whole states (3 of 3 vs 9 of 9)

In every tool-method run, save 1 was complete (5 constraints, the lazy-refill decision, the rejected
background interval) and save 2 was a DELTA: zero constraints, no mention of lazy refill, nothing
rejected. The agent reasonably treats a second save as "what is new". So "hand Agent B the latest
checkpoint" loses the constraints and the key decision — precisely the knowledge B cannot recover
from the code. In the hook method all 9 saves were self-contained, because the compiler re-derives
the whole state from the transcript each time.

If the two tool-method saves are merged by hand, those runs score about 11–12 — level with the hook
method. So the agent is not worse at knowing things; the "latest wins" handoff rule is what fails.

**Requirement for the real build:** a handoff is never "the newest checkpoint". Either every
checkpoint is a full state (hook method gives this for free), or the handoff is a deterministic
merge over the project's checkpoints. Decide one; test it.

## Finding 2 — only the hook method produced provenance

Hook-method checkpoints cited 7–9 checkable references each ("objective → transcript line 3",
"decision → line 26"). Tool-method checkpoints cited 0, 1 and 0 — the one being "npm test: 7 pass",
which points at nothing. Provenance is a must-ship item in the frozen design, so this matters more
than the score gap.

## Finding 3 — both methods miss the last seconds

In 6 of 6 runs the latest checkpoint did not know that step 3 was already half-written on disk.
The kill lands after the file write and before anything records it. Neither method fixes this.
A deterministic fix is available: at handoff time, attach the list of files changed since the last
checkpoint (a plain file comparison, no model). Whether it is needed depends on the Codex half —
Agent B can also just look at the working folder.

## Finding 4 — the hook method does not slow the agent

Longest hold on the agent across 30+ hook firings: 4 ms. The 9–19 s model call runs in a separate
process. This matches the frozen design's "checkpointing must not add noticeable latency" and the
decision to put slow work in one local Mida service.

## Smaller observations

- Session-end fired when Agent A was killed (3 of 3), and its save completed.
- Near-duplicate saves: session end and the last after-tool-use fired ~3 s apart on the same
  messages — two model calls for one state. Skip a save when nothing changed since the last one.
- One hook-method checkpoint recorded artifacts as absolute paths (`/Users/you/Desktop/…`).
  That leaks the local folder layout into shared context. Store paths relative to the project.
- One hook-method checkpoint invented a mild "unresolved issue" (decision "not yet documented in
  code") that was not a real blocker. The frozen rule "never claim zero hallucination" stands.
- The tool method cost the agent 2 tool calls per run out of its own turns; the hook method cost
  3 Haiku calls per run outside the agent.

## What this says about the frozen design

The Context Compiler (hook + cheap model) is NOT optional decoration: on this evidence it is what
delivers self-contained checkpoints and provenance. The agent-facing "checkpoint" MCP tool is still
worth having, but as a supplement, and only with a merge rule behind it.

## Not tested

Anything with Codex: whether its hooks fire headless, its transcript format, and the actual
question — does a fresh Agent B continue correctly on "Continue."? Also untested: long sessions
(these were 50–97 s), sessions that compact their memory, more than one task type, and any model
other than Sonnet for A and Haiku for the compiler.
