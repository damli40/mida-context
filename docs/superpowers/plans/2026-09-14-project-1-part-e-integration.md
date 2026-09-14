# Project 1 Plan — Part E: Integration (Tasks 21–28)

> Read `2026-09-14-project-1-protocol-core.md` first. Its Global Constraints and "Decisions" sections apply to every task here. Part E consumes Parts A, B, C and D by the exact names those files define.
>
> **How this part was verified.** Parts A–D were assembled mechanically from their plan files into a fresh repository: 191 Vitest tests and 139 Foundry tests passed, `tsc` exited 0, and the real `POLICY_HASH_V1` matched Part C. Every Part E file below was then built and run in that repository through Task 26, including the full §16 scenario against local Anvil and the prague fallback path. Each code block in this part is generated from the exact file that ran. Task 27 needs funded Monad testnet keys and has **not** been run.

## Decisions this part makes where the spec is silent

These bind the executor. Report any disagreement before implementing.

1. **Agent API requests name their exact capability.** Reads, writes and wrap fetches carry a `capabilityId`. §12.1 step 3 then loads that one capability; the API never searches an agent's capabilities on its behalf.
2. **Two clocks, each for one job.** Capability expiry and write deadlines use the latest block timestamp, with the same inclusive boundary as Part D (`now >= expiresAt` is expired). Wall-clock time is used only for HTTP request freshness (±60 seconds) and the five-minute cancellation window.
3. **The deny overlay targets a capability or a whole owner–agent relationship.** An intent anchors when Monad shows that capability revoked, or the owner–agent epoch above its value when the intent was recorded. Once anchored it stops blocking, because the chain already does. Nothing ever expires an active deny.
4. **The cancellation nonce is returned by `POST /revocations`.** No extra route exists. A successful cancellation consumes it.
5. **The FakeVault's PRF output is `HMAC-SHA256(seed, domain salt)`**, the same shape as a real authenticator PRF. There is no function that returns a global root.
6. **`approveGrant` pins the network.** A request for another chain or registry fails with `INVALID_WIRE` before advice is computed (Part C's handoff). After a grant, the Vault publishes wraps for every current and historical epoch of every READ scope it granted.
7. **The FakeVault checks every derived epoch key against the published key** and throws `COMMITMENT_MISMATCH` on a difference. This is the §11.1 recovery-mismatch detector.
8. **The Vault depends on a port, not on the API package.** `VaultContextApi` (Task 22) is implemented structurally by `ContextApiClient` (Task 24), so dependencies point one way.
9. **Every contract write simulates first**, so a revert surfaces as a named error mapped to a protocol code. A receipt with status `reverted`, for example a Monad reserve-balance revert after inclusion, is an error.
10. **Local deployments are serialized with a directory lock**, because `Deploy.s.sol` always writes `deployments/31337.json` and test files run in parallel.
11. **SDK access requests live 300 seconds.** Completion is not refused after `requestExpiresAt`, because the contract already enforced the window when the grant was mined. Consumed request IDs are kept for the life of the process.
12. **The SDK checks evidence on read.** It recomputes `evidenceCommitment` from the revealed references (`bytes32(0)` means none) and requires every referenced record to exist for the same owner.
13. **API persistence is `FsStorage` plus JSON files, including the replay record.** Every accepted `(signer, nonce, timestamp)` is written to `replay-nonces.json` in the data directory, atomically and before authentication returns, so a restart or crash inside the 60-second window cannot accept a replay (§12.1). Entries whose signed timestamp is more than 60 seconds old are pruned. An unreadable replay file fails closed instead of starting empty.
14. **Unexpected API errors fail closed** with HTTP 500 and code `CAPABILITY_DENIED`, never a stack trace or an allow.
15. **`provisionAgent` and `buildSignedAccessRequest` are fixtures** exported by `@mida/fake-vault` for Tasks 22–26. The production request path is `MidaAgent.createAccessRequest` (Task 25).
16. **The Monad testnet run generates every actor** and funds each one from a single `DEPLOYER_PRIVATE_KEY`, so only one address needs faucet funds.
17. **One shared assertion adapter, in `@mida/protocol`.** It holds `P256_N`, `normalizeP256LowS` and `toWebAuthnAuthStruct`, with no FakeVault, ox or browser dependency, so Project 2's real passkey adapter imports exactly the same normalization (spec §10.4, §15). The FakeVault builds metadata and the signing digest with ox `WebAuthnP256.getSignPayload({ hash: true })`. It signs that digest with `@noble/curves` `p256`, deliberately allowing either `s`. It converts through the shared adapter and refuses any result that ox `WebAuthnP256.verify` rejects (spec §8). Part D's fixture generator (`export-webauthn-fixture.ts`) still signs with ox `P256.sign` and normalizes inline; it only produces a test vector and is not an assertion adapter.

---

### Task 21: `@mida/chain`: ABIs, network config, chunked logs, owner history

**Depends on:** Parts A–D complete; `cd contracts && forge build` succeeds.

**Files:**
- Create: `packages/chain/package.json`, `packages/chain/scripts/gen-abis.mjs`
- Create: `packages/chain/src/deployment.ts`, `packages/chain/src/logs.ts`, `packages/chain/src/history.ts`, `packages/chain/src/registry.ts`, `packages/chain/src/writes.ts`, `packages/chain/src/local.ts`, `packages/chain/src/index.ts`
- Create (generated, committed): `packages/chain/src/abis.ts`
- Modify: root `package.json` (dependency `"@mida/chain": "workspace:*"`, script `chain:abis`)
- Test: `packages/chain/test/chain.test.ts`, `packages/chain/test/local.test.ts`

**Interfaces:**
- Consumes: Part A `MidaError`, `assertHex`, `agentId`, `agentRegistrationTypedData`, `canonicalizeOrigin`, `originHash`, types `Address`, `Hex`, `AgentRecord`, `OwnerAgentHistory`, `MidaErrorCode`; Part C `POLICY_HASH_V1` (test only); Part D `contracts/out/{CapabilityRegistry,ContextRegistry}.sol/*.json` and `contracts/deployments/<chainId>.json`.
- Produces, `abis.ts`: `capabilityRegistryAbi`, `contextRegistryAbi` (`as const`).
- Produces, `deployment.ts`: `interface Deployment { chainId: bigint; capabilityRegistry: Address; contextRegistry: Address; deploymentBlock: bigint; policyHashV1: Hex; vaultRpId: string; vaultRpIdHash: Hex }`, `LOCAL_CHAIN_ID = 31337n`, `MONAD_TESTNET_CHAIN_ID = 10143n`, `DEFAULT_DEPLOYMENTS_DIR`, `parseDeployment(json: unknown): Deployment`, `loadDeployment(chainId: bigint, directory?: string): Deployment`, `chainFor(chainId: bigint): Chain` (viem `foundry` or `monadTestnet` only).
- Produces, `logs.ts`: `MAX_LOG_BLOCK_RANGE = 100n`, `interface BlockWindow`, `blockWindows(fromBlock, toBlock, size?): BlockWindow[]`, `interface DecodedLog`, `interface LogClient`, `getLogsChunked(client: LogClient, parameters: { address; event: AbiEvent; args?; fromBlock: bigint; toBlock?: bigint }): Promise<DecodedLog[]>`.
- Produces, `history.ts`: `ownerHistory({ client: LogClient; deployment; owner; agentId; toBlock? }): Promise<OwnerAgentHistory>`.
- Produces, `registry.ts`: `interface ChainContext { publicClient: PublicClient; deployment: Deployment }`, `REVERT_CODES`, `revertNameFromData(data: Hex)`, `revertName(error: unknown)`, `toMidaError(error: unknown): unknown`, `readAgentRecord(context, agentId): Promise<AgentRecord>`, `latestTimestamp(context): Promise<bigint>`.
- Produces, `writes.ts`: `interface WriteContext extends ChainContext { walletClient; account }`, `interface LocalWriteContext extends WriteContext { account: LocalAccount }`, `createWriteContext({ rpcUrl; deployment; account: LocalAccount }): LocalWriteContext`, `sendContract(context, { address; abi; functionName; args }): Promise<TransactionReceipt>`, `registerAgent(context, { agentSalt; signer: LocalAccount; encryptionPublicKey; callbackOrigin; capabilityManifestHash }): Promise<{ agentId: Hex; receipt: TransactionReceipt }>`.
- Produces, `local.ts` (development only, never used against a real network): `FOUNDRY_BIN`, `CONTRACTS_DIR`, `ANVIL_PRIVATE_KEYS`, `interface LocalNode { rpcUrl; hardfork; stop() }`, `startAnvil({ hardfork? }): Promise<LocalNode>`, `deployLocal({ rpcUrl; privateKey? }): Promise<Deployment>`, `fundLocal(rpcUrl, address, wei?)`, `increaseLocalTime(rpcUrl, seconds)`.

- [ ] **Step 1: Create the package and generate the ABIs**

`packages/chain/package.json`:
```json
{
  "name": "@mida/chain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@mida/protocol": "workspace:*",
    "viem": "2.56.3"
  }
}
```

`packages/chain/scripts/gen-abis.mjs`:
```js
// Regenerates packages/chain/src/abis.ts from Foundry build artifacts.
// Usage (from the repository root, after `cd contracts && forge build`): pnpm chain:abis
import { readFileSync, writeFileSync } from "node:fs"

const root = new URL("../../../", import.meta.url)
const abiOf = (name) =>
  JSON.parse(readFileSync(new URL(`contracts/out/${name}.sol/${name}.json`, root), "utf8")).abi

const capability = abiOf("CapabilityRegistry")
const context = abiOf("ContextRegistry")
const source = `// GENERATED by packages/chain/scripts/gen-abis.mjs from contracts/out. Do not edit by hand.
// Regenerate with \`pnpm chain:abis\` after any contract change.
export const capabilityRegistryAbi = ${JSON.stringify(capability, null, 2)} as const

export const contextRegistryAbi = ${JSON.stringify(context, null, 2)} as const
`
writeFileSync(new URL("packages/chain/src/abis.ts", root), source)
console.log(`abis.ts <- CapabilityRegistry (${capability.length} items), ContextRegistry (${context.length} items)`)
```

Add to the root `package.json` `"dependencies"`:
```json
    "@mida/chain": "workspace:*"
```
and to its `"scripts"`:
```json
    "chain:abis": "node packages/chain/scripts/gen-abis.mjs"
```

Run from the repository root:
```bash
pnpm install
(cd contracts && forge build)
pnpm chain:abis
```
Expected: `abis.ts <- CapabilityRegistry (81 items), ContextRegistry (24 items)`. Commit the generated `packages/chain/src/abis.ts`; never edit it by hand.

- [ ] **Step 2: Write the failing unit test**

`packages/chain/test/chain.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { encodeErrorResult, getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import {
  MAX_LOG_BLOCK_RANGE,
  REVERT_CODES,
  blockWindows,
  capabilityRegistryAbi,
  chainFor,
  contextRegistryAbi,
  getLogsChunked,
  ownerHistory,
  parseDeployment,
  revertNameFromData,
} from "@mida/chain"
import type { Deployment, LogClient } from "@mida/chain"

const OWNER: Address = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
const AGENT: Hex = `0x${"aa".repeat(32)}`
const OTHER_AGENT: Hex = `0x${"bb".repeat(32)}`

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 5n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}

function recordingClient(head: bigint, logsFor: (call: { event: AbiEvent; fromBlock: bigint; toBlock: bigint }) => unknown[]) {
  const calls: Array<{ event: string; fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> }> = []
  const client: LogClient = {
    getBlockNumber: async () => head,
    getLogs: async (parameters) => {
      calls.push({ event: parameters.event.name, fromBlock: parameters.fromBlock, toBlock: parameters.toBlock, args: parameters.args })
      return logsFor(parameters)
    },
  }
  return { client, calls }
}

describe("generated ABIs (plan Task 21)", () => {
  it("contain the functions Part E calls and the §12.6 revert names", () => {
    const capabilityFunctions = capabilityRegistryAbi.filter((item) => item.type === "function").map((item) => item.name)
    for (const name of [
      "grantBatch", "initializeReadEpoch", "revoke", "revokeAndRotate", "revokeAgentAndRotate", "rotateExpiredEpoch",
      "registerAgent", "registerP256Key", "getAgent", "getCapability", "agentEpoch", "hasAuthority", "isAuthorized",
      "requiredReadEpoch", "epochPublicKey", "isWriteEpochValid", "agentIdOfSigner", "grantNonce", "ownerP256Key",
      "activeCapabilityIds", "isCapabilityValid",
    ]) {
      expect(capabilityFunctions, name).toContain(name)
    }
    const contextFunctions = contextRegistryAbi.filter((item) => item.type === "function").map((item) => item.name)
    for (const name of ["register", "getRecord", "exists", "latest"]) expect(contextFunctions, name).toContain(name)
    const errorNames = new Set<string>([...capabilityRegistryAbi, ...contextRegistryAbi].filter((i) => i.type === "error").map((i) => i.name))
    for (const name of Object.keys(REVERT_CODES)) expect(errorNames.has(name), name).toBe(true)
  })

  it("decodes revert data to a contract error name", () => {
    const career = namespaceId("goals.career")
    const data = encodeErrorResult({ abi: contextRegistryAbi, errorName: "StaleParent", args: [career, AGENT] })
    expect(revertNameFromData(data)).toBe("StaleParent")
    expect(REVERT_CODES.StaleParent).toBe("STALE_PARENT")
    expect(revertNameFromData("0xdeadbeef")).toBeUndefined()
  })
})

describe("network configuration", () => {
  it("parses a Deploy.s.sol file and normalizes addresses to lowercase", () => {
    const parsed = parseDeployment({
      chainId: 31337,
      deploymentBlock: 5,
      vaultRpId: "vault.mida.xyz",
      vaultRpIdHash: deployment.vaultRpIdHash,
      policyHashV1: deployment.policyHashV1,
      capabilityRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      contextRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    })
    expect(parsed).toEqual(deployment)
  })

  it("rejects a file with a missing or malformed key", () => {
    const fails = (value: unknown) => {
      try {
        parseDeployment(value)
      } catch (error) {
        return isMidaError(error, "INVALID_WIRE")
      }
      return false
    }
    expect(fails({ ...deployment, capabilityRegistry: undefined, chainId: 31337, deploymentBlock: 5 })).toBe(true)
    expect(fails({ ...deployment, chainId: -1, deploymentBlock: 5 })).toBe(true)
    expect(fails([])).toBe(true)
  })

  it("maps only the local chain and Monad testnet, using viem's definitions", () => {
    expect(chainFor(31337n).id).toBe(31337)
    expect(chainFor(10143n).id).toBe(10143)
    expect(chainFor(10143n).rpcUrls.default.http[0]).toBe("https://testnet-rpc.monad.xyz")
    expect(() => chainFor(1n)).toThrow()
  })
})

describe("chunked log scans (≤100 blocks per request)", () => {
  it("splits an inclusive range into windows of at most 100 blocks", () => {
    expect(MAX_LOG_BLOCK_RANGE).toBe(100n)
    expect(blockWindows(0n, 250n)).toEqual([
      { fromBlock: 0n, toBlock: 99n },
      { fromBlock: 100n, toBlock: 199n },
      { fromBlock: 200n, toBlock: 250n },
    ])
    expect(blockWindows(7n, 7n)).toEqual([{ fromBlock: 7n, toBlock: 7n }])
    expect(blockWindows(8n, 7n)).toEqual([])
    expect(() => blockWindows(0n, 10n, 101n)).toThrow()
  })

  it("never asks the provider for more than 100 blocks", async () => {
    const event = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent
    const { client, calls } = recordingClient(1_234n, (call) => [{ args: {}, blockNumber: call.fromBlock, transactionHash: null, logIndex: 0 }])
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n })
    expect(calls.length).toBe(13)
    for (const call of calls) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(100n)
    expect(calls[0]!.fromBlock).toBe(5n)
    expect(calls.at(-1)!.toBlock).toBe(1_234n)
    expect(logs).toHaveLength(13)
  })
})

describe("owner history (§14.6 PREVIOUSLY_REVOKED)", () => {
  const log = (owner: string, agentId: string) => ({ args: { owner, agentId }, blockNumber: 9n, transactionHash: null, logIndex: 0 })

  it("starts at deploymentBlock, filters by exactly (owner, agentId), and scans both revocation events", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const history = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })
    expect(history).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: false, observedThroughBlock: 20n })
    expect(new Set(calls.map((call) => call.event))).toEqual(new Set(["CapabilityRevoked", "AgentRevoked"]))
    for (const call of calls) {
      expect(call.fromBlock).toBe(5n)
      expect(call.args).toEqual({ owner: OWNER, agentId: AGENT })
    }
  })

  it("reports a revocation of this exact pair", async () => {
    const { client } = recordingClient(20n, (call) => (call.event.name === "AgentRevoked" ? [log(OWNER, AGENT.toUpperCase().replace("0X", "0x"))] : []))
    expect((await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).previouslyRevoked).toBe(true)
  })

  it("ignores revocations of another agent or by another owner even if a provider returns them", async () => {
    const { client } = recordingClient(20n, () => [
      log(OWNER, OTHER_AGENT),
      log("0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", AGENT),
    ])
    expect((await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).previouslyRevoked).toBe(false)
  })
})
```

- [ ] **Step 3: Write the failing local-chain test**

`packages/chain/test/local.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createPublicClient, getAbiItem, http } from "viem"
import type { AbiEvent, PublicClient } from "viem"
import { NAMESPACE_TREE_V1, isMidaError, originHash } from "@mida/protocol"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"
import { ANVIL_PRIVATE_KEYS, capabilityRegistryAbi, chainFor, createWriteContext, deployLocal, getLogsChunked, readAgentRecord, registerAgent, revertName, startAnvil } from "@mida/chain"
import type { Deployment, LocalNode } from "@mida/chain"

describe("local Anvil deployment (plan Task 21)", () => {
  let node: LocalNode
  let deployment: Deployment
  let publicClient: PublicClient

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    publicClient = createPublicClient({ chain: chainFor(31337n), transport: http(node.rpcUrl) })
  }, 180_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("deploys with the TypeScript policy hash and the Vault RP ID", async () => {
    expect(deployment.policyHashV1).toBe(POLICY_HASH_V1)
    expect(deployment.vaultRpId).toBe("vault.mida.xyz")
    const count = await publicClient.readContract({
      address: deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "NAMESPACE_COUNT",
    })
    expect(count).toBe(22n)
  })

  it("finds all 22 NamespaceRegistered events with a chunked scan from deploymentBlock", async () => {
    const event = getAbiItem({ abi: capabilityRegistryAbi, name: "NamespaceRegistered" }) as AbiEvent
    const logs = await getLogsChunked(publicClient, { address: deployment.capabilityRegistry, event, fromBlock: deployment.deploymentBlock })
    expect(logs.map((log) => log.args.namespaceId)).toEqual(NAMESPACE_TREE_V1.map((node) => node.id))
  })

  it("maps an unknown agent revert to CAPABILITY_DENIED", async () => {
    await expect(readAgentRecord({ publicClient, deployment }, `0x${"77".repeat(32)}`)).rejects.toSatisfy((error: unknown) =>
      isMidaError(error, "CAPABILITY_DENIED"),
    )
  })
})

describe("agent registration through the chain adapter", () => {
  let node: LocalNode
  let deployment: Deployment

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
  }, 180_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("registers an agent whose signer proved acceptance and reads the record back", async () => {
    const operator = privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!)
    const signer = privateKeyToAccount(generatePrivateKey())
    const context = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: operator })
    const { agentId } = await registerAgent(context, {
      agentSalt: `0x${"5a".repeat(32)}`,
      signer,
      encryptionPublicKey: `0x${"e1".repeat(32)}`,
      callbackOrigin: "https://career.example",
      capabilityManifestHash: `0x${"c3".repeat(32)}`,
    })
    const record = await readAgentRecord(context, agentId)
    expect(record).toEqual({
      agentId,
      operator: operator.address.toLowerCase(),
      signer: signer.address.toLowerCase(),
      encryptionPublicKey: `0x${"e1".repeat(32)}`,
      encryptionKeyVersion: 1,
      callbackOriginHash: originHash("https://career.example"),
      capabilityManifestHash: `0x${"c3".repeat(32)}`,
      capabilityManifestVersion: 1,
      active: true,
    })
  })

  it("maps a second registration of the same signer to a named revert instead of a silent success", async () => {
    const operator = privateKeyToAccount(ANVIL_PRIVATE_KEYS[3]!)
    const signer = privateKeyToAccount(generatePrivateKey())
    const context = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: operator })
    const input = {
      signer,
      encryptionPublicKey: `0x${"e2".repeat(32)}` as const,
      callbackOrigin: "https://career.example",
      capabilityManifestHash: `0x${"c4".repeat(32)}` as const,
    }
    await registerAgent(context, { ...input, agentSalt: `0x${"01".repeat(32)}` })
    await expect(registerAgent(context, { ...input, agentSalt: `0x${"02".repeat(32)}` })).rejects.toSatisfy(
      (error: unknown) => revertName(error) === "SignerAlreadyBound" || String(error).includes("SignerAlreadyBound"),
    )
  })
})
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm vitest run packages/chain`
Expected: FAIL. Vitest cannot resolve `@mida/chain`, because `packages/chain/src/index.ts` does not exist yet.

- [ ] **Step 5: Implement network configuration, chunked logs and owner history**

`packages/chain/src/deployment.ts`:
```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MidaError, assertHex } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { Chain } from "viem"
import { foundry, monadTestnet } from "viem/chains"

/** Contents of contracts/deployments/<chainId>.json, written by contracts/script/Deploy.s.sol (plan Task 20). */
export interface Deployment {
  chainId: bigint
  capabilityRegistry: Address
  contextRegistry: Address
  deploymentBlock: bigint
  policyHashV1: Hex
  vaultRpId: string
  vaultRpIdHash: Hex
}

export const LOCAL_CHAIN_ID = 31337n
export const MONAD_TESTNET_CHAIN_ID = 10143n

export const DEFAULT_DEPLOYMENTS_DIR = fileURLToPath(new URL("../../../contracts/deployments/", import.meta.url))

function wire(detail: string): never {
  throw new MidaError("INVALID_WIRE", `deployment: ${detail}`)
}

function address(value: unknown, key: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) wire(`${key} must be an address`)
  return value.toLowerCase() as Address
}

function integer(value: unknown, key: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value)
  return wire(`${key} must be a non-negative integer`)
}

export function parseDeployment(json: unknown): Deployment {
  if (json === null || typeof json !== "object" || Array.isArray(json)) wire("must be an object")
  const record = json as Record<string, unknown>
  if (typeof record.vaultRpId !== "string" || record.vaultRpId.length === 0) wire("vaultRpId must be a non-empty string")
  if (typeof record.policyHashV1 !== "string" || typeof record.vaultRpIdHash !== "string") wire("hashes must be strings")
  return {
    chainId: integer(record.chainId, "chainId"),
    capabilityRegistry: address(record.capabilityRegistry, "capabilityRegistry"),
    contextRegistry: address(record.contextRegistry, "contextRegistry"),
    deploymentBlock: integer(record.deploymentBlock, "deploymentBlock"),
    policyHashV1: assertHex(record.policyHashV1.toLowerCase(), 32),
    vaultRpId: record.vaultRpId,
    vaultRpIdHash: assertHex(record.vaultRpIdHash.toLowerCase(), 32),
  }
}

export function loadDeployment(chainId: bigint, directory: string = DEFAULT_DEPLOYMENTS_DIR): Deployment {
  const path = `${directory.replace(/\/$/, "")}/${chainId}.json`
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new MidaError("NOT_FOUND", `no deployment file at ${path}`)
  }
  const deployment = parseDeployment(JSON.parse(text))
  if (deployment.chainId !== chainId) wire(`${path} is for chain ${deployment.chainId}`)
  return deployment
}

/** Only the two networks Project 1 targets. Monad testnet comes from viem, never a hand-written object. */
export function chainFor(chainId: bigint): Chain {
  if (chainId === LOCAL_CHAIN_ID) return foundry
  if (chainId === MONAD_TESTNET_CHAIN_ID) return monadTestnet
  throw new MidaError("INVALID_WIRE", `unsupported chain ${chainId}`)
}
```

`packages/chain/src/logs.ts`:
```ts
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { AbiEvent } from "viem"

/** Monad's public RPC caps eth_getLogs at 100 blocks; every scan uses this window whatever the provider. */
export const MAX_LOG_BLOCK_RANGE = 100n

export interface BlockWindow {
  fromBlock: bigint
  toBlock: bigint
}

export function blockWindows(fromBlock: bigint, toBlock: bigint, size: bigint = MAX_LOG_BLOCK_RANGE): BlockWindow[] {
  if (size <= 0n || size > MAX_LOG_BLOCK_RANGE) {
    throw new MidaError("INVALID_WIRE", `log window must be 1-${MAX_LOG_BLOCK_RANGE} blocks`)
  }
  const windows: BlockWindow[] = []
  for (let start = fromBlock; start <= toBlock; start += size) {
    const end = start + size - 1n
    windows.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock })
  }
  return windows
}

export interface DecodedLog {
  args: Record<string, unknown>
  blockNumber: bigint | null
  transactionHash: Hex | null
  logIndex: number | null
}

/** Structural subset of viem's PublicClient used for log scans, so tests can pass a recording fake. */
export interface LogClient {
  getBlockNumber(): Promise<bigint>
  getLogs(parameters: {
    address: Address
    event: AbiEvent
    args?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
    strict: true
  }): Promise<readonly unknown[]>
}

export async function getLogsChunked(
  client: LogClient,
  parameters: { address: Address; event: AbiEvent; args?: Record<string, unknown>; fromBlock: bigint; toBlock?: bigint },
): Promise<DecodedLog[]> {
  const toBlock = parameters.toBlock ?? (await client.getBlockNumber())
  const logs: DecodedLog[] = []
  for (const window of blockWindows(parameters.fromBlock, toBlock)) {
    const page = await client.getLogs({
      address: parameters.address,
      event: parameters.event,
      ...(parameters.args === undefined ? {} : { args: parameters.args }),
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
      strict: true,
    })
    logs.push(...(page as DecodedLog[]))
  }
  return logs
}
```

`packages/chain/src/history.ts`:
```ts
import type { Address, Hex, OwnerAgentHistory } from "@mida/protocol"
import { getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"
import { getLogsChunked } from "./logs.js"
import type { LogClient } from "./logs.js"

const CAPABILITY_REVOKED = getAbiItem({ abi: capabilityRegistryAbi, name: "CapabilityRevoked" }) as AbiEvent
const AGENT_REVOKED = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase()

/**
 * §14.6 PREVIOUSLY_REVOKED input. Built only from CapabilityRevoked and AgentRevoked events for exactly
 * this (owner, agentId) pair. Topic filters narrow the query; the explicit comparison below guards against
 * a provider that ignores them. Never consults reputation or access telemetry.
 */
export async function ownerHistory(input: {
  client: LogClient
  deployment: Deployment
  owner: Address
  agentId: Hex
  toBlock?: bigint
}): Promise<OwnerAgentHistory> {
  const toBlock = input.toBlock ?? (await input.client.getBlockNumber())
  const scan = { address: input.deployment.capabilityRegistry, fromBlock: input.deployment.deploymentBlock, toBlock }
  const filter = { owner: input.owner, agentId: input.agentId }
  const logs = [
    ...(await getLogsChunked(input.client, { ...scan, event: CAPABILITY_REVOKED, args: filter })),
    ...(await getLogsChunked(input.client, { ...scan, event: AGENT_REVOKED, args: filter })),
  ]
  const previouslyRevoked = logs.some((log) => same(log.args.owner, input.owner) && same(log.args.agentId, input.agentId))
  return { owner: input.owner, agentId: input.agentId, previouslyRevoked, observedThroughBlock: toBlock }
}
```

- [ ] **Step 6: Implement registry reads, writes and local tooling**

`packages/chain/src/registry.ts`:
```ts
import { MidaError } from "@mida/protocol"
import type { AgentRecord, Hex, MidaErrorCode } from "@mida/protocol"
import { BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem"
import type { PublicClient } from "viem"
import { capabilityRegistryAbi, contextRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"

export interface ChainContext {
  publicClient: PublicClient
  deployment: Deployment
}

/** Contract custom-error names mapped to protocol codes (§12.6 first, plan decision 3 codes otherwise). */
export const REVERT_CODES: Readonly<Record<string, MidaErrorCode>> = Object.freeze({
  AgentNotFound: "CAPABILITY_DENIED",
  AnchorOwnerOnly: "ANCHOR_OWNER_ONLY",
  AuthorityExceedsRequest: "RESPONSE_MISMATCH",
  CallbackOriginMismatch: "AGENT_ID_MISMATCH",
  CapabilityAlreadyRevoked: "CAPABILITY_REVOKED",
  CapabilityDenied: "CAPABILITY_DENIED",
  CapabilityNotFound: "CAPABILITY_DENIED",
  ContextIdMismatch: "COMMITMENT_MISMATCH",
  ContextNotFound: "NOT_FOUND",
  EpochRotationRequired: "EPOCH_ROTATION_REQUIRED",
  EpochStale: "EPOCH_STALE",
  EvidenceImmutable: "EVIDENCE_IMMUTABLE",
  ExpiryInvalid: "CAPABILITY_EXPIRED",
  HighSensitivityExpiry: "CAPABILITY_DENIED",
  InvalidNamespace: "INVALID_NAMESPACE",
  InvalidSignature: "REQUEST_SIGNATURE_INVALID",
  ManifestStale: "MANIFEST_STALE",
  ParentMismatch: "STALE_PARENT",
  ProvenanceForbidden: "PROVENANCE_FORBIDDEN",
  RequestExpired: "REQUEST_EXPIRED",
  StaleParent: "STALE_PARENT",
  VersionUnsupported: "POLICY_VERSION_UNSUPPORTED",
  WebAuthnInvalid: "AUTH_INVALID",
})

const ALL_ERRORS = [...capabilityRegistryAbi, ...contextRegistryAbi].filter((item) => item.type === "error")

export function revertNameFromData(data: Hex): string | undefined {
  try {
    return decodeErrorResult({ abi: ALL_ERRORS, data }).errorName
  } catch {
    return undefined
  }
}

export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? (reverted.raw === undefined ? undefined : revertNameFromData(reverted.raw))
  }
  return undefined
}

/** Returns a MidaError for a known contract revert; any other error is returned unchanged for rethrow. */
export function toMidaError(error: unknown): unknown {
  const name = revertName(error)
  const code = name === undefined ? undefined : REVERT_CODES[name]
  return code === undefined ? error : new MidaError(code, `contract reverted ${name}`)
}

export async function readAgentRecord(context: ChainContext, agentId: Hex): Promise<AgentRecord> {
  try {
    const record = await context.publicClient.readContract({
      address: context.deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "getAgent",
      args: [agentId],
    })
    return {
      agentId: agentId.toLowerCase() as Hex,
      operator: record.operator.toLowerCase() as Hex,
      signer: record.signer.toLowerCase() as Hex,
      encryptionPublicKey: record.encryptionPublicKey,
      encryptionKeyVersion: record.encryptionKeyVersion,
      callbackOriginHash: record.callbackOriginHash,
      capabilityManifestHash: record.capabilityManifestHash,
      capabilityManifestVersion: Number(record.capabilityManifestVersion),
      active: record.active,
    }
  } catch (error) {
    throw toMidaError(error)
  }
}

/** Chain time, not wall-clock time, decides expiry so the API and the contracts use one clock (Part D note). */
export async function latestTimestamp(context: ChainContext): Promise<bigint> {
  return (await context.publicClient.getBlock({ blockTag: "latest" })).timestamp
}
```

`packages/chain/src/writes.ts`:
```ts
import {
  MidaError,
  agentId as deriveAgentId,
  agentRegistrationTypedData,
  canonicalizeOrigin,
  originHash,
} from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { createPublicClient, createWalletClient, http } from "viem"
import type { Abi, Account, LocalAccount, PublicClient, TransactionReceipt, WalletClient } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import { chainFor } from "./deployment.js"
import type { Deployment } from "./deployment.js"
import { toMidaError } from "./registry.js"
import type { ChainContext } from "./registry.js"

export interface WriteContext extends ChainContext {
  walletClient: WalletClient
  account: Account
}

/** A write context whose account can sign typed data locally (operators, owners and agent signers in tests and the CLI). */
export interface LocalWriteContext extends WriteContext {
  account: LocalAccount
}

export function createWriteContext(input: { rpcUrl: string; deployment: Deployment; account: LocalAccount }): LocalWriteContext {
  const chain = chainFor(input.deployment.chainId)
  return {
    deployment: input.deployment,
    account: input.account,
    publicClient: createPublicClient({ chain, transport: http(input.rpcUrl) }),
    walletClient: createWalletClient({ chain, account: input.account, transport: http(input.rpcUrl) }),
  }
}

/**
 * Simulates first so a revert surfaces as a named contract error mapped to a protocol code, then sends and waits
 * for the receipt. A receipt with status "reverted" (for example a Monad reserve-balance revert after inclusion)
 * is an error, never a silent success.
 */
export async function sendContract(
  context: WriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<TransactionReceipt> {
  let request: unknown
  try {
    ;({ request } = await context.publicClient.simulateContract({
      account: context.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never))
  } catch (error) {
    throw toMidaError(error)
  }
  const hash = await context.walletClient.writeContract(request as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") {
    throw new MidaError("CAPABILITY_DENIED", `${call.functionName} transaction ${hash} reverted on-chain`)
  }
  return receipt
}

/**
 * Operator-side agent registration (§4.3). The proposed signer signs MidaAgentRegistrationV1 over every field;
 * the contract fixes encryptionKeyVersion and capabilityManifestVersion at 1.
 */
export async function registerAgent(
  context: WriteContext,
  input: { agentSalt: Hex; signer: LocalAccount; encryptionPublicKey: Hex; callbackOrigin: string; capabilityManifestHash: Hex },
): Promise<{ agentId: Hex; receipt: TransactionReceipt }> {
  const { deployment } = context
  const operator = context.account.address
  const agentId = deriveAgentId({
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    operator,
    agentSalt: input.agentSalt,
  })
  const callbackOriginHash = originHash(canonicalizeOrigin(input.callbackOrigin, { allowLocalhost: true }))
  const signature = await input.signer.signTypedData(
    agentRegistrationTypedData({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      agentId,
      operator,
      signer: input.signer.address,
      encryptionPublicKey: input.encryptionPublicKey,
      encryptionKeyVersion: 1,
      callbackOriginHash,
      capabilityManifestHash: input.capabilityManifestHash,
      capabilityManifestVersion: 1n,
    }) as never,
  )
  const receipt = await sendContract(context, {
    address: deployment.capabilityRegistry,
    abi: capabilityRegistryAbi,
    functionName: "registerAgent",
    args: [input.agentSalt, input.signer.address, input.encryptionPublicKey, callbackOriginHash, input.capabilityManifestHash, signature],
  })
  return { agentId, receipt }
}
```

`packages/chain/src/local.ts`:
```ts
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdirSync, rmdirSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import type { Hex } from "@mida/protocol"
import { loadDeployment } from "./deployment.js"
import type { Deployment } from "./deployment.js"

/** Development tooling for tests and the CLI. Never used against a real network. */
export const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? `${homedir()}/.foundry/bin`
export const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts/", import.meta.url))

/** Anvil's public, pre-funded development keys (mnemonic "test test ... junk"). Never use on a real network. */
export const ANVIL_PRIVATE_KEYS: readonly Hex[] = Object.freeze([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
])

export interface LocalNode {
  rpcUrl: string
  hardfork: string
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}

async function waitForRpc(rpcUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`)
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      })
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`anvil did not answer at ${rpcUrl}`)
}

