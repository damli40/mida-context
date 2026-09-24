# Client adapters — the final v0 integration design (Sep 22, 2026)

**Status:** design written from Dami's final brief (Sep 22). Migration is out of scope (another
session owns it). After this and migration land, the build is frozen.

**One sentence:** Mida reaches AI clients through exactly two adapters — hooks for the agents that
let Mida take part in their session (Claude Code, Codex), and one read-only local MCP server for
everything else (Claude Desktop, Cursor, ChatGPT where it can reach a local server) — and this work
makes both of them honest and proves them against real clients.

> Hooks make Mida automatic. MCP makes Mida portable.

Evidence labels used throughout: **PROVEN** (run live against the real thing), **TESTED WITH FAKE**
(automated test against a stand-in), **INFERRED** (read from code or docs, not run), **UNPROVEN**
(claimed somewhere, nothing supports it yet).

---

## 1. Verdict on the two-adapter design

**Confirmed.** The code already has exactly this shape; no protocol change is needed.

- Hooks: `apps/midad/src/hook.ts` (capture), `inject-main.ts` (handoff + what's-new),
  `install.ts` (writes them into Claude Code's and Codex's settings). All talk to one daemon over a
  private Unix socket.
- MCP: `apps/midad/src/mcp.ts` + `mcp-main.ts`, a stdio server that is another client of the same
  socket. It imports no key module (an import-graph test enforces this) — **TESTED WITH FAKE**
  (`apps/midad/test/mcp.test.ts`).
- Reads never need the owner key. The daemon decrypts with the reading agent's own key
  (`agents/<name>/identity.json` + `grants.json`); the owner key is only loaded by the terminal
  `mida` command — **INFERRED** from `runtime.ts:286-291, 392-406`.

So MCP is another way to consume the same protocol state, as the brief requires. It is not another
memory system and holds no signing authority.

## 2. What is actually proven today

| Claim | Label | Source |
|---|---|---|
| Claude Code: capture + handoff + what's-new via hooks | **PROVEN** | `docs/evidence/m3-live-hosted-2026-09-22.json` |
| Codex: handoff INTO Codex on "Continue." | **PROVEN** | same file |
| Codex: capture OUT of Codex | **PROVEN BROKEN** | same file, limits: "Stop hook was ignored (bad-transcript-path)" |
| Codex desktop app / IDE extension run the same hooks as the CLI | **INFERRED** | OpenAI docs say they share `~/.codex/config.toml`; never run |
| Codex has a SessionEnd hook | **UNPROVEN** (conflict) | docs list it; our Sep 20 spike saw none |
| `mida-mcp` four tools, refusals, read-only | **TESTED WITH FAKE** | `mcp.test.ts` (hand-rolled fake daemon socket) |
| `mida-mcp` against a real daemon + real chain | **UNPROVEN** | no test does it |
| Claude Desktop reads Mida | **UNPROVEN** | quickstart §12 says "NOT RUN against a real MCP client" |
| Cursor reads Mida | **UNPROVEN** | Cursor is not installed on this machine |
| Codex reads Mida through MCP | **UNPROVEN** | quickstart §12 claims it; Sep 20 spike: Codex never found the tool unprompted |
| ChatGPT reads Mida | **UNPROVEN** | nothing built or run |
| Quickstart §12: wrong `MIDA_HOME` makes every tool say "not approved" | **INFERRED, probably incomplete** | `mcp-main.ts` calls `ensureDaemon`, which starts a key-less daemon in the wrong home; result depends on that home's state |
| `mida doctor` "ok: mida-mcp resolves" | **PROVEN, but weak** | it checks only that the file exists, never that it answers |

## 3. The defects this design fixes (all found in the code, Sep 22)

**D1 — `--as` is a closed list.** `mcp.ts:23` accepts only `claude-code | codex | assistant`, so
`--as chatgpt` is refused even when that agent is registered. **INFERRED** (code), test pins it.

**D2 — `--as` given twice: the last one silently wins** (`mcp.ts:58-79`). Ambiguity must refuse.
**INFERRED** (code, no test).

**D3 — a missing identity is reported three different ways, none of them true.** `mida_handoff` /
`mida_whats_new` say "not approved" (`handoff.ts:97-99` treats a missing identity as no capability);
`mida_read` says `refused: agent-not-setup` (`cli.ts:234-244`); a wrong `MIDA_HOME` can also start a
fresh key-less daemon. None of them says "this identity does not exist in this home". Never a
fallback to another agent — **INFERRED** (`runtime.ts:392-396` throws; no fallback anywhere).

**D4 — the project is whatever folder the client launched the server in.** `mcp.ts:60` uses
`process.cwd()` unless `--project` is passed. Desktop apps do not launch servers in your project
folder (Claude Desktop's docs require absolute paths; community reports show `/` or `$HOME`). Result:
every answer is "not approved" with no hint why. **INFERRED.**

**D5 — Codex capture fails twice over.**
- (a) Path check: `hook.ts:25-28` allows Codex transcripts only under `~/.codex/sessions`. Our live
  runs use a separate Codex home (`~/mida-live/codex-home`, set with `CODEX_HOME`) because we never
  touch the real `~/.codex`. Its transcript lives outside the allowed folder → `bad-transcript-path`.
  **INFERRED** as the cause of the live failure; Spike S2 confirms.
- (b) Reader: even with a good path, `drain.ts:292` reads every transcript with the Claude Code
  reader (`packages/compiler/src/transcript-claude.ts`), which finds zero messages in a Codex
  rollout file → `unknown-transcript-format` → the save is discarded. **INFERRED** (code).

**D6 — revocation wording.** Nothing claims revocation erases what a model already read, but
nothing states the limit either, and "Nothing was shared." after a revoke reads as "nothing was
ever shared" (`handoff.ts:70`, `mcp.ts:211`). **INFERRED** (grep).

## 4. Design

### 4.1 MCP identity: shared by default, configurable at startup only

- Default stays `assistant`. Claude Desktop, Cursor and ChatGPT all start `mida-mcp --as assistant`:
  one registration, one approval, one set of scopes.
- `--as` accepts **any name that passes the existing agent-name rule** (`keys.ts:36-38`,
  `^[a-z0-9-]+$`) instead of the closed list. The name rule already blocks `../owner`-style paths;
  `home.ts` blocks them a second time.
- `--as` is startup configuration only. No tool input schema gains an agent, home or project field.
  This is already true (**TESTED WITH FAKE**, `mcp.test.ts:176-198`) and gets a new test that
  fails if any schema ever grows such a field.
- **Fail closed at startup:** `mida-mcp` refuses to start (non-zero exit, one plain line on stderr,
  nothing on stdout) when:
  - `--as` is repeated, empty, or breaks the name rule;
  - the identity is not registered in this home — the check is the file
    `<home>/agents/<name>/identity.json` existing, done with `home.path()` and `existsSync`, **without
    reading it** (the adapter must keep importing no key module); the refusal line names the agent
    AND the home folder it looked in, so a wrong `MIDA_HOME` is obvious;
  - the project folder (see 4.2) has no Mida project marker.

  These checks run **before** `ensureDaemon` (`mcp-main.ts`), so a wrong `MIDA_HOME` can no longer
  start a key-less daemon in the wrong home.
- **Fail closed at request time too (defence in depth):** the daemon answers a missing or unloadable
  identity with one distinct refusal on all three routes (`/handoff`, `/whatsnew`, `/cli read`):
  `Mida: no agent "<name>" is set up in this Mida home (<home>). Nothing was shared.` It never
  substitutes another identity. Reads without a live grant keep today's on-chain refusals
  (not approved / revoked).
- **Honest v0 limit, written into the docs:** every MCP client sharing `assistant` loses future
  reads together when `assistant` is revoked. Per-client identities are possible later by
  registering another agent and starting `mida-mcp --as <it>`; no registration UX is built now.

### 4.2 MCP project folder: explicit when the launch folder is not a project

- Keep `--project <dir>`. If it is absent, use the launch folder **only if** it contains a Mida
  project marker (`findProjectMarker`, from `queue.ts`, which imports no keys); otherwise refuse to
  start with: `mida-mcp: <dir> is not a Mida project folder — start the server with --project <your
  project folder>`.
- Docs give every client config an explicit `--project`. Cursor can use `${workspaceFolder}`; Claude
  Desktop and the ChatGPT tunnel need an absolute path. One MCP server config serves one project
  (an approval covers one project, by the Sep 19 decision); a second project is a second config entry.

### 4.3 MCP surface: unchanged, and pinned

Four tools, read-only, same names and schemas: `mida_handoff`, `mida_whats_new`, `mida_read`
(namespace from a fixed list), `mida_status`. No write, remember, request, approve, revoke, owner
operation, or key. New pin: a test records every daemon request the adapter sends across all tools
and asserts the `/cli` argv always starts with `read` — the daemon's `/cli` route would also accept
`request` and `save-demo` (agent-signed), so the adapter's restraint is what keeps MCP read-only and
it must be tested, not assumed.

### 4.4 Codex: the reader, the folder, nothing else

- **Folder (D5a):** `mida install codex` records the resolved Codex home (`$CODEX_HOME` if set,
  else `~/.codex`) in the Mida home as a single line, `codex-home`. The hook and the drain both allow
  Codex transcripts under `<recorded codex home>/sessions` (plus the default `~/.codex/sessions`),
  with all existing checks kept: absolute, `.jsonl`, regular file, no symlink, real path inside the
  allowed folder. Recorded at install rather than read from the environment because the daemon that
  drains does not inherit Codex's environment.
- **Reader (D5b):** a new `packages/compiler/src/transcript-codex.ts` returning the same
  `Conversation` shape as `readConversation` in `transcript-claude.ts`, with `format:
  "codex-jsonl"`. The drain picks the reader by the job's recorded agent (`codex` → Codex reader,
  `claude-code` → Claude reader); an agent with no reader is refused as today
  (`unknown-transcript-format`), never guessed.
- Codex rollout facts the reader relies on (read from `openai/codex` source on Sep 22, **INFERRED**
  until Spike S2 captures a real file from the installed version): one JSON object per line,
  `{timestamp, type, payload}`; conversation lives in `type: "response_item"` records whose payload
  is `{type: "message", role, content: [{type: "input_text" | "output_text", text}]}`. The reader
  must skip what Codex and Mida inject before the real request: `developer`-role messages, user
  messages that are wholly an `<environment_context>` block, AGENTS.md instructions blocks, and Mida's
  own injected handoff text. The first real user message is copied word for word (scrubbed, capped at
  6,000 characters, as the Claude reader does). Tool calls and their outputs are kept as short
  rendered lines the way the Claude reader renders tool use; reasoning records are dropped.
- **No new Codex hook events.** Changing the managed Codex block changes its text, and Codex
  silently drops hooks whose text changed until the user re-trusts them (`install.ts:8-10`,
  `locateCodexBlock`). Capture on `Stop` (every turn) is enough for checkpoints. SessionEnd stays
  unused while its existence is unproven.
- **Known risk, measured not fixed:** a third-party report says Codex may fire `Stop` before the
  rollout file is fully written. The drain reads later than the hook fires, and the next turn's
  `Stop` recaptures, so the worst case is losing the last turn. Spike S2 measures it.
- Codex's `read` and `status` needs are already met without new code: `mida read --as codex` is a
  shell command the agent can run (**INFERRED**, agent-agnostic path `cli.ts:175-231`), and
  `mida doctor` covers Codex hooks. Codex may also run `mida-mcp --as codex` through its own MCP
  config; that is optional and gets validated only if time allows (the Sep 20 spike found Codex does
  not look for plug-in tools on its own).

### 4.5 Disclosure wording

State the true model in every place a person decides or reads about access:

> Mida keeps your context encrypted until an approved agent asks for it. When it does, Mida decrypts
> what that agent may read and hands it to the model as plain text. Revoking stops every future read
> through Mida. It cannot make a model forget what it was already shown.

- Revoked-read message (`handoff.ts:70`, `mcp.ts:211`): replace "Nothing was shared." with
  "Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent
  already read." (The tamper and unreadable messages keep "Nothing was shared." — they are true as
  written.)
