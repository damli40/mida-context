import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { PERMISSION, buildOwnerLink, namespaceById, namespaceId } from "@mida/protocol"
import type { OwnerLinkResult as FlowResult } from "@mida/protocol"
import { deriveEpochKeyPair, deriveNamespaceSecret, hexOf } from "@mida/crypto"
import { SponsorDidNotPay, SponsorPending } from "@mida/chain/browser"
import type { Deployment, SponsoredReceipt, TxKind } from "@mida/chain/browser"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"
import { fakePrfOutput } from "@mida/fake-vault/browser"
import { AGENT_ID, CHAIN_ID, NOW, REGISTRY, agentRecordFor, manifestBody } from "../../../packages/grant-advisor/test/fixtures.js"
import { deriveOwnerSecrets, ownerAccount } from "../src/owner/secrets.js"
import type { OwnerSecrets } from "../src/owner/secrets.js"
import type { CredentialsContainerLike } from "../src/check/client.js"
import { makeAssertion, makeKeyPair } from "./helpers.js"
import type { FlowEnvironment } from "../src/owner/flows.js"
import { readersAfterRevoke } from "../src/me/model.js"
import { renderMe, wireRevokePanels } from "../src/me/page.js"
import { repairReaderWrapsFromMe, revokeFromMe, shouldOfferRepair } from "../src/me/revoke.js"
import type { MeRevokeResult } from "../src/me/revoke.js"
import { BLOCKED_AT_STORE_TEXT } from "../src/me/sources.js"
import type { AgentRow, MeData } from "../src/me/sources.js"

/**
 * Task 6 — revoke straight from /me, without a terminal link. revokeFromMe builds the same
 * request the terminal would (owner = the signed-in address, readers = every other agent the
 * page verified holds live READ), parses it through the shared owner-link validation, then runs
 * the same prepareRevoke → confirmRevoke pair. These tests drive it end to end against the same
 * fakes flows.test.ts uses, plus the page wiring: the panel, the click, and the re-read after
 * the result — a row is never flipped locally.
 */

const PRF = new Uint8Array(32).map((_, i) => i + 1)
const RP_ID = "midacontext.xyz"
const NS_ID = namespaceId("preferences.communication")
const NONCE = "0123456789abcdef"
const SURVIVOR_A: Hex = `0x${"77".repeat(32)}`
const SURVIVOR_B: Hex = `0x${"88".repeat(32)}`
// readLive on the page but refused by the chain's own hasAuthority recheck — the stale row case.
const STALE: Hex = `0x${"99".repeat(32)}`
const NONREADER: Hex = `0x${"aa".repeat(32)}`
const CAP_ID: Hex = `0x${"55".repeat(32)}`

const DEPLOYMENT: Deployment = {
  chainId: CHAIN_ID,
  capabilityRegistry: REGISTRY,
  contextRegistry: "0x9999999999999999999999999999999999999999",
  deploymentBlock: 0n,
  policyHashV1: POLICY_HASH_V1,
  vaultRpId: RP_ID,
  vaultRpIdHash: `0x${"aa".repeat(32)}`,
}

const passkey = makeKeyPair()
const passkeyPoint = { qx: BigInt(hexOf(passkey.x)), qy: BigInt(hexOf(passkey.y)) }

function ownerOf(prf: Uint8Array): Address {
  return ownerAccount(deriveOwnerSecrets(prf.slice())).address.toLowerCase() as Address
}
const OWNER = ownerOf(PRF)

function epochKey(nsId: Hex, epoch: bigint, prf: Uint8Array = PRF): Hex {
  const secrets = deriveOwnerSecrets(prf.slice())
  const node = namespaceById(nsId)
  const nsSecret = deriveNamespaceSecret(fakePrfOutput(secrets.ownerSeed, node.domain), node.id)
  return hexOf(deriveEpochKeyPair(nsSecret, epoch).publicKey)
}

// --- fakes — the same shapes flows.test.ts drives --------------------------------------------

function fakeCredentials(key: ReturnType<typeof makeKeyPair>, prfOutput: Uint8Array) {
  const calls: { kind: "create" | "get"; challenge?: Uint8Array }[] = []
  const rawId = new TextEncoder().encode("owner-credential")
  const prf = prfOutput
  const toBuf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const container: CredentialsContainerLike = {
    async create() {
      calls.push({ kind: "create" })
      throw new Error("revoke never creates a credential")
    },
    async get(options) {
      const request = options!.publicKey as { challenge: Uint8Array }
      calls.push({ kind: "get", challenge: request.challenge })
      const assertion = makeAssertion(key.privateKey, { challenge: request.challenge, rpId: RP_ID })
      return {
        type: "public-key",
        rawId,
        response: {
          authenticatorData: toBuf(assertion.authenticatorData),
          clientDataJSON: toBuf(assertion.clientDataJSON),
          signature: toBuf(assertion.signatureDer),
        },
        getClientExtensionResults: () => ({ prf: { results: { first: prf } } }),
      }
    },
  }
  return { container, calls }
}

