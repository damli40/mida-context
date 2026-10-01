# What you can do with Mida

Mida is user-owned memory infrastructure for AI agents. It saves what one agent was doing as an encrypted
checkpoint you own, and hands it to the next agent you approve. This page covers what you can use it for today,
how far each use is proven, and where Mida goes next. To try it, the [quickstart](quickstart.md) takes about
15 minutes.

Each use carries a status. **Live** means it ran on Monad testnet with real agents
([evidence](evidence/live-tests-2026-09-27-to-29.md)). **In tests** means the automated suite covers it on a local
chain and nobody has run it live yet. Everything under "Where Mida is going" is planned and not built.

## Use it today

### Keep working when an agent runs out of usage (Live)

Claude Code hits its limit halfway through a feature. You open Codex in the same folder and type "Continue."
Codex starts with Mida's checkpoint: your original request word for word, what the first agent decided and why,
what it tried and dropped, and the next step. We gave a fresh Codex a half-finished job and that one word. It
finished 0 of 6 runs without a handoff and 3 of 3 with one
([method and runs](evidence/handoff-design-and-benchmark-2026-09-20.md)). The handoff ran both ways between Claude
Code and Codex on Sep 27, and Devin picked up the same project through its own hooks.

### Keep your change of plan in a long session (tested on the real compile model)

You change the plan in the middle of a long session. The next agent needs your new goal, credited to you, and
not the old one. We ran a long synthetic session with the change in the middle through Mida's default compile
model. The checkpoint carried the new goal in 6 of 6 runs, up from 0 of 6 before the fix, and credited the
change to you in 6 of 6.

### Bring in an agent for one job, then cut it off (Live)

Approve Devin for one push with `mida approve devin`. When the job lands, run `mida revoke devin`. On Sep 27 the
next Devin session got nothing from Mida and a line saying you had revoked it. A revoke stops future reads; it
cannot take back what the agent already read.

### Ask Mida mid-session (Live in Claude Desktop, in tests elsewhere)

Mida's MCP tools let an agent fetch the handoff, read a context area, or save a checkpoint while it works.
Claude Desktop called `mida_handoff` and `mida_save` live on Sep 27. `mida install claude-code` and
`mida install codex` add the same tools to those clients; that part is in tests.

### Run two efforts in one repo (In tests)

`mida task frontend` and `mida task backend` keep two efforts apart in the same project. Each session keeps the
task it started with, and a handoff carries its own task's checkpoints plus one line about each other task.

### Show which agent did what (Live)

Mida records the author of each checkpoint on Monad, and anyone can check that record. When a hackathon asks
how your team used AI, you can point at it. The record covers the agents' work summaries and decisions. It does
not cover your code.

### Build your agent on Mida's memory and permissions (In tests)

The SDK, `@mida-context/sdk`, gives your agent the context a user approved: it requests access, reads, and
writes within the grant the user signed. You skip building per-agent keys, a permission list the user can
revoke, and an export. Reference: [`sdk.md`](sdk.md).

### Take everything with you (In tests)

`mida export <folder>` writes every record the chain attributes to you, decrypted, into a new folder.

### One hackathon night with Mida

You approve Claude Code, Codex and Devin for your repo. Claude Code builds the API until its usage runs out at
2 a.m., so you open Codex and type "Continue." You bring Devin in for the deploy script and revoke it once the
deploy works. In the morning, the Monad record shows which agent wrote each checkpoint.

## Not a fit yet

- **One memory shared by several teammates.** Each Mida setup has one owner today, so each teammate runs their own.
- **Anything secret.** Mida runs on Monad testnet and has no security audit. See
  [the limits](../README.md#security-model-and-limits).
- **Heavy use of the hosted gas sponsor.** It advertises 300 signings per address a day and 2,000 a day across
  all users. `mida sponsor off` switches your setup to paying its own testnet gas.

## Where Mida is going

None of this is built. Two rules shape all of it. Mida remembers what you decided and what happened, and who
said it; the app you work in says what is true now. And Mida owns the rules of memory (who wrote a record, who
may read it, when it expires) while other tools reason over the records.

- **Teams.** Several people steer one long-running agent. Each teammate gets their own identity and permissions,
  so the record shows which person said what, and you can revoke one teammate without stopping the others.
- **Sign in with Mida.** An app asks for scoped access to your context the way it asks you to sign in. You
  approve it, and later revoke it, like any agent.
- **Move in, move out.** You connect the AI tools you already use. Mida pulls out candidate facts with their
  source, and you review the sensitive ones before anything is saved. Leaving stays as easy as arriving,
  including leaving tools built on Mida.
- **The right slice for each agent.** A coding agent gets your project preferences, not your finances. Context
  profiles give each agent a view of one project.
- **Notes addressed to one agent.** An agent leaves an encrypted note for a named agent, and that agent sees it
  on its next context check. Neither agent calls the other; both read and write your context.
- **A separate permission for training.** Reading your context does not let an agent train on it. Training
  gets its own grant, which you approve on its own.
- **Memory engines.** Separate agents read your records, work out what they mean, and write their conclusions
  back under their own identity. You see and revoke them like any other agent.
- **Chat apps.** ChatGPT and claude.ai cannot run a program on your machine. A remote Mida endpoint over MCP,
  with sign-in, would reach them; the open design question is where the decryption keys live.
- **Mida Home.** An app where you see and correct what your AIs know about you, check which AI can read what,
  and read a log of what each one learned and used.

Start with the [quickstart](quickstart.md).
