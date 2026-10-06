# TrustLayer × Mida: a Mida agent that checks another team's registry before it pays (Oct 6, 2026)

**What happened, in one paragraph.** TrustLayer (github.com/Valorian0108/Trustlayer, another Monad Metropolis team)
runs a `DelegationRegistry` on Monad testnet: an owner records which agent may act for them, at which tier, until
when. Their builder EquationX agreed on Oct 6 to an integration. Mida built a small agent, kept in a new folder of a
clone of their repository (`integrations/mida/`, branch `mida-integration`; TrustLayer merged it into their `main` on Oct 6, PR #2). Before it does
anything it asks TrustLayer's registry whether the owner delegated to it. It then reads the owner's brief through Mida
(only a record the chain marks as owner-written counts), pays the amount if it fits the tier, and writes a receipt
record into Mida, authored by the agent. On Oct 6, between 17:09 and 17:30 WAT, Dami ran it live on Monad testnet:
it paid 0.01 MON once, refused to pay the same brief again, refused to act after the TrustLayer delegation was
revoked (before asking Mida anything), and refused after the agent was revoked in Mida while TrustLayer still said
yes.

**What it shows, and what it does not.** It shows a Mida agent gated by two independent permissions on Monad:
another team's registry for what it may *do*, Mida for what it may *know*. Each revoke stopped it on its own. It does
NOT show TrustLayer's team running it (they merged it on Oct 6 at 18:38 UTC, merge commit `15b1fe8`, without a
written review), their app or its Privy login (the
owner here is a plain key used with `cast`, because their app has no revoke), or their `AuthorizationVerifier` (its
zero-knowledge step stays simulated in their repo and is not called). TrustLayer cannot read the receipt: on chain
it can see that a receipt record exists, who wrote it and when, plus a hash of its encrypted content, but linking it
to the transfer needs the content. The check runs inside the agent, which holds its own key: nothing on chain forces
it, so it is as strong as the agent's code. Testnet only, not audited.

## The transactions

Every line below was read back from the chain by Claude on Oct 6, not taken from a message.
Registries: TrustLayer `DelegationRegistry` `0x088bc310c841fA5ed5b28F37050c3B419572b70d`; Mida `ContextRegistry`
`0x75fB6dB9af93A8d823e51c488CaA913ca711FB78`; Mida `CapabilityRegistry` `0xADFbeBC7A653E4287ae30c87D32D7aD647D7039b`.
Addresses: TrustLayer owner `0x24744964bD7a09D0578124BB0b5b58A60602671F`; agent wallet
`0x26C6Bdf6FF25aff4880fb338e9A3F009e0F14918`. The Mida side ran in a home made for it (`~/.mida-trustlayer`, its own
owner key), so a revoke there could not touch Dami's everyday agents.

