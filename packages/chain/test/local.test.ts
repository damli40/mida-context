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
  }, 600_000)

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
  }, 600_000)

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
