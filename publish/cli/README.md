# mida-context

**Switch AI agents without losing the work.** Mida saves what one agent was doing as a short,
encrypted checkpoint you own, and hands it to the next agent you approve. Claude Code today, Codex
tomorrow, whatever ships next month.

**Pre-release. Monad testnet only. Not audited.** The full README, the security model and every
limit live in the repository: https://github.com/damli40/mida-context

This package holds the `mida` command and the local Mida service:

- `mida`: set up, check, approve, revoke, remember, read, export
- `midad`: the local service your agents' hooks talk to
- `mida-hook`, `mida-inject`, `mida-drain`: the entries `mida install` wires into your agent
- `mida-mcp`: an MCP server, so Claude Desktop and Cursor can read your context and save to it

## Quickstart

You need Node 22 or later. You need no testnet tokens: a hosted encrypted store and a gas sponsor
are the defaults.

```sh
npm install -g mida-context
mida init                       # add --passkey to approve with a passkey
mida install claude-code
mida install codex              # then open Codex, type /hooks, and trust the Mida entries
mida doctor                     # every PROBLEM line names its fix
```

Then, inside your project folder, in a real terminal window:

```sh
mida request claude-code
mida request codex
mida approve --all              # shows what each agent asks for; type yes
```

Work in Claude Code. When you stop, open Codex in the same folder and type **Continue.** Revoke any
agent with `mida revoke <agent>`; it cannot take back what the agent already read.

## Works with

Claude Code, Codex (the CLI and the app), Devin, Claude Desktop, Cursor, and your own app through
[`@mida-context/sdk`](https://www.npmjs.com/package/@mida-context/sdk).

## License

MIT.
