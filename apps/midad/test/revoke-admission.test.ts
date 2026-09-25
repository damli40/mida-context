// in-3 (I4): POST /batch/saves refuses a save whose signer sits on the store's active deny list
// and a save sealed under a superseded read epoch — refuse means no queue row at all, and the
// denial must not leak onto another agent's saves.
//
// The store's deny list exists so a revoke still pending on Monad already stops writes, not only
// reads. Until in-3 the batch admission path verified on-chain authority but never consulted the
// deny overlay and never checked the save's readEpoch, so both a save signed by an
// about-to-be-revoked agent and a save sealed under a superseded epoch were admitted, queued, and
// anchored. These runs pin the two gates the object upload route already runs.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { zeroHash } from "viem"
import { CONTEXT_KIND, PROVENANCE_SOURCE, batchContextId, namespaceId } from "@mida/protocol"
import type { BatchSaveMessage, Hex } from "@mida/protocol"
import { bytesOf, hexOf, sealContextObject } from "@mida/crypto"
import { signBatchSave } from "@mida/sdk"
import type { BatchedSaveWire } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  NAMESPACE,
  Runtime,
  approve,
  init,
  loadAgentIdentity,
  requestAccess,
  revoke,
  runCli,
  saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import { wrapCheckpoint } from "../src/checkpoint-payload.js"
import { apiClient } from "../src/runtime.js"
import { sampleCheckpoint } from "./helpers.js"

const AGENTS = ["claude-code", "codex"] as const
const T = 180_000
const NAMESPACE_ID = namespaceId(NAMESPACE)

const env = (projectId: string, eventId: string, sessionId = "s1") => ({
  projectId,
  sessionId,
  continuesSession: null,
  compiledBy: "test",
  checkpoint: sampleCheckpoint({ eventId }),
})

const codeOf = (error: unknown): string => (error as { code?: string })?.code ?? String(error)

