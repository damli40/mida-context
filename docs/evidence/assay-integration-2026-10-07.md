# ASSAY × Mida: a model's answer saved with proof of who served it and who saved it (Oct 7, 2026)

**What happened, in one paragraph.** ASSAY (github.com/trudransh/Assay, built by Rudransh, another Monad Metropolis
team) runs a model host on Monad testnet that signs a receipt for every answer: which model, which host, and a
sealed fingerprint of the prompt and the answer. It anchors (records) each receipt on Monad through its
`ReceiptAnchor` contract. On Oct 6 the two teams agreed one line: "assay proves which model and host produced a
response, mida proves which agent saved what, for whom, and who may read it". ASSAY built the check
(`checkRecord` in its SDK, plus `examples/mida-context/check.mts`). Mida built the small program that produces a
record for that check, kept in a new folder of a clone of their repository (`examples/mida-context/mida/`, branch
`mida-integration`). On Oct 7, between about 19:30 and 21:15 WAT, it ran live on Monad testnet: a Mida agent the
owner approved asked ASSAY's host one prompt, saved the receipt and its opening key inside one encrypted Mida
record after ASSAY's own check passed with the chain read on, a second approved Mida agent read the record and
checked it again, **ASSAY's own unchanged `check.mts` accepted the exported record ("ok … anchored on Monad")**,
and after the owner revoked the second agent its next read was refused while the receipt stayed valid.

**What it shows, and what it does not.** It shows two independent proofs about one answer on Monad: ASSAY's for
which host and model produced it, Mida's for which agent saved it, for which owner, and which agents may read it.
It shows the revoke stopping the reader on its own. It does NOT show ASSAY's team running our program or reviewing it (our half is a draft
pull request on their repository, opened Oct 7, not yet reviewed or merged), a receipt proving which model weights ran (a
receipt proves which host served which bytes and what the host claimed), or anything on mainnet. ASSAY's team
cannot read the Mida record: on chain they can see that a record exists, who wrote it and when, plus a hash of
its encrypted content. Anyone can register as an ASSAY host, so the reader trusts only the hosts named in its own
settings (here `erc8004:10143:1962`). Testnet only; Mida is not audited.

## The run

Owner commands were typed by Dami (a Mida home made for this, `~/.mida-assay`, batching off). Agent commands were
run by Claude in `examples/mida-context/mida/` at commits `dddd7e1` (steps 1 to 6) and `4bd356b` (steps 7 to 10).

| # | Step | Result |
|---|---|---|
| 0 | Owner: init, `add-agent assay-writer`, `add-agent assay-reader`, request and approve both in this folder | approvals `0xa5ade2d4f92765ed18b0a313778e4aa5214d3329e59e411fdf0c495ed9e33ee5` and `0xda9830d043e03c2311def04fc241940f3034d7385299c764a0bb8f9f1ed73d07`, project `b30f0e1f-1231-4e5a-a54a-024fd6988017` |
| 1 | `ask "Say OK"`, first try | the host's model provider answered HTTP 500; our program printed "the host answered HTTP 500 and signed no receipt. Nothing was saved." (exit 4) |
| 2 | `ask "Say OK"`, second try | receipt `0x038787f28cee1d7dee5687ccc4b00472a4df88e571f7baddd66e62cd99daa941` from host `erc8004:10143:1962`, model `gemma-4-31b-it`; private run file written, owner-only (mode 600) |
| 3 | `write <hash>`, at once | refused: "not anchored yet (the host says pending). Nothing was written." (exit 2) |
| 4 | `write <hash>`, 20 s later | "check passed"; Mida record `0xa7bb3afc…` saved, anchored, author `assay-writer` (exit 0) |
| 5 | `read` | "accepted: host erc8004:10143:1962 (trusted) served model gemma-4-31b-it; the salt opens the commitments", with the answer (exit 0) |
| 6 | `export`, then ASSAY's `npx tsx examples/mida-context/check.mts <file>` with the chain read | file written mode 600 in the gitignored `exports/`; **ASSAY's checker: "ok: erc8004:10143:1962 served this output to this prompt (gemma-4-31b-it), anchored on Monad. Use the context."** (exit 0) |
| 7 | Repeat cases | `write` again: "already recorded … Nothing was written." (exit 0); `export` again: "already exists — the file is never overwritten" (exit 2); `read` of a hash nobody saved: refused (exit 2) |
| 8 | Owner: `mida revoke assay-reader` | typed by Dami: "revoked assay-reader on chain (sponsored)", tx `0x148766cf57ca6e94973d8f0959e265049e85aa9e82f029a296dd42230369868b` |
| 9 | `read` and `export` after the revoke | "mida: refused (revoked) — … Revoking stops future reads; it cannot recall what this agent already read." (exit 3, both); no new file |
| 10 | After the revoke: `write` again as the writer, and ASSAY's `check.mts` on the step-6 file | writer still approved, "already recorded" (exit 0); ASSAY's checker still "ok … anchored on Monad" (exit 0): the receipt is as valid as before |

