// Scratch measurement for R3-1 ceilings — run with: pnpm exec tsx bench/gas-measure.ts
// Measures the node's gas ESTIMATE (what sendContract will send as `gas`) and the
// receipt gasUsed for every transaction kind on local Anvil, both hardforks where
// the P256 path differs. Deleted after the numbers are recorded.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { zeroHash } from "viem"
import type { PublicClient } from "viem"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { capabilityRegistryAbi, increaseLocalTime, registerAgent, sendContract } from "@mida/chain"
import { PERMISSION, namespaceId, p256RotationDigest } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { generateX25519KeyPair, hexOf } from "@mida/crypto"
import { FakeVaultAuthority, buildSignedAccessRequest, completeVaultAssertion, p256PublicKey, provisionAgent, vaultSignPayload } from "@mida/fake-vault"

interface Row { kind: string; estimate: bigint | null; txGas: bigint | null; gasUsed: bigint | null }
const rows: Row[] = []
const row = (kind: string, estimate: bigint | null, txGas: bigint | null, gasUsed: bigint | null) =>
  rows.push({ kind, estimate, txGas, gasUsed })

async function txNumbers(client: PublicClient, hash: Hex): Promise<{ txGas: bigint; gasUsed: bigint }> {
  const tx = await client.getTransaction({ hash })
  const receipt = await client.getTransactionReceipt({ hash })
  return { txGas: tx.gas, gasUsed: receipt.gasUsed }
}