describe("in-3 I4 — a revoke pending on Monad stops new batched saves at the store", () => {
  let scene: ScenarioEnvironment
  let network: Network

  beforeAll(async () => {
    scene = await localEnvironment({ batching: { waitMs: 200 } })
    network = { rpcUrl: scene.rpcUrl, deployment: scene.deployment, fund: scene.fund, storageUrl: scene.apiBaseUrl }
  }, 300_000)

  afterAll(async () => {
    await scene?.stop()
  })

  /** A fresh home on the shared chain: both agents registered, approved, and the batch lane on. */
  const newHome = async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-in3-i4-")))
    const runtime = await Runtime.open(home, network)
    await init(runtime, AGENTS)
    for (const name of AGENTS) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }
    const code = await runCli(["batching", "on"], {
      home,
      network,
      print: () => {},
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: async () => "yes",
      drainInput: () => {},
      kickDaemon: () => {},
    })
    expect(code).toBe(0)
    return { home, runtime, agentId: loadAgentIdentity(home, "claude-code")!.agentId }
  }

  /** The "revoke pending on Monad" state: the owner's deny is staged at the store, nothing has reached the chain. */
  const stageDenyOnly = (runtime: Runtime, agentId: Hex) =>
    runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })

  it("a save signed by a denied agent is refused WRITE_DENIED and never queued", async () => {
    const { runtime, agentId } = await newHome()
    try {
      await stageDenyOnly(runtime, agentId)

      // Mida's own save path reads first — the store's deny answers CAPABILITY_REVOKED there.
      // Either way the write is refused before a queue row exists.
      let viaMida = "admitted"
      await saveCheckpoint(runtime, "claude-code", env("proj-i4", "cp-i4-0001")).catch((e) => (viaMida = codeOf(e)))
      expect(viaMida).not.toBe("admitted")

      // The agent's key calling POST /batch/saves directly — no read first — must hit the store's
      // own admission gate, and refuse distinctly: WRITE_DENIED names the pending window
      // (CAPABILITY_REVOKED would claim the revoke already landed on Monad — it has not).
      const envelope = wrapCheckpoint(env("proj-i4", "cp-i4-0002"))
      let direct: string
      try {
        await runtime.agent("claude-code").createBatched(runtime.owner, NAMESPACE, {
          value: { ...envelope },
          kind: "EPISODE",
          source: "AGENT_INFERRED",
          tags: ["mida-checkpoint", "cp-i4-0002"],
        })
        direct = "QUEUED"
      } catch (e) {
        direct = codeOf(e)
      }
      expect(direct).toBe("WRITE_DENIED")

      // Refuse means refuse — no queue row for this owner/namespace.
      expect((await runtime.ownerApi.listBatchSaves({ owner: runtime.owner, namespaceId: NAMESPACE_ID })).items).toHaveLength(0)

      // An unrelated agent's save in the same window still queues — the deny is scoped.
      const codex = await saveCheckpoint(runtime, "codex", env("proj-i4", "cp-i4-0003", "sB2"))
      expect(codex.batched?.state).toBe("QUEUED")
      expect((await runtime.ownerApi.listBatchSaves({ owner: runtime.owner, namespaceId: NAMESPACE_ID })).items).toHaveLength(1)
    } finally {
      await runtime.close()
    }
  }, T)

  it("a save sealed under a superseded read epoch is refused EPOCH_STALE and never queued", async () => {
    const { home, runtime, agentId } = await newHome()
    try {
      const owner = runtime.owner
      const deployment = runtime.network!.deployment
      const batchAnchor = deployment.batchAnchor!

      // Hand-sign the exact wire createBatched posts, while epoch 1 is still the required epoch.
      const readEpoch = await runtime.reader.requiredReadEpoch(owner, NAMESPACE_ID)
      expect(readEpoch).toBe(1n)
      const epochPublicKey = await runtime.reader.epochPublicKey(owner, NAMESPACE_ID, readEpoch)
      expect(epochPublicKey).not.toBeNull()
      const objectNonce = hexOf(randomBytes(32))
      const contextId = batchContextId({
        chainId: deployment.chainId,
        batchAnchor,
        owner,
        agentId,
        namespaceId: NAMESPACE_ID,
        parentId: zeroHash,
        objectNonce,
      })
      const sealed = sealContextObject({
        payload: { v: 1, value: "checkpoint sealed under epoch 1", kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } },
        binding: {
          chainId: deployment.chainId,
          contextRegistry: deployment.contextRegistry,
          contextId,
          namespaceId: NAMESPACE_ID,
          readEpoch,
        },
        epochPublicKey: bytesOf(epochPublicKey ?? zeroHash, 32),
      })
      const message: BatchSaveMessage = {
        owner,
        namespaceId: NAMESPACE_ID,
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
      const signer = privateKeyToAccount(loadAgentIdentity(home, "claude-code")!.signerPrivateKey)
      const signature = await signBatchSave({ account: signer, chainId: deployment.chainId, batchAnchor, message })
      const wire: BatchedSaveWire = {
        message: { ...message, readEpoch: message.readEpoch.toString(10), expiresAt: message.expiresAt.toString(10) },
        signature,
        manifest: sealed.manifest,
        ciphertext: hexOf(sealed.ciphertext),
      }

      // Revoking codex — who holds live READ on this namespace — lands and rotates the read
      // epoch, while claude-code keeps every grant. The hand-signed save, sealed under epoch 1,
      // is now stale for a signer who still has full authority: the contract could only reject
      // it BAD_EPOCH, so admission is the only honest place to refuse it.
      await revoke(runtime, "codex")
      expect(await runtime.reader.requiredReadEpoch(owner, NAMESPACE_ID)).toBe(2n)

      let outcome = "admitted"
      await apiClient(scene.apiBaseUrl, deployment, signer).postBatchSave(wire).catch((e) => (outcome = codeOf(e)))
      expect(outcome).toBe("EPOCH_STALE")
      expect((await runtime.ownerApi.listBatchSaves({ owner, namespaceId: NAMESPACE_ID })).items).toHaveLength(0)
    } finally {
      await runtime.close()
    }
  }, T)
})