/** Starts a fresh Anvil on a free port. hardfork "default" keeps Anvil's default (Osaka, native P256 at 0x100). */
export async function startAnvil(options: { hardfork?: string } = {}): Promise<LocalNode> {
  const hardfork = options.hardfork ?? "default"
  const port = await freePort()
  const args = ["--port", String(port), "--silent", ...(hardfork === "default" ? [] : ["--hardfork", hardfork])]
  const child = spawn(`${FOUNDRY_BIN}/anvil`, args, { stdio: "ignore" })
  const rpcUrl = `http://127.0.0.1:${port}`
  await waitForRpc(rpcUrl, child)
  return {
    rpcUrl,
    hardfork,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
      }),
  }
}

const LOCK_DIR = `${CONTRACTS_DIR}deployments/.deploy-lock`

/**
 * Deploys with contracts/script/Deploy.s.sol and returns the parsed deployment file. Every local Anvil writes the
 * same deployments/31337.json, so deployments from parallel test files are serialized with a directory lock.
 */
export async function deployLocal(options: { rpcUrl: string; privateKey?: Hex }): Promise<Deployment> {
  const privateKey = options.privateKey ?? ANVIL_PRIVATE_KEYS[0]!
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      mkdirSync(LOCK_DIR)
      break
    } catch {
      if (Date.now() > deadline) throw new Error(`deploy lock ${LOCK_DIR} held for 120s`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  try {
    const result = spawnSync(
      `${FOUNDRY_BIN}/forge`,
      ["script", "script/Deploy.s.sol", "--rpc-url", options.rpcUrl, "--broadcast", "--private-key", privateKey],
      { cwd: CONTRACTS_DIR, encoding: "utf8", env: { ...process.env, VAULT_RP_ID: process.env.VAULT_RP_ID ?? "vault.mida.xyz" } },
    )
    if (result.status !== 0) throw new Error(`forge script failed:\n${result.stdout}\n${result.stderr}`)
    return loadDeployment(31337n)
  } finally {
    rmdirSync(LOCK_DIR)
  }
}

/** Anvil-only: sets an address balance so generated agent signers can pay gas in local tests. */
export async function fundLocal(rpcUrl: string, address: string, wei: bigint = 10n ** 20n): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${wei.toString(16)}`] }),
  })
  const body = (await response.json()) as { error?: unknown }
  if (body.error !== undefined) throw new Error(`anvil_setBalance failed: ${JSON.stringify(body.error)}`)
}

/** Anvil-only: moves chain time forward and mines one block, for expiry tests. */
export async function increaseLocalTime(rpcUrl: string, seconds: bigint): Promise<void> {
  for (const [method, params] of [["evm_increaseTime", [Number(seconds)]], ["evm_mine", []]] as const) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    const body = (await response.json()) as { error?: unknown }
    if (body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
  }
}
```

`packages/chain/src/index.ts`:
```ts
export * from "./abis.js"
export * from "./deployment.js"
export * from "./logs.js"
export * from "./history.js"
export * from "./registry.js"
export * from "./local.js"
export * from "./writes.js"
```

- [ ] **Step 7: Run to verify they pass**

Run:
```bash
pnpm vitest run packages/chain
pnpm typecheck
```
Expected: `Test Files 2 passed`, `Tests 15 passed`. Typecheck exits 0. The local test starts two Anvil nodes and deploys twice; it needs Foundry 1.8.1 at `~/.foundry/bin` (or `FOUNDRY_BIN`).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml packages/chain
git commit -m "feat(chain): viem adapter with generated ABIs, chunked log scans, owner history and local tooling

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 22: `@mida/fake-vault`

**Depends on:** Tasks 6–13 (crypto, storage, advisor) and Task 21.

**Files:**
- Create: `packages/protocol/src/webauthn-assertion.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/webauthn-assertion.test.ts`
- Create: `packages/fake-vault/package.json`, `packages/fake-vault/src/prf.ts`, `packages/fake-vault/src/webauthn.ts`, `packages/fake-vault/src/ports.ts`, `packages/fake-vault/src/agents.ts`, `packages/fake-vault/src/fake-vault.ts`, `packages/fake-vault/src/index.ts`
- Modify: root `package.json` (dependency `"@mida/fake-vault": "workspace:*"`)
- Test: `packages/fake-vault/test/fake-vault.test.ts`

**Interfaces:**
- Consumes: Part A protocol constants, `accessRequestHash`, `cancelFastRevokeDigest`, `canonicalizeNamespace`, `contextId`, `grantDigest`, `hashString`, `namespaceById`, `namespaceId`, `originHash`, `sortScopes`, `accessRequestTypedData`, `agentId`; Part B `assertNonZeroKey`, `bytesOf`, `deriveEpochKeyPair`, `deriveNamespaceSecret`, `generateX25519KeyPair`, `hexOf`, `prfSalt`, `sealContextObject`, `wrapEpochPrivateKeyToAgent`; Part C `POLICY_HASH_V1`, `adviseGrant`, `assertFinalSelection`, `manifestBindingFor`, `manifestBodyHash`; Task 21 `capabilityRegistryAbi`, `contextRegistryAbi`, `latestTimestamp`, `ownerHistory`, `readAgentRecord`, `registerAgent`, `sendContract`, `toMidaError`, types `ChainContext`, `WriteContext`, `LocalWriteContext`.
- Produces, `prf.ts`: `fakePrfOutput(seed: Uint8Array, domain: IsolationDomain): Uint8Array`.
- Produces, `@mida/protocol` `webauthn-assertion.ts` (the shared adapter): `P256_N: bigint`, `interface WebAuthnAuthStruct { authenticatorData: Hex; clientDataJSON: string; challengeIndex: bigint; typeIndex: bigint; r: bigint; s: bigint }`, `normalizeP256LowS(s: bigint): bigint` (throws `INVALID_WIRE` unless `0 < s < n`; returns `n - s` when `s > n/2`), `toWebAuthnAuthStruct({ authenticatorData; clientDataJSON; challengeIndex: number | bigint; typeIndex: number | bigint; r: bigint; s: bigint }): WebAuthnAuthStruct`.
- Produces, `webauthn.ts`: `type VaultAssertionMetadata`, `interface WebAuthnAssertionWire` (the struct's fields, integers as strings), `p256PublicKey(privateKey: Hex): { qx: bigint; qy: bigint }`, `vaultSignPayload({ challenge; rpId; origin }): { metadata: VaultAssertionMetadata; digest: Hex }`, `completeVaultAssertion({ challenge; metadata; r; s; publicKey: { qx; qy }; rpId; origin }): WebAuthnAuthStruct` (throws `AUTH_INVALID` unless ox `WebAuthnP256.verify` accepts the normalized result), `signVaultAssertion({ challenge; privateKey; rpId; origin }): WebAuthnAuthStruct`, `assertionToWire(auth): WebAuthnAssertionWire`. `P256_N` and `WebAuthnAuthStruct` now come from `@mida/protocol`; the FakeVault has no normalization of its own.
- Produces, `ports.ts`: `interface VaultContextApi { putObject(upload); publishEpochWrap(wrap); requestRevocationDeny(target): Promise<{ intentId: Hex }> }`.
- Produces, `agents.ts` (fixtures): `interface AgentDeclaration`, `interface ProvisionedAgent { agentId; signer; encryptionPrivateKey; encryptionPublicKey; callbackOrigin; purposeId; manifest; manifestHash }`, `provisionAgent({ operator: LocalWriteContext; name; purposeId; declarations; callbackOrigin; signer? }): Promise<ProvisionedAgent>`, `buildSignedAccessRequest({ chain: ChainContext; agent; scopes; overrides? }): Promise<AccessRequest>`.
- Produces, `fake-vault.ts`: `interface VaultAuthority` (§4.2), `type GrantSelection`, `interface GrantRequest`, `interface GrantApproval { advice; response; gasUsed: bigint }`, `type RevokeRequest`, `interface RevokeApproval { intentId; transactionHash; rotated }`, `interface FakeVaultConfig { seed; p256PrivateKey; chain: WriteContext; api: VaultContextApi; origin? }`, `toAccessRequestStruct(request)`, and `class FakeVaultAuthority implements VaultAuthority` with `owner`, `p256PublicKey`, `deriveNamespaceSecret(namespaceId)`, `registerOwnerKey()`, `initializeNamespace(namespace)`, `approveGrant(request)`, `publishReaderWraps({ agentId; namespaceId }): Promise<bigint[]>`, `approveRevocation(request)`, `rotateExpiredEpoch(namespaceId)`, `approveDenyCancellation({ revocationIntentId; apiCancellationNonce; expiresAt }): WebAuthnAssertionWire`, `createOwnerContext({ namespace; payload; lineagePolicy?; expectedParentId?; evidenceCommitment?; expiresAt? })`.

`rotateExpiredEpoch` is exercised end to end in Task 24's deadline test, where writes resume under the next epoch.

- [ ] **Step 1: Write the failing shared-adapter test**

This adapter lives in `@mida/protocol`, not the FakeVault, because Project 2's real passkey adapter must apply the same low-s normalization without depending on test tooling (decision 17).

`packages/protocol/test/webauthn-assertion.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { P256, WebAuthnP256 } from "ox"
import type { Hex } from "@mida/protocol"
import { P256_N, isMidaError, normalizeP256LowS, toWebAuthnAuthStruct } from "@mida/protocol"

const HALF = P256_N / 2n
const bytes32 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

const invalid = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, "INVALID_WIRE")
  }
  return false
}

describe("shared P256 low-s assertion adapter (§10.4)", () => {
  it("fixes the P256 group order", () => {
    expect(P256_N).toBe(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n)
  })

  it("maps a high-s value to n - s", () => {
    expect(normalizeP256LowS(HALF + 1n)).toBe(P256_N - HALF - 1n)
    expect(normalizeP256LowS(P256_N - 1n)).toBe(1n)
  })

  it("leaves low-s and exactly n/2 untouched", () => {
    expect(normalizeP256LowS(1n)).toBe(1n)
    expect(normalizeP256LowS(HALF - 1n)).toBe(HALF - 1n)
    expect(normalizeP256LowS(HALF)).toBe(HALF)
  })

  it("rejects zero, negative values, n and anything above n", () => {
    for (const s of [0n, -1n, P256_N, P256_N + 1n]) expect(invalid(() => normalizeP256LowS(s)), s.toString()).toBe(true)
  })

  it("builds the webauthn-sol struct with normalized s, and an ox-verified assertion stays valid", () => {
    const privateKey: Hex = `0x${"4d".repeat(32)}`
    const publicKey = P256.getPublicKey({ privateKey })
    const challenge: Hex = `0x${"ab".repeat(32)}`
    const rpId = "vault.mida.xyz"
    const origin = "https://vault.mida.xyz"
    const { metadata, payload } = WebAuthnP256.getSignPayload({ challenge, rpId, origin, userVerification: "required" })
    const signature = P256.sign({ payload, privateKey, hash: true })
    const verifies = (r: bigint, s: bigint) =>
      WebAuthnP256.verify({ challenge, metadata, publicKey, rpId, origin, signature: { r: bytes32(r), s: bytes32(s), yParity: 0 } })
    const r = BigInt(signature.r)
    expect(verifies(r, BigInt(signature.s))).toBe(true)

    const lowS = normalizeP256LowS(BigInt(signature.s))
    for (const rawS of [lowS, P256_N - lowS]) {
      const auth = toWebAuthnAuthStruct({
        authenticatorData: metadata.authenticatorData,
        clientDataJSON: metadata.clientDataJSON,
        challengeIndex: metadata.challengeIndex!,
        typeIndex: metadata.typeIndex!,
        r,
        s: rawS,
      })
      expect(auth).toEqual({
        authenticatorData: metadata.authenticatorData,
        clientDataJSON: metadata.clientDataJSON,
        challengeIndex: BigInt(metadata.challengeIndex!),
        typeIndex: BigInt(metadata.typeIndex!),
        r,
        s: lowS,
      })
      expect(auth.s <= HALF).toBe(true)
      expect(verifies(auth.r, auth.s)).toBe(true)
    }
  })
})
```

Run: `pnpm vitest run packages/protocol/test/webauthn-assertion.test.ts`
Expected: FAIL with `TypeError: Cannot mix BigInt and other types`, because `P256_N` is not exported yet.

- [ ] **Step 2: Implement the shared adapter**

`packages/protocol/src/webauthn-assertion.ts`:
```ts
import type { Hex } from "viem"
import { MidaError } from "./errors.js"

/** Order of the P256 (secp256r1) group. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** Solidity `WebAuthn.WebAuthnAuth` from webauthn-sol v1.0.0, in field order. */
export interface WebAuthnAuthStruct {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: bigint
  typeIndex: bigint
  r: bigint
  s: bigint
}

/**
 * EIP-7951 accepts any 0 < s < n, but webauthn-sol rejects s > n/2 (spec §10.4). A valid signature with high s has an
 * equally valid twin at n - s, so every adapter maps to that low-s form before contract submission.
 */
export function normalizeP256LowS(s: bigint): bigint {
  if (s <= 0n || s >= P256_N) throw new MidaError("INVALID_WIRE", "P256 signature s must satisfy 0 < s < n")
  return s > P256_N / 2n ? P256_N - s : s
}

/**
 * The shared assertion adapter (spec §10.4, §15): builds the struct `grantBatch` and `rotateP256Key` consume, with s
 * normalized. It has no FakeVault or browser dependency, so Project 2's real passkey adapter uses exactly this.
 */
export function toWebAuthnAuthStruct(input: {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: number | bigint
  typeIndex: number | bigint
  r: bigint
  s: bigint
}): WebAuthnAuthStruct {
  return {
    authenticatorData: input.authenticatorData,
    clientDataJSON: input.clientDataJSON,
    challengeIndex: BigInt(input.challengeIndex),
    typeIndex: BigInt(input.typeIndex),
    r: input.r,
    s: normalizeP256LowS(input.s),
  }
}
```

Append to `packages/protocol/src/index.ts`:
```ts
export * from "./webauthn-assertion.js"
```

Run: `pnpm vitest run packages/protocol/test/webauthn-assertion.test.ts`
Expected: `Tests 5 passed`.

- [ ] **Step 3: Create the package manifest**

`packages/fake-vault/package.json`:
```json
{
  "name": "@mida/fake-vault",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@mida/chain": "workspace:*",
    "@mida/crypto": "workspace:*",
    "@mida/grant-advisor": "workspace:*",
    "@mida/protocol": "workspace:*",
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "ox": "1.7.4",
    "viem": "2.56.3"
  }
}
```

Add `"@mida/fake-vault": "workspace:*"` to the root `package.json` `"dependencies"`, then run `pnpm install`.

- [ ] **Step 4: Write the failing test**

`packages/fake-vault/test/fake-vault.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { P256_N, PERMISSION, isMidaError, namespaceId, sortScopes } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap, UnsignedAccessRequest } from "@mida/protocol"
import {
  bytesOf,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  hexOf,
  manifestHash,
  openContextObject,
  prfSalt,
  unwrapEpochPrivateKey,
} from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  capabilityRegistryAbi,
  contextRegistryAbi,
  createWriteContext,
  deployLocal,
  latestTimestamp,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, WriteContext } from "@mida/chain"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js"
import { p256 } from "@noble/curves/nist.js"
import { P256, WebAuthnP256 } from "ox"
import {
  FakeVaultAuthority,
  buildSignedAccessRequest,
  completeVaultAssertion,
  p256PublicKey,
  provisionAgent,
  signVaultAssertion,
  vaultSignPayload,
} from "@mida/fake-vault"
import type { ProvisionedAgent, VaultContextApi } from "@mida/fake-vault"

const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`
const CAREER = namespaceId("goals.career")
const FINANCIAL = namespaceId("financial")

interface Recorded {
  uploads: Array<{ manifest: ObjectManifest; ciphertext: Hex; owner: Address; namespaceId: Hex }>
  wraps: ReaderEpochWrap[]
  denies: Array<{ target: unknown; chainStillAuthorized: boolean }>
}

describe("FakeVaultAuthority (plan Task 22)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: WriteContext
  let vault: FakeVaultAuthority
  let agentA: ProvisionedAgent
  let agentB: ProvisionedAgent
  let capabilityA: Hex
  const recorded: Recorded = { uploads: [], wraps: [], denies: [] }
  const approvals: unknown[] = []

  const read = <T>(functionName: string, args: readonly unknown[]) =>
    owner.publicClient.readContract({ address: deployment.capabilityRegistry, abi: capabilityRegistryAbi, functionName, args } as never) as Promise<T>

  const api: VaultContextApi = {
    putObject: async (upload) => void recorded.uploads.push(upload),
    publishEpochWrap: async (wrap) => void recorded.wraps.push(wrap),
    requestRevocationDeny: async (target) => {
      const chainStillAuthorized = await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, CAREER, PERMISSION.READ])
      recorded.denies.push({ target, chainStillAuthorized })
      return { intentId: hexOf(randomBytes(32)) }
    },
  }

  const signedRequest = (
    agent: ProvisionedAgent,
    scopes: Array<{ namespace: string; permissions: number; provenancePolicy?: number }>,
    overrides: Partial<UnsignedAccessRequest> = {},
  ) => buildSignedAccessRequest({ chain: owner, agent, scopes, overrides })

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api })
    const operatorA = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!) })
    const operatorB = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[3]!) })
    const declarations = [
      { namespace: "goals.career", permissions: ["READ" as const] },
      { namespace: "financial", permissions: ["READ" as const] },
    ]
    agentA = await provisionAgent({ operator: operatorA, name: "CareerAI", purposeId: "career_coaching", declarations, callbackOrigin: "https://career.example" })
    agentB = await provisionAgent({ operator: operatorB, name: "Bystander", purposeId: "career_coaching", declarations, callbackOrigin: "https://bystander.example" })
  }, 180_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("derives one domain's PRF output from the seed and exposes no seed or global root", async () => {
    const expected = deriveNamespaceSecret(hmac(sha256, SEED, prfSalt("general")), CAREER)
    expect(await vault.deriveNamespaceSecret(CAREER)).toEqual(expected)
    const sameSeed = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api })
    expect(await sameSeed.deriveNamespaceSecret(CAREER)).toEqual(expected)
    const financialExpected = deriveNamespaceSecret(hmac(sha256, SEED, prfSalt("financial")), FINANCIAL)
    expect(await vault.deriveNamespaceSecret(FINANCIAL)).toEqual(financialExpected)
    const otherSeed = new FakeVaultAuthority({ seed: new Uint8Array(32).fill(0x43), p256PrivateKey: P256_KEY, chain: owner, api })
    expect(hexOf(await otherSeed.deriveNamespaceSecret(CAREER))).not.toBe(hexOf(expected))
    expect(Object.keys(vault)).toEqual(["owner"])
  })

  it("refuses a deployment whose POLICY_HASH_V1 differs from the TypeScript policy", () => {
    const wrongPolicy = { ...owner, deployment: { ...deployment, policyHashV1: zeroHash } }
    expect(() => new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: wrongPolicy, api })).toThrow(
      expect.objectContaining({ code: "POLICY_VERSION_UNSUPPORTED" }),
    )
  })

  it("registers the owner P256 key and publishes the derived epoch-1 public key", async () => {
    await vault.registerOwnerKey()
    await vault.initializeNamespace("Goals.Career")
    const [qx, qy] = await read<readonly [bigint, bigint]>("ownerP256Key", [vault.owner])
    expect({ qx, qy }).toEqual(p256PublicKey(P256_KEY))
    const derived = deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n)
    expect(await read<Hex>("epochPublicKey", [vault.owner, CAREER, 1n])).toBe(hexOf(derived.publicKey))
  })

  it("publishes no reader wrap before the chain holds a READ capability", async () => {
    await expect(vault.publishReaderWraps({ agentId: agentB.agentId, namespaceId: CAREER })).rejects.toSatisfy((error: unknown) =>
      isMidaError(error, "CAPABILITY_DENIED"),
    )
    expect(recorded.wraps).toHaveLength(0)
  })

  it("advises, binds the passkey assertion, grants only READ goals.career and wraps epoch 1 to Agent A", async () => {
    const request = await signedRequest(agentA, [
      { namespace: "goals.career", permissions: PERMISSION.READ },
      { namespace: "financial", permissions: PERMISSION.READ },
    ])
    const approval = await vault.approveGrant({ accessRequest: request, manifest: agentA.manifest, selection: { kind: "recommended" } })
    approvals.push(approval)
    expect(approval.advice.recommended).toEqual([{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }])
    const financialWarnings = approval.advice.warnings.filter((w) => w.namespaceId === FINANCIAL).map((w) => w.code)
    expect(financialWarnings).toEqual(expect.arrayContaining(["HIGH_SENSITIVITY", "SCOPE_SUSPICIOUS"]))
    expect(approval.response.capabilities).toHaveLength(1)
    expect(approval.response.capabilities[0]).toMatchObject({ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 })
    capabilityA = approval.response.capabilities[0]!.capabilityId

    expect(await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, CAREER, PERMISSION.READ])).toBe(true)
    expect(await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, FINANCIAL, PERMISSION.READ])).toBe(false)
    expect(await read<bigint>("grantNonce", [vault.owner])).toBe(1n)

    expect(recorded.wraps).toHaveLength(1)
    const wrap = recorded.wraps[0]!
    expect(wrap).toMatchObject({ agentId: agentA.agentId, readEpoch: "1", agentKeyVersion: 1, namespaceId: CAREER })
    const unwrapped = unwrapEpochPrivateKey({
      wrap,
      agentEncryptionPrivateKey: agentA.encryptionPrivateKey,
      binding: {
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        owner: vault.owner,
        namespaceId: CAREER,
        readEpoch: 1n,
        agentId: agentA.agentId,
        agentKeyVersion: 1,
      },
    })
    expect(unwrapped).toEqual(deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n).privateKey)
    expect(() =>
      unwrapEpochPrivateKey({
        wrap,
        agentEncryptionPrivateKey: agentB.encryptionPrivateKey,
        binding: {
          chainId: deployment.chainId,
          capabilityRegistry: deployment.capabilityRegistry,
          owner: vault.owner,
          namespaceId: CAREER,
          readEpoch: 1n,
          agentId: agentA.agentId,
          agentKeyVersion: 1,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "DECRYPT_FAILED" }))
  })

  it("refuses a request aimed at another chain before any chain write", async () => {
    const request = await signedRequest(agentA, [{ namespace: "goals.career", permissions: PERMISSION.READ }], { chainId: "10143" })
    await expect(vault.approveGrant({ accessRequest: request, manifest: agentA.manifest, selection: { kind: "recommended" } })).rejects.toSatisfy(
      (error: unknown) => isMidaError(error, "INVALID_WIRE"),
    )
    expect(await read<bigint>("grantNonce", [vault.owner])).toBe(1n)
  })

  it("rejects a custom selection broader than the signed request before any chain write", async () => {
    const request = await signedRequest(agentA, [{ namespace: "goals.career", permissions: PERMISSION.READ }])
    const broader = sortScopes([
      { namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 },
      { namespaceId: FINANCIAL, permissions: PERMISSION.READ, provenancePolicy: 0 },
    ])
    const expiresAt = (await latestTimestamp(owner)) + 3_600n
    await expect(
      vault.approveGrant({ accessRequest: request, manifest: agentA.manifest, selection: { kind: "custom", scopes: broader, expiresAt } }),
    ).rejects.toSatisfy((error: unknown) => isMidaError(error, "RESPONSE_MISMATCH"))
    expect(await read<bigint>("grantNonce", [vault.owner])).toBe(1n)
  })

  it("uploads owner ciphertext first, then anchors matching commitments that decrypt under epoch 1", async () => {
    const created = await vault.createOwnerContext({
      namespace: "goals.career",
      payload: { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } },
    })
    const upload = recorded.uploads.at(-1)!
    expect(upload.manifest.contextId).toBe(created.contextId)
    const record = (await owner.publicClient.readContract({
      address: deployment.contextRegistry,
      abi: contextRegistryAbi,
      functionName: "getRecord",
      args: [created.contextId],
    })) as { manifestHash: Hex; ciphertextCommitment: Hex; author: Hex; readEpoch: bigint }
    expect(record.manifestHash).toBe(manifestHash(upload.manifest))
    expect(record.ciphertextCommitment).toBe(upload.manifest.ciphertextHash)
    expect(record.author).toBe(zeroHash)
    const payload = openContextObject({
      manifest: upload.manifest,
      expectedManifestHash: record.manifestHash,
      ciphertext: bytesOf(upload.ciphertext, upload.manifest.ciphertextSize),
      epochPrivateKey: deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n).privateKey,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: created.contextId, namespaceId: CAREER, readEpoch: 1n },
    })
    expect(payload.value).toBe("Prioritize systems engineering")
  })

  it("posts the fast deny while the chain still authorizes, then revokes and rotates goals.career to epoch 2", async () => {
    const approval = await vault.approveRevocation({ kind: "capability", capabilityId: capabilityA })
    approvals.push(approval)
    expect(recorded.denies).toEqual([{ target: { capabilityId: capabilityA }, chainStillAuthorized: true }])
    expect(approval.rotated).toEqual([{ namespaceId: CAREER, readEpoch: 2n }])
    expect(await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, CAREER, PERMISSION.READ])).toBe(false)
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, CAREER])).toBe(2n)
    const epoch2 = deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 2n)
    expect(await read<Hex>("epochPublicKey", [vault.owner, CAREER, 2n])).toBe(hexOf(epoch2.publicKey))
  })

  it("never places a namespace secret or epoch private key in an approval, wrap or upload", async () => {
    const secret = await vault.deriveNamespaceSecret(CAREER)
    const forbidden = [secret, deriveEpochKeyPair(secret, 1n).privateKey, deriveEpochKeyPair(secret, 2n).privateKey].map((bytes) =>
      hexOf(bytes).slice(2),
    )
    const serialized = JSON.stringify([approvals, recorded], (_key, value) => (typeof value === "bigint" ? value.toString() : value))
    for (const hex of forbidden) expect(serialized.includes(hex)).toBe(false)
  })
})

describe("FakeVault assertion construction (spec §8, §10.4)", () => {
  const KEY: Hex = `0x${"4d".repeat(32)}`
  const OTHER_KEY: Hex = `0x${"4e".repeat(32)}`
  const CHALLENGE: Hex = `0x${"ab".repeat(32)}`
  const RP_ID = "vault.mida.xyz"
  const ORIGIN = "https://vault.mida.xyz"
  const bytes32 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

  it("signs the ox signing digest with noble, emits low-s, and passes WebAuthnP256.verify", () => {
    const auth = signVaultAssertion({ challenge: CHALLENGE, privateKey: KEY, rpId: RP_ID, origin: ORIGIN })
    expect(auth.s <= P256_N / 2n).toBe(true)
    const { metadata } = WebAuthnP256.getSignPayload({ challenge: CHALLENGE, rpId: RP_ID, origin: ORIGIN, userVerification: "required" })
    expect(auth.authenticatorData).toBe(metadata.authenticatorData)
    expect(auth.clientDataJSON).toBe(metadata.clientDataJSON)
    const signature = { r: bytes32(auth.r), s: bytes32(auth.s), yParity: 0 }
    const publicKey = P256.getPublicKey({ privateKey: KEY })
    expect(WebAuthnP256.verify({ challenge: CHALLENGE, metadata, publicKey, rpId: RP_ID, origin: ORIGIN, signature })).toBe(true)
  })

  it("normalizes a forced high-s raw signature through the shared adapter", () => {
    const { metadata, digest } = vaultSignPayload({ challenge: CHALLENGE, rpId: RP_ID, origin: ORIGIN })
    const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(KEY.slice(2)), { prehash: false })
    const r = BigInt(`0x${bytesToHex(raw.slice(0, 32))}`)
    const lowS = BigInt(`0x${bytesToHex(raw.slice(32))}`)
    const highS = P256_N - lowS
    expect(highS > P256_N / 2n).toBe(true)
    const auth = completeVaultAssertion({ challenge: CHALLENGE, metadata, r, s: highS, publicKey: p256PublicKey(KEY), rpId: RP_ID, origin: ORIGIN })
    expect(auth.s).toBe(lowS)
    expect(auth.r).toBe(r)
  })

  it("refuses to return an assertion that WebAuthnP256.verify rejects", () => {
    const { metadata, digest } = vaultSignPayload({ challenge: CHALLENGE, rpId: RP_ID, origin: ORIGIN })
    const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(KEY.slice(2)), { prehash: false })
    const r = BigInt(`0x${bytesToHex(raw.slice(0, 32))}`)
    const s = BigInt(`0x${bytesToHex(raw.slice(32))}`)
    expect(() =>
      completeVaultAssertion({ challenge: CHALLENGE, metadata, r, s, publicKey: p256PublicKey(OTHER_KEY), rpId: RP_ID, origin: ORIGIN }),
    ).toThrow(expect.objectContaining({ code: "AUTH_INVALID" }))
    expect(() =>
      completeVaultAssertion({ challenge: `0x${"ac".repeat(32)}`, metadata, r, s, publicKey: p256PublicKey(KEY), rpId: RP_ID, origin: ORIGIN }),
    ).toThrow(expect.objectContaining({ code: "AUTH_INVALID" }))
  })
})
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm vitest run packages/fake-vault`
Expected: FAIL. Vitest cannot resolve `@mida/fake-vault`, because `packages/fake-vault/src/index.ts` does not exist yet.

- [ ] **Step 6: Implement the PRF stand-in, passkey assertions, the API port and the agent fixtures**

`packages/fake-vault/src/prf.ts`:
```ts
import type { IsolationDomain } from "@mida/protocol"
import { assertNonZeroKey, prfSalt } from "@mida/crypto"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"

/**
 * Deterministic stand-in for one WebAuthn PRF evaluation (§6.1): HMAC-SHA256(seed, domain salt), the same shape as
 * a real authenticator's PRF. There is deliberately no function that returns a global root; callers only ever get
 * one domain's output, and FakeVaultAuthority keeps even that private.
 */
export function fakePrfOutput(seed: Uint8Array, domain: IsolationDomain): Uint8Array {
  assertNonZeroKey(seed, "fake vault seed")
  return hmac(sha256, seed, prfSalt(domain))
}
```

`packages/fake-vault/src/webauthn.ts`:
```ts
import { MidaError, toWebAuthnAuthStruct } from "@mida/protocol"
import type { Hex, WebAuthnAuthStruct } from "@mida/protocol"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { P256, WebAuthnP256 } from "ox"

/** WebAuthn-shaped metadata as ox builds it: authenticatorData, clientDataJSON and the field indexes webauthn-sol needs. */
export type VaultAssertionMetadata = ReturnType<typeof WebAuthnP256.getSignPayload>["metadata"]

/** JSON-safe form sent to the Context API for deny cancellation (§12.5). */
export interface WebAuthnAssertionWire {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: string
  typeIndex: string
  r: Hex
  s: Hex
}

const bytes32 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

export function p256PublicKey(privateKey: Hex): { qx: bigint; qy: bigint } {
  const publicKey = P256.getPublicKey({ privateKey })
  return { qx: BigInt(publicKey.x), qy: BigInt(publicKey.y) }
}

/**
 * Spec §8: ox builds the metadata and the exact authenticator signing digest,
 * SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)), for user verification required.
 */
export function vaultSignPayload(input: { challenge: Hex; rpId: string; origin: string }): { metadata: VaultAssertionMetadata; digest: Hex } {
  const { metadata, payload } = WebAuthnP256.getSignPayload({
    challenge: input.challenge,
    rpId: input.rpId,
    origin: input.origin,
    userVerification: "required",
    hash: true,
  })
  return { metadata, digest: payload }
}

/**
 * Converts a raw P256 signature over `vaultSignPayload`'s digest through the shared low-s adapter, then refuses to
 * return it unless ox `WebAuthnP256.verify` accepts the normalized assertion for this challenge, RP ID and origin.
 */
export function completeVaultAssertion(input: {
  challenge: Hex
  metadata: VaultAssertionMetadata
  r: bigint
  s: bigint
  publicKey: { qx: bigint; qy: bigint }
  rpId: string
  origin: string
}): WebAuthnAuthStruct {
  const { metadata } = input
  if (metadata.challengeIndex === undefined || metadata.typeIndex === undefined) {
    throw new MidaError("AUTH_INVALID", "assertion metadata lacks clientDataJSON challenge and type indexes")
  }
  const auth = toWebAuthnAuthStruct({
    authenticatorData: metadata.authenticatorData,
    clientDataJSON: metadata.clientDataJSON,
    challengeIndex: metadata.challengeIndex,
    typeIndex: metadata.typeIndex,
    r: input.r,
    s: input.s,
  })
  const verified = WebAuthnP256.verify({
    challenge: input.challenge,
    metadata,
    rpId: input.rpId,
    origin: input.origin,
    publicKey: { prefix: 4, x: bytes32(input.publicKey.qx), y: bytes32(input.publicKey.qy) },
    signature: { r: bytes32(auth.r), s: bytes32(auth.s), yParity: 0 },
  })
  if (!verified) throw new MidaError("AUTH_INVALID", "normalized assertion does not pass WebAuthnP256.verify")
  return auth
}

/**
 * Software passkey assertion (spec §8, §13.4): ox digest, a raw `@noble/curves` P256 signature with either s, the
 * shared low-s adapter, and an ox verification parity check.
 */
