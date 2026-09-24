# Client Adapters Implementation Plan

> **Refs re-checked Sep 24 against `52f37f6`** (branch `p0-clients`, worktree
> `~/Desktop/mida-context-clients`). `mcp.ts`, `mcp-main.ts`, `hook.ts`, `install.ts`, `queue.ts`,
> `home.ts`, `bin/mida-mcp` and `transcript-claude.ts` are byte-identical to `c22c7c3`. `cli.ts`,
> `daemon.ts`, `drain.ts` and `handoff.ts` moved; their refs below are updated.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **In this repo:** Tasks 1–7 are implemented by Devin CLI (`swe-2-high`) from briefs Claude writes
> into `.devin/briefs/` (gitignored), chained. Claude verifies each by running the tests itself.
> ONE Opus subagent reviews the whole batch after Task 7. Task 0 (spikes) and Task 8 (real-client
> validation) are run by Claude and Dami. **Devin runs neither.**

**Goal:** Make Mida's two adapters honest and proven: `mida-mcp` becomes a fail-closed, read-only,
identity-at-startup MCP server that works from Claude Desktop, any stdio MCP harness (Cursor,
Windsurf, VS Code, Zed, Gemini CLI, Codex's MCP), ChatGPT where its tunnel allows, and — if spike S4
passes — claude.ai web and phone over an Access-protected HTTPS tunnel to the laptop;
Codex hooks gain the missing capture half; every access message states what revocation can and
cannot do.

**Architecture:** No protocol change. The MCP adapter stays a key-free client of the daemon's Unix
socket; it gains startup checks (identity exists in this home, project folder is real) that run
before it can start a daemon, and it accepts any registered agent name for `--as`. The daemon gains
one distinct "no such identity" refusal. Codex capture gets its own transcript reader, chosen by the
job's agent, and a recorded Codex home so a custom `CODEX_HOME` is trusted.

**Tech Stack:** TypeScript (ESM), pnpm workspace, vitest, `@modelcontextprotocol/sdk` (stdio), local
Anvil for e2e tests.

**Spec:** `docs/superpowers/specs/2026-09-22-client-adapters-design.md` — read it first; this plan
argues from it. Section numbers below (§4.1 etc.) refer to it.

## Global Constraints

- Work in a separate worktree: `git worktree add ~/Desktop/mida-context-clients -b p0-clients` from
  the current `p0-m0-skeleton` head. The migration work is live in the main tree; never touch it.
- One shell command per tool call; never chain with `&&`, `;` or pipes (Devin's non-interactive mode
  dies on a refused program).
- Never open `.env`; never print a key; keys by NAME only. Never read `~/.claude`, `~/.codex`,
  `~/.mida` contents.
- Never run: the Monad testnet, real agents (`claude`, `codex`), real models, `wrangler`, or owner
  commands (`mida init|approve|revoke|remember`) against a real home. Local Anvil through the test
  suite is fine.
- Never commit `docs/evidence/m0-local-anvil.json`, `DEVIN-REPORT-*.md`, `brand/`.
- `apps/midad/src/mcp.ts` and `mcp-main.ts` must not import `keys.ts`, `runtime.ts`, `skeleton.ts`,
  `cli.ts`, `remember.ts`, `projects.ts` (it imports `keys.ts`) or any `@mida/*` package. The existing
  import-graph test (`apps/midad/test/mcp.test.ts`, `describe("mida-mcp import graph")`) must stay
  green. `queue.ts` is allowed (it imports only `node:*`, `home.ts`, `hook.ts` types).
- MCP stays read-only: no new tool, no new tool input field. Exactly four tools, schemas unchanged.
- Agent names for `--as`: `/^[a-z0-9-]{1,64}$/` — the same characters as `keys.ts:24` `NAME`.
- Default MCP identity stays `assistant`. Never fall back to another identity on any failure.
- Every refusal the MCP server prints before connecting goes to **stderr**; stdout carries only
  JSON-RPC.
- Exact user-facing strings (copy verbatim):
  - `noIdentityText(agent, homeRoot)` = `Mida: no agent "${agent}" is set up in this Mida home (${homeRoot}). Nothing was shared.`
  - revoked = `Mida: ${agent}'s access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.`
  - approve preview line = `It will see this context as plain text. Revoking later stops future reads, not what it already saw.`
  - revoke line = `This stops future reads through Mida. It does not erase what ${agent} already read.`
  - owner-page revoke addition = `It does not erase what the agent already read.`
- Full suite, `pnpm typecheck` and `pnpm check:publish` green at the end of every task.

## Review Focus

1. **Wrong `MIDA_HOME` in a desktop config** → the server must refuse at startup naming the home it
   looked in, and must not spawn a daemon there. (Task 2, test "refuses before spawning".)
2. **A client launches the server from `/` or `$HOME` with no `--project`** → refuse at startup
   with the `--project` hint, never answer "not approved". (Task 2.)
3. **`--as` smuggling**: `--as ../owner`, `--as Assistant`, `--as ""`, `--as` twice, `--as=codex`
   → all refused; no tool call can change the identity. (Task 1, Task 4.)
4. **Codex rollout carrying Mida's own injected handoff or `<environment_context>` before the real
   prompt** → `firstUserMessage` is the human's words, never Mida's or Codex's scaffolding. (Task 6.)
5. **Identity file deleted while the server is running** → next tool call gets the no-identity line,
   not "not approved" and never another agent's context. (Task 3, Task 4.)

---

### Task 0: Spikes (Claude + Dami — not Devin)

Run before briefing Devin. Each result is written to `docs/evidence/clients-spikes-2026-09-<dd>.json`.

**Status Sep 23:** S1 ran — reached the real daemon after two platform fixes (see spec §4.8); still
owes one run after `mida approve assistant` in `toy4` returns real context. S2 DONE — D5a confirmed,
real fixture saved, Task 6 amended. Evidence: `docs/evidence/clients-spikes-2026-09-23.json`.
**Claude Desktop must point at a checkout outside `~/Desktop`/`~/Documents`/`~/Downloads`** — the
config below now uses `~/mida-live/mida-app` (detached worktree of the verified live commit; move it
with the live copy).

- [x] **S1 — Claude Desktop on today's code (Dami, ~15 min).** In
  `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mida": {
      "command": "/Users/you/mida-live/mida-app/bin/mida-mcp",
      "args": ["--as", "assistant", "--project", "/Users/you/mida-live/toy4"],
      "env": { "MIDA_HOME": "/Users/you/mida-live/home-v2" }
    }
  }
}
```

  Start the daemon first from a terminal that has the model keys (`source ~/mida-live/hosted-env-v2.sh`,
  then any `mida` command). Quit and reopen Claude Desktop. Ask: "Use Mida: what am I building in this
  project?" Record: tools listed (yes/no), which tool the model called, the text returned, and the
  last 20 lines of `~/Library/Logs/Claude/mcp-server-mida.log`. Then remove `"--project", "<dir>"`,
  restart, ask again, and record the answer (expect "not approved" — confirms D4).
  If `assistant` is not approved in `toy4`, first run `mida request assistant` then
  `mida approve assistant` in `toy4` (Dami's terminal).

- [x] **S2 — a real Codex rollout (Claude, ~20 min).** In `~/mida-live/toy4`, with
  `CODEX_HOME=~/mida-live/codex-home` and Mida's Codex hooks in that home's `config.toml`, run one
  short `codex exec "add a one-line comment to the README"`. Then:
  - read the last lines of the Mida home's hook log: record the Stop outcome (expect
    `bad-transcript-path`, confirming D5a);
  - copy the newest `~/mida-live/codex-home/sessions/**/rollout-*.jsonl` (read `sessions/` only,
    never `auth.json`) to `packages/compiler/test/fixtures/codex-rollout-real.jsonl`, replacing
    every absolute path with `/tmp/toy` and scrubbing anything key-shaped by hand;
  - record the set of `type` values, the `payload.type`/`role` of every `response_item` before the
    first real user prompt, and how Mida's injected handoff appears (role, first 40 chars);
  - record the rollout file's size at hook time (from the job file's timestamp) vs one second
    later.
  **Gate:** if the injected-context shapes differ from Task 6's skip rules (`INJECTED_PREFIXES`,
  developer role), amend Task 6 in this plan before briefing Devin.

