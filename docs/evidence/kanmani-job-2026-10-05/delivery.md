# Second reader: 10 Kanmani payment claims rechecked (Oct 5, 2026)

- Job `0xecc47037e843c5052e2a68c953660f976f29ff3198a758a52798930a9adc67ac` on escrow `0xd75f7786D0DD42c8F161Bd78E87D37001044Fc32` (Monad mainnet), termsHash = brief record `0xd9d35dc2c50055f8054b6c7a3b36fc447f6118ac5e2a4f76a7c53920cdcb9007`.
- Findings record `0xf7d4bf13d153fba4ee6d59ac4a33a79eac2cfd5327c012fb716e726013420891`, registered on Monad testnet in tx `0xdbf90ce9caeaed23abbe3ed551235920428d24d2e56f339c11a59fc8b3c318a6` (block 68,453,290) by agent `kanmani-auditor`; same owner, author and area as the brief. The record holds the content of `delivery-final.json`.
- Claims reported: 10. Found 2, not found 8, could not check 0. All 10 evidence documents match the hash committed on Monad.

Each claim: the hash committed on Monad mainnet was read from the recording transaction's own logs; the evidence document was downloaded and hashed (keccak256); the cited transaction was looked up with eth_getTransactionByHash on 31 chains (each chain id read from its RPC), and every chain's head block at that moment is recorded.

## 143_10180_0x103040545AC5031A11E8C03dd11324C7333a13C7_2
- verdict: **not-found** — the evidence comment says it was paid on SKALE; not on the 4 SKALE mainnet chains searched (Europa, Calypso, Nebula, Titan). SKALE runs many chains and the one used is not identified, so this not-found is not final for SKALE
- cited transaction: `0xea439ee64fcad0fe33e080e0a018bc9b475be2fb64d9f0f1b17535e176437279` (declared network: monad)
- evidence: 814 bytes, keccak256 `0x604ff60fdd8d06b62c3dda85a210a7324fec9dbafafdc68d9a08f8960d36bec8`, matches the hash in recording tx `0xa1910ac89e365a0c171f5fbdc74c70386e81d0a803ddba9b2b0953bd8271e641` (block 98243979): yes
- searched: not found on 31 chains; checked 2026-10-05T15:33:14Z

## 143_10180_0x103040545AC5031A11E8C03dd11324C7333a13C7_7
- verdict: **not-found**
- cited transaction: `0xb9883954b2ec5fc8e1eaea09dd2301351e5b936dc373a1350d467389818138a6` (declared network: monad)
- evidence: 793 bytes, keccak256 `0x0e354453e44c2365e2a22fb8c37ddd35e8be07ce7a951e28496912d0192365a5`, matches the hash in recording tx `0x4342b985367976780327fc7fb2c5a4a82cd84cf3678bf79a136b52470504d0d7` (block 98675049): yes
- searched: not found on 31 chains; checked 2026-10-05T15:33:21Z

## 143_10181_0x103040545AC5031A11E8C03dd11324C7333a13C7_10
- verdict: **not-found** — the evidence comment says it was paid on SKALE; not on the 4 SKALE mainnet chains searched (Europa, Calypso, Nebula, Titan). SKALE runs many chains and the one used is not identified, so this not-found is not final for SKALE
- cited transaction: `0xe9e56d60d6da5f0de72e9fcdeae7b74a4c9b0bb6dddbb1b85b8081b41605958c` (declared network: monad)
- evidence: 657 bytes, keccak256 `0xd777c3bfa7448f3c05be9d238a2ad6ec4120782acf044bbc80fbe62eb5cb1661`, matches the hash in recording tx `0x938b015d824100a2726f5654710b0e83b96bf6735d43ae59a87b5955d1f67bb3` (block 94834884): yes
- searched: not found on 31 chains; checked 2026-10-05T15:33:45Z

## 143_10181_0x103040545AC5031A11E8C03dd11324C7333a13C7_11
- verdict: **not-found**
- cited transaction: `0x71fbe8a5e69c3f2b2edc8097869704e64019a9f110025c42611bfb610f438f00` (declared network: monad)
- evidence: 650 bytes, keccak256 `0xf71bebda2506c22722e41592b55450f10428d2a2397f849f56330d143691e26c`, matches the hash in recording tx `0x5830b8acdfdccd1b656a861bd6a4bcd71d8fad37116e3e1fb515ba997f103e6f` (block 94836762): yes
- searched: not found on 31 chains; checked 2026-10-05T15:33:51Z

