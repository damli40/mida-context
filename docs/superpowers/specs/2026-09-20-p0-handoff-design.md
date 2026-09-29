# Mida Context P0 — the "Continue." handoff, on the real protocol

Date: 2026-09-20 · Status: design as written on Sep 20, before the build · Public cut: the hackathon-planning sections (goals framing, dates, later amendments) were removed before publication; the technical design and the benchmark stand as written.

Builds on: the Project 1 protocol core (finished, live on Monad testnet 10143). Plan of record: the Sep 18 frozen design. Evidence base: the
feasibility spike in `spike/` (`FINDINGS-capture.md`, `FINDINGS-delivery.md`).

**Where to look:** §5 is the path of one checkpoint. §8 is every way this fails and what happens.
§12 is the list of things I had not proven yet.

---

## 1. The problem

When an AI coding agent stops — it crashes, runs out of usage, or you switch tools — everything
it learned about the job stays inside that tool. The next agent starts blind.

The spike measured what "blind" costs. A fresh Codex was given a half-finished job and one word,
"Continue." Without a handoff it finished **0 of 6** runs. Worse: in all six it passed its tests
and said it was done. It did not know two of the five steps existed. The failure is not an
error. It is a confident, half-finished job that looks finished.

With a Mida handoff printed into the session at start, it finished **3 of 3**, kept the "no
timers" rule, and restated the key decision and its reason without being asked.

There is a second problem underneath. The fix today is to paste a transcript or keep a notes
file. That context belongs to no one, is readable by anything on the machine, cannot be taken
back once shared, and carries no record of which agent wrote what. As more agents work on a
person's behalf, "who may read my working context, and can I take that back" becomes an
infrastructure question. That is the track's own thesis: *identity, provenance, data ownership,
and agent trust*.

**Goal of P0:** prove one thing end to end, for real. Agent A (Claude Code) works while Mida
saves compact checkpoints. A is interrupted. The user approves a fresh Agent B (Codex) and types
only "Continue." B picks the job up correctly. The user revokes A live; A is refused, B is not.
Every checkpoint is encrypted, owned by the user, and its existence and authorship are
confirmed on Monad.

## 3. Decisions already made (by Dami unless marked)

1. Plan of record is the Sep 18 frozen design.
2. The owner acts only through the `mida` terminal command, signing with a software key on the
   laptop. No web page, no passkey prompt in P0.
3. One long-lived local service, `midad`, holds the agent keys, the save queue and the server
   data. MCP plug-ins and hooks are thin clients.
4. An approval covers one project only, **enforced by `midad`, not the chain** (the protocol's
   namespace tree is fixed at deployment; all coding checkpoints live in `projects.current`).
5. Build order: protocol-first walking skeleton.
6. (Default, Claude) The Context API server runs inside `midad` with a data folder that
   persists. Not hosted.
7. (Default, Claude) A checkpoint is readable by another agent only after its Monad
   registration confirms. This is how the existing server already behaves.
8. (Default, Claude) The cheap model that writes checkpoints is not its own registered agent in
   P0. Each checkpoint carries a `compiledBy` field, and the write-up says so.

## 4. The pieces

```
 Claude Code                                   Codex
 hook script ──┐                         ┌── hook script
               ▼                         ▼
        ┌──────────────── midad (one local service) ───────────────┐
        │ save queue · Context Compiler · agent keys (A and B)     │
        │ Context API server (persistent folder) · handoff builder │
        └────────┬──────────────────────────────────┬──────────────┘
                 ▼                                  ▼
        local data folder                     Monad testnet
        (encrypted objects)          (grants, revocations, commitments)

 you ──► `mida` command — holds the owner key; the only thing that changes access
```