- [ ] **S3 — ChatGPT through OpenAI's Secure MCP Tunnel (Dami + Claude, ~45 min).** Needs from Dami:
  a tunnel id (platform.openai.com → organization settings → tunnels), `CONTROL_PLANE_API_KEY` in
  the environment (by name only), a ChatGPT account with developer mode. Create
  `~/mida-live/mida-mcp-toy4.sh`:

```sh
#!/bin/sh
export MIDA_HOME=/Users/you/mida-live/home-v2
export PATH=/opt/homebrew/bin:/usr/bin:/bin
exec /Users/you/mida-live/mida-app/bin/mida-mcp --as assistant --project /Users/you/mida-live/toy4
```

  Then `tunnel-client init --sample sample_mcp_stdio_local --profile mida --tunnel-id <id> --mcp-command "/Users/you/mida-live/mida-mcp-toy4.sh"`,
  `tunnel-client doctor --profile mida --explain`, `tunnel-client run --profile mida`. In ChatGPT:
  Plugins → + → developer-mode app → Connection: Tunnel. Ask the S1 question. Record the plan name,
  whether the app could be created, tools seen, text returned. If the plan blocks developer mode,
  record "ChatGPT: not validated — <exact message>" and stop; nothing is built instead.

- [ ] **S4 — claude.ai through a Cloudflare tunnel + Access, zero Mida code (Dami + Claude, ~60 min).**
  Proves spec §4.7's unproven link: can claude.ai's custom-connector login pass through Cloudflare
  Access to a server on the laptop? Uses an off-the-shelf stdio-to-HTTP bridge so no Mida code
  changes (throwaway; nothing from it is kept):
  1. Dami: in the Cloudflare dashboard for `midacontext.xyz`, create a named tunnel `mida-mcp-spike`
     with public hostname `mcp-spike.midacontext.xyz` → `http://localhost:8765`; create an Access
     application for that hostname with a policy allowing only Dami's email, and turn on its OAuth /
     MCP-client support (name the exact toggle in the evidence file). Note the Access team domain and
     the application audience tag (AUD).
  2. Claude: `npx -y supergateway --stdio "/Users/you/mida-live/mida-mcp-toy4.sh" --outputTransport streamableHttp --port 8765`
     (throwaway bridge; verify its flags with `--help` first) and `cloudflared tunnel run mida-mcp-spike`.
  3. Dami: claude.ai → Settings → Connectors → Add custom connector → `https://mcp-spike.midacontext.xyz/mcp`.
     Complete the login. Ask the S1 question. Then open the Claude phone app and ask again.
  4. Negative checks: `curl -i https://mcp-spike.midacontext.xyz/mcp` with no login → must be refused
     by Access (302/401/403), never an MCP answer.
  5. Record in the evidence file: login worked (y/n, exact screen), tools seen, text returned, phone
     result, the curl status, Anthropic's calling IPs if shown. Delete the spike tunnel and Access app
     afterwards.
  **Gate:** S4 must pass steps 3–4 for Tasks 9–10 to be briefed. If it fails, record the exact
  failure, skip Tasks 9–10, and Task 7's docs say claude.ai is not supported, with that reason.

---

### Task 1: `--as` accepts any agent name, refuses ambiguity

**Files:**
- Modify: `apps/midad/src/mcp.ts:22-79` (`MCP_AGENTS`, `McpAgent`, `MCP_USAGE`, `McpArgs`, `parseMcpArgs`)
- Modify: `apps/midad/src/index.ts` (export `AGENT_NAME`)
- Test: `apps/midad/test/mcp.test.ts` (`describe("mida-mcp args")`)

**Interfaces:**
- Produces: `export const AGENT_NAME = /^[a-z0-9-]{1,64}$/`;
  `McpArgs = { agent: string; project: string; projectGiven: boolean }`;
  `parseMcpArgs(argv: string[]): { ok: true; args: McpArgs } | { ok: false; error: string }` (same
  shape; `agent` widens from `McpAgent` to `string`). `MCP_AGENTS`/`McpAgent` are deleted — grep
  every use and replace with `string`.

- [ ] **Step 1: Write the failing tests** (inside `describe("mida-mcp args")`)

