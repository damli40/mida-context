# Plan A — A setup keeps its contract, names its failures, and never talks to a stale service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementer is Devin CLI from one written brief per task (`.devin/briefs/a-task-N.md`); Claude writes the briefs, runs the suite itself, and sends ONE Opus reviewer over the whole batch.

**Goal:** Every Mida entry point uses the contract, store and sponsor the setup saved; `init` never rewrites them; no command prints a bare `refused: ERROR`; and a command never talks to a background service running other code.

**Architecture:** Four places each work out the network on their own today (cli.ts:745 via `testnetNetwork`, daemon-main.ts:16, drain-main.ts:20-34, doctor.ts:92-100 + 165-175), and they disagree. One new module, `network.ts`, owns the rule; every entry point calls it. Errors with no code get a name at the two CLI refusal points. The service reports which code it runs; the command replaces it on a mismatch.

**Tech Stack:** TypeScript (ES modules, `tsx`), Vitest, viem, Node built-ins. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-deployment-binding-and-migrate-design.md` §3, §4, §6 (and §10 checks E6, H5, H6). Issue register rows CHAIN-07, 08, 09, 10, 11. Plan B (`mida migrate`, spec §5) builds on this plan's `resolveNetwork` and is written separately.

**Deviation from the spec, stated plainly:** spec §4.1 says change `toMidaError` (packages/chain/src/registry.ts:60) to always return a `MidaError`. It has 14 callers across the chain package, the API, the owner page and the SDK, and some pass the raw error on or inspect it (`chain-views.ts:120`, the debug line's `shortMessage` at cli.ts:353). This plan instead names an uncoded error **at the CLI refusal points only** (Task 3). Same user-visible result (no `refused: ERROR`), no change to any other package. Spec §4 is amended in the same commit as Task 3.

## Global Constraints

- One command per Devin call; never `rm`, `curl`, `env`, `claude`, `codex`, `git push/reset/checkout/clean/rebase`; never open `.env`; never `pnpm mida*`; never set `MIDA_E2E_MONAD_TESTNET`; no `pnpm install`. Testnet and real-agent runs are Claude's or Dami's only.
- Never weaken an existing assertion. Exported names and signatures stay (`testnetNetwork`, `serviceUrl`, `serviceUrlInEffect`, `callDaemon`, `ensureDaemon`); you may add.
- Logs carry stable codes, names, counts and timings only. Never transcript text, file paths or `error.message`.
- Every rule states what happens **the first time** (no `network.json` yet) and on **empty input** (a value present but empty). If a brief leaves one unstated, stop and ask.
- A test that checks which contract was used asks THE CHAIN or reads the object the code actually built, never a value the test itself set.
- Stage by explicit path. `brand/`, `spikes/` and `docs/evidence/m0-local-anvil.json` are never committed.
- Run tests with `npx vitest run <path>`; the full suite with `npx vitest run` before the batch review.

---

## File Structure

| File | One responsibility |
|---|---|
| `apps/midad/src/network.ts` (new) | `resolveNetwork`: the ONE rule for which contract, RPC, store and sponsor a home uses |
| `apps/midad/src/debug-line.ts` (new) | `refusalCode` (names an uncoded error) and `debugLine` (the masked `MIDA_DEBUG=1` line) |
| `apps/midad/src/code-identity.ts` (new) | `codeIdentity()`: the folder and git commit this process's code runs from |
| `apps/midad/src/cli.ts` | calls `resolveNetwork` instead of `testnetNetwork`; prints the mismatch line; uses `refusalCode`/`debugLine`; sends `debug` to the service |
| `apps/midad/src/daemon-main.ts`, `drain-main.ts` | call `resolveNetwork` instead of reading `network.json` inline |
| `apps/midad/src/doctor.ts` | network check names the contract and any mismatch; store/sponsor lines use the resolved source; service code line |
| `apps/midad/src/skeleton.ts`, `owner-link/flows.ts` | `init` / `initPasskey` write `network.json` only when absent; refuse on a mismatch |
| `apps/midad/src/daemon.ts` | `/health` gains `codeRoot`, `codeCommit`; new `POST /shutdown`; `/cli` accepts `debug` |
| `apps/midad/src/control.ts` | `ensureCurrentDaemon` compares code identity and replaces a stale service |

---

### Task 1: `resolveNetwork`, the one rule

**Files:** Create `apps/midad/src/network.ts`, `apps/midad/test/network.test.ts`. Modify `apps/midad/src/testnet.ts` (extract `funderFor`), `apps/midad/src/index.ts` (export).

**Interfaces — Produces:**

```ts
// network.ts
import type { Deployment } from "@mida/chain"
import type { MidaHome } from "./home.js"
import type { Network } from "./runtime.js"