interface SendRecord {
  functionName: string
  kind: TxKind
}

/** Captured readContract args for the reads that matter to the assertions below. */
interface ChainReads {
  active: unknown[][]
  authority: unknown[][]
}

function fakeChain(handlers: Record<string, (args: readonly unknown[]) => unknown> = {}) {
  const calls: string[] = []
  const defaults: Record<string, (args: readonly unknown[]) => unknown> = {
    getAgent: () => agentRecordFor(manifestBody()),
    agentEpoch: () => 0n,
    grantNonce: () => 0n,
    hasAuthority: () => false,
    requiredReadEpoch: () => 1n,
    isWriteEpochValid: () => true,
    ownerP256Key: () => [passkeyPoint.qx, passkeyPoint.qy],
    activeCapabilityIds: () => [],
    isCapabilityValid: () => true,
    epochPublicKey: (args) => epochKey(args[1] as Hex, args[2] as bigint),
    ...handlers,
  }
  const publicClient = {
    async readContract(input: { functionName: string; args: readonly unknown[] }) {
      calls.push(`read:${input.functionName}`)
      const handler = defaults[input.functionName]
      if (handler === undefined) throw new Error(`no fake for ${input.functionName}`)
      return handler(input.args)
    },
    async simulateContract(input: { functionName: string }) {
      calls.push(`simulate:${input.functionName}`)
      return { request: {} }
    },
    async estimateContractGas() {
      return 100_000n
    },
    async getBlock() {
      return { timestamp: NOW }
    },
    async getBlockNumber() {
      return 100n
    },
    async getLogs() {
      return []
    },
  }
  return { publicClient: publicClient as never, calls }
}

function fakeSponsor(sends: SendRecord[]) {
  return {
    async send(call: { functionName: string }, kind: TxKind) {
      sends.push({ functionName: call.functionName, kind })
      return {
        transactionHash: `0x${"bb".repeat(32)}` as Hex,
        gasUsed: 100n,
        gasLimit: 200_000n,
        userOpHash: `0x${"cc".repeat(32)}` as Hex,
        logs: [],
      } as unknown as SponsoredReceipt
    },
  }
}

/** The fields the assertions read off the wire wrap — the object itself is the full signed shape. */
interface WrapRecord {
  agentId: Hex
  namespaceId: Hex
  /** uint64 on the wire — a decimal string, not a bigint. */
  readEpoch: string
}

function fakeApi(calls: string[], wraps: WrapRecord[], failFor: Set<Hex> = new Set()) {
  return {
    async publishEpochWrap(wrap: WrapRecord) {
      calls.push("api:publishEpochWrap")
      if (failFor.has(wrap.agentId)) throw new Error("store write refused")
      wraps.push(wrap)
      return { stored: true }
    },
    async requestRevocationDeny() {
      calls.push("api:requestRevocationDeny")
      return { intentId: `0x${"dd".repeat(32)}` as Hex }
    },
    async listRevocations() {
      calls.push("api:listRevocations")
      return []
    },
    async reissueRevocationNonce(intentId: Hex) {
      calls.push(`api:reissueRevocationNonce:${intentId.slice(2, 6)}`)
      return { intentId, state: "active", cancellationNonce: "7" }
    },
    async cancelRevocation(intentId: Hex) {
      calls.push(`api:cancelRevocation:${intentId.slice(2, 6)}`)
      return {}
    },
  }
}

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  }
}

function makeEnv(opts: {
  sends: SendRecord[]
  apiCalls: string[]
  wraps: WrapRecord[]
  chain?: ReturnType<typeof fakeChain>
  sponsor?: { send: (call: { functionName: string }, kind: TxKind) => Promise<SponsoredReceipt> }
  releasedSecrets?: OwnerSecrets[]
  wrapFailsFor?: Set<Hex>
}): { env: FlowEnvironment; credentials: ReturnType<typeof fakeCredentials> } {
  const credentials = fakeCredentials(passkey, PRF.slice())
  const chain = opts.chain ?? fakeChain()
  const sponsor = opts.sponsor ?? fakeSponsor(opts.sends)
  const store = fakeStorage()
  const env: FlowEnvironment = {
    credentials: credentials.container,
    publicClient: chain.publicClient,
    deployment: DEPLOYMENT,
    storeUrl: "https://store.test",
    storage: store.storage,
    makeSponsor: () => sponsor,
    makeApi: () => fakeApi(opts.apiCalls, opts.wraps, opts.wrapFailsFor) as never,
    fetchManifest: async () => {
      throw new Error("revoke never fetches a manifest")
    },
    onSecrets: (s) => opts.releasedSecrets?.push(s),
  }
  return { env, credentials }
}

/**
 * One live READ grant on NS_ID for the revoked agent; two survivors keep READ on chain (the
 * post-send hasAuthority check), and the chain's own recheck refuses everyone else — the
 * request's reader list names every agent the page knows, whatever its rows claimed.
 */