```ts
it("accepts any registered-agent-shaped name for --as", () => {
  const r = parseMcpArgs(["--as", "chatgpt", "--project", "/tmp/p"])
  expect(r).toEqual({ ok: true, args: { agent: "chatgpt", project: "/tmp/p", projectGiven: true } })
})

it("refuses names outside the agent-name rule", () => {
  for (const bad of ["../owner", "Assistant", "a/b", "a b", ".", "..", "x".repeat(65), "codex\n"]) {
    const r = parseMcpArgs(["--as", bad])
    expect(r.ok, bad).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^bad agent name/)
  }
})

it("refuses --as or --project given twice, even with the same value", () => {
  expect(parseMcpArgs(["--as", "assistant", "--as", "codex"])).toEqual({ ok: false, error: "--as given twice" })
  expect(parseMcpArgs(["--as", "assistant", "--as", "assistant"])).toEqual({ ok: false, error: "--as given twice" })
  expect(parseMcpArgs(["--project", "/a", "--project", "/b"])).toEqual({ ok: false, error: "--project given twice" })
})

it("refuses the --flag=value form rather than guessing", () => {
  expect(parseMcpArgs(["--as=codex"])).toEqual({ ok: false, error: "unknown flag: --as=codex" })
})

it("marks whether --project was given", () => {
  const r = parseMcpArgs([])
  expect(r.ok && r.args.projectGiven).toBe(false)
  expect(r.ok && r.args.agent).toBe("assistant")
})

it("uses the same name rule as the key store", () => {
  for (const name of ["assistant", "claude-code", "codex", "chatgpt", "a-1"]) expect(AGENT_NAME.test(name)).toBe(true)
  for (const name of ["A", "a_b", "a.b", ""]) expect(AGENT_NAME.test(name)).toBe(false)
})
```

  Update the existing refusal test that expects
  `unknown agent "x" — --as takes claude-code | codex | assistant`: a well-formed unknown name now
  passes parsing (Task 2's startup check refuses it); keep the unknown-flag, missing-value and
  positional cases as they are.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/midad/test/mcp.test.ts -t "mida-mcp args"`
Expected: FAIL (`chatgpt` refused as unknown agent; `--as given twice` not produced).

- [ ] **Step 3: Implement** — replace lines 22-24 and 42-79 of `mcp.ts`:

```ts
/**
 * An agent name `--as` may carry: the same characters the key store allows (`keys.ts` NAME), so
 * a name that passes here can only ever address `agents/<name>/` — never a path. Whether that
 * agent is registered in this home is the startup check's question, not the parser's.
 */
export const AGENT_NAME = /^[a-z0-9-]{1,64}$/

export const MCP_USAGE = "usage: mida-mcp [--as <agent>] [--project <dir>]   (agent defaults to assistant)"

export interface McpArgs {
  agent: string
  /** Absolute path — the project folder; reported to the daemon as cwd. */
  project: string
  /** False when the folder came from the launch cwd. */
  projectGiven: boolean
}

export function parseMcpArgs(argv: string[]): { ok: true; args: McpArgs } | { ok: false; error: string } {
  let agent: string | undefined
  let project: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === "--as" || flag === "--project") {
      const value = argv[i + 1]
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, error: `${flag} needs a value` }
      }
      if (flag === "--as") {
        if (agent !== undefined) return { ok: false, error: "--as given twice" }
        agent = value
      } else {
        if (project !== undefined) return { ok: false, error: "--project given twice" }
        project = value
      }
      i += 1
    } else {
      return { ok: false, error: `unknown flag: ${flag}` }
    }
  }
  const name = agent ?? "assistant"
  if (!AGENT_NAME.test(name)) return { ok: false, error: `bad agent name "${name}" — lower-case letters, digits and "-" only` }
  return { ok: true, args: { agent: name, project: resolve(project ?? process.cwd()), projectGiven: project !== undefined } }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run apps/midad/test/mcp.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck` — expected clean.

```bash
git add apps/midad/src/mcp.ts apps/midad/src/index.ts apps/midad/test/mcp.test.ts
git commit -m "mcp: --as takes any agent name, refuses repeats (client adapters T1)"
```

---

### Task 2: Startup gate — identity and project checked before any daemon starts

**Files:**
- Modify: `apps/midad/src/mcp.ts` (add `startupCheck`)
- Modify: `apps/midad/src/mcp-main.ts:40-60` (`main`)
- Test: `apps/midad/test/mcp.test.ts` (new `describe("mida-mcp startup gate")`; import-graph allow-list)

**Interfaces:**
- Consumes: `McpArgs` (Task 1); `findProjectMarker(cwd: string): { markerDir: string; projectId: string | null } | null`
  from `apps/midad/src/queue.ts:111`; `MidaHome.path(...)`, `MidaHome.root`.
- Produces: `export function startupCheck(home: MidaHome, args: McpArgs): { ok: true } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("mida-mcp startup gate", () => {
  const makeHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-gate-")))
  const makeProject = () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-proj-"))
    mkdirSync(join(dir, ".mida"))
    writeFileSync(join(dir, ".mida", "project.json"), JSON.stringify({ projectId: "p1" }))
    return dir
  }
  const register = (home: MidaHome, agent: string) => {
    mkdirSync(join(home.root, "agents", agent), { recursive: true })
    writeFileSync(join(home.root, "agents", agent, "identity.json"), "{}")
  }

  it("refuses an agent with no identity in this home, naming the home", () => {
    const home = makeHome()
    const r = startupCheck(home, { agent: "chatgpt", project: makeProject(), projectGiven: true })
    expect(r).toEqual({ ok: false, error: `no agent "chatgpt" is set up in the Mida home ${home.root} — check MIDA_HOME in this client's config` })
  })

  it("refuses a launch folder that is not a Mida project when --project was not given", () => {
    const home = makeHome()
    register(home, "assistant")
    const r = startupCheck(home, { agent: "assistant", project: "/", projectGiven: false })
    expect(r).toEqual({ ok: false, error: "/ is not a Mida project folder — start the server with --project <your project folder>" })
  })

  it("refuses an explicit --project that is not a Mida project either", () => {
    const home = makeHome()
    register(home, "assistant")
    const dir = mkdtempSync(join(tmpdir(), "mida-noproj-"))
    const r = startupCheck(home, { agent: "assistant", project: dir, projectGiven: true })
    expect(r).toEqual({ ok: false, error: `${dir} is not a Mida project folder — start the server with --project <your project folder>` })
  })

  it("passes a registered agent in a marked project", () => {
    const home = makeHome()
    register(home, "assistant")
    expect(startupCheck(home, { agent: "assistant", project: makeProject(), projectGiven: true })).toEqual({ ok: true })
  })

  it("never reads the identity file (existence only)", () => {
    const home = makeHome()
    register(home, "assistant")
    chmodSync(join(home.root, "agents", "assistant", "identity.json"), 0o000)
    expect(startupCheck(home, { agent: "assistant", project: makeProject(), projectGiven: true })).toEqual({ ok: true })
  })

  it("refuses before spawning a daemon: the real entry exits 2, stdout empty, no socket", async () => {
    const home = makeHome() // empty home: no identity
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "assistant", "--project", makeProject()], {
      env: { ...process.env, MIDA_HOME: home.root },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain(`no agent "assistant" is set up in the Mida home ${home.root}`)
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })
})
```

  `tsxLoader` and `mcpMainPath`: reuse the constants the file already uses to spawn the real entry
  (search `mcp-main` in `mcp.test.ts`); if none exist, define
  `const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")`,
  `const tsxLoader = join(repo, "node_modules/tsx/dist/loader.mjs")`,
  `const mcpMainPath = join(repo, "apps/midad/src/mcp-main.ts")`. Add `chmodSync`, `mkdirSync`,
  `writeFileSync` to the `node:fs` import.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/midad/test/mcp.test.ts -t "startup gate"`
Expected: FAIL — `startupCheck` is not exported.

- [ ] **Step 3: Implement `startupCheck` in `mcp.ts`** (add `import { existsSync } from "node:fs"` and
  `import { findProjectMarker } from "./queue.js"`; export it through the package index like
  `parseMcpArgs`):

```ts
/**
 * Refuses to serve — before a daemon is found or started — when the configured identity is not
 * registered in this home, or the project folder carries no Mida marker. Desktop clients launch
 * servers with their own environment and folder, so a wrong MIDA_HOME or a missing --project is
 * the common failure; naming which one beats every tool answering "not approved". The identity
 * file is checked for existence only: this module never reads key material (import-graph test).
 */
export function startupCheck(home: MidaHome, args: McpArgs): { ok: true } | { ok: false; error: string } {
  if (!existsSync(home.path("agents", args.agent, "identity.json"))) {
    return { ok: false, error: `no agent "${args.agent}" is set up in the Mida home ${home.root} — check MIDA_HOME in this client's config` }
  }
  if (findProjectMarker(args.project) === null) {
    return { ok: false, error: `${args.project} is not a Mida project folder — start the server with --project <your project folder>` }
  }
  return { ok: true }
}
```

  **Blocked vs missing (spec §4.8):** `existsSync` returns `false` both for "no such file" and for
  "macOS privacy protection refused" — the second must not print "no agent … is set up". Use this
  helper instead of `existsSync` for both checks, and give the blocked case its own line:

```ts
/** "yes", "no", or "blocked" — a refused read is not a missing file. */
function probe(path: string): "yes" | "no" | "blocked" {
  try {
    statSync(path)
    return "yes"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPERM" || code === "EACCES" ? "blocked" : "no"
  }
}
const blockedLine = (path: string) =>
  `${path} could not be read (the system refused access). If it is under Desktop, Documents or Downloads, macOS blocks desktop apps from it — move Mida or the project out of those folders.`
```

  `findProjectMarker` swallows errors the same way, so probe `join(args.project, ".mida", "project.json")`
  and its parents' markers only through `findProjectMarker` **after** a `probe(args.project)` that is
  not `"blocked"`. Add a test: a project folder whose parent has mode `0o000` (→ `EACCES`) gives
  the blocked line, not the "not a Mida project folder" line (skip the test when running as root).

  Read `home.ts:35-57` first: if `MidaHome.path` takes one relative string rather than segments,
  call `home.path(\`agents/${args.agent}/identity.json\`)`. `findProjectMarker` walks up parent
  folders — the same rule the hooks use, intended.

- [ ] **Step 4: Wire it into `mcp-main.ts` `main()`** directly after `const home = resolveHome(process.env)`:

```ts
  const gate = startupCheck(home, parsed.args)
  if (!gate.ok) {
    // before ensureDaemon: a wrong MIDA_HOME must not start a key-less daemon in the wrong home
    process.stderr.write(`mida-mcp: ${gate.error}\n`)
    process.exitCode = 2
    return
  }
```

  Add `startupCheck` to the `./mcp.js` import. If the import-graph test enumerates allowed leaf
  modules (~line 535), add `queue.js` with the comment "imports only node:* and home/hook types — no
  key material".

- [ ] **Step 5: Launcher finds node without PATH (spec §4.8).** `bin/mida-mcp` runs `exec node …`;
  a client with a bare environment gets `node: not found`. Replace the `exec` line with:

```sh
NODE=$(command -v node 2>/dev/null)
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
  [ -n "$NODE" ] && break
  [ -x "$candidate" ] && NODE=$candidate
done
if [ -z "$NODE" ]; then
  echo "mida-mcp: node was not found on PATH or in the usual places — put the absolute path to node in your client's MCP config as the command" >&2
  exit 127
fi
exec "$NODE" --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$ROOT/apps/midad/src/mcp-main.ts" "$@"
```

  Test: spawn `bin/mida-mcp --as nobody` with `env: { HOME, PATH: "/usr/bin:/bin" }` and assert it
  gets past node resolution (stderr contains `no agent "nobody"`, not `node: not found`) — skip when
  none of the candidate paths exist on the test machine. The published package's `mida-mcp` bin is
  a node script with a `#!/usr/bin/env node` line; that case is covered by Task 7's docs (absolute
  node path in `command`), not by code.

- [ ] **Step 6: Run to verify**

Run: `pnpm vitest run apps/midad/test/mcp.test.ts`
Expected: PASS including the import-graph block.

- [ ] **Step 7: Commit**

