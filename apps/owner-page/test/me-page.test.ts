import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { renderMe } from "../src/me/page.js"
import type { AgentRow, MeData, RecordRow } from "../src/me/sources.js"
import { BLOCKED_AT_STORE_TEXT, PARTIAL_LIST_TEXT } from "../src/me/sources.js"

/**
 * Task 5's page tests. The plan prescribes a jsdom environment pragma, but jsdom is not a
 * devDependency and its tarball tree is not installable in this environment — so this file uses
 * the repo's existing fake-element convention (entries-signing.test.ts), extended just enough to
 * cover the render path: textContent with real DOM semantics (set replaces children, get folds
 * the subtree), class/attribute matching, and click dispatch for the pager. The unsafe-API guard
 * below reads every file under src/me/ and is the XSS backstop the fake DOM cannot be.
 */

// --- a minimal DOM faithful to the small surface renderMe uses -------------------------------

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

  // Faithful textContent: setting replaces children with the string; reading folds the subtree.
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
    // Compound selector only: tag, .cls, [attr], [attr="v"] in any combination (no combinators).
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

function all(root: FakeEl, sel: string): FakeEl[] {
  return root.querySelectorAll(sel)
}

// --- fixtures ---------------------------------------------------------------------------------

const OWNER = `0x${"aa".repeat(20)}` as Address
const AGENT = `0x${"11".repeat(32)}` as Hex
const CAP = `0x${"44".repeat(32)}` as Hex
const NS = namespaceId("projects.current")
const TX = `0x${"7a".repeat(32)}` as Hex
const CTX = `0x${"cc".repeat(32)}` as Hex

type Grant = AgentRow["grants"][number]

function grant(over: Partial<Grant> = {}): Grant {
  return {
    namespaceId: NS,
    area: "projects.current",
    permissions: 1 | 2 | 4,
    capabilityId: CAP,
    status: { label: "Can read", flagged: false },
    approvedTx: TX,
    ...over,
  }
}

function agent(over: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: AGENT,
    name: "claude-code",
    grants: [grant()],
    revokedTx: null,
    blockedAtStore: false,
    readLive: true,
    ...over,
  }
}