function revokeChain(
  sends: SendRecord[],
  reads?: ChainReads,
  liveReaders: readonly Hex[] = [SURVIVOR_A, SURVIVOR_B],
  /** agents whose hasAuthority read fails outright — one dead RPC read must not stop the rest. */
  unreadableReaders: readonly Hex[] = [],
) {
  return fakeChain({
    activeCapabilityIds: (args) => {
      reads?.active.push([...args])
      return [CAP_ID]
    },
    // after the rotate send lands, the required read epoch is 2 — wraps publish for epochs 1 and 2
    requiredReadEpoch: () => (sends.some((s) => s.functionName === "revokeAgentAndRotate") ? 2n : 1n),
    getCapability: () => ({
      owner: OWNER,
      agentId: AGENT_ID,
      namespaceId: NS_ID,
      permissions: PERMISSION.READ,
      provenancePolicy: 0,
      issuedAt: 1n,
      expiresAt: NOW + 86_400n,
      agentEpoch: 0n,
      grantedAtReadEpoch: 1n,
      revoked: false,
    }),
    hasAuthority: (args) => {
      reads?.authority.push([...args])
      if (unreadableReaders.includes(args[1] as Hex)) throw new Error("RPC refused the read")
      return liveReaders.includes(args[1] as Hex)
    },
    epochPublicKey: (args) => epochKey(args[1] as Hex, args[2] as bigint),
  })
}

// --- /me rows and a mount for the page-wiring tests --------------------------------------------

function agentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: AGENT_ID,
    name: "codex",
    grants: [],
    revokedTx: null,
    blockedAtStore: false,
    readLive: true,
    ...over,
  }
}

function meData(over: Partial<MeData> = {}): MeData {
  return {
    owner: OWNER,
    agents: [agentRow()],
    records: [],
    incomplete: [],
    agentsUnavailable: false,
    source: "index",
    lag: { text: "9 s behind Monad", stale: false },
    batchingOn: true,
    batchedListComplete: true,
    counts: null,
    ...over,
  }
}

// A minimal DOM faithful to the small surface the page uses — the convention every render test
// in this package keeps (me-page.test.ts, entries-signing.test.ts).
class FakeEl {
  readonly tag: string
  children: FakeEl[] = []
  parent: FakeEl | null = null
  readonly attrs = new Map<string, string>()
  readonly listeners = new Map<string, (() => void)[]>()
  hidden = false
  disabled = false
  #text = ""

  constructor(tag: string) {
    this.tag = tag
  }

  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join("")
  }
  set textContent(value: string) {
    this.#text = value
    this.children = []
  }

  get className(): string {
    return this.attrs.get("class") ?? ""
  }
  set className(value: string) {
    this.attrs.set("class", value)
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  appendChild(child: FakeEl): FakeEl {
    child.parent = this
    this.children.push(child)
    return child
  }
  replaceChildren(...nodes: FakeEl[]): void {
    for (const node of nodes) node.parent = this
    this.children = [...nodes]
  }
  remove(): void {
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this)
      if (index !== -1) this.parent.children.splice(index, 1)
      this.parent = null
    }
    this.children = []
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn()
  }

  matches(sel: string): boolean {
    const parts = sel.match(/[a-zA-Z][\w-]*|\.[\w-]+|\[[^\]]*\]/g) ?? []
    for (const part of parts) {
      if (part.startsWith(".")) {
        if (!(this.attrs.get("class") ?? "").split(/\s+/).includes(part.slice(1))) return false
      } else if (part.startsWith("[")) {
        const inner = part.slice(1, -1)
        const eq = inner.indexOf("=")
        if (eq === -1) {
          if (!this.attrs.has(inner)) return false
        } else {
          const name = inner.slice(0, eq).trim()
          const value = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
          if (this.attrs.get(name) !== value) return false
        }
      } else if (this.tag !== part.toLowerCase()) {
        return false
      }
    }
    return parts.length > 0
  }

  *walk(): Generator<FakeEl> {
    for (const child of this.children) {
      yield child
      yield* child.walk()
    }
  }
  querySelectorAll(sel: string): FakeEl[] {
    return [...this.walk()].filter((el) => el.matches(sel))
  }
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null
  }
}

function fakeDoc(): Document {
  return { createElement: (tag: string) => new FakeEl(tag) } as unknown as Document
}

// --- the flow ----------------------------------------------------------------------------------