export type ServiceSource = "environment" | "off" | "network.json" | "local" | "hosted-default"
export interface ResolvedNetwork {
  network: Network                       // what the process must use
  saved: boolean                         // true when network.json existed
  contractSource: "network.json" | "built-in" | "deployments-dir"
  builtIn: Deployment                    // the record this code ships (or MIDA_DEPLOYMENTS_DIR's)
  /** set when saved and the built-in record names a different contract */
  mismatch?: { saved: string; builtIn: string }   // capabilityRegistry addresses, lowercase
  storage: { url: string | undefined; source: ServiceSource }
  sponsor: { url: string | undefined; source: ServiceSource }
}
export interface ResolveDeps {
  /** default: loadDeployment(MONAD_TESTNET_CHAIN_ID, env.MIDA_DEPLOYMENTS_DIR) — tests inject */
  loadBuiltIn?: () => Deployment
  /** default true: the testnetNetwork chain-id probe; daemon, drainer and doctor pass false */
  probeChainId?: boolean
}
export async function resolveNetwork(home: MidaHome, env: Record<string, string | undefined>, deps?: ResolveDeps): Promise<ResolvedNetwork>
/** One line for owner commands and doctor, or undefined when there is no mismatch. */
export function mismatchLine(resolved: ResolvedNetwork): string | undefined
/** For daemon-main and drain-main: undefined when the home has no network.json (their first-time behaviour stays theirs). */
export async function serviceNetwork(home: MidaHome, env: Record<string, string | undefined>): Promise<Network | undefined>
```

Throws errors carrying a string `code` (use `Object.assign(new Error(msg), { code })`, as `codedError` in skeleton.ts does):
- `network-json-invalid`: `network.json` exists but cannot be parsed or lacks `rpcUrl` / `deployment`.
- `deployment-conflict`: `MIDA_DEPLOYMENTS_DIR` is set AND `network.json` exists AND they name different contracts. Message names both addresses.

**The rule (every case, including first time and empty):**

| Case | Contract | RPC | Store | Sponsor |
|---|---|---|---|---|
| No `network.json` (first time) | built-in (or `MIDA_DEPLOYMENTS_DIR`) | `MONAD_TESTNET_RPC` if non-empty, else viem default | `serviceUrl(env.MIDA_STORAGE_URL, HOSTED_STORAGE_URL)` exactly as `testnetNetwork` does today; source `environment` / `off` / `hosted-default` | same with `MIDA_SPONSOR_URL` |
| `network.json` present | **saved** `deployment` (`parseDeployment`) | `MONAD_TESTNET_RPC` if non-empty, else saved `rpcUrl` | env `"off"` → none (`off`); env non-empty URL → it (`environment`); else saved non-empty `storageUrl` (`network.json`); else **none = the local store** (`local`). Never the hosted default | same rule; none = self-paid gas (`local`) |
| `MIDA_DEPLOYMENTS_DIR` set, `network.json` present, same contract | saved | as above | as above | as above |
| `MIDA_DEPLOYMENTS_DIR` set, `network.json` present, different contract | throw `deployment-conflict` | | | |
| Env value present but empty string (e.g. `MIDA_STORAGE_URL=""`) | treated as unset | | | |

"Same contract" = same `chainId` AND same `capabilityRegistry` AND same `contextRegistry`, compared lowercase. `mismatch` is set when `network.json` is present and the built-in record differs by that test. `fund`: built exactly as `testnetNetwork` builds it (only when `DEPLOYER_PRIVATE_KEY` is set). Move that code into `export function funderFor(env, rpcUrl, deployment): Network["fund"] | undefined` in testnet.ts and call it from both; `testnetNetwork` keeps its signature and behaviour. The chain-id probe (testnet.ts:33-37) runs against the RESOLVED deployment's chain id when `probeChainId` is true.

`mismatchLine`: `this setup is on contract ${short(saved)}; this version of Mida ships ${short(builtIn)} — run \`mida migrate\` to move`, where `short(a)` = first 6 characters + `…`.

