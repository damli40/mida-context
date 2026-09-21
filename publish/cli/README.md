# mida — passkey-approved context for AI agents

Mida is user-owned context for AI agents. You teach one agent something, and every agent you
approve can read or write only the parts you allow — the Monad chain holds the authority record,
encrypted context lives off-chain, and your passkey decides what each agent may do.

This package is the command line and the local service:

- `mida` — init, doctor, request/approve/revoke, remember
- `midad` — the local service the agent hooks talk to
- `mida-hook`, `mida-inject`, `mida-drain` — the hook and drain entries `mida install` wires in

## Install

```sh
npm install -g mida-context
mida init
mida install claude-code   # or: mida install codex
mida doctor
```

Requires Node 22+. See `docs/quickstart.md` in the repository for the full walkthrough.

## Configuration (all optional)

- `MIDA_HOME` — where state lives (default `~/.mida`)
- `MIDA_STORAGE_URL` — Context API endpoint (default: the hosted store; `off` runs a local store)
- `MIDA_SPONSOR_URL` — gas sponsor endpoint (default: the hosted sponsor; `off` pays own gas)
- `MONAD_TESTNET_RPC` — RPC endpoint
- `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL`, `MIDA_COMPILE_MODEL` — checkpoint compiler
- `MIDA_CLAUDE_SETTINGS`, `MIDA_CODEX_CONFIG` — hook config file overrides
- `MIDA_DEBUG=1` — one extra debug line on owner-command refusals

`mida doctor` lists every variable with set/unset — never a value.

## License

UNLICENSED — a placeholder until the owner picks a licence. See LICENSE.