describe("revokeFromMe", () => {
  it("builds the request from the signed-in owner — never a row value — with every other live reader", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const reads: ChainReads = { active: [], authority: [] }
    const releasedSecrets: OwnerSecrets[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends, reads), releasedSecrets })
    const agents = [
      agentRow({ agentId: AGENT_ID }),
      agentRow({ agentId: SURVIVOR_A }),
      agentRow({ agentId: SURVIVOR_B }),
      agentRow({ agentId: NONREADER, readLive: false }),
    ]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    expect(result.status).toBe("success")
    // requestHash is sha256 of the exact normalized request bytes — rebuilding the request the
    // protocol helper would produce pins chainId, owner, agentId AND the reader list at once:
    // a different owner, agent, or readers array cannot produce this hash.
    const expected = buildOwnerLink({
      origin: "https://me.test",
      flow: "revoke",
      req: {
        chainId: Number(CHAIN_ID),
        owner: OWNER,
        agentId: AGENT_ID,
        readers: readersAfterRevoke(agents, AGENT_ID),
      },
      nonce: NONCE,
    })
    expect(result.requestHash).toBe(expected.requestHash)
    // the chain reads ran against the signed-in owner and the clicked row's agent — the request
    // carries no other identity (prepareRevoke and approveRevocation both read this pair)
    expect(reads.active).toEqual([
      [OWNER, AGENT_ID],
      [OWNER, AGENT_ID],
    ])
    expect(result.owner).toBe(OWNER)
    expect(result.nonce).toMatch(/^[0-9a-f]{16}$/)
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"])
    expect(releasedSecrets[0]?.released).toBe(true)
  })

  it("re-keys every surviving READ agent on the rotated area — never the revoked agent or one without READ", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const reads: ChainReads = { active: [], authority: [] }
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends, reads) })
    const agents = [
      agentRow({ agentId: AGENT_ID }),
      agentRow({ agentId: SURVIVOR_A }),
      agentRow({ agentId: SURVIVOR_B }),
      agentRow({ agentId: NONREADER, readLive: false }),
      agentRow({ agentId: STALE }),
    ]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    expect(result.status).toBe("success")
    expect(sends.map((s) => s.functionName)).toEqual(["revokeAgentAndRotate"])
    // the store deny lands before the chain send — the pending state exists before Monad answers
    expect(apiCalls[0]).toBe("api:requestRevocationDeny")
    // the reader list the flow worked was every other agent the page knows — each re-checked
    // against the chain (the flow's check, then publishReaderWraps' own). NONREADER and STALE
    // are offered to the chain even though the page marked them unreadable/unverifiable; the
    // chain's answer is what keeps their wraps unpublished.
    expect(reads.authority.map((a) => a[1])).toEqual([SURVIVOR_A, SURVIVOR_A, SURVIVOR_B, SURVIVOR_B, NONREADER, STALE])
    for (const args of reads.authority) expect(args.slice(2)).toEqual([NS_ID, PERMISSION.READ, 0])
    // publishReaderWraps ran once per surviving reader for the one rotated area, publishing a
    // wrap for every registered epoch; the stale row the chain refused got nothing, and the
    // revoked agent got nothing.
    expect(wraps.map((w) => ({ agentId: w.agentId, namespaceId: w.namespaceId, readEpoch: w.readEpoch }))).toEqual([
      { agentId: SURVIVOR_A, namespaceId: NS_ID, readEpoch: "1" },
      { agentId: SURVIVOR_A, namespaceId: NS_ID, readEpoch: "2" },
      { agentId: SURVIVOR_B, namespaceId: NS_ID, readEpoch: "1" },
      { agentId: SURVIVOR_B, namespaceId: NS_ID, readEpoch: "2" },
    ])
    expect(wraps.some((w) => w.agentId === AGENT_ID)).toBe(false)
    expect(wraps.some((w) => w.agentId === NONREADER)).toBe(false)
    expect(wraps.some((w) => w.agentId === STALE)).toBe(false)
  })

  it("a request with no entries completes without a project-list signature", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends) })
    const result = await revokeFromMe(env, {
      signedInOwner: OWNER,
      agentId: AGENT_ID,
      agents: [agentRow({ agentId: AGENT_ID }), agentRow({ agentId: SURVIVOR_A })],
    })
    expect(result.status).toBe("success")
    expect(result.entry).toBeUndefined()
    expect(sends.map((s) => s.functionName)).toEqual(["revokeAgentAndRotate"])
  })

  it("a pending sponsor answers status pending with the operation hash — the deny stays staged", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
      },
    }
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends), sponsor })
    const result = await revokeFromMe(env, {
      signedInOwner: OWNER,
      agentId: AGENT_ID,
      agents: [agentRow({ agentId: AGENT_ID }), agentRow({ agentId: SURVIVOR_A })],
    })
    expect(result.status).toBe("pending")
    expect(result.operations).toContain(`0x${"ee".repeat(32)}`)
    // the deny was posted before the send and is NOT undone for a pending operation — it is the
    // pending state the page will read back.
    expect(apiCalls).toEqual(["api:requestRevocationDeny"])
    expect(sends).toHaveLength(0)
  })
})

// --- the panel and the click -------------------------------------------------------------------

