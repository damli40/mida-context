# P0 Milestone M0 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **In this repo the implementer is Devin CLI (`swe-2-high`), one task per run, from a brief Claude writes out of the task below. Claude reviews every task before the next starts.**

**Goal:** Push one hard-coded checkpoint through the real Mida protocol, with every secret and every piece of state on disk so it survives a restart: save it as agent `claude-code`, read it as agent `codex` after the owner approves, then revoke `claude-code` and see it refused while `codex` carries on.

**Architecture:** A new workspace app, `apps/midad`, holds a `MidaHome` (one folder of files, secrets readable only by the user), loads or creates the owner, one operator and two agents, runs the existing Context API against a data folder that persists, and exposes six plain functions: `init`, `requestAccess`, `approve`, `saveCheckpoint`, `readCheckpoints`, `revoke`. One small additive change to `@mida/sdk` lets an agent be rebuilt with the grants it completed in an earlier process. No hooks, no model, no MCP, no socket in this milestone.

**Tech Stack:** TypeScript (NodeNext, strict), pnpm 12.4.1 workspace, Vitest 4.1.11, viem 2.56.3, the existing `@mida/*` packages, Foundry's Anvil for local runs.

**Spec:** `docs/superpowers/specs/2026-09-20-p0-handoff-design.md` (§5 A, B, C, D, E and §12). Reference scenario for every protocol call: `apps/cli/test/section16.e2e.test.ts`. The spike at `spike/` is reference only; nothing in M0 imports it.

**What M0 must answer with measurements (spec §12):**
1. Can one operator wallet register both agents?
2. How long does a full protocol read take (it must later fit a session-start hook)?
3. How long from "save started" to "readable by the other agent", on Anvil and on Monad testnet?

**A gap found while writing this plan, fixed in Task 1:** `MidaAgent` keeps completed grants in a private in-memory list that only `completeAccessRequest` can fill (`packages/sdk/src/agent.ts:127,232`). A completed request is marked consumed and cannot be completed twice. So after any restart an approved agent can no longer read or write, and nothing can repair it. The spec's "midad restarts and carries on" is impossible without Task 1.

## Global Constraints

- Namespace is exactly `projects.current`. Purpose ID is exactly `project_assistance`.
- Agent permissions are exactly `PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN` with provenance policy `PROVENANCE_POLICY.ALLOW_INFERENCE`.
- Agent names are exactly `claude-code` and `codex`.
- Every checkpoint is written with `source: "AGENT_INFERRED"`. Agents can never write `USER_ASSERTED` or `USER_CONFIRMED`.
- Grants expire 30 days after the request.
- Secret files: folder mode `0o700`, file mode `0o600`, written to a temp name and renamed into place.
- Never log, print, commit or put in an error message: a private key, the seed, the P256 key, an encryption private key, or a checkpoint's plaintext.
- Never open, read, print or edit `.env`. Never run a command that prints environment variables.
- Do not change anything under `contracts/`, `packages/protocol`, `packages/crypto`, `packages/chain`, `packages/api`, `packages/fake-vault`, `packages/grant-advisor`, `packages/storage`, `apps/api` or `apps/cli`. The only edit outside `apps/midad` is the one in Task 1.
- Do not pin a new dependency version: reuse the exact versions already in `apps/cli/package.json`.
- If a protocol call behaves differently from what this plan says, STOP and write what happened in `DEVIN-REPORT-M0.md`. Do not work around it, do not weaken a test.
- Run one shell command per call. No `&&`, no pipes. (Devin's print mode ends the run silently on an unlisted or chained command.)
- Existing suite must stay green: `pnpm test` (306 tests before this plan) and `pnpm typecheck`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/sdk/src/agent.ts` (modify) | Accept `grants` in the config and restore them |
| `packages/sdk/test/restore-grants.test.ts` (create) | Unit test for the above |
| `apps/midad/package.json` (create) | Workspace package `@mida/midad` |
| `apps/midad/src/home.ts` | `MidaHome`: paths, JSON read, secret-safe JSON write |
| `apps/midad/src/request-store.ts` | `FileAccessRequestStore`: pending approval requests on disk |
| `apps/midad/src/keys.ts` | Create, save and load owner secrets, operator secret, agent identities, grants, revoked list |
| `apps/midad/src/api-server.ts` | Start the Context API on a data folder that persists |
| `apps/midad/src/runtime.ts` | `Runtime.open`: wire home + network into owner vault, API client and agents |
| `apps/midad/src/skeleton.ts` | The six operations |
| `apps/midad/src/cli.ts` | Crude `mida` command over the six operations |
| `apps/midad/src/index.ts` | Public exports |
| `apps/midad/test/*.test.ts` | One test file per source file, plus `skeleton.e2e.test.ts` |
| `docs/evidence/m0-*.json` | Measurements written by the end-to-end test |

---

### Task 0: Branch and Devin permissions (Claude does this, not Devin)

**Files:**
- Create: `.devin/config.json`

- [ ] **Step 1: Create the branch**

```bash
git -C ~/Desktop/mida-context switch -c p0-m0-skeleton
```

Expected: `Switched to a new branch 'p0-m0-skeleton'`. Untracked files come along untouched.

- [ ] **Step 2: Write `.devin/config.json`**

```json
{
  "permissions": {
    "allow": [
      "read", "grep", "glob", "edit",
      "Read(**)",
      "Write(apps/midad/**)",
      "Write(packages/sdk/src/agent.ts)",
      "Write(packages/sdk/test/restore-grants.test.ts)",
      "Write(package.json)",
      "Write(pnpm-lock.yaml)",
      "Write(docs/evidence/**)",
      "Write(DEVIN-REPORT-M0.md)",
      "Write(/tmp/**)",
      "Exec(git)", "Exec(pnpm)", "Exec(node)", "Exec(pwd)", "Exec(which)",
      "Exec(ls)", "Exec(cat)", "Exec(grep)", "Exec(head)", "Exec(tail)", "Exec(wc)",
      "Exec(sed)", "Exec(diff)", "Exec(stat)", "Exec(mkdir)", "Exec(cd)"
    ],
    "deny": ["Read(.env)", "Read(**/.env)", "Write(.env)", "Exec(env)", "Exec(printenv)"]
  }
}
```

- [ ] **Step 3: Confirm the starting point is green**

Run: `pnpm test` then `pnpm typecheck` from the repo root.
Expected: 306 tests pass; typecheck exits 0.

---

### Task 1: Let an agent be rebuilt with its earlier grants

**Files:**
- Modify: `packages/sdk/src/agent.ts` (the `MidaAgentConfig` interface near line 105 and the constructor near line 129)
- Test: `packages/sdk/test/restore-grants.test.ts`

**Interfaces:**
- Consumes: existing `Grant`, `MidaAgent`, `MidaError`.
- Produces: `MidaAgentConfig.grants?: readonly Grant[]`. Later tasks pass `grants: loadGrants(home, name)` to `new MidaAgent(...)`.

Why this is safe: a restored grant only tells the agent which capability ID to present. Every read is still authorised by the API against Monad, and every write is still checked by the contract. A forged restored grant buys nothing — Task 5 proves that with a test.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/test/restore-grants.test.ts
import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createWriteContext } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import type { Address, Hex } from "@mida/protocol"
import { MidaAgent } from "@mida/sdk"
import type { Grant } from "@mida/sdk"

const hex = (byte: string, bytes: number) => `0x${byte.repeat(bytes)}` as Hex
const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: hex("11", 20) as Address,
  contextRegistry: hex("22", 20) as Address,
  deploymentBlock: 0n,
  policyHashV1: hex("00", 32),
  vaultRpId: "localhost",
  vaultRpIdHash: hex("00", 32),
}
const AGENT_ID = hex("aa", 32)

function agentWith(grants: Grant[] | undefined) {
  const account = privateKeyToAccount(generatePrivateKey())
  // No network call happens in a constructor, so an unreachable RPC URL is fine here.
  const chain = createWriteContext({ rpcUrl: "http://127.0.0.1:9", deployment, account })
  const api = { account } as unknown as ConstructorParameters<typeof MidaAgent>[0]["api"]
  return new MidaAgent({ agentId: AGENT_ID, callbackOrigin: "https://x.example", encryptionPrivateKey: new Uint8Array(32).fill(7), chain, api, grants })
}

const grant = (agentId: Hex): Grant => ({
  owner: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" as Address,
  agentId,
  requestId: hex("01", 32),
  capabilities: [],
})

describe("MidaAgent restores grants completed in an earlier process", () => {
  it("starts with no grants when none are passed", () => {
    expect(agentWith(undefined).grants).toEqual([])
  })

  it("exposes a restored grant, with the owner address lower-cased like a freshly completed one", () => {
    const restored = agentWith([grant(AGENT_ID)]).grants
    expect(restored).toHaveLength(1)
    expect(restored[0]!.owner).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")
    expect(restored[0]!.requestId).toBe(hex("01", 32))
  })

  it("refuses a grant that belongs to a different agent", () => {
    expect(() => agentWith([grant(hex("bb", 32))])).toThrow(expect.objectContaining({ code: "AUTH_INVALID" }))
  })

  it("does not keep a reference to the caller's array", () => {
    const input = [grant(AGENT_ID)]
    const agent = agentWith(input)
    input.pop()
    expect(agent.grants).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run packages/sdk/test/restore-grants.test.ts`
