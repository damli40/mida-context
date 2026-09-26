// Brief ex-1 e2e: `mida export <folder>` on a real local Anvil — an owner, two agents, a
// checkpoint that a second checkpoint supersedes, an owner fact, an agent record in a second
// namespace, and one save that went through the batched lane. The export runs through the real
// CLI dispatch; the assertions then execute the README's own verification recipe against the
// chain: every manifest file must hash to the record's on-chain commitment, every ciphertext
// file to its manifest's hash, and the batched record's store row must verify against the
// BatchAnchor's Merkle root and its SaveAnchored log.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keccak256, recoverTypedDataAddress } from "viem"
import type { AbiEvent, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  PERMISSION,
  PROVENANCE_POLICY,
  batchLeafHash,
  batchSaveStructHash,
  batchSaveTypedData,
  canonicalBytes,
  namespaceId,
  verifyMerkleProof,
} from "@mida/protocol"
import type { Address, BatchSaveMessage } from "@mida/protocol"
import { deriveEpochKeyPair, hexOf } from "@mida/crypto"
import {
  batchAnchorAbi,
  contextRegistryAbi,
  createWriteContext,
  getLogsChunked,
  latestTimestamp,
} from "@mida/chain"
import { provisionAgent } from "@mida/fake-vault"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  PURPOSE_ID,
  Runtime,
  approve,
  identityFrom,
  init,
  loadOrCreateOperatorSecrets,
  loadOrCreateSignerKey,
  readOwnerUniverse,
  remember,
  requestAccess,
  runCli,
  saveAgentIdentity,
  saveCheckpoint,
  wrapCheckpoint,
} from "@mida/midad"
import type { ExportEntry, Network } from "@mida/midad"
import { declarationsFor } from "../src/skeleton.js"
import { followPendingAnchors, pendingAnchors } from "../src/batching.js"
import { sampleCheckpoint } from "./helpers.js"

const SETUP_TIMEOUT = 300_000
const STEP_TIMEOUT = 120_000
const SETTLE_MS = 10_000

const envelope = (projectId: string, checkpoint: ReturnType<typeof sampleCheckpoint>, sessionId = "s1") => ({
  projectId,
  sessionId,
  continuesSession: null,
  compiledBy: "export-e2e",
  checkpoint,
})