- [ ] **Step 1: Write the failing tests** in `apps/midad/test/network.test.ts`, one `it` per table row plus:
  - saved home, no env → store source `local`, url undefined (the Sep 22 `~/.mida` case)
  - saved home with `storageUrl` → that url, source `network.json`
  - saved home, `MIDA_STORAGE_URL=off` → undefined, `off`; `MIDA_STORAGE_URL=https://x.example` → it, `environment`
  - saved deployment X, injected built-in Y → `network.deployment.capabilityRegistry` is X's, `mismatch` names both, `mismatchLine` contains both short addresses and `mida migrate`
  - saved = built-in → no `mismatch`, `mismatchLine` undefined
  - `network.json` = `{}` → throws code `network-json-invalid`
  - `serviceNetwork` on a home without `network.json` → undefined
  Use a temp `MidaHome` (see `apps/midad/test/helpers.ts`), `probeChainId: false`, and records shaped like `docs/evidence/deployment-10143-vault.mida.xyz-2026-09-17.json` (X) and `contracts/deployments/10143.json` (Y).
- [ ] **Step 2: Run** `npx vitest run apps/midad/test/network.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement** `network.ts` and `funderFor` per the table.
- [ ] **Step 4: Run** the test — expected PASS. Run `npx vitest run apps/midad/test/sponsor-url.test.ts apps/midad/test/cli.test.ts` — expected PASS (no behaviour change yet).
- [ ] **Step 5: Commit** `git add apps/midad/src/network.ts apps/midad/src/testnet.ts apps/midad/src/index.ts apps/midad/test/network.test.ts && git commit -m "feat(midad): resolveNetwork — the saved contract, store and sponsor win (CHAIN-07/11)"`

---

### Task 2: every entry point uses it; `init` never rewrites it (CHAIN-07, 08, 11; check E6)

**Files:** Modify `apps/midad/src/cli.ts:742-745` (main), `daemon-main.ts:14-26`, `drain-main.ts:20-35`, `doctor.ts:92-100, 165-175, 294-305`, `skeleton.ts:108-121` (`init`), `owner-link/flows.ts:250-258` (`initPasskey`), `cli.ts:363-431` (`ownerRefusalLine`). Tests: `apps/midad/test/network-entry.test.ts` (new), extend `apps/midad/test/doctor.test.ts`, new `apps/midad/test/init-network.e2e.test.ts`, extend `apps/midad/test/connect.e2e.test.ts`.

**Interfaces — Consumes:** Task 1's `resolveNetwork`, `mismatchLine`, `serviceNetwork`. **Produces:** `export async function networkForCommand(home: MidaHome, env: Record<string, string | undefined>, deps?: ResolveDeps): Promise<ResolvedNetwork>` in cli.ts (main calls it; tests call it).

**Rules:**
1. `cli.ts` main: replace `const network = await testnetNetwork(process.env)` with `const resolved = await networkForCommand(home, process.env)` and pass `resolved.network` everywhere `network` went. For an OWNER command (`OWNER_COMMANDS`), if `mismatchLine(resolved)` is defined, write it to **stderr** before running the command (stdout shape unchanged). A thrown `deployment-conflict` / `network-json-invalid` reaches the existing catch at the bottom of cli.ts (`mida: <message>`, exit 1).
2. `daemon-main.ts` and `drain-main.ts`: replace the inline `network.json` read with `serviceNetwork(home, process.env)`, then override `fund` with their existing throwing closures. **First time** (`serviceNetwork` returns undefined): today's behaviour exactly — daemon `process.exit(1)` quietly; drainer throws `network.json is missing or incomplete; run mida init first`.
3. `doctor.ts`: the `network` check calls `resolveNetwork(home, env, { probeChainId: false })`. Lines:
   - `ok: network.json present — contract ${short(capabilityRegistry)}`
   - when `mismatch`: an extra `note: ${mismatchLine}` (a note, not a problem: the setup still works)
   - `deployment-conflict` → `problem("MIDA_DEPLOYMENTS_DIR names a different contract than this setup", "unset MIDA_DEPLOYMENTS_DIR")`
   - `network-json-invalid` or no file → today's `problem("network.json is missing or unreadable", INIT_FIX)`
   `serviceUrls` (doctor.ts:165) is replaced by the resolved `storage` / `sponsor`. For source `local` the store line reads `store: local (this setup saved no store address)` and the sponsor line `sponsor: none — this setup pays its own gas`; other sources keep today's wording. Any check that probed the hosted default "as if this home used it" must now skip for `local`.
4. `init` (skeleton.ts:113) and `initPasskey` (flows.ts:250): **write `network.json` only when the home has none.** When it exists: if `resolveNetwork(...).mismatch` is set, throw `codedError("deployment-mismatch", …)` before any chain call; `ownerRefusalLine` gets the case `this setup is on contract ${short(saved)}; this version of Mida ships ${short(builtIn)}. \`init\` will not move it — run \`mida migrate\``. When it exists and matches, leave the file byte-identical and continue init's idempotent steps.
5. `connectAgent` (packages/sdk/src/connect.ts:283-300) already prefers the saved deployment and treats a missing saved `storageUrl` as local. Do not change it; add one assertion that it picks the saved deployment.

