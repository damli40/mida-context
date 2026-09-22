import { describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MidaHome,
  canonicalEntries,
  markRevokePending,
  revokePasskey,
  revokePending,
  saveAgentIdentity,
} from "@mida/midad"
import type { AgentIdentity, PasskeyDeps, ServiceRuntime } from "@mida/midad"
import { OwnerLinkOutcome, PAGE_MISMATCH_LINE } from "@mida/midad"
import { PERMISSION, namespaceId, requestHash } from "@mida/protocol"
import type { Address, Hex, OwnerLinkResult } from "@mida/protocol"
import { manifestBodyHash, POLICY_HASH_V1 } from "@mida/grant-advisor"
import { AGENT_ID, CHAIN_ID, NOW, REGISTRY, manifestBody, signManifest } from "../../../packages/grant-advisor/test/fixtures.js"

/**
 * `revokePasskey` against a fake chain and a fake page: the session is a hand-built
 * ServiceRuntime so every chain answer is scripted — which capabilities exist and whether
 * they are still live after the page claims the revoke. The tests pin the rule that decides
 * everything: the chain, not the page's say-so, retires the capabilities before the local
 * marker and the re-signed list are written.
 */

const OWNER_KEY = `0x${"44".repeat(32)}` as Hex
const OWNER = privateKeyToAccount(OWNER_KEY).address.toLowerCase() as Address
const CAP_ID = `0x${"55".repeat(32)}` as Hex
const TX = `0x${"cc".repeat(32)}` as Hex
const SURVIVOR_ID = `0x${"77".repeat(32)}` as Hex
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
  /** Capability ids activeCapabilityIds returns. */
  ids?: Hex[]
  /** id → the on-chain record getCapability returns. */
  caps?: Map<string, { owner: Address; agentId: Hex; namespaceId: Hex; permissions: number; provenancePolicy: number; expiresAt: bigint }>
  /** ids isCapabilityValid reports live — a function so a test can flip it mid-run. */
  live?: (id: Hex) => boolean
  /** (owner, agentId, nsId, permissions, provenance) tuples hasAuthority answers true for. */
  authority?: Set<string>
}

interface CapturedRound {
  url?: string
  req?: Record<string, unknown>
}

function fakeSession(home: MidaHome, chain: FakeChain, captured: CapturedRound): ServiceRuntime {
  const ids = chain.ids ?? []
  const caps = chain.caps ?? new Map()
  const live = chain.live ?? (() => false)
  const authority = chain.authority ?? new Set<string>()
  return {
    home,
    network: NETWORK,
    owner: OWNER,
    apiBaseUrl: "http://127.0.0.1:9",
    reader: {
      async activeCapabilityIds() {
        return [...ids]
      },
      async getCapability(id: Hex) {
        return caps.get(id.toLowerCase()) ?? null
      },
      async hasAuthority(_o: Address, a: Hex, nsId: Hex, p: number, pp: number) {
        return authority.has(`${a.toLowerCase()}:${nsId.toLowerCase()}:${p}:${pp}`)
      },
      async agentIdOfSigner() {
        return null
      },
      async getAgent() {
        return null
      },
    },
    chain: {
      deployment: NETWORK.deployment,
      publicClient: {
        async readContract(input: { functionName: string; args: readonly unknown[] }) {
          if (input.functionName === "isCapabilityValid") return live(input.args[0] as Hex)
          throw new Error(`no fake for ${input.functionName}`)
        },
      },
    },
    agent: () => {
      throw new Error("revoke does not need the agent facade")
    },
    progress: undefined,
    close: async () => {},
  } as unknown as ServiceRuntime
}

/** runOwnerLinkRound deps with the page faked: the opener records the link and resolves the result. */
function fakePageDeps(
  lines: string[],
  answer: (nonce: string, reqBytes: Uint8Array, req: Record<string, unknown>) => OwnerLinkResult | Promise<OwnerLinkResult>,
  captured: CapturedRound,
): PasskeyDeps {
  let resolveResult: ((r: OwnerLinkResult) => void) | undefined
  return {
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
      const reqJson = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(params.get("req")!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
      ) as Record<string, unknown>
      captured.req = reqJson
      resolveResult!(await answer(params.get("nonce")!, link.requestBytes, reqJson))
    },
  }
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

const dir = () => mkdtempSync(join(tmpdir(), "mida-revoke-passkey-"))