Expected: FAIL. TypeScript/Vitest reports that `grants` does not exist in `MidaAgentConfig`, or the second test fails with length 0.

If `Grant` is not exported from `@mida/sdk`, check `packages/sdk/src/index.ts`; it re-exports from `./agent.js`. Do not add a new export unless it is truly missing.

- [ ] **Step 3: Implement**

In `packages/sdk/src/agent.ts`, add to `MidaAgentConfig`, after `requests?`:

```ts
  /**
   * Grants this agent completed in an earlier process. They only tell the agent which capabilityId to present:
   * every read is still authorised by the API against Monad and every write by the contract, so a stale or forged
   * entry buys nothing.
   */
  grants?: readonly Grant[]
```

At the end of the constructor, after `this.#reader = ...`:

```ts
    for (const grant of config.grants ?? []) {
      if (grant.agentId.toLowerCase() !== this.agentId) {
        throw new MidaError("AUTH_INVALID", "a restored grant belongs to a different agent")
      }
      this.#grants.push({ ...grant, owner: grant.owner.toLowerCase() as Address, agentId: this.agentId, capabilities: [...grant.capabilities] })
    }
```

- [ ] **Step 4: Run the new test, then the whole suite**

Run: `pnpm vitest run packages/sdk/test/restore-grants.test.ts` — Expected: 4 passed.
Run: `pnpm test` — Expected: 310 passed, 0 failed.
Run: `pnpm typecheck` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/agent.ts packages/sdk/test/restore-grants.test.ts
git commit -m "feat(sdk): restore completed grants when an agent is rebuilt after a restart"
```

---

### Task 2: The `@mida/midad` package, `MidaHome`, and the on-disk request store

**Files:**
- Create: `apps/midad/package.json`, `apps/midad/src/home.ts`, `apps/midad/src/request-store.ts`, `apps/midad/src/index.ts`
- Test: `apps/midad/test/home.test.ts`, `apps/midad/test/request-store.test.ts`

**Interfaces:**
- Consumes: `AccessRequestStore`, `StoredAccessRequest` from `@mida/sdk`; `MidaError`, `AccessRequest`, `Hex` from `@mida/protocol`.
- Produces:
  - `class MidaHome { constructor(root?: string); readonly root: string; path(relative: string): string; has(relative: string): boolean; readJson<T>(relative: string): T | undefined; writeSecretJson(relative: string, value: unknown): void; list(relative: string): string[] }`
  - `class FileAccessRequestStore implements AccessRequestStore { constructor(home: MidaHome, agentName: string) }`

- [ ] **Step 1: Create the package**

```json
{
  "name": "@mida/midad",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@hono/node-server": "1.19.17",
    "@mida/api": "workspace:*",
    "@mida/chain": "workspace:*",
    "@mida/cli": "workspace:*",
    "@mida/crypto": "workspace:*",
    "@mida/fake-vault": "workspace:*",
    "@mida/protocol": "workspace:*",
    "@mida/sdk": "workspace:*",
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "viem": "2.56.3"
  }
}
```

Then run: `pnpm install` — Expected: exits 0, `pnpm-lock.yaml` gains an `apps/midad` importer and no new external package versions.

- [ ] **Step 2: Write the failing tests**

```ts
// apps/midad/test/home.test.ts
import { describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome } from "@mida/midad"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))

describe("MidaHome", () => {
  it("returns undefined for a file that does not exist", () => {
    expect(freshHome().readJson("owner/secrets.json")).toBeUndefined()
  })

  it("round-trips JSON through nested folders", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/identity.json", { a: 1, nested: { b: "two" } })
    expect(home.readJson("agents/codex/identity.json")).toEqual({ a: 1, nested: { b: "two" } })
    expect(home.has("agents/codex/identity.json")).toBe(true)
  })

  it("writes files only the user can read, in folders only the user can enter", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { k: "v" })
    expect(statSync(home.path("owner/secrets.json")).mode & 0o777).toBe(0o600)
    expect(statSync(home.path("owner")).mode & 0o777).toBe(0o700)
  })

  it("leaves no temp file behind and replaces, not appends", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { v: 1 })
    home.writeSecretJson("owner/secrets.json", { v: 2 })
    expect(home.readJson("owner/secrets.json")).toEqual({ v: 2 })
    expect(readdirSync(home.path("owner"))).toEqual(["secrets.json"])
  })

  it("throws on a corrupt file instead of pretending it is missing", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { v: 1 })
    writeFileSync(home.path("owner/secrets.json"), "{not json")
    expect(() => home.readJson("owner/secrets.json")).toThrow()
  })

  it("refuses a path that climbs out of the home folder", () => {
    expect(() => freshHome().path("../outside.json")).toThrow()
  })

  it("lists the entries of a folder, and an empty list for a missing one", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/identity.json", {})
    home.writeSecretJson("agents/claude-code/identity.json", {})
    expect(home.list("agents").sort()).toEqual(["claude-code", "codex"])
    expect(home.list("nothing-here")).toEqual([])
  })
})
```

```ts
// apps/midad/test/request-store.test.ts
import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessRequest, Hex } from "@mida/protocol"
import { FileAccessRequestStore, MidaHome } from "@mida/midad"

const REQUEST_ID = `0x${"ab".repeat(32)}` as Hex
const request = { requestId: REQUEST_ID, purposeId: "project_assistance" } as unknown as AccessRequest
const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-req-")))