- [ ] **Step 1: Write failing tests:**
  - `network-entry.test.ts`: temp home with `network.json` = deployment X, injected built-in Y. `networkForCommand` → X. `serviceNetwork` → X. A home without `network.json` → `serviceNetwork` undefined.
  - `doctor.test.ts`: saved home without `storageUrl` → output contains `store: local (this setup saved no store address)` and NOT `store.midacontext.xyz`. Saved X, built-in Y → a `note:` line naming both.
  - **E6** `init-network.e2e.test.ts` on local Anvil (`localEnvironment()` as in skeleton.e2e.test.ts): run `init`; read `network.json` bytes; run `init` again → bytes identical. Then rewrite the saved `deployment.capabilityRegistry` to another valid address and run `init` → rejects with code `deployment-mismatch`, and that call leaves `network.json` unchanged.
- [ ] **Step 2: Run** `npx vitest run apps/midad/test/network-entry.test.ts apps/midad/test/doctor.test.ts apps/midad/test/init-network.e2e.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** rules 1-5.
- [ ] **Step 4: Run** those tests — PASS. Then `npx vitest run apps/midad` — PASS, with no existing assertion edited.
- [ ] **Step 5: Commit** by explicit paths: `git commit -m "fix(midad): every entry point uses the saved contract; init never rewrites it (CHAIN-07/08/11, E6)"`

---

### Task 3: no bare `refused: ERROR`; `MIDA_DEBUG=1` reaches agent commands (CHAIN-09; check H5)

**Files:** Create `apps/midad/src/debug-line.ts`, `apps/midad/test/debug-line.test.ts`. Modify `cli.ts:234-244` (`runCliWithRuntime` catch), `cli.ts:348-356` (owner catch), `cli.ts:552-558` (passkey catch), `cli.ts:363-431` (`ownerRefusalLine` default), `cli.ts:660-666` (`runInstall` catch), `cli.ts:765` (send `debug`), `daemon.ts:260-284` (`/cli` accepts `debug`), spec §4.1 (amend).

**Interfaces — Produces:**

```ts
// debug-line.ts
/** The error's own string `code`; else "CHAIN_CALL_FAILED" for a viem error (instanceof viem's BaseError); else "UNEXPECTED". Never "ERROR". */
export function refusalCode(error: unknown): string
/** The masked one-line detail. Walks `cause` up to 5 deep; per level: name, shortMessage ?? message, details; hex runs of 40+ → "<hex>"; first 6 lines joined by " / "; max 900 chars; prefixed "debug: ". */
export function debugLine(error: unknown): string
```

**Rules:**
1. Every place that prints `refused: ${… ?? "ERROR"}` prints `refused: ${refusalCode(error)}` instead. After the change, `grep -n '"ERROR"' apps/midad/src/cli.ts` shows no refusal string.
2. `CHAIN_CALL_FAILED` has a plain line in `runCliWithRuntime`'s catch and in `ownerRefusalLine`: `the chain call failed — this setup's contract is ${short(capabilityRegistry)}; run with MIDA_DEBUG=1 to see why` (the runtime in scope has the deployment: `runtime.chain.deployment`).
3. The two inline debug blocks (cli.ts:352-356, 554-557) become `deps.print(debugLine(error))` under the same `MIDA_DEBUG === "1"` condition. For an error with no `cause`, the output is identical to today's.
4. Agent commands: main sends `{ argv, cwd, debug: process.env.MIDA_DEBUG === "1" }` to `/cli`. `daemon.ts` reads `debug` (the boolean `true` only; anything else is false) and passes it in `runCliWithRuntime`'s context (`context?: { cwd?: string; debug?: boolean }`); its catch appends `debugLine(error)` when true.
5. Unchanged: no log line gains a message; without `MIDA_DEBUG` no output contains an error message.
6. Spec §4.1 is amended to: "An uncoded error is named at the CLI refusal points (`refusalCode`); `toMidaError` is unchanged, because 14 callers in other packages depend on its current behaviour."

