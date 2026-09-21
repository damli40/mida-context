# The Mida gas sponsor

A Cloudflare Worker that sits between the Mida SDK and a gas-sponsorship provider (Pimlico first,
Alchemy second) and decides, for every request, whether our sponsorship budget pays for it.

## Why this exists

A new Mida user owns no MON. Today we send them 0.2 MON from a funder wallet before they can do
anything — that does not scale, and no team integrating the SDK can ship that flow. The fix is
EIP-7702 + ERC-4337: the user's ordinary address signs a one-time authorization letting it run
smart-account code, the action travels as a "user operation" whose `sender` **is** the user's
address, a bundler puts it on chain, and a paymaster pays. Our contracts still see the user's
address as `msg.sender`, so grant ownership stays correct.

But a paymaster key with no guard is a blank cheque. The provider's sponsorship policy cannot
restrict *which contract* is called — so this Worker is the guard. It checks every user operation
before it forwards: only calls to the two Mida registries, only Mida functions, only zero value,
only bounded gas, only within daily budgets.

**It can pay for a call or refuse to. It cannot sign, read, grant or revoke.**

## What this endpoint can do — and cannot do

The endpoint is admission control over someone else's money. It is not a signer and holds no user
key; the user operation is already signed by the user's own key before it arrives.

**It can:**

- **Refuse.** Any JSON-RPC method outside a fixed allowlist gets `-32601`; batch bodies are
  refused outright (batching is how a policy check gets skipped); and every operation that fails
  a policy rule gets a JSON-RPC error naming the rule — never a 500 and never a silent pass.
- **Enforce a Mida-only policy.** `callData` must decode as `execute`/`executeBatch` (or Alchemy's
  `executeWithRuntimeValidation` wrapper, one level deep) with at most 8 inner calls; every inner
  call must target the configured `CAPABILITY_REGISTRY` or `CONTEXT_REGISTRY`, move 0 MON, and
  begin with the selector of a state-changing function from their ABIs. One explicit exception:
  an `execute` to the sender itself with empty data is allowed **only** alongside an
  `eip7702Auth.address` of the zero address — that is how a user clears their delegation, and it
  needs no Mida call.
- **Bound what Monad bills.** Monad charges the gas *limit*, not gas used, so every gas field is
  capped: `callGasLimit` ≤ the largest per-kind ceiling in `packages/chain/src/gas.ts`
  (6,000,000), `verificationGasLimit`/`preVerificationGas` ≤ 500,000, paymaster gas fields ≤
  300,000 each, and both fee fields ≤ 500 gwei — a user operation names its own fee caps, and the
  paymaster is charged `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`, so an absurd priority
  fee would be paid in full.
- **Check the delegation story.** An `eip7702Auth` must name this chain (a chain-id-0
  authorization is valid on every chain and is refused) and an allowed implementation address —
  or the zero address for a delegation-clearing op. When no `eip7702Auth` is present — the field
  the bundler actually applies; an `authorization` field under any other name is validated but
  never substitutes — the sender's on-chain code (read via `RPC_URL`) must already be `0xef0100`
  + an allowed implementation. `factory`/`initCode` must be empty: a 7702 sender is never
  deployed by a factory.
- **Spend slowly.** Two D1 counters, incremented atomically on `eth_sendUserOperation` only: 30
  sponsored operations per sender per day and 2,000 globally (UTC days, both configurable). Over
  either limit is a refusal, and the sender budget is checked first so a spammy sender cannot
  drain the global one.
- **Keep the secrets.** The provider API key and the sponsorship policy id live in Worker
  secrets. A client-supplied `paymasterContext` is discarded and the configured `POLICY_ID` is
  injected by the Worker. Provider error bodies are scrubbed of every secret before they reach a
  client or a log.
- **Describe itself.** `GET /` returns the chain, the two registry addresses, the implementation
  allowlist, every limit, the method allowlist, and the one-sentence contract above.