export function signVaultAssertion(input: { challenge: Hex; privateKey: Hex; rpId: string; origin: string }): WebAuthnAuthStruct {
  const { metadata, digest } = vaultSignPayload(input)
  const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(input.privateKey.slice(2)), { prehash: false, lowS: false })
  return completeVaultAssertion({
    challenge: input.challenge,
    metadata,
    r: BigInt(`0x${bytesToHex(raw.slice(0, 32))}`),
    s: BigInt(`0x${bytesToHex(raw.slice(32))}`),
    publicKey: p256PublicKey(input.privateKey),
    rpId: input.rpId,
    origin: input.origin,
  })
}

export function assertionToWire(auth: WebAuthnAuthStruct): WebAuthnAssertionWire {
  return {
    authenticatorData: auth.authenticatorData,
    clientDataJSON: auth.clientDataJSON,
    challengeIndex: auth.challengeIndex.toString(10),
    typeIndex: auth.typeIndex.toString(10),
    r: bytes32(auth.r),
    s: bytes32(auth.s),
  }
}
```

`packages/fake-vault/src/ports.ts`:
```ts
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"

/**
 * The only Context API calls the Vault makes. Defined here as a port so the Vault does not depend on the API
 * package; `ContextApiClient` (plan Task 24) implements it structurally, and the CLI (Task 26) wires the two.
 */
export interface VaultContextApi {
  putObject(upload: {
    owner: Address
    namespaceId: Hex
    objectNonce: Hex
    expectedParentId: Hex
    manifest: ObjectManifest
    ciphertext: Hex
  }): Promise<unknown>
  publishEpochWrap(wrap: ReaderEpochWrap): Promise<unknown>
  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }): Promise<{ intentId: Hex }>
}
```

`packages/fake-vault/src/agents.ts`:
```ts
import {
  NAMESPACE_TREE_VERSION,
  POLICY_VERSION,
  accessRequestTypedData,
  canonicalizeNamespace,
  agentId as deriveAgentId,
  encodeUint64,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type {
  AccessRequest,
  Hex,
  Permission,
  ProvenancePolicy,
  PurposeId,
  SignedAgentCapabilityManifest,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { generateX25519KeyPair, hexOf } from "@mida/crypto"
import { latestTimestamp, registerAgent } from "@mida/chain"
import type { ChainContext, LocalWriteContext } from "@mida/chain"
import { manifestBindingFor, manifestBodyHash } from "@mida/grant-advisor"
import { randomBytes } from "@noble/hashes/utils.js"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

export interface AgentDeclaration {
  namespace: string
  permissions: Permission[]
  provenancePolicies?: ProvenancePolicy[]
  reason?: string
}

export interface ProvisionedAgent {
  agentId: Hex
  signer: LocalAccount
  encryptionPrivateKey: Uint8Array
  encryptionPublicKey: Hex
  callbackOrigin: string
  purposeId: PurposeId
  manifest: SignedAgentCapabilityManifest
  manifestHash: Hex
}

/**
 * Test and demo tooling: an operator signs a manifest body, a fresh signer accepts registration, and the agent is
 * registered with its X25519 key. Private keys stay in memory; nothing here is persisted.
 */
export async function provisionAgent(input: {
  operator: LocalWriteContext
  name: string
  purposeId: PurposeId
  declarations: readonly AgentDeclaration[]
  callbackOrigin: string
  signer?: LocalAccount
}): Promise<ProvisionedAgent> {
  const { deployment } = input.operator
  const agentSalt = hexOf(randomBytes(32))
  const agentId = deriveAgentId({
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    operator: input.operator.account.address,
    agentSalt,
  })
  const now = await latestTimestamp(input.operator)
  const body = {
    v: 1 as const,
    agentId,
    manifestVersion: 1,
    name: input.name,
    purposes: [{ id: input.purposeId, description: `${input.name} ${input.purposeId}` }],
    scopeDeclarations: input.declarations.map((declaration) => ({
      purposeId: input.purposeId,
      namespace: declaration.namespace,
      permissions: declaration.permissions,
      ...(declaration.provenancePolicies === undefined ? {} : { provenancePolicies: declaration.provenancePolicies }),
      reason: declaration.reason ?? `Needed for ${input.purposeId}`,
    })),
    issuedAt: Number(now) - 60,
  }
  const manifestHash = manifestBodyHash(body)
  const operatorSignature = await input.operator.account.signTypedData(
    manifestBindingFor({ chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, body }) as never,
  )
  const signer = input.signer ?? privateKeyToAccount(generatePrivateKey())
  const encryption = generateX25519KeyPair()
  const registered = await registerAgent(input.operator, {
    agentSalt,
    signer,
    encryptionPublicKey: hexOf(encryption.publicKey),
    callbackOrigin: input.callbackOrigin,
    capabilityManifestHash: manifestHash,
  })
  if (registered.agentId !== agentId) throw new Error("registered agentId differs from the derived agentId")
  return {
    agentId,
    signer,
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: hexOf(encryption.publicKey),
    callbackOrigin: input.callbackOrigin,
    purposeId: input.purposeId,
    manifest: { manifest: body, operatorSignature },
    manifestHash,
  }
}

/**
 * Test fixture for Tasks 22–24, before the SDK exists: an exact, sorted, agent-signed request valid for five minutes
 * from the latest block. Task 25's MidaAgent.createAccessRequest is the production path.
 */
export async function buildSignedAccessRequest(input: {
  chain: ChainContext
  agent: ProvisionedAgent
  scopes: ReadonlyArray<{ namespace: string; permissions: number; provenancePolicy?: number }>
  overrides?: Partial<UnsignedAccessRequest>
}): Promise<AccessRequest> {
  const { deployment } = input.chain
  const now = await latestTimestamp(input.chain)
  const unsigned: UnsignedAccessRequest = {
    v: 1,
    chainId: encodeUint64(deployment.chainId),
    capabilityRegistry: deployment.capabilityRegistry,
    requestId: hexOf(randomBytes(32)),
    nonce: hexOf(randomBytes(32)),
    agentId: input.agent.agentId,
    purposeId: input.agent.purposeId,
    callbackOrigin: input.agent.callbackOrigin,
    manifestHash: input.agent.manifestHash,
    manifestVersion: input.agent.manifest.manifest.manifestVersion,
    policyVersion: POLICY_VERSION,
    namespaceTreeVersion: NAMESPACE_TREE_VERSION,
    scopes: sortScopes(
      input.scopes.map((scope) => ({
        namespaceId: namespaceId(canonicalizeNamespace(scope.namespace)),
        permissions: scope.permissions,
        provenancePolicy: scope.provenancePolicy ?? 0,
      })),
    ),
    issuedAt: encodeUint64(now),
    requestExpiresAt: encodeUint64(now + 300n),
    capabilityExpiresAt: "0",
    ...input.overrides,
  }
  return { ...unsigned, agentSignature: await input.agent.signer.signTypedData(accessRequestTypedData(unsigned) as never) }
}
```

- [ ] **Step 7: Implement `FakeVaultAuthority`**

`packages/fake-vault/src/fake-vault.ts`:
```ts
import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  MidaError,
  NAMESPACE_TREE_VERSION,
  OWNER_AUTHOR_ID,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  accessRequestHash,
  cancelFastRevokeDigest,
  canonicalizeNamespace,
  contextId as deriveContextId,
  decodeUint64,
  encodeUint64,
  grantDigest,
  hashString,
  namespaceById,
  namespaceId as toNamespaceId,
  originHash,
  sortScopes,
} from "@mida/protocol"
import type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  ContextPayload,
  GrantAdvice,
  GrantScope,
  GrantedCapability,
  Hex,
  LineagePolicy,
  SignedAgentCapabilityManifest,
  WebAuthnAuthStruct,
} from "@mida/protocol"
import {
  assertNonZeroKey,
  bytesOf,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  hexOf,
  sealContextObject,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { EpochKeyPair } from "@mida/crypto"
import {
  capabilityRegistryAbi,
  contextRegistryAbi,
  latestTimestamp,
  ownerHistory,
  readAgentRecord,
  sendContract,
  toMidaError,
} from "@mida/chain"
import type { WriteContext } from "@mida/chain"
import { POLICY_HASH_V1, adviseGrant, assertFinalSelection } from "@mida/grant-advisor"
import { randomBytes } from "@noble/hashes/utils.js"
import { parseEventLogs, zeroHash } from "viem"
import type { Abi, TransactionReceipt } from "viem"
import { fakePrfOutput } from "./prf.js"
import type { VaultContextApi } from "./ports.js"
import { assertionToWire, p256PublicKey, signVaultAssertion } from "./webauthn.js"
import type { WebAuthnAssertionWire } from "./webauthn.js"

/** §4.2 VaultAuthority. The Vault is the only component that derives passkey-controlled namespace secrets. */
export interface VaultAuthority {
  deriveNamespaceSecret(namespaceId: Hex): Promise<Uint8Array>
  approveGrant(request: GrantRequest): Promise<GrantApproval>
  approveRevocation(request: RevokeRequest): Promise<RevokeApproval>
}

export type GrantSelection = { kind: "recommended" } | { kind: "custom"; scopes: GrantScope[]; expiresAt: bigint }

export interface GrantRequest {
  accessRequest: AccessRequest
  manifest: SignedAgentCapabilityManifest
  selection: GrantSelection
}

/** Returned to the owner's app: advice, the grant receipt and gas. No key material. */
export interface GrantApproval {
  advice: GrantAdvice
  response: AccessGrantResponse
  gasUsed: bigint
}

export type RevokeRequest = { kind: "capability"; capabilityId: Hex } | { kind: "agent"; agentId: Hex }

export interface RevokeApproval {
  intentId: Hex
  transactionHash: Hex
  rotated: Array<{ namespaceId: Hex; readEpoch: bigint }>
}

export interface FakeVaultConfig {
  /** 32 non-zero test bytes standing in for the passkey's PRF secret. Never a production secret. */
  seed: Uint8Array
  /** Software P256 key standing in for the passkey credential. */
  p256PrivateKey: Hex
  /** Owner EOA write context; `account` is the owner. */
  chain: WriteContext
  api: VaultContextApi
  /** Defaults to https://<deployment.vaultRpId>. */
  origin?: string
}

interface CapabilityView {
  owner: Address
  agentId: Hex
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: bigint
  revoked: boolean
}

export function toAccessRequestStruct(request: AccessRequest) {
  return {
    requestId: request.requestId,
    nonce: request.nonce,
    agentId: request.agentId,
    purposeIdHash: hashString(request.purposeId),
    callbackOriginHash: originHash(request.callbackOrigin),
    manifestHash: request.manifestHash,
    manifestVersion: BigInt(request.manifestVersion),
    policyVersionHash: hashString(request.policyVersion),
    namespaceTreeVersionHash: hashString(request.namespaceTreeVersion),
    issuedAt: decodeUint64(request.issuedAt),
    requestExpiresAt: decodeUint64(request.requestExpiresAt),
    capabilityExpiresAt: decodeUint64(request.capabilityExpiresAt),
    scopes: request.scopes.map((scope) => ({
      namespaceId: scope.namespaceId,
      permissions: scope.permissions,
      provenancePolicy: scope.provenancePolicy,
    })),
    agentSignature: request.agentSignature,
  }
}

/**
 * Project 1 software Vault (§13.4). Secrets live in private fields and never cross its public surface except
 * through the §4.2 `deriveNamespaceSecret` boundary, which only owner-side code holds. Approvals, wraps and uploads
 * carry public keys, ciphertext and wrapped keys only.
 */
export class FakeVaultAuthority implements VaultAuthority {
  readonly owner: Address
  readonly #seed: Uint8Array
  readonly #p256PrivateKey: Hex
  readonly #chain: WriteContext
  readonly #api: VaultContextApi
  readonly #origin: string

  constructor(config: FakeVaultConfig) {
    if (config.chain.deployment.policyHashV1 !== POLICY_HASH_V1) {
      throw new MidaError("POLICY_VERSION_UNSUPPORTED", "deployed POLICY_HASH_V1 differs from this Vault's policy")
    }
    assertNonZeroKey(config.seed, "fake vault seed")
    this.#seed = Uint8Array.from(config.seed)
    this.#p256PrivateKey = config.p256PrivateKey
    this.#chain = config.chain
    this.#api = config.api
    this.#origin = config.origin ?? `https://${config.chain.deployment.vaultRpId}`
    this.owner = config.chain.account.address.toLowerCase() as Address
  }

  get p256PublicKey(): { qx: bigint; qy: bigint } {
    return p256PublicKey(this.#p256PrivateKey)
  }

  async deriveNamespaceSecret(namespaceId: Hex): Promise<Uint8Array> {
    const node = namespaceById(namespaceId)
    return deriveNamespaceSecret(fakePrfOutput(this.#seed, node.domain), node.id)
  }

  async registerOwnerKey(): Promise<Hex> {
    const { qx, qy } = this.p256PublicKey
    return (await this.#sendCapability("registerP256Key", [qx, qy])).transactionHash
  }

  async initializeNamespace(namespace: string): Promise<Hex> {
    const id = toNamespaceId(canonicalizeNamespace(namespace))
    const keys = await this.#epochKeys(id, 1n)
    return (await this.#sendCapability("initializeReadEpoch", [id, hexOf(keys.publicKey)])).transactionHash
  }

  async approveGrant(request: GrantRequest): Promise<GrantApproval> {
    const { accessRequest } = request
    const { deployment } = this.#chain
    // Part C handoff: the Advisor verifies signatures under the request's own domain, so the Vault pins the network.
    if (
      decodeUint64(accessRequest.chainId) !== deployment.chainId ||
      accessRequest.capabilityRegistry.toLowerCase() !== deployment.capabilityRegistry
    ) {
      throw new MidaError("INVALID_WIRE", "access request targets a different chain or registry than this Vault")
    }
    const agentRecord = await readAgentRecord(this.#chain, accessRequest.agentId)
    const history = await ownerHistory({
      client: this.#chain.publicClient,
      deployment,
      owner: this.owner,
      agentId: accessRequest.agentId,
    })
    const now = await latestTimestamp(this.#chain)
    const advice = adviseGrant({ request: accessRequest, manifest: request.manifest, agentRecord, ownerHistory: history, now })

    const selected =
      request.selection.kind === "recommended"
        ? { scopes: advice.recommended, expiresAt: decodeUint64(advice.recommendedExpiresAt) }
        : { scopes: sortScopes(request.selection.scopes), expiresAt: request.selection.expiresAt }
    if (selected.scopes.length === 0) throw new MidaError("CAPABILITY_DENIED", "nothing was selected to grant")
    assertFinalSelection({
      requestedScopes: accessRequest.scopes,
      requestedExpiresAt: decodeUint64(accessRequest.capabilityExpiresAt),
      finalScopes: selected.scopes,
      finalExpiresAt: selected.expiresAt,
      now,
    })

    const { agentSignature: _signature, ...unsigned } = accessRequest
    const requestHash = accessRequestHash(unsigned)
    const nonce = await this.#readCapability<bigint>("grantNonce", [this.owner])
    const challenge = grantDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner: this.owner,
      agentId: accessRequest.agentId,
      requestHash,
      manifestHash: accessRequest.manifestHash,
      manifestVersion: BigInt(accessRequest.manifestVersion),
      finalScopes: selected.scopes,
      expiresAt: selected.expiresAt,
      grantNonce: nonce,
    })
    const receipt = await this.#sendCapability("grantBatch", [
      toAccessRequestStruct(accessRequest),
      selected.scopes,
      selected.expiresAt,
      this.#assert(challenge),
    ])

    const capabilities: GrantedCapability[] = parseEventLogs({
      abi: capabilityRegistryAbi,
      eventName: "CapabilityGranted",
      logs: receipt.logs,
    }).map((log) => ({
      namespaceId: log.args.namespaceId,
      permissions: log.args.permissions,
      provenancePolicy: log.args.provenancePolicy,
      expiresAt: encodeUint64(log.args.expiresAt),
      capabilityId: log.args.capabilityId,
      transactionHash: receipt.transactionHash,
    }))
    const response: AccessGrantResponse = {
      v: 1,
      chainId: accessRequest.chainId,
      capabilityRegistry: accessRequest.capabilityRegistry,
      requestId: accessRequest.requestId,
      nonce: accessRequest.nonce,
      requestHash,
      owner: this.owner,
      agentId: accessRequest.agentId,
      manifestHash: accessRequest.manifestHash,
      manifestVersion: accessRequest.manifestVersion,
      policyVersion: POLICY_VERSION,
      namespaceTreeVersion: NAMESPACE_TREE_VERSION,
      capabilities,
    }
    // §13.4: wraps are published only now that the chain holds the READ capability.
    for (const capability of capabilities) {
      if ((capability.permissions & PERMISSION.READ) !== 0) {
        await this.publishReaderWraps({ agentId: accessRequest.agentId, namespaceId: capability.namespaceId })
      }
    }
    return { advice, response, gasUsed: receipt.gasUsed }
  }

  /** Publishes one wrap per registered epoch (current and historical, §10.3) for an agent that holds live exact READ. */
  async publishReaderWraps(input: { agentId: Hex; namespaceId: Hex }): Promise<bigint[]> {
    const { deployment } = this.#chain
    const authorized = await this.#readCapability<boolean>("hasAuthority", [
      this.owner,
      input.agentId,
      input.namespaceId,
      PERMISSION.READ,
      0,
    ])
    if (!authorized) throw new MidaError("CAPABILITY_DENIED", "agent has no live exact READ capability; no wrap published")
    const agent = await readAgentRecord(this.#chain, input.agentId)
    const required = await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, input.namespaceId])
    const createdAt = await latestTimestamp(this.#chain)
    const published: bigint[] = []
    for (let epoch = 1n; epoch <= required; epoch++) {
      const onChain = await this.#readCapability<Hex>("epochPublicKey", [this.owner, input.namespaceId, epoch])
      if (onChain === zeroHash) continue
      const keys = await this.#epochKeys(input.namespaceId, epoch, onChain)
      await this.#api.publishEpochWrap(
        wrapEpochPrivateKeyToAgent({
          epochPrivateKey: keys.privateKey,
          agentEncryptionPublicKey: bytesOf(agent.encryptionPublicKey, 32),
          binding: {
            chainId: deployment.chainId,
            capabilityRegistry: deployment.capabilityRegistry,
            owner: this.owner,
            namespaceId: input.namespaceId,
            readEpoch: epoch,
            agentId: input.agentId,
            agentKeyVersion: agent.encryptionKeyVersion,
          },
          createdAt,
        }),
      )
      published.push(epoch)
    }
    return published
  }

  /** §7.3 and §16 steps 13–14: the local deny is posted first, then one owner transaction revokes and rotates. */
  async approveRevocation(request: RevokeRequest): Promise<RevokeApproval> {
    if (request.kind === "capability") {
      const capability = await this.#readCapability<CapabilityView>("getCapability", [request.capabilityId])
      if (capability.owner.toLowerCase() !== this.owner) {
        throw new MidaError("CAPABILITY_DENIED", "capability belongs to another owner")
      }
      const live = await this.#readCapability<boolean>("isCapabilityValid", [request.capabilityId])
      const endsRead = live && (capability.permissions & PERMISSION.READ) !== 0
      const { intentId } = await this.#api.requestRevocationDeny({ capabilityId: request.capabilityId })
      if (!endsRead) {
        const receipt = await this.#sendCapability("revoke", [request.capabilityId])
        return { intentId, transactionHash: receipt.transactionHash, rotated: [] }
      }
      const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, capability.namespaceId])) + 1n
      const keys = await this.#epochKeys(capability.namespaceId, next)
      const receipt = await this.#sendCapability("revokeAndRotate", [request.capabilityId, hexOf(keys.publicKey)])
      return { intentId, transactionHash: receipt.transactionHash, rotated: [{ namespaceId: capability.namespaceId, readEpoch: next }] }
    }

    const ids = await this.#readCapability<readonly Hex[]>("activeCapabilityIds", [this.owner, request.agentId])
    const readNamespaces: Hex[] = []
    for (const id of ids) {
      const capability = await this.#readCapability<CapabilityView>("getCapability", [id])
      const live = await this.#readCapability<boolean>("isCapabilityValid", [id])
      if (live && (capability.permissions & PERMISSION.READ) !== 0 && !readNamespaces.includes(capability.namespaceId)) {
        readNamespaces.push(capability.namespaceId)
      }
    }
    const rotations: Array<{ namespaceId: Hex; newEpochPublicKey: Hex }> = []
    const rotated: RevokeApproval["rotated"] = []
    for (const namespaceId of readNamespaces) {
      const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])) + 1n
      rotations.push({ namespaceId, newEpochPublicKey: hexOf((await this.#epochKeys(namespaceId, next)).publicKey) })
      rotated.push({ namespaceId, readEpoch: next })
    }
    const { intentId } = await this.#api.requestRevocationDeny({ owner: this.owner, agentId: request.agentId })
    const receipt = await this.#sendCapability("revokeAgentAndRotate", [request.agentId, rotations])
    return { intentId, transactionHash: receipt.transactionHash, rotated }
  }

  /** §7.3 expiry: resumes writes after the earliest READ expiry closed the epoch. */
  async rotateExpiredEpoch(namespaceId: Hex): Promise<{ transactionHash: Hex; readEpoch: bigint }> {
    const next = (await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])) + 1n
    const keys = await this.#epochKeys(namespaceId, next)
    const receipt = await this.#sendCapability("rotateExpiredEpoch", [namespaceId, hexOf(keys.publicKey)])
    return { transactionHash: receipt.transactionHash, readEpoch: next }
  }

  /** §12.5 deny cancellation restores authority, so it needs a fresh passkey assertion with UV. */
  approveDenyCancellation(input: { revocationIntentId: Hex; apiCancellationNonce: bigint; expiresAt: bigint }): WebAuthnAssertionWire {
    const { deployment } = this.#chain
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner: this.owner,
      revocationIntentId: input.revocationIntentId,
      apiCancellationNonce: input.apiCancellationNonce,
      expiresAt: input.expiresAt,
    })
    return assertionToWire(this.#assert(challenge))
  }

  /** Owner-authored context (§11.5): ciphertext is uploaded as pending first, then the commitments are anchored. */
  async createOwnerContext(input: {
    namespace: string
    payload: ContextPayload
    lineagePolicy?: LineagePolicy
    expectedParentId?: Hex
    evidenceCommitment?: Hex
    expiresAt?: bigint
  }): Promise<{ contextId: Hex; readEpoch: bigint; manifestHash: Hex; transactionHash: Hex }> {
    const { deployment } = this.#chain
    const namespaceId = toNamespaceId(canonicalizeNamespace(input.namespace))
    const readEpoch = await this.#readCapability<bigint>("requiredReadEpoch", [this.owner, namespaceId])
    const onChain = await this.#readCapability<Hex>("epochPublicKey", [this.owner, namespaceId, readEpoch])
    const keys = await this.#epochKeys(namespaceId, readEpoch, onChain)
    const objectNonce = hexOf(randomBytes(32))
    const contextId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: this.owner,
      authorId: OWNER_AUTHOR_ID,
      namespaceId,
      objectNonce,
    })
    const sealed = sealContextObject({
      payload: input.payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId, readEpoch },
      epochPublicKey: keys.publicKey,
    })
    const expectedParentId = input.expectedParentId ?? zeroHash
    await this.#api.putObject({
      owner: this.owner,
      namespaceId,
      objectNonce,
      expectedParentId,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
    })
    const receipt = await this.#send(contextRegistryAbi, deployment.contextRegistry, "register", [
      this.owner,
      [
        {
          contextId,
          objectNonce,
          namespaceId,
          expectedParentId,
          manifestHash: sealed.manifestHash,
          ciphertextCommitment: sealed.ciphertextCommitment,
          evidenceCommitment: input.evidenceCommitment ?? zeroHash,
          readEpoch,
          expiresAt: input.expiresAt ?? 0n,
          recordType: RECORD_TYPE.CONTEXT,
          lineagePolicy: LINEAGE_POLICY[input.lineagePolicy ?? "STANDARD"],
          kind: CONTEXT_KIND[input.payload.kind],
          provenanceSource: PROVENANCE_SOURCE[input.payload.provenance.source],
        },
      ],
    ])
    return { contextId, readEpoch, manifestHash: sealed.manifestHash, transactionHash: receipt.transactionHash }
  }

  async #epochKeys(namespaceId: Hex, epoch: bigint, expectedPublicKey?: Hex): Promise<EpochKeyPair> {
    const keys = deriveEpochKeyPair(await this.deriveNamespaceSecret(namespaceId), epoch)
    if (expectedPublicKey !== undefined && hexOf(keys.publicKey) !== expectedPublicKey.toLowerCase()) {
      // §11.1: the contract cannot prove key derivation; a mismatch means this seed is not the key's owner.
      throw new MidaError("COMMITMENT_MISMATCH", `derived epoch ${epoch} public key differs from the published key`)
    }
    return keys
  }

  #assert(challenge: Hex): WebAuthnAuthStruct {
    const rpId = this.#chain.deployment.vaultRpId
    return signVaultAssertion({ challenge, privateKey: this.#p256PrivateKey, rpId, origin: this.#origin })
  }

  async #readCapability<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    try {
      return (await this.#chain.publicClient.readContract({
        address: this.#chain.deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName,
        args,
      } as never)) as T
    } catch (error) {
      throw toMidaError(error)
    }
  }

  #sendCapability(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    return this.#send(capabilityRegistryAbi, this.#chain.deployment.capabilityRegistry, functionName, args)
  }

  #send(abi: Abi, address: Address, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    return sendContract(this.#chain, { address, abi, functionName, args })
  }
}
```

`packages/fake-vault/src/index.ts`:
```ts
export * from "./prf.js"
export * from "./webauthn.js"
export * from "./ports.js"
export * from "./agents.js"
export * from "./fake-vault.js"
```

- [ ] **Step 8: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/protocol/test/webauthn-assertion.test.ts packages/fake-vault
pnpm typecheck
```
Expected: `Test Files 2 passed`, `Tests 18 passed` (5 adapter tests and 13 Vault tests). Typecheck exits 0. The passing test proves:
- **Assertions follow spec §8.** The digest comes from ox, the signature from noble, `s` is normalized by the shared adapter, and ox `WebAuthnP256.verify` accepts the result. A forced high-s signature comes out low-s; a wrong key or challenge throws `AUTH_INVALID`.
- **PRF output is per domain.** It is `HMAC-SHA256(seed, domain salt)`, and the Vault exposes no enumerable secret.
- **The policy guard works.** A deployment with a different `POLICY_HASH_V1` is refused.
- **The epoch-1 key matches the derivation.** The published key equals the derived key.
- **No wrap before authorization.** Nothing is published until the chain holds READ.
- **The §16 grant narrows correctly.** READ goals.career plus READ financial becomes READ goals.career only, with HIGH and suspicious warnings. A's wrap unwraps to the derived epoch key, and another agent's key cannot open it.
- **Bad selections never reach the chain.** A request for another chain, and a custom selection broader than the request, both fail before any transaction.
- **Owner context round-trips.** Its ciphertext is uploaded first, its commitments are anchored, and it decrypts.
- **The deny comes first.** It is posted while the chain still authorizes; revocation then rotates to epoch 2.
- **No secret leaks.** No namespace secret or epoch private key appears in any approval, wrap or upload.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml packages/protocol/src/webauthn-assertion.ts packages/protocol/src/index.ts packages/protocol/test/webauthn-assertion.test.ts packages/fake-vault
git commit -m "feat(fake-vault): software Vault with deterministic PRF domains, passkey-bound grants and rotating revocation

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 23: Context API: request authentication, ordered authorization, deny overlay

**Depends on:** Task 22 (tests only use its assertion signer and fixtures).

**Files:**
- Create: `apps/api/package.json`, `apps/api/src/chain-views.ts`, `apps/api/src/errors.ts`, `apps/api/src/auth.ts`, `apps/api/src/verify-assertion.ts`, `apps/api/src/deny-overlay.ts`, `apps/api/src/authorize.ts`, `apps/api/src/client.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`
- Modify: root `package.json` (dependency `"@mida/api": "workspace:*"`)
- Test: `apps/api/test/verify-assertion.test.ts`, `apps/api/test/auth.test.ts`, `apps/api/test/authorization.test.ts`

`app.ts`, `client.ts`, `deny-overlay.ts` and `index.ts` are this task's stage. Task 24 replaces or extends each of them.

**Interfaces:**
- Consumes: Part A `MidaError`, `MIDA_ERROR_CODES`, `assertHex`, `canonicalTarget`, `httpRequestTypedData`, `cancelFastRevokeDigest`; Part B `hexOf`; Part C `isTypedDataSignedBy`; Task 21 `capabilityRegistryAbi`, `contextRegistryAbi`, `latestTimestamp`, `readAgentRecord`, `toMidaError`, types `ChainContext`, `Deployment`.
- Produces, `chain-views.ts`: `interface CapabilityView` (§10.3 fields), `interface ContextRecordView` (§11.3 fields), `class RegistryReader { readonly context; now(); agentIdOfSigner(signer): Promise<Hex | null>; getAgent(agentId): Promise<AgentRecord | null>; getCapability(id): Promise<CapabilityView | null>; agentEpoch(owner, agentId); hasAuthority(owner, agentId, namespaceId, permissions, provenanceBits); requiredReadEpoch(owner, namespaceId); epochPublicKey(owner, namespaceId, epoch): Promise<Hex | null>; isWriteEpochValid(owner, namespaceId, epoch); ownerP256Key(owner): Promise<{ qx; qy } | null>; getRecord(contextId): Promise<ContextRecordView | null> }`.
- Produces, `errors.ts`: `interface ApiErrorBody`, `statusFor(code)`, `toErrorBody(error)`, `errorFromBody(status, body)`.
- Produces, `auth.ts`: `AUTH_HEADERS` (`x-mida-signer`, `x-mida-timestamp`, `x-mida-nonce`, `x-mida-signature`), `REQUEST_WINDOW_SECONDS = 60n`, `targetOf(url: URL): string`, `class ReplayGuard { constructor(file: string); consume(signer, nonce, signedAt: bigint, now: bigint) }` (durable: loads `file` on start, persists before returning), `authenticateRequest({ method; url; headers; body; chainId; capabilityRegistry; now; replay }): Address`.
- Produces, `verify-assertion.ts`: `interface WebAuthnAssertionInput`, `verifyVaultAssertion({ challenge; assertion; qx; qy; rpIdHash }): boolean`.
- Produces, `deny-overlay.ts`: `type RevocationTarget`, `type DenyState = "active" | "anchored" | "cancelled"`, `interface RevocationIntent`, `class DenyOverlay { constructor(file); list(); get(id); create(owner, target, agentEpochAtIntent); denies({ owner; agentId; capabilityId }); reconcile(reader); cancel(id, owner, nonce) }`.
- Produces, `authorize.ts`: `interface AgentAuthorization { agentId; agent; capability; now }`, `authorizeAgent({ reader; overlay; signer; owner; capabilityId; namespaceId; permission; agentKeyVersion? }): Promise<AgentAuthorization>`.
- Produces, `client.ts` (stage): `interface ContextApiClientOptions`, `class ContextApiClient { account; request<T>(method, path, { query?; body?; signed? }) }`.
- Produces, `app.ts` (stage): `CANCELLATION_MAX_LIFETIME_SECONDS = 300n`, `interface ContextApiOptions { reader; deployment; dataDir; clock? }`, `createContextApi(options): { app; overlay }` with `POST /revocations` and `POST /revocations/:id/cancel`. The replay record lives at `<dataDir>/replay-nonces.json`.

- [ ] **Step 1: Create the package manifest**

`apps/api/package.json`:
```json
{
  "name": "@mida/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@hono/node-server": "1.19.17",
    "@mida/chain": "workspace:*",
    "@mida/crypto": "workspace:*",
    "@mida/grant-advisor": "workspace:*",
    "@mida/protocol": "workspace:*",
    "@mida/storage": "workspace:*",
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "hono": "4.13.7",
    "viem": "2.56.3"
  }
}
```

Add `"@mida/api": "workspace:*"` to the root `package.json` `"dependencies"`, then run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

`apps/api/test/verify-assertion.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import type { Hex } from "@mida/protocol"
import { assertionToWire, p256PublicKey, signVaultAssertion } from "@mida/fake-vault"
import type { WebAuthnAssertionWire } from "@mida/fake-vault"
import { verifyVaultAssertion } from "@mida/api"

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const KEY: Hex = `0x${"4d".repeat(32)}`
const OTHER_KEY: Hex = `0x${"4e".repeat(32)}`
const rpIdHash = (rpId: string): Hex => `0x${bytesToHex(sha256(utf8ToBytes(rpId)))}`
const RP_ID_HASH = rpIdHash("vault.mida.xyz")
const CHALLENGE: Hex = `0x${"ab".repeat(32)}`
const { qx, qy } = p256PublicKey(KEY)
const valid = assertionToWire(signVaultAssertion({ challenge: CHALLENGE, privateKey: KEY, rpId: "vault.mida.xyz", origin: "https://vault.mida.xyz" }))
const verify = (assertion: WebAuthnAssertionWire, challenge: Hex = CHALLENGE) => verifyVaultAssertion({ challenge, assertion, qx, qy, rpIdHash: RP_ID_HASH })

/** Re-signs a mutated assertion with the real key, so each rejection is caused by the mutated field alone. */
function resigned(authenticatorData: Uint8Array, clientDataJSON: string): WebAuthnAssertionWire {
  const message = concatBytes(authenticatorData, sha256(utf8ToBytes(clientDataJSON)))
  const signature = p256.sign(message, hexToBytes(KEY.slice(2)), { prehash: true, lowS: true })
  return {
    ...valid,
    authenticatorData: `0x${bytesToHex(authenticatorData)}`,
    clientDataJSON,
    r: `0x${bytesToHex(signature.slice(0, 32))}`,
    s: `0x${bytesToHex(signature.slice(32, 64))}`,
  }
}

const authData = (rpId: string, flags: number) => concatBytes(sha256(utf8ToBytes(rpId)), new Uint8Array([flags, 0, 0, 0, 0]))

describe("off-chain Vault assertion verification (§12.5 cancellation)", () => {
  it("accepts the Vault's own ox-produced assertion and a re-signed copy of it", () => {
    expect(verify(valid)).toBe(true)
    expect(verify(resigned(authData("vault.mida.xyz", 0x05), valid.clientDataJSON))).toBe(true)
  })

  it("rejects a different challenge or a different owner key", () => {
    expect(verify(valid, `0x${"ac".repeat(32)}`)).toBe(false)
    const other = p256PublicKey(OTHER_KEY)
    expect(verifyVaultAssertion({ challenge: CHALLENGE, assertion: valid, qx: other.qx, qy: other.qy, rpIdHash: RP_ID_HASH })).toBe(false)
  })

  it("rejects another RP ID, a missing UV flag and a missing UP flag even when correctly signed", () => {
    expect(verify(resigned(authData("evil.example", 0x05), valid.clientDataJSON))).toBe(false)
    expect(verify(resigned(authData("vault.mida.xyz", 0x01), valid.clientDataJSON))).toBe(false)
    expect(verify(resigned(authData("vault.mida.xyz", 0x04), valid.clientDataJSON))).toBe(false)
  })

  it("rejects a create-type ceremony, high-s and truncated authenticator data", () => {
    expect(verify(resigned(authData("vault.mida.xyz", 0x05), valid.clientDataJSON.replace("webauthn.get", "webauthn.set")))).toBe(false)
    expect(verify({ ...valid, s: `0x${(N - BigInt(valid.s)).toString(16).padStart(64, "0")}` })).toBe(false)
    expect(verify({ ...valid, authenticatorData: valid.authenticatorData.slice(0, 2 + 36 * 2) as Hex })).toBe(false)
  })

  it("does not check clientDataJSON.origin: a foreign origin with the Vault RP-ID hash still verifies (documented v0 limit)", () => {
    const foreign = valid.clientDataJSON.replace("https://vault.mida.xyz", "https://evil.example")
    expect(verify(resigned(authData("vault.mida.xyz", 0x05), foreign))).toBe(true)
  })
})
```