const sha256hex = (bytes: Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`

const CONTEXT_REGISTERED = contextRegistryAbi.find((e) => e.type === "event" && e.name === "ContextRegistered") as AbiEvent
const SAVE_ANCHORED = batchAnchorAbi.find((e) => e.type === "event" && e.name === "SaveAnchored") as AbiEvent

describe("mida export end to end on local Anvil (ex-1)", () => {
  let env: ScenarioEnvironment
  let network: Network
  let batchAnchor: Address
  let home: MidaHome
  let runtime: Runtime
  const secretBytes: Uint8Array[] = []
  const saved = {
    cp1: undefined as unknown as { contextId: Hex },
    cp2: undefined as unknown as { contextId: Hex },
    fact: undefined as unknown as { contextId: Hex },
    career: undefined as unknown as { contextId: Hex },
    batched: undefined as unknown as { contextId: Hex },
    checkpoint1: envelope("proj-export", sampleCheckpoint({ eventId: "cp-export-01", objective: "the first checkpoint" })),
    checkpoint2: envelope("proj-export", sampleCheckpoint({ eventId: "cp-export-02", objective: "the superseding checkpoint" })),
    checkpointB: envelope("proj-export-b", sampleCheckpoint({ eventId: "cp-export-03", objective: "the batched checkpoint" })),
    factText: "the owner exports with one command",
    careerText: "codex wrote this in goals.career",
  }

  /** Drives the pending ledger until the chain has answered for every queued save. */
  const settlePending = async (ms = SETTLE_MS) => {
    const total = { anchored: 0, rejected: 0 }
    const deadline = Date.now() + ms
    while (Date.now() < deadline && pendingAnchors(home).length > 0) {
      const step = await followPendingAnchors(runtime, () => {})
      total.anchored += step.anchored
      total.rejected += step.rejected
      if (pendingAnchors(home).length > 0) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { ...total, left: pendingAnchors(home).length }
  }

  beforeAll(async () => {
    env = await localEnvironment({ batching: { waitMs: 200 } })
    if (env.deployment.batchAnchor === undefined) throw new Error("deployLocal did not deploy a BatchAnchor")
    batchAnchor = env.deployment.batchAnchor
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-export-e2e-")))
    runtime = await Runtime.open(home, network)

    // init provisions only claude-code — codex gets a manifest that also declares a second
    // namespace, so its record there exercises "a namespace other than the checkpoint area".
    await init(runtime, ["claude-code"])
    const operator = createWriteContext({
      rpcUrl: network.rpcUrl,
      deployment: network.deployment,
      account: privateKeyToAccount(loadOrCreateOperatorSecrets(home).privateKey),
    })
    const codexSignerKey = loadOrCreateSignerKey(home, "codex")
    const provisioned = await provisionAgent({
      operator,
      name: "codex",
      purposeId: PURPOSE_ID,
      declarations: [
        ...declarationsFor(PURPOSE_ID),
        { namespace: "goals.career", permissions: ["READ", "CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE"] },
      ],
      callbackOrigin: "https://codex.mida.example",
      signer: privateKeyToAccount(codexSignerKey),
    })
    const codexIdentity = identityFrom("codex", codexSignerKey, provisioned)
    saveAgentIdentity(home, codexIdentity)
    const codex = runtime.attach(codexIdentity)
    await runtime.ownerApi.putAgentManifest(codexIdentity.manifest)
    await runtime.ensureFunded(provisioned.signer.address, "codex's wallet")

    for (const name of ["claude-code", "codex"] as const) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }

    // The second namespace: initialized by the owner, granted to codex through the same
    // vault.approveGrant path the approve command uses — a custom selection, since the policy's
    // expected scopes do not cover it.
    await runtime.vault.initializeNamespace("goals.career")
    const careerRequest = await codex.createAccessRequest({
      purposeId: PURPOSE_ID,
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.CREATE | PERMISSION.READ, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    })
    const expiresAt = (await latestTimestamp(runtime.chain)) + 7n * 86_400n
    const { response } = await runtime.vault.approveGrant({
      accessRequest: careerRequest,
      manifest: codexIdentity.manifest,
      selection: { kind: "custom", scopes: careerRequest.scopes, expiresAt },
    })
    await codex.completeAccessRequest(careerRequest, response)

    // 1–2. an agent checkpoint in project A, then a checkpoint superseding it (same lineage, v2)
    const cp1 = await saveCheckpoint(runtime, "claude-code", saved.checkpoint1)
    expect(cp1.lane).toBe("direct")
    const cp2 = await runtime.agent("claude-code").supersede(runtime.owner, cp1.contextId, {
      value: { ...wrapCheckpoint(saved.checkpoint2) },
      kind: "EPISODE",
      source: "AGENT_INFERRED",
      tags: ["mida-checkpoint", saved.checkpoint2.checkpoint.eventId],
    })
    saved.cp1 = cp1
    saved.cp2 = cp2

    // 3. an owner `remember` fact
    const fact = await remember(runtime, saved.factText)
    if (fact.kind !== "remembered") throw new Error("the owner fact was refused")
    saved.fact = fact

    // 4. codex's record in the second namespace
    saved.career = await codex.create(runtime.owner, "goals.career", {
      value: saved.careerText,
      kind: "INFERENCE",
      source: "AGENT_INFERRED",
    })

    // 5. one batched save: the switch flips through the real CLI, the save queues, the batch
    // settles, and the pending ledger sees ANCHORED before the export runs.
    const lines: string[] = []
    const code = await runCli(["batching", "on"], {
      home,
      network,
      print: (line) => lines.push(line),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: async () => "yes",
      drainInput: () => {},
      kickDaemon: () => {},
    })
    expect(code).toBe(0)
    const batchedSave = await saveCheckpoint(runtime, "claude-code", saved.checkpointB)
    expect(batchedSave.lane).toBe("batched")
    saved.batched = batchedSave
    const settled = await settlePending()
    expect(settled).toMatchObject({ anchored: 1, rejected: 0, left: 0 })

    // Every secret this universe created — the no-key-bytes check scans the export for each.
    const ownerSecrets = home.readJson<{ privateKey: Hex; seed: Hex; p256PrivateKey: Hex }>("owner/secrets.json")!
    const operatorSecrets = home.readJson<{ privateKey: Hex }>("operator/secrets.json")!
    const secretHex: Hex[] = [ownerSecrets.privateKey, ownerSecrets.seed, ownerSecrets.p256PrivateKey, operatorSecrets.privateKey]
    for (const name of ["claude-code", "codex"]) {
      const signerFile = home.readJson<{ signerPrivateKey: Hex }>(`agents/${name}/signer.json`)!
      const identityFile = home.readJson<{ encryptionPrivateKey: Hex }>(`agents/${name}/identity.json`)!
      secretHex.push(signerFile.signerPrivateKey, identityFile.encryptionPrivateKey)
    }
    // …plus the derived material: each namespace secret and its epoch-1 private key.
    for (const ns of ["projects.current", "preferences.communication", "goals.career"]) {
      const nsSecret = await runtime.vault.deriveNamespaceSecret(namespaceId(ns))
      secretBytes.push(nsSecret)
      secretBytes.push(deriveEpochKeyPair(nsSecret, 1n).privateKey)
    }
    for (const hex of secretHex) secretBytes.push(Buffer.from(hex.slice(2), "hex"))
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  let dest = ""
  let entries: ExportEntry[] = []

  const entryFor = (contextId: Hex): ExportEntry => {
    const found = entries.find((entry) => entry.contextId.toLowerCase() === contextId.toLowerCase())
    expect(found, `no records.json entry for ${contextId}`).toBeDefined()
    return found!
  }

  it(
    "mida export writes the folder, and every record the chain attributes to the owner is in it",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "mida-export-out-"))
      dest = join(outDir, "my-export")
      const lines: string[] = []
      const code = await runCli(["export", dest], {
        home,
        network,
        cwd: outDir,
        print: (line) => lines.push(line),
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
      expect(code).toBe(0)
      expect(lines).toContain(`Exported 5 records (3 namespaces) to ${dest}.`)

      entries = JSON.parse(readFileSync(join(dest, "records.json"), "utf8")) as ExportEntry[]

      // The count check the brief asks for: the owner's chain registrations are the
      // ContextRegistered logs it owns (direct saves) plus the SaveAnchored logs (batched).
      const head = await runtime.chain.publicClient.getBlockNumber({ cacheTime: 0 })
      const directLogs = await getLogsChunked(runtime.chain.publicClient, {
        address: env.deployment.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { owner: runtime.owner },
        fromBlock: env.deployment.deploymentBlock,
        toBlock: head,
      })
      const batchedLogs = await getLogsChunked(runtime.chain.publicClient, {
        address: batchAnchor,
        event: SAVE_ANCHORED,
        args: { owner: runtime.owner },
        fromBlock: env.deployment.batchAnchorBlock ?? env.deployment.deploymentBlock,
        toBlock: head,
      })
      expect(directLogs).toHaveLength(4)
      expect(batchedLogs).toHaveLength(1)
      expect(entries).toHaveLength(directLogs.length + batchedLogs.length)
      const ids = new Set(entries.map((entry) => entry.contextId.toLowerCase()))
      for (const id of [saved.cp1, saved.cp2, saved.fact, saved.career, saved.batched].map((s) => s.contextId.toLowerCase())) {
        expect(ids.has(id), `record ${id} missing from records.json`).toBe(true)
      }
    },
    STEP_TIMEOUT,
  )

  it("the default owner read carries no encrypted bytes — migrate's call is unchanged", async () => {
    // keepEncrypted off is the readOwnerUniverse migrate has always called: no manifest or
    // ciphertext is retained, so a plaintext-only caller's memory use does not change.
    const universe = await readOwnerUniverse(runtime)
    expect(universe).toHaveLength(5)
    for (const record of universe) expect(record.encrypted).toBeUndefined()
    const kept = await readOwnerUniverse(runtime, { keepEncrypted: true })
    for (const record of kept) expect(record.encrypted?.manifest.contextId).toBe(record.contextId)
  })

  it("every payload reads back exactly as it was saved", () => {
    const cp1 = entryFor(saved.cp1.contextId)
    expect(cp1.payload).toMatchObject({ value: { ...wrapCheckpoint(saved.checkpoint1) } })
    const cp2 = entryFor(saved.cp2.contextId)
    expect(cp2.payload).toMatchObject({ value: { ...wrapCheckpoint(saved.checkpoint2) } })
    const fact = entryFor(saved.fact.contextId)
    expect((fact.payload as { value: { text: string } }).value.text).toBe(saved.factText)
    const career = entryFor(saved.career.contextId)
    expect(career.payload).toMatchObject({ value: saved.careerText })
    const batched = entryFor(saved.batched.contextId)
    expect(batched.payload).toMatchObject({ value: { ...wrapCheckpoint(saved.checkpointB) } })
  })

  it("supersession and authorship come out right: cp1 superseded by cp2, authors named", () => {
    const cp1 = entryFor(saved.cp1.contextId)
    const cp2 = entryFor(saved.cp2.contextId)
    expect(cp1.current).toBe(false)
    expect(cp1.supersededBy).toBe(cp2.contextId)
    expect(cp2.current).toBe(true)
    expect(cp2.supersededBy).toBeNull()
    expect(cp2.parentId).toBe(cp1.contextId)
    expect(cp2.version).toBe(2)
    expect(cp1.author.name).toBe("claude-code")
    expect(entryFor(saved.career.contextId).author.name).toBe("codex")
    expect(entryFor(saved.fact.contextId).author.name).toBe("you")
    expect(entryFor(saved.batched.contextId).lane).toBe("batched")
    expect(entryFor(saved.batched.contextId).batchId).not.toBeNull()
    expect(cp1.lane).toBe("direct")
    expect(cp1.expiresAt).toBeNull()
    expect(cp1.expired).toBe(false)
  })

  it("the README's own recipe holds for every record — manifest, ciphertext, chain", async () => {
    for (const entry of entries) {
      const id = entry.contextId.toLowerCase()
      const manifestBytes = readFileSync(join(dest, "encrypted", `${id}.manifest.json`))
      const ciphertext = readFileSync(join(dest, "encrypted", `${id}.ciphertext`))

      // 1. keccak256 of the manifest FILE — the file IS canonicalBytes(manifest) — is the
      //    record's manifestHash.
      expect(keccak256(manifestBytes), `manifest hash mismatch for ${id}`).toBe(entry.manifestHash)
      const manifest = JSON.parse(manifestBytes.toString("utf8"))
      // 3. sha256 of the ciphertext file equals the manifest's ciphertextHash; size matches.
      expect(sha256hex(ciphertext)).toBe(manifest.ciphertextHash)
      expect(ciphertext.length).toBe(manifest.ciphertextSize)

      if (entry.lane === "direct") {
        // 2. ContextRegistry.getRecord(contextId) — the chain's row carries the same hash.
        const record = await runtime.reader.getRecord(entry.contextId)
        expect(record?.manifestHash).toBe(entry.manifestHash)
        continue
      }

      // Batched: no getRecord row — the store's batch row verifies against BatchAnchor instead.
      const row = JSON.parse(readFileSync(join(dest, "encrypted", `${id}.batched.json`), "utf8"))
      const message: BatchSaveMessage = {
        ...row.save.message,
        readEpoch: BigInt(row.save.message.readEpoch),
        expiresAt: BigInt(row.save.message.expiresAt),
      }
      // 4. the save's own manifestHash field names the same commitment
      expect(message.manifestHash).toBe(entry.manifestHash)
      // 1. struct hash, 2. leaf hash — agentId is whoever signed the save, proven on chain
      const structHash = batchSaveStructHash(message)
      const signer = await recoverTypedDataAddress({
        ...batchSaveTypedData({ chainId: env.deployment.chainId, batchAnchor, message }),
        signature: row.save.signature,
      } as never)
      const agentId = await runtime.reader.agentIdOfSigner(signer)
      expect(agentId).not.toBeNull()
      const leaf = batchLeafHash({ contextId: entry.contextId, agentId: agentId!, lineageId: row.lineageId, version: row.version, structHash })
      // 3. the batch's on-chain root admits the leaf under the store's proof — and the
      //    SaveAnchored log for this contextId carries that same leaf
      const [root] = await runtime.chain.publicClient.readContract({
        address: batchAnchor,
        abi: batchAnchorAbi,
        functionName: "batchOf",
        args: [row.batchId],
      })
      expect(verifyMerkleProof(leaf, row.proof, root)).toBe(true)
      const head = await runtime.chain.publicClient.getBlockNumber({ cacheTime: 0 })
      const anchoredLogs = await getLogsChunked(runtime.chain.publicClient, {
        address: batchAnchor,
        event: SAVE_ANCHORED,
        args: { batchId: row.batchId },
        fromBlock: env.deployment.batchAnchorBlock ?? env.deployment.deploymentBlock,
        toBlock: head,
      })
      const log = anchoredLogs.find((l) => (l.args as { contextId: Hex }).contextId.toLowerCase() === id)
      expect(log, `no SaveAnchored log for ${id}`).toBeDefined()
      expect((log!.args as unknown as { leafHash: Hex }).leafHash).toBe(leaf)
    }
  })

  it("records.md renders the content, and the README tells the truth about counts", () => {
    const md = readFileSync(join(dest, "records.md"), "utf8")
    expect(md).toContain("## projects.current (3)")
    expect(md).toContain("## goals.career (1)")
    expect(md).toContain("the superseding checkpoint")
    expect(md).toContain("contains no keys")
    expect(md).toContain(`superseded → ${saved.cp2.contextId}`)

    const readme = readFileSync(join(dest, "README.md"), "utf8")
    expect(readme).toContain("5 records in 3 context areas")
    expect(readme).toContain("- projects.current: 3")
    expect(readme).toContain("- preferences.communication: 1")
    expect(readme).toContain("- goals.career: 1")
    expect(readme).toContain("4 direct, 1 batched")
    expect(readme).toContain("Saves still queued on this laptop: 0")
    expect(readme).toContain("contains no keys")
    expect(readme).toContain(`chain id: ${env.deployment.chainId}`)
    expect(readme).toContain(`ContextRegistry: ${env.deployment.contextRegistry}`)
    expect(readme).toContain(`BatchAnchor: ${batchAnchor}`)
    expect(readme).toContain(`owner: ${runtime.owner}`)
  })

  it("the folder is 0700, every file 0600, and no exported file carries any secret", () => {
    expect(statSync(dest).mode & 0o777).toBe(0o700)
    expect(statSync(join(dest, "encrypted")).mode & 0o777).toBe(0o700)
    const files = ["README.md", "records.json", "records.md"].map((name) => join(dest, name))
    for (const name of readdirSync(join(dest, "encrypted"))) {
      const file = join(dest, "encrypted", name)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      files.push(file)
    }
    for (const file of files.slice(0, 3)) expect(statSync(file).mode & 0o777).toBe(0o600)

    // Every secret in hex AND base64 form, against the raw bytes of every exported file —
    // a key that leaked into ANY field of ANY file fails here.
    const needles: Buffer[] = []
    for (const secret of secretBytes) {
      needles.push(Buffer.from(secret))
      needles.push(Buffer.from(hexOf(secret).slice(2), "utf8"))
      needles.push(Buffer.from(hexOf(secret), "utf8"))
      needles.push(Buffer.from(Buffer.from(secret).toString("base64"), "utf8"))
    }
    for (const file of files) {
      const bytes = readFileSync(file)
      for (const needle of needles) {
        expect(bytes.includes(needle), `${file} contains key material`).toBe(false)
      }
    }
    // sanity: the secrets really were loaded — an empty needle list would pass vacuously
    expect(secretBytes.length).toBeGreaterThanOrEqual(10)
  })
})
