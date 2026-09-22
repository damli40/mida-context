import { describe, expect, it } from "vitest"
import { encodeAbiParameters, encodeEventTopics } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MidaHome,
  approvePasskey,
  canonicalEntries,
  ensureProjectMarker,
  expectedScopesFor,
  markRevokePending,
  saveAgentIdentity,
} from "@mida/midad"
import type { AgentIdentity, PasskeyDeps, ServiceRuntime } from "@mida/midad"
import { OwnerLinkOutcome, PAGE_MISMATCH_LINE, PASSKEY_IDENTITY_LINE, WRONG_OWNER_LINE } from "@mida/midad"
import { PERMISSION, hashString, namespaceId, requestHash } from "@mida/protocol"
import type { AccessRequest, Address, Hex, OwnerLinkResult } from "@mida/protocol"
import { capabilityRegistryAbi } from "@mida/chain"
import { FileAccessRequestStore } from "@mida/midad"
import { expandScopeInputs, manifestBodyHash, POLICY_HASH_V1 } from "@mida/grant-advisor"
import {
  AGENT_ID,
  CHAIN_ID,
  NOW,
  REGISTRY,
  manifestBody,
  signManifest,
  signRequest,
  unsignedRequest,
} from "../../../packages/grant-advisor/test/fixtures.js"

/**
 * `approvePasskey` against a fake chain, a fake agent and a fake page: the session object is a
 * hand-built ServiceRuntime so every chain answer is scripted — which capabilities are live,
 * which transactions emitted them — and the "page" is the injected listener/opener pair. The
 * tests cover the terminal's half of the contract: what is sent, what must be true on chain
 * before a file changes, and which outcomes write nothing.
 */

const OWNER_KEY = `0x${"44".repeat(32)}` as Hex
const OWNER = privateKeyToAccount(OWNER_KEY).address.toLowerCase() as Address
const CAP_ID = `0x${"55".repeat(32)}` as Hex
const TX = `0x${"cc".repeat(32)}` as Hex
const NS = namespaceId("projects.current")

const NETWORK = {
  rpcUrl: "http://127.0.0.1:1",
  deployment: {
    chainId: CHAIN_ID,
    capabilityRegistry: REGISTRY,
    contextRegistry: "0x3333333333333333333333333333333333333333",
    agentRegistry: "0x4444444444444444444444444444444444444444",
    deploymentBlock: 0n,
    vaultRpId: "vault.mida.xyz",
    vaultRpIdHash: `0x${"00".repeat(32)}`,
    policyHashV1: POLICY_HASH_V1,
  },
} as unknown as ServiceRuntime["network"]

interface FakeChain {
  /** `${nsId}:${permissions}:${provenancePolicy}` tuples the owner has already granted the agent. */
  authority: Set<string>
  /** Capability ids activeCapabilityIds returns. */
  ids: Hex[]
  /** id → the on-chain record getCapability returns. */
  caps: Map<string, { owner: Address; agentId: Hex; namespaceId: Hex; permissions: number; provenancePolicy: number; expiresAt: bigint }>
  /** ids isCapabilityValid reports live. */
  live: Set<string>
  /** txHash → capability ids its receipt's CapabilityGranted logs emit. */
  emitted: Map<Hex, Hex[]>
}

function capabilityGrantedLog(owner: Address, agentId: Hex, capabilityId: Hex, nsId: Hex, permissions: number): { address: Address; topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: capabilityRegistryAbi,
    eventName: "CapabilityGranted",
    args: { owner, agentId, namespaceId: nsId },
  }).filter((t): t is Hex => typeof t === "string")
  const data = encodeAbiParameters(
    [
      { name: "capabilityId", type: "bytes32" },
      { name: "permissions", type: "uint8" },
      { name: "provenancePolicy", type: "uint8" },
      { name: "expiresAt", type: "uint64" },
      {
        name: "context",
        type: "tuple",
        components: [
          { name: "requestHash", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "manifestVersion", type: "uint64" },
          { name: "policyVersionHash", type: "bytes32" },
          { name: "namespaceTreeVersionHash", type: "bytes32" },
          { name: "grantNonce", type: "uint256" },
        ],
      },
    ],
    [
      capabilityId,
      permissions,
      0,
      NOW + 7n * 86_400n,
      {
        requestHash: `0x${"00".repeat(32)}` as Hex,
        manifestHash: manifestBodyHash(manifestBody()),
        manifestVersion: 1n,
        policyVersionHash: hashString("mida-grant-policy-v1"),
        namespaceTreeVersionHash: hashString("mida-namespace-tree-v1"),
        grantNonce: 0n,
      },
    ],
  )
  return { address: REGISTRY, topics, data }
}