describe("FileAccessRequestStore", () => {
  it("loads what it saved, unconsumed", async () => {
    const store = new FileAccessRequestStore(freshHome(), "codex")
    await store.save(request)
    expect(await store.load(REQUEST_ID)).toEqual({ request, consumed: false })
  })

  it("treats request IDs as case-insensitive", async () => {
    const store = new FileAccessRequestStore(freshHome(), "codex")
    await store.save(request)
    expect(await store.load(`0x${"AB".repeat(32)}` as Hex)).toBeDefined()
  })

  it("refuses to save the same request ID twice", async () => {
    const store = new FileAccessRequestStore(freshHome(), "codex")
    await store.save(request)
    await expect(store.save(request)).rejects.toMatchObject({ code: "REPLAY" })
  })

  it("survives a restart: a second store on the same home sees the request", async () => {
    const home = freshHome()
    await new FileAccessRequestStore(home, "codex").save(request)
    expect(await new FileAccessRequestStore(home, "codex").load(REQUEST_ID)).toEqual({ request, consumed: false })
  })

  it("marks consumed exactly once, even across two store instances", async () => {
    const home = freshHome()
    const first = new FileAccessRequestStore(home, "codex")
    await first.save(request)
    await first.markConsumed(REQUEST_ID)
    expect((await first.load(REQUEST_ID))!.consumed).toBe(true)
    await expect(new FileAccessRequestStore(home, "codex").markConsumed(REQUEST_ID)).rejects.toMatchObject({ code: "REQUEST_CONSUMED" })
  })

  it("rejects marking an unknown request", async () => {
    await expect(new FileAccessRequestStore(freshHome(), "codex").markConsumed(REQUEST_ID)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("keeps each agent's requests apart", async () => {
    const home = freshHome()
    await new FileAccessRequestStore(home, "codex").save(request)
    expect(await new FileAccessRequestStore(home, "claude-code").load(REQUEST_ID)).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run and see them fail**

Run: `pnpm vitest run apps/midad/test`
Expected: FAIL — `@mida/midad` has no exports yet.

- [ ] **Step 4: Implement**

```ts
// apps/midad/src/home.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { randomBytes } from "node:crypto"

/** One folder that holds everything Mida keeps on this machine. Secrets in it are readable by the user only. */
export class MidaHome {
  readonly root: string

  constructor(root: string = join(homedir(), ".mida")) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  path(relativePath: string): string {
    const full = resolve(this.root, relativePath)
    const back = relative(this.root, full)
    if (back.startsWith("..") || back === "") throw new Error(`path escapes the Mida home: ${relativePath}`)
    return full
  }

  has(relativePath: string): boolean {
    return existsSync(this.path(relativePath))
  }

  /** undefined only when the file is absent. A file that exists but will not parse throws: never treat corrupt as missing. */
  readJson<T>(relativePath: string): T | undefined {
    const full = this.path(relativePath)
    if (!existsSync(full)) return undefined
    return JSON.parse(readFileSync(full, "utf8")) as T
  }

  writeSecretJson(relativePath: string, value: unknown): void {
    const full = this.path(relativePath)
    let folder = dirname(full)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    while (folder.length > this.root.length) {
      chmodSync(folder, 0o700)
      folder = dirname(folder)
    }
    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" })
    renameSync(temp, full)
  }

  list(relativePath: string): string[] {
    const full = this.path(relativePath)
    return existsSync(full) ? readdirSync(full) : []
  }
}
```

```ts
// apps/midad/src/request-store.ts
import { closeSync, openSync } from "node:fs"
import { MidaError } from "@mida/protocol"
import type { AccessRequest, Hex } from "@mida/protocol"
import type { AccessRequestStore, StoredAccessRequest } from "@mida/sdk"
import type { MidaHome } from "./home.js"

/**
 * Pending approval requests on disk, one file per request, so a restart between "agent asked" and "owner approved"
 * loses nothing. "Consumed" is a marker file created with the exclusive flag: the operating system lets exactly one
 * creator win, which keeps the SDK's "a request completes at most once" rule true across processes.
 */
export class FileAccessRequestStore implements AccessRequestStore {
  readonly #home: MidaHome
  readonly #folder: string

  constructor(home: MidaHome, agentName: string) {
    if (!/^[a-z0-9-]+$/.test(agentName)) throw new Error(`bad agent name: ${agentName}`)
    this.#home = home
    this.#folder = `requests/${agentName}`
  }

  #file(requestId: Hex): string {
    if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) throw new MidaError("INVALID_WIRE", "requestId must be 32 bytes of hex")
    return `${this.#folder}/${requestId.toLowerCase()}.json`
  }

  async save(request: AccessRequest): Promise<void> {
    const file = this.#file(request.requestId)
    if (this.#home.has(file)) throw new MidaError("REPLAY", "requestId was already used")
    this.#home.writeSecretJson(file, request)
  }

  async load(requestId: Hex): Promise<StoredAccessRequest | undefined> {
    const file = this.#file(requestId)
    const request = this.#home.readJson<AccessRequest>(file)
    if (request === undefined) return undefined
    return { request, consumed: this.#home.has(`${file}.consumed`) }
  }

  async markConsumed(requestId: Hex): Promise<void> {
    const file = this.#file(requestId)
    if (!this.#home.has(file)) throw new MidaError("NOT_FOUND", "no stored request for this requestId")
    try {
      closeSync(openSync(this.#home.path(`${file}.consumed`), "wx", 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MidaError("REQUEST_CONSUMED", "this requestId was already completed")
      throw error
    }
  }
}
```

```ts
// apps/midad/src/index.ts
export { MidaHome } from "./home.js"
export { FileAccessRequestStore } from "./request-store.js"
```

Check `AccessRequestStore` and `StoredAccessRequest` are exported from `@mida/sdk` (`packages/sdk/src/index.ts`). They are defined in `packages/sdk/src/request-store.ts`. If the index does not re-export them, STOP and report — do not edit the SDK index.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/midad/test` — Expected: 14 passed.
Run: `pnpm typecheck` — Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/midad package.json pnpm-lock.yaml
git commit -m "feat(midad): home folder with user-only secret files and an on-disk request store"
```

---

### Task 3: Keys and identities on disk

**Files:**
- Create: `apps/midad/src/keys.ts`
- Modify: `apps/midad/src/index.ts`
- Test: `apps/midad/test/keys.test.ts`

**Interfaces:**
- Consumes: `MidaHome` (Task 2); `ProvisionedAgent` from `@mida/fake-vault`; `Grant` from `@mida/sdk`; `hexOf` from `@mida/crypto`.
- Produces:

```ts
export interface OwnerSecrets { privateKey: Hex; seed: Hex; p256PrivateKey: Hex }
export interface OperatorSecrets { privateKey: Hex }
export interface AgentIdentity {
  name: string; agentId: Hex; signerPrivateKey: Hex
  encryptionPrivateKey: Hex; encryptionPublicKey: Hex
  callbackOrigin: string; purposeId: PurposeId
  manifest: SignedAgentCapabilityManifest; manifestHash: Hex
}
export function loadOrCreateOwnerSecrets(home: MidaHome): OwnerSecrets
export function loadOrCreateOperatorSecrets(home: MidaHome): OperatorSecrets
export function loadOrCreateSignerKey(home: MidaHome, name: string): Hex
export function identityFrom(name: string, signerPrivateKey: Hex, provisioned: ProvisionedAgent): AgentIdentity
export function saveAgentIdentity(home: MidaHome, identity: AgentIdentity): void
export function loadAgentIdentity(home: MidaHome, name: string): AgentIdentity | undefined
export function listAgentNames(home: MidaHome): string[]
export function saveGrants(home: MidaHome, name: string, grants: readonly Grant[]): void
export function loadGrants(home: MidaHome, name: string): Grant[]
export function markRevoked(home: MidaHome, name: string): void
export function isRevoked(home: MidaHome, name: string): boolean
```

The signer key is saved **before** the agent is registered on-chain (Task 4 relies on this): a crash after registration must never leave a registered agent whose key is gone.

- [ ] **Step 1: Write the failing test**

```ts
// apps/midad/test/keys.test.ts
import { describe, expect, it } from "vitest"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "@mida/protocol"
import type { ProvisionedAgent } from "@mida/fake-vault"
import type { Grant } from "@mida/sdk"
import {
  MidaHome, identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets,
  loadOrCreateOwnerSecrets, loadOrCreateSignerKey, markRevoked, saveAgentIdentity, saveGrants,
} from "@mida/midad"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-keys-")))
const KEY = /^0x[0-9a-f]{64}$/

describe("owner, operator and signer secrets", () => {
  it("creates three distinct 32-byte owner secrets and returns the same ones next time", () => {
    const home = freshHome()
    const first = loadOrCreateOwnerSecrets(home)
    expect(first.privateKey).toMatch(KEY)
    expect(first.seed).toMatch(KEY)
    expect(first.p256PrivateKey).toMatch(KEY)
    expect(new Set([first.privateKey, first.seed, first.p256PrivateKey]).size).toBe(3)
    expect(loadOrCreateOwnerSecrets(home)).toEqual(first)
    expect(statSync(home.path("owner/secrets.json")).mode & 0o777).toBe(0o600)
  })

  it("keeps the operator key stable and different from the owner key", () => {
    const home = freshHome()
    const operator = loadOrCreateOperatorSecrets(home)
    expect(loadOrCreateOperatorSecrets(home)).toEqual(operator)
    expect(operator.privateKey).not.toBe(loadOrCreateOwnerSecrets(home).privateKey)
  })

  it("gives each agent its own stable signer key", () => {
    const home = freshHome()
    const claude = loadOrCreateSignerKey(home, "claude-code")
    expect(loadOrCreateSignerKey(home, "claude-code")).toBe(claude)
    expect(loadOrCreateSignerKey(home, "codex")).not.toBe(claude)
  })

  it("refuses an owner secrets file that is missing a field, instead of generating a new owner", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { privateKey: `0x${"11".repeat(32)}` })
    expect(() => loadOrCreateOwnerSecrets(home)).toThrow()
  })

  it("names the bad field in the error but never its value", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { privateKey: "0xnot-a-key-SECRETVALUE", seed: "x", p256PrivateKey: "y" })
    expect(() => loadOrCreateOwnerSecrets(home)).toThrow(/privateKey/)
    expect(() => loadOrCreateOwnerSecrets(home)).not.toThrow(/SECRETVALUE/)
  })
})

describe("agent identities, grants and the revoked list", () => {
  const signerPrivateKey = `0x${"5a".repeat(32)}` as Hex
  const provisioned = {
    agentId: `0x${"aa".repeat(32)}`,
    signer: privateKeyToAccount(signerPrivateKey),
    encryptionPrivateKey: new Uint8Array(32).fill(9),
    encryptionPublicKey: `0x${"bb".repeat(32)}`,
    callbackOrigin: "https://codex.mida.example",
    purposeId: "project_assistance",
    manifest: { body: { name: "codex" }, signature: "0x01" },
    manifestHash: `0x${"cc".repeat(32)}`,
  } as unknown as ProvisionedAgent

  it("round-trips an identity and stores the encryption key as hex, not raw bytes", () => {
    const home = freshHome()
    const identity = identityFrom("codex", signerPrivateKey, provisioned)
    expect(identity.encryptionPrivateKey).toBe(`0x${"09".repeat(32)}`)
    saveAgentIdentity(home, identity)
    expect(loadAgentIdentity(home, "codex")).toEqual(identity)
    expect(loadAgentIdentity(home, "claude-code")).toBeUndefined()
    expect(listAgentNames(home)).toEqual(["codex"])
  })

  it("refuses an identity whose signer key does not match the provisioned signer", () => {
    expect(() => identityFrom("codex", `0x${"5b".repeat(32)}` as Hex, provisioned)).toThrow()
  })

  it("round-trips grants and starts empty", () => {
    const home = freshHome()
    expect(loadGrants(home, "codex")).toEqual([])
    const grant: Grant = { owner: `0x${"dd".repeat(20)}` as Address, agentId: `0x${"aa".repeat(32)}` as Hex, requestId: `0x${"01".repeat(32)}` as Hex, capabilities: [] }
    saveGrants(home, "codex", [grant])
    expect(loadGrants(home, "codex")).toEqual([grant])
  })

  it("remembers a revoked agent", () => {
    const home = freshHome()
    expect(isRevoked(home, "claude-code")).toBe(false)
    markRevoked(home, "claude-code")
    expect(isRevoked(home, "claude-code")).toBe(true)
    expect(isRevoked(home, "codex")).toBe(false)
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `pnpm vitest run apps/midad/test/keys.test.ts`
Expected: FAIL — the functions are not exported.

- [ ] **Step 3: Implement**

```ts
// apps/midad/src/keys.ts
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { p256 } from "@noble/curves/nist.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { hexOf } from "@mida/crypto"
import type { Hex, PurposeId, SignedAgentCapabilityManifest } from "@mida/protocol"
import type { ProvisionedAgent } from "@mida/fake-vault"
import type { Grant } from "@mida/sdk"
import type { MidaHome } from "./home.js"

export interface OwnerSecrets { privateKey: Hex; seed: Hex; p256PrivateKey: Hex }
export interface OperatorSecrets { privateKey: Hex }
export interface AgentIdentity {
  name: string
  agentId: Hex
  signerPrivateKey: Hex
  encryptionPrivateKey: Hex
  encryptionPublicKey: Hex
  callbackOrigin: string
  purposeId: PurposeId
  manifest: SignedAgentCapabilityManifest
  manifestHash: Hex
}

const KEY = /^0x[0-9a-f]{64}$/
const NAME = /^[a-z0-9-]+$/

function assertKeys(file: string, record: Record<string, unknown> | undefined, fields: string[]): void {
  for (const field of fields) {
    const value = record?.[field]
    // The message names the file and the field, never the value.
    if (typeof value !== "string" || !KEY.test(value)) throw new Error(`${file}: field "${field}" is missing or is not a 32-byte hex key`)
  }
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`bad agent name: ${name}`)
}

export function loadOrCreateOwnerSecrets(home: MidaHome): OwnerSecrets {
  const file = "owner/secrets.json"
  const existing = home.readJson<Record<string, unknown>>(file)
  if (existing !== undefined) {
    assertKeys(file, existing, ["privateKey", "seed", "p256PrivateKey"])
    return existing as unknown as OwnerSecrets
  }
  const created: OwnerSecrets = { privateKey: generatePrivateKey(), seed: hexOf(randomBytes(32)), p256PrivateKey: hexOf(p256.utils.randomSecretKey()) }
  home.writeSecretJson(file, created)
  return created
}

export function loadOrCreateOperatorSecrets(home: MidaHome): OperatorSecrets {
  const file = "operator/secrets.json"
  const existing = home.readJson<Record<string, unknown>>(file)
  if (existing !== undefined) {
    assertKeys(file, existing, ["privateKey"])
    return existing as unknown as OperatorSecrets
  }
  const created: OperatorSecrets = { privateKey: generatePrivateKey() }
  home.writeSecretJson(file, created)
  return created
}

export function loadOrCreateSignerKey(home: MidaHome, name: string): Hex {
  assertName(name)
  const file = `agents/${name}/signer.json`
  const existing = home.readJson<Record<string, unknown>>(file)
  if (existing !== undefined) {
    assertKeys(file, existing, ["signerPrivateKey"])
    return existing.signerPrivateKey as Hex
  }
  const signerPrivateKey = generatePrivateKey()
  home.writeSecretJson(file, { signerPrivateKey })
  return signerPrivateKey
}

export function identityFrom(name: string, signerPrivateKey: Hex, provisioned: ProvisionedAgent): AgentIdentity {
  assertName(name)
  if (privateKeyToAccount(signerPrivateKey).address !== provisioned.signer.address) {
    throw new Error(`agent ${name}: the saved signer key is not the key the agent was registered with`)
  }
  return {
    name,
    agentId: provisioned.agentId,
    signerPrivateKey,
    encryptionPrivateKey: hexOf(provisioned.encryptionPrivateKey),
    encryptionPublicKey: provisioned.encryptionPublicKey,
    callbackOrigin: provisioned.callbackOrigin,
    purposeId: provisioned.purposeId,
    manifest: provisioned.manifest,
    manifestHash: provisioned.manifestHash,
  }
}

export function saveAgentIdentity(home: MidaHome, identity: AgentIdentity): void {
  assertName(identity.name)
  home.writeSecretJson(`agents/${identity.name}/identity.json`, identity)
}

export function loadAgentIdentity(home: MidaHome, name: string): AgentIdentity | undefined {
  assertName(name)
  const file = `agents/${name}/identity.json`
  const identity = home.readJson<Record<string, unknown>>(file)
  if (identity === undefined) return undefined
  assertKeys(file, identity, ["agentId", "signerPrivateKey", "encryptionPrivateKey", "manifestHash"])
  return identity as unknown as AgentIdentity
}

export function listAgentNames(home: MidaHome): string[] {
  return home.list("agents").filter((name) => NAME.test(name) && home.has(`agents/${name}/identity.json`)).sort()
}

export function saveGrants(home: MidaHome, name: string, grants: readonly Grant[]): void {
  assertName(name)
  home.writeSecretJson(`agents/${name}/grants.json`, grants)
}

export function loadGrants(home: MidaHome, name: string): Grant[] {
  assertName(name)
  return home.readJson<Grant[]>(`agents/${name}/grants.json`) ?? []
}

export function markRevoked(home: MidaHome, name: string): void {
  assertName(name)
  home.writeSecretJson(`agents/${name}/revoked.json`, { revoked: true })
}

export function isRevoked(home: MidaHome, name: string): boolean {
  assertName(name)
  return home.has(`agents/${name}/revoked.json`)
}
```

Add to `apps/midad/src/index.ts`:

```ts
export * from "./keys.js"
```

If `hexOf` returns upper-case hex or the `identityFrom` encryption-key expectation fails, check `packages/crypto/src` for `hexOf`'s exact output and report; do not change `@mida/crypto`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/midad/test` — Expected: 23 passed.
Run: `pnpm typecheck` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/midad
git commit -m "feat(midad): owner, operator and agent identities persisted as user-only files"
```

---

### Task 4: Runtime and the six operations

**Files:**
- Create: `apps/midad/src/api-server.ts`, `apps/midad/src/runtime.ts`, `apps/midad/src/skeleton.ts`
- Modify: `apps/midad/src/index.ts`
- Test: `apps/midad/test/skeleton.e2e.test.ts` (steps 1–7; Task 5 appends the rest)

**Interfaces:**
- Consumes: everything from Tasks 1–3; from the protocol, exactly the calls used in `apps/cli/test/section16.e2e.test.ts`: `provisionAgent`, `FakeVaultAuthority`, `ContextApiClient`, `RegistryReader`, `createContextApi`, `createWriteContext`, `MidaAgent`.
- Produces:

```ts
export interface Network { rpcUrl: string; deployment: Deployment; fund(address: Address): Promise<void> }
export const NAMESPACE = "projects.current"
export const PURPOSE_ID = "project_assistance"
export const AGENT_PERMISSIONS: number   // READ | CREATE | SUPERSEDE_OWN
export class Runtime {
  static open(home: MidaHome, network: Network): Promise<Runtime>
  readonly home: MidaHome; readonly network: Network; readonly owner: Address
  readonly vault: FakeVaultAuthority; readonly ownerApi: ContextApiClient; readonly reader: RegistryReader
  readonly ownerChain: LocalWriteContext; readonly apiBaseUrl: string
  agent(name: string): MidaAgent            // throws if that agent has no identity yet
  attach(identity: AgentIdentity): MidaAgent
  ensureFunded(address: Address): Promise<void>
  close(): Promise<void>
}
export function init(runtime: Runtime, agentNames: readonly string[]): Promise<{ owner: Address; agents: Record<string, Hex> }>
export function requestAccess(runtime: Runtime, name: string): Promise<{ requestId: Hex }>
export function approve(runtime: Runtime, name: string): Promise<{ capabilityIds: Hex[]; permissions: number[]; transactionHash: Hex; gasUsed: bigint }>
export function saveCheckpoint(runtime: Runtime, name: string, input: { projectId: string; checkpoint: Record<string, unknown> }): Promise<{ contextId: Hex; transactionHash: Hex; milliseconds: number }>
export function readCheckpoints(runtime: Runtime, name: string, projectId: string): Promise<{ checkpoints: Array<{ contextId: Hex; authorId: Hex; checkpoint: Record<string, unknown> }>; milliseconds: number }>
export function revoke(runtime: Runtime, name: string): Promise<{ transactionHashes: Hex[]; rewrapped: string[] }>
```

- [ ] **Step 1: Write the failing end-to-end test (steps 1–7)**

```ts
// apps/midad/test/skeleton.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { privateKeyToAccount } from "viem/accounts"
import { bytesOf } from "@mida/crypto"
import { createWriteContext } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { localEnvironment, monadTestnetEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  AGENT_PERMISSIONS, MidaHome, Runtime, approve, init, loadAgentIdentity, loadGrants, readCheckpoints, requestAccess, revoke, saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"

const ON_TESTNET = process.env.MIDA_E2E_MONAD_TESTNET === "1"
const STEP_TIMEOUT = ON_TESTNET ? 300_000 : 60_000
const AGENTS = ["claude-code", "codex"] as const
const CHECKPOINT = { objective: "Build a rate limiter", nextAction: "Write KeyedLimiter", constraints: ["no timers"] }

describe(`M0 walking skeleton on ${ON_TESTNET ? "Monad testnet" : "local Anvil"}`, () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  let grantGasUsed = ""
  const timings = { save: [] as number[], read: [] as number[] }
  const transactions: Record<string, string> = {}
  const step = (name: string, fn: () => Promise<void>) => it(name, fn, STEP_TIMEOUT)

  beforeAll(async () => {
    env = ON_TESTNET ? await monadTestnetEnvironment() : await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-m0-")))
    runtime = await Runtime.open(home, network)
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  step("1. init registers the owner, opens projects.current, and registers BOTH agents from ONE operator wallet", async () => {
    const result = await init(runtime, AGENTS)
    expect(Object.keys(result.agents).sort()).toEqual(["claude-code", "codex"])
    expect(result.agents["claude-code"]).not.toBe(result.agents.codex)
    for (const name of AGENTS) {
      expect(await runtime.reader.getAgent(result.agents[name]!)).toMatchObject({ active: true })
    }
  })

  step("2. init is safe to run again: same agents, and the owner sends no new transaction", async () => {
    const before = await runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })
    const again = await init(runtime, AGENTS)
    expect(again.agents["claude-code"]).toBe(runtime.agent("claude-code").agentId)
    expect(await runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })).toBe(before)
  })

  step("3. an agent that was never approved can neither save nor read", async () => {
    await expect(saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: CHECKPOINT })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(readCheckpoints(runtime, "codex", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  step("4. the owner approves claude-code with exactly read + add + replace-own", async () => {
    await requestAccess(runtime, "claude-code")
    const approval = await approve(runtime, "claude-code")
    expect(approval.capabilityIds).toHaveLength(1)
    expect(approval.permissions).toEqual([AGENT_PERMISSIONS])
    expect(approval.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
    transactions.grantClaudeCode = approval.transactionHash
    grantGasUsed = approval.gasUsed.toString()
  })

  step("5. claude-code saves a checkpoint; codex, not yet approved, still cannot read it", async () => {
    const saved = await saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: CHECKPOINT })
    expect(saved.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
    timings.save.push(saved.milliseconds)
    transactions.firstSave = saved.transactionHash
    await expect(readCheckpoints(runtime, "codex", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  step("6. RESTART in the middle of an approval: codex asks, the process restarts, the owner approves after it", async () => {
    await saveCheckpoint(runtime, "claude-code", { projectId: "proj-2", checkpoint: { objective: "A different project" } })
    await requestAccess(runtime, "codex")
    await runtime.close()
    runtime = await Runtime.open(home, network)
    const approval = await approve(runtime, "codex")
    expect(approval.permissions).toEqual([AGENT_PERMISSIONS])
    transactions.grantCodex = approval.transactionHash
  })

  step("7. codex reads claude-code's checkpoint, and only for the project it asked about", async () => {
    const read = await readCheckpoints(runtime, "codex", "proj-1")
    expect(read.checkpoints.map((c) => c.checkpoint)).toEqual([CHECKPOINT])
    expect(read.checkpoints[0]!.authorId).toBe(runtime.agent("claude-code").agentId)
    timings.read.push(read.milliseconds)
  })
})
```

Some imports (`mkdirSync`, `writeFileSync`, `fileURLToPath`, `privateKeyToAccount`, `bytesOf`, `createWriteContext`, `ContextApiClient`, `MidaAgent`, `loadAgentIdentity`, `loadGrants`, `revoke`) are used only by Task 5's steps. If the linter or typecheck objects to unused imports now, leave them out and add them in Task 5.

- [ ] **Step 2: Run and see it fail**

Run: `pnpm vitest run apps/midad/test/skeleton.e2e.test.ts`
Expected: FAIL — `Runtime` is not exported.

- [ ] **Step 3: Implement the API server and the runtime**

```ts
// apps/midad/src/api-server.ts
import { mkdirSync } from "node:fs"
import { createPublicClient, http } from "viem"
import { serve } from "@hono/node-server"
import { chainFor } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { RegistryReader, createContextApi } from "@mida/api"

/** The existing Context API, on a data folder that is still there after a restart. Bound to localhost only. */
export async function startPersistentApi(input: { rpcUrl: string; deployment: Deployment; dataDir: string }): Promise<{ baseUrl: string; close(): Promise<void> }> {
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 })
  const publicClient = createPublicClient({ chain: chainFor(input.deployment.chainId), transport: http(input.rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment: input.deployment })
  const { app } = createContextApi({ reader, deployment: input.deployment, dataDir: input.dataDir })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ baseUrl: `http://127.0.0.1:${info.port}`, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}
```

```ts
// apps/midad/src/runtime.ts
import { privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import { PERMISSION } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { bytesOf } from "@mida/crypto"
import { createWriteContext } from "@mida/chain"
import type { Deployment, LocalWriteContext } from "@mida/chain"
import { ContextApiClient, RegistryReader } from "@mida/api"
import { FakeVaultAuthority } from "@mida/fake-vault"
import { MidaAgent } from "@mida/sdk"
import type { MidaHome } from "./home.js"
import { FileAccessRequestStore } from "./request-store.js"
import { listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets } from "./keys.js"
import type { AgentIdentity } from "./keys.js"
import { startPersistentApi } from "./api-server.js"

export interface Network {
  rpcUrl: string
  deployment: Deployment
  fund(address: Address): Promise<void>
}

export const NAMESPACE = "projects.current"
export const PURPOSE_ID = "project_assistance" as const
export const AGENT_PERMISSIONS = PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN
/** Below this balance an account is topped up before it has to send a transaction. */
const MIN_BALANCE_WEI = 50_000_000_000_000_000n

export class Runtime {
  readonly #agents = new Map<string, MidaAgent>()
  readonly #close: () => Promise<void>

  private constructor(
    readonly home: MidaHome,
    readonly network: Network,
    readonly ownerChain: LocalWriteContext,
    readonly ownerApi: ContextApiClient,
    readonly vault: FakeVaultAuthority,
    readonly reader: RegistryReader,
    readonly apiBaseUrl: string,
    close: () => Promise<void>,
  ) {
    this.#close = close
  }

  get owner(): Address {
    return this.vault.owner
  }

  static async open(home: MidaHome, network: Network): Promise<Runtime> {
    const secrets = loadOrCreateOwnerSecrets(home)
    const ownerAccount = privateKeyToAccount(secrets.privateKey)
    const server = await startPersistentApi({ rpcUrl: network.rpcUrl, deployment: network.deployment, dataDir: home.path("data") })
    const ownerChain = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: ownerAccount })
    const ownerApi = Runtime.#apiClient(server.baseUrl, network.deployment, ownerAccount)
    const vault = new FakeVaultAuthority({ seed: bytesOf(secrets.seed, 32), p256PrivateKey: secrets.p256PrivateKey, chain: ownerChain, api: ownerApi })
    const runtime = new Runtime(home, network, ownerChain, ownerApi, vault, new RegistryReader(ownerChain), server.baseUrl, server.close)
    for (const name of listAgentNames(home)) runtime.attach(loadAgentIdentity(home, name)!)
    return runtime
  }

  static #apiClient(baseUrl: string, deployment: Deployment, account: LocalAccount): ContextApiClient {
    return new ContextApiClient({ baseUrl, account, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry })
  }

  /** Builds the agent from its saved identity and the grants it completed before, and keeps it for `agent(name)`. */
  attach(identity: AgentIdentity): MidaAgent {
    const signer = privateKeyToAccount(identity.signerPrivateKey)
    const agent = new MidaAgent({
      agentId: identity.agentId,
      callbackOrigin: identity.callbackOrigin,
      encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
      chain: createWriteContext({ rpcUrl: this.network.rpcUrl, deployment: this.network.deployment, account: signer }),
      api: Runtime.#apiClient(this.apiBaseUrl, this.network.deployment, signer),
      requests: new FileAccessRequestStore(this.home, identity.name),
      grants: loadGrants(this.home, identity.name),
    })
    this.#agents.set(identity.name, agent)
    return agent
  }

  agent(name: string): MidaAgent {
    const agent = this.#agents.get(name)
    if (agent === undefined) throw new Error(`agent "${name}" is not set up on this machine; run init first`)
    return agent
  }

  async ensureFunded(address: Address): Promise<void> {
    const balance = await this.ownerChain.publicClient.getBalance({ address })
    if (balance < MIN_BALANCE_WEI) await this.network.fund(address)
  }

  close(): Promise<void> {
    return this.#close()
  }
}
```

- [ ] **Step 4: Implement the operations**

```ts
// apps/midad/src/skeleton.ts
import { privateKeyToAccount } from "viem/accounts"
import { PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { createWriteContext } from "@mida/chain"
import { provisionAgent } from "@mida/fake-vault"
import { AGENT_PERMISSIONS, NAMESPACE, PURPOSE_ID } from "./runtime.js"
import type { Runtime } from "./runtime.js"
import {
  identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets, loadOrCreateSignerKey,
  markRevoked, saveAgentIdentity, saveGrants,
} from "./keys.js"

const CHECKPOINT_TYPE = "mida.checkpoint.v0"
const GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60
const NAMESPACE_ID = namespaceId(NAMESPACE)

/** Spec §5A. Every step first asks the chain or the disk whether it is already done, so running it twice is harmless. */
export async function init(runtime: Runtime, agentNames: readonly string[]): Promise<{ owner: Address; agents: Record<string, Hex> }> {
  const { home, network, vault, reader, owner } = runtime
  await runtime.ensureFunded(owner)
  const ownerKey = await reader.ownerP256Key(owner)
  if (ownerKey == null || ownerKey.qx === 0n) await vault.registerOwnerKey()
  if ((await reader.epochPublicKey(owner, NAMESPACE_ID, 1n)) == null) await vault.initializeNamespace(NAMESPACE)

  const operatorAccount = privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey)
  const operator = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: operatorAccount })
  const agents: Record<string, Hex> = {}
  for (const name of agentNames) {
    let identity = loadAgentIdentity(home, name)
    if (identity === undefined) {
      await runtime.ensureFunded(operatorAccount.address)
      // Saved to disk BEFORE the registration transaction: a crash must never leave a registered agent with no key.
      const signerPrivateKey = loadOrCreateSignerKey(home, name)
      const provisioned = await provisionAgent({
        operator,
        name,
        purposeId: PURPOSE_ID,
        declarations: [{ namespace: NAMESPACE, permissions: ["READ", "CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE"] }],
        callbackOrigin: `https://${name}.mida.example`,
        signer: privateKeyToAccount(signerPrivateKey),
      })
      identity = identityFrom(name, signerPrivateKey, provisioned)
      saveAgentIdentity(home, identity)
      await runtime.ownerApi.putAgentManifest(identity.manifest)
      runtime.attach(identity)
    }
    await runtime.ensureFunded(privateKeyToAccount(identity.signerPrivateKey).address)
    agents[name] = identity.agentId
  }
  return { owner, agents }
}

/** Spec §5B step 1: the agent asks. The request is on disk before this returns, and so is which request is pending. */
export async function requestAccess(runtime: Runtime, name: string): Promise<{ requestId: Hex }> {
  const request = await runtime.agent(name).createAccessRequest({
    purposeId: PURPOSE_ID,
    scopes: [{ namespace: NAMESPACE, permissions: AGENT_PERMISSIONS, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
  })
  runtime.home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
  return { requestId: request.requestId }
}

/** Spec §5B steps 3–4: the owner approves the pending request on-chain; the agent checks the result and keeps the grant. */
export async function approve(runtime: Runtime, name: string): Promise<{ capabilityIds: Hex[]; permissions: number[]; transactionHash: Hex; gasUsed: bigint }> {
  const { home, vault } = runtime
  const identity = loadAgentIdentity(home, name)
  const pending = home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)
  if (identity === undefined || pending === undefined) throw new Error(`agent "${name}" has no pending request; run requestAccess first`)
  const approval = await vault.approveGrant({ accessRequest: pending.request, manifest: identity.manifest, selection: { kind: "recommended" } })
  const agent = runtime.agent(name)
  const grant = await agent.completeAccessRequest(pending.request, approval.response)
  saveGrants(home, name, [...agent.grants])
  return {
    capabilityIds: grant.capabilities.map((capability) => capability.capabilityId),
    permissions: grant.capabilities.map((capability) => capability.permissions),
    transactionHash: approval.response.capabilities[0]!.transactionHash,
    gasUsed: approval.gasUsed,
  }
}

/** Spec §5C steps 4–5 with a hard-coded checkpoint: encrypt, upload, and register on Monad under the agent's own key. */
export async function saveCheckpoint(runtime: Runtime, name: string, input: { projectId: string; checkpoint: Record<string, unknown> }): Promise<{ contextId: Hex; transactionHash: Hex; milliseconds: number }> {
  const started = Date.now()
  const object = await runtime.agent(name).create(runtime.owner, NAMESPACE, {
    value: { type: CHECKPOINT_TYPE, projectId: input.projectId, compiledBy: "m0-hardcoded", checkpoint: input.checkpoint },
    kind: "EPISODE",
    source: "AGENT_INFERRED",
    tags: ["mida-checkpoint"],
  })
  return { contextId: object.contextId, transactionHash: object.transactionHash!, milliseconds: Date.now() - started }
}

/** Spec §5D steps 2–3: a full protocol read as this agent, then keep only this project's checkpoints. */
export async function readCheckpoints(runtime: Runtime, name: string, projectId: string): Promise<{ checkpoints: Array<{ contextId: Hex; authorId: Hex; checkpoint: Record<string, unknown> }>; milliseconds: number }> {
  const started = Date.now()
  const objects = await runtime.agent(name).read(runtime.owner, NAMESPACE)
  const checkpoints = objects.flatMap((object) => {
    const value = object.payload.value
    if (typeof value !== "object" || value === null) return []
    const record = value as Record<string, unknown>
    if (record.type !== CHECKPOINT_TYPE || record.projectId !== projectId) return []
    return [{ contextId: object.contextId, authorId: object.authorId, checkpoint: record.checkpoint as Record<string, unknown> }]
  })
  return { checkpoints, milliseconds: Date.now() - started }
}

/** Spec §5E: refuse at once locally, revoke and rotate the key on Monad, then hand the new key to everyone still approved. */
export async function revoke(runtime: Runtime, name: string): Promise<{ transactionHashes: Hex[]; rewrapped: string[] }> {
  const { home, vault, ownerApi } = runtime
  const capabilityIds = loadGrants(home, name).flatMap((grant) => grant.capabilities.map((capability) => capability.capabilityId))
  if (capabilityIds.length === 0) throw new Error(`agent "${name}" has no grant to revoke`)
  for (const capabilityId of capabilityIds) await ownerApi.requestRevocationDeny({ capabilityId })
  const transactionHashes: Hex[] = []
  for (const capabilityId of capabilityIds) transactionHashes.push((await vault.approveRevocation({ kind: "capability", capabilityId })).transactionHash)
  markRevoked(home, name)
  const rewrapped: string[] = []
  for (const other of listAgentNames(home)) {
    if (other === name || isRevoked(home, other) || loadGrants(home, other).length === 0) continue
    await vault.publishReaderWraps({ agentId: loadAgentIdentity(home, other)!.agentId, namespaceId: NAMESPACE_ID })
    rewrapped.push(other)
  }
  return { transactionHashes, rewrapped }
}
```

Add to `apps/midad/src/index.ts`:

```ts
export { Runtime, AGENT_PERMISSIONS, NAMESPACE, PURPOSE_ID } from "./runtime.js"
export type { Network } from "./runtime.js"
export { startPersistentApi } from "./api-server.js"
export { init, requestAccess, approve, saveCheckpoint, readCheckpoints, revoke } from "./skeleton.js"
```

**Points where the protocol might disagree with this plan. For each: STOP and report, do not work around.**
- `reader.ownerP256Key(owner)` for an owner who never registered: this plan assumes `null` or a zero `qx`. Read the `RegistryReader` source under `apps/api/src` and adjust only that one condition to match what it really returns.
- The second `provisionAgent` from the same operator reverting. That is M0's question 1. Report the revert reason exactly.
- The grant advisor narrowing the grant below `AGENT_PERMISSIONS` (step 4 of the test would show it). Report `approval.advice` warnings.
- `create` rejecting `kind: "EPISODE"` with `source: "AGENT_INFERRED"`. Report the error code.
- Step 3 expecting `CAPABILITY_DENIED` from an unapproved `create`. If the SDK reports a different code, report it.

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run apps/midad/test/skeleton.e2e.test.ts`
Expected: 7 passed (local Anvil; roughly 20–60 s). **If step 7 fails with `CAPABILITY_DENIED` the grants were not restored after the restart; if it returns an empty list the API data folder did not persist.** Fix the cause, never the assertion.
Run: `pnpm typecheck` — Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/midad
git commit -m "feat(midad): init, approve, save and read a checkpoint through the real protocol with state on disk"
```

---

### Task 5: Revoke, the forged-grant attack, and the measurements

**Files:**
- Modify: `apps/midad/test/skeleton.e2e.test.ts` (append steps 8–12 inside the same `describe`, after step 7)
- Create (by running the test): `docs/evidence/m0-local-anvil.json`

**Interfaces:**
- Consumes: everything Task 4 produced, plus `revoke`, `loadGrants`, `loadAgentIdentity`.
- Produces: the evidence file, shape `{ network: string, generatedAt: ISO-8601 string, oneOperatorRegisteredBothAgents: true, grantGasUsed: string, saveMilliseconds: number[], readMilliseconds: number[], saveToReadableMilliseconds: number, transactions: Record<string, string> }`. Hashes, numbers and the network name only.

- [ ] **Step 1: Append the steps**

```ts
  step("8. after the restart claude-code can still save, and codex sees the new save", async () => {
    const started = Date.now()
    const saved = await saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: { ...CHECKPOINT, nextAction: "Write the README" } })
    const read = await readCheckpoints(runtime, "codex", "proj-1")
    transactions.saveToReadableMs = String(Date.now() - started)
    timings.save.push(saved.milliseconds)
    timings.read.push(read.milliseconds)
    transactions.saveAfterRestart = saved.transactionHash
    expect(read.checkpoints).toHaveLength(2)
  })

  step("9. ATTACK: an agent rebuilt with a forged grant gets nothing", async () => {
    const identity = loadAgentIdentity(home, "codex")!
    const real = loadGrants(home, "codex")[0]!
    const forgedCapability = { ...real.capabilities[0]!, capabilityId: `0x${"f0".repeat(32)}` as `0x${string}` }
    const signer = privateKeyToAccount(identity.signerPrivateKey)
    const forged = new MidaAgent({
      agentId: identity.agentId,
      callbackOrigin: identity.callbackOrigin,
      encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
      chain: createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: signer }),
      api: new ContextApiClient({ baseUrl: runtime.apiBaseUrl, account: signer, chainId: network.deployment.chainId, capabilityRegistry: network.deployment.capabilityRegistry }),
      grants: [{ ...real, capabilities: [forgedCapability] }],
    })
    await expect(forged.read(runtime.owner, "projects.current")).rejects.toMatchObject({ code: expect.stringMatching(/^(CAPABILITY_DENIED|CAPABILITY_REVOKED|NOT_FOUND)$/) })
  })

  step("10. the owner revokes claude-code: it is refused for reads AND writes", async () => {
    const result = await revoke(runtime, "claude-code")
    expect(result.transactionHashes).toHaveLength(1)
    expect(result.rewrapped).toEqual(["codex"])
    transactions.revokeAndRotate = result.transactionHashes[0]!
    await expect(readCheckpoints(runtime, "claude-code", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    await expect(saveCheckpoint(runtime, "claude-code", { projectId: "proj-1", checkpoint: CHECKPOINT })).rejects.toMatchObject({
      code: expect.stringMatching(/^CAPABILITY_(REVOKED|DENIED)$/),
    })
  })

  step("11. codex is untouched: it still reads everything, and saves under the new key", async () => {
    const saved = await saveCheckpoint(runtime, "codex", { projectId: "proj-1", checkpoint: { objective: "Codex carried on" } })
    transactions.codexSaveAfterRevoke = saved.transactionHash
    const read = await readCheckpoints(runtime, "codex", "proj-1")
    expect(read.checkpoints).toHaveLength(3)
    expect(read.checkpoints.map((c) => c.checkpoint.objective)).toContain("Codex carried on")
  })

  step("12. the revocation survives a restart, and the measurements are written down", async () => {
    await runtime.close()
    runtime = await Runtime.open(home, network)
    await expect(readCheckpoints(runtime, "claude-code", "proj-1")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect((await readCheckpoints(runtime, "codex", "proj-1")).checkpoints).toHaveLength(3)
    const folder = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url))
    mkdirSync(folder, { recursive: true })
    const { saveToReadableMs, ...hashes } = transactions
    writeFileSync(
      `${folder}m0-${ON_TESTNET ? "monad-testnet" : "local-anvil"}.json`,
      JSON.stringify({
        network: env.name, generatedAt: new Date().toISOString(), oneOperatorRegisteredBothAgents: true,
        grantGasUsed, saveMilliseconds: timings.save, readMilliseconds: timings.read,
        saveToReadableMilliseconds: Number(saveToReadableMs), transactions: hashes,
      }, null, 2),
    )
  })
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run apps/midad/test/skeleton.e2e.test.ts`
Expected: 12 passed.

If step 10's read is refused with a code other than `CAPABILITY_REVOKED`, STOP and report the code: the demo's "A is refused because it was revoked" line depends on it. If step 12's revoked read passes after the restart, the deny list or the on-chain revoke did not persist — that is the worst bug this milestone can have; report it, do not soften the test.

- [ ] **Step 3: Full suite**

Run: `pnpm test` — Expected: all pass (306 + 4 + 23 + 12 = 345).
Run: `pnpm typecheck` — Expected: exit 0.

- [ ] **Step 4: Check nothing secret was written outside the home folder**

Run: `git status --short`
Expected: only files under `apps/midad` and `docs/evidence/m0-local-anvil.json`. Open the evidence file and confirm it holds only hashes, numbers and the network name.

- [ ] **Step 5: Commit**

```bash
git add apps/midad docs/evidence/m0-local-anvil.json
git commit -m "test(midad): revoke, forged-grant attack and M0 measurements on local Anvil"
```

---

### Task 6: The crude `mida` command, and the Monad testnet run

**Files:**
- Create: `apps/midad/src/cli.ts`
- Modify: `apps/midad/src/index.ts`, root `package.json` (one script)
- Test: `apps/midad/test/cli.test.ts`
- Create (by running): `docs/evidence/m0-monad-testnet.json`

**Interfaces:**
- Consumes: the six operations and `Runtime`.
- Produces: `export async function runCli(argv: string[], deps: CliDeps): Promise<number>` with `interface CliDeps { home: MidaHome; network: Network; print(line: string): void }`, and the script `pnpm mida <command>`.

Commands: `init`, `request <agent>`, `approve <agent>`, `save-demo <agent> <projectId>`, `read <agent> <projectId>`, `revoke <agent>`. Exit code 0 on success, 1 on a refused or failed operation, 2 on bad usage. Output is one line per fact. It never prints a key, and never prints checkpoint text.

- [ ] **Step 1: Write the failing test**

```ts
// apps/midad/test/cli.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, runCli } from "@mida/midad"
import type { Network } from "@mida/midad"

describe("the crude mida command", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  const lines: string[] = []
  const run = (...argv: string[]) => runCli(argv, { home, network, print: (line) => lines.push(line) })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-")))
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("rejects an unknown command, an unknown agent and a missing project with exit code 2", async () => {
    expect(await run("frobnicate")).toBe(2)
    expect(await run("approve", "cursor")).toBe(2)
    expect(await run("read", "codex")).toBe(2)
  })

  it("walks the whole demo: init, approve both, save, read, revoke, refused", async () => {
    expect(await run("init")).toBe(0)
    expect(await run("request", "claude-code")).toBe(0)
    expect(await run("approve", "claude-code")).toBe(0)
    expect(await run("save-demo", "claude-code", "proj-1")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(1)
    expect(await run("request", "codex")).toBe(0)
    expect(await run("approve", "codex")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(await run("revoke", "claude-code")).toBe(0)
    expect(await run("read", "claude-code", "proj-1")).toBe(1)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(lines.some((line) => line.includes("CAPABILITY_REVOKED"))).toBe(true)
  }, 300_000)

  it("never prints a secret: no output line contains any key stored in the home folder", () => {
    const secrets: string[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder)) {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== "data") walk(full)
        } else if (/secrets|signer|identity/.test(entry)) {
          const text = readFileSync(full, "utf8")
          for (const match of text.matchAll(/"(?:privateKey|seed|p256PrivateKey|signerPrivateKey|encryptionPrivateKey)":\s*"(0x[0-9a-f]{64})"/g)) secrets.push(match[1]!)
        }
      }
    }
    walk(home.root)
    expect(secrets.length).toBeGreaterThanOrEqual(8)
    const output = lines.join("\n")
    for (const secret of secrets) expect(output.includes(secret)).toBe(false)
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `pnpm vitest run apps/midad/test/cli.test.ts`
Expected: FAIL — `runCli` is not exported.

- [ ] **Step 3: Implement**

```ts
// apps/midad/src/cli.ts
import { MidaHome } from "./home.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { approve, init, readCheckpoints, requestAccess, revoke, saveCheckpoint } from "./skeleton.js"

const AGENTS = ["claude-code", "codex"]
const WITH_AGENT = ["request", "approve", "save-demo", "read", "revoke"]
const WITH_PROJECT = ["save-demo", "read"]
const USAGE = "usage: mida init | request <agent> | approve <agent> | save-demo <agent> <projectId> | read <agent> <projectId> | revoke <agent>   (agent = claude-code | codex)"

export interface CliDeps {
  home: MidaHome
  network: Network
  print(line: string): void
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command = "", agent = "", projectId = ""] = argv
  const usage = () => {
    deps.print(USAGE)
    return 2
  }
  if (command !== "init" && !WITH_AGENT.includes(command)) return usage()
  if (WITH_AGENT.includes(command) && !AGENTS.includes(agent)) return usage()
  if (WITH_PROJECT.includes(command) && projectId.length === 0) return usage()

  const runtime = await Runtime.open(deps.home, deps.network)
  try {
    if (command === "init") {
      const result = await init(runtime, AGENTS)
      deps.print(`owner ${result.owner}`)
      for (const [name, agentId] of Object.entries(result.agents)) deps.print(`agent ${name} ${agentId}`)
    } else if (command === "request") {
      deps.print(`requested ${agent} ${(await requestAccess(runtime, agent)).requestId}`)
    } else if (command === "approve") {
      const result = await approve(runtime, agent)
      deps.print(`approved ${agent} tx ${result.transactionHash} gas ${result.gasUsed}`)
    } else if (command === "save-demo") {
      const result = await saveCheckpoint(runtime, agent, { projectId, checkpoint: { objective: "M0 demo checkpoint", savedBy: agent } })
      deps.print(`saved ${result.contextId} tx ${result.transactionHash} in ${result.milliseconds} ms`)
    } else if (command === "read") {
      const result = await readCheckpoints(runtime, agent, projectId)
      deps.print(`read ${result.checkpoints.length} checkpoint(s) in ${result.milliseconds} ms`)
      for (const checkpoint of result.checkpoints) deps.print(`  ${checkpoint.contextId} written by ${checkpoint.authorId}`)
    } else {
      const result = await revoke(runtime, agent)
      deps.print(`revoked ${agent} tx ${result.transactionHashes.join(" ")}; new key sent to: ${result.rewrapped.join(", ") || "nobody"}`)
    }
    return 0
  } catch (error) {
    // The error code only. A message from a deeper layer is never echoed: it could carry data.
    const code = (error as { code?: unknown }).code
    deps.print(`refused: ${typeof code === "string" ? code : "ERROR"}`)
    return 1
  } finally {
    await runtime.close()
  }
}

/** Entry point for `pnpm mida`. Monad testnet only; needs DEPLOYER_PRIVATE_KEY in the environment as the funder. */
async function main(): Promise<void> {
  const { monadTestnetEnvironment } = await import("@mida/cli")
  const env = await monadTestnetEnvironment()
  try {
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    process.exitCode = await runCli(process.argv.slice(2), { home: new MidaHome(), network, print: (line) => console.log(line) })
  } finally {
    await env.stop()
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
```

Add to `apps/midad/src/index.ts`:

```ts
export { runCli } from "./cli.js"
export type { CliDeps } from "./cli.js"
```

Add to the root `package.json` scripts:

```json
"mida": "node --env-file=.env --import tsx apps/midad/src/cli.ts"
```

`--env-file` makes Node load the funder key itself. Nobody opens `.env`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/midad/test/cli.test.ts` — Expected: 3 passed.
Run: `pnpm test` — Expected: 348 passed. Run: `pnpm typecheck` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/midad package.json
git commit -m "feat(midad): crude mida command over the six skeleton operations"
```

- [ ] **Step 6: Monad testnet run — Claude or Dami runs this, NOT Devin (it uses the funder key)**

Run from the repo root:

```bash
MIDA_E2E_MONAD_TESTNET=1 node --env-file=.env ./node_modules/vitest/vitest.mjs run apps/midad/test/skeleton.e2e.test.ts
```

Expected: 12 passed; `docs/evidence/m0-monad-testnet.json` written. It funds four accounts at 0.2 MON each from the deployer key (about 6.6 MON were left on Sep 17). If the balance is too low the funding step says so; top up from `https://faucet.monad.xyz` and re-run.

- [ ] **Step 7: Record the answers**

Read the evidence file and write into `log.md` and into spec §12, in plain words: whether one operator registered both agents; the read time in milliseconds against the session-start hook time limits of Claude Code and Codex (look both limits up at that point — they are not known now); the save-to-readable time; the gas per approval. State which design choice each number decides: cache or no cache (spec §5D), one operator or two.

```bash
git add docs/evidence/m0-monad-testnet.json log.md docs/superpowers/specs/2026-09-20-p0-handoff-design.md
git commit -m "docs: record M0 measurements from Monad testnet"
```

- [ ] **Step 8: Adversarial review before M0 is called done**

Run `/code-review high` on the branch diff. Aim it at: a refusal that does not refuse; a secret reaching a log, an error message or the evidence file; `init` run twice doing something twice; a crash between any two lines of `init`, `approve` or `revoke` leaving state the next run cannot repair; the project filter returning another project's checkpoint.

---

## What M0 deliberately leaves out (each has a later milestone in the spec §11)

- The owner key and the agent keys live in one process here. The spec's hard boundary — only the `mida` command holds the owner key, `midad` is a separate long-lived service reached over a socket — is built in M2 with the hooks. M0's `keys.ts` already keeps owner functions and agent functions apart so that cut is mechanical.
- The owner-signed approved-projects list (spec §5B step 4). M0 filters by project ID in code only.
- Funding by the owner wallet. M0 funds from the testnet deployer key, as Project 1's scenario does.
- Hooks, the compiler, the merge rule, the handoff text, MCP, `install`, `doctor`, `status`, `provenance`.
- `pnpm mida` starts Project 1's temp-folder API server as a side effect of `monadTestnetEnvironment()` and ignores it. Harmless, wasteful, removed in M2.
