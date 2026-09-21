# The hosted Mida context store

A Cloudflare Worker that runs the **same** Context API (`createContextApi` in `apps/api`) that the
Mida CLI runs on your own laptop, backed by Cloudflare D1 (SQLite) instead of files on disk.

## Why this exists

Today, an application that wants to use Mida context has to run the API server itself — the Mida
CLI binds it to `127.0.0.1` on the user's machine and stores files in a local directory. A team
integrating the SDK should not have to run a server at all. This Worker is that same server,
hosted — and because it is the same code with the same rules, anyone can run their own copy and
get identical behaviour.

**It holds ciphertext only. The encryption keys never reach it. Anyone can run the same server
themselves.**

## What this server can do — and cannot do

The server is storage plus admission control. It is *not* a trust authority: Monad (the chain)
decides what is allowed; the server can only ever be stricter, never looser.

**It can:**

- **Refuse ciphertext.** It rejects uploads that are unsigned, malformed, over the size caps
  (1 MB per request body, 256 KB of ciphertext per object, 16 KB per agent-manifest envelope),
  over quota (2,000 object PUTs and 20 manifest PUTs per signer per day, 20 MB of unanchored
  ciphertext per signer), or signed by someone the chain does not authorise — so it cannot be
  used as free file hosting. `GET /` reports every one of these limits.
- **Throttle callers.** Two Cloudflare `[[ratelimits]]` bindings give every route a per-IP
  budget keyed on `CF-Connecting-IP`: 120 requests a minute for signed traffic, 20 a minute for
  anonymous traffic — including `GET /` and CORS preflights. A refusal is 429 with
  `Retry-After: 60`.
- **Spend a bounded number of chain reads per request.** Every Monad read is one outgoing
  subrequest, and one request is allowed at most **30** (`MAX_CHAIN_READS_PER_REQUEST`,
  reported by `GET /` as `chainReadsPerRequest`). A request that would need more fails with
  503 and `Retry-After: 5` — never a 500, and never a partial write.
- **Delete ciphertext.** Pending uploads that the chain never anchors are swept after 24 hours
  — row and ciphertext blob together — and expired request nonces are swept with them, as are
  agent-manifest envelopes whose agent never registered. The operator can also delete rows
  directly; deleting data only makes objects disappear — it can never make new ones valid.

**It cannot:**

- **Read ciphertext.** It never holds a decryption key — the client encrypts before upload and
  the DEK arrives only as a wrapped blob addressed to the epoch key, so the stored bytes are
  opaque to the operator.
- **Grant authority.** Permission to read or write comes from capabilities recorded on Monad;
  the server only checks them (`GET /objects` requires an anchored chain record plus a
  capability with the READ bit), so it cannot allow what the chain does not.