async function measure(hardfork: string) {
  const env: ScenarioEnvironment = await localEnvironment(hardfork === "default" ? {} : { hardfork })
  try {
    const probeAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(probeAccount.address)
    const client = env.writeContext(probeAccount).publicClient
    const ownerAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(ownerAccount.address)
    const owner = env.writeContext(ownerAccount)
    const vault = new FakeVaultAuthority({
      seed: randomBytes(32),
      p256PrivateKey: hexOf(p256.utils.randomSecretKey()),
      chain: owner,
      api: {
        putObject: async () => undefined,
        publishEpochWrap: async () => undefined,
        requestRevocationDeny: async () => ({ intentId: zeroHash }),
      },
    })
    const registry = env.deployment.capabilityRegistry

    // funding: plain value transfer estimate
    const fundEstimate = await client.estimateGas({ account: ownerAccount, to: probeAccount.address, value: 10n ** 18n })
    row(`${hardfork}/funding`, fundEstimate, null, null)

    // owner.key — args are the vault's own public key
    const keyEstimate = await client.estimateContractGas({
      account: ownerAccount, address: registry, abi: capabilityRegistryAbi, functionName: "registerP256Key", args: [vault.p256PublicKey.qx, vault.p256PublicKey.qy],
    })
    const keyTx = await txNumbers(client, await vault.registerOwnerKey())
    row(`${hardfork}/owner.key`, keyEstimate, keyTx.txGas, keyTx.gasUsed)

    // owner.keyRotate — fresh owner registers then rotates its own key (section16 pattern)
    const rotAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(rotAccount.address)
    const rotOwner = env.writeContext(rotAccount)
    const rotOldKey = hexOf(p256.utils.randomSecretKey())
    const rotOldPublic = p256PublicKey(rotOldKey)
    await sendContract(rotOwner, { address: registry, abi: capabilityRegistryAbi, functionName: "registerP256Key", args: [rotOldPublic.qx, rotOldPublic.qy] })
    const rotNewPublic = p256PublicKey(hexOf(p256.utils.randomSecretKey()))
    const rotChallenge = p256RotationDigest({
      chainId: env.deployment.chainId, capabilityRegistry: registry, owner: rotAccount.address,
      newQx: rotNewPublic.qx, newQy: rotNewPublic.qy, nonce: 0n,
    })
    const rotRpId = env.deployment.vaultRpId
    const rotOrigin = `https://${rotRpId}`
    const { metadata: rotMeta, digest: rotDigest } = vaultSignPayload({ challenge: rotChallenge, rpId: rotRpId, origin: rotOrigin })
    const rotRaw = p256.sign(hexToBytes(rotDigest.slice(2)), hexToBytes(rotOldKey.slice(2)), { prehash: false })
    const rotAssertion = completeVaultAssertion({
      challenge: rotChallenge, metadata: rotMeta,
      r: BigInt(`0x${bytesToHex(rotRaw.slice(0, 32))}`), s: BigInt(`0x${bytesToHex(rotRaw.slice(32))}`),
      publicKey: rotOldPublic, rpId: rotRpId, origin: rotOrigin,
    })
    const rotArgs = [rotNewPublic.qx, rotNewPublic.qy, rotAssertion] as const
    const rotEstimate = await client.estimateContractGas({
      account: rotAccount, address: registry, abi: capabilityRegistryAbi, functionName: "rotateP256Key", args: [...rotArgs],
    })
    const rotReceipt = await sendContract(rotOwner, { address: registry, abi: capabilityRegistryAbi, functionName: "rotateP256Key", args: [...rotArgs] })
    const rotTx = await txNumbers(client, rotReceipt.transactionHash)
    row(`${hardfork}/owner.keyRotate`, rotEstimate, rotTx.txGas, rotTx.gasUsed)

    // epoch.init
    const initTx = await txNumbers(client, await vault.initializeNamespace("goals.career"))
    row(`${hardfork}/epoch.init`, null, initTx.txGas, initTx.gasUsed)

    // agent.register — the real registerAgent call; re-estimating after the fact reverts
    const operatorAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(operatorAccount.address)
    const operator = env.writeContext(operatorAccount)
    const registered = await registerAgent(operator, {
      agentSalt: hexOf(randomBytes(32)), signer: privateKeyToAccount(generatePrivateKey()),
      encryptionPublicKey: hexOf(generateX25519KeyPair().publicKey),
      callbackOrigin: "https://measure.example", capabilityManifestHash: hexOf(randomBytes(32)),
    })
    const regTxNums = await txNumbers(client, registered.receipt.transactionHash)
    row(`${hardfork}/agent.register`, null, regTxNums.txGas, regTxNums.gasUsed)

    // context.register (owner write)
    const created = await vault.createOwnerContext({
      namespace: "goals.career",
      payload: { v: 1, value: "measurement payload ".repeat(8), kind: "GOAL", provenance: { source: "USER_ASSERTED" } },
    })
    const regTx = await txNumbers(client, created.transactionHash)
    row(`${hardfork}/context.register`, null, regTx.txGas, regTx.gasUsed)

    // an agent holding CREATE + READ for revoke paths — two grants, one capability each
    const agent = await provisionAgent({
      operator, name: "Measure", purposeId: "career_coaching",
      declarations: [
        { namespace: "goals.career", permissions: ["READ", "CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] },
      ],
      callbackOrigin: "https://measure-agent.example",
    })
    // one request per permission — scopes must be strictly ascending by namespaceId
    const requestCreate = await buildSignedAccessRequest({
      chain: owner, agent,
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: 1 }],
    })
    const approvalCreate = await vault.approveGrant({ accessRequest: requestCreate, manifest: agent.manifest, selection: { kind: "recommended" } })
    const requestRead = await buildSignedAccessRequest({
      chain: owner, agent,
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }],
    })
    const approval = await vault.approveGrant({ accessRequest: requestRead, manifest: agent.manifest, selection: { kind: "recommended" } })
    const grantTx = await txNumbers(client, approval.response.capabilities[0]!.transactionHash)
    row(`${hardfork}/grant.batch`, null, grantTx.txGas, grantTx.gasUsed)

    const createCap = approvalCreate.response.capabilities.find((c) => (c.permissions & PERMISSION.READ) === 0)
    const readCap = approval.response.capabilities.find((c) => (c.permissions & PERMISSION.READ) !== 0)

    if (createCap !== undefined) {
      const estimate = await client.estimateContractGas({
        account: ownerAccount, address: registry, abi: capabilityRegistryAbi, functionName: "revoke", args: [createCap.capabilityId],
      })
      const revoked = await vault.approveRevocation({ kind: "capability", capabilityId: createCap.capabilityId })
      const revTx = await txNumbers(client, revoked.transactionHash)
      row(`${hardfork}/revoke.capability`, estimate, revTx.txGas, revTx.gasUsed)
    }
    if (readCap !== undefined) {
      const revoked = await vault.approveRevocation({ kind: "capability", capabilityId: readCap.capabilityId })
      const revTx = await txNumbers(client, revoked.transactionHash)
      row(`${hardfork}/revoke.rotate`, null, revTx.txGas, revTx.gasUsed)
    }

    // revoke.agent — a second agent with a READ grant, revoked wholesale
    const agent2 = await provisionAgent({
      operator, name: "Measure2", purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["READ"] }],
      callbackOrigin: "https://measure-agent2.example",
    })
    const request2 = await buildSignedAccessRequest({ chain: owner, agent: agent2, scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    await vault.approveGrant({ accessRequest: request2, manifest: agent2.manifest, selection: { kind: "recommended" } })
    const agentRevoke = await vault.approveRevocation({ kind: "agent", agentId: agent2.agentId })
    const agentRevTx = await txNumbers(client, agentRevoke.transactionHash)
    row(`${hardfork}/revoke.agent`, null, agentRevTx.txGas, agentRevTx.gasUsed)

    // epoch.rotateExpired — grant a READ that expires in a minute, advance chain time, rotate
    try {
      const agent3 = await provisionAgent({
        operator, name: "Measure3", purposeId: "career_coaching",
        declarations: [{ namespace: "financial", permissions: ["READ"] }],
        callbackOrigin: "https://measure-agent3.example",
      })
      await vault.initializeNamespace("financial")
      const now = BigInt(Math.floor(Date.now() / 1000))
      const request3 = await buildSignedAccessRequest({ chain: owner, agent: agent3, scopes: [{ namespace: "financial", permissions: PERMISSION.READ }] })
      await vault.approveGrant({
        accessRequest: request3, manifest: agent3.manifest,
        selection: { kind: "custom", scopes: [{ namespaceId: namespaceId("financial"), permissions: PERMISSION.READ, provenancePolicy: 0 }], expiresAt: now + 60n },
      })
      await increaseLocalTime(env.rpcUrl, 120n)
      const rotated = await vault.rotateExpiredEpoch(namespaceId("financial"))
      const rotTxNums = await txNumbers(client, rotated.transactionHash)
      row(`${hardfork}/epoch.rotateExpired`, null, rotTxNums.txGas, rotTxNums.gasUsed)
    } catch (error) {
      row(`${hardfork}/epoch.rotateExpired`, null, null, null)
      console.error("epoch.rotateExpired failed:", error instanceof Error ? error.message : error)
    }
  } finally {
    await env.stop()
  }
}

for (const hardfork of ["default", "prague"]) {
  await measure(hardfork)
}

console.log("\nkind | estimate | tx.gas (auto limit) | receipt.gasUsed")
for (const r of rows) {
  console.log(`${r.kind} | ${r.estimate ?? "-"} | ${r.txGas ?? "-"} | ${r.gasUsed ?? "-"}`)
}
