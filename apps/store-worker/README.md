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

- **Refuse ciphertext.** It rejects uploads that are unsigned, malformed, over the size cap
  (256 KB per object), over quota (2,000 PUTs per signer per day, 20 MB of unanchored ciphertext
  per signer), or signed by someone the chain does not authorise — so it cannot be used as free
  file hosting.
- **Delete ciphertext.** Pending uploads that the chain never anchors are swept after 24 hours,
  and expired request nonces are swept with them. The operator can also delete rows directly;
  deleting data only makes objects disappear — it can never make new ones valid.

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

- **Daily maintenance is automatic.** The `scheduled` cron (`0 4 * * *` in `wrangler.toml`)
  deletes pending objects older than 24 h that the chain never anchored, and nonces older than
  the 60-second request window.
- **`nodejs_compat` is on, deliberately.** The shared `@mida/api` package re-exports its
  file-backed stores (`node:fs`/`node:path`), so the bundler sees Node imports. The Worker always
  injects the D1 stores; those code paths never execute.
- **`import.meta.url` is defined in `wrangler.toml`, deliberately.** `@mida/chain`'s barrel
  computes two directory constants at module scope from `import.meta.url`, which is not a URL in
  workerd; the define keeps that dead code from crashing startup.
- **Check `GET /` after deploying.** It returns the deployment's chain id, the two registry
  addresses, the enforced limits, and a sentence telling callers this server stores ciphertext
  only.
- **Logs are safe by construction.** Method, path template, status, byte count and duration —
  never a request body, a signature, a full address or a full hash.