describe("/me revoke panel", () => {
  it("the confirm panel carries the exact disclosure sentence", () => {
    const root = renderMe(meData({ agents: [agentRow({ name: "codex" })] }), fakeDoc()) as unknown as FakeEl
    const panel = root.querySelector("[data-confirm-panel]")
    expect(panel).not.toBeNull()
    expect(panel!.hidden).toBe(true) // closed until the row's own Revoke is clicked
    const disclosure = panel!.querySelector("[data-revoke-disclosure]")
    expect(disclosure).not.toBeNull()
    expect(disclosure!.textContent).toBe(
      "This stops future reads through Mida. It does not erase what codex already read.",
    )
  })

  it("Revoke opens the panel; Confirm runs the flow; a pending result re-reads as blocked at the store", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
      },
    }
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends), sponsor })
    const doc = fakeDoc()
    const mount = new FakeEl("div")
    let agents = [
      agentRow({ agentId: AGENT_ID, name: "codex" }),
      agentRow({ agentId: SURVIVOR_A, name: "claude-code" }),
    ]
    let seen: FlowResult | undefined
    let reloads = 0
    // reload stands in for loadMe: a pending send leaves the store deny staged, so the re-read
    // reports the row blocked at the store — exactly what loadMe would produce.
    const render = (): void => {
      const root = renderMe(meData({ agents }), doc) as unknown as FakeEl
      mount.replaceChildren(root)
      wireRevokePanels(root as unknown as HTMLElement, doc, agents, {
        run: (agent, progress) =>
          revokeFromMe({ ...env, progress }, { signedInOwner: OWNER, agentId: agent.agentId, agents }).then((r) => {
            seen = r
            return r
          }),
        reload: () => {
          reloads += 1
          agents = [
            agentRow({ agentId: AGENT_ID, name: "codex", readLive: false, blockedAtStore: true }),
            agentRow({ agentId: SURVIVOR_A, name: "claude-code" }),
          ]
          render()
        },
      })
    }
    render()
    const revoke = mount
      .querySelectorAll("[data-revoke-agent]")
      .find((b) => b.getAttribute("data-revoke-agent") === AGENT_ID)
    expect(revoke).not.toBeNull()
    revoke!.click()
    const panel = mount.querySelector("[data-confirm-panel]")
    expect(panel!.hidden).toBe(false)
    const confirm = panel!.querySelector("[data-revoke-confirm]")
    expect(confirm).not.toBeNull()
    confirm!.click()
    await vi.waitFor(() => {
      expect(mount.textContent).toContain(BLOCKED_AT_STORE_TEXT)
    })
    expect(seen?.status).toBe("pending")
    expect(reloads).toBe(1)
    // the row is re-read, not flipped locally: the first agent's row now shows the store block
    const row = mount.querySelectorAll(".agent")[0]!
    expect(row.textContent).toContain(BLOCKED_AT_STORE_TEXT)
    expect(row.textContent).not.toContain("Can read")
    expect(apiCalls).toEqual(["api:requestRevocationDeny"])
  })

  it("a refused sponsor leaves the row able to read and the panel shows the reason", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorDidNotPay("quota exhausted")
      },
    }
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends), sponsor })
    const doc = fakeDoc()
    const mount = new FakeEl("div")
    const agents = [agentRow({ agentId: AGENT_ID, name: "codex" })]
    let seen: FlowResult | undefined
    let reloads = 0
    const root = renderMe(meData({ agents }), doc) as unknown as FakeEl
    mount.replaceChildren(root)
    wireRevokePanels(root as unknown as HTMLElement, doc, agents, {
      run: (agent, progress) =>
        revokeFromMe({ ...env, progress }, { signedInOwner: OWNER, agentId: agent.agentId, agents }).then((r) => {
          seen = r
          return r
        }),
      reload: () => {
        reloads += 1
      },
    })
    mount.querySelector("[data-revoke-agent]")!.click()
    mount.querySelector("[data-revoke-confirm]")!.click()
    await vi.waitFor(() => {
      expect(seen).not.toBeUndefined()
      expect(seen!.status).toBe("failed")
    })
    expect(reloads).toBe(0) // nothing landed — the page does not re-read as if it had
    // the panel carries the reason and the row still reads "Can read"
    const status = mount.querySelector("[data-revoke-status]")
    expect(status!.hidden).toBe(false)
    expect(status!.textContent).toContain("quota exhausted")
    expect(mount.querySelector(".agent")!.textContent).toContain("Can read")
  })
})

// --- F3: surviving readers, partial wrap failures, the repair action, tx-bearing reload ------