`apps/api/test/auth.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, createContextApi } from "@mida/api"
import type { RegistryReader } from "@mida/api"

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}
const NOW = 1_800_000_000n

function setup(dataDir: string = mkdtempSync(join(tmpdir(), "mida-auth-"))) {
  // Authentication runs before any chain read; an empty body reaches the handler, which rejects it as INVALID_WIRE.
  const { app } = createContextApi({ reader: {} as RegistryReader, deployment, dataDir, clock: () => NOW })
  const captured: Array<{ url: string; init: RequestInit }> = []
  const account = privateKeyToAccount(generatePrivateKey())
  const client = (options: Partial<ConstructorParameters<typeof ContextApiClient>[0]> = {}) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => NOW,
      fetch: async (url, init) => {
        captured.push({ url, init })
        return app.request(url, init)
      },
      ...options,
    })
  return { app, client, captured, dataDir }
}

describe("§12.1 request authentication", () => {
  it("rejects an unsigned request before any handler runs", async () => {
    const { client } = setup()
    await expect(client().request("POST", "/revocations", { body: {}, signed: false })).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("accepts a correctly signed request, so the handler's own validation is what fails", async () => {
    const { app, client, captured } = setup()
    await expect(client().request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    const response = await app.request(captured[0]!.url, captured[0]!.init)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "REPLAY" } })
  })

  it("still rejects a replay after the API restarts on the same data directory", async () => {
    const first = setup()
    await expect(first.client().request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    const restarted = setup(first.dataDir)
    const response = await restarted.app.request(first.captured[0]!.url, first.captured[0]!.init)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "REPLAY" } })
  })

  it("rejects a timestamp more than 60 seconds away and accepts exactly 60", async () => {
    const { client } = setup()
    await expect(client({ clock: () => NOW - 61n }).request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(client({ clock: () => NOW + 61n }).request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(client({ clock: () => NOW - 60n }).request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "INVALID_WIRE" })
  })

  it("binds the exact body bytes, the method, the target and the registry", async () => {
    const { app, client } = setup()
    const tamper = (mutate: (url: string, init: RequestInit) => [string, RequestInit]) =>
      client({ fetch: async (url, init) => app.request(...mutate(url, init)) }).request("POST", "/revocations", { body: { agentId: "0x00" } })
    await expect(tamper((url, init) => [url, { ...init, body: new TextEncoder().encode("{}") }])).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(tamper((url, init) => [url.replace("/revocations", "/revocations/x/cancel"), init])).rejects.toMatchObject({
      code: expect.stringMatching(/AUTH_INVALID|NOT_FOUND/),
    })
    await expect(
      client({ capabilityRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }).request("POST", "/revocations", { body: {} }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("canonicalizes query order and rejects a repeated query key", async () => {
    const { app, client } = setup()
    await expect(client().request("POST", "/revocations", { body: {}, query: { b: "2", a: "1" } })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    const repeated = client({ fetch: async (url, init) => app.request(`${url}&a=3`, init) })
    await expect(repeated.request("POST", "/revocations", { body: {}, query: { a: "1" } })).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })
})
```

`apps/api/test/authorization.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { PERMISSION, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { ANVIL_PRIVATE_KEYS, createWriteContext, deployLocal, increaseLocalTime, latestTimestamp, startAnvil } from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, provisionAgent } from "@mida/fake-vault"
import type { ProvisionedAgent } from "@mida/fake-vault"
import { randomBytes } from "@noble/hashes/utils.js"
import { ContextApiClient, DenyOverlay, RegistryReader, authorizeAgent, createContextApi } from "@mida/api"
import type { CapabilityView } from "@mida/api"

const CAREER = namespaceId("goals.career")
const LEARNING = namespaceId("goals.learning")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`

describe("Context API authorization and the deny overlay (plan Task 23)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let reader: RegistryReader
  let overlay: DenyOverlay
  let ownerClient: ContextApiClient
  let strangerClient: ContextApiClient
  let vault: FakeVaultAuthority
  let agentA: ProvisionedAgent
  let agentE: ProvisionedAgent
  let agentN: ProvisionedAgent
  let capabilityA: Hex
  let capabilityE: Hex

  const authorize = (agent: ProvisionedAgent, capabilityId: Hex | undefined, extra: { namespaceId?: Hex; permission?: number; agentKeyVersion?: number } = {}) =>
    authorizeAgent({
      reader,
      overlay,
      signer: agent.signer.address.toLowerCase() as Address,
      owner: vault.owner,
      capabilityId,
      namespaceId: extra.namespaceId ?? CAREER,
      permission: extra.permission ?? PERMISSION.READ,
      ...(extra.agentKeyVersion === undefined ? {} : { agentKeyVersion: extra.agentKeyVersion }),
    })

  const grant = async (agent: ProvisionedAgent, selection: Parameters<FakeVaultAuthority["approveGrant"]>[0]["selection"]) => {
    const accessRequest = await buildSignedAccessRequest({ chain: owner, agent, scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    return (await vault.approveGrant({ accessRequest, manifest: agent.manifest, selection })).response.capabilities[0]!.capabilityId
  }

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    reader = new RegistryReader(owner)
    const api = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-authz-")) })
    overlay = api.overlay
    const clientFor = (account: LocalAccount) =>
      new ContextApiClient({
        baseUrl: "http://mida.test",
        account,
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        fetch: async (url, init) => api.app.request(url, init),
      })
    ownerClient = clientFor(owner.account)
    strangerClient = clientFor(privateKeyToAccount(generatePrivateKey()))
    vault = new FakeVaultAuthority({
      seed: SEED,
      p256PrivateKey: P256_KEY,
      chain: owner,
      api: {
        putObject: async () => undefined,
        publishEpochWrap: async () => undefined,
        requestRevocationDeny: (target) =>
          ownerClient.request<{ intentId: Hex }>("POST", "/revocations", {
            body: "capabilityId" in target ? { capabilityId: target.capabilityId } : { agentId: target.agentId },
          }),
      },
    })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await vault.initializeNamespace("goals.learning")
    const declarations = [
      { namespace: "goals.career", permissions: ["READ" as const] },
      { namespace: "goals.learning", permissions: ["READ" as const] },
    ]
    const provision = (index: number, name: string) =>
      provisionAgent({
        operator: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[index]!) }),
        name,
        purposeId: "career_coaching",
        declarations,
        callbackOrigin: `https://${name.toLowerCase()}.example`,
      })
    agentA = await provision(2, "AgentA")
    agentE = await provision(3, "AgentE")
    agentN = await provision(4, "AgentN")
    capabilityA = await grant(agentA, { kind: "recommended" })
    capabilityE = await grant(agentE, { kind: "custom", scopes: [{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }], expiresAt: (await latestTimestamp(owner)) + 120n })
  }, 240_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("authorizes a live exact READ capability for its own agent", async () => {
    const result = await authorize(agentA, capabilityA, { agentKeyVersion: 1 })
    expect(result.agentId).toBe(agentA.agentId)
  })

  it("step 2: denies a signer that is not a registered agent", async () => {
    const stranger = { ...agentA, signer: privateKeyToAccount(generatePrivateKey()) }
    await expect(authorize(stranger, capabilityA)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("step 3: denies a request that names no capability or another agent's capability", async () => {
    await expect(authorize(agentA, undefined)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, capabilityE)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, hexOf(randomBytes(32)))).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("steps 6–8: wrong namespace, missing permission bit and stale key version each fail closed", async () => {
    await expect(authorize(agentA, capabilityA, { namespaceId: LEARNING })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, capabilityA, { permission: PERMISSION.CREATE })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(authorize(agentA, capabilityA, { agentKeyVersion: 2 })).rejects.toMatchObject({ code: "WRAP_KEY_VERSION_MISMATCH" })
  })

  it("never lets a stale or lying local view make Monad authorization true", async () => {
    class LyingReader extends RegistryReader {
      override async getCapability(): Promise<CapabilityView> {
        return {
          owner: vault.owner,
          agentId: agentN.agentId,
          namespaceId: CAREER,
          permissions: PERMISSION.READ,
          provenancePolicy: 0,
          issuedAt: 0n,
          expiresAt: 0n,
          agentEpoch: 0n,
          grantedAtReadEpoch: 1n,
          revoked: false,
        }
      }
    }
    await expect(
      authorizeAgent({
        reader: new LyingReader(owner),
        overlay,
        signer: agentN.signer.address.toLowerCase() as Address,
        owner: vault.owner,
        capabilityId: hexOf(randomBytes(32)),
        namespaceId: CAREER,
        permission: PERMISSION.READ,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("POST /revocations requires an authenticated owner of an existing target", async () => {
    await expect(ownerClient.request("POST", "/revocations", { body: { capabilityId: capabilityA }, signed: false })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(strangerClient.request("POST", "/revocations", { body: { capabilityId: capabilityA } })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(ownerClient.request("POST", "/revocations", { body: { agentId: hexOf(randomBytes(32)) } })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a recorded deny blocks at step 4, before namespace and permission checks, while Monad still authorizes", async () => {
    const intent = await ownerClient.request<{ intentId: Hex; state: string; cancellationNonce: string }>("POST", "/revocations", { body: { capabilityId: capabilityA } })
    expect(intent.state).toBe("active")
    await expect(authorize(agentA, capabilityA, { namespaceId: LEARNING, permission: PERMISSION.CREATE })).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect(await reader.hasAuthority(vault.owner, agentA.agentId, CAREER, PERMISSION.READ, 0)).toBe(true)

    // A session signature alone cannot cancel; nor can another passkey or an over-long validity.
    const now = BigInt(Math.floor(Date.now() / 1000))
    const cancel = (body: unknown) => ownerClient.request<{ state: string }>("POST", `/revocations/${intent.intentId}/cancel`, { body })
    await expect(cancel({})).rejects.toMatchObject({ code: "AUTH_INVALID" })
    const otherVault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: `0x${"4e".repeat(32)}`, chain: owner, api: { putObject: async () => undefined, publishEpochWrap: async () => undefined, requestRevocationDeny: async () => ({ intentId: intent.intentId }) } })
    const nonce = BigInt(intent.cancellationNonce)
    const wrongKey = otherVault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: nonce, expiresAt: now + 120n })
    await expect(cancel({ expiresAt: (now + 120n).toString(), assertion: wrongKey })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    const tooLong = vault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: nonce, expiresAt: now + 301n })
    await expect(cancel({ expiresAt: (now + 301n).toString(), assertion: tooLong })).rejects.toMatchObject({ code: "AUTH_INVALID" })

    const good = { expiresAt: (now + 120n).toString(), assertion: vault.approveDenyCancellation({ revocationIntentId: intent.intentId, apiCancellationNonce: nonce, expiresAt: now + 120n }) }
    expect((await cancel(good)).state).toBe("cancelled")
    await expect(authorize(agentA, capabilityA)).resolves.toMatchObject({ agentId: agentA.agentId })
    await expect(cancel(good)).rejects.toMatchObject({ code: "REPLAY" })
  })

  it("a deny anchors only when Monad shows the revocation; without one it stays active", async () => {
    await ownerClient.request("POST", "/revocations", { body: { agentId: agentN.agentId } })
    await overlay.reconcile(reader)
    expect(overlay.list().filter((intent) => intent.target.kind === "agent").map((intent) => intent.state)).toEqual(["active"])

    const approval = await vault.approveRevocation({ kind: "capability", capabilityId: capabilityA })
    expect(overlay.get(approval.intentId)?.state).toBe("active")
    await overlay.reconcile(reader)
    expect(overlay.get(approval.intentId)?.state).toBe("anchored")
    await expect(authorize(agentA, capabilityA)).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect(overlay.list().filter((intent) => intent.target.kind === "agent").map((intent) => intent.state)).toEqual(["active"])
  })

  it("step 5: expiry, on chain time, fails before namespace and key-version checks", async () => {
    await increaseLocalTime(node.rpcUrl, 200n)
    await expect(authorize(agentE, capabilityE, { namespaceId: LEARNING, agentKeyVersion: 9 })).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" })
    expect(overlay.list().filter((intent) => intent.target.kind === "agent").map((intent) => intent.state)).toEqual(["active"])
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run apps/api`
Expected: FAIL. Vitest cannot resolve `@mida/api`, because `apps/api/src/index.ts` does not exist yet.

- [ ] **Step 4: Implement chain views, errors and request authentication**

`apps/api/src/chain-views.ts`:
```ts
import { isMidaError } from "@mida/protocol"
import type { Address, AgentRecord, Hex } from "@mida/protocol"
import { capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, toMidaError } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { zeroHash } from "viem"

/** Spec §10.3 Capability, as read from CapabilityRegistry. */
export interface CapabilityView {
  owner: Address
  agentId: Hex
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  issuedAt: bigint
  expiresAt: bigint
  agentEpoch: bigint
  grantedAtReadEpoch: bigint
  revoked: boolean
}

/** Spec §11.3 ContextRecord, as read from ContextRegistry. */
export interface ContextRecordView {
  contextId: Hex
  owner: Address
  author: Hex
  namespaceId: Hex
  lineageId: Hex
  parentId: Hex
  manifestHash: Hex
  ciphertextCommitment: Hex
  evidenceCommitment: Hex
  readEpoch: bigint
  createdAt: bigint
  expiresAt: bigint
  version: number
  recordType: number
  lineagePolicy: number
  kind: number
  provenanceSource: number
}

const lower = <T extends string>(value: T) => value.toLowerCase() as T

/**
 * Every Monad read the Context API and SDK make. Nothing here is cached: each call reads current chain state, so no
 * local value can make Monad authorization true (§12, `currentlyAllowedByMonad`).
 */
export class RegistryReader {
  constructor(readonly context: ChainContext) {}

  now(): Promise<bigint> {
    return latestTimestamp(this.context)
  }

  async agentIdOfSigner(signer: Address): Promise<Hex | null> {
    const id = await this.#capability<Hex>("agentIdOfSigner", [signer])
    return id === zeroHash ? null : id
  }

  async getAgent(agentId: Hex): Promise<AgentRecord | null> {
    try {
      return await readAgentRecord(this.context, agentId)
    } catch (error) {
      if (isMidaError(error, "CAPABILITY_DENIED")) return null
      throw error
    }
  }

  async getCapability(capabilityId: Hex): Promise<CapabilityView | null> {
    try {
      const capability = await this.#capability<CapabilityView>("getCapability", [capabilityId])
      return { ...capability, owner: lower(capability.owner), agentId: lower(capability.agentId), namespaceId: lower(capability.namespaceId) }
    } catch (error) {
      if (isMidaError(error, "CAPABILITY_DENIED")) return null
      throw error
    }
  }

  agentEpoch(owner: Address, agentId: Hex): Promise<bigint> {
    return this.#capability("agentEpoch", [owner, agentId])
  }

  hasAuthority(owner: Address, agentId: Hex, namespaceId: Hex, permissions: number, provenanceBits: number): Promise<boolean> {
    return this.#capability("hasAuthority", [owner, agentId, namespaceId, permissions, provenanceBits])
  }

  requiredReadEpoch(owner: Address, namespaceId: Hex): Promise<bigint> {
    return this.#capability("requiredReadEpoch", [owner, namespaceId])
  }

  async epochPublicKey(owner: Address, namespaceId: Hex, epoch: bigint): Promise<Hex | null> {
    const key = await this.#capability<Hex>("epochPublicKey", [owner, namespaceId, epoch])
    return key === zeroHash ? null : key
  }

  isWriteEpochValid(owner: Address, namespaceId: Hex, epoch: bigint): Promise<boolean> {
    return this.#capability("isWriteEpochValid", [owner, namespaceId, epoch])
  }

  async ownerP256Key(owner: Address): Promise<{ qx: bigint; qy: bigint } | null> {
    const [qx, qy] = await this.#capability<readonly [bigint, bigint]>("ownerP256Key", [owner])
    return qx === 0n ? null : { qx, qy }
  }

  async getRecord(contextId: Hex): Promise<ContextRecordView | null> {
    try {
      const record = (await this.context.publicClient.readContract({
        address: this.context.deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "getRecord",
        args: [contextId],
      })) as ContextRecordView
      return { ...record, owner: lower(record.owner) }
    } catch (error) {
      const mapped = toMidaError(error)
      if (isMidaError(mapped, "NOT_FOUND")) return null
      throw mapped
    }
  }

  async #capability<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    try {
      return (await this.context.publicClient.readContract({
        address: this.context.deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName,
        args,
      } as never)) as T
    } catch (error) {
      throw toMidaError(error)
    }
  }
}
```

`apps/api/src/errors.ts`:
```ts
import { MIDA_ERROR_CODES, MidaError, isMidaError } from "@mida/protocol"
import type { MidaErrorCode } from "@mida/protocol"

export interface ApiErrorBody {
  error: { code: MidaErrorCode; message: string }
}

const STATUS: Partial<Record<MidaErrorCode, number>> = {
  AUTH_INVALID: 401,
  REPLAY: 401,
  CAPABILITY_DENIED: 403,
  CAPABILITY_EXPIRED: 403,
  CAPABILITY_REVOKED: 403,
  PROVENANCE_FORBIDDEN: 403,
  ANCHOR_OWNER_ONLY: 403,
  NOT_FOUND: 404,
  NO_EPOCH_WRAP: 404,
  MANIFEST_NOT_FOUND: 404,
  EPOCH_STALE: 409,
  EPOCH_ROTATION_REQUIRED: 409,
  STALE_PARENT: 409,
  REQUEST_CONSUMED: 409,
  PAYLOAD_TOO_LARGE: 413,
}

export function statusFor(code: MidaErrorCode): number {
  return STATUS[code] ?? 400
}

/** Unknown failures never leak internals and never read as authorization. */
export function toErrorBody(error: unknown): { status: number; body: ApiErrorBody } {
  if (isMidaError(error)) return { status: statusFor(error.code), body: { error: { code: error.code, message: error.message } } }
  return { status: 500, body: { error: { code: "CAPABILITY_DENIED", message: "internal error; request denied" } } }
}

export function errorFromBody(status: number, body: unknown): Error {
  const error = (body as Partial<ApiErrorBody> | null)?.error
  if (error !== undefined && (MIDA_ERROR_CODES as readonly string[]).includes(error.code)) {
    return new MidaError(error.code, error.message.replace(new RegExp(`^${error.code}: `), ""))
  }
  return new Error(`Context API returned HTTP ${status}`)
}
```

`apps/api/src/auth.ts`:
```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError, assertHex, canonicalTarget, httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { isTypedDataSignedBy } from "@mida/grant-advisor"
import type { TypedDataDefinition } from "viem"

export const AUTH_HEADERS = {
  signer: "x-mida-signer",
  timestamp: "x-mida-timestamp",
  nonce: "x-mida-nonce",
  signature: "x-mida-signature",
} as const

export const REQUEST_WINDOW_SECONDS = 60n

/** Builds the §12.1 canonical target from a URL: path plus query sorted by key. Repeated keys are rejected. */
export function targetOf(url: URL): string {
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) throw new MidaError("AUTH_INVALID", `query parameter ${key} is repeated`)
    query[key] = value
  }
  return canonicalTarget(url.pathname, query)
}

interface SeenNonce {
  signer: Address
  nonce: Hex
  /** The request's signed timestamp, base-10 Unix seconds. */
  timestamp: string
}

/**
 * Durable (signer, nonce) record for the §12.1 validity window. Each accepted pair is written to disk, atomically and
 * synchronously, before authentication returns, so neither a restart nor a crash can forget a nonce that was accepted.
 * An entry is pruned once its signed timestamp is more than 60 seconds old, because the timestamp check alone then
 * rejects the request. An unreadable store fails closed rather than starting empty.
 */
export class ReplayGuard {
  readonly #file: string
  readonly #seen = new Map<string, SeenNonce>()

  constructor(file: string) {
    this.#file = file
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of JSON.parse(text) as SeenNonce[]) this.#seen.set(ReplayGuard.#key(entry.signer, entry.nonce), entry)
  }

  static #key(signer: Address, nonce: Hex): string {
    return `${signer.toLowerCase()}:${nonce.toLowerCase()}`
  }

  consume(signer: Address, nonce: Hex, signedAt: bigint, now: bigint): void {
    for (const [key, entry] of this.#seen) {
      if (BigInt(entry.timestamp) < now - REQUEST_WINDOW_SECONDS) this.#seen.delete(key)
    }
    const key = ReplayGuard.#key(signer, nonce)
    if (this.#seen.has(key)) throw new MidaError("REPLAY", "request nonce was already used")
    this.#seen.set(key, { signer: signer.toLowerCase() as Address, nonce: nonce.toLowerCase() as Hex, timestamp: signedAt.toString(10) })
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    writeFileSync(temporary, JSON.stringify([...this.#seen.values()]))
    renameSync(temporary, this.#file)
  }
}

/**
 * §12.1 authentication: an EIP-712 MidaHttpRequestV1 signature over method, canonical target, raw body bytes,
 * timestamp and nonce, under the "Mida Context API" domain for this chain and registry. Returns the proven signer.
 * Authorization happens afterwards and separately.
 */
export function authenticateRequest(input: {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array
  chainId: bigint
  capabilityRegistry: Address
  now: bigint
  replay: ReplayGuard
}): Address {
  const signer = input.headers.get(AUTH_HEADERS.signer)
  const timestamp = input.headers.get(AUTH_HEADERS.timestamp)
  const nonce = input.headers.get(AUTH_HEADERS.nonce)
  const signature = input.headers.get(AUTH_HEADERS.signature)
  if (signer === null || timestamp === null || nonce === null || signature === null) {
    throw new MidaError("AUTH_INVALID", "missing request authentication headers")
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer) || !/^(0|[1-9][0-9]*)$/.test(timestamp) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new MidaError("AUTH_INVALID", "malformed request authentication headers")
  }
  try {
    assertHex(nonce, 32)
  } catch {
    throw new MidaError("AUTH_INVALID", "nonce must be lowercase bytes32")
  }
  const signedAt = BigInt(timestamp)
  const skew = input.now > signedAt ? input.now - signedAt : signedAt - input.now
  if (skew > REQUEST_WINDOW_SECONDS) throw new MidaError("AUTH_INVALID", "request timestamp is outside the 60 second window")

  const typedData = httpRequestTypedData({
    chainId: input.chainId,
    capabilityRegistry: input.capabilityRegistry,
    signer: signer as Address,
    method: input.method,
    target: targetOf(input.url),
    body: input.body,
    timestamp: signedAt,
    nonce: nonce as Hex,
  })
  if (!isTypedDataSignedBy(typedData as unknown as TypedDataDefinition, signature as Hex, signer as Address)) {
    throw new MidaError("AUTH_INVALID", "request signature does not match the signed method, target, body and time")
  }
  input.replay.consume(signer as Address, nonce as Hex, signedAt, input.now)
  return signer.toLowerCase() as Address
}
```

- [ ] **Step 5: Implement assertion verification, the deny overlay and ordered authorization**

`apps/api/src/verify-assertion.ts`:
```ts
import { hexToBytes } from "@noble/hashes/utils.js"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes } from "@noble/hashes/utils.js"
import type { Hex } from "@mida/protocol"

export interface WebAuthnAssertionInput {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: string
  typeIndex: string
  r: Hex
  s: Hex
}

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const FLAG_UP = 0x01
const FLAG_UV = 0x04

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Off-chain mirror of MidaWebAuthn plus webauthn-sol v1.0.0 (§10.4), used to accept a deny cancellation (§12.5):
 * RP-ID hash, UP and UV flags, `"type":"webauthn.get"` and the base64url challenge at their declared indexes,
 * low-s, then P256 over SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)). Like the contract, it does not check
 * `clientDataJSON.origin`; the browser enforces the origin for the Vault RP ID.
 */
export function verifyVaultAssertion(input: {
  challenge: Hex
  assertion: WebAuthnAssertionInput
  qx: bigint
  qy: bigint
  rpIdHash: Hex
}): boolean {
  try {
    const { assertion } = input
    const authenticatorData = hexToBytes(assertion.authenticatorData.slice(2))
    if (authenticatorData.length < 37) return false
    if (Buffer.from(authenticatorData.subarray(0, 32)).toString("hex") !== input.rpIdHash.slice(2).toLowerCase()) return false
    const flags = authenticatorData[32]!
    if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) return false

    const typeIndex = Number(assertion.typeIndex)
    const challengeIndex = Number(assertion.challengeIndex)
    const expectedType = '"type":"webauthn.get"'
    if (assertion.clientDataJSON.slice(typeIndex, typeIndex + expectedType.length) !== expectedType) return false
    const expectedChallenge = `"challenge":"${base64url(hexToBytes(input.challenge.slice(2)))}"`
    if (assertion.clientDataJSON.slice(challengeIndex, challengeIndex + expectedChallenge.length) !== expectedChallenge) return false

    const r = BigInt(assertion.r)
    const s = BigInt(assertion.s)
    if (r <= 0n || r >= N || s <= 0n || s > N / 2n) return false

    const message = concatBytes(authenticatorData, sha256(new TextEncoder().encode(assertion.clientDataJSON)))
    const signature = hexToBytes(r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0"))
    const publicKey = hexToBytes(`04${input.qx.toString(16).padStart(64, "0")}${input.qy.toString(16).padStart(64, "0")}`)
    return p256.verify(signature, message, publicKey, { prehash: true, lowS: true })
  } catch {
    return false
  }
}
```

`apps/api/src/deny-overlay.ts`:
```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { RegistryReader } from "./chain-views.js"

export type RevocationTarget = { kind: "capability"; capabilityId: Hex } | { kind: "agent"; agentId: Hex }

export type DenyState = "active" | "anchored" | "cancelled"

export interface RevocationIntent {
  id: Hex
  owner: Address
  target: RevocationTarget
  state: DenyState
  /** Owner-agent epoch when the intent was recorded; an agent revocation is anchored once the chain epoch exceeds it. */
  agentEpochAtIntent: string | null
  /** Base-10 uint256 consumed by a successful cancellation; null once consumed or no longer cancellable. */
  cancellationNonce: string | null
}

/**
 * §12.5 fast revocation overlay, persisted as one JSON file. Exactly three transitions exist:
 *   active → anchored   matching Monad revocation observed (reconcile)
 *   active → active     transaction failed, missing or reorged out (no timeout ever clears a deny)
 *   active → cancelled  fresh owner P256-approved cancellation (cancel)
 * It can only reduce authority: `effectiveAllowed = currentlyAllowedByMonad AND NOT localDeny`.
 */
export class DenyOverlay {
  readonly #file: string
  #intents: RevocationIntent[]

  constructor(file: string) {
    this.#file = file
    try {
      this.#intents = JSON.parse(readFileSync(file, "utf8")) as RevocationIntent[]
    } catch {
      this.#intents = []
    }
  }

  list(): readonly RevocationIntent[] {
    return this.#intents.map((intent) => ({ ...intent }))
  }

  get(id: Hex): RevocationIntent | undefined {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    return intent === undefined ? undefined : { ...intent }
  }

  create(owner: Address, target: RevocationTarget, agentEpochAtIntent: bigint | null): RevocationIntent {
    const intent: RevocationIntent = {
      id: hexOf(randomBytes(32)),
      owner: owner.toLowerCase() as Address,
      target:
        target.kind === "capability"
          ? { kind: "capability", capabilityId: target.capabilityId.toLowerCase() as Hex }
          : { kind: "agent", agentId: target.agentId.toLowerCase() as Hex },
      state: "active",
      agentEpochAtIntent: agentEpochAtIntent === null ? null : agentEpochAtIntent.toString(10),
      cancellationNonce: BigInt(hexOf(randomBytes(32))).toString(10),
    }
    this.#intents.push(intent)
    this.#save()
    return { ...intent }
  }

  /** True when an active deny matches this owner and either this agent relationship or this exact capability. */
  denies(input: { owner: Address; agentId: Hex; capabilityId: Hex }): boolean {
    const owner = input.owner.toLowerCase()
    return this.#intents.some(
      (intent) =>
        intent.state === "active" &&
        intent.owner === owner &&
        (intent.target.kind === "agent"
          ? intent.target.agentId === input.agentId.toLowerCase()
          : intent.target.capabilityId === input.capabilityId.toLowerCase()),
    )
  }

  /** active → anchored only when Monad shows the matching revocation. Failed or missing transactions leave it active. */
  async reconcile(reader: RegistryReader): Promise<void> {
    let changed = false
    for (const intent of this.#intents) {
      if (intent.state !== "active") continue
      const anchored =
        intent.target.kind === "capability"
          ? (await reader.getCapability(intent.target.capabilityId))?.revoked === true
          : (await reader.agentEpoch(intent.owner, intent.target.agentId)) > BigInt(intent.agentEpochAtIntent ?? "0")
      if (anchored) {
        intent.state = "anchored"
        intent.cancellationNonce = null
        changed = true
      }
    }
    if (changed) this.#save()
  }

  /** active → cancelled. The caller must already have verified a fresh P256 assertion over this nonce. */
  cancel(id: Hex, owner: Address, nonce: bigint): RevocationIntent {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    if (intent === undefined || intent.owner !== owner.toLowerCase()) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null || BigInt(intent.cancellationNonce) !== nonce) {
      throw new MidaError("REPLAY", "revocation intent is not cancellable with this nonce")
    }
    intent.state = "cancelled"
    intent.cancellationNonce = null
    this.#save()
    return { ...intent }
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#intents, null, 2))
    renameSync(temporary, this.#file)
  }
}
```

`apps/api/src/authorize.ts`:
```ts
import { MidaError } from "@mida/protocol"
import type { Address, AgentRecord, Hex } from "@mida/protocol"
import type { CapabilityView, RegistryReader } from "./chain-views.js"
import type { DenyOverlay } from "./deny-overlay.js"

export interface AgentAuthorization {
  agentId: Hex
  agent: AgentRecord
  capability: CapabilityView
  now: bigint
}

/**
 * §12.1 normative, fail-closed validation order for every agent operation. Step 1 (authentication) has already
 * produced `signer`. Each later step stops at the first failure with its §12.6 code. A final exact `hasAuthority`
 * read keeps the API chain-bounded: it can deny sooner than Monad, never allow what Monad does not.
 */
export async function authorizeAgent(input: {
  reader: RegistryReader
  overlay: DenyOverlay
  signer: Address
  owner: Address
  capabilityId: Hex | undefined
  namespaceId: Hex
  permission: number
  agentKeyVersion?: number
}): Promise<AgentAuthorization> {
  const owner = input.owner.toLowerCase() as Address
  const namespaceId = input.namespaceId.toLowerCase() as Hex

  // 2. resolve active agent identity
  const agentId = await input.reader.agentIdOfSigner(input.signer)
  if (agentId === null) throw new MidaError("CAPABILITY_DENIED", "signer is not the current signer of a registered agent")
  const agent = await input.reader.getAgent(agentId)
  if (agent === null || !agent.active) throw new MidaError("CAPABILITY_DENIED", "agent is not active")

  // 3. load the exact capability; require it exists for this owner and agent
  if (input.capabilityId === undefined) throw new MidaError("CAPABILITY_DENIED", "request names no capability")
  const capability = await input.reader.getCapability(input.capabilityId)
  if (capability === null || capability.owner !== owner || capability.agentId !== agentId) {
    throw new MidaError("CAPABILITY_DENIED", "capability does not exist for this owner and agent")
  }

  // 4. local deny, on-chain revocation, agent-epoch mismatch
  await input.overlay.reconcile(input.reader)
  if (input.overlay.denies({ owner, agentId, capabilityId: input.capabilityId })) {
    throw new MidaError("CAPABILITY_REVOKED", "owner revocation intent is active")
  }
  if (capability.revoked) throw new MidaError("CAPABILITY_REVOKED", "capability was revoked on-chain")
  if ((await input.reader.agentEpoch(owner, agentId)) !== capability.agentEpoch) {
    throw new MidaError("CAPABILITY_REVOKED", "owner revoked every capability of this agent")
  }

  // 5. expiry, inclusive at expiresAt, on chain time (same boundary as CapabilityStore._isLive)
  const now = await input.reader.now()
  if (capability.expiresAt !== 0n && now >= capability.expiresAt) throw new MidaError("CAPABILITY_EXPIRED", "capability expired")

  // 6. exact namespace
  if (capability.namespaceId !== namespaceId) throw new MidaError("CAPABILITY_DENIED", "capability is for another namespace")

  // 7. permission bit
  if ((capability.permissions & input.permission) !== input.permission) {
    throw new MidaError("CAPABILITY_DENIED", "capability lacks the requested permission")
  }

  // 8. current registered encryption key version, where the operation involves one
  if (input.agentKeyVersion !== undefined && input.agentKeyVersion !== agent.encryptionKeyVersion) {
    throw new MidaError("WRAP_KEY_VERSION_MISMATCH", "encryption key version is not the agent's current version")
  }

  if (!(await input.reader.hasAuthority(owner, agentId, namespaceId, input.permission, 0))) {
    throw new MidaError("CAPABILITY_DENIED", "Monad does not currently authorize this operation")
  }
  return { agentId, agent, capability, now }
}
```

- [ ] **Step 6: Implement the signed client and the revocation routes**

`apps/api/src/client.ts`:
```ts
import { httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { LocalAccount } from "viem"
import { AUTH_HEADERS, targetOf } from "./auth.js"
import { errorFromBody } from "./errors.js"

export interface ContextApiClientOptions {
  baseUrl: string
  account: LocalAccount
  chainId: bigint
  capabilityRegistry: Address
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  clock?: () => bigint
}

/** Signs every request with MidaHttpRequestV1 (§12.1). The signature covers the exact body bytes sent. */
export class ContextApiClient {
  readonly account: LocalAccount
  readonly #options: ContextApiClientOptions

  constructor(options: ContextApiClientOptions) {
    this.account = options.account
    this.#options = options
  }

  async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown; signed?: boolean } = {}): Promise<T> {
    const url = new URL(path, this.#options.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    const body = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body))
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (options.signed !== false) {
      const timestamp = (this.#options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000))))()
      const nonce = hexOf(randomBytes(32))
      const signature = await this.account.signTypedData(
        httpRequestTypedData({
          chainId: this.#options.chainId,
          capabilityRegistry: this.#options.capabilityRegistry,
          signer: this.account.address,
          method,
          target: targetOf(url),
          body,
          timestamp,
          nonce,
        }) as never,
      )
      headers[AUTH_HEADERS.signer] = this.account.address
      headers[AUTH_HEADERS.timestamp] = timestamp.toString(10)
      headers[AUTH_HEADERS.nonce] = nonce
      headers[AUTH_HEADERS.signature] = signature
    }
    const doFetch = this.#options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
    const response = await doFetch(url.toString(), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    })
    const text = await response.text()
    const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
    if (!response.ok) throw errorFromBody(response.status, parsed)
    return parsed as T
  }
}
```

`apps/api/src/app.ts`:
```ts
import { MidaError, assertHex, cancelFastRevokeDigest } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { ReplayGuard, authenticateRequest } from "./auth.js"
import type { RegistryReader } from "./chain-views.js"
import { DenyOverlay } from "./deny-overlay.js"
import type { RevocationTarget } from "./deny-overlay.js"
import { toErrorBody } from "./errors.js"
import { verifyVaultAssertion } from "./verify-assertion.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"

export const CANCELLATION_MAX_LIFETIME_SECONDS = 300n

export interface ContextApiOptions {
  reader: RegistryReader
  deployment: Deployment
  dataDir: string
  /** Wall-clock seconds for request freshness. Chain time decides capability expiry. */
  clock?: () => bigint
}

type Env = { Variables: { signer: Address; body: Uint8Array } }

function bytes32(value: unknown, where: string): Hex {
  if (typeof value !== "string") throw new MidaError("INVALID_WIRE", `${where} must be a string`)
  try {
    return assertHex(value, 32)
  } catch {
    throw new MidaError("INVALID_WIRE", `${where} must be lowercase bytes32`)
  }
}

/** Task 23 stage: request authentication and the §12.5 revocation routes. Task 24 replaces this file with every §12 route. */
export function createContextApi(options: ContextApiOptions) {
  const { reader, deployment } = options
  const clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  const overlay = new DenyOverlay(`${options.dataDir}/revocations.json`)
  const replay = new ReplayGuard(`${options.dataDir}/replay-nonces.json`)
  const app = new Hono<Env>()

  app.onError((error, c) => {
    const { status, body } = toErrorBody(error)
    return c.json(body, status as 400)
  })

  const authenticated = createMiddleware<Env>(async (c, next) => {
    const body = new Uint8Array(await c.req.arrayBuffer())
    c.set(
      "signer",
      authenticateRequest({
        method: c.req.method,
        url: new URL(c.req.url),
        headers: c.req.raw.headers,
        body,
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        now: clock(),
        replay,
      }),
    )
    c.set("body", body)
    await next()
  })

  const json = <T>(body: Uint8Array): T => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T
    } catch {
      throw new MidaError("INVALID_WIRE", "request body must be UTF-8 JSON")
    }
  }

  /** §12.5: owner-authenticated. The target must exist and belong to the signer before the deny is recorded. */
  app.post("/revocations", authenticated, async (c) => {
    const owner = c.get("signer")
    const request = json<{ capabilityId?: unknown; agentId?: unknown }>(c.get("body"))
    let target: RevocationTarget
    let agentEpochAtIntent: bigint | null = null
    if (request.capabilityId !== undefined) {
      const capabilityId = bytes32(request.capabilityId, "capabilityId")
      const capability = await reader.getCapability(capabilityId)
      if (capability === null || capability.owner !== owner) throw new MidaError("CAPABILITY_DENIED", "capability is not the signer's")
      target = { kind: "capability", capabilityId }
    } else if (request.agentId !== undefined) {
      const agentId = bytes32(request.agentId, "agentId")
      if ((await reader.getAgent(agentId)) === null) throw new MidaError("NOT_FOUND", "agent not found")
      target = { kind: "agent", agentId }
      agentEpochAtIntent = await reader.agentEpoch(owner, agentId)
    } else {
      throw new MidaError("INVALID_WIRE", "revocation needs capabilityId or agentId")
    }
    const intent = overlay.create(owner, target, agentEpochAtIntent)
    return c.json({ intentId: intent.id, state: intent.state, cancellationNonce: intent.cancellationNonce })
  })

  /** §12.5 cancellation restores authority, so it needs a fresh P256 assertion with UV, not just a session signature. */
  app.post("/revocations/:id/cancel", authenticated, async (c) => {
    const owner = c.get("signer")
    const id = bytes32(c.req.param("id"), "id")
    const request = json<{ expiresAt?: string; assertion?: WebAuthnAssertionInput }>(c.get("body"))
    const intent = overlay.get(id)
    if (intent === undefined || intent.owner !== owner) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null) throw new MidaError("REPLAY", "revocation intent is not cancellable")
    if (request.assertion === undefined || typeof request.expiresAt !== "string" || !/^(0|[1-9][0-9]*)$/.test(request.expiresAt)) {
      throw new MidaError("AUTH_INVALID", "cancellation requires a fresh passkey assertion and expiresAt")
    }
    const expiresAt = BigInt(request.expiresAt)
    const now = clock()
    if (now >= expiresAt || expiresAt - now > CANCELLATION_MAX_LIFETIME_SECONDS) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is expired or valid for more than five minutes")
    }
    const key = await reader.ownerP256Key(owner)
    const nonce = BigInt(intent.cancellationNonce)
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner,
      revocationIntentId: intent.id,
      apiCancellationNonce: nonce,
      expiresAt,
    })
    if (key === null || !verifyVaultAssertion({ challenge, assertion: request.assertion, qx: key.qx, qy: key.qy, rpIdHash: deployment.vaultRpIdHash })) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is not a valid owner passkey assertion")
    }
    const cancelled = overlay.cancel(intent.id, owner, nonce)
    return c.json({ intentId: cancelled.id, state: cancelled.state })
  })

  return { app, overlay }
}
```

`apps/api/src/index.ts`:
```ts
export * from "./auth.js"
export * from "./authorize.js"
export * from "./chain-views.js"
export * from "./client.js"
export * from "./deny-overlay.js"
export * from "./errors.js"
export * from "./verify-assertion.js"
export * from "./app.js"
```

- [ ] **Step 7: Run to verify they pass**

Run:
```bash
pnpm vitest run apps/api
pnpm typecheck
```
Expected: `Test Files 3 passed`, `Tests 20 passed`. Typecheck exits 0. What the three files prove:
- **The verifier matches the contract.** `verify-assertion` accepts exactly what `MidaWebAuthn` plus webauthn-sol accept. It rejects another RP ID, a missing UV or UP flag, a wrong challenge, a create ceremony, high-s and truncated data. The foreign-origin case passes, which is the documented v0 limitation.
- **Authentication is strict.** `auth` binds the method, target, body, registry and time. It allows exactly ±60 seconds and rejects replay, including after a new API instance starts on the same data directory.
- **Authorization follows §12.1 order.** In `authorization`, an unknown signer, a missing or foreign capability, wrong namespace, missing bit and stale key version each fail with their own code. A local deny fires at step 4, before steps 6–8, while Monad still authorizes. Expiry fires at step 5, before the namespace and key checks. A lying reader cannot make Monad authorization true.
- **The deny overlay behaves as §12.5 says.** Cancellation needs a fresh passkey assertion from the owner's key, valid for at most five minutes, and cannot be replayed. A deny anchors only after the chain revocation, and never on a timer.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml apps/api
git commit -m "feat(api): signed request auth, ordered chain-bounded authorization and the fast revocation overlay

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 24: Context API: objects, manifests, agent manifests, epoch wraps

**Depends on:** Task 23.

**Files:**
- Create: `apps/api/src/store.ts`, `apps/api/src/wire.ts`
- Replace: `apps/api/src/app.ts` (every §12 route), `apps/api/src/client.ts` (typed route methods), `apps/api/src/deny-overlay.ts` (adds `deniesRelationship`)
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/routes.test.ts`

