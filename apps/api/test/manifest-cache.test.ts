// M3-A2 item 2: a manifest index row marked verified inside the last 60 seconds is served without a
// Monad read; older or never-verified rows re-verify and refresh the mark. Negatives are never cached —
// every failure re-checks the chain, so a removed agent disappears within 60 s of its last verification.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { AgentCapabilityManifestBody, AgentRecord, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { manifestBindingFor, manifestBodyHash } from "@mida/grant-advisor"
import { randomBytes } from "@noble/hashes/utils.js"
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

const START = 1_800_000_000n
const operator = privateKeyToAccount(generatePrivateKey())

async function signedEnvelope() {
  const body: AgentCapabilityManifestBody = {
    v: 1,
    agentId: hexOf(randomBytes(32)),
    manifestVersion: 1,
    name: "agent",
    purposes: [{ id: "career_coaching", description: "reads career context" }],
    scopeDeclarations: [],
    issuedAt: 0,
  }
  const binding = manifestBindingFor({ chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, body })
  return {
    manifest: body,
    operatorSignature: await operator.signTypedData(binding as never),
  } as SignedAgentCapabilityManifest
}

describe("the 60 second verified-manifest cache", () => {
  it("serves a recently verified row with no chain read, re-verifies after 60 s, never caches a negative", async () => {
    let now = START
    const agents = new Map<Hex, AgentRecord>()
    let agentReads = 0
    const reader = {
      now: async () => now,
      getAgent: async (agentId: Hex) => {
        agentReads += 1
        return agents.get(agentId.toLowerCase() as Hex) ?? null
      },
    } as unknown as RegistryReader
    const { app, store } = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-cache-")), clock: () => now })
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account: operator,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => now,
      fetch: async (url, init) => app.request(url, init),
    })

    const envelope = await signedEnvelope()
    const bodyHash = manifestBodyHash(envelope.manifest)
    const record: AgentRecord = {
      agentId: envelope.manifest.agentId,
      operator: operator.address,
      signer: operator.address,
      encryptionPublicKey: hexOf(randomBytes(32)),
      encryptionKeyVersion: 1,
      callbackOriginHash: hexOf(randomBytes(32)),
      capabilityManifestHash: bodyHash,
      capabilityManifestVersion: 1,
      active: true,
    }
    agents.set(record.agentId.toLowerCase() as Hex, record)

    // The registered-agent PUT verifies and marks the row: the immediate GET is a cache hit — zero chain reads.
    await client.putAgentManifest(envelope)
    agentReads = 0
    expect(await client.getAgentManifest(bodyHash)).toEqual(envelope)
    expect(agentReads).toBe(0)

    // Still inside the window at 59 s; past it at 61 s the GET re-verifies and refreshes the mark.
    now = START + 59n
    await client.getAgentManifest(bodyHash)
    expect(agentReads).toBe(0)
    now = START + 61n
    await client.getAgentManifest(bodyHash)
    expect(agentReads).toBe(1)
    expect(await store.getManifestIndex(bodyHash)).toMatchObject({ verifiedAt: new Date(Number(START + 61n) * 1000).toISOString() })
    // And the refreshed mark buys another chain-free window.
    await client.getAgentManifest(bodyHash)
    expect(agentReads).toBe(1)

    // The agent disappearing on Monad stays invisible only inside the window: once the mark ages out the
    // next GET re-checks — and every request after that re-checks too, because no negative is cached.
    agents.clear()
    now = START + 61n + 61n
    await expect(client.getAgentManifest(bodyHash)).rejects.toMatchObject({ code: "AGENT_ID_MISMATCH" })
    expect(agentReads).toBe(2)
    await expect(client.getAgentManifest(bodyHash)).rejects.toMatchObject({ code: "AGENT_ID_MISMATCH" })
    expect(agentReads).toBe(3)
  })
})
