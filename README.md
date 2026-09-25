# Mida Context

**Switch AI agents without losing the work.** Mida saves what one agent was doing as a short,
encrypted checkpoint that *you* own, and hands it to the next agent you approve — Claude Code
today, Codex tomorrow, whatever comes next.

> [!IMPORTANT]
> **Status: pre-release, Monad testnet only, not audited.** The full loop — set up, approve an
> agent, save a checkpoint, hand it to a fresh agent, revoke — has run live on Monad testnet
> ([evidence](docs/evidence/m3-live-hosted-2026-09-22.json)). The npm packages are **not published
> yet**; install from this repository (see [Quickstart](#quickstart)). Handoff works **one
> direction today**: Claude Code sessions are captured, Codex sessions are not yet. See
> [What works and what doesn't](#what-works-and-what-doesnt).

---

## The problem

Anyone who works with more than one AI agent knows this moment: one agent runs out of usage, or
crashes, or you simply want a different one for the next part of the job. The new agent starts
blind. Everything the first one learned — what you asked for, what it decided and why, what it
already tried and rejected, what is left to do — stays locked inside the first tool.

We measured what "blind" costs. A fresh Codex session was given a half-finished job and one word,
"Continue." Without a handoff it finished **0 of 6** runs — and in all six it passed its tests and
said it was done, because it did not know two of the five steps existed. With a Mida handoff printed
into the session at start, it finished **3 of 3**, kept a rule only the first agent had been told,
and restated the key decision and its reason unprompted
([method and runs](docs/superpowers/specs/2026-09-20-p0-handoff-design.md)).

Today's workarounds are pasting transcripts, or keeping a notes file. That context belongs to no one,
any program on your machine can read it, and there is no way to take it back from an agent you no
longer trust. And the tools keep changing: new models, new agent programs, new prices every few
weeks. Your context should not be the reason you stay with one of them.

## What Mida does

Mida is a small service that runs on your machine and a set of permission rules that live on a
public blockchain (Monad testnet).

- **It captures.** Hooks in your agent notice what the session is doing.
- **It summarises.** A model you choose turns the session into a compact **checkpoint**: the
  original request word for word, the goal, progress, decisions with reasons, rejected approaches,
  constraints, and the next step.
- **It encrypts before anything leaves your machine**, and stores only ciphertext.
- **It records who may read it on-chain.** The chain holds *permissions and authorship* — which agent
  may read which kind of context, and which agent wrote each record — never the content.
- **It hands off.** When an approved agent starts a session, Mida prints the latest checkpoint into it.
  You type "Continue."
- **You stay in charge.** Only you approve or revoke an agent. A model never decides access.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/mida-architecture-dark.svg">
  <img alt="How one checkpoint travels: an agent's session events go to the local Mida service, which captures them, has your chosen model summarise them into a checkpoint, encrypts it, stores the ciphertext, and registers its author and fingerprint on Monad. The next agent receives the checkpoint at session start. You approve and revoke agents on Monad. An optional batching lane, off by default, anchors many agent-signed saves in one Monad transaction under one Merkle root." src="docs/architecture/mida-architecture-light.svg" width="100%">
</picture>

<sub>Editable source: [`docs/architecture/mida-architecture.excalidraw`](docs/architecture/mida-architecture.excalidraw) (open it at excalidraw.com).</sub>

---

## Contents

- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Bring your own compile model](#bring-your-own-compile-model)
- [Use Mida from other tools (MCP, SDK)](#use-mida-from-other-tools)
- [Commands](#commands)
- [Configuration](#configuration)
- [Security model and limits](#security-model-and-limits)
- [What it costs to run](#what-it-costs-to-run)
- [What works and what doesn't](#what-works-and-what-doesnt)
- [Repository layout](#repository-layout)
- [Contributing and license](#contributing-and-license)

---

## Quickstart

**You need:** Node.js 22 or later, `pnpm`, and Claude Code and/or Codex. Nothing else: by default Mida
uses a hosted encrypted store and a gas sponsor, so you need no testnet tokens.

**1. Install the CLI.** Until the package is on npm, build and install it from this repository:

```bash
git clone <this repository> mida-context && cd mida-context
pnpm install && pnpm build:publish
cd publish/cli && npm pack
npm install -g mida-context-0.1.0.tgz
mida --help
```

**2. Create your setup.** This makes your owner key and one identity per agent (`claude-code`, `codex`,
and `assistant` — a stand-in for any other assistant), registers them on Monad testnet, and starts
the local service. It is safe to re-run; it only sends what is missing.

```bash
mida init            # or: mida init --passkey   (approve with a passkey in your browser)
```

**3. Wire in your agent and check everything.**

```bash
mida install claude-code      # writes the hook entries into Claude Code's settings
mida doctor                   # one ok / note / PROBLEM line per check; every PROBLEM names its fix
```

**4. Approve both agents for this project folder** — the one that writes checkpoints (Claude Code) and
the one that will continue (Codex). Run these in a real terminal window, inside the project folder.
Approving asks you to type `yes`; an agent cannot do it for you.

```bash
mida request claude-code && mida approve claude-code
mida request codex && mida approve codex
```

An agent that is not approved for the folder saves nothing there, and `mida doctor` says so.

**5. Work, stop, continue.** Work in Claude Code as usual. When you stop (or it runs out), open Codex in
the same folder: the session starts with a `Mida:` block holding the checkpoint. Type **Continue.**

**6. Revoke whenever you like.**

```bash
mida revoke codex      # future reads by codex are refused, on-chain
```

The full walkthrough, with expected output for every step, is [`docs/quickstart.md`](docs/quickstart.md).

---

## How it works

<details>
<summary><b>The path of one checkpoint, step by step</b></summary>

1. **Capture.** When the agent uses a tool, stops, compacts its context, or ends a session, its hook
   (`mida-hook`) writes one small job into a queue folder and pokes the local service (`midad`) over a
   private socket. The hook does nothing slow, so your agent never waits on Mida.
2. **Summarise.** The service reads the session transcript, removes secrets (API keys, private keys,
   passwords, bearer tokens, `…_KEY=value` lines), and sends the text to your compile model, which
   returns the checkpoint as JSON. At most one save per minute per session; the first comes after 10
   seconds, and a session that stops always saves.
3. **Seal.** The checkpoint is encrypted on your machine with a key only approved agents can unwrap.
4. **Store.** The ciphertext goes to the encrypted store — a local one on your machine, or the hosted
   `store.midacontext.xyz`, which only ever sees ciphertext.
5. **Register.** One transaction on Monad records the new checkpoint's author and a fingerprint of its
   content. No content ever goes on-chain.
6. **Hand off.** When an approved agent starts a session, its start hook (`mida-inject`) asks the
   service for a handoff: Mida reads the checkpoints *as that agent*, checking every permission
   against the chain, merges them, and prints the result into the new session.

</details>

<details>
<summary><b>What lives where</b></summary>

| Thing | Where | Who can read it |
|---|---|---|
| Checkpoint content | Encrypted store (local or hosted) | Only agents you approved, with their own keys |
| Permissions, revocations, authorship | Monad testnet contracts | Public (they reveal *that* an agent may read an area, not the content) |
| Your owner key (software mode) | `~/.mida/owner/` on your disk | You |
| Your owner key (passkey mode) | Your passkey; never written to disk | You |
| Agent keys | `~/.mida/agents/` on your disk | That agent's process on your machine |

**Contracts** (`contracts/src`): `CapabilityRegistry` (who may do what: namespaces, agents, owner keys,
capabilities, read-key generations, revocation) and `ContextRegistry` (records of authorship,
provenance and history — fingerprints only). Current testnet deployment:
[`contracts/deployments/10143.json`](contracts/deployments/10143.json).

**Hosted services** (all optional; each can be switched off or self-hosted):

| Service | What it does | What it can't do |
|---|---|---|
| `store.midacontext.xyz` | Holds encrypted objects | Read them — it never has the keys |
| `sponsor.midacontext.xyz` | Pays gas for Mida's own contract calls | Sign, read, grant or revoke anything |
| `app.midacontext.xyz` | The passkey page for signup / approve / revoke | Act without your passkey |

</details>

---

## Bring your own compile model

The compile model is the one part of Mida that reads your session text, so you choose it. Out of the
box Mida tries **DeepSeek** (if `DEEPSEEK_API_KEY` is set), then **Kimi** (if `KIMI_API_KEY` is set),
then **Claude Haiku** through your local `claude` CLI login (no key needed). Any server that speaks the
**OpenAI-compatible chat-completions API** can replace all three — a local model included.

### 1. Point Mida at your model (no code)

```bash
export MIDA_COMPILE_MODEL=custom
export MIDA_COMPILE_BASE_URL=http://127.0.0.1:11434/v1     # e.g. a local Ollama server
export MIDA_COMPILE_MODEL_ID=<the model name your server serves>
# export MIDA_COMPILE_API_KEY=...        optional; sent as "Authorization: Bearer ...", never on the command line
# export MIDA_COMPILE_TIMEOUT_MS=120000  optional
mida doctor                              # prints the active provider and the host the text goes to
```

Rules, checked before the transcript is even read:

- The endpoint must be `https://`, or `http://` on **loopback only** (`127.0.0.1`, `localhost`, `::1`).
- **Choosing `custom` is a privacy decision, so a failed custom compile has no fallback.** Mida will not
  quietly send your transcript to a vendor instead. Set `MIDA_COMPILE_FALLBACK=1` to opt back into the
  vendor chain.
- Environment variables starting `ANTHROPIC_` are stripped from everything Mida starts, so a key in
  your shell cannot silently redirect your transcript.

### 2. The contract your model must meet

**What Mida sends** — one request per save:

```http
POST <MIDA_COMPILE_BASE_URL>/chat/completions
content-type: application/json
authorization: Bearer <MIDA_COMPILE_API_KEY>      # only if set

{ "model": "<MIDA_COMPILE_MODEL_ID>",
  "messages": [ { "role": "user", "content": "<extraction rules + transcript [+ previous checkpoint]>" } ],
  "max_tokens": 8000 }
```

The prompt holds fixed extraction rules, then the session transcript (secrets removed, up to 40,000
characters, as `L<n> <role>:` blocks), then — from the second save on — the previous checkpoint, so the
model updates it instead of starting over. The previous checkpoint goes *last* so providers that cache
prompt prefixes can reuse the unchanged part.

**What Mida expects back:** `choices[0].message.content` containing one JSON object — the checkpoint.
Surrounding text is tolerated; Mida extracts the JSON.

<details>
<summary><b>The checkpoint schema</b> (<code>packages/checkpoint/src/schema.ts</code>)</summary>

Your model writes the ten **content** fields; Mida fills the rest (`eventId`, `agent`, `source`,
`createdAt`) and copies `originalRequest` word for word from the transcript itself — a model never
writes it.

| Field | Type | Limit | Written by |
|---|---|---|---|
| `objective` | string, non-empty | 2,000 chars | model |
| `progress` | string[] | 50 items × 2,000 chars | model |
| `decisions` | `{ decision, rationale }[]` | 50 items | model |
| `rejected` | `{ approach, why }[]` | 50 items | model |
| `constraints` | string[] | 50 items | model |
| `artifacts` | string[] | 50 items | model |
| `unresolvedIssue` | string or `null` | 2,000 chars | model |
| `nextAction` | string, non-empty | 2,000 chars | model |
| `remainingPlan` | string[] | 50 items | model |
| `evidence` | `{ field, ref }[]` | 50 items | model |
| `originalRequest` | string or `null` | 6,000 chars | Mida (copied verbatim) |
| `eventId`, `agent`, `source`, `createdAt` | — | — | Mida |

Unknown keys are rejected. Minimal valid model output:

```json
{
  "objective": "Add rate limiting to the sponsor endpoint",
  "progress": ["Wrote failing tests for the per-IP limit"],
  "decisions": [{ "decision": "Key the limit on the caller IP", "rationale": "Sender addresses are free to create" }],
  "rejected": [{ "approach": "Per-sender limit only", "why": "An attacker can mint unlimited senders" }],
  "constraints": ["Do not change the public API"],
  "artifacts": ["apps/sponsor-worker/src/worker.ts"],
  "unresolvedIssue": null,
  "nextAction": "Implement the limiter binding and run the sponsor tests",
  "remainingPlan": ["Deploy", "Smoke-test the live endpoint"],
  "evidence": [{ "field": "decisions", "ref": "L42" }]
}
```

</details>

**What happens when your model gets it wrong:**

| Your model returns | Mida does |
|---|---|
| Valid checkpoint | Saves it, labelled with the model that wrote it |
| Fields over their limits | Trims them (`…` on long strings; keeps the newest 50 of `progress`/`evidence`, the first 50 elsewhere) instead of failing the save |
| Invalid shape, or no JSON | Retries the **same** model once, then (only if fallback is on) the next configured provider |
| An error, timeout or rate limit | Retries the whole compile up to 3 times, waiting 2 s then 8 s |
| A checkpoint that stays invalid | Gives up on that save after 3 attempts; your session is unaffected |

Everything the model writes is scrubbed for secrets again before it is saved.

### 3. Check that your model works

- `mida doctor` names the active provider, the host your text goes to, and the fallback chain.
- Each save writes one line to `~/.mida/logs/drain.jsonl`: `outcome: "saved"` with `compileMs`,
  `attempts`, `retried` and `fellBack` (which provider actually wrote it), or a failure with a stable
  code and the names of any invalid fields — never your text.
- Read back what was saved: `mida read --as <agent>` shows exactly what that agent can see.

> [!NOTE]
> **Not built yet:** a one-command quality test for a custom model. The benchmark data behind the
> default choice (a fixed transcript with 15 must-keep facts, [evidence](docs/evidence/)) was run
> against the built-in providers only. Until a conformance test exists, check a few real saves by hand
> before trusting a new model.

---

## Use Mida from other tools

**Any MCP client** (Claude Desktop, Cursor, …) can *read* your Mida context through `mida-mcp`, a
read-only adapter: four tools (`mida_handoff`, `mida_whats_new`, `mida_read`, `mida_status`), no keys,
no write tools.

```json
{ "mcpServers": { "mida-claude-desktop": { "command": "/absolute/path/to/mida-mcp", "args": ["--as", "claude-desktop", "--project", "/path/to/project"] } } }
```

Desktop apps start it without your shell environment, so pass a non-default `MIDA_HOME` in `"env"`.
Each client gets its own identity: `mida install claude-desktop` writes this entry for you, then
`mida approve claude-desktop` in the project folder approves it. (`assistant` is the
general-assistant identity — it reads what you `mida remember`, never project context.) Details:
[`docs/quickstart.md` §12](docs/quickstart.md).

**The SDK** (`mida-context-sdk`, not yet on npm) lets your own program act as an agent:

```ts
import { connectAgent, PERMISSION, PROVENANCE_POLICY } from "mida-context-sdk"

const conn = connectAgent({ name: "codex" })          // reads the identity `mida init` created
if (conn.agent.grants.length === 0) {
  await conn.requestAccess({ purposeId: "project_assistance", scopes: [{
    namespace: "projects.current",
    permissions: PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN,
    provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }] })
  process.exit(0)                                      // now run `mida approve codex`
}
await conn.agent.create(conn.owner, "projects.current",
  { kind: "EPISODE", source: "AGENT_INFERRED", value: { note: "written by my script" } })
```

Main methods: `read`, `readWithStatus`, `create`, `supersede`, `propose`, `createAccessRequest`. Every
permission the SDK relies on is re-read from Monad; nothing the store returns is trusted on its own.

---

## Commands

| Command | What it does | Needs a real terminal |
|---|---|---|
| `mida init` / `mida init --passkey` | Create your owner key (file or passkey) and agent identities; start the service | — |
| `mida install <tool>` / `uninstall <tool>` | Add or remove Mida's hooks for `claude-code` or `codex` | — |
| `mida doctor` | Check everything; each problem names its fix | — |
| `mida doctor --live <tool>` | Prove one tool's hooks really fire | — |
| `mida request <agent>` | The agent asks for access | — |
| `mida approve <agent>` | You approve it for this folder (shows the scopes and a risk note; type `yes`) | yes |
| `mida revoke <agent>` | End its access everywhere and rotate the read keys | yes |
| `mida remember "<fact>"` | Tell Mida a fact about you, readable by agents you allow | yes |
| `mida read --as <agent> [area]` | See exactly what that agent can read | — |
| `mida read <agent> <projectId>` | List an agent's checkpoints for a project | — |

`agent` is `claude-code`, `codex`, or `assistant`. "Needs a real terminal" means the command refuses to
run from inside an agent, so an agent cannot approve itself.

---

## Configuration

Every setting is optional. `mida doctor` shows which values are in effect (host names only).

| Variable | Default | Meaning |
|---|---|---|
| `MIDA_HOME` | `~/.mida` | Where Mida keeps its state (absolute path) |
| `MIDA_STORAGE_URL` | hosted store | Encrypted store; `off` = the local store |
| `MIDA_SPONSOR_URL` | hosted sponsor | Gas sponsor; `off` = your wallets pay gas |
| `MONAD_TESTNET_RPC` | public RPC | Monad testnet endpoint |
| `MIDA_COMPILE_MODEL` | `deepseek` → `kimi` → `haiku` | Pin one: `deepseek`, `kimi`, `haiku`, `custom` |
| `MIDA_COMPILE_BASE_URL` / `_MODEL_ID` / `_API_KEY` / `_TIMEOUT_MS` | — | Your own model ([above](#bring-your-own-compile-model)) |
| `MIDA_COMPILE_FALLBACK` | off | `1` lets a custom model fall back to the vendors |
| `DEEPSEEK_API_KEY` / `_BASE_URL` / `_MODEL` / `_TIMEOUT_MS` | — / api.deepseek.com / `deepseek-flash` / 120 s | DeepSeek |
| `KIMI_API_KEY` / `_BASE_URL` / `_MODEL` / `_TIMEOUT_MS` | — / api.moonshot.ai / `kimi-k2.7-code-highspeed` / 120 s | Kimi |
| `MIDA_DEBUG` | off | `1` prints a masked detail line when a command is refused |

A setup keeps the contract, store and sponsor it was created with; the built-in defaults apply only
to a brand-new setup.

---

## Security model and limits

Mida is built on one rule: **your context belongs to you, not to any agent or to Mida.** Here is exactly
what that does and does not protect.

**What it protects**

- Content is encrypted on your machine. The hosted store and the chain never see plaintext.
- Only agents you approved can decrypt, and every read is checked against the chain.
- Only you approve and revoke. Owner commands refuse to run from inside an agent.
- Every record carries its on-chain author, so a handoff says which agent wrote each line.
- Secrets are scrubbed from transcripts before your compile model sees them, and again from its output.

**Its limits — read these before relying on it**

- **Revoking stops future reads. It cannot take back what an agent already read.**
- **Project scoping is enforced on your machine, not on the chain.** The chain grants an agent a kind of
  context (for example, all coding checkpoints); which *folder* it may use is checked by the local
  service against a list you signed. A program already running as you, with an agent's key file, could
  bypass that local check.
- **Software-mode keys are files on your disk.** Passkey mode keeps the owner key off disk; agent keys
  are always files.
- **Your compile model sees your (scrubbed) session text.** Choose it accordingly; a local model keeps
  the text on your machine.
- **The passkey website origin is not checked on-chain** — a documented v0 limitation of the contracts.
- **Testnet only, not audited.** Do not put anything you could not afford to lose in it.

---

## What it costs to run

Each checkpoint save is one call to your compile model plus one Monad transaction. While an agent is
actively working, that can be about one save a minute. On testnet the sponsor pays by default, so
this is free to you; measured on Sep 21, one save cost about 0.03 testnet MON. Costs on a future
mainnet are not measured.

---

## What works and what doesn't

| | Status |
|---|---|
| Set up, approve, save, hand off to a fresh Codex, revoke — live on Monad testnet | ✅ Run once, Sep 22 ([evidence](docs/evidence/m3-live-hosted-2026-09-22.json)) |
| Passkey owner (signup and approval in the browser) | ✅ Run live, Sep 22 ([evidence](docs/evidence/m3-passkey-live-2026-09-22.json)) |
| Hosted encrypted store and gas sponsor | ✅ Live |
| Custom (OpenAI-compatible) compile model | ✅ Supported; quality test not built |
| MCP read-only adapter | ✅ In tests; not yet run against a real MCP client |
| SDK | ✅ On a local chain; not yet on npm |
| Handoff **from Codex to Claude Code** | ❌ Codex sessions are not captured yet |
| Moving a setup to a new contract deployment (`mida migrate`) | 🚧 In progress |
| npm packages | 🚧 Not published yet |
| Security audit | ❌ None |

---

## Repository layout

| Path | What's there |
|---|---|
| `apps/midad` | The local service, the `mida` command, hooks, the MCP adapter |
| `packages/compiler` | Transcript reading, secret scrubbing, the compile call and its fallbacks |
| `packages/checkpoint` | The checkpoint schema, validation, merging and rendering |
| `packages/sdk` | The agent SDK (`connectAgent`, `MidaAgent`) |
| `packages/crypto`, `packages/protocol`, `packages/chain` | Encryption, identifiers and signatures, chain access |
| `contracts` | The Solidity contracts and deployments |
| `apps/store-worker`, `apps/sponsor-worker`, `apps/owner-page` | The hosted store, gas sponsor and passkey page |
| `docs/quickstart.md` | The full walkthrough with expected output |
| `docs/superpowers/specs` | Design documents |

Development: `pnpm install`, then `pnpm test` (the whole suite) and `pnpm typecheck`. Node 22+.

## Contributing and license

Issues and pull requests are welcome once the repository is public. Please run `pnpm test` and
`pnpm typecheck` before opening one.

**License: not chosen yet.** Until a license file is added, no rights are granted to use, copy or
modify this code.