**Interfaces:**
- Consumes: Task 23 in full; Part A `OWNER_AUTHOR_ID`, `PERMISSION`, `contextId`, `decodeUint64`, `encodeUint64`, `isMidaError`, `namespaceById`, `CRYPTO_VERSION`; Part B `bytesOf`, `hexOf`, `manifestHash`, `verifyObjectManifest`, `FsStorage`; Part C `manifestBodyHash`, `manifestEnvelopeBytes`, `manifestEnvelopeHash`, `parseManifestEnvelopeBytes`, `validateManifestBody`, `verifySignedManifest`.
- Produces, `store.ts`: `interface StoredObject`, `class ApiStore { blobs: FsStorage; putObject; getObject; listObjects(owner, namespaceId); putWrap; getWrap; setManifestIndex(bodyHash, envelopeHash); getManifestIndex(bodyHash) }`.
- Produces, `wire.ts`: `interface ObjectUploadBody { owner; namespaceId; objectNonce; expectedParentId; manifest; ciphertext; capabilityId? }`, `interface AnchoredObject`, `hex(value, bytes, where)`, `address(value, where)`, `parseObjectManifest`, `parseObjectUpload`, `parseReaderWrap`.
- Produces, `deny-overlay.ts`: adds `deniesRelationship(reader, { owner; agentId; namespaceId }): Promise<boolean>`.
- Produces, `client.ts`: `interface ContextApiRoutes` and `ContextApiClient implements ContextApiRoutes` with `putObject`, `listObjects`, `getManifest`, `putAgentManifest`, `getAgentManifest`, `publishEpochWrap`, `getEpochWrap`, `requestRevocationDeny`, `cancelRevocation`. `ContextApiClient` satisfies Task 22's `VaultContextApi`.
- Produces, `app.ts`: `createContextApi(options): { app; overlay; store }` serving `PUT /objects`, `GET /objects`, `GET /manifests/:contextId`, `PUT /agent-manifests`, `GET /agent-manifests/:bodyHash`, `POST /epoch-wraps`, `GET /epoch-wraps`, `POST /revocations`, `POST /revocations/:id/cancel`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/routes.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  contextId as deriveContextId,
  namespaceId,
} from "@mida/protocol"
import type { ContextPayload, Hex } from "@mida/protocol"
import { bytesOf, hexOf, openContextObject, sealContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  contextRegistryAbi,
  createWriteContext,
  deployLocal,
  fundLocal,
  increaseLocalTime,
  latestTimestamp,
  sendContract,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, provisionAgent } from "@mida/fake-vault"
import type { AgentDeclaration, GrantSelection, ProvisionedAgent } from "@mida/fake-vault"
import { randomBytes } from "@noble/hashes/utils.js"
import { ContextApiClient, RegistryReader, createContextApi } from "@mida/api"
import type { ApiStore, ObjectUploadBody } from "@mida/api"

const CAREER = namespaceId("goals.career")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`
const GOAL: ContextPayload = { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } }
const READ_CAREER = [{ namespace: "goals.career", permissions: PERMISSION.READ }]

describe("Context API routes (plan Task 24)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let reader: RegistryReader
  let store: ApiStore
  let app: ReturnType<typeof createContextApi>["app"]
  let vault: FakeVaultAuthority
  let aliceContextId: Hex
  const agents: Record<string, ProvisionedAgent> = {}
  const clients: Record<string, ContextApiClient> = {}
  const capabilities: Record<string, Hex> = {}

  const clientFor = (account: LocalAccount) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => app.request(url, init),
    })

  async function provision(label: string, index: number, declarations: AgentDeclaration[]) {
    const operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[index]!) })
    const agent = await provisionAgent({ operator, name: label, purposeId: "career_coaching", declarations, callbackOrigin: `https://${label.toLowerCase()}.example` })
    await fundLocal(node.rpcUrl, agent.signer.address)
    agents[label] = agent
    clients[label] = clientFor(agent.signer)
  }

  async function grant(label: string, scopes: Array<{ namespace: string; permissions: number; provenancePolicy?: number }>, selection: GrantSelection = { kind: "recommended" }) {
    const accessRequest = await buildSignedAccessRequest({ chain: owner, agent: agents[label]!, scopes })
    const approval = await vault.approveGrant({ accessRequest, manifest: agents[label]!.manifest, selection })
    capabilities[label] = approval.response.capabilities[0]!.capabilityId
  }

  /** An agent-authored root object under the current epoch, sealed with only the public epoch key. */
  async function agentObject(label: string, overrides: Partial<ObjectUploadBody> = {}) {
    const agent = agents[label]!
    const readEpoch = await reader.requiredReadEpoch(vault.owner, CAREER)
    const epochPublicKey = (await reader.epochPublicKey(vault.owner, CAREER, readEpoch))!
    const objectNonce = hexOf(randomBytes(32))
    const contextId = deriveContextId({ chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, owner: vault.owner, authorId: agent.agentId, namespaceId: CAREER, objectNonce })
    const payload: ContextPayload = { v: 1, value: `${label} inference`, kind: "INFERENCE", provenance: { source: "AGENT_INFERRED" } }
    const sealed = sealContextObject({
      payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId: CAREER, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    const upload: ObjectUploadBody = {
      owner: vault.owner,
      namespaceId: CAREER,
      objectNonce,
      expectedParentId: zeroHash,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
      ...(capabilities[label] === undefined ? {} : { capabilityId: capabilities[label] }),
      ...overrides,
    }
    const register = () =>
      sendContract(createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }), {
        address: deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "register",
        args: [
          vault.owner,
          [
            {
              contextId, objectNonce, namespaceId: CAREER, expectedParentId: zeroHash, manifestHash: sealed.manifestHash,
              ciphertextCommitment: sealed.ciphertextCommitment, evidenceCommitment: zeroHash, readEpoch, expiresAt: 0n,
              recordType: RECORD_TYPE.CONTEXT, lineagePolicy: LINEAGE_POLICY.STANDARD, kind: CONTEXT_KIND.INFERENCE,
              provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
            },
          ],
        ],
      })
    return { upload, contextId, register }
  }

  const wrapFor = (label: string, readEpoch: bigint, agentKeyVersion = 1) =>
    clients[label]!.getEpochWrap({
      owner: vault.owner,
      namespaceId: CAREER,
      readEpoch,
      agentId: agents[label]!.agentId,
      agentKeyVersion,
      capabilityId: capabilities[label] ?? hexOf(randomBytes(32)),
    })

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    reader = new RegistryReader(owner)
    const api = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-routes-")) })
    app = api.app
    store = api.store
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api: clientFor(owner.account) })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await provision("R", 2, [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("W", 3, [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }])
    await provision("X", 4, [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("T", 5, [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("S", 6, [{ namespace: "goals.career", permissions: ["READ"] }])
    await grant("R", READ_CAREER)
    await grant("W", [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }])
    await grant("T", READ_CAREER)
    aliceContextId = (await vault.createOwnerContext({ namespace: "goals.career", payload: GOAL })).contextId
  }, 300_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("stores signed agent manifests by body hash and fails closed on a missing, stale or mismatched envelope", async () => {
    const publicClient = clients.R!
    expect(await publicClient.putAgentManifest(agents.R!.manifest)).toMatchObject({ bodyHash: agents.R!.manifestHash })
    expect(await publicClient.getAgentManifest(agents.R!.manifestHash)).toEqual(agents.R!.manifest)
    await expect(publicClient.getAgentManifest(hexOf(randomBytes(32)))).rejects.toMatchObject({ code: "MANIFEST_NOT_FOUND" })

    // A body mutated after signing indexes under a new hash that no AgentRecord commits to.
    const mutated = { ...agents.R!.manifest, manifest: { ...agents.R!.manifest.manifest, name: "Renamed" } }
    const { bodyHash } = await publicClient.putAgentManifest(mutated)
    await expect(publicClient.getAgentManifest(bodyHash)).rejects.toMatchObject({ code: "MANIFEST_HASH_MISMATCH" })

    // The body-hash index pointing at another agent's envelope bytes is detected.
    const other = await publicClient.putAgentManifest(agents.W!.manifest)
    store.setManifestIndex(agents.R!.manifestHash, other.envelopeHash)
    await expect(publicClient.getAgentManifest(agents.R!.manifestHash)).rejects.toMatchObject({ code: "MANIFEST_HASH_MISMATCH" })
  })

  it("serves anchored owner context to an authorized reader, who decrypts it with its own epoch wrap", async () => {
    const objects = await clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.R! })
    const object = objects.find((candidate) => candidate.contextId === aliceContextId)!
    expect(object.authorId).toBe(zeroHash)
    const wrap = await wrapFor("R", 1n)
    const epochPrivateKey = unwrapEpochPrivateKey({
      wrap,
      agentEncryptionPrivateKey: agents.R!.encryptionPrivateKey,
      binding: { chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, owner: vault.owner, namespaceId: CAREER, readEpoch: 1n, agentId: agents.R!.agentId, agentKeyVersion: 1 },
    })
    const record = (await reader.getRecord(aliceContextId))!
    const payload = openContextObject({
      manifest: object.manifest,
      expectedManifestHash: record.manifestHash,
      ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
      epochPrivateKey,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: aliceContextId, namespaceId: CAREER, readEpoch: 1n },
    })
    expect(payload.value).toBe("Prioritize systems engineering")
    expect((await clientFor(owner.account).listObjects({ owner: vault.owner, namespaceId: CAREER })).map((o) => o.contextId)).toContain(aliceContextId)
  })

  it("denies an agent with no capability, a forged capability id, and a CREATE-only agent's reads and wraps", async () => {
    await expect(clients.X!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.W! })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(clients.W!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.W! })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(wrapFor("W", 1n)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(wrapFor("X", 1n)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("keeps an upload pending, and out of every read, until Monad holds its commitments", async () => {
    const written = await agentObject("W")
    expect(await clients.W!.putObject(written.upload)).toMatchObject({ contextId: written.contextId, state: "pending" })
    const ids = async () => (await clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.R! })).map((o) => o.contextId)
    expect(await ids()).not.toContain(written.contextId)
    await expect(clients.R!.getManifest(written.contextId, capabilities.R!)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await written.register()
    expect(await ids()).toContain(written.contextId)
    expect((await clients.R!.getManifest(written.contextId, capabilities.R!)).manifest.contextId).toBe(written.contextId)
  })

  it("rejects mutated ciphertext, a contextId not derived from the uploader, and an agent without CREATE", async () => {
    const written = await agentObject("W")
    const flipped = `${written.upload.ciphertext.slice(0, -2)}${written.upload.ciphertext.endsWith("00") ? "01" : "00"}` as Hex
    await expect(clients.W!.putObject({ ...written.upload, ciphertext: flipped })).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" })
    await expect(clients.W!.putObject({ ...written.upload, objectNonce: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
    // W's object uploaded by R's signer derives a different contextId (author R), so it cannot be passed off as W's.
    await expect(clients.R!.putObject({ ...written.upload, capabilityId: capabilities.R! })).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
    const byX = await agentObject("X", { capabilityId: hexOf(randomBytes(32)) })
    await expect(clients.X!.putObject(byX.upload)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("accepts a wrap only from the owner, for a registered epoch, the current key version and live READ", async () => {
    const genuine = await wrapFor("R", 1n)
    const ownerClient = clientFor(owner.account)
    await expect(clients.R!.publishEpochWrap(genuine)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, agentId: agents.X!.agentId })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, agentKeyVersion: 2 })).rejects.toMatchObject({ code: "WRAP_KEY_VERSION_MISMATCH" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, readEpoch: "3" })).rejects.toMatchObject({ code: "EPOCH_STALE" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, wrappedEpochPrivateKey: `0x${"00".repeat(47)}` })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    expect(await ownerClient.publishEpochWrap(genuine)).toEqual({ stored: true })
  })

  it("after revoking T: old-epoch uploads are stale, T is revoked, and remaining reader R waits for its epoch-2 wrap", async () => {
    const staleUpload = await agentObject("W")
    await vault.approveRevocation({ kind: "capability", capabilityId: capabilities.T! })
    expect(await reader.requiredReadEpoch(vault.owner, CAREER)).toBe(2n)
    await expect(clients.W!.putObject(staleUpload.upload)).rejects.toMatchObject({ code: "EPOCH_STALE" })
    await expect(wrapFor("T", 1n)).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })

    await expect(wrapFor("R", 2n)).rejects.toMatchObject({ code: "NO_EPOCH_WRAP" })
    expect(await vault.publishReaderWraps({ agentId: agents.R!.agentId, namespaceId: CAREER })).toEqual([1n, 2n])
    expect((await wrapFor("R", 2n)).readEpoch).toBe("2")

    const fresh = await agentObject("W")
    expect(await clients.W!.putObject(fresh.upload)).toMatchObject({ state: "pending" })
    await fresh.register()
  })

  it("an expired write deadline closes new writes, leaves a valid reader's history readable, and rotation resumes writes", async () => {
    await grant("S", READ_CAREER, {
      kind: "custom",
      scopes: [{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }],
      expiresAt: (await latestTimestamp(owner)) + 120n,
    })
    await increaseLocalTime(node.rpcUrl, 200n)
    const blocked = await agentObject("W")
    await expect(clients.W!.putObject(blocked.upload)).rejects.toMatchObject({ code: "EPOCH_ROTATION_REQUIRED" })
    const history = await clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.R! })
    expect(history.map((object) => object.contextId)).toContain(aliceContextId)
    expect((await wrapFor("R", 1n)).readEpoch).toBe("1")
    await expect(wrapFor("S", 2n)).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" })

    // §7.3 expiry: the owner publishes the next epoch key and writes resume under it.
    expect(await vault.rotateExpiredEpoch(CAREER)).toMatchObject({ readEpoch: 3n })
    const resumed = await agentObject("W")
    expect(resumed.upload.manifest.readEpoch).toBe("3")
    expect(await clients.W!.putObject(resumed.upload)).toMatchObject({ state: "pending" })
    await resumed.register()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/api/test/routes.test.ts`
Expected: FAIL in `beforeAll` or the first test, with `clientFor(...).putAgentManifest is not a function` or `vault.createOwnerContext` failing on `putObject is not a function`. Task 23's client has no route methods yet.

- [ ] **Step 3: Implement persistence and strict wire validation**

`apps/api/src/store.ts`:
```ts
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"
import { FsStorage } from "@mida/storage"

/** A ciphertext upload's immutable metadata. Served as context only after Monad holds matching commitments (§12.2). */
export interface StoredObject {
  contextId: Hex
  owner: Address
  namespaceId: Hex
  authorId: Hex
  objectNonce: Hex
  expectedParentId: Hex
  manifest: ObjectManifest
  manifestHash: Hex
  uploadedAt: string
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2))
  renameSync(temporary, path)
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

/**
 * Context API persistence: content-addressed blobs in FsStorage (ciphertext and signed manifest envelopes), plus
 * JSON files for object metadata, reader wraps and the manifest body-hash index. Every path segment is validated hex.
 */