interface CapturedRound {
  url?: string
  req?: Record<string, unknown>
  completed?: { request: AccessRequest; response: { capabilities: { capabilityId: Hex; transactionHash: Hex }[] } }
}

function fakeSession(home: MidaHome, chain: Partial<FakeChain>, captured: CapturedRound): ServiceRuntime {
  const authority = chain.authority ?? new Set<string>()
  const ids = chain.ids ?? []
  const caps = chain.caps ?? new Map()
  const live = chain.live ?? new Set<string>()
  const emitted = chain.emitted ?? new Map<Hex, Hex[]>()
  const fakeAgent = {
    agentId: AGENT_ID,
    grants: [] as { capabilities: unknown[] }[],
    async createAccessRequest(input: { purposeId: string; scopes: { namespace: string; permissions: number; provenancePolicy?: number }[]; capabilityExpiresAt: bigint }) {
      const request = await signRequest(
        unsignedRequest(
          input.scopes.map((s) => ({ namespace: s.namespace, permissions: s.permissions, provenancePolicy: s.provenancePolicy })),
          { capabilityExpiresAt: input.capabilityExpiresAt.toString(10) },
        ),
      )
      return request
    },
    async completeAccessRequest(request: AccessRequest, response: { capabilities: { capabilityId: Hex; transactionHash: Hex }[] }) {
      captured.completed = { request, response }
      const grant = { capabilities: response.capabilities }
      fakeAgent.grants.push(grant)
      return grant
    },
  }
  return {
    home,
    network: NETWORK,
    owner: OWNER,
    apiBaseUrl: "http://127.0.0.1:9",
    reader: {
      async hasAuthority(_o: Address, a: Hex, nsId: Hex, p: number, pp: number) {
        return authority.has(`${a.toLowerCase()}:${nsId.toLowerCase()}:${p}:${pp}`)
      },
      async activeCapabilityIds() {
        return [...ids]
      },
      async getCapability(id: Hex) {
        return caps.get(id.toLowerCase()) ?? null
      },
    },
    chain: {
      deployment: NETWORK.deployment,
      publicClient: {
        async readContract(input: { functionName: string; args: readonly unknown[] }) {
          if (input.functionName === "isCapabilityValid") return live.has((input.args[0] as string).toLowerCase())
          throw new Error(`no fake for ${input.functionName}`)
        },
        async getTransactionReceipt(input: { hash: Hex }) {
          const granted = emitted.get(input.hash)
          if (granted === undefined) return null
          return {
            status: "success",
            logs: granted.map((id) => {
              const cap = caps.get(id.toLowerCase())!
              return capabilityGrantedLog(OWNER, cap.agentId, id, cap.namespaceId, cap.permissions)
            }),
          }
        },
      },
    },
    agent: () => fakeAgent,
    progress: undefined,
    close: async () => {},
  } as unknown as ServiceRuntime
}

