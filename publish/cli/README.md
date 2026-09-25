# mida-context — switch AI agents without losing the work

Mida saves what one AI agent was doing as a short, encrypted checkpoint that **you** own, and hands
it to the next agent you approve — Claude Code today, Codex tomorrow. The content stays encrypted
off-chain; which agent may read it, and which agent wrote it, is recorded on Monad.

**Status: pre-release, Monad testnet only, not audited.** Handoff works one direction today: Claude
Code sessions are captured, Codex sessions are not yet. The full README, with the architecture
diagram, the security model and every limit, is in the project repository.

This package is the command line and the local service:

- `mida` — set up, check, approve, revoke, remember, read
- `midad` — the local service the agent hooks talk to
- `mida-hook`, `mida-inject`, `mida-drain` — the entries `mida install` wires into your agent
- `mida-mcp` — a read-only MCP server so Claude Desktop, Cursor and other MCP clients can read your context

## Quickstart

Requires Node 22+. No testnet tokens needed: the hosted store and gas sponsor are the defaults.

```sh
npm install -g mida-context
mida init                     # or: mida init --passkey
mida install claude-code      # or: mida install codex
mida doctor                   # every PROBLEM line names its fix
# in your project folder, in a real terminal — approve the agent that writes AND the one that continues:
mida request claude-code && mida approve claude-code   # type yes
mida request codex && mida approve codex               # type yes
```

Work in Claude Code, stop, open Codex in the same folder, and type **Continue.** Revoke any time with
`mida revoke codex` — future reads are refused; what an agent already read cannot be taken back.

Mida keeps your context encrypted until an approved agent asks for it. When it does, Mida decrypts
what that agent may read and hands it to the model as plain text. Revoking stops every future read
through Mida. It cannot make a model forget what it was already shown.

## MCP clients — one identity each

Desktop clients that speak MCP read your context through `mida-mcp`, and **each client connects under
its own identity** so it can be approved and revoked alone. `mida install <client>` registers the
identity and merges one entry into the client's MCP config, then you approve it in the project folder:

```sh
mida install claude-desktop   # merges mida-claude-desktop into claude_desktop_config.json
mida approve claude-desktop
mida install cursor           # writes .cursor/mcp.json in the current workspace
mida approve cursor
```

The Codex app (which is also the ChatGPT desktop app) and the Codex CLI share the `codex` identity
through the Codex hooks — no MCP entry is needed for either. Browser ChatGPT is not supported in v0.

`mida revoke <client>` isolates one client; `mida uninstall <client>` removes only the MCP config
entry — the identity stays until revoked. `mida approve --all` approves every pending request after
one typed `yes`; `mida revoke --all` revokes every approved agent the same way. In passkey mode the
page still signs once **per agent** — batch approvals ask the terminal once, never the page once.

## Bring your own compile model

A model turns each session into the checkpoint. Default order: DeepSeek (`DEEPSEEK_API_KEY`), then
Kimi (`KIMI_API_KEY`), then Claude Haiku through your `claude` CLI login. Any OpenAI-compatible
chat-completions endpoint can replace them:

```sh
export MIDA_COMPILE_MODEL=custom
export MIDA_COMPILE_BASE_URL=http://127.0.0.1:11434/v1    # https, or http on loopback only
export MIDA_COMPILE_MODEL_ID=<your model name>
# export MIDA_COMPILE_API_KEY=...                          optional
```

Mida sends one `POST <base>/chat/completions` per save with the secret-scrubbed transcript and expects
`choices[0].message.content` to hold one JSON checkpoint with ten fields: `objective`, `progress`,
`decisions`, `rejected`, `constraints`, `artifacts`, `unresolvedIssue`, `nextAction`, `remainingPlan`,
`evidence`. A failed custom compile has **no fallback** (your transcript never goes to a vendor
instead) unless you set `MIDA_COMPILE_FALLBACK=1`. The exact schema, limits and retry rules are in the
repository README.

## Configuration (all optional)

- `MIDA_HOME` — where state lives (default `~/.mida`)
- `MIDA_STORAGE_URL` — encrypted store (default: the hosted store; `off` = a local store)
- `MIDA_SPONSOR_URL` — gas sponsor (default: the hosted sponsor; `off` = your wallets pay gas)
- `MONAD_TESTNET_RPC` — RPC endpoint
- `MIDA_COMPILE_*`, `DEEPSEEK_*`, `KIMI_*` — the compile model (above)
- `MIDA_CLAUDE_SETTINGS`, `MIDA_CODEX_CONFIG` — hook config file overrides
- `MIDA_DEBUG=1` — one masked detail line when a command is refused

A setup keeps the contract, store and sponsor it was created with. `mida doctor` shows which values
are in effect — host names only, never a value that could be a secret.

## License

MIT — see LICENSE.