describe("F3 — surviving agents always get the new key", () => {
  const UNVERIFIED: Hex = `0x${"66".repeat(32)}`

  function grantRow(over: Partial<AgentRow["grants"][number]> = {}): AgentRow["grants"][number] {
    return {
      namespaceId: NS_ID,
      area: "preferences.communication",
      permissions: PERMISSION.READ,
      capabilityId: CAP_ID,
      status: { label: "Can read", flagged: false },
      approvedTx: null,
      ...over,
    }
  }

  it("a row the page could not verify is still offered to the chain — and re-wrapped when the chain says READ", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends, undefined, [UNVERIFIED]) })
    const agents = [
      agentRow({ agentId: AGENT_ID }),
      // the page could not check this one — readLive false, no verdict — and yet it is a live
      // reader on chain, so it must receive the rotated key or the revoke silently locks it out
      agentRow({ agentId: UNVERIFIED, readLive: false }),
    ]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    expect(result.status).toBe("success")
    expect(wraps.some((w) => w.agentId === UNVERIFIED)).toBe(true)
    expect(result.rewrapFailed).toEqual([])
  })

  it("one reader's publish failing never stops the rest — the failure is named on the result", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const { env } = makeEnv({
      sends,
      apiCalls,
      wraps,
      chain: revokeChain(sends),
      wrapFailsFor: new Set<Hex>([SURVIVOR_A]),
    })
    const agents = [agentRow({ agentId: AGENT_ID }), agentRow({ agentId: SURVIVOR_A }), agentRow({ agentId: SURVIVOR_B })]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    // the revoke landed and the flow completed — a wrap failure is reported, not fatal
    expect(result.status).toBe("success")
    expect(sends.map((s) => s.functionName)).toEqual(["revokeAgentAndRotate"])
    // SURVIVOR_B was still processed after SURVIVOR_A's publish threw
    expect(wraps.map((w) => w.agentId)).toEqual([SURVIVOR_B, SURVIVOR_B])
    expect(result.rewrapFailed).toHaveLength(1)
    expect(result.rewrapFailed[0]!.agentId).toBe(SURVIVOR_A)
    expect(result.rewrapFailed[0]!.namespaceId).toBe(NS_ID)
    expect(result.rewrapFailed[0]!.reason).toContain("store write refused")
  })

  it("a pending revoke offers the repair action — running it re-wraps the survivors", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
      },
    }
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends), sponsor })
    const doc = fakeDoc()
    const mount = new FakeEl("div")
    const agents = [
      agentRow({ agentId: AGENT_ID, name: "codex", grants: [grantRow()] }),
      agentRow({ agentId: SURVIVOR_A, name: "claude-code", grants: [grantRow({ capabilityId: `0x${"56".repeat(32)}` as Hex })] }),
    ]
    // the same contract the boot path keeps: repairOffered survives the reload, the repair
    // callback re-reads the world, and the epochs the revoke was built against gate the action
    let repairOffered = false
    let repairEpochs: { namespaceId: Hex; epoch: bigint }[] = []
    const render = (): void => {
      const root = renderMe(meData({ agents }), doc) as unknown as FakeEl
      mount.replaceChildren(root)
      wireRevokePanels(root as unknown as HTMLElement, doc, agents, {
        run: async (agent, progress) => {
          const result = await revokeFromMe({ ...env, progress }, { signedInOwner: OWNER, agentId: agent.agentId, agents })
          if (result.status === "pending" || result.rewrapFailed.length > 0) {
            repairOffered = true
            repairEpochs = result.epochsAtRevoke
          }
          return result
        },
        reload: () => {
          render()
        },
        repair: !repairOffered
          ? undefined
          : (progress) =>
              repairReaderWrapsFromMe({ ...env, progress }, { signedInOwner: OWNER, agents, epochsAtRevoke: repairEpochs }),
      })
    }
    render()
    expect(mount.querySelector("[data-repair-wraps]")).toBeNull() // nothing offered before a revoke
    mount.querySelector("[data-revoke-agent]")!.click()
    mount.querySelector("[data-revoke-confirm]")!.click()
    await vi.waitFor(() => {
      expect(mount.querySelector("[data-repair-wraps]")).not.toBeNull()
    })
    // clicking while the chain still reports the pre-rotation epoch is refused in words — the
    // repair never opens a ceremony on the old key
    mount.querySelector("[data-repair-run]")!.click()
    await vi.waitFor(() => {
      expect(mount.textContent).toContain("Waiting for the revoke to land on Monad")
    })
    expect(wraps).toHaveLength(0)
    // the pending transaction lands — the chain's required epoch moves, and the next click runs
    sends.push({ functionName: "revokeAgentAndRotate", kind: "revoke.agent" })
    mount.querySelector("[data-repair-run]")!.click()
    await vi.waitFor(() => {
      // the survivor got the NEW epoch's wrap; the revoked agent was skipped by the chain's
      // own hasAuthority check
      expect(wraps.some((w) => w.agentId === SURVIVOR_A && w.namespaceId === NS_ID && w.readEpoch === "2")).toBe(true)
    })
    expect(wraps.some((w) => w.agentId === AGENT_ID)).toBe(false)
    // a clean run retires the action
    await vi.waitFor(() => {
      expect(mount.querySelector("[data-repair-wraps]")!.hidden).toBe(true)
    })
  })

  it("a revoke result carrying a transaction — even a failed one — re-reads the page", async () => {
    const doc = fakeDoc()
    const mount = new FakeEl("div")
    const agents = [agentRow({ agentId: AGENT_ID, name: "codex" })]
    const root = renderMe(meData({ agents }), doc) as unknown as FakeEl
    mount.replaceChildren(root)
    let reloads = 0
    wireRevokePanels(root as unknown as HTMLElement, doc, agents, {
      run: async () =>
        ({
          v: 1,
          status: "failed",
          nonce: NONCE,
          requestHash: `0x${"ab".repeat(32)}` as Hex,
          owner: OWNER,
          transactions: [`0x${"bb".repeat(32)}` as Hex],
          operations: [],
          reason: "the send landed; a later step failed",
        }) satisfies FlowResult,
      reload: () => {
        reloads += 1
      },
    })
    mount.querySelector("[data-revoke-agent]")!.click()
    mount.querySelector("[data-revoke-confirm]")!.click()
    await vi.waitFor(() => {
      expect(reloads).toBe(1)
    })
  })
})