/** runOwnerLinkRound deps with the page faked: the opener records the link and resolves the result. `resolve` lets a test hand-craft the page's answer inside its own opener. */
function fakePageDeps(lines: string[], answer: (nonce: string, reqBytes: Uint8Array) => OwnerLinkResult, captured: CapturedRound): PasskeyDeps & { resolve(r: OwnerLinkResult): void } {
  let resolveResult: ((r: OwnerLinkResult) => void) | undefined
  const deps: PasskeyDeps & { resolve(r: OwnerLinkResult): void } = {
    print: (line) => lines.push(line),
    startListener: async () => ({
      port: 4700,
      result: new Promise<OwnerLinkResult>((resolve) => {
        resolveResult = resolve
      }),
      close: () => {},
    }),
    openLink: async (link) => {
      captured.url = link.url
      const params = new URLSearchParams(link.url.split("#")[1])
      captured.req = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(params.get("req")!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
      ) as Record<string, unknown>
      resolveResult!(answer(params.get("nonce")!, link.requestBytes))
    },
    resolve: (r) => resolveResult!(r),
  }
  return deps
}

function successResult(nonce: string, reqBytes: Uint8Array, extra: Partial<OwnerLinkResult> = {}): OwnerLinkResult {
  return {
    v: 1,
    status: "success",
    nonce,
    requestHash: requestHash(reqBytes),
    owner: OWNER,
    transactions: [TX],
    operations: [],
    ...extra,
  }
}

const dir = () => mkdtempSync(join(tmpdir(), "mida-approve-passkey-"))

async function identity(): Promise<AgentIdentity> {
  return {
    name: "codex",
    agentId: AGENT_ID,
    signerPrivateKey: `0x${"66".repeat(32)}`,
    encryptionPrivateKey: `0x${"77".repeat(32)}`,
    encryptionPublicKey: `0x${"88".repeat(32)}`,
    callbackOrigin: "https://codex.mida.example",
    purposeId: "project_assistance",
    manifest: await signManifest(manifestBody()),
    manifestHash: manifestBodyHash(manifestBody()),
  }
}

async function pendingRequest(home: MidaHome, scopes: { namespace: string; permissions: number }[]): Promise<AccessRequest> {
  const request = await signRequest(unsignedRequest(scopes))
  await new FileAccessRequestStore(home, "codex").save(request)
  home.writeSecretJson("agents/codex/pending-request.json", { request })
  return request
}

