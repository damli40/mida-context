import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import type { PreparedRevoke } from "../src/owner/flows.js"
import { revokeSummaryLines } from "../src/owner/summary.js"
import { showSummaryLines } from "../src/owner/page.js"

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

interface FakeElement {
  tag: string
  textContent: string
  children: FakeElement[]
  appendChild(child: FakeElement): void
  replaceChildren(...nodes: FakeElement[]): void
}

function fakeEl(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    textContent: "",
    children: [],
    appendChild(child) {
      el.children.push(child)
    },
    replaceChildren(...nodes) {
      el.children = [...nodes]
    },
  }
  return el
}

function withFakeDoc(fn: () => void): void {
  const saved = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = { createElement: (tag: string) => fakeEl(tag) }
  try {
    fn()
  } finally {
    ;(globalThis as { document?: unknown }).document = saved
  }
}