## 143_10182_0x09C32b8FC0a94A1EeD424499A42180e29667bEeE_4
- verdict: **found** — found on celo (chain 42220) block 75452874; the evidence declares monad
- cited transaction: `0x75d464eb1880e3eb2e3c7526c2e2f89d7cfd21f1fc67041b13f8d066fae3730a` (declared network: monad)
- evidence: 936 bytes, keccak256 `0x55b42c779e84b0c686063e0c8416864776d737a4c3c18605eef40451c79a1439`, matches the hash in recording tx `0xbe58d124434fa31f97f36329a8042575ef27d951312ae4ec4c7373d2e6c0e1cb` (block 108546342): yes
- searched: not found on 30 chains, found on celo; checked 2026-10-05T15:34:15Z

## 143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_4
- verdict: **found** — found on celo (chain 42220) block 75452874; the evidence declares monad
- cited transaction: `0x75d464eb1880e3eb2e3c7526c2e2f89d7cfd21f1fc67041b13f8d066fae3730a` (declared network: monad)
- evidence: 813 bytes, keccak256 `0x6ccb3db94597287100b5b30af2cc6b973bbd1af82bf828f324a81bb2db1a243a`, matches the hash in recording tx `0x6d33b7722c1e585bcb9d7a37e8471b84164949668e124d814287b1393f4038f5` (block 98034546): yes
- searched: not found on 30 chains, found on celo; checked 2026-10-05T15:34:39Z

## 143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_30
- verdict: **not-found**
- cited transaction: `0x312608e3ad434c0209803e125dd27005c59a5548a30284e6a8e67cf2dfb492cc` (declared network: monad)
- evidence: 929 bytes, keccak256 `0x98aa80b9911cf5a2e5cac32e2a1d97990bf2fc155020e6577fa26911252349fc`, matches the hash in recording tx `0x205f1d06384a01edfada535e5e35c9ca63512c96ee65e5aa6a92643649caf31f` (block 100914979): yes
- searched: not found on 31 chains; checked 2026-10-05T15:35:03Z

## 143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_33
- verdict: **not-found**
- cited transaction: `0xd20d2685e75ea1182aaf618c4f51b2a6e8afa0e511afae48536e4ca6655ad86d` (declared network: monad)
- evidence: 933 bytes, keccak256 `0xf207557837641726bb1c8869f585d6f46a0879ede960fa4ba21f91ac55bac7a0`, matches the hash in recording tx `0x67c98ca7c63e93bdd821b761892b0382089c8f61aa984a7c74883b311469a503` (block 101709542): yes
- searched: not found on 31 chains; checked 2026-10-05T15:35:10Z

## 143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_36
- verdict: **not-found**
- cited transaction: `0xa9f11fbeadcd6d99b460ece6aa4f6ec2fae1a22a487c367611e2dc68354c6fb2` (declared network: monad)
- evidence: 929 bytes, keccak256 `0x533c639e2f59b5c39f7b9bd5ac62834980f9f9ac03709b29c65c6cacba2c44e1`, matches the hash in recording tx `0x5e9cb06762762cfa0d7feb415a9be49b9babd1e9406a1f429f847f23906c357f` (block 102842416): yes
- searched: not found on 31 chains; checked 2026-10-05T15:35:18Z

## 143_10221_0x103040545AC5031A11E8C03dd11324C7333a13C7_1
- verdict: **not-found**
- cited transaction: `0x5055ee69f321b1defb1bf0dd60c53d9f18d2dbcf700e3099609927980312f8c2` (declared network: monad)
- evidence: 929 bytes, keccak256 `0x15a67672780960d5c335282cbbf3599600e3f48a576a849adb83e2901912c553`, matches the hash in recording tx `0x889e09b443bb43257e2a4b570c4f319fa98ede24d1a876b0467af0c397f95eb2` (block 103431194): yes
- searched: not found on 31 chains; checked 2026-10-05T15:35:41Z

## Across the 10

- 2 found (both on Celo), 8 not found, 0 could not check. Every evidence document matches the hash committed on Monad.
- `0x75d464eb18…` is cited by 2 claims (4499A42180e29667bEeE_4, C03dd11324C7333a13C7_4). On Celo it is one USDC payment of 0.020 split 0.0174 to 0x09C3…EeE (the author of one claim) and 0.0026 to 0xc237…938e: it reads as one job paid once, rated from two sides, not two payments.
- Chains searched (31): monad (143), monad-testnet (10143), ethereum (1), base (8453), optimism (10), arbitrum (42161), polygon (137), bsc (56), avalanche (43114), linea (59144), scroll (534352), gnosis (100), celo (42220), blast (81457), mantle (5000), unichain (130), sonic (146), zksync-era (324), sei (1329), hyperevm (999), skale-europa (2046399126), skale-calypso (1564830818), skale-nebula (1482601649), skale-titan (1350216234), sepolia (11155111), base-sepolia (84532), arbitrum-sepolia (421614), optimism-sepolia (11155420), polygon-amoy (80002), bsc-testnet (97), avalanche-fuji (43113)