describe("approvePasskey", () => {
  it("grants only the still-needed scopes, proves the grant from the chain, then clears the pending request", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const request = await pendingRequest(home, [{ namespace: "projects.current", permissions: PERMISSION.READ | PERMISSION.CREATE }])
    const captured: CapturedRound = {}
    const session = fakeSession(
      home,
      {
        // the page's tx emitted one capability for the requested scope, and it is live
        ids: [CAP_ID],
        caps: new Map([[CAP_ID.toLowerCase(), { owner: OWNER, agentId: AGENT_ID, namespaceId: NS, permissions: PERMISSION.READ | PERMISSION.CREATE, provenancePolicy: 0, expiresAt: NOW + 7n * 86_400n }]]),
        live: new Set([CAP_ID.toLowerCase()]),
        emitted: new Map([[TX, [CAP_ID]]]),
      },
      captured,
    )
    const lines: string[] = []
    const deps = fakePageDeps(lines, (nonce, bytes) => successResult(nonce, bytes), captured)

    const result = await approvePasskey(session, "codex", undefined, deps)

    // the page was handed the signed request, the manifest and the owner
    expect(captured.url).toContain("https://app.midacontext.xyz/approve#v=1&req=")
    expect(captured.req?.owner).toBe(OWNER)
    expect(captured.req?.requestId).toBeUndefined()
    expect((captured.req?.request as { requestId: string }).requestId).toBe(request.requestId)
    expect(captured.req?.manifest).toBeDefined()
    // the response the agent completed was built from the chain, not trusted from the page
    expect(captured.completed?.response.capabilities).toEqual([
      expect.objectContaining({ capabilityId: CAP_ID, transactionHash: TX }),
    ])
    expect(result.granted).toBe(1)
    expect(result.listOnly).toBe(false)
    // the pending request and any revoked marker are cleared; the grant is on disk
    expect(home.has("agents/codex/pending-request.json")).toBe(false)
    expect(home.readJson("agents/codex/grants.json")).toBeDefined()
    expect(lines).toContain(PASSKEY_IDENTITY_LINE)
    expect(lines.some((l) => l.startsWith("codex is asking for:"))).toBe(true)
  })

  it("an already-approved agent in a project folder gets one touch for the signed list row — no grant send needed", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const projectDir = join(dir(), "project")
    mkdirSync(projectDir, { recursive: true })
    const marker = ensureProjectMarker(projectDir)
    // the chain already authorizes every expected scope — nothing to mint
    const authority = new Set<string>()
    for (const s of expandScopeInputs(expectedScopesFor("project_assistance"))) {
      authority.add(`${AGENT_ID.toLowerCase()}:${s.namespaceId.toLowerCase()}:${s.permissions}:${s.provenancePolicy}`)
    }
    const captured: CapturedRound = {}
    const session = fakeSession(home, { authority, ids: [CAP_ID], live: new Set([CAP_ID.toLowerCase()]) }, captured)
    const ownerAccount = privateKeyToAccount(OWNER_KEY)
    const lines: string[] = []
    const deps = fakePageDeps(lines, (nonce, bytes) => successResult(nonce, bytes), captured)
    // The fake page signs the list the same way the real one does: the rows it was sent, plus
    // approvedAt on the new row.
    deps.openLink = async (link) => {
      const params = new URLSearchParams(link.url.split("#")[1])
      const reqJson = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(params.get("req")!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
      ) as { entries: { agent: string; projectId: string; root: string; approvedAt: string }[]; entry: { agent: string; projectId: string; root: string } }
      const rows = [...reqJson.entries, { ...reqJson.entry, approvedAt: new Date(0).toISOString() }]
      const signature = await ownerAccount.signMessage({ message: canonicalEntries(rows) })
      captured.url = link.url
      captured.req = reqJson as unknown as Record<string, unknown>
      deps.resolve({
        v: 1,
        status: "success",
        nonce: params.get("nonce")!,
        requestHash: requestHash(link.requestBytes),
        owner: OWNER,
        transactions: [],
        operations: [],
        entry: { entries: rows as unknown as Record<string, unknown>[], signature },
      })
    }

    const result = await approvePasskey(session, "codex", projectDir, deps)

    expect(result.listOnly).toBe(true)
    expect(result.granted).toBe(0)
    expect(captured.completed).toBeUndefined() // no grant completed — nothing was minted
    expect(result.projectId).toBe(marker.projectId)
    // the signed list the page returned was written, exactly as signed
    const written = home.readJson<{ entries: { agent: string; projectId: string }[]; signature: string }>("approved-projects.json")
    expect(written?.signature).toMatch(/^0x/)
    expect(written?.entries.some((e) => e.agent === "codex" && e.projectId === marker.projectId)).toBe(true)
    expect(lines.some((l) => l.includes("already approved on chain; adding this folder needs one passkey touch"))).toBe(true)
  })

  it("a signed list the page altered — a row the terminal never sent — is a mismatch and nothing is written", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const projectDir = join(dir(), "project")
    mkdirSync(projectDir, { recursive: true })
    ensureProjectMarker(projectDir)
    const authority = new Set<string>()
    for (const s of expandScopeInputs(expectedScopesFor("project_assistance"))) {
      authority.add(`${AGENT_ID.toLowerCase()}:${s.namespaceId.toLowerCase()}:${s.permissions}:${s.provenancePolicy}`)
    }
    const captured: CapturedRound = {}
    const session = fakeSession(home, { authority, ids: [CAP_ID], live: new Set([CAP_ID.toLowerCase()]) }, captured)
    const ownerAccount = privateKeyToAccount(OWNER_KEY)
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes), captured)
    deps.openLink = async (link) => {
      const params = new URLSearchParams(link.url.split("#")[1])
      const rows = [
        { agent: "codex", projectId: "proj", root: `0x${"33".repeat(32)}`, approvedAt: new Date(0).toISOString() },
        { agent: "intruder", projectId: "evil", root: `0x${"99".repeat(32)}`, approvedAt: new Date(0).toISOString() },
      ]
      const signature = await ownerAccount.signMessage({ message: canonicalEntries(rows) })
      deps.resolve({
        v: 1,
        status: "success",
        nonce: params.get("nonce")!,
        requestHash: requestHash(link.requestBytes),
        owner: OWNER,
        transactions: [],
        operations: [],
        entry: { entries: rows as unknown as Record<string, unknown>[], signature },
      })
    }

    await expect(approvePasskey(session, "codex", projectDir, deps)).rejects.toThrowError(PAGE_MISMATCH_LINE)
    expect(home.has("approved-projects.json")).toBe(false)
  })

  it("a success result whose grant never landed on chain is a mismatch — the pending request stays for a re-run", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    await pendingRequest(home, [{ namespace: "projects.current", permissions: PERMISSION.READ | PERMISSION.CREATE }])
    const captured: CapturedRound = {}
    // no live capabilities and no emitted logs: the page claimed a grant the chain never saw
    const session = fakeSession(home, {}, captured)
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes), captured)

    await expect(approvePasskey(session, "codex", undefined, deps)).rejects.toThrowError(PAGE_MISMATCH_LINE)
    expect(home.has("agents/codex/pending-request.json")).toBe(true)
    expect(home.has("agents/codex/grants.json")).toBe(false)
  })

  it("a success result that names a different owner is a mismatch", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    await pendingRequest(home, [{ namespace: "projects.current", permissions: PERMISSION.READ | PERMISSION.CREATE }])
    const session = fakeSession(home, {}, {})
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes, { owner: `0x${"99".repeat(20)}` as Address }), {})

    await expect(approvePasskey(session, "codex", undefined, deps)).rejects.toThrowError(PAGE_MISMATCH_LINE)
  })

  it("the wrong-owner reason from the page becomes the fixed passkey line — exit 2", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    await pendingRequest(home, [{ namespace: "projects.current", permissions: PERMISSION.READ | PERMISSION.CREATE }])
    const session = fakeSession(home, {}, {})
    const deps = fakePageDeps([], (nonce, bytes) => ({
      v: 1,
      status: "failed",
      nonce,
      requestHash: requestHash(bytes),
      owner: null,
      transactions: [],
      operations: [],
      reason: "This passkey derives a different Mida owner",
    }), {})

    const error = await approvePasskey(session, "codex", undefined, deps).then(
      () => undefined,
      (e) => e as OwnerLinkOutcome,
    )
    expect(error).toBeInstanceOf(OwnerLinkOutcome)
    expect(error!.line).toBe(WRONG_OWNER_LINE)
    expect(error!.exitCode).toBe(2)
  })

  it("a cancelled page throws the page's reason — exit 2, pending request kept", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    await pendingRequest(home, [{ namespace: "projects.current", permissions: PERMISSION.READ | PERMISSION.CREATE }])
    const session = fakeSession(home, {}, {})
    const deps = fakePageDeps([], (nonce, bytes) => ({
      v: 1,
      status: "cancelled",
      nonce,
      requestHash: requestHash(bytes),
      owner: null,
      transactions: [],
      operations: [],
      reason: "the passkey prompt was dismissed",
    }), {})

    const error = await approvePasskey(session, "codex", undefined, deps).then(
      () => undefined,
      (e) => e as OwnerLinkOutcome,
    )
    expect(error!.line).toBe("the passkey prompt was dismissed")
    expect(error!.exitCode).toBe(2)
    expect(home.has("agents/codex/pending-request.json")).toBe(true)
  })

  it("a pending revoke inside the landing window refuses before the page is asked", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    markRevokePending(home, "codex", { intentId: `0x${"aa".repeat(32)}` as Hex, userOpHash: null })
    const captured: CapturedRound = {}
    const session = fakeSession(home, { ids: [CAP_ID], live: new Set([CAP_ID.toLowerCase()]) }, captured)
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes), captured)

    const error = await approvePasskey(session, "codex", undefined, deps).then(
      () => undefined,
      (e) => e as OwnerLinkOutcome,
    )
    expect(error).toBeInstanceOf(OwnerLinkOutcome)
    expect(error!.line).toContain("still landing")
    expect(error!.exitCode).toBe(1)
    expect(captured.url).toBeUndefined() // the page was never opened
  })
})
