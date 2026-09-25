// scripts/bench-batch-anchor.mts — the BatchAnchor testnet benchmark (plan Task 11).
//
// DAMI RUNS THIS. The agent that wrote it never did — it reaches Monad testnet and spends real
// testnet MON from DEPLOYER_PRIVATE_KEY:
//
//   node --env-file=.env --import tsx scripts/bench-batch-anchor.mts --price-usd <MON USD price> [--saves n] [--batch k] [--agents k] [--store url]
//
// A small first run to check the plumbing before a sized one:
//
//   node --env-file=.env --import tsx scripts/bench-batch-anchor.mts --price-usd <price> --saves 20 --batch 20
//
// Reads DEPLOYER_PRIVATE_KEY and MONAD_TESTNET_RPC by NAME from the environment. The key is never
// printed, never logged and never written to the evidence file — every printed line and thrown
// error passes through a mask first, and buildEvidence builds its output field by field so no
// other property can leak into the JSON.
//
// What a run measures (setup cost is excluded — it is the price of throwaway actors, not of saves):
//   setup    a throwaway owner plus --agents throwaway agents through the same on-chain steps
//            `mida init` + requestAccess + approve run — owner P256 key, namespace read epochs,
//            agent registration, the policy's recommended grant — funded from the deployer key.
//            The app's own functions are not imported: they live in @mida/midad, an app package
//            the repo root does not depend on, so the same package calls are made here directly.
//   direct   min(--saves, 20) checkpoint saves, one ContextRegistry.register transaction each
//   batched  --saves EIP-712 signed saves anchored by BatchAnchor.submitBatch — sent by the
//            deployer in --batch chunks, or queued at a real store when --store is given (then
//            the store chooses the batches and queued→anchored latency is measured too)
//   per tx   gasUsed, gasLimit, effectiveGasPrice; "charged" is gasLimit × effectiveGasPrice
//            because Monad bills the reserved limit, not the gas used
//   writes   docs/evidence/batch-anchor-benchmark-<YYYY-MM-DD>.json
//
// The run refuses to start its measured phases when the deployer balance is below the script's
// own estimate — one real submitBatch is priced with eth_estimateGas against the signed saves
// and multiplied out — and it prints both numbers either way.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseEventLogs, zeroHash } from "viem"
import type { AbiEvent, LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { p256 } from "@noble/curves/nist.js"
import { randomBytes } from "@noble/hashes/utils.js"
import {
  CONTEXT_KIND,
  PROVENANCE_SOURCE,
  batchContextId,
  canonicalizeNamespace,
  decodeUint64,
  encodeUint64,
  namespaceId as toNamespaceId,
} from "@mida/protocol"
import type { Address, BatchSaveMessage, ContextPayload, Hex, PurposeId } from "@mida/protocol"
import { bytesOf, hexOf, sealContextObject } from "@mida/crypto"
import {
  DEFAULT_DEPLOYMENTS_DIR,
  GAS_CEILINGS,
  MONAD_TESTNET_CHAIN_ID,
  batchAnchorAbi,
  getLogsChunked,
  loadDeployment,
  sendContract,
} from "@mida/chain"
import type { LocalWriteContext, SendCost } from "@mida/chain"
import { ContextApiClient, RegistryReader } from "@mida/api"
import type { BatchedSaveWire } from "@mida/api"
import { MidaAgent, signBatchSave } from "@mida/sdk"
import { FakeVaultAuthority, provisionAgent } from "@mida/fake-vault"
import { POLICY_DOCUMENT_V1, permissionBits, provenancePolicyBits } from "@mida/grant-advisor"
import type { ScopeInput } from "@mida/grant-advisor"
import { DEFAULT_TESTNET_FUNDING_WEI, monadTestnetEnvironment } from "@mida/cli"
import { buildEvidence, chargedWei, parseArgs, perSave, percentile } from "./bench-batch-anchor-lib.mjs"

/** How long the --store path waits for the store's batcher to anchor a queued save. */
const SETTLE_TIMEOUT_MS = 10 * 60 * 1_000
const SETTLE_POLL_MS = 1_000

const BATCH_ANCHORED = batchAnchorAbi.find((entry) => entry.type === "event" && entry.name === "BatchAnchored") as AbiEvent
const SAVE_REJECTED = batchAnchorAbi.find((entry) => entry.type === "event" && entry.name === "SaveRejected") as AbiEvent

// The key is read once, kept in this one binding, and masked out of anything that can be printed.
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY

const mask = (text: string): string =>
  DEPLOYER_KEY === undefined ? text : text.split(DEPLOYER_KEY).join("[redacted]").split(DEPLOYER_KEY.slice(2)).join("[redacted]")

const print = (line: string): void => console.log(mask(line))
const fail = (message: string): never => {
  throw new Error(mask(message))
}

// The values below are the ones the midad app carries (apps/midad/src): NAMESPACE and PURPOSE_ID
// from runtime.ts, the grant lifetime from skeleton.ts, the funding floor from runtime.ts, and
// the checkpoint envelope shape from checkpoint-payload.ts. They are copied — not imported —
// because this script runs from the repo root, which does not depend on the app package.
const NAMESPACE = "projects.current"
const PURPOSE_ID: PurposeId = "project_assistance"
const FACT_NAMESPACES = ["preferences.communication", "profile.skills"] as const
const GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60
const MIN_BALANCE_WEI = 150_000_000_000_000_000n
const CHECKPOINT_TYPE = "mida.checkpoint.v1"

/** A wei amount printed as MON to four decimal places, truncated — copied from apps/midad runtime.ts. */
function formatMon(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = (wei % 1_000_000_000_000_000_000n) / 100_000_000_000_000n
  return `${whole}.${frac.toString().padStart(4, "0")}`
}

/** The checkpoint fields a real save seals (the packages/checkpoint schema), kept literal here. */
interface BenchCheckpoint {
  eventId: string
  agent: string
  source: "agent-tool" | "hook-compiler"
  createdAt: string
  objective: string
  originalRequest: string | null
  progress: string[]
  decisions: { decision: string; rationale: string }[]
  rejected: { approach: string; why: string }[]
  constraints: string[]
  artifacts: string[]
  unresolvedIssue: string | null
  nextAction: string
  remainingPlan: string[]
  evidence: { field: string; ref: string }[]
}

/** The envelope `saveCheckpoint` wraps a checkpoint in — type tag plus project/session ids. */
interface BenchCheckpointEnvelope {
  type: typeof CHECKPOINT_TYPE
  projectId: string
  sessionId: string
  continuesSession: string | null
  compiledBy: string
  checkpoint: BenchCheckpoint
}

/**
 * A small, field-complete checkpoint envelope — what wrapCheckpoint returns when nothing had to
 * shrink. Its validation is omitted on purpose: every value here is inside the schema's limits by
 * construction, and sealContextObject would seal whatever it was given anyway.
 */
function checkpointEnvelope(eventId: string, projectId: string): BenchCheckpointEnvelope {
  return {
    type: CHECKPOINT_TYPE,
    projectId,
    sessionId: "s1",
    continuesSession: null,
    compiledBy: "bench",
    checkpoint: {
      eventId,
      agent: "bench",
      source: "agent-tool",
      createdAt: new Date().toISOString(),
      objective: "benchmark checkpoint",
      originalRequest: null,
      progress: [],
      decisions: [],
      rejected: [],
      constraints: [],
      artifacts: [],
      unresolvedIssue: null,
      nextAction: "n",
      remainingPlan: [],
      evidence: [],
    },
  }
}

/** The scopes a project_assistance agent asks for — skeleton.ts's expectedScopesFor, verbatim. */
function expectedScopes(purposeId: PurposeId): ScopeInput[] {
  return POLICY_DOCUMENT_V1.purposes[purposeId].expected.map((entry) => ({
    namespace: entry.namespace,
    permissions: permissionBits(entry.permissions),
    provenancePolicy: provenancePolicyBits(entry.provenancePolicies),
  }))
}

/** The manifest scope declarations a project_assistance agent registers — skeleton.ts's declarationsFor. */
const AGENT_DECLARATIONS = POLICY_DOCUMENT_V1.purposes[PURPOSE_ID].expected.map((entry) => ({
  namespace: entry.namespace,
  permissions: [...entry.permissions],
  provenancePolicies: [...entry.provenancePolicies],
}))

/**
 * The SignedSave struct submitBatch takes — the same field-by-field mapping
 * createBatcherChain.submit applies to a BatchedSaveWire. The wire's manifest and ciphertext are
 * store data; the contract only sees the signed message fields and the signature.
 */
function contractSaves(wires: readonly BatchedSaveWire[]) {
  return wires.map((wire) => ({
    owner: wire.message.owner,
    namespaceId: wire.message.namespaceId,
    objectNonce: wire.message.objectNonce,
    lineageId: wire.message.lineageId,
    parentId: wire.message.parentId,
    parentVersion: wire.message.parentVersion,
    rootAuthor: wire.message.rootAuthor,
    manifestHash: wire.message.manifestHash,
    ciphertextCommitment: wire.message.ciphertextCommitment,
    readEpoch: decodeUint64(wire.message.readEpoch),
    expiresAt: decodeUint64(wire.message.expiresAt),
    kind: wire.message.kind,
    provenanceSource: wire.message.provenanceSource,
    signature: wire.signature,
  }))
}

/** The fee a send would offer right now — the same estimate sendContract prices a send with. */
async function feePerGas(publicClient: { estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; gasPrice?: bigint }>; getGasPrice(): Promise<bigint> }): Promise<bigint> {
  const estimated = await publicClient.estimateFeesPerGas()
  if (estimated.maxFeePerGas !== undefined) return estimated.maxFeePerGas
  if (estimated.gasPrice !== undefined) return estimated.gasPrice
  return publicClient.getGasPrice()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (DEPLOYER_KEY === undefined || !/^0x[0-9a-fA-F]{64}$/.test(DEPLOYER_KEY)) {
    fail("DEPLOYER_PRIVATE_KEY must be set to a funded Monad testnet key (0x plus 64 hex) — it is read by name and never printed")
  }
  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY as Hex)

  // The deployment file is the gate the plan names. batchAnchor is checked once, here, and the
  // narrowed constant is the only copy used below — runbook step 1 is the fix when it is absent.
  const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID, DEFAULT_DEPLOYMENTS_DIR())
  const batchAnchor = deployment.batchAnchor ?? fail("this deployment has no BatchAnchor — deploy it first (runbook step 1)")

  print("connecting to Monad testnet (this checks the chain id before anything is spent)…")
  const env = await monadTestnetEnvironment(process.env)
  try {
    if (env.deployment.batchAnchor !== batchAnchor) {
      fail("the deployment the environment resolved names a different batchAnchor than contracts/deployments/10143.json — run pnpm run deployments:gen")
    }
    const deployer = env.writeContext(deployerAccount)
    const publicClient = deployer.publicClient

    const fundingWei = BigInt(process.env.TESTNET_FUNDING_WEI ?? DEFAULT_TESTNET_FUNDING_WEI)
    const fee = await feePerGas(publicClient)
    const names = Array.from({ length: args.agents }, (_, i) => `bench-${i + 1}`)

    /** midad's ensureFunded: below the floor the funder tops the wallet up; one fund per call. */
    const ensureFunded = async (address: Address, label: string): Promise<void> => {
      const balance = await publicClient.getBalance({ address })
      if (balance >= MIN_BALANCE_WEI) return
      print(`topping up ${label}…`)
      await env.fund(address)
    }

    /**
     * midad's pre-send balance guard (runtime.ts's makeOwnerBalanceGuard) rewritten onto the
     * deployer's funder: priced like the send itself — gas limit × the send's own fee values plus
     * any transferred value — the wallet is topped up once, re-read, and the send refused with the
     * real numbers when that still falls short. Never a loop, never a bare node error.
     */
    const topUpWhenLow = (chain: LocalWriteContext, label: string) => async (cost: SendCost): Promise<void> => {
      const need = cost.gasLimit * (cost.fee.maxFeePerGas ?? cost.fee.gasPrice ?? 0n) + (cost.value ?? 0n)
      let balance = await chain.publicClient.getBalance({ address: cost.payer })
      if (balance >= need) return
      print(`topping up ${label}…`)
      await env.fund(cost.payer)
      balance = await chain.publicClient.getBalance({ address: cost.payer })
      if (balance < need) {
        fail(`${label} holds ${formatMon(balance)} MON but this send needs ${cost.upperBound === true ? "up to " : ""}${formatMon(need)} MON — top up the deployer and re-run`)
      }
    }

    // Setup funding is spend the deployer commits to before any measurement: owner + operator +
    // one per agent, each a funding transfer the deployer also pays gas on.
    const balanceAtStart = await publicClient.getBalance({ address: deployerAccount.address })
    const setupNeed = BigInt(names.length + 2) * (fundingWei + chargedWei(GAS_CEILINGS.funding, fee))
    print(`deployer balance ${formatMon(balanceAtStart)} MON — setup needs about ${formatMon(setupNeed)} MON in funding transfers`)
    if (balanceAtStart < setupNeed) {
      fail(`deployer balance ${formatMon(balanceAtStart)} MON is below the setup estimate ${formatMon(setupNeed)} MON — top up and re-run`)
    }

    // --- setup: the same on-chain steps `mida init` + requestAccess + approve run -------------
    print(`setup: throwaway owner plus ${names.length} throwaway agent(s) — owner key, namespaces, register, grant (not measured)…`)
    const ownerAccount = privateKeyToAccount(generatePrivateKey())
    const ownerChain = env.writeContext(ownerAccount)
    ownerChain.beforeSend = topUpWhenLow(ownerChain, "the throwaway owner")
    await ensureFunded(ownerAccount.address, "the throwaway owner")
    const ownerApi = new ContextApiClient({
      baseUrl: env.apiBaseUrl,
      account: ownerAccount,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
    })
    const vault = new FakeVaultAuthority({
      seed: randomBytes(32),
      p256PrivateKey: hexOf(p256.utils.randomSecretKey()),
      chain: ownerChain,
      api: ownerApi,
    })
    const owner = vault.owner

    const reader = new RegistryReader({ publicClient, deployment })
    const ownerKey = await reader.ownerP256Key(owner)
    if (ownerKey === null || ownerKey.qx === 0n) {
      print("registering the throwaway owner's key on the chain…")
      await vault.registerOwnerKey()
    }
    // The checkpoint namespace plus the two owner-fact namespaces, opened only when missing —
    // a fresh owner needs all three transactions.
    for (const ns of [NAMESPACE, ...FACT_NAMESPACES]) {
      if ((await reader.epochPublicKey(owner, toNamespaceId(ns), 1n)) === null) {
        await vault.initializeNamespace(ns)
      }
    }

    const operatorAccount = privateKeyToAccount(generatePrivateKey())
    const operator = env.writeContext(operatorAccount)
    operator.beforeSend = topUpWhenLow(operator, "the operator wallet")
    await ensureFunded(operatorAccount.address, "the operator wallet")

    const agents: { name: string; agentId: Hex; signer: LocalAccount; agent: MidaAgent }[] = []
    for (const name of names) {
      const signer = privateKeyToAccount(generatePrivateKey())
      const callbackOrigin = `https://${name}.mida.example`
      print(`registering ${name} on the chain…`)
      const provisioned = await provisionAgent({ operator, name, purposeId: PURPOSE_ID, declarations: AGENT_DECLARATIONS, callbackOrigin, signer })
      await ownerApi.putAgentManifest(provisioned.manifest)
      await ensureFunded(signer.address, `${name}'s wallet`)
      const agentChain = env.writeContext(signer)
      agentChain.beforeSend = topUpWhenLow(agentChain, `${name}'s wallet`)
      const agent = new MidaAgent({
        agentId: provisioned.agentId,
        callbackOrigin,
        encryptionPrivateKey: provisioned.encryptionPrivateKey,
        chain: agentChain,
        api: new ContextApiClient({ baseUrl: env.apiBaseUrl, account: signer, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry }),
      })
      const request = await agent.createAccessRequest({
        purposeId: PURPOSE_ID,
        scopes: expectedScopes(PURPOSE_ID),
        capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
      })
      print(`sending ${name}'s grant…`)
      const approval = await vault.approveGrant({ accessRequest: request, manifest: provisioned.manifest, selection: { kind: "recommended" } })
      await agent.completeAccessRequest(request, approval.response)
      agents.push({ name, agentId: provisioned.agentId, signer, agent })
    }

    // One namespace, one read epoch for the whole run — signed once per save below.
    const namespaceId = toNamespaceId(canonicalizeNamespace(NAMESPACE))
    const readEpoch = await reader.requiredReadEpoch(owner, namespaceId)
    const epochPublicKey = await reader.epochPublicKey(owner, namespaceId, readEpoch)
    if (epochPublicKey === null || !(await reader.isWriteEpochValid(owner, namespaceId, readEpoch))) {
      throw new Error(mask("the current read epoch does not accept writes — re-run"))
    }

    // Sign all batched-phase saves now: the batch-size probe below needs real signed saves, and
    // signing here keeps signing cost out of the timed submissions. Same assembly as
    // MidaAgent.createBatched — sealContextObject plus signBatchSave — minus the POST.
    print(`signing ${args.saves} batched save(s) under EIP-712 (the contract re-checks every signature)…`)
    const wires: { wire: BatchedSaveWire; contextId: Hex; agentIndex: number }[] = []
    for (let i = 0; i < args.saves; i++) {
      const agentIndex = i % agents.length
      const agent = agents[agentIndex] ?? fail("no agents were provisioned — --agents must be at least 1")
      const eventId = `cp-bench-b${i}`
      const objectNonce = hexOf(randomBytes(32))
      const contextId = batchContextId({
        chainId: deployment.chainId,
        batchAnchor,
        owner,
        agentId: agent.agentId,
        namespaceId,
        parentId: zeroHash,
        objectNonce,
      })
      const envelope = checkpointEnvelope(eventId, "proj-bench")
      const payload: ContextPayload = {
        v: 1,
        value: { ...envelope },
        kind: "EPISODE",
        provenance: { source: "AGENT_INFERRED" },
        tags: ["mida-checkpoint", eventId],
      }
      const sealed = sealContextObject({
        payload,
        binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId, readEpoch },
        epochPublicKey: bytesOf(epochPublicKey, 32),
      })
      const message: BatchSaveMessage = {
        owner,
        namespaceId,
        objectNonce,
        lineageId: zeroHash,
        parentId: zeroHash,
        parentVersion: 0,
        rootAuthor: zeroHash,
        manifestHash: sealed.manifestHash,
        ciphertextCommitment: sealed.ciphertextCommitment,
        readEpoch,
        expiresAt: 0n,
        kind: CONTEXT_KIND.EPISODE,
        provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
      }
      const signature = await signBatchSave({ account: agent.signer, chainId: deployment.chainId, batchAnchor, message })
      wires.push({
        wire: {
          message: { ...message, readEpoch: encodeUint64(readEpoch), expiresAt: encodeUint64(message.expiresAt) },
          signature,
          manifest: sealed.manifest,
          ciphertext: hexOf(sealed.ciphertext),
        },
        contextId,
        agentIndex,
      })
    }

    // The balance estimate the plan asks for: a one-batch probe — eth_estimateGas on the first
    // real batch of signed saves — times the batch count, plus what the direct phase can still
    // draw from agent wallets beyond what they already hold. --store mode submits nothing itself:
    // the store's batcher pays for its own transactions.
    const batchCount = Math.ceil(args.saves / args.batch)
    const probeGas = await publicClient.estimateContractGas({
      account: deployerAccount,
      address: batchAnchor,
      abi: batchAnchorAbi,
      functionName: "submitBatch",
      args: [hexOf(randomBytes(32)), contractSaves(wires.slice(0, args.batch).map((entry) => entry.wire))],
    } as never)
    const directCount = Math.min(args.saves, 20)
    const agentHeld = (
      await Promise.all(agents.map((entry) => publicClient.getBalance({ address: entry.signer.address })))
    ).reduce((total, balance) => total + balance, 0n)
    // context.register is billed at its ceiling as an upper bound — the real estimate is lower.
    const directShortfall = chargedWei(GAS_CEILINGS["context.register"], fee) * BigInt(directCount) - agentHeld
    const batchNeed = args.store === undefined ? chargedWei(probeGas, fee) * BigInt(batchCount) : 0n
    const required = (directShortfall > 0n ? directShortfall : 0n) + batchNeed
    const balance = await publicClient.getBalance({ address: deployerAccount.address })
    print(`deployer balance ${formatMon(balance)} MON — estimated remaining need ${formatMon(required)} MON`)
    if (balance < required) {
      fail(`deployer balance ${formatMon(balance)} MON is below the estimated ${formatMon(required)} MON this run still needs — top up and re-run`)
    }

    // Direct phase: min(n, 20) checkpoint saves, one transaction each, measured per save — the
    // direct lane of saveCheckpoint: seal, upload to the store, register on the chain.
    print(`direct phase: ${directCount} checkpoint save(s), one transaction each…`)
    const direct: { gasUsed: bigint; charged: bigint }[] = []
    for (let i = 0; i < directCount; i++) {
      const entry = agents[i % agents.length] ?? fail("no agents were provisioned — --agents must be at least 1")
      await ensureFunded(entry.signer.address, `${entry.name}'s wallet`)
      const eventId = `cp-bench-d${i}`
      const envelope = checkpointEnvelope(eventId, "proj-bench")
      const object = await entry.agent.create(owner, NAMESPACE, {
        value: { ...envelope },
        kind: "EPISODE",
        source: "AGENT_INFERRED",
        tags: ["mida-checkpoint", eventId],
      })
      // A save that landed but could not be measured must fail the run — quietly dropping it
      // would shrink the denominator and report a per-save cost that never happened.
      const transactionHash =
        object.transactionHash ?? fail(`direct save ${i} produced no measurable transaction (the record was already anchored)`)
      const [receipt, transaction] = await Promise.all([
        publicClient.getTransactionReceipt({ hash: transactionHash }),
        publicClient.getTransaction({ hash: transactionHash }),
      ]).catch((error) => fail(`direct save ${i} landed as ${transactionHash} but its receipt could not be read back: ${(error as Error).message}`))
      const charged = chargedWei(transaction.gas, receipt.effectiveGasPrice)
      direct.push({ gasUsed: receipt.gasUsed, charged })
      print(`  save ${i + 1}/${directCount}: tx ${transactionHash.slice(0, 10)}… charged ${formatMon(charged)} MON`)
    }

    const notes: string[] = [
      "setup (owner key, namespace epochs, agent registration, grants, funding transfers) is excluded from the measured phases",
      "charged = gasLimit × effectiveGasPrice — Monad bills the reserved gas limit, not the gas used",
    ]

    // Batched phase.
    let batchedTxs: { gasUsed: bigint; charged: bigint }[] = []
    let rejected = 0
    let maxSavesPerTxObserved = 0
    let latencyMs: { p50: number; p95: number } | undefined
    if (args.store === undefined) {
      print(`batched phase: ${args.saves} signed save(s) via submitBatch, ${batchCount} transaction(s) of up to ${args.batch}…`)
      for (let start = 0; start < wires.length; start += args.batch) {
        const chunk = wires.slice(start, start + args.batch).map((entry) => entry.wire)
        // A fresh random batchId per submission — the contract only requires it be unused.
        const receipt = await sendContract(
          deployer,
          { address: batchAnchor, abi: batchAnchorAbi, functionName: "submitBatch", args: [hexOf(randomBytes(32)), contractSaves(chunk)] },
          "batch.submit",
        )
        const anchored = parseEventLogs({ abi: batchAnchorAbi, eventName: "SaveAnchored", logs: receipt.logs }).length
        const rejectedHere = parseEventLogs({ abi: batchAnchorAbi, eventName: "SaveRejected", logs: receipt.logs }).length
        rejected += rejectedHere
        maxSavesPerTxObserved = Math.max(maxSavesPerTxObserved, anchored)
        const charged = chargedWei(receipt.gasLimit, receipt.effectiveGasPrice)
        batchedTxs.push({ gasUsed: receipt.gasUsed, charged })
        print(`  tx ${batchedTxs.length}/${batchCount}: ${chunk.length} saves — anchored ${anchored}, rejected ${rejectedHere}, charged ${formatMon(charged)} MON`)
      }
      notes.push("batched saves were submitted directly by the deployer in --batch-sized transactions")
    } else {
      // --store: the saves go to a real store's queue and its batcher submits them. The runner
      // measures queued→anchored latency client-side and attributes the batch transactions by
      // the submitter address the anchor logs name.
      print(`batched phase via --store ${args.store}: ${args.saves} signed save(s) posted to the queue…`)
      const storeUrl = args.store
      const probe = new ContextApiClient({ baseUrl: storeUrl, account: deployerAccount, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry })
      const status = await probe.batchStatus().catch((error) => fail(`the store at --store did not answer /batch/status: ${(error as Error).message}`))
      if (!status.enabled) fail("the store reports batching disabled — the BATCHING_ENABLED kill switch is off at the store")
      if (status.batchAnchor.toLowerCase() !== batchAnchor.toLowerCase()) {
        fail("the store's batchAnchor differs from this deployment's — wrong store or wrong deployment")
      }
      const clients = agents.map(
        (entry) => new ContextApiClient({ baseUrl: storeUrl, account: entry.signer, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry }),
      )
      const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 })
      const posted: { contextId: Hex; client: ContextApiClient; at: number }[] = []
      for (const { wire, contextId, agentIndex } of wires) {
        const client = clients[agentIndex] ?? fail("no agents were provisioned — --agents must be at least 1")
        const at = Date.now()
        try {
          await client.postBatchSave(wire)
        } catch (error) {
          fail(`the store refused a batched save: ${(error as Error).message}`)
        }
        posted.push({ contextId, client, at })
      }
      print(`  posted ${posted.length}; waiting for the store's batcher to anchor them (up to ${SETTLE_TIMEOUT_MS / 1000}s)…`)
      const latencies: number[] = []
      const ourBatchIds = new Set<string>()
      let unsettled = 0
      const deadline = Date.now() + SETTLE_TIMEOUT_MS
      for (const entry of posted) {
        for (;;) {
          const view = await entry.client.getBatchSave(entry.contextId)
          if (view.state === "ANCHORED") {
            latencies.push(Date.now() - entry.at)
            if (view.item?.batchId !== undefined) ourBatchIds.add(view.item.batchId.toLowerCase())
            break
          }
          if (view.state === "REJECTED") {
            rejected += 1
            break
          }
          if (Date.now() > deadline) {
            unsettled += 1
            break
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
        }
      }
      if (latencies.length > 0) latencyMs = { p50: percentile(latencies, 50), p95: percentile(latencies, 95) }
      if (unsettled > 0) notes.push(`${unsettled} save(s) were still QUEUED/SUBMITTED when the settle wait ended — their latency is unmeasured`)
      notes.push("the store chose batch boundaries, not --batch; latency is queued→anchored measured client-side")

      // Attribute batch transactions: anchored items name their batchId; the first match also
      // names the store's submitter, which lets all-rejected batches (no anchored item survives
      // to name them) be found too. A save that was never submitted has no transaction to count.
      const anchoredLogs = await getLogsChunked(publicClient, { address: batchAnchor, event: BATCH_ANCHORED, fromBlock })
      const rejectedLogs = await getLogsChunked(publicClient, { address: batchAnchor, event: SAVE_REJECTED, fromBlock })
      const byBatchId = new Map<string, (typeof anchoredLogs)[number]>()
      for (const log of anchoredLogs) byBatchId.set(((log.args as { batchId: Hex }).batchId).toLowerCase(), log)
      const submitter = [...ourBatchIds].map((id) => byBatchId.get(id)).find((log) => log !== undefined)?.args as { submitter?: Address } | undefined
      const candidateIds = new Set<string>([...ourBatchIds, ...rejectedLogs.map((log) => ((log.args as { batchId: Hex }).batchId).toLowerCase())])
      const txHashes = new Set<string>()
      for (const id of candidateIds) {
        const log = byBatchId.get(id)
        if (log === undefined) continue
        const isOurs = ourBatchIds.has(id) || (submitter?.submitter !== undefined && (log.args as { submitter: Address }).submitter.toLowerCase() === submitter.submitter.toLowerCase())
        if (isOurs && log.transactionHash !== null) txHashes.add(log.transactionHash)
      }
      if (ourBatchIds.size === 0 && rejected > 0) {
        notes.push("no save anchored, so the store's submitter could not be identified — batch transactions are not attributed")
      }
      for (const hash of txHashes) {
        const [transaction, receipt] = await Promise.all([
          publicClient.getTransaction({ hash: hash as Hex }),
          publicClient.getTransactionReceipt({ hash: hash as Hex }),
        ])
        batchedTxs.push({ gasUsed: receipt.gasUsed, charged: chargedWei(transaction.gas, receipt.effectiveGasPrice) })
      }
      for (const id of ourBatchIds) {
        const log = byBatchId.get(id)
        if (log !== undefined) maxSavesPerTxObserved = Math.max(maxSavesPerTxObserved, Number((log.args as { acceptedCount: number }).acceptedCount))
      }
      notes.push("run against a store only this benchmark was posting to — a shared batch's transaction is charged to its own saves")
    }
    if (rejected > 0) notes.push(`${rejected} save(s) were rejected on-chain — see the rejection codes in docs/batching-trial-runbook.md`)

    const directCharged = direct.reduce((total, tx) => total + tx.charged, 0n)
    const directGasUsed = direct.reduce((total, tx) => total + tx.gasUsed, 0n)
    const batchedCharged = batchedTxs.reduce((total, tx) => total + tx.charged, 0n)
    const batchedGasUsed = batchedTxs.reduce((total, tx) => total + tx.gasUsed, 0n)

    const date = new Date().toISOString().slice(0, 10)
    const evidence = buildEvidence({
      date,
      chainId: deployment.chainId,
      batchAnchor,
      contextRegistry: deployment.contextRegistry,
      monPriceUsd: args.priceUsd,
      direct: {
        saves: direct.length,
        txs: direct.length,
        chargedWeiPerSave: perSave(directCharged, direct.length),
        gasUsedPerSave: perSave(directGasUsed, direct.length),
      },
      batched: {
        saves: args.saves,
        txs: batchedTxs.length,
        batchSize: args.batch,
        chargedWeiPerSave: perSave(batchedCharged, args.saves),
        gasUsedPerSave: perSave(batchedGasUsed, args.saves),
        rejected,
        ...(latencyMs === undefined ? {} : { latencyMs }),
      },
      maxSavesPerTxObserved,
      notes,
    })
    const dir = fileURLToPath(new URL("../docs/evidence/", import.meta.url))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `batch-anchor-benchmark-${date}.json`)
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
    print(`evidence written: ${path}`)
    print(`direct: ${direct.length} saves in ${direct.length} txs — ${formatMon(perSave(directCharged, direct.length))} MON charged per save`)
    print(`batched: ${args.saves} saves in ${batchedTxs.length} txs — ${formatMon(perSave(batchedCharged, args.saves))} MON charged per save, ${rejected} rejected`)
  } finally {
    await env.stop().catch(() => undefined)
  }
}

main().then(
  () => {
    process.exit(0)
  },
  (error) => {
    console.error(mask(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`))
    process.exit(1)
  },
)