// --- H1: a revoke without a complete agent list would rotate the key for nobody ---------------

describe("H1 — no revoke or repair without the complete agent list", () => {
  it("refuses to rotate when the click-time reload could not list agents", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends) })
    // the fresh load failed to enumerate — an empty list is not "no readers"
    await expect(
      revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents: [], agentsUnavailable: true }),
    ).rejects.toThrow("Revoke needs the full agent list — the index and chain scan are unavailable; try again shortly")
    expect(credentials.calls).toHaveLength(0)
    expect(sends).toHaveLength(0)
    expect(apiCalls).toHaveLength(0)
  })

  it("an empty list with no flag still refuses — the clicked agent cannot be missing from a true list", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env } = makeEnv({ sends, apiCalls, wraps: [], chain: revokeChain(sends) })
    await expect(
      revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents: [] }),
    ).rejects.toThrow("Revoke needs the full agent list")
    expect(sends).toHaveLength(0)
  })

  it("repair with zero known agents refuses — it never claims to reach 'every surviving agent'", async () => {
    const wraps: WrapRecord[] = []
    const { env, credentials } = makeEnv({ sends: [], apiCalls: [], wraps })
    await expect(
      repairReaderWrapsFromMe(env, { signedInOwner: OWNER, agents: [], agentsUnavailable: true }),
    ).rejects.toThrow("Revoke needs the full agent list")
    expect(credentials.calls).toHaveLength(0)
    expect(wraps).toHaveLength(0)
  })
})

// --- H2: repair is allowed only once the chain reports the rotation it is fixing --------------

describe("H2 — repair waits for the rotation to land", () => {
  function grantRow(over: Partial<AgentRow["grants"][number]> = {}): AgentRow["grants"][number] {
    return {
      namespaceId: NS_ID,
      area: "preferences.communication",
      permissions: PERMISSION.READ,
      capabilityId: CAP_ID,
      status: { label: "Can read", flagged: false },
      approvedTx: null,
      ...over,
    }
  }

  it("the revoke result carries the read epoch it was built against, per rotated area", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends) })
    const result = await revokeFromMe(env, {
      signedInOwner: OWNER,
      agentId: AGENT_ID,
      agents: [agentRow({ agentId: AGENT_ID, grants: [grantRow()] }), agentRow({ agentId: SURVIVOR_A, grants: [grantRow()] })],
    })
    expect(result.status).toBe("success")
    // the snapshot is the chain's word at build time — repair waits for strictly higher
    expect(result.epochsAtRevoke).toEqual([{ namespaceId: NS_ID, epoch: 1n }])
  })

  it("a repair during the pending window refuses — no ceremony, no old-epoch wraps", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
      },
    }
    // the sponsor never recorded the send, so the fake chain still reports epoch 1 — the
    // pending window exactly as Monad would answer it.
    const { env, credentials } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends), sponsor })
    const agents = [agentRow({ agentId: AGENT_ID, grants: [grantRow()] }), agentRow({ agentId: SURVIVOR_A, grants: [grantRow()] })]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    expect(result.status).toBe("pending")
    await expect(
      repairReaderWrapsFromMe(env, { signedInOwner: OWNER, agents, epochsAtRevoke: result.epochsAtRevoke }),
    ).rejects.toThrow("Waiting for the revoke to land on Monad")
    // one passkey prompt total — the revoke's; the refused repair never opened a ceremony and
    // never re-sent an epoch-1 wrap
    expect(credentials.calls).toHaveLength(1)
    expect(wraps).toHaveLength(0)
  })

  it("once the chain reports the newer epoch the same repair publishes wraps for it", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
      },
    }
    const { env } = makeEnv({ sends, apiCalls, wraps, chain: revokeChain(sends), sponsor })
    const agents = [agentRow({ agentId: AGENT_ID, grants: [grantRow()] }), agentRow({ agentId: SURVIVOR_A, grants: [grantRow()] })]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    expect(result.status).toBe("pending")
    // the pending transaction lands — the chain's required epoch moves to 2
    sends.push({ functionName: "revokeAgentAndRotate", kind: "revoke.agent" })
    const outcome = await repairReaderWrapsFromMe(env, {
      signedInOwner: OWNER,
      agents,
      epochsAtRevoke: result.epochsAtRevoke,
    })
    expect(outcome.failed).toHaveLength(0)
    expect(outcome.rewrapped).toEqual([SURVIVOR_A])
    // the wrap the survivor actually needed — the post-rotation epoch — was published
    expect(wraps.some((w) => w.agentId === SURVIVOR_A && w.readEpoch === "2")).toBe(true)
  })
})

// --- H3: one dead chain read never silences the other readers ---------------------------------