- [ ] **Step 1: Failing tests** in `debug-line.test.ts`: coded error → its code; `new BaseError("boom")` (from viem) → `CHAIN_CALL_FAILED`; `new Error("x")` → `UNEXPECTED`; `undefined` → `UNEXPECTED`; `debugLine` masks a 64-hex run, walks a two-level `cause`, caps at 900 chars. In `cli.test.ts`: `runCliWithRuntime(["request","claude-code"], <runtime whose agent throws new BaseError("boom")>, print)` prints the CHAIN_CALL_FAILED line and no `ERROR`; with context `{ debug: true }` it also prints exactly one `debug:` line.
- [ ] **Step 2: Run** `npx vitest run apps/midad/test/debug-line.test.ts apps/midad/test/cli.test.ts` — FAIL.
- [ ] **Step 3: Implement**, and amend spec §4.1.
- [ ] **Step 4: Run** those tests and `npx vitest run apps/midad/test/refusals.test.ts apps/midad/test/daemon.test.ts` — PASS.
- [ ] **Step 5: Commit** `git commit -m "fix(midad): name every refusal; MIDA_DEBUG reaches agent commands (CHAIN-09, H5)"`

---

### Task 4: the command replaces a service running other code (CHAIN-10; check H6)

**Files:** Create `apps/midad/src/code-identity.ts`, `apps/midad/test/code-identity.test.ts`. Modify `daemon.ts:115-150, 234-236` (`/health`, new `/shutdown`, optional `identity` dep), `control.ts` (add `ensureCurrentDaemon`), `cli.ts:760-766` (use it), `doctor.ts` (service code line). Tests: extend `apps/midad/test/control.test.ts`, `apps/midad/test/daemon.e2e.test.ts`.

**Interfaces — Produces:**

```ts
// code-identity.ts
export interface CodeIdentity { codeRoot: string; codeCommit: string }
/** codeRoot = realpath of the folder four levels above this file (repo root in dev) — for the npm build, the package root; codeCommit = `git -C <codeRoot> rev-parse HEAD`, run once, "unknown" on any failure or outside git. Cached per process. */
export function codeIdentity(): CodeIdentity

// control.ts — added; ensureDaemon keeps its signature and behaviour
export interface EnsureResult { up: boolean; replaced?: { codeRoot: string; codeCommit: string; pid: number }; refusal?: string }
export async function ensureCurrentDaemon(
  home: MidaHome,
  spawn: () => void,
  options: { waitMs: number; shutdownWaitMs?: number /* default 10_000 */; self?: CodeIdentity /* default codeIdentity() */ },
): Promise<EnsureResult>
```