export class ApiStore {
  readonly blobs: FsStorage
  readonly #dir: string

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.blobs = new FsStorage(join(dataDir, "blobs"))
  }

  putObject(object: StoredObject): void {
    const path = join(this.#dir, "objects", `${object.contextId}.json`)
    const existing = readJson<StoredObject>(path)
    if (existing !== undefined) {
      if (existing.manifestHash !== object.manifestHash) {
        throw new MidaError("COMMITMENT_MISMATCH", "a different manifest is already stored for this contextId")
      }
      return
    }
    writeJsonAtomic(path, object)
  }

  getObject(contextId: Hex): StoredObject | undefined {
    return readJson<StoredObject>(join(this.#dir, "objects", `${contextId}.json`))
  }

  listObjects(owner: Address, namespaceId: Hex): StoredObject[] {
    let names: string[]
    try {
      names = readdirSync(join(this.#dir, "objects")).filter((name) => name.endsWith(".json"))
    } catch {
      return []
    }
    return names
      .map((name) => readJson<StoredObject>(join(this.#dir, "objects", name)))
      .filter((object): object is StoredObject => object !== undefined && object.owner === owner && object.namespaceId === namespaceId)
      .sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.contextId < b.contextId ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1))
  }

  #wrapPath(key: { owner: Address; namespaceId: Hex; readEpoch: string; agentId: Hex; agentKeyVersion: number }): string {
    return join(this.#dir, "wraps", key.owner, key.namespaceId, key.readEpoch, `${key.agentId}-${key.agentKeyVersion}.json`)
  }

  putWrap(wrap: ReaderEpochWrap): void {
    writeJsonAtomic(this.#wrapPath(wrap), wrap)
  }

  getWrap(key: { owner: Address; namespaceId: Hex; readEpoch: string; agentId: Hex; agentKeyVersion: number }): ReaderEpochWrap | undefined {
    return readJson<ReaderEpochWrap>(this.#wrapPath(key))
  }

  setManifestIndex(bodyHash: Hex, envelopeHash: Hex): void {
    writeJsonAtomic(join(this.#dir, "agent-manifests", `${bodyHash}.json`), { envelopeHash })
  }

  getManifestIndex(bodyHash: Hex): Hex | undefined {
    return readJson<{ envelopeHash: Hex }>(join(this.#dir, "agent-manifests", `${bodyHash}.json`))?.envelopeHash
  }
}
```

`apps/api/src/wire.ts`:
```ts
import { CRYPTO_VERSION, MidaError, assertHex, decodeUint64 } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"

/** PUT /objects body (§12.2). `capabilityId` names the agent's exact capability; owners omit it. */
export interface ObjectUploadBody {
  owner: Address
  namespaceId: Hex
  objectNonce: Hex
  expectedParentId: Hex
  manifest: ObjectManifest
  ciphertext: Hex
  capabilityId?: Hex
}

/** One element of GET /objects (§12.3). Clients re-check both commitments against Monad before decrypting. */
export interface AnchoredObject {
  contextId: Hex
  owner: Address
  namespaceId: Hex
  authorId: Hex
  manifest: ObjectManifest
  manifestHash: Hex
  ciphertext: Hex
}

function wire(detail: string): never {
  throw new MidaError("INVALID_WIRE", detail)
}

function object(value: unknown, where: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return wire(`${where} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of keys) if (!Object.hasOwn(record, key)) wire(`${where}.${key} is required`)
  for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) wire(`${where}.${key} is not allowed`)
  return record
}

export function hex(value: unknown, bytes: number, where: string): Hex {
  if (typeof value !== "string") return wire(`${where} must be a string`)
  try {
    return assertHex(value, bytes)
  } catch {
    return wire(`${where} must be lowercase 0x hex of ${bytes} bytes`)
  }
}

export function address(value: unknown, where: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) return wire(`${where} must be a lowercase address`)
  return value as Address
}

function uint64(value: unknown, where: string): string {
  if (typeof value !== "string") return wire(`${where} must be a base-10 string`)
  decodeUint64(value)
  return value
}

export function parseObjectManifest(value: unknown): ObjectManifest {
  const manifest = object(value, "manifest", ["v", "contextId", "ciphertextHash", "ciphertextSize", "payloadNonce", "cryptoVersion", "readEpoch", "epochDekWrap"])
  if (manifest.v !== 1) wire("manifest.v must be 1")
  if (manifest.cryptoVersion !== CRYPTO_VERSION) wire(`manifest.cryptoVersion must be ${CRYPTO_VERSION}`)
  if (!Number.isSafeInteger(manifest.ciphertextSize) || (manifest.ciphertextSize as number) < 0) wire("manifest.ciphertextSize must be a non-negative integer")
  const wrap = object(manifest.epochDekWrap, "manifest.epochDekWrap", ["v", "contextId", "namespaceId", "readEpoch", "ephemeralPublicKey", "nonce", "wrappedDek"])
  if (wrap.v !== 1) wire("manifest.epochDekWrap.v must be 1")
  return {
    v: 1,
    contextId: hex(manifest.contextId, 32, "manifest.contextId"),
    ciphertextHash: hex(manifest.ciphertextHash, 32, "manifest.ciphertextHash"),
    ciphertextSize: manifest.ciphertextSize as number,
    payloadNonce: hex(manifest.payloadNonce, 24, "manifest.payloadNonce"),
    cryptoVersion: CRYPTO_VERSION,
    readEpoch: uint64(manifest.readEpoch, "manifest.readEpoch"),
    epochDekWrap: {
      v: 1,
      contextId: hex(wrap.contextId, 32, "epochDekWrap.contextId"),
      namespaceId: hex(wrap.namespaceId, 32, "epochDekWrap.namespaceId"),
      readEpoch: uint64(wrap.readEpoch, "epochDekWrap.readEpoch"),
      ephemeralPublicKey: hex(wrap.ephemeralPublicKey, 32, "epochDekWrap.ephemeralPublicKey"),
      nonce: hex(wrap.nonce, 24, "epochDekWrap.nonce"),
      wrappedDek: hex(wrap.wrappedDek, 48, "epochDekWrap.wrappedDek"),
    },
  }
}

export function parseObjectUpload(value: unknown): ObjectUploadBody {
  const body = object(value, "upload", ["owner", "namespaceId", "objectNonce", "expectedParentId", "manifest", "ciphertext"], ["capabilityId"])
  if (typeof body.ciphertext !== "string" || !/^0x([0-9a-f]{2})*$/.test(body.ciphertext)) wire("ciphertext must be lowercase 0x hex")
  return {
    owner: address(body.owner, "owner"),
    namespaceId: hex(body.namespaceId, 32, "namespaceId"),
    objectNonce: hex(body.objectNonce, 32, "objectNonce"),
    expectedParentId: hex(body.expectedParentId, 32, "expectedParentId"),
    manifest: parseObjectManifest(body.manifest),
    ciphertext: body.ciphertext as Hex,
    ...(body.capabilityId === undefined ? {} : { capabilityId: hex(body.capabilityId, 32, "capabilityId") }),
  }
}

/** §12.4 step 6: every wrap field present, correctly typed and of the exact byte length. */
export function parseReaderWrap(value: unknown): ReaderEpochWrap {
  const wrap = object(value, "wrap", [
    "v", "owner", "namespaceId", "readEpoch", "agentId", "agentKeyVersion", "ephemeralPublicKey", "nonce", "wrappedEpochPrivateKey", "createdAt",
  ])
  if (wrap.v !== 1) wire("wrap.v must be 1")
  if (!Number.isSafeInteger(wrap.agentKeyVersion) || (wrap.agentKeyVersion as number) < 1 || (wrap.agentKeyVersion as number) > 0xffffffff) {
    wire("wrap.agentKeyVersion must be a uint32 of at least 1")
  }
  return {
    v: 1,
    owner: address(wrap.owner, "wrap.owner"),
    namespaceId: hex(wrap.namespaceId, 32, "wrap.namespaceId"),
    readEpoch: uint64(wrap.readEpoch, "wrap.readEpoch"),
    agentId: hex(wrap.agentId, 32, "wrap.agentId"),
    agentKeyVersion: wrap.agentKeyVersion as number,
    ephemeralPublicKey: hex(wrap.ephemeralPublicKey, 32, "wrap.ephemeralPublicKey"),
    nonce: hex(wrap.nonce, 24, "wrap.nonce"),
    wrappedEpochPrivateKey: hex(wrap.wrappedEpochPrivateKey, 48, "wrap.wrappedEpochPrivateKey"),
    createdAt: uint64(wrap.createdAt, "wrap.createdAt"),
  }
}
```

- [ ] **Step 4: Replace the deny overlay, the client and the app**

Replace `apps/api/src/deny-overlay.ts`:
```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { RegistryReader } from "./chain-views.js"

export type RevocationTarget = { kind: "capability"; capabilityId: Hex } | { kind: "agent"; agentId: Hex }

export type DenyState = "active" | "anchored" | "cancelled"

export interface RevocationIntent {
  id: Hex
  owner: Address
  target: RevocationTarget
  state: DenyState
  /** Owner-agent epoch when the intent was recorded; an agent revocation is anchored once the chain epoch exceeds it. */
  agentEpochAtIntent: string | null
  /** Base-10 uint256 consumed by a successful cancellation; null once consumed or no longer cancellable. */
  cancellationNonce: string | null
}

/**
 * §12.5 fast revocation overlay, persisted as one JSON file. Exactly three transitions exist:
 *   active → anchored   matching Monad revocation observed (reconcile)
 *   active → active     transaction failed, missing or reorged out (no timeout ever clears a deny)
 *   active → cancelled  fresh owner P256-approved cancellation (cancel)
 * It can only reduce authority: `effectiveAllowed = currentlyAllowedByMonad AND NOT localDeny`.
 */
export class DenyOverlay {
  readonly #file: string
  #intents: RevocationIntent[]

  constructor(file: string) {
    this.#file = file
    try {
      this.#intents = JSON.parse(readFileSync(file, "utf8")) as RevocationIntent[]
    } catch {
      this.#intents = []
    }
  }

  list(): readonly RevocationIntent[] {
    return this.#intents.map((intent) => ({ ...intent }))
  }

  get(id: Hex): RevocationIntent | undefined {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    return intent === undefined ? undefined : { ...intent }
  }

  create(owner: Address, target: RevocationTarget, agentEpochAtIntent: bigint | null): RevocationIntent {
    const intent: RevocationIntent = {
      id: hexOf(randomBytes(32)),
      owner: owner.toLowerCase() as Address,
      target:
        target.kind === "capability"
          ? { kind: "capability", capabilityId: target.capabilityId.toLowerCase() as Hex }
          : { kind: "agent", agentId: target.agentId.toLowerCase() as Hex },
      state: "active",
      agentEpochAtIntent: agentEpochAtIntent === null ? null : agentEpochAtIntent.toString(10),
      cancellationNonce: BigInt(hexOf(randomBytes(32))).toString(10),
    }
    this.#intents.push(intent)
    this.#save()
    return { ...intent }
  }

  /** True when an active deny matches this owner and either this agent relationship or this exact capability. */
  denies(input: { owner: Address; agentId: Hex; capabilityId: Hex }): boolean {
    const owner = input.owner.toLowerCase()
    return this.#intents.some(
      (intent) =>
        intent.state === "active" &&
        intent.owner === owner &&
        (intent.target.kind === "agent"
          ? intent.target.agentId === input.agentId.toLowerCase()
          : intent.target.capabilityId === input.capabilityId.toLowerCase()),
    )
  }

  /**
   * For wrap publication, which names no capability: an active deny on this agent, or on any of its capabilities in
   * this namespace, blocks publication.
   */
  async deniesRelationship(reader: RegistryReader, input: { owner: Address; agentId: Hex; namespaceId: Hex }): Promise<boolean> {
    const owner = input.owner.toLowerCase()
    const agentId = input.agentId.toLowerCase()
    for (const intent of this.#intents) {
      if (intent.state !== "active" || intent.owner !== owner) continue
      if (intent.target.kind === "agent") {
        if (intent.target.agentId === agentId) return true
        continue
      }
      const capability = await reader.getCapability(intent.target.capabilityId)
      if (capability !== null && capability.agentId === agentId && capability.namespaceId === input.namespaceId.toLowerCase()) return true
    }
    return false
  }

  /** active → anchored only when Monad shows the matching revocation. Failed or missing transactions leave it active. */
  async reconcile(reader: RegistryReader): Promise<void> {
    let changed = false
    for (const intent of this.#intents) {
      if (intent.state !== "active") continue
      const anchored =
        intent.target.kind === "capability"
          ? (await reader.getCapability(intent.target.capabilityId))?.revoked === true
          : (await reader.agentEpoch(intent.owner, intent.target.agentId)) > BigInt(intent.agentEpochAtIntent ?? "0")
      if (anchored) {
        intent.state = "anchored"
        intent.cancellationNonce = null
        changed = true
      }
    }
    if (changed) this.#save()
  }

  /** active → cancelled. The caller must already have verified a fresh P256 assertion over this nonce. */
  cancel(id: Hex, owner: Address, nonce: bigint): RevocationIntent {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    if (intent === undefined || intent.owner !== owner.toLowerCase()) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null || BigInt(intent.cancellationNonce) !== nonce) {
      throw new MidaError("REPLAY", "revocation intent is not cancellable with this nonce")
    }
    intent.state = "cancelled"
    intent.cancellationNonce = null
    this.#save()
    return { ...intent }
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#intents, null, 2))
    renameSync(temporary, this.#file)
  }
}
```

Replace `apps/api/src/client.ts`:
```ts
import { httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap, SignedAgentCapabilityManifest } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { LocalAccount } from "viem"
import { AUTH_HEADERS, targetOf } from "./auth.js"
import { errorFromBody } from "./errors.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"
import type { AnchoredObject, ObjectUploadBody } from "./wire.js"

export interface ContextApiClientOptions {
  baseUrl: string
  account: LocalAccount
  chainId: bigint
  capabilityRegistry: Address
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  clock?: () => bigint
}

/**
 * Signs every request with MidaHttpRequestV1 (§12.1); the signature covers the exact body bytes sent. The typed route
 * methods implement the FakeVault's VaultContextApi port structurally, so the same client serves owners and agents.
 */
export class ContextApiClient implements ContextApiRoutes {
  readonly account: LocalAccount
  readonly #options: ContextApiClientOptions

  constructor(options: ContextApiClientOptions) {
    this.account = options.account
    this.#options = options
  }

  async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown; signed?: boolean } = {}): Promise<T> {
    const url = new URL(path, this.#options.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    const body = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body))
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (options.signed !== false) {
      const timestamp = (this.#options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000))))()
      const nonce = hexOf(randomBytes(32))
      const signature = await this.account.signTypedData(
        httpRequestTypedData({
          chainId: this.#options.chainId,
          capabilityRegistry: this.#options.capabilityRegistry,
          signer: this.account.address,
          method,
          target: targetOf(url),
          body,
          timestamp,
          nonce,
        }) as never,
      )
      headers[AUTH_HEADERS.signer] = this.account.address
      headers[AUTH_HEADERS.timestamp] = timestamp.toString(10)
      headers[AUTH_HEADERS.nonce] = nonce
      headers[AUTH_HEADERS.signature] = signature
    }
    const doFetch = this.#options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
    const response = await doFetch(url.toString(), {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    })
    const text = await response.text()
    const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
    if (!response.ok) throw errorFromBody(response.status, parsed)
    return parsed as T
  }

  putObject(upload: ObjectUploadBody) {
    return this.request<{ contextId: Hex; manifestHash: Hex; state: "pending" }>("PUT", "/objects", { body: upload })
  }

  async listObjects(input: { owner: Address; namespaceId: Hex; capabilityId?: Hex }) {
    const query = { owner: input.owner.toLowerCase(), namespaceId: input.namespaceId, ...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }) }
    return (await this.request<{ objects: AnchoredObject[] }>("GET", "/objects", { query })).objects
  }

  getManifest(contextId: Hex, capabilityId?: Hex) {
    return this.request<{ manifest: ObjectManifest; manifestHash: Hex }>("GET", `/manifests/${contextId}`, capabilityId === undefined ? {} : { query: { capabilityId } })
  }

  putAgentManifest(envelope: SignedAgentCapabilityManifest) {
    return this.request<{ bodyHash: Hex; envelopeHash: Hex }>("PUT", "/agent-manifests", { body: envelope, signed: false })
  }

  getAgentManifest(bodyHash: Hex) {
    return this.request<SignedAgentCapabilityManifest>("GET", `/agent-manifests/${bodyHash}`, { signed: false })
  }

  publishEpochWrap(wrap: ReaderEpochWrap) {
    return this.request<{ stored: true }>("POST", "/epoch-wraps", { body: wrap })
  }

  getEpochWrap(input: { owner: Address; namespaceId: Hex; readEpoch: bigint; agentId: Hex; agentKeyVersion: number; capabilityId: Hex }) {
    return this.request<ReaderEpochWrap>("GET", "/epoch-wraps", {
      query: {
        owner: input.owner.toLowerCase(),
        namespaceId: input.namespaceId,
        readEpoch: input.readEpoch.toString(10),
        agentId: input.agentId,
        agentKeyVersion: String(input.agentKeyVersion),
        capabilityId: input.capabilityId,
      },
    })
  }

  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }) {
    const body = "capabilityId" in target ? { capabilityId: target.capabilityId } : { agentId: target.agentId }
    return this.request<{ intentId: Hex; state: string; cancellationNonce: string }>("POST", "/revocations", { body })
  }

  cancelRevocation(intentId: Hex, input: { expiresAt: bigint; assertion: WebAuthnAssertionInput }) {
    return this.request<{ intentId: Hex; state: string }>("POST", `/revocations/${intentId}/cancel`, {
      body: { expiresAt: input.expiresAt.toString(10), assertion: input.assertion },
    })
  }
}

export interface ContextApiRoutes {
  putObject(upload: ObjectUploadBody): Promise<{ contextId: Hex; manifestHash: Hex; state: "pending" }>
  listObjects(input: { owner: Address; namespaceId: Hex; capabilityId?: Hex }): Promise<AnchoredObject[]>
  getManifest(contextId: Hex, capabilityId?: Hex): Promise<{ manifest: ObjectManifest; manifestHash: Hex }>
  putAgentManifest(envelope: SignedAgentCapabilityManifest): Promise<{ bodyHash: Hex; envelopeHash: Hex }>
  getAgentManifest(bodyHash: Hex): Promise<SignedAgentCapabilityManifest>
  publishEpochWrap(wrap: ReaderEpochWrap): Promise<{ stored: true }>
  getEpochWrap(input: { owner: Address; namespaceId: Hex; readEpoch: bigint; agentId: Hex; agentKeyVersion: number; capabilityId: Hex }): Promise<ReaderEpochWrap>
  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }): Promise<{ intentId: Hex; state: string; cancellationNonce: string }>
  cancelRevocation(intentId: Hex, input: { expiresAt: bigint; assertion: WebAuthnAssertionInput }): Promise<{ intentId: Hex; state: string }>
}
```

Replace `apps/api/src/app.ts`:
```ts
import {
  MidaError,
  OWNER_AUTHOR_ID,
  PERMISSION,
  cancelFastRevokeDigest,
  contextId as deriveContextId,
  decodeUint64,
  encodeUint64,
  isMidaError,
  namespaceById,
} from "@mida/protocol"
import type { Address, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { bytesOf, hexOf, manifestHash, verifyObjectManifest } from "@mida/crypto"
import type { Deployment } from "@mida/chain"
import {
  manifestBodyHash,
  manifestEnvelopeBytes,
  manifestEnvelopeHash,
  parseManifestEnvelopeBytes,
  validateManifestBody,
  verifySignedManifest,
} from "@mida/grant-advisor"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { zeroHash } from "viem"
import { ReplayGuard, authenticateRequest } from "./auth.js"
import { authorizeAgent } from "./authorize.js"
import type { ContextRecordView, RegistryReader } from "./chain-views.js"
import { DenyOverlay } from "./deny-overlay.js"
import type { RevocationTarget } from "./deny-overlay.js"
import { toErrorBody } from "./errors.js"
import { ApiStore } from "./store.js"
import type { StoredObject } from "./store.js"
import { verifyVaultAssertion } from "./verify-assertion.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"
import { address, hex, parseObjectUpload, parseReaderWrap } from "./wire.js"
import type { AnchoredObject } from "./wire.js"

export const CANCELLATION_MAX_LIFETIME_SECONDS = 300n

export interface ContextApiOptions {
  reader: RegistryReader
  deployment: Deployment
  dataDir: string
  /** Wall-clock seconds for request freshness. Chain time decides capability expiry. */
  clock?: () => bigint
}

type Env = { Variables: { signer: Address; body: Uint8Array } }

function isAnchored(stored: StoredObject, record: ContextRecordView | null): boolean {
  return (
    record !== null &&
    record.owner === stored.owner &&
    record.namespaceId === stored.namespaceId &&
    record.manifestHash === stored.manifestHash &&
    record.ciphertextCommitment === stored.manifest.ciphertextHash
  )
}

/**
 * Minimal Context API (§12). A thin storage and authorization service, never a decryptor: it holds ciphertext,
 * immutable manifests and reader wraps, and every agent operation passes the §12.1 ordered checks against Monad.
 */
export function createContextApi(options: ContextApiOptions) {
  const { reader, deployment } = options
  const clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  const overlay = new DenyOverlay(`${options.dataDir}/revocations.json`)
  const store = new ApiStore(options.dataDir)
  const replay = new ReplayGuard(`${options.dataDir}/replay-nonces.json`)
  const app = new Hono<Env>()

  app.onError((error, c) => {
    const { status, body } = toErrorBody(error)
    return c.json(body, status as 400)
  })

  const authenticated = createMiddleware<Env>(async (c, next) => {
    const body = new Uint8Array(await c.req.arrayBuffer())
    c.set(
      "signer",
      authenticateRequest({
        method: c.req.method,
        url: new URL(c.req.url),
        headers: c.req.raw.headers,
        body,
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        now: clock(),
        replay,
      }),
    )
    c.set("body", body)
    await next()
  })

  const json = <T>(body: Uint8Array): T => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T
    } catch {
      throw new MidaError("INVALID_WIRE", "request body must be UTF-8 JSON")
    }
  }

  const optionalCapability = (value: string | undefined): Hex | undefined =>
    value === undefined ? undefined : hex(value, 32, "capabilityId")

  // ---------- §12.2 object upload ----------
  app.put("/objects", authenticated, async (c) => {
    const signer = c.get("signer")
    const upload = parseObjectUpload(json(c.get("body")))
    namespaceById(upload.namespaceId)
    const { manifest } = upload

    // 1. owner or agent identity
    const isOwner = signer === upload.owner
    let authorId: Hex = OWNER_AUTHOR_ID
    if (!isOwner) {
      const agentId = await reader.agentIdOfSigner(signer)
      if (agentId === null) throw new MidaError("CAPABILITY_DENIED", "signer is neither the owner nor a registered agent")
      authorId = agentId
    }

    // 2–3. canonical manifest hash, ciphertext hash and size
    const ciphertext = bytesOf(upload.ciphertext, (upload.ciphertext.length - 2) / 2)
    const committedManifestHash = manifestHash(manifest)
    if (ciphertext.length !== manifest.ciphertextSize) throw new MidaError("CONTENT_HASH_MISMATCH", "ciphertext size differs from the manifest")
    verifyObjectManifest({ manifest, expectedManifestHash: committedManifestHash, ciphertext })

    // 4. contextId, namespace and read-epoch correspondence
    const expectedContextId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: upload.owner,
      authorId,
      namespaceId: upload.namespaceId,
      objectNonce: upload.objectNonce,
    })
    if (manifest.contextId !== expectedContextId) {
      throw new MidaError("COMMITMENT_MISMATCH", "manifest contextId is not derived from this owner, author, namespace and nonce")
    }
    if (
      manifest.epochDekWrap.contextId !== manifest.contextId ||
      manifest.epochDekWrap.namespaceId !== upload.namespaceId ||
      manifest.epochDekWrap.readEpoch !== manifest.readEpoch
    ) {
      throw new MidaError("MANIFEST_MISMATCH", "object DEK wrap does not correspond to this object, namespace and epoch")
    }

    // 5. the submitted epoch is current and writable
    const readEpoch = decodeUint64(manifest.readEpoch)
    const required = await reader.requiredReadEpoch(upload.owner, upload.namespaceId)
    if (readEpoch !== required) throw new MidaError("EPOCH_STALE", `object uses epoch ${readEpoch}; epoch ${required} is required`)
    if (!(await reader.isWriteEpochValid(upload.owner, upload.namespaceId, required))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the current epoch no longer accepts writes")
    }

    // 6. agent CREATE, or applicable supersession authority
    if (!isOwner) {
      const base = { reader, overlay, signer, owner: upload.owner, capabilityId: upload.capabilityId, namespaceId: upload.namespaceId }
      if (upload.expectedParentId === zeroHash) {
        await authorizeAgent({ ...base, permission: PERMISSION.CREATE })
      } else {
        const parent = await reader.getRecord(upload.expectedParentId)
        if (parent === null || parent.owner !== upload.owner || parent.namespaceId !== upload.namespaceId) {
          throw new MidaError("NOT_FOUND", "expected parent is not a record of this owner and namespace")
        }
        const ownLineage = (await reader.getRecord(parent.lineageId))?.author === authorId
        try {
          await authorizeAgent({ ...base, permission: PERMISSION.SUPERSEDE_ANY })
        } catch (error) {
          if (!ownLineage || !isMidaError(error, "CAPABILITY_DENIED")) throw error
          await authorizeAgent({ ...base, permission: PERMISSION.SUPERSEDE_OWN })
        }
      }
    }

    // 7. store as pending; §12.3 serves it only once Monad holds matching commitments
    await store.blobs.put(ciphertext)
    store.putObject({
      contextId: manifest.contextId,
      owner: upload.owner,
      namespaceId: upload.namespaceId,
      authorId,
      objectNonce: upload.objectNonce,
      expectedParentId: upload.expectedParentId,
      manifest,
      manifestHash: committedManifestHash,
      uploadedAt: new Date().toISOString(),
    })
    return c.json({ contextId: manifest.contextId, manifestHash: committedManifestHash, state: "pending" })
  })

  // ---------- §12.3 object read ----------
  app.get("/objects", authenticated, async (c) => {
    const signer = c.get("signer")
    const owner = address(c.req.query("owner"), "owner")
    const namespaceId = hex(c.req.query("namespaceId"), 32, "namespaceId")
    namespaceById(namespaceId)
    if (signer !== owner) {
      await authorizeAgent({ reader, overlay, signer, owner, capabilityId: optionalCapability(c.req.query("capabilityId")), namespaceId, permission: PERMISSION.READ })
    }
    const objects: AnchoredObject[] = []
    for (const stored of store.listObjects(owner, namespaceId)) {
      if (!isAnchored(stored, await reader.getRecord(stored.contextId))) continue
      objects.push({
        contextId: stored.contextId,
        owner: stored.owner,
        namespaceId: stored.namespaceId,
        authorId: stored.authorId,
        manifest: stored.manifest,
        manifestHash: stored.manifestHash,
        ciphertext: hexOf(await store.blobs.get(stored.manifest.ciphertextHash)),
      })
    }
    return c.json({ objects })
  })

  app.get("/manifests/:contextId", authenticated, async (c) => {
    const signer = c.get("signer")
    const contextId = hex(c.req.param("contextId"), 32, "contextId")
    const stored = store.getObject(contextId)
    if (stored === undefined || !isAnchored(stored, await reader.getRecord(contextId))) throw new MidaError("NOT_FOUND", "no anchored object")
    if (signer !== stored.owner) {
      await authorizeAgent({
        reader,
        overlay,
        signer,
        owner: stored.owner,
        capabilityId: optionalCapability(c.req.query("capabilityId")),
        namespaceId: stored.namespaceId,
        permission: PERMISSION.READ,
      })
    }
    return c.json({ manifest: stored.manifest, manifestHash: stored.manifestHash })
  })

  // ---------- §14.1 agent capability manifests (public metadata) ----------
  app.put("/agent-manifests", async (c) => {
    const envelope = json<SignedAgentCapabilityManifest>(new Uint8Array(await c.req.arrayBuffer()))
    if (envelope === null || typeof envelope !== "object" || typeof envelope.operatorSignature !== "string" || !/^0x[0-9a-f]{130}$/.test(envelope.operatorSignature)) {
      throw new MidaError("INVALID_WIRE", "envelope needs a manifest and a lowercase 65-byte operatorSignature")
    }
    validateManifestBody(envelope.manifest, await reader.now())
    const envelopeHash = manifestEnvelopeHash(envelope)
    await store.blobs.put(manifestEnvelopeBytes(envelope))
    const bodyHash = manifestBodyHash(envelope.manifest)
    store.setManifestIndex(bodyHash, envelopeHash)
    return c.json({ bodyHash, envelopeHash })
  })

  app.get("/agent-manifests/:bodyHash", async (c) => {
    const bodyHash = hex(c.req.param("bodyHash"), 32, "bodyHash")
    const envelopeHash = store.getManifestIndex(bodyHash)
    if (envelopeHash === undefined) throw new MidaError("MANIFEST_NOT_FOUND", "no envelope indexed for this body hash")
    let bytes: Uint8Array
    try {
      bytes = await store.blobs.get(envelopeHash)
    } catch (error) {
      if (isMidaError(error)) throw error
      throw new MidaError("MANIFEST_NOT_FOUND", "indexed envelope bytes are missing")
    }
    const envelope = parseManifestEnvelopeBytes({ bytes, expectedEnvelopeHash: envelopeHash, expectedBodyHash: bodyHash })
    const agentRecord = await reader.getAgent(envelope.manifest.agentId)
    if (agentRecord === null) throw new MidaError("AGENT_ID_MISMATCH", "manifest agent is not registered")
    verifySignedManifest({ envelope, agentRecord, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, now: await reader.now() })
    return c.json(envelope)
  })

  // ---------- §12.4 reader-epoch wraps ----------
  app.post("/epoch-wraps", authenticated, async (c) => {
    const signer = c.get("signer")
    const wrap = parseReaderWrap(json(c.get("body")))
    // 1. owner authentication alone is necessary but never sufficient
    if (signer !== wrap.owner) throw new MidaError("CAPABILITY_DENIED", "only the owner may publish reader wraps")
    // 2 and 5. namespace and epoch exist: current, or historical with a registered key
    namespaceById(wrap.namespaceId)
    const epoch = decodeUint64(wrap.readEpoch)
    const required = await reader.requiredReadEpoch(wrap.owner, wrap.namespaceId)
    if (epoch > required || (await reader.epochPublicKey(wrap.owner, wrap.namespaceId, epoch)) === null) {
      throw new MidaError("EPOCH_STALE", "read epoch is not a registered current or historical epoch")
    }
    // 3. recipient agent and exact key version
    const agent = await reader.getAgent(wrap.agentId)
    if (agent === null) throw new MidaError("CAPABILITY_DENIED", "recipient is not an active agent")
    if (agent.encryptionKeyVersion !== wrap.agentKeyVersion) throw new MidaError("WRAP_KEY_VERSION_MISMATCH", "wrap targets a stale agent key version")
    // 4. recipient holds active exact READ, and no local deny covers the relationship
    await overlay.reconcile(reader)
    if (
      (await overlay.deniesRelationship(reader, { owner: wrap.owner, agentId: wrap.agentId, namespaceId: wrap.namespaceId })) ||
      !(await reader.hasAuthority(wrap.owner, wrap.agentId, wrap.namespaceId, PERMISSION.READ, 0))
    ) {
      throw new MidaError("CAPABILITY_DENIED", "recipient has no active exact READ authority")
    }
    store.putWrap(wrap)
    return c.json({ stored: true })
  })

  app.get("/epoch-wraps", authenticated, async (c) => {
    const signer = c.get("signer")
    const owner = address(c.req.query("owner"), "owner")
    const namespaceId = hex(c.req.query("namespaceId"), 32, "namespaceId")
    const agentId = hex(c.req.query("agentId"), 32, "agentId")
    const readEpoch = decodeUint64(c.req.query("readEpoch") ?? "")
    const versionText = c.req.query("agentKeyVersion") ?? ""
    if (!/^[1-9][0-9]{0,9}$/.test(versionText)) throw new MidaError("INVALID_WIRE", "agentKeyVersion must be a positive integer")
    const authorization = await authorizeAgent({
      reader,
      overlay,
      signer,
      owner,
      capabilityId: optionalCapability(c.req.query("capabilityId")),
      namespaceId,
      permission: PERMISSION.READ,
      agentKeyVersion: Number(versionText),
    })
    if (authorization.agentId !== agentId) throw new MidaError("CAPABILITY_DENIED", "an agent may fetch only its own wraps")
    if ((await reader.epochPublicKey(owner, namespaceId, readEpoch)) === null) {
      throw new MidaError("EPOCH_STALE", "read epoch is not a registered current or historical epoch")
    }
    const wrap = store.getWrap({ owner, namespaceId, readEpoch: encodeUint64(readEpoch), agentId, agentKeyVersion: Number(versionText) })
    if (wrap === undefined) throw new MidaError("NO_EPOCH_WRAP", "no reader wrap is published yet for this agent key and epoch")
    return c.json(wrap)
  })

  // ---------- §12.5 fast revocation deny overlay ----------
  app.post("/revocations", authenticated, async (c) => {
    const owner = c.get("signer")
    const request = json<{ capabilityId?: unknown; agentId?: unknown }>(c.get("body"))
    let target: RevocationTarget
    let agentEpochAtIntent: bigint | null = null
    if (request.capabilityId !== undefined) {
      const capabilityId = hex(request.capabilityId, 32, "capabilityId")
      const capability = await reader.getCapability(capabilityId)
      if (capability === null || capability.owner !== owner) throw new MidaError("CAPABILITY_DENIED", "capability is not the signer's")
      target = { kind: "capability", capabilityId }
    } else if (request.agentId !== undefined) {
      const agentId = hex(request.agentId, 32, "agentId")
      if ((await reader.getAgent(agentId)) === null) throw new MidaError("NOT_FOUND", "agent not found")
      target = { kind: "agent", agentId }
      agentEpochAtIntent = await reader.agentEpoch(owner, agentId)
    } else {
      throw new MidaError("INVALID_WIRE", "revocation needs capabilityId or agentId")
    }
    const intent = overlay.create(owner, target, agentEpochAtIntent)
    return c.json({ intentId: intent.id, state: intent.state, cancellationNonce: intent.cancellationNonce })
  })

  app.post("/revocations/:id/cancel", authenticated, async (c) => {
    const owner = c.get("signer")
    const id = hex(c.req.param("id"), 32, "id")
    const request = json<{ expiresAt?: string; assertion?: WebAuthnAssertionInput }>(c.get("body"))
    const intent = overlay.get(id)
    if (intent === undefined || intent.owner !== owner) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null) throw new MidaError("REPLAY", "revocation intent is not cancellable")
    if (request.assertion === undefined || typeof request.expiresAt !== "string" || !/^(0|[1-9][0-9]*)$/.test(request.expiresAt)) {
      throw new MidaError("AUTH_INVALID", "cancellation requires a fresh passkey assertion and expiresAt")
    }
    const expiresAt = BigInt(request.expiresAt)
    const now = clock()
    if (now >= expiresAt || expiresAt - now > CANCELLATION_MAX_LIFETIME_SECONDS) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is expired or valid for more than five minutes")
    }
    const key = await reader.ownerP256Key(owner)
    const nonce = BigInt(intent.cancellationNonce)
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner,
      revocationIntentId: intent.id,
      apiCancellationNonce: nonce,
      expiresAt,
    })
    if (key === null || !verifyVaultAssertion({ challenge, assertion: request.assertion, qx: key.qx, qy: key.qy, rpIdHash: deployment.vaultRpIdHash })) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is not a valid owner passkey assertion")
    }
    const cancelled = overlay.cancel(intent.id, owner, nonce)
    return c.json({ intentId: cancelled.id, state: cancelled.state })
  })

  return { app, overlay, store }
}
```

Append to `apps/api/src/index.ts`:
```ts
export * from "./store.js"
export * from "./wire.js"
```

- [ ] **Step 5: Run to verify everything passes**

Run:
```bash
pnpm vitest run apps/api packages/fake-vault
pnpm typecheck
```
Expected: `Test Files 5 passed`, `Tests 41 passed`: 28 API tests and the 13 Vault tests, which now run against the real client. Typecheck exits 0. `routes.test.ts` proves:
- **Manifests fail closed.** An envelope is served only when its bytes, body hash and operator signature match the current AgentRecord. A stale body or a tampered index is rejected.
- **Readers decrypt only through their own wrap.** Anchored owner context reaches an authorized reader.
- **Denials are exact.** No capability, a forged capability ID, and a CREATE-only agent's reads and wraps are all denied.
- **Pending uploads stay invisible** until Monad holds matching commitments.
- **Uploads are validated.** Mutated ciphertext, a context ID not derived from the uploader, and an agent without CREATE are rejected.
- **§12.4 wrap publication.** It requires the owner, a registered epoch, the current key version, live READ and valid lengths.
- **After revocation:** an old-epoch upload is stale, the revoked reader is refused, and the remaining reader gets `NO_EPOCH_WRAP` until its epoch-2 wrap is published.
- **Deadline behaviour.** An expired write deadline blocks new writes but leaves a separately valid reader's history readable. Once the owner calls `rotateExpiredEpoch`, writes resume under epoch 3.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): objects, manifests, agent manifests and epoch wraps behind section 12 checks

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 25: `@mida/sdk`: `MidaAgent`

**Depends on:** Task 24.

**Files:**
- Create: `packages/sdk/package.json`, `packages/sdk/src/request-store.ts`, `packages/sdk/src/agent.ts`, `packages/sdk/src/index.ts`
- Modify: root `package.json` (dependency `"@mida/sdk": "workspace:*"`)
- Test: `packages/sdk/test/agent.test.ts`

**Interfaces:**
- Consumes: Part A protocol constants, `accessRequestTypedData`, `assertCanonicalScopes`, `canonicalJson`, `canonicalizeNamespace`, `canonicalizeOrigin`, `contextId`, `decodeUint64`, `encodeUint64`, `evidenceCommitment`, `namespaceById`, `namespaceId`, `originHash`; Part B `bytesOf`, `hexOf`, `manifestHash`, `openContextObject`, `sealContextObject`, `unwrapEpochPrivateKey`; Part C `assertGrantResponseWithinRequest`, `expandScopeInputs`, type `ScopeInput`; Task 21 `capabilityRegistryAbi`, `contextRegistryAbi`, `latestTimestamp`, `readAgentRecord`, `sendContract`, type `LocalWriteContext`; Task 24 `RegistryReader`, types `AnchoredObject`, `ContextApiRoutes`, `ContextRecordView`.
- Produces, `request-store.ts`: `interface StoredAccessRequest`, `interface AccessRequestStore { save; load; markConsumed }`, `class MemoryAccessRequestStore`.
- Produces, `agent.ts`: `REQUEST_LIFETIME_SECONDS = 300n`, `interface AccessRequestInput { purposeId; scopes: ScopeInput[]; capabilityExpiresAt? }`, `interface Grant`, `type AgentProvenanceSource = "AGENT_INFERRED" | "IMPORTED" | "EXTERNAL_ATTESTATION"`, `interface CreateContextInput`, `type SupersedeContextInput`, `interface ProposalInput`, `interface ContextObject`, `interface MidaAgentConfig { agentId; callbackOrigin; encryptionPrivateKey; chain: LocalWriteContext; api; requests? }`, and `class MidaAgent` with `agentId`, `grants`, and the §13.1 surface: `createAccessRequest(input)`, `completeAccessRequest(request, response)`, `read(owner, namespace)`, `create(owner, namespace, input)`, `supersede(owner, parentId, input)`, `propose(owner, namespace, input)`.

No SDK input type admits `USER_ASSERTED` or `USER_CONFIRMED`, and the write path refuses them at runtime too.

- [ ] **Step 1: Create the package manifest**

`packages/sdk/package.json`:
```json
{
  "name": "@mida/sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@mida/api": "workspace:*",
    "@mida/chain": "workspace:*",
    "@mida/crypto": "workspace:*",
    "@mida/grant-advisor": "workspace:*",
    "@mida/protocol": "workspace:*",
    "@noble/hashes": "2.4.0",
    "viem": "2.56.3"
  }
}
```

Add `"@mida/sdk": "workspace:*"` to the root `package.json` `"dependencies"`, then run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/sdk/test/agent.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recoverTypedDataAddress } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { PERMISSION, PROVENANCE_POLICY, accessRequestTypedData, namespaceId, sortScopes } from "@mida/protocol"
import type { AccessGrantResponse, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { ANVIL_PRIVATE_KEYS, createWriteContext, deployLocal, fundLocal, latestTimestamp, startAnvil } from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, provisionAgent } from "@mida/fake-vault"
import type { AgentDeclaration, ProvisionedAgent } from "@mida/fake-vault"
import { ContextApiClient, RegistryReader, createContextApi } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { MidaAgent } from "@mida/sdk"

const CAREER = namespaceId("goals.career")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`

describe("MidaAgent (plan Task 25)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let app: ReturnType<typeof createContextApi>["app"]
  let vault: FakeVaultAuthority
  let aliceContextId: Hex
  const provisioned: Record<string, ProvisionedAgent> = {}
  const sdk: Record<string, MidaAgent> = {}
  const apis: Record<string, ContextApiClient> = {}

  const clientFor = (account: LocalAccount) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => app.request(url, init),
    })

  async function agent(label: string, index: number, declarations: AgentDeclaration[]) {
    const operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[index]!) })
    const agent = await provisionAgent({ operator, name: label, purposeId: "career_coaching", declarations, callbackOrigin: `https://${label.toLowerCase()}.example` })
    await fundLocal(node.rpcUrl, agent.signer.address)
    provisioned[label] = agent
    apis[label] = clientFor(agent.signer)
    sdk[label] = new MidaAgent({
      agentId: agent.agentId,
      callbackOrigin: agent.callbackOrigin,
      encryptionPrivateKey: agent.encryptionPrivateKey,
      chain: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }),
      api: apis[label]!,
    })
  }

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    app = createContextApi({ reader: new RegistryReader(owner), deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-sdk-")) }).app
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api: clientFor(owner.account) })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await agent("A", 2, [
      { namespace: "goals.career", permissions: ["READ"] },
      { namespace: "financial", permissions: ["READ"] },
    ])
    await agent("C", 3, [{ namespace: "goals.career", permissions: ["CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE", "ALLOW_IMPORTED"] }])
    await agent("D", 4, [{ namespace: "goals.career", permissions: ["READ"] }])
    await agent("N", 5, [{ namespace: "goals.career", permissions: ["READ"] }])
    aliceContextId = (
      await vault.createOwnerContext({ namespace: "goals.career", payload: { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } } })
    ).contextId
  }, 300_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("createAccessRequest canonicalizes, expands parents, sorts, signs with the registered signer and lasts 300 seconds", async () => {
    const request = await sdk.A!.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [
        { namespace: " Goals.Career ", permissions: PERMISSION.READ },
        { namespace: "financial", permissions: PERMISSION.READ },
      ],
    })
    const expected = sortScopes(
      ["goals.career", "financial", "financial.preferences"].map((name) => ({ namespaceId: namespaceId(name), permissions: PERMISSION.READ, provenancePolicy: 0 })),
    )
    expect(request.scopes).toEqual(expected)
    expect(BigInt(request.requestExpiresAt) - BigInt(request.issuedAt)).toBe(300n)
    expect(request.manifestHash).toBe(provisioned.A!.manifestHash)
    const { agentSignature, ...unsigned } = request
    const typedData = accessRequestTypedData(unsigned)
    expect(await recoverTypedDataAddress({ ...typedData, signature: agentSignature } as never)).toBe(provisioned.A!.signer.address)
  })

  it("completes the Vault's recommended grant only after proving it on Monad, and never twice", async () => {
    const request = await sdk.A!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }, { namespace: "financial", permissions: PERMISSION.READ }] })
    const approval = await vault.approveGrant({ accessRequest: request, manifest: provisioned.A!.manifest, selection: { kind: "recommended" } })
    const grant = await sdk.A!.completeAccessRequest(request, approval.response)
    expect(grant.capabilities.map((c) => [c.namespaceId, c.permissions])).toEqual([[CAREER, PERMISSION.READ]])
    await expect(sdk.A!.completeAccessRequest(request, approval.response)).rejects.toMatchObject({ code: "REQUEST_CONSUMED" })
  })

  it("rejects a broadened response, a capability or transaction Monad does not hold, and a different request, without consuming", async () => {
    const request = await sdk.D!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.D!.manifest, selection: { kind: "recommended" } })
    const first = response.capabilities[0]!
    const withCapability = (patch: Partial<typeof first>): AccessGrantResponse => ({ ...response, capabilities: [{ ...first, ...patch }] })
    await expect(sdk.D!.completeAccessRequest(request, withCapability({ permissions: PERMISSION.READ | PERMISSION.CREATE }))).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest(request, withCapability({ capabilityId: hexOf(randomBytes(32)) }))).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest(request, withCapability({ transactionHash: hexOf(randomBytes(32)) }))).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest({ ...request, capabilityExpiresAt: "1" }, response)).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest(request, { ...response, requestId: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    expect((await sdk.D!.completeAccessRequest(request, response)).capabilities).toHaveLength(1)
  })

  it("reads owner context by verifying Monad commitments and unwrapping its own epoch key; an ungranted agent is denied", async () => {
    const objects = await sdk.A!.read(vault.owner, "goals.career")
    expect(objects.find((o) => o.contextId === aliceContextId)?.payload.value).toBe("Prioritize systems engineering")
    await expect(sdk.N!.read(vault.owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  let created: Hex

  it("a CREATE-only agent writes with the public epoch key alone and cannot read anything back", async () => {
    const scopes = [{ namespace: "goals.career", permissions: PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE | PROVENANCE_POLICY.ALLOW_IMPORTED }]
    const request = await sdk.C!.createAccessRequest({ purposeId: "career_coaching", scopes })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.C!.manifest, selection: { kind: "custom", scopes: request.scopes, expiresAt } })
    await sdk.C!.completeAccessRequest(request, response)

    const object = await sdk.C!.create(vault.owner, "goals.career", { value: "Systems engineering is the focus", kind: "GOAL", source: "AGENT_INFERRED" })
    created = object.contextId
    expect(object).toMatchObject({ authorId: provisioned.C!.agentId, version: 1, lineageId: object.contextId, readEpoch: 1n })
    const seen = (await sdk.A!.read(vault.owner, "goals.career")).find((o) => o.contextId === created)!
    expect(seen.payload.provenance.source).toBe("AGENT_INFERRED")
    await expect(sdk.C!.read(vault.owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(apis.C!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: response.capabilities[0]!.capabilityId })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("propose always writes AGENT_INFERRED; user provenance and reference-less imports are refused before any upload", async () => {
    const proposed = await sdk.C!.propose(vault.owner, "goals.career", { value: "Consider staff engineer roles" })
    expect(proposed.payload.provenance.source).toBe("AGENT_INFERRED")
    expect(proposed.payload.kind).toBe("INFERENCE")
    const uploads = vi.spyOn(apis.C!, "putObject")
    for (const source of ["USER_ASSERTED", "USER_CONFIRMED"]) {
      await expect(sdk.C!.create(vault.owner, "goals.career", { value: "x", kind: "GOAL", source: source as never })).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    }
    await expect(sdk.C!.create(vault.owner, "goals.career", { value: "x", kind: "FACT", source: "IMPORTED" })).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    expect(uploads).not.toHaveBeenCalled()
    uploads.mockRestore()
  })

  it("supersedes its own lineage, then loses to the stale-parent rule when reusing the old parent", async () => {
    const next = await sdk.C!.supersede(vault.owner, created, { value: "Systems engineering, v2", kind: "GOAL", source: "AGENT_INFERRED" })
    expect(next).toMatchObject({ version: 2, parentId: created, lineageId: created })
    await expect(sdk.C!.supersede(vault.owner, created, { value: "late", kind: "GOAL", source: "AGENT_INFERRED" })).rejects.toMatchObject({ code: "STALE_PARENT" })
  })

  it("verifies evidence references on read: a real reference passes, a reference to a record that does not exist fails", async () => {
    await sdk.C!.create(vault.owner, "goals.career", { value: "Imported from CV", kind: "FACT", source: "IMPORTED", references: [{ relation: "derived_from", recordId: aliceContextId }] })
    expect((await sdk.A!.read(vault.owner, "goals.career")).some((o) => o.payload.value === "Imported from CV")).toBe(true)
    await sdk.C!.create(vault.owner, "goals.career", { value: "Dangling", kind: "FACT", source: "IMPORTED", references: [{ relation: "supports", recordId: hexOf(randomBytes(32)) }] })
    await expect(sdk.A!.read(vault.owner, "goals.career")).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/sdk`
Expected: FAIL. Vitest cannot resolve `@mida/sdk`, because `packages/sdk/src/index.ts` does not exist yet.

- [ ] **Step 4: Implement the request store and `MidaAgent`**

`packages/sdk/src/request-store.ts`:
```ts
import { MidaError } from "@mida/protocol"
import type { AccessRequest, Hex } from "@mida/protocol"

export interface StoredAccessRequest {
  request: AccessRequest
  consumed: boolean
}

/** Where `createAccessRequest` persists originals by requestId so `completeAccessRequest` can check against them (§13.3). */
export interface AccessRequestStore {
  save(request: AccessRequest): Promise<void>
  load(requestId: Hex): Promise<StoredAccessRequest | undefined>
  markConsumed(requestId: Hex): Promise<void>
}

/**
 * In-memory store for Project 1. A consumed entry is kept for the life of the process so a requestId can never be
 * completed twice. Production agents persist this across restarts.
 */
export class MemoryAccessRequestStore implements AccessRequestStore {
  readonly #entries = new Map<string, StoredAccessRequest>()

  async save(request: AccessRequest): Promise<void> {
    const key = request.requestId.toLowerCase()
    if (this.#entries.has(key)) throw new MidaError("REPLAY", "requestId was already used")
    this.#entries.set(key, { request, consumed: false })
  }

  async load(requestId: Hex): Promise<StoredAccessRequest | undefined> {
    const entry = this.#entries.get(requestId.toLowerCase())
    return entry === undefined ? undefined : { request: entry.request, consumed: entry.consumed }
  }

  async markConsumed(requestId: Hex): Promise<void> {
    const entry = this.#entries.get(requestId.toLowerCase())
    if (entry === undefined) throw new MidaError("NOT_FOUND", "no stored request for this requestId")
    entry.consumed = true
  }
}
```

`packages/sdk/src/agent.ts`:
```ts
import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  accessRequestTypedData,
  assertCanonicalScopes,
  canonicalJson,
  canonicalizeNamespace,
  canonicalizeOrigin,
  contextId as deriveContextId,
  decodeUint64,
  encodeUint64,
  evidenceCommitment,
  namespaceById,
  namespaceId as toNamespaceId,
  originHash,
} from "@mida/protocol"
import type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  ContextKind,
  ContextPayload,
  GrantedCapability,
  Hex,
  PurposeId,
  RecordReference,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { bytesOf, hexOf, manifestHash, openContextObject, sealContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import { capabilityRegistryAbi, contextRegistryAbi, latestTimestamp, readAgentRecord, sendContract } from "@mida/chain"
import type { LocalWriteContext } from "@mida/chain"
import { assertGrantResponseWithinRequest, expandScopeInputs } from "@mida/grant-advisor"
import type { ScopeInput } from "@mida/grant-advisor"
import { RegistryReader } from "@mida/api"
import type { AnchoredObject, ContextApiRoutes, ContextRecordView } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { parseEventLogs, zeroHash } from "viem"
import { MemoryAccessRequestStore } from "./request-store.js"
import type { AccessRequestStore } from "./request-store.js"

/** §13.2 allows up to 600 seconds; the SDK uses 300 so a request stays valid through a normal consent screen. */
export const REQUEST_LIFETIME_SECONDS = 300n

export interface AccessRequestInput {
  purposeId: PurposeId
  /** Builder-supplied scopes; parents are expanded through the frozen tree before signing. */
  scopes: readonly ScopeInput[]
  /** Requested grant expiry in Unix seconds; omitted or 0n means no expiry is requested. */
  capabilityExpiresAt?: bigint
}

export interface Grant {
  owner: Address
  agentId: Hex
  requestId: Hex
  capabilities: GrantedCapability[]
}

/** The only provenance an agent can write (§11.8). USER_ASSERTED and USER_CONFIRMED need the owner. */
export type AgentProvenanceSource = "AGENT_INFERRED" | "IMPORTED" | "EXTERNAL_ATTESTATION"

export interface CreateContextInput {
  value: ContextPayload["value"]
  kind: Exclude<ContextKind, "NONE">
  source: AgentProvenanceSource
  references?: RecordReference[]
  tags?: string[]
  note?: string
  extractionConfidence?: number
  expiresAt?: bigint
}

export type SupersedeContextInput = CreateContextInput

export interface ProposalInput {
  value: ContextPayload["value"]
  kind?: Exclude<ContextKind, "NONE">
  references?: RecordReference[]
  tags?: string[]
  note?: string
  extractionConfidence?: number
}

export interface ContextObject {
  contextId: Hex
  owner: Address
  namespace: string
  namespaceId: Hex
  authorId: Hex
  lineageId: Hex
  parentId: Hex
  version: number
  readEpoch: bigint
  recordType: "CONTEXT" | "EVIDENCE"
  payload: ContextPayload
  transactionHash?: Hex
}

export interface MidaAgentConfig {
  agentId: Hex
  callbackOrigin: string
  encryptionPrivateKey: Uint8Array
  /** Write context whose account is the agent's current registered signer. */
  chain: LocalWriteContext
  /** Context API client bound to the same signer. */
  api: ContextApiRoutes & { account: { address: Address } }
  requests?: AccessRequestStore
}

const AGENT_SOURCES: ReadonlySet<string> = new Set(["AGENT_INFERRED", "IMPORTED", "EXTERNAL_ATTESTATION"])

/** §13.1 agent/server SDK. Every authority it relies on is re-read from Monad; nothing the API returns is trusted alone. */
export class MidaAgent {
  readonly agentId: Hex
  readonly #chain: LocalWriteContext
  readonly #api: MidaAgentConfig["api"]
  readonly #callbackOrigin: string
  readonly #encryptionPrivateKey: Uint8Array
  readonly #requests: AccessRequestStore
  readonly #reader: RegistryReader
  readonly #grants: Grant[] = []

  constructor(config: MidaAgentConfig) {
    if (config.api.account.address.toLowerCase() !== config.chain.account.address.toLowerCase()) {
      throw new MidaError("AUTH_INVALID", "the API client and the chain account must both be the agent's signer")
    }
    this.agentId = config.agentId.toLowerCase() as Hex
    this.#chain = config.chain
    this.#api = config.api
    this.#callbackOrigin = config.callbackOrigin
    this.#encryptionPrivateKey = Uint8Array.from(config.encryptionPrivateKey)
    this.#requests = config.requests ?? new MemoryAccessRequestStore()
    this.#reader = new RegistryReader(config.chain)
  }

  get grants(): readonly Grant[] {
    return this.#grants.map((grant) => ({ ...grant, capabilities: [...grant.capabilities] }))
  }

  /** §13.2: canonical, parent-expanded, sorted exact scopes, signed by the agent's current signer and persisted. */
  async createAccessRequest(input: AccessRequestInput): Promise<AccessRequest> {
    const { deployment, account } = this.#chain
    const agent = await readAgentRecord(this.#chain, this.agentId)
    if (agent.signer !== account.address.toLowerCase()) {
      throw new MidaError("AGENT_ID_MISMATCH", "configured signer is not the agent's current registered signer")
    }
    const callbackOrigin = canonicalizeOrigin(this.#callbackOrigin, { allowLocalhost: true })
    if (originHash(callbackOrigin) !== agent.callbackOriginHash) {
      throw new MidaError("AGENT_ID_MISMATCH", "callback origin is not the agent's registered origin")
    }
    const scopes = expandScopeInputs(input.scopes)
    assertCanonicalScopes(scopes)
    const now = await latestTimestamp(this.#chain)
    const unsigned: UnsignedAccessRequest = {
      v: 1,
      chainId: encodeUint64(deployment.chainId),
      capabilityRegistry: deployment.capabilityRegistry,
      requestId: hexOf(randomBytes(32)),
      nonce: hexOf(randomBytes(32)),
      agentId: this.agentId,
      purposeId: input.purposeId,
      callbackOrigin,
      manifestHash: agent.capabilityManifestHash,
      manifestVersion: agent.capabilityManifestVersion,
      policyVersion: POLICY_VERSION,
      namespaceTreeVersion: NAMESPACE_TREE_VERSION,
      scopes,
      issuedAt: encodeUint64(now),
      requestExpiresAt: encodeUint64(now + REQUEST_LIFETIME_SECONDS),
      capabilityExpiresAt: encodeUint64(input.capabilityExpiresAt ?? 0n),
    }
    const request: AccessRequest = { ...unsigned, agentSignature: await account.signTypedData(accessRequestTypedData(unsigned) as never) }
    await this.#requests.save(request)
    return request
  }

  /**
   * §13.3: the response must match the stored original request, stay within its authority (Part C helper), and every
   * capability must exist on Monad with identical fields, be currently valid, and be emitted by the named transaction.
   * The chain proves a capability exists; the original request proves it is the one this agent asked for.
   */
  async completeAccessRequest(request: AccessRequest, response: AccessGrantResponse): Promise<Grant> {
    const stored = await this.#requests.load(response.requestId)
    if (stored === undefined) throw new MidaError("RESPONSE_MISMATCH", "no original request is stored for this requestId")
    if (stored.consumed) throw new MidaError("REQUEST_CONSUMED", "this requestId was already completed")
    if (canonicalJson(stored.request) !== canonicalJson(request)) {
      throw new MidaError("RESPONSE_MISMATCH", "the request differs from the stored original")
    }
    const original = stored.request
    assertGrantResponseWithinRequest(original, response, await latestTimestamp(this.#chain))

    const owner = response.owner.toLowerCase() as Address
    const registry = this.#chain.deployment.capabilityRegistry
    for (const granted of response.capabilities) {
      const capability = await this.#reader.getCapability(granted.capabilityId)
      if (
        capability === null ||
        capability.owner !== owner ||
        capability.agentId !== this.agentId ||
        capability.namespaceId !== granted.namespaceId.toLowerCase() ||
        capability.permissions !== granted.permissions ||
        capability.provenancePolicy !== granted.provenancePolicy ||
        capability.expiresAt !== decodeUint64(granted.expiresAt)
      ) {
        throw new MidaError("RESPONSE_MISMATCH", `capability ${granted.capabilityId} on Monad differs from the response`)
      }
      if (!(await this.#reader.hasAuthority(owner, this.agentId, capability.namespaceId, capability.permissions, capability.provenancePolicy))) {
        throw new MidaError("CAPABILITY_DENIED", `capability ${granted.capabilityId} is not currently valid on Monad`)
      }
      const receipt = await this.#chain.publicClient.getTransactionReceipt({ hash: granted.transactionHash }).catch(() => null)
      const emitted =
        receipt !== null &&
        receipt.status === "success" &&
        parseEventLogs({ abi: capabilityRegistryAbi, eventName: "CapabilityGranted", logs: receipt.logs }).some(
          (log) =>
            log.address.toLowerCase() === registry &&
            log.args.capabilityId === granted.capabilityId &&
            log.args.owner.toLowerCase() === owner &&
            log.args.agentId === this.agentId,
        )
      if (!emitted) throw new MidaError("RESPONSE_MISMATCH", `transaction ${granted.transactionHash} did not grant ${granted.capabilityId}`)
    }

    await this.#requests.markConsumed(original.requestId)
    const grant: Grant = { owner, agentId: this.agentId, requestId: original.requestId, capabilities: [...response.capabilities] }
    this.#grants.push(grant)
    return grant
  }

  /** §12.3 read: API objects are re-checked against Monad commitments, then decrypted with this agent's own epoch wraps. */
  async read(owner: Address, namespace: string): Promise<ContextObject[]> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    const capability = this.#requireCapability(ownerAddress, namespaceId, PERMISSION.READ)
    const { deployment } = this.#chain
    const objects = await this.#api.listObjects({ owner: ownerAddress, namespaceId, capabilityId: capability.capabilityId })
    const agent = await readAgentRecord(this.#chain, this.agentId)
    const epochKeys = new Map<bigint, Uint8Array>()
    const results: ContextObject[] = []
    for (const object of objects) {
      const record = await this.#verifiedRecord(ownerAddress, namespaceId, object)
      let epochPrivateKey = epochKeys.get(record.readEpoch)
      if (epochPrivateKey === undefined) {
        const wrap = await this.#api.getEpochWrap({
          owner: ownerAddress,
          namespaceId,
          readEpoch: record.readEpoch,
          agentId: this.agentId,
          agentKeyVersion: agent.encryptionKeyVersion,
          capabilityId: capability.capabilityId,
        })
        epochPrivateKey = unwrapEpochPrivateKey({
          wrap,
          agentEncryptionPrivateKey: this.#encryptionPrivateKey,
          binding: {
            chainId: deployment.chainId,
            capabilityRegistry: deployment.capabilityRegistry,
            owner: ownerAddress,
            namespaceId,
            readEpoch: record.readEpoch,
            agentId: this.agentId,
            agentKeyVersion: agent.encryptionKeyVersion,
          },
        })
        epochKeys.set(record.readEpoch, epochPrivateKey)
      }
      const payload = openContextObject({
        manifest: object.manifest,
        expectedManifestHash: record.manifestHash,
        ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
        epochPrivateKey,
        binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: record.contextId, namespaceId, readEpoch: record.readEpoch },
      })
      await this.#verifyReferences(ownerAddress, record, payload)
      results.push(this.#toObject(record, name, payload))
    }
    return results
  }

  async create(owner: Address, namespace: string, input: CreateContextInput): Promise<ContextObject> {
    const ownerAddress = owner.toLowerCase() as Address
    const name = canonicalizeNamespace(namespace)
    const namespaceId = toNamespaceId(name)
    return this.#write({
      owner: ownerAddress,
      name,
      namespaceId,
      expectedParentId: zeroHash,
      input,
      capability: this.#requireCapability(ownerAddress, namespaceId, PERMISSION.CREATE),
    })
  }

  /** §11.6: SUPERSEDE_ANY on another author's STANDARD lineage, SUPERSEDE_OWN (or ANY) on this agent's own lineage. */
  async supersede(owner: Address, parentId: Hex, input: SupersedeContextInput): Promise<ContextObject> {
    const ownerAddress = owner.toLowerCase() as Address
    const parent = await this.#reader.getRecord(parentId)
    if (parent === null || parent.owner !== ownerAddress || parent.recordType !== RECORD_TYPE.CONTEXT) {
      throw new MidaError("NOT_FOUND", "parent is not a context record of this owner")
    }
    if (parent.lineagePolicy === LINEAGE_POLICY.OWNER_CONTROLLED) {
      throw new MidaError("ANCHOR_OWNER_ONLY", "only the owner may supersede an owner-controlled lineage")
    }
    const ownLineage = (await this.#reader.getRecord(parent.lineageId))?.author === this.agentId
    const capability =
      this.#findCapability(ownerAddress, parent.namespaceId, PERMISSION.SUPERSEDE_ANY) ??
      (ownLineage ? this.#findCapability(ownerAddress, parent.namespaceId, PERMISSION.SUPERSEDE_OWN) : undefined)
    if (capability === undefined) throw new MidaError("CAPABILITY_DENIED", "no completed grant allows superseding this lineage")
    return this.#write({
      owner: ownerAddress,
      name: namespaceById(parent.namespaceId).name,
      namespaceId: parent.namespaceId,
      expectedParentId: parentId,
      input,
      capability,
    })
  }

  /** Always AGENT_INFERRED; the owner decides later whether to confirm it. */
  propose(owner: Address, namespace: string, input: ProposalInput): Promise<ContextObject> {
    return this.create(owner, namespace, { ...input, kind: input.kind ?? "INFERENCE", source: "AGENT_INFERRED" })
  }

  #findCapability(owner: Address, namespaceId: Hex, permission: number): GrantedCapability | undefined {
    for (const grant of [...this.#grants].reverse()) {
      if (grant.owner !== owner) continue
      const match = grant.capabilities.find(
        (capability) => capability.namespaceId.toLowerCase() === namespaceId && (capability.permissions & permission) === permission,
      )
      if (match !== undefined) return match
    }
    return undefined
  }

  #requireCapability(owner: Address, namespaceId: Hex, permission: number): GrantedCapability {
    const capability = this.#findCapability(owner, namespaceId, permission)
    if (capability === undefined) throw new MidaError("CAPABILITY_DENIED", "no completed grant covers this owner, namespace and permission")
    return capability
  }

  async #verifiedRecord(owner: Address, namespaceId: Hex, object: AnchoredObject): Promise<ContextRecordView> {
    const record = await this.#reader.getRecord(object.contextId)
    if (
      record === null ||
      object.manifest.contextId !== object.contextId ||
      record.owner !== owner ||
      record.namespaceId !== namespaceId ||
      record.manifestHash !== manifestHash(object.manifest) ||
      record.ciphertextCommitment !== object.manifest.ciphertextHash
    ) {
      throw new MidaError("COMMITMENT_MISMATCH", `object ${object.contextId} does not match its Monad commitments`)
    }
    return record
  }

  /** §11.8: typed references must recompute the committed value, and each referenced record must exist for this owner. */
  async #verifyReferences(owner: Address, record: ContextRecordView, payload: ContextPayload): Promise<void> {
    const references = payload.provenance.references ?? []
    const commitment = references.length === 0 ? zeroHash : evidenceCommitment(references)
    if (commitment !== record.evidenceCommitment) {
      throw new MidaError("COMMITMENT_MISMATCH", `references of ${record.contextId} do not match its evidence commitment`)
    }
    for (const reference of references) {
      const target = await this.#reader.getRecord(reference.recordId)
      if (target === null || target.owner !== owner) {
        throw new MidaError("COMMITMENT_MISMATCH", `referenced record ${reference.recordId} does not exist for this owner`)
      }
    }
  }

  async #write(args: {
    owner: Address
    name: string
    namespaceId: Hex
    expectedParentId: Hex
    input: CreateContextInput
    capability: GrantedCapability
  }): Promise<ContextObject> {
    const { input } = args
    if (!AGENT_SOURCES.has(input.source)) {
      throw new MidaError("PROVENANCE_FORBIDDEN", `an agent cannot write provenance ${String(input.source)}`)
    }
    const references = input.references ?? []
    if (input.source !== "AGENT_INFERRED" && references.length === 0) {
      throw new MidaError("PROVENANCE_FORBIDDEN", `${input.source} requires at least one evidence reference`)
    }
    if (!Object.hasOwn(CONTEXT_KIND, input.kind) || (input.kind as string) === "NONE") {
      throw new MidaError("INVALID_WIRE", `unknown context kind ${String(input.kind)}`)
    }
    const { deployment } = this.#chain
    const readEpoch = await this.#reader.requiredReadEpoch(args.owner, args.namespaceId)
    const epochPublicKey = await this.#reader.epochPublicKey(args.owner, args.namespaceId, readEpoch)
    if (epochPublicKey === null || !(await this.#reader.isWriteEpochValid(args.owner, args.namespaceId, readEpoch))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the current read epoch does not accept writes")
    }
    const objectNonce = hexOf(randomBytes(32))
    const contextId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: args.owner,
      authorId: this.agentId,
      namespaceId: args.namespaceId,
      objectNonce,
    })
    const payload: ContextPayload = {
      v: 1,
      value: input.value,
      kind: input.kind,
      provenance: {
        source: input.source,
        ...(references.length === 0 ? {} : { references }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.extractionConfidence === undefined ? {} : { extractionConfidence: input.extractionConfidence }),
      },
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    }
    // CREATE needs only the public epoch key: the agent can encrypt to the namespace without being able to read it.
    const sealed = sealContextObject({
      payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId: args.namespaceId, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    await this.#api.putObject({
      owner: args.owner,
      namespaceId: args.namespaceId,
      objectNonce,
      expectedParentId: args.expectedParentId,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
      capabilityId: args.capability.capabilityId,
    })
    const receipt = await sendContract(this.#chain, {
      address: deployment.contextRegistry,
      abi: contextRegistryAbi,
      functionName: "register",
      args: [
        args.owner,
        [
          {
            contextId,
            objectNonce,
            namespaceId: args.namespaceId,
            expectedParentId: args.expectedParentId,
            manifestHash: sealed.manifestHash,
            ciphertextCommitment: sealed.ciphertextCommitment,
            evidenceCommitment: references.length === 0 ? zeroHash : evidenceCommitment(references),
            readEpoch,
            expiresAt: input.expiresAt ?? 0n,
            recordType: RECORD_TYPE.CONTEXT,
            lineagePolicy: LINEAGE_POLICY.STANDARD,
            kind: CONTEXT_KIND[input.kind],
            provenanceSource: PROVENANCE_SOURCE[input.source],
          },
        ],
      ],
    })
    const record = await this.#reader.getRecord(contextId)
    if (record === null) throw new MidaError("COMMITMENT_MISMATCH", "the registered record is missing after the transaction")
    return { ...this.#toObject(record, args.name, payload), transactionHash: receipt.transactionHash }
  }

  #toObject(record: ContextRecordView, name: string, payload: ContextPayload): ContextObject {
    return {
      contextId: record.contextId,
      owner: record.owner,
      namespace: name,
      namespaceId: record.namespaceId,
      authorId: record.author,
      lineageId: record.lineageId,
      parentId: record.parentId,
      version: record.version,
      readEpoch: record.readEpoch,
      recordType: record.recordType === RECORD_TYPE.EVIDENCE ? "EVIDENCE" : "CONTEXT",
      payload,
    }
  }
}
```

`packages/sdk/src/index.ts`:
```ts
export * from "./request-store.js"
export * from "./agent.js"
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/sdk
pnpm typecheck
```
Expected: `Tests 8 passed`. Typecheck exits 0. The test proves:
- **Requests are built per §13.2.** Scopes are canonicalized, parents expanded (`financial` becomes `financial` plus `financial.preferences`), sorted, and signed by the registered signer for 300 seconds.
- **Completion is proven on Monad, once.** A second completion fails with `REQUEST_CONSUMED`.
- **Tampered responses fail without consuming the request.** A broadened response, a capability or transaction Monad does not hold, a different request object and an unknown request ID all fail with `RESPONSE_MISMATCH`. The genuine completion still succeeds afterwards.
- **Reads verify before decrypting.** They re-check Monad commitments and decrypt through the agent's own wrap; an ungranted agent is denied.
- **CREATE does not imply READ.** A CREATE-only agent writes with the public epoch key alone and can read nothing back.
- **`propose` always writes `AGENT_INFERRED`.** User provenance and reference-less imports are refused before any upload.
- **Supersession obeys the stale-parent rule.** An agent supersedes its own lineage; reusing the old parent fails with `STALE_PARENT`.
- **Evidence is checked on read.** A real evidence reference passes; a reference to a record that does not exist fails with `COMMITMENT_MISMATCH`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml packages/sdk
git commit -m "feat(sdk): MidaAgent with on-chain-verified grants, verified reads and agent-only provenance

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 26: CLI scenario against local Anvil

**Depends on:** Task 25.

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/src/environment.ts`, `apps/cli/src/evidence.ts`, `apps/cli/src/index.ts`
- Modify: root `package.json` (dependency `"@mida/cli": "workspace:*"`)
- Test: `apps/cli/test/section16.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 21–25 in full; Part B `deriveEpochKeyPair`, `openContextObject`, `unwrapEpochPrivateKey`; Part C `isScopeSubset`; `@hono/node-server` `serve`.
- Produces, `environment.ts`: `interface ScenarioEnvironment { name; rpcUrl; deployment; apiBaseUrl; fund(address); writeContext(account); stop() }`, `startApiServer({ rpcUrl; deployment }): Promise<{ baseUrl; close() }>`, `localEnvironment({ hardfork? }): Promise<ScenarioEnvironment>`, `DEFAULT_TESTNET_FUNDING_WEI`, `monadTestnetEnvironment(env?): Promise<ScenarioEnvironment>`.
- Produces, `evidence.ts`: `P256_VERIFIER` (`0x…0100`), `PRECOMPILE_TRUE`, `interface ScenarioEvidence`, `evidencePath(network, date?)`, `writeEvidence(path, evidence)`, `probeP256Precompile(publicClient): Promise<{ valid: Hex; tampered: Hex }>`.

The scenario is one Vitest file, and every §16 step is an explicit `it` with its own assertions. The local run always executes. The Monad testnet run executes only when `MIDA_E2E_MONAD_TESTNET=1` (Task 27). Every actor is generated fresh for each run: Alice, four operators and four agent signers. The API runs as a real HTTP server on a free localhost port.

Beyond the 17 steps, the file covers the four §15 rows Part B deferred:
- **CREATE-only agent requests a private wrap:** rejected, in step 12.
- **CREATE-only agent reads an existing object:** denied, and the public epoch key cannot decrypt it, also in step 12.
- **Remaining reader lacks its new wrap:** `NO_EPOCH_WRAP` while Monad still authorizes it, in step 17.
- **Wrap publication with a wrong key version:** rejected, in the step after 17.

The first three steps map to the spec as follows:
- **§16 step 13** posts the deny explicitly, so the test can assert the denial before any chain transaction.
- **§16 step 14's** `approveRevocation` posts a second deny, which is harmless, then sends the single `revokeAndRotate` transaction.
- **Agent D**, the "remaining authorized reader", is granted READ before the revocation, in step 8b.

- [ ] **Step 1: Create the package manifest**

`apps/cli/package.json`:
```json
{
  "name": "@mida/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@hono/node-server": "1.19.17",
    "@mida/api": "workspace:*",
    "@mida/chain": "workspace:*",
    "@mida/crypto": "workspace:*",
    "@mida/fake-vault": "workspace:*",
    "@mida/grant-advisor": "workspace:*",
    "@mida/protocol": "workspace:*",
    "@mida/sdk": "workspace:*",
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "viem": "2.56.3"
  }
}
```

Add `"@mida/cli": "workspace:*"` to the root `package.json` `"dependencies"`, then run `pnpm install`.

- [ ] **Step 2: Write the failing end-to-end test**

`apps/cli/test/section16.e2e.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEventLogs, zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { P256_N, PERMISSION, PROVENANCE_POLICY, accessRequestHash, namespaceId, p256RotationDigest } from "@mida/protocol"
import type { Address, Hex, ReaderEpochWrap } from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, hexOf, openContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import { capabilityRegistryAbi, sendContract } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, completeVaultAssertion, p256PublicKey, provisionAgent, vaultSignPayload } from "@mida/fake-vault"
import type { AgentDeclaration, ProvisionedAgent } from "@mida/fake-vault"
import { isScopeSubset } from "@mida/grant-advisor"
import { ContextApiClient, RegistryReader } from "@mida/api"
import type { AnchoredObject } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js"
import { PRECOMPILE_TRUE, evidencePath, localEnvironment, monadTestnetEnvironment, probeP256Precompile, writeEvidence } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"

const CAREER = namespaceId("goals.career")
const FINANCIAL = namespaceId("financial")
const GOAL_TEXT = "Prioritize systems engineering for the next six months"
const EPOCH_TWO_TEXT = "Epoch two: interviewing with infrastructure teams"
const ON_TESTNET = process.env.MIDA_E2E_MONAD_TESTNET === "1"
const STEP_TIMEOUT = ON_TESTNET ? 300_000 : 60_000

type Label = "A" | "B" | "C" | "D"
interface Actor {
  provisioned: ProvisionedAgent
  sdk: MidaAgent
  api: ContextApiClient
}

const targets = [
  { name: "local Anvil", create: () => localEnvironment() },
  ...(ON_TESTNET ? [{ name: "Monad testnet", create: () => monadTestnetEnvironment() }] : []),
]

describe.each(targets)("§16 end-to-end scenario on $name (plan Tasks 26 and 27)", ({ create }) => {
  let env: ScenarioEnvironment
  let reader: RegistryReader
  let vault: FakeVaultAuthority
  let owner: Address
  let ownerApi: ContextApiClient
  const actors = {} as Record<Label, Actor>
  const transactions: Record<string, Hex> = {}
  const grantBatchGasUsed: Record<string, string> = {}
  let aliceContextId: Hex
  let capabilityA: Hex
  let capabilityC: Hex
  let epoch1WrapForA: ReaderEpochWrap
  let epochTwoContextId: Hex

  const step = (name: string, fn: () => Promise<void>) => it(name, fn, STEP_TIMEOUT)
  const apiFor = (account: LocalAccount) =>
    new ContextApiClient({ baseUrl: env.apiBaseUrl, account, chainId: env.deployment.chainId, capabilityRegistry: env.deployment.capabilityRegistry })
  const agentId = (label: Label) => actors[label].provisioned.agentId
  const readerBinding = (label: Label, readEpoch: bigint) => ({
    chainId: env.deployment.chainId,
    capabilityRegistry: env.deployment.capabilityRegistry,
    owner,
    namespaceId: CAREER,
    readEpoch,
    agentId: agentId(label),
    agentKeyVersion: 1,
  })
  const objectBinding = (contextId: Hex, readEpoch: bigint) => ({
    chainId: env.deployment.chainId,
    contextRegistry: env.deployment.contextRegistry,
    contextId,
    namespaceId: CAREER,
    readEpoch,
  })
  const open = (object: AnchoredObject, epochPrivateKey: Uint8Array, readEpoch: bigint) =>
    openContextObject({
      manifest: object.manifest,
      expectedManifestHash: object.manifestHash,
      ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
      epochPrivateKey,
      binding: objectBinding(object.contextId, readEpoch),
    })
  const ownerObject = async (contextId: Hex) => (await ownerApi.listObjects({ owner, namespaceId: CAREER })).find((o) => o.contextId === contextId)!

  async function provision(label: Label, declarations: AgentDeclaration[]) {
    const operatorAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(operatorAccount.address)
    const provisioned = await provisionAgent({
      operator: env.writeContext(operatorAccount),
      name: `Agent${label}`,
      purposeId: "career_coaching",
      declarations,
      callbackOrigin: `https://agent-${label.toLowerCase()}.example`,
    })
    await env.fund(provisioned.signer.address)
    const api = apiFor(provisioned.signer)
    const sdk = new MidaAgent({
      agentId: provisioned.agentId,
      callbackOrigin: provisioned.callbackOrigin,
      encryptionPrivateKey: provisioned.encryptionPrivateKey,
      chain: env.writeContext(provisioned.signer),
      api,
    })
    actors[label] = { provisioned, sdk, api }
  }

  beforeAll(async () => {
    env = await create()
    const aliceAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(aliceAccount.address)
    const alice = env.writeContext(aliceAccount)
    reader = new RegistryReader(alice)
    ownerApi = apiFor(aliceAccount)
    vault = new FakeVaultAuthority({ seed: randomBytes(32), p256PrivateKey: hexOf(p256.utils.randomSecretKey()), chain: alice, api: ownerApi })
    owner = vault.owner
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await env?.stop()
  })

  step("1. Alice registers her owner P256 key and the goals.career epoch-1 public key", async () => {
    transactions.registerP256Key = await vault.registerOwnerKey()
    transactions.initializeReadEpoch = await vault.initializeNamespace("goals.career")
    expect(await reader.ownerP256Key(owner)).toEqual(vault.p256PublicKey)
    const derived = deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n)
    expect(await reader.epochPublicKey(owner, CAREER, 1n)).toBe(hexOf(derived.publicKey))
  })

  step("2. Agents A, B, C and D register signed capability manifests committed in their AgentRecords", async () => {
    await provision("A", [{ namespace: "goals.career", permissions: ["READ"] }, { namespace: "financial", permissions: ["READ"] }])
    await provision("B", [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("C", [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }])
    await provision("D", [{ namespace: "goals.career", permissions: ["READ"] }])
    for (const label of ["A", "B", "C", "D"] as const) {
      const { provisioned } = actors[label]
      expect(await reader.getAgent(provisioned.agentId)).toMatchObject({
        capabilityManifestHash: provisioned.manifestHash,
        capabilityManifestVersion: 1,
        encryptionPublicKey: provisioned.encryptionPublicKey,
        encryptionKeyVersion: 1,
        active: true,
      })
      expect((await ownerApi.putAgentManifest(provisioned.manifest)).bodyHash).toBe(provisioned.manifestHash)
      expect(await ownerApi.getAgentManifest(provisioned.manifestHash)).toEqual(provisioned.manifest)
    }
  })

  step("3. Alice creates encrypted goals.career context under epoch 1, and no plaintext reaches Monad", async () => {
    const created = await vault.createOwnerContext({ namespace: "goals.career", payload: { v: 1, value: GOAL_TEXT, kind: "GOAL", provenance: { source: "USER_ASSERTED" } } })
    aliceContextId = created.contextId
    transactions.aliceContext = created.transactionHash
    expect(await reader.getRecord(created.contextId)).toMatchObject({ owner, author: zeroHash, readEpoch: 1n, version: 1 })
    const transaction = await reader.context.publicClient.getTransaction({ hash: created.transactionHash })
    expect(transaction.input.includes(Buffer.from(GOAL_TEXT, "utf8").toString("hex"))).toBe(false)
  })

  step("4–7. Agent A asks for READ goals.career plus unnecessary READ financial; the Advisor narrows; the passkey binds; the Vault wraps epoch 1 to A", async () => {
    const request = await actors.A.sdk.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }, { namespace: "financial", permissions: PERMISSION.READ }],
    })
    const nonce = () =>
      reader.context.publicClient.readContract({ address: env.deployment.capabilityRegistry, abi: capabilityRegistryAbi, functionName: "grantNonce", args: [owner] })
    const nonceBefore = await nonce()
    const approval = await vault.approveGrant({ accessRequest: request, manifest: actors.A.provisioned.manifest, selection: { kind: "recommended" } })

    // 5. deterministic narrowing with HIGH and suspicious warnings, provably inside the request
    expect(approval.advice.recommended).toEqual([{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }])
    expect(approval.advice.warnings.filter((w) => w.namespaceId === FINANCIAL).map((w) => w.code)).toEqual(expect.arrayContaining(["HIGH_SENSITIVITY", "SCOPE_SUSPICIOUS"]))
    expect(approval.advice.risk).toBe("high")
    expect(isScopeSubset(approval.advice.recommended, request.scopes)).toBe(true)

    // 6. the P256 approval consumed Alice's nonce and bound this exact request
    const { agentSignature: _signature, ...unsigned } = request
    expect(approval.response.requestHash).toBe(accessRequestHash(unsigned))
    expect(await nonce()).toBe(nonceBefore + 1n)
    const grant = await actors.A.sdk.completeAccessRequest(request, approval.response)
    expect(grant.capabilities.map((c) => [c.namespaceId, c.permissions])).toEqual([[CAREER, PERMISSION.READ]])
    expect(await reader.hasAuthority(owner, agentId("A"), FINANCIAL, PERMISSION.READ, 0)).toBe(false)
    capabilityA = grant.capabilities[0]!.capabilityId
    transactions.grantA = approval.response.capabilities[0]!.transactionHash
    grantBatchGasUsed.grantA = approval.gasUsed.toString()

    // 7. exactly one wrap, to A's registered key version
    epoch1WrapForA = await actors.A.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 1n, agentId: agentId("A"), agentKeyVersion: 1, capabilityId: capabilityA })
    expect(epoch1WrapForA).toMatchObject({ agentId: agentId("A"), agentKeyVersion: 1, readEpoch: "1", owner })
  })

  step("8. Agent A verifies the Monad commitments, unwraps its epoch key and decrypts", async () => {
    const objects = await actors.A.sdk.read(owner, "goals.career")
    expect(objects.map((object) => [object.contextId, object.payload.value])).toEqual([[aliceContextId, GOAL_TEXT]])
  })

  step("8b. Agent D, who will remain a reader after A is revoked, is granted READ goals.career", async () => {
    const request = await actors.D.sdk.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    const approval = await vault.approveGrant({ accessRequest: request, manifest: actors.D.provisioned.manifest, selection: { kind: "recommended" } })
    await actors.D.sdk.completeAccessRequest(request, approval.response)
    expect((await actors.D.sdk.read(owner, "goals.career")).map((o) => o.payload.value)).toEqual([GOAL_TEXT])
  })

  step("9. Agent B has no grant: denied by the SDK, the API and Monad, and cannot open A's wrap", async () => {
    await expect(actors.B.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(actors.B.api.listObjects({ owner, namespaceId: CAREER, capabilityId: capabilityA })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(
      actors.B.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 1n, agentId: agentId("B"), agentKeyVersion: 1, capabilityId: capabilityA }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await reader.hasAuthority(owner, agentId("B"), CAREER, PERMISSION.READ, 0)).toBe(false)
    expect(() => unwrapEpochPrivateKey({ wrap: epoch1WrapForA, agentEncryptionPrivateKey: actors.B.provisioned.encryptionPrivateKey, binding: readerBinding("A", 1n) })).toThrow(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    )
  })

  step("10. Agent C receives an advised exact CREATE goals.career grant without READ", async () => {
    const request = await actors.C.sdk.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    })
    const approval = await vault.approveGrant({ accessRequest: request, manifest: actors.C.provisioned.manifest, selection: { kind: "recommended" } })
    expect(approval.advice.recommended).toEqual([{ namespaceId: CAREER, permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }])
    const grant = await actors.C.sdk.completeAccessRequest(request, approval.response)
    capabilityC = grant.capabilities[0]!.capabilityId
    grantBatchGasUsed.grantC = approval.gasUsed.toString()
    expect(await reader.hasAuthority(owner, agentId("C"), CAREER, PERMISSION.CREATE, PROVENANCE_POLICY.ALLOW_INFERENCE)).toBe(true)
    expect(await reader.hasAuthority(owner, agentId("C"), CAREER, PERMISSION.READ, 0)).toBe(false)
  })

  step("11. Agent C creates a new encrypted lineage using only the public epoch key", async () => {
    const object = await actors.C.sdk.create(owner, "goals.career", { value: "Systems engineering fits the last two projects", kind: "INFERENCE", source: "AGENT_INFERRED" })
    expect(object).toMatchObject({ authorId: agentId("C"), version: 1, lineageId: object.contextId, readEpoch: 1n })
    transactions.agentCEpoch1 = object.transactionHash!
  })

  step("12. Agent C can neither fetch a reader wrap nor read or decrypt Alice's existing object", async () => {
    await expect(
      actors.C.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 1n, agentId: agentId("C"), agentKeyVersion: 1, capabilityId: capabilityC }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(actors.C.api.listObjects({ owner, namespaceId: CAREER, capabilityId: capabilityC })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(actors.C.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    const aliceObject = await ownerObject(aliceContextId)
    const publicEpochKey = bytesOf((await reader.epochPublicKey(owner, CAREER, 1n))!, 32)
    expect(() => open(aliceObject, publicEpochKey, 1n)).toThrow(expect.objectContaining({ code: "DECRYPT_FAILED" }))
    expect(() => unwrapEpochPrivateKey({ wrap: epoch1WrapForA, agentEncryptionPrivateKey: actors.C.provisioned.encryptionPrivateKey, binding: readerBinding("A", 1n) })).toThrow(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    )
  })

  step("13. Alice posts an owner-signed revocation intent; the API denies Agent A before any chain transaction", async () => {
    const intent = await ownerApi.requestRevocationDeny({ capabilityId: capabilityA })
    expect(intent.state).toBe("active")
    expect(await reader.hasAuthority(owner, agentId("A"), CAREER, PERMISSION.READ, 0)).toBe(true)
    await expect(actors.A.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
  })

  step("14. Alice revokes Agent A and advances goals.career to epoch 2 in one Monad transaction", async () => {
    const approval = await vault.approveRevocation({ kind: "capability", capabilityId: capabilityA })
    transactions.revokeAndRotate = approval.transactionHash
    expect(approval.rotated).toEqual([{ namespaceId: CAREER, readEpoch: 2n }])
    expect(await reader.requiredReadEpoch(owner, CAREER)).toBe(2n)
    expect(await reader.epochPublicKey(owner, CAREER, 2n)).toBe(hexOf(deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 2n).publicKey))
    const receipt = await reader.context.publicClient.getTransactionReceipt({ hash: approval.transactionHash })
    const events = parseEventLogs({ abi: capabilityRegistryAbi, logs: receipt.logs }).map((log) => log.eventName)
    expect(events).toEqual(expect.arrayContaining(["CapabilityRevoked", "ReadEpochRequired", "NamespaceEpochKeySet"]))
  })

  step("15. Agent C writes a new object under epoch 2", async () => {
    const object = await actors.C.sdk.create(owner, "goals.career", { value: EPOCH_TWO_TEXT, kind: "INFERENCE", source: "AGENT_INFERRED" })
    expect(object.readEpoch).toBe(2n)
    epochTwoContextId = object.contextId
    transactions.agentCEpoch2 = object.transactionHash!
  })

  step("16. Monad denies Agent A, and A's epoch-1 key cannot decrypt the epoch-2 object (but still opens epoch 1: forward-only)", async () => {
    expect(await reader.hasAuthority(owner, agentId("A"), CAREER, PERMISSION.READ, 0)).toBe(false)
    await expect(actors.A.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    const epochOneKey = unwrapEpochPrivateKey({ wrap: epoch1WrapForA, agentEncryptionPrivateKey: actors.A.provisioned.encryptionPrivateKey, binding: readerBinding("A", 1n) })
    const epochTwoObject = await ownerObject(epochTwoContextId)
    const epochOneObject = await ownerObject(aliceContextId)
    expect(() => open(epochTwoObject, epochOneKey, 2n)).toThrow(expect.objectContaining({ code: "DECRYPT_FAILED" }))
    expect(open(epochOneObject, epochOneKey, 1n).value).toBe(GOAL_TEXT)
  })

  step("17. Remaining reader D gets NO_EPOCH_WRAP, not a denial, until its epoch-2 wrap is published; then it reads everything", async () => {
    expect(await reader.hasAuthority(owner, agentId("D"), CAREER, PERMISSION.READ, 0)).toBe(true)
    await expect(actors.D.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "NO_EPOCH_WRAP" })
    expect(await vault.publishReaderWraps({ agentId: agentId("D"), namespaceId: CAREER })).toEqual([1n, 2n])
    expect((await actors.D.sdk.read(owner, "goals.career")).map((o) => o.payload.value)).toEqual(expect.arrayContaining([GOAL_TEXT, EPOCH_TWO_TEXT]))
  })

  step("§15: a wrap addressed to D's stale key version is rejected", async () => {
    const capabilityD = actors.D.sdk.grants[0]!.capabilities[0]!.capabilityId
    const genuine = await actors.D.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 2n, agentId: agentId("D"), agentKeyVersion: 1, capabilityId: capabilityD })
    await expect(ownerApi.publishEpochWrap({ ...genuine, agentKeyVersion: 2 })).rejects.toMatchObject({ code: "WRAP_KEY_VERSION_MISMATCH" })
  })

  step("records the run's evidence, including a direct probe of the P256 verifier at 0x0100", async () => {
    const probe = await probeP256Precompile(reader.context.publicClient)
    expect(probe).toEqual({ valid: PRECOMPILE_TRUE, tampered: "0x" })
    writeEvidence(evidencePath(env.name), {
      network: env.name,
      generatedAt: new Date().toISOString(),
      chainId: env.deployment.chainId.toString(),
      capabilityRegistry: env.deployment.capabilityRegistry,
      contextRegistry: env.deployment.contextRegistry,
      deploymentBlock: env.deployment.deploymentBlock.toString(),
      p256PrecompileProbe: probe,
      grantBatchGasUsed,
      transactions,
    })
  })
})

