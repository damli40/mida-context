# Kanmani job: a Mida agent hired, paid and revoked (Oct 5, 2026)

**What happened, in one paragraph.** Kanmani (kanmani.xyz) runs an escrow for agent jobs on Monad mainnet. Its
founder, Asuran, hired a Mida agent to recheck 10 payment claims that Kanmani's own verifier could not find on any
chain (the claims live at https://kanmani.xyz/claims). The job's brief and the agent's findings were both Mida
records, written by that agent. The escrow's `deliver()` call pointed at the findings record. Kanmani checked the
record on chain, paid 0.50 USDC for the 10 claims, and Dami then revoked the agent. Kanmani was the buyer; Mida's
agent did the work.

**What it shows, and what it does not.** Another team used a Mida record as the deliverable of a paid job: the
record's existence, its author (the job agent) and its time are on chain, and the payment points at it. Kanmani
could NOT read the record: letting another team's app read a Mida record (Sign in with Mida) is not shipped, so it
received the findings as a file, and "the file matches the encrypted record" rests on Dami's word. Mida's records are
on Monad testnet; the escrow and the payment are on Monad mainnet. Not audited.

## The transactions

Every line below was read from the chain by Claude on Oct 5, not taken from a message.

| Step | Chain | Transaction | What the chain shows |
|---|---|---|---|
| Brief record written by the job agent | Monad testnet (10143) | `0xb0cb606016e13ac45a329c7d0ec29dbe6344ae3c678fecb803b70b5286e457d3` (block 68,442,389) | Record `0xd9d35dc2c50055f8054b6c7a3b36fc447f6118ac5e2a4f76a7c53920cdcb9007`, created 15:55:00 UTC, author = agent `kanmani-auditor` (`0xb5d9…78fd`), owner `0x01de…d6bc` |
| Job funded by Kanmani | Monad mainnet (143) | `0x10950f2e35f241ec01de5d6dbdef65756b0025f924605bad2ca68ddf6182f571` (block 110,802,186) | Escrow `0xd75f7786D0DD42c8F161Bd78E87D37001044Fc32`, job `0xecc47037e843c5052e2a68c953660f976f29ff3198a758a52798930a9adc67ac`; agent `0xD68937ed886243bf5A44Bb0A9338Ee91bB8D2016`; USDC, ceiling 0.50, 0.05 per claim; deadline 2026-10-08 16:39:46 UTC; termsHash = the brief record; 0.50 USDC moved into the escrow |
| Findings record written by the job agent | Monad testnet | `0xdbf90ce9caeaed23abbe3ed551235920428d24d2e56f339c11a59fc8b3c318a6` (block 68,453,290) | Record `0xf7d4bf13d153fba4ee6d59ac4a33a79eac2cfd5327c012fb716e726013420891`, created 16:49:54 UTC; same owner, author and area as the brief |
| Delivery, signed by Dami from the agent address | Monad mainnet | `0x24a69e44eb6eab7fac8f321f8e4121b515e42a8240b8caf98cb8456c0944f49c` (block 110,806,856, 17:03:23 UTC) | The escrow logs the job with the findings record. Before sending, an eth_call dry run from any other address reverted `NotAgent`; after it, a second delivery reverts `WrongState` |
| Settlement by Kanmani | Monad mainnet | `0x89dc80d4d64c9f4334c486ffdc4429c530282b24eed6f1eeeaec5fc4abb01d8b` (block 110,808,567) | 0.50 USDC from the escrow to the agent; the settle event logs 10 units paid, 0 refunded |
| Agent revoked by the owner | Monad testnet | `0xb3918ef7882808f8de196954122baeb0fa3fa6b0e25b007fe514fafa4484323d` (block 68,459,464) | CapabilityRegistry: owner `0x01de…d6bc` revokes `0xb5d9…78fd` and rotates the read key of its 3 areas. The findings record still exists afterwards |

Registry: ContextRegistry `0x75fB6dB9af93A8d823e51c488CaA913ca711FB78` (testnet). The job ran in a Mida home made for
it (`~/.mida-kanmani`, its own owner key), so an expiry or revoke there could not touch Dami's own agents.

## The findings

10 claims rechecked (method: the hash committed on Monad mainnet was read from each recording transaction's logs; each
evidence document was downloaded and keccak256-hashed; each cited transaction was looked up on 31 chains, each chain's
id read from its RPC, with the head block recorded):

- All 10 evidence documents match the hash committed on Monad.
- 2 found, both on Celo: both claims cite one transaction (`0x75d464eb…730a`, block 75,452,874), one 0.020 USDC payment
  split 0.0174 and 0.0026. Their evidence says Monad, so they name the wrong network; they are not missing payments.
  Asuran checked this on Celo independently, and said Kanmani's verifier will add Celo and re-run the 10.
- 8 not found on 31 chains. 2 of the 8 say they were paid on SKALE; only 4 SKALE chains were searched, so those 2 are not
  final for SKALE.

## Sources

- In `kanmani-job-2026-10-05/` next to this file: `delivery-final.json` (the findings record's content, as sent to
  Asuran), `delivery.md` (the same, readable), `findings.json` (the raw recheck output, every chain and head block) and
  `recheck.py` (the script that produced it). The brief record holds Kanmani's job section in Asuran's words; it is not
  republished here.
- Asuran's messages (funding, settlement, and the statement that Kanmani's README lists the job with these
  transactions and our caveats) were pasted into the session by Dami. Kanmani's README itself was not checked by Claude.
