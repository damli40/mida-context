import { describe, expect, it, vi } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { HIDDEN_LIMIT_MS, armTeardown, renderMe, revocableStore } from "../src/me/page.js"
import type { MeData, MePorts, RecordRow } from "../src/me/sources.js"
import { AGENTS_NOT_LISTED_TEXT, PARTIAL_LIST_TEXT, SOURCE_BADGE_TEXT } from "../src/me/sources.js"

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
const NS = namespaceId("projects.current")
const CTX = `0x${"cc".repeat(32)}` as Hex

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
    records: [record()],
    incomplete: [],
    recordsUnavailable: false,
    degraded: false,
    batchingOn: true,
    ...over,
  }
}

const openText = (text: string, provenanceSource: number | null = null) => () => ({ ok: true as const, text, provenanceSource })

// --- the render contract ----------------------------------------------------------------------

describe("renderMe", () => {
  it("a record author named like an attack renders as literal text and creates no element", () => {
    const evil = '<img src=x onerror=alert(1)>'
    const root = renderMe(data({ records: [record({ authorName: evil })] }), fakeDoc()) as unknown as FakeEl
    expect(root.textContent).toContain(evil)
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

  it("the page renders no links — it has no source for a transaction hash", () => {
    const rows = [
      record(),
      record({ lane: "batched", contextId: `0x${"d4".repeat(32)}` as Hex, batchId: `0x${"b5".repeat(32)}` as Hex }),
    ]
    const root = renderMe(data({ records: rows }), fakeDoc()) as unknown as FakeEl
    expect(all(root, "a")).toHaveLength(0)
    expect(root.textContent).toContain("direct · anchored on Monad")
    expect(root.textContent).toContain("batch · anchored on Monad")
  })

  it("an incomplete list shows the banner, and no count tile carries a figure", () => {
    const root = renderMe(data({ incomplete: [PARTIAL_LIST_TEXT] }), fakeDoc()) as unknown as FakeEl
    const banners = all(root, ".me-banner")
    expect(banners.length).toBe(1)
    expect(banners[0]!.textContent).toBe(PARTIAL_LIST_TEXT)
    expect(all(root, "[data-count]")).toHaveLength(0)
  })

  it("the agent area says the page does not list agents — never '0 agents' or 'none granted'", () => {
    const root = renderMe(data(), fakeDoc()) as unknown as FakeEl
    const unavailable = AGENTS_NOT_LISTED_TEXT
    // once on the summary tile in place of the count, once where the list would be
    const hits = all(root, ".agent-meta").concat(all(root, ".n")).filter((el) => el.textContent.includes(unavailable))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(root.textContent).not.toContain("0 agents can read")
    expect(root.textContent).not.toContain("No agents have been granted access")
  })

  it("a store that failed every listing says 'could not load records' — never 'holds no records'", () => {
    const root = renderMe(data({ records: [], recordsUnavailable: true }), fakeDoc()) as unknown as FakeEl
    expect(root.textContent).toContain("could not load records from the store")
    expect(root.textContent).not.toContain("The store holds no records")
    // and a store that answered empty stays "holds no records" — the two are not interchangeable
    const empty = renderMe(data({ records: [], recordsUnavailable: false }), fakeDoc()) as unknown as FakeEl
    expect(empty.textContent).toContain("The store holds no records")
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

  it("the badge names what the page read, on a normal dot", () => {
    const root = renderMe(data(), fakeDoc()) as unknown as FakeEl
    expect(root.textContent).toContain(SOURCE_BADGE_TEXT)
    expect(SOURCE_BADGE_TEXT).toBe("Records come from the store and are checked on Monad")
    expect(root.textContent).not.toContain("unreachable")
    expect(all(root, ".dot-stale")).toEqual([])
  })

  it("the rendered page never names an index", () => {
    const root = renderMe(data(), fakeDoc()) as unknown as FakeEl
    expect(root.textContent).not.toMatch(/\bindex/i)
    expect(root.textContent).toContain("Run mida doctor in your terminal to see the agents approved on that machine.")
    // nothing on the page offers a revoke here, so the tile carries no line about revoking
    expect(root.textContent).not.toContain("Revoking stops future reads")
  })

  it("a failed or partial read shows the warning dot beside the badge", () => {
    const root = renderMe(data({ degraded: true }), fakeDoc()) as unknown as FakeEl
    expect(all(root, ".dot-stale").length).toBe(1)
  })

  it("the sign-in screen and the loading line promise records, never an agent list", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const html = readFileSync(join(here, "../public/me.html"), "utf8")
    expect(html).toContain("Your records, and who wrote them.")
    expect(html).not.toMatch(/every agent|what it can read|Who can read your context/)
    expect(html).not.toMatch(/\bindex\b/i)
    const page = readFileSync(join(here, "../src/me/page.ts"), "utf8")
    expect(page).toContain('"Your records, and who wrote them."')
    expect(page).not.toContain("reading agents, grants")
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

// --- read-only: revoking lives in the terminal, not on this page --------------------------------

describe("/me is read-only — revoking happens in the terminal", () => {
  it("no button or link carries 'revoke', and no revoke/repair control exists anywhere", () => {
    const root = renderMe(data(), fakeDoc()) as unknown as FakeEl
    for (const node of root.walk()) {
      if (node.tag === "button" || node.tag === "a") {
        expect(node.textContent.toLowerCase(), `a <${node.tag}> must not offer revoking`).not.toContain("revoke")
      }
    }
    for (const sel of [
      "[data-revoke-agent]",
      "[data-confirm-panel]",
      "[data-revoke-cancel]",
      "[data-revoke-confirm]",
      "[data-revoke-disclosure]",
      "[data-revoke-status]",
      "[data-repair-wraps]",
      "[data-repair-run]",
    ]) {
      expect(all(root, sel), `${sel} must not be rendered`).toHaveLength(0)
    }
  })

  it("the agents section states the page is read-only, and why the terminal owns revoking", () => {
    const root = renderMe(data(), fakeDoc()) as unknown as FakeEl
    const sec = root.querySelector('[aria-labelledby="agents-title"]')
    expect(sec).not.toBeNull()
    expect(sec!.textContent).toContain(
      "This page is read-only. Revoking happens in your terminal, where your other agents get the new key.",
    )
  })
})

// --- teardown: the five-minute hidden-tab rule and sign-out cleanup -----------------------------

/**
 * The boot path's DOM surface, faked: armTeardown reads document/window globals through el(),
 * so the tests stub both. me-root carries a decrypted cell and the pager — the two things
 * sign-out must neutralise.
 */
function stubPageDom() {
  const els = new Map<string, FakeEl>()
  for (const id of ["me-root", "sign-in", "go", "sign-out"]) els.set(id, new FakeEl("div"))
  const docListeners = new Map<string, (() => void)[]>()
  const winListeners = new Map<string, (() => void)[]>()
  const doc = {
    hidden: false,
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: (type: string, fn: () => void) => docListeners.set(type, [...(docListeners.get(type) ?? []), fn]),
  }
  const win = {
    addEventListener: (type: string, fn: () => void) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
  }
  const fire = (map: Map<string, (() => void)[]>, type: string): void => {
    for (const fn of map.get(type) ?? []) fn()
  }
  return { els, doc, win, docListeners, winListeners, fire }
}

describe("teardown — the five-minute rule runs while hidden, and sign-out disarms the page", () => {
  function harness() {
    const dom = stubPageDom()
    vi.stubGlobal("document", dom.doc)
    vi.stubGlobal("window", dom.win)
    const decrypted = new FakeEl("p")
    decrypted.setAttribute("data-decrypted", "1")
    decrypted.textContent = "the secret body"
    const more = new FakeEl("button")
    more.setAttribute("data-more", "")
    const root = dom.els.get("me-root")!
    root.appendChild(decrypted)
    root.appendChild(more)
    const ended = { n: 0 }
    const dropped = { n: 0 }
    armTeardown({ end: () => void (ended.n += 1) }, () => void (dropped.n += 1))
    return { dom, decrypted, more, ended, dropped }
  }

  it("hidden for five minutes ends the session even if the tab never comes back", () => {
    vi.useFakeTimers()
    try {
      const { dom, decrypted, more, ended, dropped } = harness()
      dom.doc.hidden = true
      dom.fire(dom.docListeners, "visibilitychange")
      // still alive just under the limit, dead once it passes — no visibility return needed
      vi.advanceTimersByTime(HIDDEN_LIMIT_MS - 1000)
      expect(ended.n).toBe(0)
      vi.advanceTimersByTime(2000)
      expect(ended.n).toBe(1)
      expect(dropped.n).toBe(1)
      expect(decrypted.textContent).toBe("cleared — sign in again to read")
      expect(more.disabled).toBe(true)
      expect(dom.els.get("sign-in")!.hidden).toBe(false)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it("coming back before five minutes cancels the timer — the session survives", () => {
    vi.useFakeTimers()
    try {
      const { dom, ended } = harness()
      dom.doc.hidden = true
      dom.fire(dom.docListeners, "visibilitychange")
      vi.advanceTimersByTime(HIDDEN_LIMIT_MS - 1000)
      dom.doc.hidden = false
      dom.fire(dom.docListeners, "visibilitychange")
      vi.advanceTimersByTime(HIDDEN_LIMIT_MS + 60_000)
      expect(ended.n).toBe(0)
      // and a second hidden stretch runs the full clock again
      dom.doc.hidden = true
      dom.fire(dom.docListeners, "visibilitychange")
      vi.advanceTimersByTime(HIDDEN_LIMIT_MS + 1000)
      expect(ended.n).toBe(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it("sign-out ends immediately: keys wiped, controls dead, store signer dropped — and end is idempotent", () => {
    try {
      const { dom, decrypted, more, ended, dropped } = harness()
      dom.els.get("sign-out")!.click()
      expect(ended.n).toBe(1)
      expect(dropped.n).toBe(1)
      expect(decrypted.textContent).toBe("cleared — sign in again to read")
      expect(more.disabled).toBe(true)
      expect(dom.els.get("go")!.disabled).toBe(false)
      dom.fire(dom.winListeners, "pagehide") // a later pagehide does not end twice
      expect(ended.n).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("revocableStore — the signer dies with the session", () => {
  it("calls pass through until drop, then every method refuses", async () => {
    const calls: string[] = []
    const store = {
      listObjects: async () => {
        calls.push("listObjects")
        return { objects: [], partial: false }
      },
      listBatchSaves: async () => ({ items: [], partial: false }),
      listRevocations: async () => [],
      batchStatus: async () => ({ enabled: true, batchAnchor: `0x${"44".repeat(20)}` as Address }),
      getAgentManifest: async () => {
        throw new Error("unneeded")
      },
    }
    const { port, drop } = revocableStore(store as unknown as MePorts["store"])
    await port.listObjects({ owner: OWNER, namespaceId: NS })
    expect(calls).toEqual(["listObjects"])
    drop()
    await expect(port.listObjects({ owner: OWNER, namespaceId: NS })).rejects.toThrow(/signed out/)
    await expect(port.batchStatus()).rejects.toThrow(/signed out/)
    expect(calls).toEqual(["listObjects"]) // nothing reached the client after the drop
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