function record(over: Partial<RecordRow> = {}): RecordRow {
  return {
    contextId: CTX,
    namespaceId: NS,
    area: "projects.current",
    readEpoch: 1n,
    lane: "direct",
    state: "anchored",
    authorId: AGENT,
    authorName: "claude-code",
    source: 3,
    tx: TX,
    batchId: null,
    ciphertext: "0x12",
    manifest: {},
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

function data(over: Partial<MeData> = {}): MeData {
  return {
    owner: OWNER,
    agents: [agent()],
    records: [record()],
    incomplete: [],
    agentsUnavailable: false,
    source: "index",
    lag: { text: "9 s behind Monad", stale: false },
    batchingOn: true,
    counts: { records: 31, youSaid: 9, pending: 2 },
    ...over,
  }
}

const openText = (text: string, provenanceSource: number | null = null) => () => ({ ok: true as const, text, provenanceSource })

// --- the render contract ----------------------------------------------------------------------

describe("renderMe", () => {
  it("an agent named like an attack renders as literal text and creates no element", () => {
    const evil = '<img src=x onerror=alert(1)>'
    const root = renderMe(data({ agents: [agent({ name: evil })] }), fakeDoc()) as unknown as FakeEl
    const name = root.querySelector(".agent-name")
    expect(name).not.toBeNull()
    expect(name!.textContent).toBe(evil)
    expect(all(root, "img")).toHaveLength(0)
    expect(all(root, "script")).toHaveLength(0)
  })

  it("a record body that is markup renders literally, never as elements", () => {
    const root = renderMe(data(), fakeDoc(), openText("<b>x</b> <i>y</i>")) as unknown as FakeEl
    const cell = root.querySelector(".rec-what")
    expect(cell).not.toBeNull()
    expect(cell!.textContent).toBe("<b>x</b> <i>y</i>")
    expect(all(root, "b")).toHaveLength(0)
    expect(all(root, "i")).toHaveLength(0)
    // the decrypted cell is marked so a hidden-too-long/pagehide teardown can wipe it
    expect(cell!.getAttribute("data-decrypted")).toBe("1")
  })

  it("a tx value that is not a 32-byte hash renders no link; a real hash links", () => {
    // every tx field in this fixture is malformed — no <a> may exist anywhere
    const bad = data({
      agents: [agent({ grants: [grant({ approvedTx: "not-a-hash" as Hex })], revokedTx: "also-not" as Hex })],
      records: [record({ tx: "0xZZZ-not-a-hash" as Hex })],
    })
    const rootBad = renderMe(bad, fakeDoc()) as unknown as FakeEl
    expect(all(rootBad, "a")).toHaveLength(0)

    const ok = renderMe(data(), fakeDoc()) as unknown as FakeEl
    const links = all(ok, "a.tx")
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute("href")!.endsWith(TX)).toBe(true)
      expect(link.getAttribute("target")).toBe("_blank")
      expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    }
  })

  it("an incomplete list shows the banner and hides the index counts", () => {
    const root = renderMe(
      data({ incomplete: [PARTIAL_LIST_TEXT], counts: null }),
      fakeDoc(),
    ) as unknown as FakeEl
    const banners = all(root, ".me-banner")
    expect(banners.length).toBe(1)
    expect(banners[0]!.textContent).toBe(PARTIAL_LIST_TEXT)
    // the counts the index would have supplied are absent — no tile may carry a figure
    expect(all(root, "[data-count]")).toHaveLength(0)
  })

  it("complete data shows the three count tiles with their figures", () => {
    const root = renderMe(data(), fakeDoc()) as unknown as FakeEl
    const tiles = all(root, "[data-count]")
    expect(tiles).toHaveLength(3)
    const texts = tiles.map((t) => t.textContent)
    expect(texts.some((t) => t.includes("31"))).toBe(true)
    expect(texts.some((t) => t.includes("9"))).toBe(true)
    expect(texts.some((t) => t.includes("2"))).toBe(true)
  })

  it("a store-denied agent reads 'blocked at the store · revoke pending on Monad'", () => {
    const root = renderMe(
      data({ agents: [agent({ blockedAtStore: true, readLive: false })] }),
      fakeDoc(),
    ) as unknown as FakeEl
    const row = root.querySelector(".agent")
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain(BLOCKED_AT_STORE_TEXT)
    // and it must never be described as able to read
    expect(row!.textContent).not.toContain("Can read")
  })

  it("a failed agent load reads 'Agent list unavailable' — never '0 agents' or 'none granted'", () => {
    const root = renderMe(
      data({ agents: [], agentsUnavailable: true, counts: null }),
      fakeDoc(),
    ) as unknown as FakeEl
    const unavailable = "Agent list unavailable — the index is down and the chain scan did not finish"
    // once on the summary tile in place of the count, once where the list would be
    const hits = all(root, ".agent-meta").concat(all(root, ".n")).filter((el) => el.textContent.includes(unavailable))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(root.textContent).not.toContain("0 agents can read")
    expect(root.textContent).not.toContain("No agents have been granted access")
  })

  it("a flagged grant names the listing that spoke — the index, or in chain-log mode the grant log, never the index", () => {
    const flagged = agent({ readLive: false, grants: [grant({ status: { label: "Revoked", flagged: true } })] })
    const fromIndex = renderMe(data({ agents: [flagged] }), fakeDoc()) as unknown as FakeEl
    expect(fromIndex.querySelector(".grant-status")!.textContent).toBe("Revoked — the index disagrees with the chain")

    const fromLogs = renderMe(
      data({ source: "chain-logs", lag: { text: "index unavailable", stale: true }, agents: [flagged] }),
      fakeDoc(),
    ) as unknown as FakeEl
    const status = fromLogs.querySelector(".grant-status")
    expect(status).not.toBeNull()
    expect(status!.textContent).toBe("Revoked — the grant log disagrees with the chain")
    expect(status!.textContent).not.toContain("index")
  })

  it("provenance badges only ever ride on anchored rows — unverified and pending read Source unknown", () => {
    const rows = [
      record({ state: "unverified", source: 1, contextId: `0x${"d1".repeat(32)}` as Hex }),
      record({ lane: "batched", state: "pending", source: 3, contextId: `0x${"d2".repeat(32)}` as Hex }),
      record({ state: "unknown", source: 2, contextId: `0x${"d3".repeat(32)}` as Hex }),
    ]
    const root = renderMe(data({ records: rows }), fakeDoc()) as unknown as FakeEl
    expect(root.textContent).not.toContain("You said")
    expect(root.textContent).not.toContain("inferred")
    expect(all(root, ".badge").filter((b) => b.textContent === "Source unknown")).toHaveLength(3)
  })

  it("a decrypted payload whose provenance label disagrees with the chain is flagged on the row", () => {
    // chain says USER_ASSERTED (1); the bytes inside claim AGENT_INFERRED (3)
    const flagged = renderMe(
      data({ records: [record({ state: "anchored", source: 1 })] }),
      fakeDoc(),
      openText("body", 3),
    ) as unknown as FakeEl
    expect(flagged.textContent).toContain("the record's own label disagrees with Monad")

    // agreement flags nothing, and neither does a row the chain never confirmed — Monad has not
    // spoken for it, so there is nothing to disagree with
    const agreed = renderMe(data({ records: [record({ state: "anchored", source: 3 })] }), fakeDoc(), openText("body", 3)) as unknown as FakeEl
    expect(agreed.textContent).not.toContain("disagrees with Monad")
    const unchecked = renderMe(data({ records: [record({ state: "unverified", source: 1 })] }), fakeDoc(), openText("body", 3)) as unknown as FakeEl
    expect(unchecked.textContent).not.toContain("disagrees with Monad")
  })

  it("a row whose chain check could not run says 'could not check Monad just now' — never 'not on Monad'", () => {
    const root = renderMe(data({ records: [record({ state: "unknown" })] }), fakeDoc()) as unknown as FakeEl
    expect(root.textContent).toContain("could not check Monad just now")
    expect(root.textContent).not.toContain("not on Monad")
  })

  it("shows the newest 20 records and pages the rest with 'Show 20 more'", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      record({ contextId: `0x${String(i).padStart(2, "0")}${"cc".repeat(31)}` as Hex, createdAt: 1_700_000_000_000 + i }),
    )
    const root = renderMe(data({ records: many }), fakeDoc(), openText("body")) as unknown as FakeEl
    expect(all(root, "[data-row]")).toHaveLength(20)
    const more = all(root, "[data-more]")
    expect(more).toHaveLength(1)
    more[0]!.click()
    expect(all(root, "[data-row]")).toHaveLength(25)
    expect(all(root, "[data-more]")).toHaveLength(0) // no more pages
  })
})

// --- the source-level guard: no markup-writing API under src/me/ -------------------------------

describe("src/me rendering guard", () => {
  it("no file under src/me/ writes markup — textContent only", () => {
    const meDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "me")
    const files = readdirSync(meDir).filter((name) => name.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    const banned = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/
    for (const file of files) {
      const source = readFileSync(join(meDir, file), "utf8")
      expect(source, `${file} must render with textContent only`).not.toMatch(banned)
    }
  })
})