| Step | Transaction | Block | What the chain shows |
|---|---|---|---|
| Mida: approve `trustlayer-agent` for the folder (sponsored) | `0x5781f3f5ece633cf814cb52e47e92c497a4c10fd7d2292760325ffd1eb40f8b9` | 68,733,472 | success; grant: `preferences.communication` READ, `projects.current` READ + CREATE + SUPERSEDE_OWN, `profile.skills` READ, until 2026-11-05 |
| Setup mistake: a delegation from the agent to itself (#29) | `0xc399e17285c743989364ff4c5575d2306ee6e5f7bd9059357f36980331bd7ebf` | 68,738,469 | `from` = agent; owner = agent = `0x26C6…4918`. Wrong key typed at the prompt; revoked at teardown (below) |
| TrustLayer: owner delegates to the agent, Routine, 24 h (#30) | `0x8f74ff5ee66fc6d8d634728f5e5941767a60de818ced543d3a6fae082136ab16` | 68,740,746 | `from` = owner; `checkAgentDelegation(owner, agent)` → `true, 30, 1` |
| Mida: the owner writes brief 1 (`preferences.communication`) | `0xbc283c37a0d0c554aa57069f3997b6fe21c38de61ab1569785311c5330d444c6` | 68,741,058 | `ContextRegistered`, record `0x9b58b755b0e29eba43acb47f08cc2a0346d7906cf67985dbd7d2a43852172aaf` |
| The agent pays 0.01 MON | `0x3eedcfdcbdb2c36ad0ae47242f571625d3c21d021e64b469a5896eb8379aeae6` | 68,741,501 | success; `from` agent, `to` owner, value 10,000,000,000,000,000 wei (0.01 MON), agent nonce 2 |
| Mida: the agent writes its receipt (`projects.current`) | `0xaae565b5936407058868d446a1d29f0bd226725430cdc37789d5169a4cc9169f` | 68,741,522 | `ContextRegistered`, record `0x547a8f2f67c3fa10bdc49fdc5cb7f31376984827a8587eaeb3bf9859cb82a0ca` |
| Re-run of the same brief | — | — | no transaction: the agent's nonce stayed at 3 (its three sends: #29, the owner's funding, the payment) |
| TrustLayer: owner revokes #30 | `0x9fd1634e0a99b937aa02bc83271689cf30b295256f2de48427695b9a81f2cb23` | 68,742,505 | success; `DelegationRevoked(30)` |
| Mida: the owner writes brief 2 | `0x1dfafee6c1fe51e6beafc1890577f783e4656a01bd6edb1a35eba4dcb589ded5` | 68,742,543 | record `0x372ccaae8b62c7d9724d90b412d8ff2fddbc2cc667758868bac6a2a985a2c0a4`; never paid |
| TrustLayer: owner delegates again (#31) | `0x6498611a37cc117b4b6539f36ca0378b22d73821f82ed6398b84fd0587c5b92f` | 68,742,698 | success. `cast` then lost its connection reading the block, so the command was run again… |
| …which created a duplicate (#32) | `0x187a44fe2b5c77a45b860293def49edccfc97dced2f01db74ab7c9215d87eb91` | 68,742,732 | success; both revoked at teardown |
| Mida: owner revokes `trustlayer-agent` (sponsored) | `0x66698ce35b866a983f650c64ad9cf4f6b60347fa6091bab4445e467854853710` | 68,742,813 | success; the new read key went to the other agent (the assistant) only |
| Teardown: owner revokes #31 | `0x3789f1e63a3fa36eb53ec5fa2a95bf78559c9863d187643415d585ad58f2e43a` | 68,743,877 | found by Claude in the registry's `DelegationRevoked` log |
| Teardown: owner revokes #32 | `0x8ac0bdb097bbcd09ca00466ce938436381b0de96197ab09968dafec081203622` | 68,743,944 | success (two later retries were refused at gas estimation, "Delegation already inactive": no transaction) |
| Teardown: the agent revokes #29 | `0x8a754f92712144e87134eba483bc8e314df0a02e19edfa9b29db4019efed0182` | 68,744,274 | success |

After teardown, read by Claude: `checkAgentDelegation(owner, agent)` → `false`; `checkAgentDelegation(agent, agent)` →
`false`. The agent's journal of signed payments holds one entry, brief 1, marked receipted, mode 600. Not recorded
during the run: the hash of the agent's 0.3 MON funding transfer to the owner (the agent's nonce 1).

## What the agent printed

Approve check (the SDK, before any money):

```
midad: answering — pid 12267, up since 2026-10-06T16:31:16.274Z, queue 0 — socket in .mida-trustlayer
trustlayer-agent: approved for this folder
```

Dry run, real run, and the re-run a minute later:

```
trustlayer: delegation #30 from 0x2474…671F to 0x26C6…4918 — tier Routine ($50), expires 2026-10-07T17:09:18.000Z
midad: answering — pid 12267, up since 2026-10-06T16:31:16.274Z, queue 0 — socket in .mida-trustlayer
trustlayer-agent: approved for this folder
mida: trustlayer-agent approved; brief 0x9b58b755… (owner, 2026-10-06T17:11:28.813Z): transfer 0.01 MON to 0x2474…671F
decision: 0.01 MON is within the Routine auto-execute cap (50 MON). Sending.
dry run: nothing sent, nothing written.

trustlayer: delegation #30 from 0x2474…671F to 0x26C6…4918 — tier Routine ($50), expires 2026-10-07T17:09:18.000Z
mida: trustlayer-agent approved; brief 0x9b58b755… (owner, 2026-10-06T17:11:28.813Z): transfer 0.01 MON to 0x2474…671F
decision: 0.01 MON is within the Routine auto-execute cap (50 MON). Sending.
sent: 0.01 MON to 0x2474…671F — tx 0x3eedcfdcbdb2c36ad0ae47242f571625d3c21d021e64b469a5896eb8379aeae6 (block 68,741,501)
recorded: Mida receipt 0x547a8f2f… (anchored) in projects.current, author trustlayer-agent

trustlayer: delegation #30 from 0x2474…671F to 0x26C6…4918 — tier Routine ($50), expires 2026-10-07T17:09:18.000Z
mida: trustlayer-agent approved; brief 0x9b58b755… (owner, 2026-10-06T17:11:28.813Z): transfer 0.01 MON to 0x2474…671F
already done: receipt 0x547a8f2f… for brief 0x9b58b755… exists (tx 0x3eedcfdcbdb2c36ad0ae47242f571625d3c21d021e64b469a5896eb8379aeae6). Nothing was sent.
```

After the TrustLayer revoke (brief 2 written), exit 2, no call to Mida:

```
trustlayer: no valid delegation from 0x2474…671F to 0x26C6…4918 on the DelegationRegistry (revoked, expired or never created). Nothing was sent.
exit 2
```

After a new delegation and the Mida revoke, exit 3 while TrustLayer still says yes:

```
trustlayer: delegation #31 from 0x2474…671F to 0x26C6…4918 — tier Routine ($50), expires 2026-10-07T17:19:23.000Z
mida: refused (revoked) — Mida: trustlayer-agent's access was revoked by the owner — nothing was read. Nothing was sent.
exit 3
```

## Limits, in the same breath

- Testnet only; not audited. The amounts are testnet MON, with 1 MON standing in for 1 USD against TrustLayer's tier caps.
- The TrustLayer check runs inside the agent, which holds its own key. **The run itself showed why that matters:** the
  setup mistake created a delegation from the agent to itself (#29). Had `.env` named the agent as the TrustLayer
  owner, the agent would have passed the check on its own delegation. The check is only as strong as the owner
  address the agent is configured with.
- Revokes are forward-only: brief 1 stays read and its payment stays sent; brief 2 stayed unpaid because both revokes
  came before it.
- TrustLayer can see the receipt record exists, its author and time, and a hash of its encrypted content; it cannot read
  it or link it to the transfer from the chain alone.
- The code: 33 commits, three adversarial reviews and three fix rounds before this run. 124 tests, all with simulated
  chain and Mida calls; this run is the first against the real ones. A later commit adds the owner-address limit
  above to the integration's README.