```bash
git add bin/mida-mcp apps/midad/src/mcp.ts apps/midad/src/mcp-main.ts apps/midad/src/index.ts apps/midad/test/mcp.test.ts
git commit -m "mcp: refuse at startup on a missing identity or non-project folder, before any daemon (T2)"
```

---

### Task 3: Daemon answers a missing identity with one distinct refusal

**Files:**
- Modify: `apps/midad/src/handoff.ts:69-163` (`noIdentityText` beside `notApprovedText` at 69, `checkAccess` at 129-163)
- Modify: `apps/midad/src/mcp.ts:205-225` (`toolWhatsNew`'s refusal mapping; `toolHandoff` at 150 already returns `body.text` directly, so it needs no change)
- Modify: `apps/midad/src/cli.ts:264-280` (`runCliWithRuntime` catch)
- Test: `apps/midad/test/handoff.test.ts` (no test calls `checkAccess(` directly yet; add the first one there, building the runtime the way that file already does); `apps/midad/test/mcp.test.ts`; `apps/midad/test/cli.test.ts` (this is where `runCliWithRuntime` is driven — `refusals.test.ts` only tests `ownerRefusalLine`/`historyCursor`)

**Interfaces:**
- Consumes: `loadAgentIdentity(home, agent)` (already imported in handoff.ts).
- Produces: `export const noIdentityText = (agent: string, homeRoot: string): string`; refusal reason
  `"no-identity"` on `/handoff` and `/whatsnew`; the same line printed by `mida read`.

- [ ] **Step 1: Write the failing tests**

  In the `checkAccess` test file (reuse its `runtime` / `projectDir` setup):

```ts
it("refuses an agent with no identity in this home with its own reason, before the project check", async () => {
  let projectChecked = false
  const result = await checkAccess(runtime, { agent: "ghost", cwd: projectDir }, {
    checkProject: async () => { projectChecked = true; return { ok: false, reason: "not-approved" } as never },
  })
  expect(result).toEqual({ ok: false, reason: "no-identity", text: `Mida: no agent "ghost" is set up in this Mida home (${runtime.home.root}). Nothing was shared.` })
  expect(projectChecked).toBe(false)
})
```

  In `mcp.test.ts`, copy the not-approved test at `mcp.test.ts:223-236` twice (once for
  `mida_handoff`, once for `mida_whats_new`), with the fake daemon answering
  `{ kind: "refused", reason: "no-identity", text: "Mida: no agent \"assistant\" is set up in this Mida home (/h). Nothing was shared." }`
  and expecting that exact text back.

  In `cli.test.ts` (reuse the helper it already uses to drive `runCliWithRuntime`):

```ts
it("mida read --as <unregistered> prints the no-identity line, not a bare code", async () => {
  const lines = await runRead(["read", "--as", "ghost", "projects.current"])
  expect(lines).toEqual([`Mida: no agent "ghost" is set up in this Mida home (${home.root}). Nothing was shared.`])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/midad/test/handoff.test.ts apps/midad/test/cli.test.ts apps/midad/test/mcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

  `handoff.ts`, beside `notApprovedText`:

```ts
export const noIdentityText = (agent: string, homeRoot: string): string =>
  `Mida: no agent "${agent}" is set up in this Mida home (${homeRoot}). Nothing was shared.`
```

  In `checkAccess`, after the `isAbsolute(input.cwd)` guard and before `checkProject`:

```ts
  // an agent with no identity here is its own answer — never "not approved", never another agent
  if (loadAgentIdentity(runtime.home, agent) === undefined) {
    return { ok: false, reason: "no-identity", text: noIdentityText(agent, runtime.home.root) }
  }
```

  `daemon.ts` needs no change: `/handoff` (302) and `/whatsnew` (352) already reply with the whole
  result object, so `text` is carried through. In `toolWhatsNew`'s refusal mapping (`mcp.ts:205-225`)
  add, before the generic fallback:

```ts
    if (reason === "no-identity" && typeof body.text === "string") return toolText(body.text)
```

  In `cli.ts` `runCliWithRuntime`'s catch (264-280) the code already comes from
  `const code = refusalCode(error)` and there are three branches (`already-approved`,
  `CHAIN_CALL_FAILED`, fallback `refused: ${code}`). Add a fourth `else if` before the fallback —
  keep `refusalCode`, keep the `MIDA_DEBUG` line after the chain, and do not reintroduce
  `(error as { code?: unknown }).code`:

```ts
    } else if (code === "agent-not-setup") {
      print(noIdentityText(agent, runtime.home.root))
    } else {
```

  Import `noIdentityText` from `./handoff.js`. Do not touch `refusals.test.ts`'s `refused: UNEXPECTED`
  and `CHAIN_CALL_FAILED` tests.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run apps/midad`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/midad/src/handoff.ts apps/midad/src/mcp.ts apps/midad/src/cli.ts apps/midad/src/daemon.ts apps/midad/test
git commit -m "midad: one distinct no-identity refusal on handoff, whats-new and read (T3)"
```

---

### Task 4: Pin MCP read-only, and run it against a real daemon

**Files:**
- Test: `apps/midad/test/mcp.test.ts` (read-only pin)
- Create: `apps/midad/test/mcp.e2e.test.ts`

**Interfaces:**
- Consumes: `createMidaMcpServer(deps: McpServerDeps)`; the local-Anvil harness in
  `apps/midad/test/daemon.e2e.test.ts` (`localEnvironment()` from `@mida/cli`, `startDaemon` /
  `callDaemon` from `@mida/midad`) and the programmatic request/approve/revoke drivers in
  `apps/midad/test/connect.e2e.test.ts`.

- [ ] **Step 1: Read-only pin** (in `describe("mida-mcp tools against a fake daemon")`): make the
  fake daemon record every request as `{ path, body }`, call every tool with every valid input (all
  three namespaces for `mida_read`), then:

```ts
it("only ever sends read-shaped requests to the daemon", async () => {
  // ...call mida_handoff, mida_whats_new, mida_status, and mida_read for each READ_NAMESPACES entry
  for (const req of recorded) {
    expect(["/health", "/handoff", "/whatsnew", "/cli"]).toContain(req.path)
    if (req.path === "/cli") expect(req.body.argv.slice(0, 3)).toEqual(["read", "--as", "assistant"])
  }
})

it("no tool schema carries an identity, home or project field", async () => {
  const { tools } = await client.listTools()
  for (const tool of tools) {
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})
    for (const p of props) expect(p).not.toMatch(/^(as|agent|identity|home|project|cwd|mida_home)$/i)
  }
})
```

  If `mida_status` sends a route not in that list, add the exact route with a one-line comment
  naming why it is read-only.

- [ ] **Step 2: Real-daemon e2e** — `apps/midad/test/mcp.e2e.test.ts`. Copy the setup block of
  `connect.e2e.test.ts`: a fresh local chain, programmatic init, a project folder with its marker,
  request + approve for `assistant`, and one saved checkpoint whose content includes the sentence
  `Emergency state pulses the spacecraft and shows an EMERGENCY label; never red.` Start the real
  daemon with `startDaemon`. Connect an MCP client over `InMemoryTransport` to
  `createMidaMcpServer({ home, agent: "assistant", project, sessionId: "e2e", daemonUp: true })`.
  Helper: `const textOf = (r: { content: { text: string }[] }) => r.content[0].text`.

```ts
it("returns the real approved context through mida_handoff and mida_read", async () => {
  expect(textOf(await client.callTool({ name: "mida_handoff", arguments: {} }))).toContain("EMERGENCY label")
  expect(textOf(await client.callTool({ name: "mida_read", arguments: { namespace: "projects.current" } }))).toContain("EMERGENCY label")
})

it("a server started as an unapproved agent gets nothing, and a tool call cannot switch identity", async () => {
  const other = await connectMcp({ agent: "codex" }) // registered by init, never approved here
  expect(textOf(await other.callTool({ name: "mida_handoff", arguments: {} }))).toMatch(/codex is not approved/)
  await expect(other.callTool({ name: "mida_read", arguments: { namespace: "projects.current", as: "assistant" } as never })).rejects.toThrow()
})