- `mida approve` preview (`cli.ts` near 300) and the owner page's approve screen: one added line —
  "It will see this context as plain text. Revoking later stops future reads, not what it already
  saw."
- Owner page revoke screen (`apps/owner-page/src/owner/revoke.ts:35`): keep the line, add "It does
  not erase what the agent already read."
- `mida revoke` terminal output: add the same sentence.
- `docs/quickstart.md` §10 and §12, and `publish/cli/README.md`: the paragraph above.

Any test that pins these strings changes with them.

### 4.6 What stays out (from the brief, restated so the plan can't drift)

No MCP writes, no remote/cloud keys, no Mida-built relay or protocol, no per-client registration
UX, no automatic per-client identities, no new contracts, permission model, or protocol primitives.

### 4.7 claude.ai web and phone — spike first, build only if clean (Dami, Sep 23)

**Changed from the Sep 22 brief**, which listed claude.ai as a documented limitation. Dami chose
"spike, then build if clean" on Sep 23. The design keeps every rule of §4.1–4.3; only the transport
changes.

- **Why it needs something new:** claude.ai custom connectors are called from Anthropic's cloud,
  never from the user's machine, so the server must answer on a public HTTPS address (support.claude.com
  article 11175166). A connector added on the web also appears in the Claude phone apps.
