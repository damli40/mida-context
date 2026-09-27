# Mida quickstart — 15 minutes from `npm install` to a shared, revocable memory

You use more than one AI coding agent, and every time you switch, the new one starts blank — you are the API between them. Mida gives the agents you approve a shared, encrypted context store on Monad testnet, so a checkpoint saved by one agent is readable by the next. This guide installs it, approves two agents, and watches the second one continue the first one's work.

Each step is marked **RUN** (the implementer ran it) or **NOT RUN** (verified in code/tests only — the live Monad testnet path was not exercised end-to-end in this environment).

## 0. What you need

- Node.js 22 or later (`node --version`)
- Codex and/or Claude Code installed (the hooks work with either; the demo uses Codex then Claude Code)
- Nothing else — the hosted store (`store.midacontext.xyz`) and gas sponsor (`sponsor.midacontext.xyz`) are the defaults, so no testnet MON is needed on the happy path

## 1. Install the CLI — RUN

Until the package is published, pack it from the repo and install the tarball:

```bash
cd mida-context
pnpm install && pnpm build:publish
cd publish/cli && npm pack
npm install -g mida-context-0.1.0.tgz
```

Expected output (the file count may differ; the bin links are the point):

```
npm notice === Tarball Contents ===
npm notice package size: ~95 kB
npm notice total files: 10
added 1 package in ~2s
```

Then confirm it is on your PATH:

```bash
mida --help
```

Expected output:

```
usage: mida init | install <tool> | uninstall <tool> | doctor [--live <tool>] | request <agent> | approve <agent> | approve --all | save-demo <agent> <projectId> | read <agent> <projectId> | read --as <agent> | remember <fact> | remember --replaces <id> <fact> | revoke <agent> | revoke --all | link <folder> | unlink | project new | batching on|off | migrate [--undo]   (tool = claude-code | codex | devin | claude-desktop | cursor; agent = claude-code | codex | devin | assistant — or the identity a client installs)
```

*Status: RUN — `pnpm check:publish` installs the packed tarball into a fresh folder outside the repo and runs `npx mida --help` to exit 0 with this text. The `-g` global-install variant links the same bins through npm's standard path.*

## 2. Create your vault and register the agents — NOT RUN on testnet

```bash
mida init
```

What it does: generates your owner wallet and one identity per agent (`claude-code`, `codex`, `assistant`), registers them on Monad testnet, and starts the local daemon (`midad`). With the sponsor on — the default — every send is paid by the sponsor; your wallets can stay empty. (Devin is not among them: `mida install devin` registers that identity when you install the tool.)

Expected output:

```
registering your key on the chain…
opening 3 context areas (3 transactions)…
registering claude-code on the chain…
registering codex on the chain…
registering assistant on the chain…
owner 0x<40 hex>
agent claude-code 0x<64 hex>
agent codex 0x<64 hex>
agent assistant 0x<64 hex>
```

`mida init` is safe to re-run: identities and context areas that already exist are reused, and only missing sends go out.

**If the sponsor refuses or you turned it off** (`MIDA_SPONSOR_URL=off`), your owner wallet pays its own gas and init stops with:

```
your owner wallet cannot pay for the setup — send at least 0.5 testnet MON to this address, then run `mida init` again: 0x<your owner address>
```

Send the MON (a Monad testnet faucet), re-run `mida init`, and it resumes where it stopped.

*Status: NOT RUN on the live testnet — the init flow is covered end-to-end on a local Anvil chain by `apps/midad/test/skeleton.e2e.test.ts`, including the unfunded-owner resume path in `init-self-fund.test.ts`.*

## 3. Sanity-check the install — RUN

```bash
mida doctor
```