| Unit | Where | One job | Depends on |
|---|---|---|---|
| Checkpoint library | `packages/checkpoint` | The checkpoint shape, strict validation, the merge rule, and rendering a handoff as text. Pure functions, no I/O | nothing |
| Context Compiler | `packages/compiler` | Transcript reader per tool → secret scrubber → cheap model → pick known fields → validate → attach the user's request copied word for word by code | checkpoint library; a swappable model command |
| `midad` | `apps/midad` | Queue, agent keys, Context API server, protocol calls, handoff builder. The only unit that speaks the protocol on an agent's behalf | `@mida/sdk`, `@mida/api`, `@mida/chain`, the two packages above |
| Hook script | installed to `~/.mida/bin/mida-hook` | Tell `midad` an event happened; at session start, print the handoff. Never slow, never blocks | `midad` (does nothing if it is down) |
| MCP plug-in | `apps/mcp` | Five deliberate-use tools (§7). The demo never depends on it | `midad` |
| `mida` command | `apps/mida` | `init`, `install`, `doctor`, `approve`, `revoke`, `status`, `provenance`. Holds the owner key | `@mida/fake-vault` owner class, `@mida/chain`; `midad` for reads |

Two boundaries drawn on purpose:

- **Only the `mida` command can change who has access.** `midad` and the agents never hold the
  owner key. "Models never decide authority" is enforced by who holds which key, not by
  convention.
- **Hook commands are one fixed line that never changes between versions**
  (`~/.mida/bin/mida-hook claude-code`, `~/.mida/bin/mida-hook codex`). Codex stores a fingerprint
  of the exact command text and silently skips a hook whose text changed. All behaviour lives in
  `midad`.

Hooks and the MCP plug-in reach `midad` over a local socket file, `~/.mida/midad.sock`, readable
only by the user.

On-disk layout, all under `~/.mida/`, every secret file readable only by the user:
`owner/` (owner wallet key, 32-byte seed, stand-in passkey key), `agents/<name>/` (agent ID,
signer key, encryption key, operator manifest), `operator/`, `data/` (the Context API folder),
`queue/`, `requests/` (pending approval requests), `approved-projects.json` (+ owner signature),
`logs/`. In each project folder: `.mida/project.json` holding a random project ID.

## 5. The path of one checkpoint

Function names are from a read of the Project 1 code on Sep 20. They were not executed.

### A. Set up once — `mida init`

1. Create the three owner secrets and save them. Create one operator wallet and, per agent, a
   signer wallet and an encryption keypair.
2. The user funds the owner wallet once from the faucet. `mida init` passes small amounts on to
   the operator and the two agent signers, waiting 4 blocks between transfers (Monad's
   reserve-balance rule; the workaround already exists at `apps/cli/src/environment.ts:96-102`).
3. `registerOwnerKey()` and `initializeNamespace("projects.current")` — two owner transactions.
4. Per agent: `provisionAgent()` → `registerAgent` transaction signed by the operator, then
   `putAgentManifest`.

### B. Approve — `mida approve codex`, run inside a project folder

Every agent needs this once per project before anything works, Claude Code included: an
unapproved agent can neither save nor read. Grants last 30 days, then need approving again.