- **Shape:** `mida-mcp --http <port>` serves the same four read-only tools over MCP's Streamable
  HTTP transport, **bound to 127.0.0.1 only** (any other bind address is refused). Same `--as`,
  same `--project`, same startup gate. Nothing about identity, keys or reads changes: the process is
  still a key-free client of the local daemon socket.
- **Exposure:** an existing tunnel product, not a Mida relay — a Cloudflare named tunnel
  (`cloudflared`) on a Mida-owned hostname (e.g. `mcp.midacontext.xyz`; the zone is already on
  Cloudflare for the Workers) forwarding to `http://127.0.0.1:<port>`. The laptop dials out; nothing
  listens on a public interface. Works only while the laptop and daemon are up — stated in the docs.
- **Login:** Cloudflare Access in front of the hostname, allowing only the owner's email, using
  Access's OAuth support so claude.ai's connector login works (**UNPROVEN** — a third-party write-up
  describes Access "Managed OAuth" with dynamic client registration for Claude/ChatGPT connectors;
  spike S4 proves or kills it).
- **Defence in depth:** in HTTP mode `mida-mcp` refuses every request that does not carry a valid
  Cloudflare Access token (`Cf-Access-Jwt-Assertion`, checked against the team's public keys and the
  application's audience tag given at startup). A misconfigured Access policy then fails closed
  instead of exposing context.
- **Disclosure:** same model as §4.5 — the text goes to Anthropic's model; revoking `assistant`
  stops future reads through every client using it, including claude.ai.
- **Gate:** no Task 9–10 code merges unless S4 passes (claude.ai web completes login, lists the four
  tools, returns real context; the phone app sees the same connector) AND the batch review signs off
  on the HTTP mode. If S4 fails, claude.ai stays a documented limitation with the exact failure.
- **ChatGPT fallback:** if S3 (OpenAI's Secure MCP Tunnel) is blocked by plan or org requirements,
  ChatGPT developer mode can also call the same Access-protected HTTPS endpoint (it supports OAuth
  remote servers); validated in Task 8 only if S3 fails.

### 4.8 What the Sep 23 runs changed

- **S2 (Codex CLI) — D5a confirmed live:** the Stop hook logged `bad-transcript-path` for a rollout
  under the throwaway `CODEX_HOME`. Real rollout shapes differ from the source-code reading (tool
  calls are `custom_tool_call`, output is an array of text parts, Codex injects a
  `<recommended_plugins>` **user** message, Mida's handoff arrives as a **developer** message starting
  `MIDA HANDOFF`, reasoning is encrypted). The final assistant message was on disk before `Stop`
  fired (n=1). Evidence: `docs/evidence/clients-spikes-2026-09-23.json`.
- **S1 (Claude Desktop) — reached the real daemon**, after two platform failures:
  - macOS privacy protection blocks a desktop app from running anything under `~/Desktop`,
    `~/Documents` or `~/Downloads` — `Operation not permitted` — and granting Claude the Desktop
    folder did not help (the server is started by a helper process; the "shared-pool" for Cowork/Code
    sessions starts it too). Fix used: a checkout outside those folders (`~/mida-live/mida-app`).
    The same block will hit a **project folder** in those places. Design consequence: the startup
    gate must tell a blocked read (`EPERM`/`EACCES`) apart from a missing file — `existsSync` returns
    false for both and would print the misleading "no agent … is set up".
  - The launcher runs `node` from PATH; a client that starts servers with a bare environment gets
    `node: not found`. Design consequence: the launcher falls back to the usual install locations and
    says plainly when it cannot find node; the docs use an absolute node path.
  - Tools listed; `mida_status`, `mida_handoff`, `mida_read` answered from the real daemon;
    `assistant` was refused (`not approved for this folder`, `CAPABILITY_DENIED`).
- **Known issue, not fixed here (Dami, Sep 23):** `mida doctor` printed `ok: assistant approved` in the
  same folder where every read was refused — doctor counts any live chain grant, not the folder or
  the key epoch. The migration session traced a related cause to an old contract still in use; noted
  only, no fix in this plan.

## 5. Spikes, before implementation

Each answers one UNPROVEN assumption cheaply. Devin runs none of them (Devin never runs real agents,
real clients, the testnet or owner commands).

- **S1 — Claude Desktop, today's code, zero changes (Dami, ~15 min).** Add the quickstart §12 JSON
  with an absolute `--project` and `MIDA_HOME` to `claude_desktop_config.json`, restart, ask "what am I
  building in this project?". Record: server connects (see `~/Library/Logs/Claude/mcp-server-mida.log`),
  tools listed, real context returned, and one run with `--project` removed to observe D4. Decides:
  whether anything beyond D1–D4 blocks Desktop.
- **S2 — a real Codex rollout, in the throwaway Codex home (Claude, ~20 min).** On the toy project
  with Mida's Codex hooks installed under `CODEX_HOME=~/mida-live/codex-home`, run one short `codex
  exec` task. Keep a scrubbed copy of the rollout file as the reader's test fixture (read only
  `sessions/`, never the auth file). Record the queued job's outcome (expect `bad-transcript-path`,
  confirming D5a), the rollout's record types, where the first real user message sits, and the file
  size at hook time vs one second later (the flush risk). Decides: the reader's exact skip rules.
- **S3 — ChatGPT through OpenAI's Secure MCP Tunnel (Dami + Claude, ~45 min).** Needs from Dami: a
  tunnel id from the OpenAI Platform organization's tunnel settings, a `CONTROL_PLANE_API_KEY`
  (by name only, never printed), and a ChatGPT account with developer mode. Run `tunnel-client` with
  `--mcp-command` pointing at a small wrapper script that sets `MIDA_HOME` and runs
  `mida-mcp --as assistant --project <toy>` (the tunnel docs do not say what environment or folder
  the command gets, so the wrapper fixes both). In ChatGPT: Plugins → + → developer-mode app →
  Connection: Tunnel. Ask the same question as S1. Decides: whether ChatGPT is claimed at all. If the
  account's plan cannot use developer-mode apps, the answer is "ChatGPT: not validated — needs
  <plan>", and nothing is built instead.

## 6. Acceptance (from the brief)

One Mida installation, one home, one daemon:

| Client | Adapter | Identity | Must show |
|---|---|---|---|
| Claude Code | hooks | `claude-code` | already PROVEN; re-run once after the change |
| Codex | hooks | `codex` | handoff in (re-run) **and** a Codex save compiled and readable by `claude-code` |
| Claude Desktop | MCP | `assistant` | real context; refused after `mida revoke assistant` |
| Cursor | MCP | `assistant` | same, if Dami installs Cursor; otherwise recorded "not validated" |
| ChatGPT | MCP via OpenAI tunnel (or §4.7 endpoint) | `assistant` | same, if S3 succeeds; otherwise the exact limitation |
| claude.ai web + phone | MCP over HTTPS via Cloudflare tunnel + Access (§4.7) | `assistant` | same, if S4 passes; otherwise the exact limitation |
| Any other MCP client (Cursor, Windsurf, VS Code, Zed, Gemini CLI…) | local stdio MCP | `assistant` | one generic config documented; validated only where installed |

For every client, `docs/evidence/clients-2026-09-<dd>.json` records: connection mechanism; whether
it reached the real local daemon; identity; tools that worked; whether real authorized context came
back; the answer when unapproved and after revoke; platform limits. And across all of them:

- no client gets more than its configured identity may read;
- no MCP client can choose or change its identity;
- no MCP client receives signing authority;
- revoke stops future reads, and every user-facing line says it cannot recall past ones.

## 7. Coordination

The migration work is live in the main tree on `p0-m0-skeleton`. This work runs in its own worktree
and branch (`p0-clients`), and merges after migration merges; it touches `mcp*.ts`, `hook.ts`,
`drain.ts`, `install.ts` (Codex home record only), `handoff.ts`, `cli.ts` (approve/revoke text only),
the compiler package, the owner page text, and docs. If migration also edits `cli.ts` or
`install.ts`, the merge is by hand, reviewed.