describe("H3 — a failed read for one reader is recorded, the rest still re-keyed", () => {
  it("a reader whose authority check throws lands on rewrapFailed and the loop reaches the rest", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const reads: ChainReads = { active: [], authority: [] }
    // SURVIVOR_A's hasAuthority read dies on the wire; SURVIVOR_B still answers live.
    const chain = revokeChain(sends, reads, [SURVIVOR_B], [SURVIVOR_A])
    const { env } = makeEnv({ sends, apiCalls, wraps, chain })
    const agents = [
      agentRow({ agentId: AGENT_ID }),
      agentRow({ agentId: SURVIVOR_A }),
      agentRow({ agentId: SURVIVOR_B }),
    ]
    const result = await revokeFromMe(env, { signedInOwner: OWNER, agentId: AGENT_ID, agents })
    // the revoke itself landed — a dead read on one reader is that reader's failure, not the flow's
    expect(result.status).toBe("success")
    expect(result.rewrapFailed).toHaveLength(1)
    expect(result.rewrapFailed[0]!.agentId).toBe(SURVIVOR_A)
    expect(result.rewrapFailed[0]!.namespaceId).toBe(NS_ID)
    expect(result.rewrapFailed[0]!.reason).toContain("RPC refused")
    expect(wraps.some((w) => w.agentId === SURVIVOR_B && w.readEpoch === "2")).toBe(true)
    expect(wraps.some((w) => w.agentId === SURVIVOR_A)).toBe(false)
  })

  it("repair is offered for ANY non-success result that sent a transaction — not only pending", () => {
    const tx = `0x${"bb".repeat(32)}` as Hex
    const make = (over: Partial<MeRevokeResult>): MeRevokeResult => ({
      v: 1,
      status: "success",
      nonce: NONCE,
      requestHash: `0x${"ab".repeat(32)}` as Hex,
      owner: OWNER,
      transactions: [],
      operations: [],
      rewrapFailed: [],
      epochsAtRevoke: [],
      ...over,
    })
    // the send landed and a later step failed — Monad changed; the page must offer the fix
    expect(shouldOfferRepair(make({ status: "failed", transactions: [tx] }))).toBe(true)
    expect(shouldOfferRepair(make({ status: "pending", operations: [`0x${"ee".repeat(32)}` as Hex] }))).toBe(true)
    expect(shouldOfferRepair(make({ status: "success", rewrapFailed: [{ agentId: SURVIVOR_A, namespaceId: NS_ID, reason: "x" }] }))).toBe(true)
    // nothing sent and nothing failed — there is nothing to repair
    expect(shouldOfferRepair(make({ status: "failed" }))).toBe(false)
    expect(shouldOfferRepair(make({ status: "cancelled" }))).toBe(false)
    expect(shouldOfferRepair(make({}))).toBe(false)
  })
})

// --- H4: repair's reader set is filtered, not chain-trusted -----------------------------------

describe("H4 — repair never re-keys the revoked agent or a store-blocked one", () => {
  function grantRow(over: Partial<AgentRow["grants"][number]> = {}): AgentRow["grants"][number] {
    return {
      namespaceId: NS_ID,
      area: "preferences.communication",
      permissions: PERMISSION.READ,
      capabilityId: CAP_ID,
      status: { label: "Can read", flagged: false },
      approvedTx: null,
      ...over,
    }
  }

  it("the revoked agent and a store-blocked row get no wrap even while the chain still says READ", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const wraps: WrapRecord[] = []
    const reads: ChainReads = { active: [], authority: [] }
    // The window where the chain's answer cannot be trusted: the revoke has landed (epoch
    // moved to 2) but this read replica still reports the revoked agent holding READ — and a
    // store-blocked row looks equally readable. Neither must be offered a wrap.
    const chain = revokeChain(sends, reads, [AGENT_ID, SURVIVOR_A, STALE])
    sends.push({ functionName: "revokeAgentAndRotate", kind: "revoke.agent" })
    const { env } = makeEnv({ sends, apiCalls, wraps, chain })
    const agents = [
      agentRow({ agentId: AGENT_ID, grants: [grantRow()] }),
      agentRow({ agentId: SURVIVOR_A, grants: [grantRow()] }),
      agentRow({ agentId: STALE, grants: [grantRow()], blockedAtStore: true }),
    ]
    const outcome = await repairReaderWrapsFromMe(env, {
      signedInOwner: OWNER,
      agents,
      epochsAtRevoke: [{ namespaceId: NS_ID, epoch: 1n }],
      excludeAgentIds: [AGENT_ID],
    })
    expect(outcome.rewrapped).toEqual([SURVIVOR_A])
    expect(wraps.some((w) => w.agentId === AGENT_ID)).toBe(false)
    expect(wraps.some((w) => w.agentId === STALE)).toBe(false)
    expect(wraps.some((w) => w.agentId === SURVIVOR_A && w.readEpoch === "2")).toBe(true)
    // the excluded ids were never even asked about — exclusion is by list, not by chain verdict
    expect(reads.authority.map((a) => a[1])).toEqual([SURVIVOR_A, SURVIVOR_A])
  })
})
