import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import type { PreparedRevoke } from "../src/owner/flows.js"
import { revokeSummaryLines } from "../src/owner/summary.js"
import { showError, showSummaryLines } from "../src/owner/page.js"

/**
 * The revoke summary (in-30 T-4): it must render through the same one-element-per-line
 * showSummaryLines as approve — a <pre> with a newline-joined text node does not wrap on a
 * phone, and a stray newline inside a field could mint a line of its own.
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

function prep(live: PreparedRevoke["live"]): PreparedRevoke {
  return { agentId: `0x${"44".repeat(32)}` as Hex, live }
}

function live(name: string, permissions: number): PreparedRevoke["live"][number] {
  return { capabilityId: `0x${"55".repeat(32)}` as Hex, namespaceId: namespaceId(name), namespaceName: name, permissions }
}

describe("the revoke summary lines (in-30 T-4)", () => {
  it("lists what the agent can do, one line per entry — same words as before", () => {
    const lines = revokeSummaryLines(prep([live("preferences.communication", 1), live("goals.career", 3)]))
    expect(lines).toEqual([
      "This agent can currently:",
      "• preferences.communication — read",
      "• goals.career — read and add entries",
      "Revoking ends all of this and locks the old keys out of anything it saved.",
      "It does not erase what the agent already read.",
    ])
  })

  it("an agent with nothing live gets the single line", () => {
    expect(revokeSummaryLines(prep([]))).toEqual(["The chain shows nothing live for this agent."])
  })

  it("renders one element per line through showSummaryLines — never a joined text node", () => {
    const mount = fakeEl("div")
    const lines = revokeSummaryLines(prep([live("preferences.communication", 1)]))
    withFakeDoc(() => showSummaryLines(mount as never, lines))
    expect(mount.children).toHaveLength(lines.length)
    expect(mount.children.map((c) => c.textContent)).toEqual(lines)
  })

  it("revoke.ts renders through showSummaryLines — no newline-joined textContent join", () => {
    const source = readFileSync(join(ROOT, "../src/owner/revoke.ts"), "utf8")
    expect(source).toContain("showSummaryLines(")
    expect(source).not.toMatch(/summary\.textContent\s*=\s*lines\.join/)
  })

  it("revoke.html uses a normal wrapping element for #summary, like approve — not <pre>", () => {
    const html = readFileSync(join(ROOT, "../public/revoke.html"), "utf8")
    expect(html).not.toMatch(/<pre[^>]*id="summary"/)
    expect(html).toMatch(/<div id="summary">/)
    const css = readFileSync(join(ROOT, "../public/owner.css"), "utf8")
    expect(css).toMatch(/#summary\s*\{[^}]*overflow-wrap:\s*anywhere/)
  })
})

describe("a refused request leaves only the error on the page (in-30 NIT 5)", () => {
  it("showError empties the summary mount — 'Checking the request…' does not stay up", () => {
    const summary = fakeEl("div")
    summary.textContent = "Checking the request…"
    const error = fakeEl("p")
    withFakeDoc({ summary, error }, () =>
      showError("This request contains characters Mida does not accept, so this page will not show or sign it."),
    )
    expect(summary.textContent).toBe("")
    expect(summary.children).toHaveLength(0)
    expect(error.textContent).toBe(
      "This request contains characters Mida does not accept, so this page will not show or sign it.",
    )
    expect(error.hidden).toBe(false)
  })

  it("a rendered summary survives a later error — only the placeholder clears", () => {
    const summary = fakeEl("div")
    const error = fakeEl("p")
    withFakeDoc({ summary, error }, () => {
      showSummaryLines(summary as never, ["line one", "line two"])
      showError("something failed")
    })
    expect(summary.children.map((c) => c.textContent)).toEqual(["line one", "line two"])
    expect(error.textContent).toBe("something failed")
  })
})

interface FakeElement {
  tag: string
  textContent: string
  hidden: boolean
  readonly childElementCount: number
  children: FakeElement[]
  appendChild(child: FakeElement): void
  replaceChildren(...nodes: FakeElement[]): void
}

function fakeEl(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    textContent: "",
    hidden: true,
    get childElementCount() {
      return el.children.length
    },
    children: [],
    appendChild(child) {
      el.children.push(child)
    },
    replaceChildren(...nodes) {
      el.children = [...nodes]
      el.textContent = "" // replaceChildren() empties text nodes too — the placeholder goes with them
    },
  }
  return el
}

function withFakeDoc(ids: Record<string, FakeElement> | (() => void), fn?: () => void): void {
  const byId = typeof ids === "function" ? {} : ids
  const run = typeof ids === "function" ? ids : fn!
  const saved = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => fakeEl(tag),
    getElementById: (id: string) => byId[id] ?? null,
  }
  try {
    run()
  } finally {
    ;(globalThis as { document?: unknown }).document = saved
  }
}