One `ok:` / `note:` / `PROBLEM:` line per check — daemon, network, owner, agents, hooks, wallets, services, sponsor, environment. The lines that matter here (hosts only — a URL's path or query could carry a key, so doctor never prints one):

```
ok: store: store.midacontext.xyz (default)
ok: sponsor: sponsor.midacontext.xyz (default)
ok: gas sponsor sponsor.midacontext.xyz answers (… signings per address a day, … a day in total)
```

A `PROBLEM:` line always ends with its fix (`— npm i -g mida-context`, `— run mida init`, …). Exit code is the number of problems, capped at 9.

*Status: RUN — `pnpm check:publish` runs `npx mida doctor` on an empty `MIDA_HOME` and asserts it prints checks with no stack trace.*

## 4. Install the hooks for Codex — NOT RUN

```bash
mida install codex
```

Expected output:

```
installed
Codex will ignore these hooks until you trust them: open codex, type /hooks, and trust the Mida entries.
```

(`mida install claude-code` is the same shape; it prints just `installed` because Claude Code needs no trust step.)

*Status: NOT RUN — it edits `~/.codex/config.toml`, which I did not want to touch on this machine. The managed-block format and idempotent re-install are covered by `apps/midad/test/install.test.ts`.*

## 5. Trust the hooks — NOT RUN

Open Codex and type `/hooks`. Trust the Mida entries. Until you do, Codex silently ignores them — there is no error, so this step is easy to miss.

*Status: NOT RUN — it is a UI interaction inside Codex.*

## 6. Request access for the agent — RUN (filed by the SDK path too)

In the project folder you want Codex to work in:

```bash
mida request codex
```

Expected output:

```
requested codex 0x<64 hex>
```

*Status: RUN on local Anvil — `connect.e2e.test.ts` files this request through the packaged SDK surface and the same on-disk format, then `mida approve` completes it.*

## 7. Approve it — NOT RUN

Still in that project folder, in your own terminal (approval is an owner command — it never runs through the daemon):

```bash
mida approve codex
```

You see exactly what is being granted before anything is signed:

```
codex is asking for:
  profile.skills: READ
  preferences.communication: READ
  projects.current: READ + CREATE + SUPERSEDE_OWN
  until <ISO timestamp>
grant advisor: low risk; recommends 3 scope(s) until <ISO timestamp>
Type yes to approve:
```

Type `yes` — a passkey prompt may follow depending on your vault — then:

```
approved codex tx 0x<64 hex> gas <number> project <projectId>
```

*Status: NOT RUN interactively — the same approve is driven programmatically in the e2e suite, including the approval preview and the `Type yes` gate.*

## 8. Start the session and see the `Mida:` line — NOT RUN

Still in that folder:

```bash
codex
```

On session start the hook injects one line into the agent's context. With nothing saved yet:

```
Mida: connected. Nothing has been saved for this project yet.
```

Work for a bit. The SessionEnd hook saves a compact checkpoint when you leave — the agent does not have to remember to do it.

*Status: NOT RUN — needs a real Codex session. The injected text is asserted in hook tests (`hook-output.ts`, `handoff.ts`).*

## 9. Kill it, then continue in the other agent — NOT RUN

Ctrl-C the Codex session. Then:

```bash
mida install claude-code   # once — if you have not already
mida request claude-code
mida approve claude-code   # same preview; type yes
claude
```

Type only:

```
Continue.
```

Claude Code's session starts with a `Mida:` line carrying the checkpoint Codex saved — objective, progress, decisions, constraints, next action — and continues the task from there.

*Status: NOT RUN end-to-end with real agents — the save-then-read-across-agents flow is the M0 walking skeleton (`skeleton.e2e.test.ts` steps 5–8).*

## 10. Revoke — NOT RUN

```bash
mida revoke codex
```

```
revoked codex on chain — tx 0x<64 hex>
This stops future reads through Mida. It does not erase what codex already read.
new read key sent to claude-code
```

Codex is refused on its next read or write; the remaining agents keep access through a rotated key. Revoking one client isolates exactly that client — `mida revoke claude-desktop` stops Claude Desktop and leaves Cursor untouched.

The batch forms save a repeated round: `mida approve --all` lists every pending request, asks for one typed `yes`, then approves each in turn — a failure names its agent and does not stop the rest. `mida revoke --all` is the same shape for every agent that holds an approval:

```bash
mida approve --all     # one list of every pending request, one yes
mida revoke --all      # one list of every approved agent, one yes
```

In passkey mode the same commands exist, but the passkey still signs once **per agent** — the batch asks the terminal once, never the page once.

Mida keeps your context encrypted until an approved agent asks for it. When it does, Mida decrypts what that agent may read and hands it to the model as plain text. Revoking stops every future read through Mida. It cannot make a model forget what it was already shown.

## 11. Remember a fact — and replace one — RUN on local Anvil

`mida remember` writes an owner-signed fact — the chain records you, not any agent, as its author — into a context area every approved agent may read. In your own terminal (it is an owner command, like `approve` — it never runs through the daemon):

```bash
mida remember "I prefer Python"
```

```
area: preferences.communication (agents with READ on this area will see it)
Type yes to remember:
remembered 0x<64 hex> in preferences.communication
```

Type `yes` at the ask. Facts live in `preferences.communication` (the default shown above) or `profile.skills`. Every fact `mida read --as <agent>` prints carries the date the chain stamped on its record and a short id — the first 8 hex characters of the record's id:

```
What you have told Mida about yourself
  preferences.communication: I prefer Python (id a1b2c3d4, 2026-09-27 14:03 UTC)
```

When a fact changes, replace it instead of stacking a second opinion. `--replaces` names the old fact by its short id; the new fact is written through the registry's supersede path, so the chain itself records new-replaces-old and the old record stays anchored as history:

```bash
mida remember --replaces a1b2c3d4 "I prefer TypeScript now"
```

The same preview and typed-`yes` ask apply. Afterwards the handoff an agent receives lists only the current fact — `I prefer TypeScript now` with its own date — while `mida read --as <agent>` keeps both lines, marking the old one `(replaced by e5f6a7b8 on 2026-09-27 14:12 UTC)`. An id that names no fact, or more than one, refuses before the ask; so does an id that names a fact already replaced.

*Status: RUN on local Anvil — `apps/midad/test/fact-replace.e2e.test.ts` writes Python, replaces it with TypeScript through the real `runCli` path, then checks the chain's parent/lineage record, the handoff's single-fact output and the `read --as` history marker.*

## 12. The SDK path — RUN on local Anvil

Everything above is driven by the CLI. The same lifecycle — request, approve, write, read, revoke — is reachable from your own process through `mida-context-sdk`. Install it next to the CLI (`npm i mida-context-sdk`, or the packed tarball), then:

```js
// agent.mjs — run twice: once to request, once after `mida approve codex`
import { connectAgent, PERMISSION, PROVENANCE_POLICY } from "mida-context-sdk"

const conn = connectAgent({ name: "codex" })               // the home `mida init` made
if (conn.agent.grants.length === 0) {
  await conn.requestAccess({                               // files the request `mida approve` completes
    purposeId: "project_assistance",
    scopes: [{ namespace: "projects.current",
               permissions: PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN,
               provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
  })
  console.log("requested — run `mida approve codex`, then run this script again")
  process.exit(0)
}
try {
  const saved = await conn.agent.create(conn.owner, "projects.current",
    { kind: "EPISODE", source: "AGENT_INFERRED", value: { note: "written by my script" } })
  console.log("wrote", saved.contextId)
  console.log("readable:", (await conn.agent.read(conn.owner, "projects.current")).length, "record(s)")
} catch (error) {
  console.log("refused:", error.code)                      // CAPABILITY_DENIED after `mida revoke codex`
}
```

Run it — the SDK is plain bundled ESM, so no tsx, no build step:

```bash
node agent.mjs
```

- **First run** — `requested — run mida approve codex…`, and `mida approve codex` picks the request up.
- **Second run** — `wrote 0x<64 hex>` then `readable: 1 record(s)`.
- **After `mida revoke codex`** — `refused: CAPABILITY_DENIED` (or `CAPABILITY_REVOKED`).

`connectAgent` reads the identity, grants and `network.json` the CLI wrote, so the SDK and the CLI always agree on which store, sponsor and deployment are in use. For an agent that has never been through `mida init`, pass `identity` + `owner` explicitly instead of `name` — see `ConnectOptions` in the SDK's `index.d.ts`.

*Status: RUN on local Anvil — `apps/midad/test/connect.e2e.test.ts` executes this exact sequence (connect → request → `mida approve` → create → read → `mida revoke` → refused) against a fresh chain, and `pnpm check:publish` runs and type-checks an SDK consumer installed from the packed tarball. NOT RUN on the live testnet.*

## 13. Use Mida from an MCP client — NOT RUN against any real client

Agents that speak MCP instead of hooks — Claude Desktop and Cursor — reach the same daemon through `mida-mcp`: a local MCP server that is a client of the midad socket, exactly like the hooks. It holds no keys and signs nothing.

Every client connects under **its own identity** — `--as` is required and `assistant` is refused, because a general assistant can never hold a project approval. `mida install <client>` does both halves: it registers a project-context identity named after the client and merges one `mcpServers` entry into that client's MCP config (everything already in the file is kept; the first change leaves a one-time `.mida-backup`). Approving, isolating and revoking then act on exactly that one client — `mida approve claude-desktop` never touches `cursor`'s access.

The disclosure model is the same as everywhere else:

Mida keeps your context encrypted until an approved agent asks for it. When it does, Mida decrypts what that agent may read and hands it to the model as plain text. Revoking stops every future read through Mida. It cannot make a model forget what it was already shown.

**Claude Desktop — NOT RUN.** Run in the project folder; install merges the `mida-claude-desktop` entry into `claude_desktop_config.json` (Settings → Developer → MCP servers shows it) and registers the `claude-desktop` identity:

```bash
mida install claude-desktop
mida approve claude-desktop
```

The written entry — desktop clients start the server **without your shell's environment and not in your project folder**, so the home and the project are both explicit:

```json
{
  "mcpServers": {
    "mida-claude-desktop": {
      "command": "<absolute path to mida-mcp>",
      "args": ["--as", "claude-desktop", "--project", "<folder where install ran>"],
      "env": { "MIDA_HOME": "<the Mida home>" }
    }
  }
}
```

**Cursor — NOT RUN.** Run in the workspace folder; install merges the `mida-cursor` entry into `.cursor/mcp.json` and registers the `cursor` identity:

```bash
mida install cursor
mida approve cursor
```

Cursor's `--project` is written as the literal `${workspaceFolder}`, which Cursor resolves per window:

```json
{
  "mcpServers": {
    "mida-cursor": {
      "command": "<absolute path to mida-mcp>",
      "args": ["--as", "cursor", "--project", "${workspaceFolder}"],
      "env": { "MIDA_HOME": "<the Mida home>" }
    }
  }
}
```

**Codex CLI — NOT RUN.** No MCP entry is needed: the Codex CLI uses the `codex` identity through the hooks `mida install codex` already writes (section 4). The old Codex app is now a tab inside the ChatGPT desktop app — whether Mida's plain config hooks fire there is untested, so the app is not a supported client in v0. Browser ChatGPT is not supported either.

**Any MCP harness — NOT RUN.** Every stdio config is the same block in a different file: `command` names the `mida-mcp` launcher by absolute path (`<repo>/bin/mida-mcp` from a source checkout finds node for you — PATH, then the usual install spots, then the newest `~/.nvm` version), `args` is `["--as", "<a registered client identity>", "--project", "<project folder>"]`, `env` carries `MIDA_HOME`. Any registered name works — `mida-mcp` refuses `--as` values it cannot serve, so the identity must exist in the home first.

Windsurf keeps that block in `~/.codeium/windsurf/mcp_config.json`, VS Code in `.vscode/mcp.json`, Zed in `settings.json` under `context_servers`, and Gemini CLI in `~/.gemini/settings.json` under `mcpServers` — check each client's own MCP docs for the exact file. None of them is validated against Mida yet.

`--as` is startup configuration: it names one registered identity and no tool call can change it — the tools carry no identity field. Revoking is per client: `mida revoke claude-desktop` stops Claude Desktop's reads and writes and leaves Cursor untouched; `mida approve --all` and `mida revoke --all` act on every agent at once after one confirmation (in passkey mode the page asks once per agent — signatures are never batched). `mida uninstall <client>` removes only the config entry — the identity and its approvals stay until `mida revoke <client>`.

The server refuses to start — one line on stderr, exit 2, nothing on stdout — in the cases that would otherwise read as "not approved" forever:

- `mida-mcp needs --as <client>: the client's own identity. This home knows: <names> — give each client its own: mida install <client>` — no `--as` was given; the listed names are the identities this home already holds.
- `mida-mcp: assistant is a general assistant and cannot read project context — run: mida install <client>` — `assistant` never holds a project approval, so a client configured with it could never read this folder.
- `mida-mcp: no agent "<name>" is set up in the Mida home <home> — check MIDA_HOME in this client's config` — the `--as` identity is not registered in the home the config points at (usually a wrong `MIDA_HOME`, or `mida install <client>` never ran).
- `mida-mcp: <dir> is not a Mida project folder — start the server with --project <your project folder>` — the folder the client launched the server in carries no Mida project marker; pass the project explicitly.

**macOS: desktop apps cannot run anything under Desktop, Documents or Downloads.** Install Mida and keep the MCP project folder outside those directories — macOS privacy protection refuses the launch, and the server says so at startup instead of pretending the home is empty:

- `mida-mcp: <mida home>/agents/<client>/identity.json could not be read (the system refused access). If it is under Desktop, Documents or Downloads, macOS blocks desktop apps from it — move Mida or the project out of those folders.`
- `mida-mcp: <project folder> could not be read (the system refused access). If it is under Desktop, Documents or Downloads, macOS blocks desktop apps from it — move Mida or the project out of those folders.`

The model keys used for compiles live in the daemon, not in this server: start the daemon from a terminal that has them (any `mida` command does), and the MCP server reuses it over the socket; a daemon the client spawns itself would have no keys and could not compile.

The client then sees five tools — `mida_handoff` (the same text a session-start hook would inject), `mida_whats_new` (the per-prompt note), `mida_read` (a context namespace), `mida_status` (health plus each agent's verdict for this folder) and `mida_save`. `mida doctor` prints `ok: mida-mcp resolves to <path>` once the package is installed.

`mida_save` is the one write: the model fills the ten checkpoint fields (objective, progress, decisions, rejected, constraints, artifacts, unresolvedIssue, nextAction, remainingPlan, evidence — plus an optional `originalRequest` carrying the user's own words, up to 6,000 characters) and sends them to the daemon over the socket. The adapter still holds no keys — `midad` validates the shape and names any field it does not know, scrubs secrets with the same scrubber the transcript compiler uses, checks the same gates a read passes (registered MCP identity → this folder is approved for it → the chain grant includes CREATE on the project area → not revoked), then seals, stores and registers the checkpoint signed as the client's own identity. Every save by one client in one project chains under one stable session id, so a later handoff merges them as a single history. A client the owner approved for READ only gets the actionable line instead: `<name> can read but not write here — run \`mida request <name>\` and \`mida approve <name>\` to add write access`. The approval a client needs is the one `mida approve <client>` already grants — its access request asks for READ | CREATE | SUPERSEDE_OWN on the project area.

The honest limits:

- **Local only.** It is stdio on this machine, talking to midad's Unix socket — there is no remote MCP endpoint to point a hosted client at.
- **One save per minute per client per project.** The daemon enforces it (a looping model cannot spend the sponsor's gas); a refused save says when the next one is allowed.
- **No owner operations.** A model cannot approve, revoke, request or remember through MCP — there is no tool and no socket route for those; only the checkpoint write above.
- claude.ai web and mobile: not supported in v0 — they only call public HTTPS servers from Anthropic's cloud, and Mida does not run one.
<!-- revisit if spike S4 passes (plan Task 10) -->
- **ChatGPT — NOT RUN, and not supported in v0.** Browser ChatGPT has no local stdio transport Mida can serve. The ChatGPT desktop app now hosts the old Codex app as a tab — whether plain config hooks fire there is untested, so it is not a supported client in v0 either.

*Status: NOT RUN against a real MCP client — `apps/midad/test/mcp.test.ts` drives the server over the SDK's in-memory transport against a fake daemon socket (including the not-approved, revoked and daemon-down answers), `apps/midad/test/mcp.e2e.test.ts` runs the reads against a real daemon on a local Anvil chain, and `apps/midad/test/mcp-save.e2e.test.ts` runs `mida_save` end to end the same way (a real save another agent's handoff then sees, the READ-only / unapproved / revoked / bad-shape / rate-limit refusals, and secret scrubbing before sealing). No client above has been validated end-to-end.*

## 14. Devin — a third hook client — NOT RUN

Devin is a hook client like Codex, not an MCP client: `mida install devin` merges Mida's hook block into `~/.config/devin/config.json` (under `"hooks"`, the same shape as Claude Code's block — session start and prompts run `mida-inject devin`; `PostToolUse`, `Stop`, `PostCompaction` and `SessionEnd` run `mida-hook devin`). `mida install devin` is an owner command — it also registers the `devin` identity on the chain (one transaction), so no separate `mida init` step provisions it — and the identity is its own: `mida approve devin` / `mida revoke devin` act on it alone. There is no trust step.

```bash
mida install devin
mida approve devin
```

Devin's hooks have no transcript file and no `cwd` in the payload: the project folder comes from `DEVIN_PROJECT_DIR`, and sessions are read back from Devin's SQLite store `~/.local/share/devin/cli/sessions.db` (read-only; `MIDA_DEVIN_DB` points elsewhere in tests). Two consequences worth knowing:

- **Devin also replays other clients' hooks.** It imports `~/.claude/settings.json` and would run Mida's Claude Code entries under its own environment — which is why every Mida hook entry for a non-devin agent exits silently when `DEVIN_PROJECT_DIR` is set. A Devin session can never be saved under `claude-code`'s name.
- **Node 22.13+ is required** for the database read (`node:sqlite`). On an older Node, `mida doctor` prints a `PROBLEM:` line and devin save jobs end `bad` with reason `devin-needs-node-22.13`.

*Status: NOT RUN against a real Devin — every test uses synthetic payloads and a synthetic SQLite file (`apps/midad/test/devin.e2e.test.ts`, `apps/midad/test/drain-devin.test.ts`, `packages/compiler/test/transcript-devin.test.ts`). No real `~/.config/devin` or `~/.local/share/devin` was touched.*

## One project, several folders

A project is its `.mida/project.json` marker, not a single folder. When you ask Mida which project a
folder belongs to, **the nearest `.mida/project.json` walking up the tree wins** — a marker in the
folder itself beats one in a parent, and nothing looks further up once one is found. That one rule
decides everything below.

Normally one project is one folder. But the same work can live in several places — a git worktree, a
second clone, a folder you copied. Approving every folder as its own project splits the history: a
checkpoint saved in one would never surface in the other. `mida link` joins them into one project
instead.

```bash
cd <the second folder>          # run INSIDE the folder being added
mida link <any folder in the project>   # join the project that <folder> belongs to
```

It shows the project id, the project's marker folder, this folder's canonical path and every agent
already approved for the project, asks `Type yes to link:`, then writes this folder's marker with
the project's id and adds one owner-signed approved-folder row per agent. No transaction, nothing
sent — the signed approval list is local data, so a link costs no gas. From then on a handoff saved
in one folder is what an agent receives in the other. Repeating the link — or typing the same folder
as a relative path, `~/…` or a symlink — changes nothing.

A folder that already carries a different project's marker — say a worktree approved before you
linked it — is a **folder move**: `mida link` shows what the folder leaves (the old project's id,
its folder and saved-checkpoint counts) and confirms `Continue? Type yes:`, then moves the folder's
signed rows to the new project and flips its marker, all or nothing. The old project's history stays
exactly where it is — nothing is copied into the new project or appears in its handoffs.

```bash
mida unlink    # inside a linked folder: its rows leave the signed list and its marker goes
```

Unlink removes this folder's approval rows for every agent and its `.mida/` marker — the project,
its other folders and everything saved to them are untouched. It refuses the project's only folder:
unlinking that would orphan the project, so there is nothing to unlink.

```bash
mida project new   # inside any folder: start a separate project HERE
```

`project new` writes a fresh project id in this folder's own marker, even inside another project's
tree. Because the nearest marker wins, the new marker makes this folder — and everything under it —
stop using the parent's project, which is why it names that parent and asks `yes` first. The parent
keeps every row and record it had; agents must be approved for the new project separately, as usual.
A folder that is already its own project refuses (unlink or `project new` at the right level first);
the owner's home folder and `/` refuse outright.

All three are owner commands like `approve` — real terminal only, never the daemon. `mida doctor`
shows one line per project with every folder its rows cover (`ok: project ae3e5609… — 2 folders
(…/a, …/b)`), and a `PROBLEM` naming the fix — `mida unlink` or removing the row — when a listed
folder no longer exists.

*Status: NOT RUN interactively — the commands and their refusals are covered by
`apps/midad/test/projects.test.ts` and `apps/midad/test/cli.test.ts`; the
handoff-across-folders proof is `apps/midad/test/link.e2e.test.ts` on local Anvil.*

## The compile model: DeepSeek by default — RUN (benchmarked)

Every checkpoint save runs one compile call: the session's transcript text (secrets scrubbed first) goes to a model that returns the compact checkpoint. You choose the provider:

| Provider | You set | Model | Measured on the same transcript |
|---|---|---|---|
| **DeepSeek — default** | `DEEPSEEK_API_KEY` | `deepseek-flash` | **7.9 s median**, 15/15 checks, 3/3 runs |
| Kimi | `KIMI_API_KEY` | `kimi-k2.7-code-highspeed` | 10.4 s median, 15/15, 3/3 |
| Claude Haiku | nothing — uses your `claude` CLI login | `claude-haiku` | 22.6 s median, 15/15, 3/3 |

With no keys at all the compiler is Haiku through the `claude` CLI — no extra setup, just slower. Set `DEEPSEEK_API_KEY` and DeepSeek takes over: it is roughly 10× cheaper than the others and has no fixed requests-per-minute cap. (DeepSeek charges double during UTC weekday mornings — even at peak it stays far below the alternatives.) If a call fails — rate limit, 5xx, timeout, or output that is not usable JSON — the compile walks to the next provider that is configured, ending at Haiku; each provider is tried at most once per compile and the checkpoint records which one actually wrote it. Compiles after the first one reuse the provider's prompt cache (DeepSeek and Kimi do this automatically); `~/.mida/logs/drain.jsonl` shows `cacheHit` per compile.

`MIDA_COMPILE_MODEL` pins the choice: `deepseek` | `kimi` | `haiku` | `custom`. Per-provider overrides: `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `DEEPSEEK_TIMEOUT_MS`, and the same trio for `KIMI_*`. `mida doctor` prints which provider is active, which host the text goes to, and the fallback chain — hosts only, never a full URL (its path could carry a key).

*Measured numbers and method: `docs/evidence/compile-model-speed-deepseek-2026-09-22.json` (DeepSeek) and `docs/evidence/compile-model-speed-2026-09-21.json` (Kimi, Haiku) — same 62-line transcript, 15 must-keep items checked per run. `deepseek-v4-pro` was benchmarked and rejected (~70 s, one no-JSON failure) — it is not offered.*

### Run your own compiler

Point the compile call at any OpenAI-compatible endpoint — a local Ollama-style server is the example:

```bash
MIDA_COMPILE_MODEL=custom
MIDA_COMPILE_BASE_URL=http://127.0.0.1:11434/v1
MIDA_COMPILE_MODEL_ID=<the model name your server serves>
# MIDA_COMPILE_API_KEY=…   optional — a local server usually needs none
```

http is allowed only on loopback (`127.0.0.1`, `localhost`, `::1`) — a remote endpoint must be https. Choosing `custom` is a privacy decision: **a failed custom compile has no fallback** — Mida will not silently send your transcript to a vendor — unless you set `MIDA_COMPILE_FALLBACK=1` to opt back into the vendor chain.

The honest limit: Mida cannot judge a custom model's output quality. The benchmark harness under `bench/` (the same transcript + 15 must-keep checks the numbers above come from) is how you check yours before trusting it.

## Defaults and overrides

| Setting | Default | Override | `"off"` means |
|---|---|---|---|
| Context store | `https://store.midacontext.xyz` | `MIDA_STORAGE_URL` | the local store the daemon serves |
| Gas sponsor | `https://sponsor.midacontext.xyz` | `MIDA_SPONSOR_URL` | wallets pay their own gas (testnet MON needed) |
| Mida home | `~/.mida` | `MIDA_HOME` | — |
| Monad testnet RPC | public endpoint | `MONAD_TESTNET_RPC` | — |
| Compile model | `deepseek` if `DEEPSEEK_API_KEY` is set, else `kimi`, else `claude-haiku` | `MIDA_COMPILE_MODEL` | — |

`mida doctor` shows which are in effect — host names only, never values that could be secrets.

## Troubleshooting (found in live runs)

Each entry: what you see, what it means, what to do. First seen in the Sep 27, 2026 live test unless noted.

**Claude Desktop: "MCP mida-claude-desktop: Server disconnected".**
Look in `~/Library/Logs/Claude/mcp-server-mida-claude-desktop.log`. If it says
`/bin/sh: …/bin/mida-mcp: Operation not permitted`, macOS is blocking Claude Desktop from reading the folder Mida
runs from. macOS protects `~/Desktop`, `~/Documents` and `~/Downloads`. Terminal has access, so hook clients work;
Claude Desktop is a separate app and does not. Fix one of two ways: give Claude Desktop access (System Settings →
Privacy & Security → Files and Folders → Claude → turn on the folder, e.g. Desktop Folder), then quit Claude
Desktop with Cmd-Q and reopen it; or run Mida from a folder outside those three (an npm global install puts
`mida-mcp` outside them). Cursor and other desktop apps can hit the same wall. On macOS, `mida install
claude-desktop` and `mida install cursor` warn at install time when the launcher they write lives under one of
those folders — the warning names both fixes — and `mida doctor` repeats the note for an installed entry.
The warning only prints when the launcher's real path is under a protected folder; installing elsewhere stays quiet.

**`mida doctor`: "codex's hook block is an older version", right after you trusted the hooks in Codex.**
Fixed. When you trust hooks, Codex writes its trust records (`[hooks.state]`, `trusted_hash`) inside Mida's marked
block; doctor now ignores Codex's state and reports the block as installed, and `mida install codex` /
`mida uninstall codex` preserve the trust records (including other tools' records) instead of rewriting them away.

**"<agent>'s request has expired (a request lasts 5 minutes)".**
Run `mida request <agent>`, then `mida approve <agent>` straight away. `mida install devin` files a request too; if
you approve later than 5 minutes after it, request again first. `mida doctor` says the same: an expired request
gets "run `mida request <agent>`, then `mida approve <agent>` right away", not the approve-only line.

**`mida request <agent>` says "already approved on chain".**
That agent already holds a grant. To use it in a new folder, run `mida approve <agent>` in that folder: it adds the
folder, with no transaction and nothing to pay. This is guidance, not a failure — the command exits 0, so a chain
like `mida request a && mida request b` keeps going.

**`mida approve` sits at "sending the grant (about 5 seconds)…" for much longer.**
Every send now prints "still waiting for Monad (N s)…" every 15 seconds and gives up after 120 seconds with a
message that says only what is true: a known transaction hash means "sent as 0x…, not confirmed yet" — the first
transaction may still be pending, and a rerun checks only mined state, so the message tells you to wait a minute,
run `mida doctor`, and not run the command again until it shows the result; with no hash the line is either "the
send may still have gone out — check with `mida doctor` first, don't rerun yet" or, when the hang was provably
before broadcast, "nothing was sent: run the same command again". Once `mida doctor` shows the outcome, the same
command is safe: it asks the chain what the agent already holds before sending, so a grant that already landed is
not sent twice. Ctrl-C still works, and the same advice applies after it.

**`mida doctor`: "midad runs … @ <old commit>; this command runs … @ <new commit>".**
The Mida service is still the old version after an update. Run any `mida` command; it replaces the service.

**`mida read <agent> <projectId>`: "project-mismatch: this folder is approved for …".**
Each folder has its own project id, in `.mida/project.json`. Use that id, or run the command from the folder the
project belongs to.

**`mida doctor`: "store: local (this setup saved no store address)" / "sponsor: none — this setup pays its own gas".**
A setup keeps the store and gas settings it was created with. New setups use the hosted store and the gas sponsor
by default (the table above); a setup made before those defaults stays local and pays its own gas, so its earlier
records stay where they are. Every grant and revoke then spends your wallet's testnet MON (about 0.09 MON per grant
and 0.055 per revoke on Sep 27). Moving an existing setup to the hosted store is on the roadmap.