describe("owner passkey verification path inside grantBatch (plan Task 26)", () => {
  const P256_KEY: Hex = `0x${"4d".repeat(32)}`

  /**
   * Signs a MIDA_ROTATE_P256_V1 challenge, then forces the raw signature to high-s. webauthn-sol must reject the raw
   * struct, and the same signature through the shared adapter must rotate the owner key on-chain.
   */
  async function rotateWithForcedHighS(env: ScenarioEnvironment) {
    const ownerAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(ownerAccount.address)
    const owner = env.writeContext(ownerAccount)
    const registry = env.deployment.capabilityRegistry
    const send = (functionName: string, args: readonly unknown[]) => sendContract(owner, { address: registry, abi: capabilityRegistryAbi, functionName, args })
    const oldKey = hexOf(p256.utils.randomSecretKey())
    const oldPublic = p256PublicKey(oldKey)
    const newPublic = p256PublicKey(hexOf(p256.utils.randomSecretKey()))
    await send("registerP256Key", [oldPublic.qx, oldPublic.qy])

    const challenge = p256RotationDigest({
      chainId: env.deployment.chainId,
      capabilityRegistry: registry,
      owner: ownerAccount.address,
      newQx: newPublic.qx,
      newQy: newPublic.qy,
      nonce: 0n,
    })
    const rpId = env.deployment.vaultRpId
    const origin = `https://${rpId}`
    const { metadata, digest } = vaultSignPayload({ challenge, rpId, origin })
    const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(oldKey.slice(2)), { prehash: false })
    const r = BigInt(`0x${bytesToHex(raw.slice(0, 32))}`)
    const highS = P256_N - BigInt(`0x${bytesToHex(raw.slice(32))}`)
    const rawHighS = {
      authenticatorData: metadata.authenticatorData,
      clientDataJSON: metadata.clientDataJSON,
      challengeIndex: BigInt(metadata.challengeIndex!),
      typeIndex: BigInt(metadata.typeIndex!),
      r,
      s: highS,
    }
    const rawRejected = await send("rotateP256Key", [newPublic.qx, newPublic.qy, rawHighS]).then(
      () => false,
      (error: unknown) => (error as { code?: string }).code === "AUTH_INVALID",
    )
    const normalized = completeVaultAssertion({ challenge, metadata, r, s: highS, publicKey: oldPublic, rpId, origin })
    await send("rotateP256Key", [newPublic.qx, newPublic.qy, normalized])
    const [qx, qy] = (await owner.publicClient.readContract({
      address: registry,
      abi: capabilityRegistryAbi,
      functionName: "ownerP256Key",
      args: [ownerAccount.address],
    })) as readonly [bigint, bigint]
    return { rawHighSWasHigh: highS > P256_N / 2n, rawRejected, normalizedS: normalized.s, rotated: qx === newPublic.qx && qy === newPublic.qy }
  }

  async function grantOnce(hardfork: string) {
    const env = await localEnvironment({ hardfork })
    try {
      const aliceAccount = privateKeyToAccount(generatePrivateKey())
      await env.fund(aliceAccount.address)
      const alice = env.writeContext(aliceAccount)
      const vault = new FakeVaultAuthority({
        seed: new Uint8Array(32).fill(0x42),
        p256PrivateKey: P256_KEY,
        chain: alice,
        api: { putObject: async () => undefined, publishEpochWrap: async () => undefined, requestRevocationDeny: async () => ({ intentId: zeroHash }) },
      })
      await vault.registerOwnerKey()
      await vault.initializeNamespace("goals.career")
      const operatorAccount = privateKeyToAccount(generatePrivateKey())
      await env.fund(operatorAccount.address)
      const agent = await provisionAgent({
        operator: env.writeContext(operatorAccount),
        name: "PathProbe",
        purposeId: "career_coaching",
        declarations: [{ namespace: "goals.career", permissions: ["READ"] }],
        callbackOrigin: "https://path-probe.example",
      })
      const accessRequest = await buildSignedAccessRequest({ chain: alice, agent, scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
      const approval = await vault.approveGrant({ accessRequest, manifest: agent.manifest, selection: { kind: "recommended" } })
      return { gasUsed: approval.gasUsed, probe: await probeP256Precompile(alice.publicClient), highS: await rotateWithForcedHighS(env) }
    } finally {
      await env.stop()
    }
  }

  it("verifies through the native precompile on Osaka Anvil and through FreshCryptoLib on prague Anvil, the gas shows which, and a forced high-s assertion is normalized and accepted on both", async () => {
    const native = await grantOnce("default")
    const fallback = await grantOnce("prague")
    expect(native.probe).toEqual({ valid: PRECOMPILE_TRUE, tampered: "0x" })
    expect(fallback.probe).toEqual({ valid: "0x", tampered: "0x" })
    expect(fallback.gasUsed - native.gasUsed).toBeGreaterThan(150_000n)
    for (const path of [native, fallback]) {
      expect(path.highS.rawHighSWasHigh).toBe(true)
      expect(path.highS.rawRejected).toBe(true)
      expect(path.highS.normalizedS <= P256_N / 2n).toBe(true)
      expect(path.highS.rotated).toBe(true)
    }
    writeEvidence(evidencePath("local-p256-paths"), {
      network: "local-p256-paths",
      generatedAt: new Date().toISOString(),
      chainId: "31337",
      capabilityRegistry: zeroHash,
      contextRegistry: zeroHash,
      deploymentBlock: "0",
      p256PrecompileProbe: native.probe,
      grantBatchGasUsed: { nativeOsaka: native.gasUsed.toString(), fallbackPrague: fallback.gasUsed.toString() },
      transactions: {},
    })
  }, 300_000)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run apps/cli`
Expected: FAIL. Vitest cannot resolve `@mida/cli`, because `apps/cli/src/index.ts` does not exist yet.

- [ ] **Step 4: Implement environments and evidence**

`apps/cli/src/environment.ts`:
```ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Address, Hex } from "@mida/protocol"
import {
  MONAD_TESTNET_CHAIN_ID,
  chainFor,
  createWriteContext,
  deployLocal,
  fundLocal,
  loadDeployment,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalWriteContext } from "@mida/chain"
import { RegistryReader, createContextApi } from "@mida/api"
import { serve } from "@hono/node-server"
import { createPublicClient, http } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"

/** One network the §16 scenario can run against. Every actor is generated fresh per run and funded through `fund`. */
export interface ScenarioEnvironment {
  name: string
  rpcUrl: string
  deployment: Deployment
  apiBaseUrl: string
  fund(address: Address): Promise<void>
  writeContext(account: LocalAccount): LocalWriteContext
  stop(): Promise<void>
}

/** Runs the Context API as a real HTTP server on a free localhost port. */
export async function startApiServer(input: { rpcUrl: string; deployment: Deployment }): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const publicClient = createPublicClient({ chain: chainFor(input.deployment.chainId), transport: http(input.rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment: input.deployment })
  const { app } = createContextApi({ reader, deployment: input.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-api-")) })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** Fresh Anvil, Deploy.s.sol, and an in-process API server. hardfork "prague" forces the Solidity P256 fallback. */
export async function localEnvironment(options: { hardfork?: string } = {}): Promise<ScenarioEnvironment> {
  const node = await startAnvil(options)
  const deployment = await deployLocal({ rpcUrl: node.rpcUrl })
  const server = await startApiServer({ rpcUrl: node.rpcUrl, deployment })
  return {
    name: `local-${node.hardfork}`,
    rpcUrl: node.rpcUrl,
    deployment,
    apiBaseUrl: server.baseUrl,
    fund: (address) => fundLocal(node.rpcUrl, address),
    writeContext: (account) => createWriteContext({ rpcUrl: node.rpcUrl, deployment, account }),
    stop: async () => {
      await server.close()
      await node.stop()
    },
  }
}

export const DEFAULT_TESTNET_FUNDING_WEI = 200_000_000_000_000_000n

/**
 * Monad testnet (chain 10143). Needs contracts/deployments/10143.json from the Task 27 deploy and one funded
 * DEPLOYER_PRIVATE_KEY in .env; every other actor is generated and funded from it. The API still runs locally.
 */
export async function monadTestnetEnvironment(env: Record<string, string | undefined> = process.env): Promise<ScenarioEnvironment> {
  const key = env.DEPLOYER_PRIVATE_KEY
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("DEPLOYER_PRIVATE_KEY (a funded Monad testnet key) is required in .env for the testnet run")
  }
  const rpcUrl = env.MONAD_TESTNET_RPC ?? monadTestnet.rpcUrls.default.http[0]
  const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID)
  const funder = createWriteContext({ rpcUrl, deployment, account: privateKeyToAccount(key as Hex) })
  const chainId = await funder.publicClient.getChainId()
  if (BigInt(chainId) !== MONAD_TESTNET_CHAIN_ID) throw new Error(`RPC ${rpcUrl} is chain ${chainId}, not Monad testnet 10143`)
  const funding = BigInt(env.TESTNET_FUNDING_WEI ?? DEFAULT_TESTNET_FUNDING_WEI)
  const server = await startApiServer({ rpcUrl, deployment })
  return {
    name: "monad-testnet",
    rpcUrl,
    deployment,
    apiBaseUrl: server.baseUrl,
    fund: async (address) => {
      const hash = await funder.walletClient.sendTransaction({ account: funder.account, chain: funder.walletClient.chain, to: address, value: funding })
      const receipt = await funder.publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") {
        throw new Error(`funding ${address} reverted in ${hash}; check the funder balance against Monad's reserve-balance rule`)
      }
    },
    writeContext: (account) => createWriteContext({ rpcUrl, deployment, account }),
    stop: () => server.close(),
  }
}
```

`apps/cli/src/evidence.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, randomBytes } from "@noble/hashes/utils.js"
import type { PublicClient } from "viem"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
export const P256_VERIFIER: Hex = "0x0000000000000000000000000000000000000100"
export const PRECOMPILE_TRUE: Hex = `0x${"00".repeat(31)}01`

export interface ScenarioEvidence {
  network: string
  generatedAt: string
  chainId: string
  capabilityRegistry: Hex
  contextRegistry: Hex
  deploymentBlock: string
  p256PrecompileProbe: { valid: Hex; tampered: Hex }
  grantBatchGasUsed: Record<string, string>
  transactions: Record<string, Hex>
}

/** Local runs write to the gitignored .mida-data/; the Monad testnet run writes the committed docs/evidence/ file. */
export function evidencePath(network: string, date: Date = new Date()): string {
  return network === "monad-testnet"
    ? `${ROOT}docs/evidence/monad-testnet-${date.toISOString().slice(0, 10)}.json`
    : `${ROOT}.mida-data/evidence/${network}.json`
}

export function writeEvidence(path: string, evidence: ScenarioEvidence): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
}