Read back from the chain by Claude on Oct 7 (public RPC, `eth_getTransactionReceipt`), not taken from a message:

- ASSAY's anchor transaction for this receipt: `0x223217056a5e512805eb8a623b03f91dbd39fabb3aafc4cbd80dee1c7cc9864d`,
  status 1, block 69042977, sent to `ReceiptAnchor` `0x63e4F42E6d254ed6aAE735F9F4169BbFd12c1a24`; Merkle root
  `0x01a64d6869425b69e02e5178e7c75e9ef6b34aeddf43017b00f2bad2ee67b15f` (a one-receipt batch, so the proof is empty).
- The two approvals in step 0: both status 1, blocks 69041802 and 69042187.
- The revoke in step 8: status 1, block 69048822, sent to the same address as the approvals
  (`0x4337084d9e255ff0702461cf8895ce9e3b5ff108`, the sponsored-transaction entry point), 10 log entries. It is
  5,845 blocks after the anchor, so the accepted read (step 5) came before it and the refused read (step 9) after.

Not read back: the Mida record's own anchor transaction (the program prints only the record id).

## Reviews before anything was pushed

Three independent reviews, each told to make the package accept a forged record. None managed it on `write` or
`read`. What they found and what was fixed:

1. **Review 1** (before the rework landed): the owner's run would have stopped three times before saving anything
   (an empty settings value, a shortened hash, a missing tool). Fixed by Devin, commits `79d4642..9ba306d`.
2. **Review 2** (Oct 7): `export` skipped the check; a refused record could print a fake "accepted:" line through a
   line break; changing only the chain number kept testnet's contract address and connection; the README had no
   install step. Fixed by Claude, commits `46ba3e4`, `dddd7e1`.
3. **Review 3** (Oct 7, of the review-2 commits): `ask` still printed host text raw, and most of the one-line fix had
   no test, although the commit message said it had. Fixed in `4bd356b`, with a test at each place; 16 fixes were
   undone one at a time in a scratch copy and each was caught by at least 3 tests.

Tests at `4bd356b`: 158 passed (`npm test`), including two that run the reader against ASSAY's real `checkRecord`
with the chain read on (a fake chain answering yes or no).

**Noted about ASSAY's checker:** `check.mts --offline` (and `checkRecord` with `offline: true`) skips the chain
read, so on its own it is not acceptance: a record signed with a made-up key that names a trusted host passes it.
It is meant for CI on a known fixture. We told ASSAY's builder on Oct 7. Our program never uses it, and our README
there says not to treat an offline pass as acceptance.

**Known and left as is:** the pinned `@mida-context/sdk` 0.1.4 was published Oct 4 (three days old, under the
house seven-day rule; it is Mida's own package). The program does not ask the RPC which chain it is; the receipt's
fingerprint covers the host id, which names the chain, and the reviewer found no way to exploit it.

## Where things are

- Code: branch `mida-integration` at `4bd356b` on `github.com/damli40/Assay` (Dami's fork), opened Oct 7 as a draft
  pull request on ASSAY's repository: https://github.com/trudransh/Assay/pull/6. 26 commits on top of ASSAY's main,
  29 files, all under `examples/mida-context/` (four lines appended to their README there). Not yet reviewed or
  merged by ASSAY.
- Private files, never committed: `runs/`, `exports/`, `.env`, `.mida/` in that folder (all gitignored; the first
  two hold the salt of the test receipt).
- Diagram: `docs/architecture/mida-assay.{excalidraw,svg,png}`.
