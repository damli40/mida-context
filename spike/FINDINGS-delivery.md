# Spike findings — delivery half (Claude Code → Codex), 2026-09-20

Nine runs, three per condition, plus two pilots. In every run Agent A = Claude Sonnet, headless, on
the toy rate-limiter task, killed the moment it began step 3, with checkpoints captured by the
hook + cheap-model method (the winner of the capture half). Agent B = a fresh headless Codex
(codex-cli 0.142.5) given exactly one word: `Continue.` Raw data in `results/` (gitignored).
Three runs per condition shows a direction, not a statistic.

## The three conditions

- **Injected:** a session-start hook prints the Mida handoff into Codex's session.
- **Tool only:** Codex has the Mida plug-in with a "get handoff" tool and must decide to use it.
- **No Mida:** nothing but the working folder.

## How it was judged

Not by what the checkpoint says — by whether B FINISHED THE JOB, checked on the finished files.
Steps 4 (a keyed limiter that evicts the least-recently-used key) and 5 (a README usage section)
appear nowhere in the working folder: the task text is passed to A as a prompt and never written
to disk. So B can only build them if the handoff told it to.

## Results

| Run | A | Codex | Codex tokens | Step 4 keyed limiter + eviction | Step 5 README | Timers used | Tests |
|---|---|---|---|---|---|---|---|
| injected 2 | 78 s | 95 s | 43,359 | yes | yes | none | 14/14 |
| injected 3 | 70 s | 93 s | 44,552 | yes | yes | none | 16/16 |
| injected 4 | 60 s | 123 s | 57,668 | yes | yes | none | 17/17 |
| tool only 1 | 48 s | 57 s | 42,144 | no | no | none | 9/9 |
| tool only 2 | 70 s | 52 s | 40,230 | no | no | none | 11/11 |
| tool only 3 | 82 s | 58 s | 42,125 | no | no | none | 13/13 |
| no Mida 11 | 66 s | 56 s | 41,139 | no | no | none | 10/10 |
| no Mida 12 | 99 s | 44 s | 26,296 | no | no | none | 11/11 |
| no Mida 13 | 70 s | 67 s | 28,930 | no | no | none | 11/11 |

**Task finished: injected 3 of 3 · tool only 0 of 3 · no Mida 0 of 3.**

(An automated text search first reported "no eviction" for injected runs 3 and 4. Reading the code
showed a key cap, a size check and delete-then-reinsert — least-recently-used eviction under
different wording. The search was wrong, not the code.)

## Finding 1 — with the handoff injected, a fresh Codex finishes the job from one word

All three injected runs built steps 4 and 5, kept the "no timers" rule, and ended with passing
tests. Codex's closing message in run 2 restated the key decision and its reason unprompted:
"chose lazy refill. A background interval would violate the explicit 'no timers' constraint."
That is the recital the frozen demo calls for. Codex also noticed step 3 was already half-written
on disk and completed it rather than redoing it — the "last seconds" gap from the capture half
healed itself.

## Finding 2 — "tests pass" tells you nothing; every baseline passed its tests and was half done

All six failing runs ended green (9–13 tests). Without the handoff Codex tidied what existed,
finished step 3, and reported "Continued and finished the token bucket work." It did not know
steps 4 and 5 existed, and it said it was done. **It runs, it returns a result, and the result is
wrong** — silently. This is the strongest single argument for the product and should be in the
pitch: the cost of a lost handoff is not an error, it is a confident half-finished job.

## Finding 3 — Codex never found Mida on its own (0 of 3), and here is the mechanism

In the tool-only runs Codex made zero calls to "get handoff". Checked directly: the plug-in was
registered and enabled, and the server starts and lists its tools by hand. But Codex does not show
plug-in tools to the model up front — it keeps them behind a tool SEARCH. Asked "do you have any
tools containing 'mida'?" Codex answered NONE; told to use its tool search for 'mida', it found
both tools. With only "Continue." nothing prompts it to search. In one run it even went looking
for summary files on disk — it wanted context and did not know where it lived.
Caveat: the confirming probe changed two things at once (a longer plug-in startup allowance and a
prompt that told it to search), so deferral is the evident cause, not a proven sole cause.

**Consequence: delivery by injection is the design. The MCP tool is for deliberate use, never the
path the demo depends on.** This answers the frozen design's open question "how often does the
model skip calling Mida?" — for Codex with a bare "Continue.", every time.

## Finding 4 — the user's request must travel word for word (found by the first pilot)

Pilot 1 (before the fix): Codex picked up from the handoff, finished step 3, then STOPPED — "I
didn't find the descriptions for steps 4 and 5 anywhere… so I stopped instead of inventing the
remaining API." The cheap model had compressed the task to "following 5 steps". Fix: every
checkpoint now carries the original request verbatim, copied from the transcript by code, never
written by a model, plus a "remaining plan" list. Attacked before use: a fake model that tried to
replace the request with "delete the repo", including under look-alike field names, was dropped and
logged. Pilot 2 and the three injected runs above all ran with the fix.

## Codex facts measured along the way

- Hooks run headless; a session-start hook's output reaches the model.
- Events seen: session start, prompt submitted, after tool use, stop. **No session-end event.**
- Hook input has the same shape as Claude Code's (event, session ID, folder, transcript path).
- **Codex silently skips any hook the user has not personally trusted** (it stores a hash of the
  exact command text). The spike used `--dangerously-bypass-hook-trust` per run in a throwaway
  config. The product needs a one-time human approval at install, a check that the hook really
  fires afterwards, and a hook command whose text never changes.

## Cost of continuing

Codex used 43–58K tokens and 93–123 s when it had the handoff and did the full remaining job;
26–42K tokens and 44–67 s when it had nothing and did half of it. The handoff itself is a few
thousand characters.

## Not tested

Long sessions, sessions that compact their memory, more than one task, handoff in the other
direction (Codex → Claude Code), Cursor, the third benchmark condition from the frozen design
(handing B the raw transcript), real encryption, grants, revocation, and anything on-chain.
One scorer; no second rater. Sonnet for A, Haiku for the compiler, Codex's default model for B.