it("refuses after the owner revokes assistant", async () => {
  await revokeAgent("assistant") // the programmatic revoke connect.e2e.test.ts uses
  expect(textOf(await client.callTool({ name: "mida_handoff", arguments: {} }))).toMatch(/assistant's access was revoked by the owner/)
  expect(textOf(await client.callTool({ name: "mida_read", arguments: { namespace: "projects.current" } }))).not.toContain("EMERGENCY")
})

it("an identity deleted while running gets the no-identity line on the next call", async () => {
  rmSync(join(home.root, "agents", "assistant"), { recursive: true })
  expect(textOf(await client.callTool({ name: "mida_handoff", arguments: {} })))
    .toBe(`Mida: no agent "assistant" is set up in this Mida home (${home.root}). Nothing was shared.`)
})
```

  `connectMcp({ agent })` builds a second server/client pair the same way with that agent. Keep the
  tests in this order in the file (vitest runs them in order); the deletion test is last.

- [ ] **Step 3: Run**

Run: `pnpm vitest run apps/midad/test/mcp.e2e.test.ts apps/midad/test/mcp.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/midad/test/mcp.test.ts apps/midad/test/mcp.e2e.test.ts
git commit -m "test: mida-mcp read-only pin and real-daemon e2e on local Anvil (T4)"
```

---

### Task 5: Codex home — install where Codex reads, trust the transcripts it writes

**Files:**
- Create: `apps/midad/src/codex-home.ts`
- Modify: `apps/midad/src/hook.ts:19-51` (`TRANSCRIPT_DIRS`, `transcriptPathAllowed`) and its call at `hook.ts:143`
- Modify: `apps/midad/src/drain.ts:263`
- Modify: `apps/midad/src/cli.ts` `runInstall` (starts 739; codex config line 810; doctor's codex line 818) (install target, doctor default)
- Modify: `apps/midad/src/index.ts` (exports)
- Test: `apps/midad/test/codex-home.test.ts` (new), `apps/midad/test/hook.test.ts`, `apps/midad/test/install.test.ts`

**Interfaces:**
- Produces:
  - `resolveCodexHome(env: NodeJS.ProcessEnv, homeDir: string): string` — `env.CODEX_HOME` when a non-empty absolute path, else `join(homeDir, ".codex")`.
  - `recordCodexHome(home: MidaHome, dir: string): void` — writes `dir + "\n"` to the home file `codex-home`, mode 0o600, atomically (temp file + rename, as `queue.ts` does).
  - `recordedCodexHome(home: MidaHome): string | undefined` — the trimmed line if absolute, else `undefined`.
  - `transcriptRoots(agent: string, homeDir: string, home?: MidaHome): string[]` — `claude-code` → `[join(homeDir, ".claude/projects")]`; `codex` → `[join(homeDir, ".codex/sessions")]` plus `join(recordedCodexHome(home), "sessions")` when recorded; anything else → `[]`.
  - `transcriptPathAllowed(transcriptPath: unknown, agent: string, homeDir: string, home?: MidaHome): transcriptPath is string` — same checks as today; passes if inside **any** root.

- [ ] **Step 1: Failing tests** — `codex-home.test.ts`:

```ts
it("prefers an absolute CODEX_HOME, else ~/.codex", () => {
  expect(resolveCodexHome({ CODEX_HOME: "/x/codex" }, "/u")).toBe("/x/codex")
  expect(resolveCodexHome({ CODEX_HOME: "rel" }, "/u")).toBe("/u/.codex")
  expect(resolveCodexHome({}, "/u")).toBe("/u/.codex")
})

it("records and reads back the codex home, ignoring junk", () => {
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "h-")))
  expect(recordedCodexHome(home)).toBeUndefined()
  recordCodexHome(home, "/x/codex")
  expect(recordedCodexHome(home)).toBe("/x/codex")
  writeFileSync(home.path("codex-home"), "relative/path\n")
  expect(recordedCodexHome(home)).toBeUndefined()
})
```

  `hook.test.ts`, next to the existing codex test (~199-211):

```ts
it("accepts a codex rollout under the recorded CODEX_HOME, and still refuses outside it", () => {
  const user = mkdtempSync(join(tmpdir(), "u-"))
  const codexHome = mkdtempSync(join(tmpdir(), "ch-"))
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "h-")))
  const rollout = join(codexHome, "sessions/2026/09/22/rollout-x.jsonl")
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(rollout, "{}\n")
  expect(transcriptPathAllowed(rollout, "codex", user, home)).toBe(false) // not recorded yet
  recordCodexHome(home, codexHome)
  expect(transcriptPathAllowed(rollout, "codex", user, home)).toBe(true)
  expect(transcriptPathAllowed(rollout, "claude-code", user, home)).toBe(false) // roots are per agent
  const outside = join(codexHome, "history.jsonl")
  writeFileSync(outside, "{}\n")
  expect(transcriptPathAllowed(outside, "codex", user, home)).toBe(false) // not under sessions/
})
```

  `install.test.ts`: installing Codex with `CODEX_HOME=<tmp>` writes `<tmp>/config.toml` and records
  `<tmp>` in the Mida home (drive it through the same CLI entry the existing install tests use), and
  the written block is byte-identical to `codexBlock()` (no re-trust).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/midad/test/codex-home.test.ts apps/midad/test/hook.test.ts apps/midad/test/install.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `codex-home.ts` (imports: `node:fs`, `node:path`, type-only `./home.js`),
  then in `hook.ts` replace the `TRANSCRIPT_DIRS` lookup:

```ts
export function transcriptPathAllowed(transcriptPath: unknown, agent: string, homeDir: string, home?: MidaHome): transcriptPath is string {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return false
  if (!isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return false
  const roots = transcriptRoots(agent, homeDir, home)
  if (roots.length === 0) return false
  try {
    const stat = lstatSync(transcriptPath)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    const real = realpathSync(transcriptPath)
    return roots.some((root) => {
      try {
        const inside = relative(realpathSync(root), real)
        return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
```

  Pass `input.home` at `hook.ts:143` and `deps.home` at `drain.ts:263`. In `cli.ts`, replace both
  hard-coded `join(homedir(), ".codex", "config.toml")` with
  `join(resolveCodexHome(process.env, homedir()), "config.toml")`; after `installCodex(...)` returns
  `installed` or `already-installed`, call `recordCodexHome(home, resolveCodexHome(process.env, homedir()))`
  (use the home the install command already resolves). Do **not** change `codexBlock()`.

- [ ] **Step 4: Run** `pnpm vitest run apps/midad` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/midad/src/codex-home.ts apps/midad/src/hook.ts apps/midad/src/drain.ts apps/midad/src/cli.ts apps/midad/src/index.ts apps/midad/test
git commit -m "codex: install into CODEX_HOME and trust rollouts under the recorded home (T5)"
```

---

### Task 6: Codex transcript reader, chosen by agent

**Files:**
- Create: `packages/compiler/src/transcript-lines.ts` (bounded head/tail read, moved out of `transcript-claude.ts`)
- Modify: `packages/compiler/src/transcript-claude.ts` (use it; behaviour byte-identical)
- Create: `packages/compiler/src/transcript-codex.ts`
- Modify: `packages/compiler/src/index.ts` (export), `apps/midad/src/drain.ts:14, 292`
- Create: `packages/compiler/test/transcript-codex.test.ts`, `packages/compiler/test/fixtures/codex-rollout-synthetic.jsonl`
- Uses: `packages/compiler/test/fixtures/codex-rollout-real.jsonl` (from Task 0 S2)

**Interfaces:**
- Consumes: `Conversation` (`transcript-claude.ts:53`); `scrubSecrets`, `scrubValue` from `./scrub.js`.
- Produces: `Conversation.format` widens to `"claude-jsonl" | "codex-jsonl" | "unknown-tail"`;
  `readCodexConversation(path: string, opts?: { maxChars?: number }): Conversation`;
  `readTranscriptFor(agent: string, path: string): Conversation | null` — `codex` → Codex reader,
  `claude-code` → `readConversation`, anything else → `null`.

- [ ] **Step 1: Synthetic fixture** `codex-rollout-synthetic.jsonl` (13 lines, exactly):

```jsonl
{"timestamp":"2026-09-22T10:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/tmp/toy"}}
{"timestamp":"2026-09-22T10:00:00.100Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>sandbox</permissions instructions>"}]}}
{"timestamp":"2026-09-22T10:00:00.200Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"Mida: handoff from claude-code — Original request: build the dashboard"}]}}
{"timestamp":"2026-09-22T10:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/toy\n\n<INSTRUCTIONS>be brief</INSTRUCTIONS>"}]}}
{"timestamp":"2026-09-22T10:00:00.400Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/tmp/toy</cwd>\n</environment_context>"}]}}
{"timestamp":"2026-09-22T10:00:01.000Z","type":"turn_context","payload":{"cwd":"/tmp/toy","model":"x"}}
{"timestamp":"2026-09-22T10:00:01.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Make emergencies pulse, not red. API_KEY=sk-live-abcdefghijklmnop"}]}}
{"timestamp":"2026-09-22T10:00:02.000Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}}
{"timestamp":"2026-09-22T10:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"ls\"]}","call_id":"c1"}}
{"timestamp":"2026-09-22T10:00:03.500Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"README.md\nsrc"}}
{"timestamp":"2026-09-22T10:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done: the spacecraft pulses and shows EMERGENCY."}]}}
{"timestamp":"2026-09-22T10:00:04.100Z","type":"event_msg","payload":{"type":"token_count"}}
not json at all
```

- [ ] **Step 2: Failing tests** `transcript-codex.test.ts`:

```ts
const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

it("finds the human's first request, skipping Codex and Mida scaffolding, scrubbed", () => {
  const c = readCodexConversation(fx("codex-rollout-synthetic.jsonl"))
  expect(c.format).toBe("codex-jsonl")
  expect(c.firstUserMessage).toMatch(/^Make emergencies pulse, not red\./)
  expect(c.firstUserMessage).not.toContain("sk-live-abcdefghijklmnop")
})

it("renders user, tool and assistant lines with real line numbers, drops reasoning and events", () => {
  const c = readCodexConversation(fx("codex-rollout-synthetic.jsonl"))
  expect(c.text).toContain("L7 user:")
  expect(c.text).toContain("L9 tool:")
  expect(c.text).toContain("L10 tool-result:")
  expect(c.text).toContain("L11 assistant:")
  for (const gone of ["thinking", "token_count", "Mida: handoff", "<environment_context>", "AGENTS.md", "sk-live-abcdefghijklmnop"]) {
    expect(c.text).not.toContain(gone)
  }
  expect(c.messagesKept).toBe(4)
})

it("collects cwds from session_meta and turn_context", () => {
  expect(readCodexConversation(fx("codex-rollout-synthetic.jsonl")).cwds).toEqual(["/tmp/toy"])
})

it("answers unknown-tail for a file with no Codex records (e.g. a Claude transcript)", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cx-")), "t.jsonl")
  writeFileSync(p, `{"type":"user","message":{"content":"hi"}}\n`)
  const c = readCodexConversation(p)
  expect(c.format).toBe("unknown-tail")
  expect(c.firstUserMessage).toBeNull()
})

it("reads the real rollout captured in spike S2", () => {
  const c = readCodexConversation(fx("codex-rollout-real.jsonl"))
  expect(c.format).toBe("codex-jsonl")
  expect(c.firstUserMessage).toMatch(/spike S2 was here/)
  expect(c.text).toContain("tool:")
  expect(c.text).not.toContain("MIDA HANDOFF")
  expect(c.text).not.toContain("recommended_plugins")
})

it("dispatches by agent and refuses unknown agents", () => {
  expect(readTranscriptFor("codex", fx("codex-rollout-synthetic.jsonl"))?.format).toBe("codex-jsonl")
  expect(readTranscriptFor("gemini", fx("codex-rollout-synthetic.jsonl"))).toBeNull()
})
```

  The existing `transcript-claude.test.ts` must pass **unchanged** after the refactor.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run packages/compiler`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**
  - `transcript-lines.ts`: move the bounded open-once head (64 KB) / tail (60,000 B) reading out of
    `transcript-claude.ts` without changing its behaviour, exported for both readers. The Claude
    reader's tests stay green untouched; that is the proof the move changed nothing.
  - `transcript-codex.ts`, per line, in order:
    - not JSON, or no string `type` → skipped.
    - `session_meta` / `turn_context` → `payload.cwd` (non-empty string) into `cwds`, unique, first-seen order.
    - `response_item` + `payload.type === "message"`:
      - `role` `developer` or `system` → skipped.
      - text = join of `content[].text` for parts typed `input_text` or `output_text`.
      - `role === "user"` and `text.trimStart()` starts with one of
        `INJECTED_PREFIXES = ["<environment_context>", "<user_instructions>", "<recommended_plugins>", "# AGENTS.md instructions", "<INSTRUCTIONS>", "MIDA HANDOFF", "Mida:"]` → skipped. (S2: Codex injected `<recommended_plugins>` as a **user** message; Mida's handoff arrived as a **developer** message starting `MIDA HANDOFF`.)
      - else a kept `user` / `assistant` block: `L<n> <role>:` + scrubbed text, parts cut at 600 chars (`PART_CHARS`).
      - the first kept `user` block's full text, scrubbed with `scrubSecrets` and capped at 6,000
        chars including `…` (the Claude reader's helper) → `firstUserMessage`.
    - `payload.type === "function_call"` → `L<n> tool:` + `${name} ${arguments}`, cut at 600, scrubbed.
    - `payload.type === "custom_tool_call"` (what Codex 2026-09 actually writes, S2) → `L<n> tool:` + `${name} ${input}`, cut at 600, scrubbed.
    - `payload.type === "function_call_output"` or `"custom_tool_call_output"` → `L<n> tool-result:` +
      `output`, where `output` is either a string or an array of `{ type, text }` parts (join the
      `text`s) — S2 saw the array form; cut at 600, scrubbed.
    - `reasoning` (encrypted in S2 — never render `encrypted_content`), `event_msg`, `compacted`,
      `world_state`, `token_usage_record`, anything else → skipped.
    - zero kept messages → the `unknown-tail` shape with `firstUserMessage: null`.
    - apply the same `maxChars` budget and `[… N earlier messages omitted …]` marker as the Claude
      reader, reusing its helper.
  - `drain.ts:292`: `const convo = readTranscriptFor(job.agent, job.transcriptPath)`; when
    `convo === null || convo.format === "unknown-tail"` take the existing `unknown-transcript-format`
    branch unchanged.
  - grep the repo for `"claude-jsonl"`; any exhaustive switch on `format` accepts `"codex-jsonl"` the same way.

- [ ] **Step 5: Run**

Run: `pnpm vitest run packages/compiler apps/midad`
Expected: PASS, including `transcript-claude.test.ts` untouched and `drain.e2e.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/compiler/src packages/compiler/test apps/midad/src/drain.ts
git commit -m "compiler: Codex rollout reader; drain picks the reader by agent (T6)"
```

---

### Task 7: Disclosure wording and client docs

**Files:**
- Modify: `apps/midad/src/handoff.ts:71-72` (`revokedText`), `apps/midad/src/mcp.ts:210-212`
- Modify: `apps/midad/src/cli.ts` approve preview (just before `Type yes to approve:`, line 344) and both revoke outputs (`cli.ts:372`, `cli.ts:584`)
- Modify: `apps/owner-page/src/owner/revoke.ts:35`, and the owner page's approve confirmation copy (grep `apps/owner-page/src/owner`)
- Modify: `docs/quickstart.md` §10 and §12, `publish/cli/README.md`
- Test: every test pinning these strings (grep the old strings under `apps/*/test`); Task 4's revoked assertion

- [ ] **Step 1: Update tests first.** Only the *revoked* assertions of `Nothing was shared.` change
  (tamper and unreadable keep theirs). Tighten Task 4's revoked assertion to the exact revoked string
  from Global Constraints. Add: the approve preview prints the approve line immediately before the
  `Type yes to approve:` prompt; `mida revoke <agent>` prints the revoke line after the tx line; the
  owner-page revoke screen contains the addition.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/midad apps/owner-page`
Expected: FAIL on the changed strings.

- [ ] **Step 3: Change the strings** exactly as in Global Constraints. `mcp.ts` reproduces the
  revoked line (it cannot import handoff.ts) — change both copies.

- [ ] **Step 4: Docs**
  - `docs/quickstart.md` §10: add the disclosure paragraph from spec §4.5 verbatim.
  - `docs/quickstart.md` §12, rewritten to contain: the disclosure paragraph; three configs —
    Claude Desktop (absolute `--project`, `env.MIDA_HOME`), Cursor `.cursor/mcp.json` with
    `"--project", "${workspaceFolder}"`, Codex `[mcp_servers.mida]` in `$CODEX_HOME/config.toml`
    with `command`, `args` and `[mcp_servers.mida.env]`; "`--as` is startup configuration: default
    `assistant`, any registered agent name, and no tool can change it"; "Revoking `assistant` stops
    future reads for every client started as `assistant`"; the two startup refusals and what each
    means; "claude.ai web and mobile: not supported — they only call public HTTPS servers from
    Anthropic's cloud, and Mida does not run one"; "ChatGPT: through OpenAI's Secure MCP Tunnel where
    your ChatGPT plan allows developer-mode apps"; every client marked **NOT RUN** until Task 8 flips it.
  - Also in §12: **"Any MCP harness"** — one generic stdio block (`command` = absolute path to
    `node`, `args` = [absolute path to the `mida-mcp` entry, `--as`, `assistant`, `--project`,
    `<absolute project folder>`], `env.MIDA_HOME`) with a one-line note on where Cursor, Windsurf,
    VS Code, Zed and Gemini CLI keep that block (link each client's own MCP docs; do not claim any
    as validated); **"macOS: desktop apps cannot run anything under Desktop, Documents or
    Downloads"** — install Mida and keep MCP projects outside them, with the two startup lines a user
    will see; and the claude.ai section from Task 10 if S4 passed, else "claude.ai web and mobile:
    not supported in v0 — <S4's exact reason>".
  - `publish/cli/README.md`: the disclosure paragraph under revoke.

- [ ] **Step 5: Full gates** (one command per call)

Run: `pnpm vitest run`, then `pnpm typecheck`, then `pnpm check:publish`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps docs/quickstart.md publish/cli/README.md
git commit -m "copy: revocation stops future reads, never recalls past ones; MCP client docs (T7)"
```

---

### Task 9: `mida-mcp --http` — the same server over Streamable HTTP, loopback only (gated on S4)

**Brief only if S4 passed.**

**Files:**
- Create: `apps/midad/src/mcp-http.ts`
- Modify: `apps/midad/src/mcp.ts` (`parseMcpArgs`: `--http <port>`), `apps/midad/src/mcp-main.ts` (choose transport)
- Test: `apps/midad/test/mcp-http.test.ts` (new); `mcp.test.ts` import-graph test extended to walk `mcp-http.ts`

**Interfaces:**
- Consumes: `createMidaMcpServer(deps)`, `startupCheck` (Task 2), `McpArgs` (Task 1).
- Produces: `McpArgs.httpPort?: number`; `startMcpHttp(opts: { port: number; makeServer: () => Server; verify: (req: IncomingMessage) => Promise<boolean> }): Promise<{ close(): Promise<void>; port: number; address(): AddressInfo }>`
  — binds `127.0.0.1` only; `verify` is Task 10's Access check (in this task, tests pass an
  always-true stub, and `mcp-main.ts` refuses to start `--http` without Task 10's flags once Task 10
  lands).

- [ ] **Step 1: Failing tests** (`mcp-http.test.ts`)

```ts
it("parses --http with a port and refuses bad ports", () => {
  expect(parseMcpArgs(["--http", "8765"])).toMatchObject({ ok: true, args: { httpPort: 8765 } })
  for (const bad of ["0", "70000", "abc", "-1"]) expect(parseMcpArgs(["--http", bad]).ok, bad).toBe(false)
  expect(parseMcpArgs(["--http", "1", "--http", "2"])).toEqual({ ok: false, error: "--http given twice" })
})

it("listens on 127.0.0.1 only", async () => {
  const srv = await startMcpHttp({ port: 0, makeServer: () => createMidaMcpServer(fakeDeps()), verify: async () => true })
  const addr = srv.address() // expose the bound address from startMcpHttp for this test
  expect(addr.address).toBe("127.0.0.1")
  await srv.close()
})

it("serves the same four tools over HTTP", async () => {
  const srv = await startMcpHttp({ port: 0, makeServer: () => createMidaMcpServer(fakeDeps()), verify: async () => true })
  const client = new Client({ name: "t", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)))
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["mida_handoff", "mida_read", "mida_status", "mida_whats_new"])
  await srv.close()
})

it("refuses a request the verifier rejects with 401 and no MCP body", async () => {
  const srv = await startMcpHttp({ port: 0, makeServer: () => createMidaMcpServer(fakeDeps()), verify: async () => false })
  const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  expect(res.status).toBe(401)
  expect(await res.text()).not.toContain("mida_read")
  await srv.close()
})

it("answers only /mcp", async () => {
  const srv = await startMcpHttp({ port: 0, makeServer: () => createMidaMcpServer(fakeDeps()), verify: async () => true })
  expect((await fetch(`http://127.0.0.1:${srv.port}/`)).status).toBe(404)
  await srv.close()
})
```

  `fakeDeps()` = the deps object the fake-daemon tests in `mcp.test.ts` already build; move it to a
  shared test helper file if it is not exported. `StreamableHTTPClientTransport` comes from
  `@modelcontextprotocol/sdk/client/streamableHttp.js`.

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run apps/midad/test/mcp-http.test.ts` → FAIL.

- [ ] **Step 3: Implement** `mcp-http.ts` with `node:http` and the SDK's
  `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` in
  **stateless** mode (`sessionIdGenerator: undefined`), one fresh server + transport per request, as
  the SDK's stateless example does:

```ts
export async function startMcpHttp(opts: {
  port: number
  makeServer: () => Server
  verify: (req: IncomingMessage) => Promise<boolean>
}) {
  const http = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
      res.writeHead(404).end()
      return
    }
    if (!(await opts.verify(req).catch(() => false))) {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized")
      return
    }
    const server = opts.makeServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((ok) => http.listen(opts.port, "127.0.0.1", ok))
  const address = http.address() as AddressInfo
  return {
    port: address.port,
    address: () => address,
    close: () => new Promise<void>((ok) => http.close(() => ok())),
  }
}
```

  (Adjust `transport.handleRequest(req, res)` to the SDK 1.30 signature in `streamableHttp.d.ts:107`
  — it may take a parsed body third argument.) `mcp-http.ts` imports only `node:*`, the SDK and
  `./mcp.js`; extend the import-graph test to start its walk at `mcp-http.ts` too.
  `mcp-main.ts`: when `httpPort` is set, after `startupCheck` and `ensureDaemon`, call `startMcpHttp`
  with `makeServer: () => createMidaMcpServer({ …same deps… })` instead of connecting stdio, print one
  stderr line `mida-mcp: serving <agent> for <project> on http://127.0.0.1:<port>/mcp`, and stay up.

- [ ] **Step 4: Run** `pnpm vitest run apps/midad` → PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/midad/src/mcp-http.ts apps/midad/src/mcp.ts apps/midad/src/mcp-main.ts apps/midad/test
git commit -m "mcp: --http serves the same read-only tools on 127.0.0.1 (claude.ai path, T9)"
```

---

### Task 10: Cloudflare Access check in HTTP mode, and the claude.ai docs (gated on S4)

**Brief only if S4 passed.**

**Files:**
- Create: `apps/midad/src/access-token.ts`
- Modify: `apps/midad/package.json` (add `jose` `^6.2.12` as a direct dependency — it is only
  transitive today), `apps/midad/src/mcp.ts` (`--access-team <domain>`, `--access-aud <tag>`),
  `apps/midad/src/mcp-main.ts`, `docs/quickstart.md` (new §12c), `publish/cli/package.json` via
  `pnpm build:publish` if dependencies are regenerated there
- Test: `apps/midad/test/access-token.test.ts`

**Interfaces:**
- Produces: `makeAccessVerifier(opts: { teamDomain: string; aud: string; jwks?: JWTVerifyGetKey }): (req: IncomingMessage) => Promise<boolean>`
  — true only when `cf-access-jwt-assertion` is present, verifies with `jose.jwtVerify` against
  `https://<teamDomain>/cdn-cgi/access/certs`, `issuer: https://<teamDomain>`, `audience: aud`,
  and is not expired. `mcp-main.ts` refuses `--http` unless both `--access-team` and `--access-aud`
  are given: `mida-mcp: --http needs --access-team and --access-aud — the HTTP mode never runs unprotected`.

- [ ] **Step 1: Failing tests** — generate an RS256 key pair with `jose.generateKeyPair`, pass a
  local JWKS through `opts.jwks` (`jose.createLocalJWKSet`), and sign tokens with `jose.SignJWT`:

```ts
it("accepts a valid Access token for this team and audience", async () => {
  expect(await verifier(reqWith(await token({ iss: "https://t.cloudflareaccess.com", aud: "AUD1" })))).toBe(true)
})
it("refuses a missing header, wrong audience, wrong issuer, expired token, or another key", async () => {
  expect(await verifier(reqWith(undefined))).toBe(false)
  expect(await verifier(reqWith(await token({ iss: "https://t.cloudflareaccess.com", aud: "OTHER" })))).toBe(false)
  expect(await verifier(reqWith(await token({ iss: "https://evil.cloudflareaccess.com", aud: "AUD1" })))).toBe(false)
  expect(await verifier(reqWith(await token({ iss: "https://t.cloudflareaccess.com", aud: "AUD1", exp: 1 })))).toBe(false)
  expect(await verifier(reqWith(await tokenSignedByOtherKey()))).toBe(false)
})
it("refuses to start --http without both Access flags", () => {
  // spawn mcp-main with --http 0 only; expect exit 2 and the exact stderr line above
})
```

  (`reqWith(t)` builds `{ headers: t ? { "cf-access-jwt-assertion": t } : {} }` cast to `IncomingMessage`.)

- [ ] **Step 2: Run to verify they fail**, **Step 3: implement** `access-token.ts` with
  `jose.createRemoteJWKSet(new URL("https://" + teamDomain + "/cdn-cgi/access/certs"))` as the default
  key source and `jwtVerify(token, jwks, { issuer, audience })`, returning `false` on any throw;
  wire it as Task 9's `verify`. **Step 4: run** `pnpm vitest run apps/midad`, `pnpm typecheck`,
  `pnpm check:publish` → green.

- [ ] **Step 5: Docs** — `docs/quickstart.md` new §12c "claude.ai (web and phone)": what it is (the
  laptop answers; a Cloudflare tunnel carries the question in; Cloudflare Access checks it is you;
  Mida checks Access's token again); the exact S4 setup steps that worked, with the tunnel pointed at
  `mida-mcp --as assistant --project <dir> --http 8765 --access-team <team> --access-aud <aud>`;
  "works only while your laptop and Mida are running"; the disclosure paragraph; the shared-identity
  limit; "NOT RUN" until Task 8 V6 flips it.

- [ ] **Step 6: Commit**

```bash
git add apps/midad/src/access-token.ts apps/midad/src/mcp.ts apps/midad/src/mcp-main.ts apps/midad/package.json pnpm-lock.yaml apps/midad/test docs/quickstart.md publish
git commit -m "mcp: HTTP mode requires a valid Cloudflare Access token; claude.ai docs (T10)"
```

---

### Task 8: Verify, review, prove on real clients (Claude + Dami — not Devin)

- [ ] **Claude verifies** each Devin task by running its tests and reading the diff; after Task 7,
  runs `pnpm vitest run`, `pnpm typecheck`, `pnpm check:publish` and records counts in `log.md`.
- [ ] **ONE Opus subagent batch review** of `p0-clients` against its base — adversarial, briefed with
  spec §4 and this plan's Review Focus. Fix round via Devin if needed.
- [ ] **Merge** after the migration branch has merged: rebase `p0-clients` onto the new
  `p0-m0-skeleton` head, re-run the full gates, fast-forward. Hand-merge any conflict in `cli.ts` /
  `install.ts`, then re-run.
- [ ] **Move the live copy:** `git -C ~/Desktop/mida-context-live checkout --detach <verified head>`, then `pnpm install` there.
- [ ] **Live validation** — one home (`home-v2`), one daemon, project `toy4`. Write
  `docs/evidence/clients-2026-09-<dd>.json`, one object per client:

```json
{
  "client": "claude-desktop",
  "mechanism": "local stdio MCP (claude_desktop_config.json)",
  "reachedRealDaemon": true,
  "identity": "assistant",
  "toolsWorked": ["mida_handoff", "mida_read", "mida_status", "mida_whats_new"],
  "realContextReturned": true,
  "unapprovedAnswer": "<exact text>",
  "afterRevokeAnswer": "<exact text>",
  "startupRefusals": { "wrongHome": "<stderr line>", "noProject": "<stderr line>" },
  "limits": ["<platform limits observed>"],
  "label": "PROVEN"
}
```

  - **V1 Claude Code** (hooks): one short task, kill, confirm a checkpoint saved (re-run).
  - **V2 Codex** (hooks): a fresh `codex` "Continue." in `toy4` gets the handoff (re-run); then a
    Codex task whose Stop hook saves — `drain.jsonl` shows it compiled — and
    `mida read --as claude-code` shows Codex's work. First proof of capture out of Codex.
  - **V3 Claude Desktop** (MCP, `assistant`): the S1 config; ask "What is the emergency-state design
    decision for this project?"; Dami runs `mida revoke assistant`; ask again; then a wrong
    `MIDA_HOME` and a missing `--project` to capture both startup refusals from
    `~/Library/Logs/Claude/mcp-server-mida.log`. Re-approve afterwards.
  - **V4 Cursor** (MCP, `assistant`): only if Dami installs Cursor; `.cursor/mcp.json` in `toy4` with
    `${workspaceFolder}`. Otherwise `"label": "NOT VALIDATED — not installed"`.
  - **V5 ChatGPT** (MCP via Secure MCP Tunnel, `assistant`): only if S3 succeeded; same question.
    Otherwise the exact limitation from S3 — and, if Tasks 9–10 landed, try ChatGPT developer mode
    against the Access-protected endpoint (spec §4.7 fallback) and record that instead.
  - **V6 claude.ai web + phone** (MCP over HTTPS, `assistant`): only if Tasks 9–10 landed. Real
    named tunnel `mcp.midacontext.xyz` → `mida-mcp --http 8765 --access-team … --access-aud …`;
    connector added on claude.ai; demo question on web, then on the phone; `mida revoke assistant`,
    ask again on both; `curl -i` without login refused; a request forged locally to
    `127.0.0.1:8765/mcp` without the Access header gets 401.
  - **V7 any other harness**: whichever of Cursor / Windsurf / VS Code / Zed / Gemini CLI is installed
    on the day, with the generic block from the docs. Anything not installed:
    `"label": "NOT VALIDATED — not installed"`.
  - Flip each quickstart **NOT RUN** mark only for clients that passed.
- [ ] **Acceptance check** against spec §6: every row filled; each cross-client rule demonstrated
  (identity cannot be switched: Task 4 e2e + V3; no signing: import-graph test + read-only pin;
  forward-only revoke: V3's after-revoke text) or marked with the exact gap.

## Order and dependencies

```
Migration plan B lands ──► re-check refs (banner) ──► Task 1
Task 0: S1 ✓ (one re-run owed), S2 ✓, S3 and S4 before their gated tasks
Task 1 ──► Task 2 ──► Task 3 ──► Task 4 ──► Task 7 (tightens Task 4's revoked assertion)
Task 5 ──► Task 6
S4 passed ──► Task 9 ──► Task 10 (after Task 2; Task 7's claude.ai line waits for S4's verdict)
All ──► Task 8
```

Brief Devin in the order 1, 2, 3, 4, 5, 6, 9, 10, 7 on one branch (skip 9–10 if S4 failed) — Tasks 1–3 and 5 share `mcp.ts` /
`cli.ts`, so parallel runs would collide.

## Not done by this plan (on purpose)

No MCP writes; no remote endpoint, relay or cloud key; no per-client identities or registration UX;
no new Codex hook events (would force every user to re-trust hooks); no live MCP handshake in
`mida doctor` (it still only checks the file exists); no hooks for harnesses other than Claude Code
and Codex (they get MCP only); no Mida-run relay — claude.ai goes through Cloudflare's tunnel and
Access, and only if S4 passes; **`mida doctor` says "approved" where reads are refused** (spec §4.8)
— noted by Dami's decision, NOT fixed here (the migration session traced a related cause to an old
contract still in use); the Codex desktop app's hooks are inherited from the shared config but validated only if
Dami runs V2 from the app.