- **Revoke authority.** Revocation lives on the chain and in the owner's signed intents; the
  server's deny overlay can only *remove* effective authority, never restore it — `effective =
  allowedByMonad AND NOT localDeny`.
- **Forge valid data.** Every accepted request carries a Mida EIP-712 signature over method,
  path, body, timestamp and nonce, and every served object must match a chain-anchored manifest
  hash and ciphertext commitment — so modified or invented data fails verification, not storage.

## Run your own

You need a Cloudflare account, `wrangler`, and a Monad RPC endpoint. Nothing secret or
account-specific lives in `wrangler.toml` — you supply the real values.

1. Create the D1 database and paste the printed `database_id` into `wrangler.toml` in place of
   `REPLACE_WITH_D1_DATABASE_ID`:

   ```
   wrangler d1 create mida-context-store        # NOT RUN — requires a Cloudflare account
   ```

2. Create the tables:

   ```
   wrangler d1 execute mida-context-store --file=schema.sql   # NOT RUN
   ```

3. Set the deployment variables in `wrangler.toml` `[vars]` — `CHAIN_ID`,
   `CAPABILITY_REGISTRY`, `CONTEXT_REGISTRY`, `DEPLOYMENT_BLOCK`, `POLICY_HASH_V1`,
   `VAULT_RP_ID`, `VAULT_RP_ID_HASH` — to the deployment your clients will use, and set the RPC
   endpoint as a secret (it may carry an API key, so it does not belong in the file):

   ```
   wrangler secret put RPC_URL                  # NOT RUN
   ```

   Every variable is required; the Worker refuses to start with an error naming the missing one.

4. Deploy:

   ```
   wrangler deploy                              # NOT RUN
   ```

`NOT RUN` means exactly that: this code was verified end-to-end locally through Miniflare (the
same `workerd` runtime Workers uses, against a real SQLite D1), but no command was ever run
against a real Cloudflare account.

### Notes for operators

- **Maintenance is automatic and bounded.** The `scheduled` cron (`*/15 * * * *` in
  `wrangler.toml`) deletes pending objects older than 24 h that the chain never anchored —
  row and ciphertext blob together — and nonces older than the 60-second request window. Each
  run examines at most **25** object rows, oldest first (one chain read each), so a run always
  fits the platform's subrequest ceiling; a backlog drains over successive runs instead of a
  daily job dying half-way. A row whose chain read fails is skipped, never deleted.
- **The 30-read budget assumes the Cloudflare Workers Free plan** (50 subrequests per
  invocation, of which every Monad read is one — 30 leaves headroom for rate-limit checks and
  D1). **Check the current Workers limits page** before deploying on another plan; the number
  is `MAX_CHAIN_READS_PER_REQUEST` in `apps/api/src/chain-budget.ts`.
- **`GET /objects` can be partial.** Rows never yet verified against Monad cost one chain read
  each; when the budget runs out mid-list the response carries `x-mida-partial: true` and omits
  the unexamined rows. Verified rows are marked, so a retry makes progress — the bundled client
  retries up to 3 times and then returns what it has with `partial: true` on the result, never
  a silent short list.
- **One process per data directory.** The file-backed store (what `createContextApi` uses with
  `dataDir` — the local/self-hosted mode) enforces its quotas read-then-write: atomic inside one
  Node process, but two processes sharing a directory can both pass the pending-byte check. Run
  exactly one process per directory; if you need several front ends, use the D1-backed deployment
  where the pending cap is a single conditional `INSERT` and atomic across instances.
- **`nodejs_compat` is on, deliberately.** The shared `@mida/api` package re-exports its
  file-backed stores (`node:fs`/`node:path`), so the bundler sees Node imports. The Worker always
  injects the D1 stores; those code paths never execute. `@mida/chain`'s directory constants
  resolve lazily on first call, so the bundle's module scope touches no `import.meta.url` — no
  `[define]` shim is needed or present.
- **Manifest reads are cheap for verified agents.** `GET /agent-manifests/:bodyHash` re-verifies
  the envelope against Monad only when the row's verified mark is older than 60 seconds; inside
  the window it serves without a chain read. The consequence to know: an agent removed on chain
  keeps being served for up to 60 seconds after its last verification — that number is the worst
  case, and it is the same `manifestVerifyCacheSeconds` `GET /` reports. Failed verifications
  are never cached.
- **Check `GET /` after deploying.** It returns the deployment's chain id, the two registry
  addresses, every enforced limit, the 60-second manifest cache window, the per-request
  chain-read budget, the partial-list header name, the sweep cadence and bound, the per-IP
  budgets the bindings are configured with (`null` where a binding is absent), and a sentence
  telling callers this server stores ciphertext only.
- **Logs are safe by construction.** Method, path template, status, byte count and duration —
  never a request body, a signature, a full address or a full hash.

### Self-hosting on a public address

Running this Worker is one way to self-host; the other is the plain Node server (`createContextApi`
with `dataDir`, the same app the CLI runs). If you put that Node server on a public address you get
the identical application rules — same signatures, quotas, sweeps and capability checks — but you
lose everything Cloudflare's edge provides here for free: per-IP rate limiting applied before your
code runs (the Node app takes an optional `limiter` hook and ships with none — put your own reverse
proxy with a request budget in front, or anonymous traffic reaches your process unfiltered), TLS
termination at the edge, DDoS absorption, and D1's atomic quotas across instances (the file store's
pending-byte check is atomic inside one process only — one process per data directory, as above).
A bare Node server on a public address without a limiting proxy is not a safe deployment of this
code.