**It cannot:**

- **Sign anything.** It holds no user key and no wallet; the user's signature arrives inside the
  user operation, and the provider — not this Worker — validates it on chain.
- **Become the sender.** `sender` is the user's own address end-to-end; the Worker never
  substitutes one, and the contracts keep seeing the real user's `msg.sender`.
- **Read or write your data.** It sees calldata only long enough to decode and check it; it holds
  no decryption key and touches no context ciphertext.
- **Sponsor anything but Mida calls.** No inner call can name a third contract, move MON, or run
  an unrecognised function — including inside a batch where the other calls are all valid. One
  bad call refuses the whole operation.

## Run your own

You need a Cloudflare account, `wrangler`, a Monad RPC endpoint, and a Pimlico (or Alchemy)
account with a sponsorship policy configured for chain `10143` and EntryPoint v0.8
`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`. Nothing secret or account-specific lives in
`wrangler.toml` — you supply the real values.

1. Create the D1 database and paste the printed `database_id` into `wrangler.toml` in place of
   `REPLACE_WITH_D1_DATABASE_ID`:

   ```
   wrangler d1 create mida-gas-sponsor          # NOT RUN — requires a Cloudflare account
   ```

2. Create the budget tables:

   ```
   wrangler d1 execute mida-gas-sponsor --file=schema.sql   # NOT RUN
   ```

3. Set `[vars]` in `wrangler.toml`: `CHAIN_ID` (`10143` for Monad testnet), the two registry
   addresses, `ALLOWED_IMPLEMENTATIONS` (the EIP-7702 smart-account implementations you trust —
   verify the address on-chain before listing it; `scripts/sponsor-probe.mts` exists to do
   exactly that), and optionally the budget limits.

4. Set the secrets — the provider key, the sponsorship policy id, and a chain RPC endpoint:

   ```
   wrangler secret put PROVIDER_KEY             # NOT RUN
   wrangler secret put POLICY_ID                # NOT RUN
   wrangler secret put RPC_URL                  # NOT RUN
   ```

   To point at a provider URL that already embeds its key, set `PROVIDER_URL` instead of
   `PROVIDER`/`PROVIDER_KEY`. For Alchemy, set `PROVIDER = "alchemy"` and `ALCHEMY_BASE_URL` in
   `[vars]` (Monad 7702 is allowlist-only there today; Pimlico is the default).

5. Deploy:

   ```
   wrangler deploy                              # NOT RUN
   ```

`NOT RUN` means exactly that: this code was verified end-to-end locally through Miniflare (the
same `workerd` runtime Workers uses, against a real SQLite D1 and a fake provider that records
requests), but no command was ever run against a real Cloudflare account or a live provider.

### Notes for operators

- **The policy id can never come from the client.** The Worker rebuilds `pm_*` params as
  `[userOp, entryPoint, chainId, context]` where the context is shaped per provider —
  `{sponsorshipPolicyId}` for Pimlico, `{policyId}` for Alchemy — from the `POLICY_ID` secret.
- **Logs are safe by construction.** One line per request: method, refusal rule (if refused),
  the first 10 characters of the sender, milliseconds. Never a request body, the API key, the
  policy id, a private key, or a full address or hash.
- **Budgets reset at midnight UTC**, matching how providers count daily sponsorship.
- **`nodejs_compat` is on, deliberately.** `@mida/chain` re-exports its local-anvil tooling
  (`node:child_process`/`node:fs`/`node:net`), so the bundler sees Node imports; the Worker only
  reads `GAS_CEILINGS` and the two ABIs and those paths never execute.
- **Check `GET /` after deploying.** It is the whole contract the endpoint makes with its
  callers — including the refusal rules, so an integrating team can see exactly what will be
  paid for before they send anything.
- **Alchemy is untested against the live service.** Monad 7702 is allowlist-only there and our
  request was unanswered at build time; the adapter is exercised against the provider interface
  only.