1. `midad`, acting as Codex, calls `createAccessRequest()` for read + add + replace-own on
   `projects.current`, purpose `project_assistance` (the existing policy table lists exactly this
   as that purpose's recommended grant, Project 1 spec line 1447). The request is written to
   `requests/` through the SDK's `AccessRequestStore` slot, so a restart does not lose it.
2. The `mida` command prints what is being asked and what the grant advisor says, and waits for
   the user to type yes.
3. `approveGrant()` → `grantBatch` transaction (~424,000 gas, measured Sep 17). Then
   `publishReaderWraps()` gives the agent the decryption key. `midad` runs
   `completeAccessRequest()`.
4. The command adds this project's ID under this agent in `approved-projects.json` and signs the
   file with the owner key. `midad` verifies that signature on every use and refuses to serve
   anything if it fails.

### C. Save — every capture

1. The hook fires (Claude Code: after tool use, stop, before memory compaction, session end;
   Codex: after tool use, stop — Codex has no session-end event). It sends the event and the
   transcript path to `midad` and returns. Spike measurement: the hook held the agent 4 ms at
   most.
2. `midad` queues the job. It drops the job if the transcript has not changed since the last
   save, and saves at most once a minute, except that a stop or session end always flushes.
3. The compiler produces a checkpoint (9–19 s in the spike, off the agent's path).
4. `midad` wraps it as a `ContextPayload`: `recordType` CONTEXT, source `AGENT_INFERRED` (the
   only source an agent may use without an evidence reference), and inside the encrypted value:
   the checkpoint, the project ID, the session ID, `continuesSession` if this session began from
   a handoff, and `compiledBy`.
5. `sdk.create()` uploads the encrypted object and sends one `register` transaction signed by
   that agent's own wallet.

Every save is a new object, never an overwrite. The save's ID is a hash of project ID, session
ID and the transcript's byte length and last-line hash — values that keep changing — so a retry
is recognised as a duplicate and a later save never is.

### D. Hand off — a fresh agent starts

1. The session-start hook asks `midad` for this project's handoff, as this agent.
2. `midad` checks the signed approved-projects list, then calls
   `sdk.read(owner, "projects.current")` with that agent's keys. The read itself is authorised
   against the chain by the existing server, so a revoked agent is refused here.
3. `midad` decrypts, keeps only this project's checkpoints, and merges them (rule below).
4. The rendered handoff is printed into the session.

**Changed since I presented section 2 in chat:** I proposed caching the rendered handoff for
speed plus a separate live revocation check. I have removed the cache. A full read on every
session start is simpler and cannot serve a revoked agent stale context. If the skeleton build
measures it as too slow for the hook's time limit, a cache comes back with the live check —
that is a measured decision, not a guessed one.

**The merge rule — code, never a model.** A handoff is never just the newest checkpoint,
because agents write a full first save and then saves that only describe what changed.

- Scope: the most recent session for this project, plus any sessions it continues
  (`continuesSession`), oldest first.
- The user's original request: from the first checkpoint in that scope, word for word.
- Objective, remaining plan, open issue, next step: the latest non-empty value.
- Decisions, rejected options, constraints, files touched: every distinct entry, in order.
- Progress: every entry, in order. If the render passes 8,000 characters, the oldest progress
  entries are replaced by one line saying how many were left out.
- The render leads with the original request, then remaining plan, then the rest, and ends
  with provenance: per checkpoint, which agent wrote it, when, and its on-chain record ID.

### E. Revoke — `mida revoke claude-code`

Revoking is for the whole agent, across every project: the chain holds one grant per agent, not
one per project. There is no per-project revoke in P0.

1. `requestRevocationDeny()` — the local server refuses that agent at once, no transaction.
2. `approveRevocation()` → `revokeAndRotate`: one transaction that revokes the grant and moves
   the namespace to a new encryption key.
3. `publishReaderWraps()` again so the agents still approved get the new key.
4. The command removes the agent from `approved-projects.json` and re-signs it.
5. The revoked agent's next handoff or save is refused with `CAPABILITY_REVOKED`. Its hook
   prints one plain line saying access was revoked. `mida status` shows the transaction hash.

## 6. The `mida` command

| Command | What it does |
|---|---|
| `mida init` | §5A. Safe to re-run: skips every step already done |
| `mida install <claude-code\|codex>` | Writes the hook entries and MCP entry into that tool's config. For Codex, tells the user to approve the hooks once inside Codex (its trust step cannot be done for them) |
| `mida doctor` | Proves each hook really fires: starts a throwaway headless session of each tool and checks `midad` received the events. Also checks `midad` is up, wallets have gas, the owner is registered, the shell API-key variable is not going to hijack the compiler |
| `mida approve <agent>` | §5B |
| `mida revoke <agent>` | §5E |
| `mida status` | Per agent and project: approved or revoked, grant expiry, last save, queue depth, last transaction hash |
| `mida provenance` | For this project: every checkpoint — writer, time, record ID, transaction hash, whether the chain confirms it |

`mida doctor` exists because of a spike finding: Codex skips an untrusted hook without any
message. Without a check, "installed" and "working" are different things and nothing says so.

## 7. The MCP plug-in — five thin tools

The frozen design lists five. All are thin calls into `midad`; none can change access.

| Tool | Does |
|---|---|
| `mida_handoff` | Returns the same handoff the session-start hook prints |
| `mida_checkpoint` | Lets the agent save a checkpoint on purpose. Same validation, same queue |
| `mida_resolve` | Returns this project's merged context as structured data |
| `mida_propose` | The agent suggests a durable fact for the owner to confirm later (`sdk.propose`). P0 stores it; reviewing it is P1 |
| `mida_provenance` | Same data as `mida provenance` |

Spike finding that shapes this: given only "Continue.", Codex called the Mida tool in 0 of 3
runs, because Codex keeps plug-in tools behind a tool search. **Delivery by injection is the
design. The plug-in is for deliberate use and the demo never depends on it.**

## 8. How it fails, and what happens

The rule throughout: a failure must be visible. The failure to fear is the one that looks like
success.

| What goes wrong | What happens |
|---|---|
| `midad` is not running | Hooks do nothing and exit at once; the agent is never blocked. `mida status` and `mida doctor` say so. No save is silently "lost in the hook": the next event after `midad` returns captures the whole transcript anyway |
| The agent is not approved for this project, or its grant expired | Nothing is saved or read. The session-start hook prints one line: "Mida: <agent> is not approved for this project — run `mida approve <agent>`". Events are not queued for later, so nothing is saved retroactively without the owner's say |
| Compiler model fails, times out, or returns junk | The job stays queued and retries with backoff (3 tries). Unknown fields are dropped and logged; a save missing a required field is rejected, never half-saved |
| Model tries to rewrite the user's request | It cannot: that field is copied from the transcript by code and the model's version is discarded (attacked in the spike, held) |
| A secret in the transcript | The scrubber runs before the model sees anything and again on the model's output. Logs never contain transcript text |
| Monad connection down or a transaction fails | The encrypted object waits in the queue; the transaction retries. Until it confirms, other agents do not see that checkpoint. `mida status` shows queue depth |
| Agent wallet out of gas | Saves queue up, `mida status` and `mida doctor` say which wallet to top up |
| Agent killed mid-save | `midad` is a separate process and finishes the save |
| `midad` restarts | Queue, pending approvals, server data and deny list are all on disk and reload |
| The user's request is very long | The protocol caps a payload at 65,536 bytes. The request is stored once, in the session's first checkpoint. If it alone would break the cap, the middle is cut with a marker stating how many characters were removed and where the full text is, and the handoff repeats that warning at the top |
| Approved-projects list edited by hand or by an agent | Signature check fails; `midad` serves nothing and says why |
| Handoff read is slow or fails | The agent gets one line: "Mida: no handoff available (reason)". Never a stale or partial handoff |
| Codex hook not trusted, or its command text changed | `mida doctor` catches it. This cannot be detected at run time because Codex gives no signal |
| Shell has an API-key variable that overrides the model login | `midad` removes it from the compiler's environment (found in the spike: it caused a run with zero output) |

## 9. Limits to state plainly in the write-up

- **Software owner key.** P0 signs owner actions with a key file on the laptop, not a passkey.
  The protocol's passkey check is real; the prompt is not built.
- **Same-laptop limit of revocation.** Both tools run as the same macOS user. Revoking A is real
  and checkable — the chain and the server refuse A's key — but on one laptop it stops an honest
  tool or a remote agent, not malicious local software that steals B's key file.
- **Project scoping is enforced by the local service, not the chain.** The chain enforces which
  agent; the laptop enforces which project.
- **Checkpoints are written by a cheap model, labelled as such**, and signed with the key of the
  agent whose session it was.
- **The scrubbed transcript goes to the compiler's model vendor.** For a Claude Code session that
  is the vendor that already saw it. For a Codex session it is a second vendor. The model
  command is swappable, including for a local model.
- **Not hosted.** One laptop. Handoff between machines is later work.

## 10. Testing, and the benchmark

- **Unit tests (Vitest, the repo's existing setup):** checkpoint validation, the merge rule, the
  render, the scrubber, each transcript reader against saved fixture transcripts, save-ID
  behaviour past 60 KB, the very-long-request cut.
- **Regression tests for every spike bug** (each one passed its tests while being wrong):
  duplicate IDs after 60 KB; secrets behind JSON-escaped quotes and JSON-style keys; an extra
  model field discarding a whole save; the hook blocking the agent; absolute paths in a
  checkpoint; a delta save erasing the original request.
- **Integration on local Anvil:** the full §5 path with a fake compiler — init, approve, save,
  read as B, revoke A, A refused, B still reads after the key rotation, `midad` restart in the
  middle of an approval and in the middle of a save.
- **End to end on Monad testnet:** the same, once per milestone, with transaction hashes saved
  to `docs/evidence/`.
- **Adversarial review** (`/code-review high`) before anything is called done, aimed at the
  wrong-number class: a refusal that does not refuse, a handoff for the wrong project, a status
  line that says "saved" before the chain confirms.
- **README run:** the demo flow on a clean clone, following only the README.

**Benchmark (for the write-up and video).** Prompt is exactly "Continue." Three conditions: no
Mida; the scrubbed raw transcript injected at session start; the Mida handoff injected. Two
tasks (the spike's rate limiter and one new one), 15 measured runs in total. Scored on the
finished files, not on what the agent says: were the steps that exist only in the handoff
built, were the stated constraints kept, do tests pass — plus tokens and seconds. Only measured
numbers are shown. Stated limits: one scorer, small sample, shows a direction not a statistic.

## 12. Not proven yet — M0 answers these first

1. Can one operator wallet register both agents? Project 1's tests use one operator per agent.
   The agent ID formula includes a random salt, which suggests yes. If no: one operator each,
   two more wallets to fund.
2. Does a full protocol read fit inside each tool's session-start hook time limit over the
   public testnet connection? If no: the cache plus live check described in §5D.
3. How many seconds from "save queued" to "readable by B" on testnet, and how many transactions
   does a normal session produce?

**Answered Sep 20 on Monad testnet** (12 of 12 steps passed; `docs/evidence/m0-monad-testnet.json`,
commit `c35848c`; local-chain figures in `m0-local-anvil.json` for contrast):

1. **Yes.** One operator wallet registered both agents, on the local chain and on testnet. No
   extra wallets to fund.
2. **Yes, with room.** A full protocol read took 2.5 s and 2.8 s (30 ms on the local chain — the
   difference is round trips to the public RPC, not work). Claude Code's session-start hook
   allows 600 s by default, and Codex's docs state the same figure (docs-site only, not verified
   in its repo). So §5D stays as written: no cache. Not measured: a read over many checkpoints.
   The server checks each object against the chain, so read time will grow with the number of
   saves; M2 measures a read over 50 checkpoints before the handoff builder is called done.
3. **5.6 s** from starting a save to another agent reading it (the save itself 2.8–2.9 s). Add the
   compiler's 9–19 s in front and a checkpoint is readable roughly 15–25 s after the hook fires.
   So an agent that is cut off loses at most the last minute of work plus that delay, which the
   demo can say out loud. Approving a grant cost 403,382 gas. Transactions per session: not
   measured yet; with the one-save-a-minute rule it is at most one per active minute.

Also unknown, not blocking: Codex's transcript format (needed for M3's reverse direction);
behaviour in long sessions and after memory compaction; whether a second scorer changes the
benchmark picture.

## 13. Out of scope for P0

Web page or status page; passkey prompt (P1); Cursor; baseline
import; benchmark dashboard; review screen for proposed facts; hosted server; per-role scoping
inside a project; chain-enforced per-project scoping (needs a new namespace-tree version);
the compiler as its own registered agent; Envio indexing. Under the freeze rule each of these
is a new feature and goes to the post-hackathon list.

---