/** Direct eth_call to the P256 verifier: a fresh valid (hash, r, s, qx, qy) must return 1, a tampered one nothing. */
export async function probeP256Precompile(publicClient: PublicClient): Promise<{ valid: Hex; tampered: Hex }> {
  const secretKey = p256.utils.randomSecretKey()
  const message = randomBytes(32)
  const signature = p256.sign(message, secretKey, { prehash: true, lowS: true })
  const publicKey = p256.getPublicKey(secretKey, false)
  const input = concatBytes(sha256(message), signature, publicKey.subarray(1))
  const tampered = Uint8Array.from(input)
  tampered[159] = tampered[159]! ^ 0x01
  const call = async (data: Uint8Array) => (await publicClient.call({ to: P256_VERIFIER, data: hexOf(data) })).data ?? "0x"
  return { valid: await call(input), tampered: await call(tampered) }
}
```

`apps/cli/src/index.ts`:
```ts
export * from "./environment.js"
export * from "./evidence.js"
```

- [ ] **Step 5: Run the local scenario and both P256 paths**

Run:
```bash
pnpm vitest run apps/cli
cat .mida-data/evidence/local-default.json
cat .mida-data/evidence/local-p256-paths.json
pnpm typecheck
```
Expected: `Test Files 1 passed`, `Tests 18 passed`: the 17 scenario tests plus the path test. The evidence files are written under the gitignored `.mida-data/evidence/`. `local-default.json` holds the deployment, the transaction hash of every step, `grantBatch` gas and a direct probe of `0x0100` (`valid` = 32-byte `1`, `tampered` = `0x`). `local-p256-paths.json` shows the two verification paths. On 2026-09-14 the plan's author measured:

| `grantBatch` gas | Measured |
|---|---|
| Osaka Anvil, native P256 at `0x100` | about 347,000 |
| prague Anvil, FreshCryptoLib fallback | about 682,000 |

Two runs on 2026-09-14 differed by a few hundred gas, because each run uses random keys and so slightly different calldata. Treat these values as approximate, not exact.

The test requires the fallback to cost more than 150,000 gas above native, and requires prague's precompile probe to return nothing. Together those prove the two runs took different paths.

On both hardforks the path test also signs a `rotateP256Key` challenge and forces the raw signature to high-s. `webauthn-sol` rejects that raw struct, which the API maps to `AUTH_INVALID`. The same signature passed through the shared adapter rotates the owner key on-chain (§15 high-s row). Typecheck exits 0.

- [ ] **Step 6: Run the whole repository once**

Run:
```bash
pnpm test
pnpm typecheck
(cd contracts && forge test && forge test --evm-version prague)
```
Expected: every Vitest file passes (278 tests in 26 files on 2026-09-14), typecheck exits 0, and both Foundry runs report `139 tests passed, 0 failed, 1 skipped`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml apps/cli
git commit -m "feat(cli): section 16 end-to-end scenario on local Anvil with native and fallback P256 evidence

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 27: Monad testnet deployment and scenario run

**Depends on:** Task 26.

> **This task cannot pass without a funded Monad testnet key, and it has not been run.** Every command below is the command Task 26 ran locally, pointed at chain 10143. Nothing in this plan spends real funds. Steps marked **(human)** are Dami's.

**Files:**
- Modify: `.env.example` (the testnet run needs only one funded key)
- Create (generated, committed): `contracts/deployments/10143.json`, `contracts/broadcast/Deploy.s.sol/10143/`, `docs/evidence/monad-testnet-<YYYY-MM-DD>.json`
- Modify: `log.md`

**What the harness already accounts for on Monad:**
- **Reserve-balance reverts.** A transaction can be included and still revert. `sendContract` and the funding helper both throw on any receipt whose status is `reverted`, so a revert can never pass silently.
- **`eth_getTransactionByHash` returns `null` for mempool transactions.** The harness waits for receipts and reads a transaction only after its receipt exists (scenario step 3).
- **`eth_getLogs` is capped at 100 blocks on the public RPC.** Every scan runs from `deploymentBlock` in windows of 100 blocks or fewer. At roughly 400 ms per block, `ownerHistory` makes about 2 RPC calls per 100 blocks since deployment. Run the scenario soon after deploying; an hour later each grant needs about 180 log calls. An indexer, planned for Project 4, removes this cost.
- **Step timeouts** rise to 300 seconds when `MIDA_E2E_MONAD_TESTNET=1`.

- [ ] **Step 1: Pin the toolchain and replace the example environment file**

Run:
```bash
foundryup --install 1.8.1
~/.foundry/bin/forge --version | head -1
node --version
```
Expected: `forge Version: 1.8.1` and Node 22 or newer.

Replace `.env.example` with:
```text
# Monad testnet run (plan Task 27). Never commit real values.
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz
# The only funded key. Every other actor is generated per run and funded from it.
DEPLOYER_PRIVATE_KEY=
# Native balance sent to each generated actor, in wei (default 0.2 MON).
TESTNET_FUNDING_WEI=200000000000000000
# Set to 1 to include the Monad testnet target in apps/cli/test/section16.e2e.test.ts.
MIDA_E2E_MONAD_TESTNET=
```

- [ ] **Step 2 (human): Create and fund the deployer key**

Run:
```bash
~/.foundry/bin/cast wallet new
```
Copy the private key into a local `.env` as `DEPLOYER_PRIVATE_KEY`. Never paste it anywhere else. Then fund the printed address at `https://faucet.monad.xyz`.

How much to fund:
- **Funding for actors.** The run generates nine actors at 0.2 MON each, so 1.8 MON.
- **Deployment gas.** This depends on testnet gas prices and was not measured.
- **Reserve balance.** Before funding, read `https://docs.monad.xyz/developer-essentials/reserve-balance`. Whether its 10 MON reserve applies to a plain EOA sending value was **not verified** for this plan. If it does, the deployer needs at least 10 MON above its spending.

Check the balance:
```bash
set -a; source .env; set +a
~/.foundry/bin/cast chain-id --rpc-url "$MONAD_TESTNET_RPC"
~/.foundry/bin/cast balance "$(~/.foundry/bin/cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" --rpc-url "$MONAD_TESTNET_RPC" --ether
```
Expected: `10143` and a non-zero balance.

- [ ] **Step 3: Deploy to Monad testnet**

Run:
```bash
set -a; source .env; set +a
cd contracts
~/.foundry/bin/forge script script/Deploy.s.sol --rpc-url "$MONAD_TESTNET_RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
cat deployments/10143.json
CAP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("deployments/10143.json","utf8")).capabilityRegistry)')
~/.foundry/bin/cast call "$CAP" "POLICY_HASH_V1()(bytes32)" --rpc-url "$MONAD_TESTNET_RPC"
~/.foundry/bin/cast call "$CAP" "NAMESPACE_COUNT()(uint256)" --rpc-url "$MONAD_TESTNET_RPC"
cd ..
```
Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.` and `wrote deployments/10143.json` with `"chainId": 10143`. `POLICY_HASH_V1` must read `0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45`, and the namespace count must be `22`. If the script fails with a reverted receipt, check the deployer balance against the reserve-balance rule before retrying; never lower the check.

- [ ] **Step 4: Run the §16 scenario on Monad testnet**

Run:
```bash
set -a; source .env; set +a
MIDA_E2E_MONAD_TESTNET=1 pnpm vitest run apps/cli/test/section16.e2e.test.ts
cat docs/evidence/monad-testnet-*.json
```
Expected: `Tests 35 passed`: 17 local, 17 Monad testnet and the path test. `docs/evidence/monad-testnet-<date>.json` contains:
- `chainId` `"10143"` and the deployed addresses;
- a transaction hash for every §16 step;
- `grantBatchGasUsed.grantA` and `grantC`, the owner passkey verified on Monad's native path;
- `p256PrecompileProbe` with `valid` equal to 32-byte `1` and `tampered` equal to `0x`.

Compare `grantA` with the local numbers. Close to the Osaka value (about 355,000 in the scenario) means Monad used the precompile. Close to prague plus about 335,000 would mean it did not, and the evidence must say so.

- [ ] **Step 5: Commit the deployment and the evidence**

Append one line to `log.md` with the date, both addresses, the evidence file name and the measured gas. Then run:
```bash
git add .env.example contracts/deployments/10143.json contracts/broadcast/Deploy.s.sol/10143 docs/evidence log.md
git commit -m "chore(testnet): deploy to Monad testnet and record section 16 evidence

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```
Before committing, confirm that `git diff --cached` shows no private key. The broadcast files contain signed transactions but no keys.

---

### Task 28: Completion gate and adversarial review

**Depends on:** Tasks 1–27.

**Files:**
- Modify: `log.md`, and any file a review finding requires (each fix follows TDD)

- [ ] **Step 1: Run every §19 gate item and record the results**

| §19 gate item | Command | Expected on 2026-09-14 |
|---|---|---|
| Unit and property tests: canonicalization, expansion, manifests, subset invariants, derivation, encryption, wraps, storage, wire validation | `pnpm vitest run packages/protocol packages/crypto packages/storage packages/grant-advisor` | 196 passed (191 from Parts A–C plus the 5 shared-adapter tests from Task 22) |
| Foundry adversarial tests | `cd contracts && forge test && forge test --evm-version prague` | 139 passed, 0 failed, 1 skipped, on both |
| API ordered validation, chain-bounded authorization, local deny, reads and wrap publication | `pnpm vitest run apps/api` | 28 passed |
| Chain adapter, Vault and SDK | `pnpm vitest run packages/chain packages/fake-vault packages/sdk` | 36 passed |
| Complete CLI scenario locally | `pnpm vitest run apps/cli` | 18 passed |
| Same scenario on Monad testnet | Task 27 Step 4 | 35 passed, plus the committed evidence file |
| Fallback and native P256 paths distinguished and evidenced | `pnpm vitest run apps/cli -t "verification path"`; `cd contracts && forge test --match-contract P256PathsTest -vv` and again with `--evm-version prague`; the testnet evidence probe | prague probe empty, fallback more than 150,000 gas above native; Monad probe returns `1` |
| Typecheck | `pnpm typecheck` | exit 0 |

Any row that differs from its expected value is a failure. Fix it before continuing; never edit the expectation to match.

- [ ] **Step 2: Agent adversarial pre-pass**

Use the `superpowers:requesting-code-review` skill on the full diff since the first Project 1 commit. Give the reviewer this brief, whose job is to make the code fail, not to confirm it looks fine:
1. **Cross-layer authorization.** Find any path where the Context API, SDK or Vault allows something `CapabilityRegistry` or `ContextRegistry` would refuse. Start with:
   - the inclusive expiry boundary in TypeScript versus `_isLive`;
   - deny-overlay matching by capability versus by agent;
   - `deniesRelationship` for wrap publication;
   - the supersession permission fallback in `PUT /objects`;
   - `completeAccessRequest` trusting any response field without an on-chain check.
2. **Deployment differences.** List what behaves differently on Monad testnet than on Anvil:
   - P256 precompile presence;
   - reserve-balance reverts;
   - the 100-block log cap and its cost as the chain grows;
   - receipt timing;
   - public RPC rate limits;
   - Deploy.s.sol's fixed output path.

   For each, name the test that would catch it or state that none does.
3. **Wrong numbers that still run.** Check every figure the evidence files and the README would quote: gas values, the precompile probe, test counts. Find any fallback that could silently read the wrong chain, registry or deployment file.
4. **Secrets.** Confirm that no private key, PRF output, DEK, epoch private key or plaintext is logged, persisted by the API, or committed.

Record each finding in `log.md` as what breaks, under which inputs, and whether it is fixed now or blocked.

- [ ] **Step 3 (human): Deep review**

Dami runs `/code-review high`, or `/code-review ultra` for the multi-agent cloud pass. These are user-triggered and billed; an agent cannot start them. Every confirmed finding gets a failing test first, then the fix, then a rerun of Step 1.

- [ ] **Step 4: Close the gate**

Project 1 passes only when:
- every Step 1 row matches its expected value;
- the Step 2 and Step 3 findings are fixed or explicitly recorded as accepted v0 limits;
- `log.md` states what was verified, what was not, and the commit that passed.

Commit:
```bash
git add log.md
git commit -m "docs: record the Project 1 completion gate results

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

> **The rule this gate enforces** (repo `CLAUDE.md`): adversarial review by default on anything that ships. The bug to fear runs, returns a number, and the number is wrong. Aim the review at cross-layer authorization and deployment differences.