async function identity(name = "codex", agentId: Hex = AGENT_ID): Promise<AgentIdentity> {
  return {
    name,
    agentId,
    signerPrivateKey: `0x${"66".repeat(32)}`,
    encryptionPrivateKey: `0x${"77".repeat(32)}`,
    encryptionPublicKey: `0x${"88".repeat(32)}`,
    callbackOrigin: "https://codex.mida.example",
    purposeId: "project_assistance",
    manifest: await signManifest(manifestBody()),
    manifestHash: manifestBodyHash(manifestBody()),
  }
}

const CAP = { owner: OWNER, agentId: AGENT_ID, namespaceId: NS, permissions: PERMISSION.READ | PERMISSION.CREATE, provenancePolicy: 0, expiresAt: NOW + 7n * 86_400n }

/** A signed approved-projects list on disk, as approve left it. */
async function writeList(home: MidaHome, rows: { agent: string; projectId: string; root: string; approvedAt: string }[]) {
  const signature = await privateKeyToAccount(OWNER_KEY).signMessage({ message: canonicalEntries(rows) })
  home.writeSecretJson("approved-projects.json", { entries: rows, signature })
}

describe("revokePasskey", () => {
  it("sends the revoke through the page, proves the caps died on chain, then writes the marker and the re-signed list", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    saveAgentIdentity(home, await identity("survivor", SURVIVOR_ID))
    const rows = [
      { agent: "codex", projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
      { agent: "survivor", projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
    ]
    await writeList(home, rows)
    // live before the page answers, dead after — the scripted chain the page's send would have changed
    let landed = false
    const caps = new Map([[CAP_ID.toLowerCase(), CAP]])
    const captured: CapturedRound = {}
    const session = fakeSession(
      home,
      {
        ids: [CAP_ID],
        caps,
        live: () => !landed,
        // the survivor still holds READ on the revoked namespace — the page re-wrapped it
        authority: new Set([`${SURVIVOR_ID.toLowerCase()}:${NS.toLowerCase()}:${PERMISSION.READ}:0`]),
      },
      captured,
    )
    const lines: string[] = []
    const deps = fakePageDeps(lines, async (nonce, bytes, reqJson) => {
      landed = true // the page's send lands between the request and the result
      const kept = reqJson.entries as typeof rows // the page re-signs what it was sent
      const signature = await privateKeyToAccount(OWNER_KEY).signMessage({ message: canonicalEntries(kept) })
      return successResult(nonce, bytes, { transactions: [TX], entry: { entries: kept as never, signature } })
    }, captured)

    const result = await revokePasskey(session, "codex", deps)

    // the page was asked for the agent, the surviving readers, and the rows to keep
    expect(captured.url).toContain("/revoke#v=1&req=")
    expect(captured.req?.owner).toBe(OWNER)
    expect(captured.req?.agentId).toBe(AGENT_ID)
    expect((captured.req?.readers as string[]).includes(SURVIVOR_ID)).toBe(true)
    expect((captured.req?.readers as string[]).includes(AGENT_ID)).toBe(false)
    expect((captured.req?.entries as { agent: string }[]).every((e) => e.agent !== "codex")).toBe(true)
    // the local record caught up with the chain
    expect(result.nothingToRevoke).toBe(false)
    expect(home.readJson("agents/codex/revoked.json")).toBeDefined()
    const written = home.readJson<{ entries: { agent: string }[]; signature: string }>("approved-projects.json")
    expect(written?.entries).toEqual([rows[1]])
    expect(result.rewrapped).toEqual(["survivor"])
    expect(lines).toContain("Your passkey is your Mida identity. Use the same passkey you originally registered.")
  })

  it("a page result whose caps are still live on chain is a mismatch — nothing is written", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const caps = new Map([[CAP_ID.toLowerCase(), CAP]])
    const session = fakeSession(home, { ids: [CAP_ID], caps, live: () => true }, {})
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes), {})

    await expect(revokePasskey(session, "codex", deps)).rejects.toThrowError(PAGE_MISMATCH_LINE)
    expect(home.has("agents/codex/revoked.json")).toBe(false)
  })

  it("an agent with nothing on chain and no list is nothing-to-revoke — the page is never opened", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const captured: CapturedRound = {}
    const session = fakeSession(home, {}, captured)
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes), captured)

    const result = await revokePasskey(session, "codex", deps)

    expect(result.nothingToRevoke).toBe(true)
    expect(result.transactionHashes).toEqual([])
    expect(captured.url).toBeUndefined()
    expect(home.has("agents/codex/revoked.json")).toBe(false) // never-approved agents get no marker
  })

  it("a re-run after a landed pending revoke clears the pending marker without asking the page", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    markRevokePending(home, "codex", { intentId: null, userOpHash: `0x${"ee".repeat(32)}` as Hex })
    const captured: CapturedRound = {}
    const session = fakeSession(home, {}, captured)
    const deps = fakePageDeps([], (nonce, bytes) => successResult(nonce, bytes), captured)

    const result = await revokePasskey(session, "codex", deps)

    expect(result.nothingToRevoke).toBe(true)
    expect(captured.url).toBeUndefined()
    expect(revokePending(home, "codex")).toBeUndefined()
    // no live caps, no revoked marker yet, no grants.json — the never-approved rule: no marker
    expect(home.has("agents/codex/revoked.json")).toBe(false)
  })

  it("a chain-dead agent with rows still on the list still costs one touch — the page re-signs the kept rows", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const rows = [
      { agent: "codex", projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
      { agent: "survivor", projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
    ]
    await writeList(home, rows)
    // chain already shows the caps dead — ids listed but not valid
    const caps = new Map([[CAP_ID.toLowerCase(), CAP]])
    const captured: CapturedRound = {}
    const session = fakeSession(home, { ids: [CAP_ID], caps, live: () => false }, captured)
    const deps = fakePageDeps([], async (nonce, bytes, reqJson) => {
      const kept = reqJson.entries as typeof rows
      const signature = await privateKeyToAccount(OWNER_KEY).signMessage({ message: canonicalEntries(kept) })
      return successResult(nonce, bytes, { transactions: [], entry: { entries: kept as never, signature } })
    }, captured)

    const result = await revokePasskey(session, "codex", deps)

    expect(captured.url).toContain("/revoke#v=1&req=") // the touch still happened
    expect(result.nothingToRevoke).toBe(false)
    const written = home.readJson<{ entries: { agent: string }[] }>("approved-projects.json")
    expect(written?.entries).toEqual([rows[1]])
    expect(home.readJson("agents/codex/revoked.json")).toBeDefined()
  })

  it("a re-signed list the page altered — a surviving row dropped — is a mismatch and the file keeps the old signature", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const rows = [
      { agent: "codex", projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
      { agent: "survivor", projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
    ]
    await writeList(home, rows)
    let landed = false
    const caps = new Map([[CAP_ID.toLowerCase(), CAP]])
    const session = fakeSession(home, { ids: [CAP_ID], caps, live: () => !landed }, {})
    const deps = fakePageDeps([], async (nonce, bytes) => {
      landed = true
      // the page dropped the survivor's row and signed that instead — a real signature over wrong content
      const altered = [] as typeof rows
      const signature = await privateKeyToAccount(OWNER_KEY).signMessage({ message: canonicalEntries(altered) })
      return successResult(nonce, bytes, { entry: { entries: altered as never, signature } })
    }, {})

    await expect(revokePasskey(session, "codex", deps)).rejects.toThrowError(PAGE_MISMATCH_LINE)
    const written = home.readJson<{ entries: { agent: string }[] }>("approved-projects.json")
    expect(written?.entries).toEqual(rows) // the old list is untouched
  })

  it("a pending sponsor result marks the revoke still-landing and exits 1 — marker survives for the next run", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const caps = new Map([[CAP_ID.toLowerCase(), CAP]])
    const session = fakeSession(home, { ids: [CAP_ID], caps, live: () => true }, {})
    const opHash = `0x${"ee".repeat(32)}` as Hex
    const deps = fakePageDeps([], (nonce, bytes) => ({
      v: 1,
      status: "pending",
      nonce,
      requestHash: requestHash(bytes),
      owner: OWNER,
      transactions: [],
      operations: [opHash],
      reason: "accepted, still landing",
    }), {})

    const error = await revokePasskey(session, "codex", deps).then(
      () => undefined,
      (e) => e as OwnerLinkOutcome,
    )
    expect(error!.exitCode).toBe(1)
    expect(error!.line).toContain("may still land")
    expect(revokePending(home, "codex")?.userOpHash).toBe(opHash)
    expect(home.has("agents/codex/revoked.json")).toBe(false)
  })

  it("a cancelled page throws the reason and writes nothing", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveAgentIdentity(home, await identity())
    const caps = new Map([[CAP_ID.toLowerCase(), CAP]])
    const session = fakeSession(home, { ids: [CAP_ID], caps, live: () => true }, {})
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

    const error = await revokePasskey(session, "codex", deps).then(
      () => undefined,
      (e) => e as OwnerLinkOutcome,
    )
    expect(error!.exitCode).toBe(2)
    expect(error!.line).toBe("the passkey prompt was dismissed")
    expect(home.has("agents/codex/revoked.json")).toBe(false)
  })
})
