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
usage: mida init | install <tool> | uninstall <tool> | doctor [--live <tool>] | request <agent> | approve <agent> | save-demo <agent> <projectId> | read <agent> <projectId> | read --as <agent> | remember <fact> | revoke <agent>
   (tool = claude-code | codex; agent = claude-code | codex | assistant — assistant is a stand-in for any other assistant you use)
```

*Status: RUN — `pnpm check:publish` installs the packed tarball into a fresh folder outside the repo and runs `npx mida --help` to exit 0 with this text. The `-g` global-install variant links the same bins through npm's standard path.*

## 2. Create your vault and register the agents — NOT RUN on testnet

```bash
mida init
```

What it does: generates your owner wallet and one identity per agent (`claude-code`, `codex`, `assistant`), registers them on Monad testnet, and starts the local daemon (`midad`). With the sponsor on — the default — every send is paid by the sponsor; your wallets can stay empty.

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
revoked codex tx 0x<64 hex>; new key sent to: claude-code
```

Codex is refused on its next read or write; the remaining agents keep access through a rotated key.

## 11. The SDK path — RUN on local Anvil

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

## 12. Use Mida from Claude Desktop / Cursor — RUN in tests

Agents that speak MCP instead of hooks — Claude Desktop, Cursor, Codex's MCP support — reach the same daemon through `mida-mcp`: a local, stdio MCP server that is a client of the midad socket, exactly like the hooks. It holds no keys and signs nothing.

Claude Desktop's `claude_desktop_config.json` (Settings → Developer → MCP servers), or Cursor's `.cursor/mcp.json` — the same shape in both:

```json
{
  "mcpServers": {
    "mida": {
      "command": "<absolute path to mida-mcp>",
      "args": ["--as", "assistant"]
    }
  }
}
```

The command is the installed `mida-mcp` bin by absolute path (`which mida-mcp` prints it; from a source checkout it is `<repo>/bin/mida-mcp`). `--as` names which agent identity the server reports — `claude-code`, `codex` or `assistant` (the default); add `"--project", "<dir>"` if the client launches it somewhere other than your project folder. The approval step is the same per-folder command the hooks use:

```bash
mida request assistant && mida approve assistant
```

The client then sees four tools — `mida_handoff` (the same text a session-start hook would inject), `mida_whats_new` (the per-prompt note), `mida_read` (a context namespace) and `mida_status` (health plus each agent's verdict for this folder). `mida doctor` prints `ok: mida-mcp resolves to <path>` once the package is installed.

The honest limits:

- **Local only.** It is stdio on this machine, talking to midad's Unix socket — there is no remote MCP endpoint to point a hosted client at.
- **Read-only.** No write tool exists in this round — a model cannot save, remember, approve or revoke through MCP until the owner decides that is wanted.
- **ChatGPT web connectors are not supported.** Remote MCP needs a key held in the cloud that can sign for the agent, and Mida's design keeps signing keys on your machine.

*Status: RUN in tests — `apps/midad/test/mcp.test.ts` drives the server over the SDK's in-memory transport against a fake daemon socket, including the not-approved, revoked and daemon-down answers. NOT RUN against a real MCP client.*

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