**Rules:**
1. `/health` adds `codeRoot` and `codeCommit`, computed once in `startDaemon` from `deps.identity ?? codeIdentity()`.
2. `POST /shutdown`: responds `{ ok: true }`, then does exactly what SIGTERM does today (daemon-main.ts `shutdown`: `daemon.close()`, then exit). A save in flight finishes first: confirm `close()` waits for `inFlight`, and test it.
3. `ensureCurrentDaemon`: `/health` down → same as `ensureDaemon`. Up, and the body lacks `codeRoot` (an older service) OR `codeRoot`/`codeCommit` differ from `self` → POST `/shutdown`, poll `/health` every 100 ms until it stops answering (≤ `shutdownWaitMs`), then spawn and wait as `ensureDaemon` does. Still answering after `shutdownWaitMs` → `{ up: false, refusal: "the Mida service (pid N) runs code from <root> @ <commit7>; this command runs <root> @ <commit7>. It did not stop within 10 s — stop it with: kill N" }`. `"unknown"` on BOTH sides counts as equal; on one side only, as different.
4. `cli.ts` main uses `ensureCurrentDaemon`; on `replaced` writes to stderr `restarted the Mida service (it was running code from <root> @ <commit7>)`; on `refusal` prints it and exits 1.
5. `doctor`: `ok: midad runs <root> @ <commit7>; this command runs the same`; or `problem("midad runs <root> @ <commit7>; this command runs <root> @ <commit7>", "run any mida command to replace it")`; or, for a body without the fields, `problem("midad predates code reporting", "run any mida command to replace it")`.
6. Hooks (`hook-main.ts`, `inject-main.ts`, `mcp-main.ts`) are unchanged: they fail open and must stay fast. Only the `mida` command replaces services.

- [ ] **Step 1: Failing tests:** `code-identity.test.ts` (in this repo → a 40-hex commit; a root outside git → `unknown`). `control.test.ts` with a fake socket server: same identity → no `/shutdown`; different commit → `/shutdown` called once, then spawn; body without `codeRoot` → replaced; a server that ignores `/shutdown` → `refusal` naming the pid, with `shutdownWaitMs: 200`. **H6** in `daemon.e2e.test.ts`: start a real daemon with `identity: { codeRoot: "/a", codeCommit: "1" }`, enqueue 2 jobs, call `ensureCurrentDaemon` with `self: { codeRoot: "/b", codeCommit: "2" }` and a spawn that starts a daemon with the `/b` identity → the old one exits, `/health` answers with `/b`, and no job is lost (each is still queued or was saved).
- [ ] **Step 2: Run** `npx vitest run apps/midad/test/code-identity.test.ts apps/midad/test/control.test.ts apps/midad/test/daemon.e2e.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; then `npx vitest run` (whole suite) — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(midad): replace a service running other code (CHAIN-10, H6)"`

---

## After the batch (Claude, not Devin)

1. One Opus reviewer over Tasks 1-4 together, adversarial: what each rule does on a home with no `network.json`, with an empty `storageUrl`, with `MIDA_DEPLOYMENTS_DIR` set, on a passkey home; whether any path still builds a Network without `resolveNetwork` (`grep -rn "readJson.*network.json\|testnetNetwork(" apps/midad/src`); whether `/shutdown` can drop a queued job.
2. Claude runs on a **copy** of `~/.mida` (`cp -R ~/.mida /tmp/mida-copy`, `MIDA_HOME=/tmp/mida-copy`): `mida doctor` names `0xf07d…`, says `store: local`, prints the mismatch note; `mida approve claude-code` in a test folder reaches "already approved … now approved for this folder" with NO `MIDA_DEPLOYMENTS_DIR`.
3. Issue register: CHAIN-07, 08, 09, 10, 11 → FIXED with commits; E6 and H6 wired into `bench/deterministic/e-authority.ts` and `h-reliability.ts`.

## Self-review (done while writing)

- Spec coverage: §3 rules 1-6 → Tasks 1-2; §4 → Task 3 (stated deviation); §6 items 1-5 → Task 4; E6 → Task 2, H5 → Task 3, H6 → Task 4. §5 (migrate) and §9 (redeploy checklist) → Plan B.
- First-time and empty cases: Task 1's table, Task 2 rule 2, Task 3 rule 4 (`debug` not `true` → false), Task 4 rule 3 (`unknown`, missing fields).
- Names across tasks: `resolveNetwork`, `ResolvedNetwork`, `ResolveDeps`, `mismatchLine`, `serviceNetwork`, `networkForCommand`, `funderFor`, `refusalCode`, `debugLine`, `codeIdentity`, `CodeIdentity`, `ensureCurrentDaemon`, `EnsureResult`: each defined once, in the task that produces it.
