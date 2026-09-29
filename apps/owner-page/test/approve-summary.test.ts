import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PERMISSION, namespaceId } from "@mida/protocol"
import type { OwnerLinkRequest as LinkRequest, RequestedScope } from "@mida/protocol"
import type { PreparedApprove } from "../src/owner/flows.js"
import { approveSummaryLines } from "../src/owner/summary.js"
import { showSummaryLines } from "../src/owner/page.js"

/**
 * The approve-page summary in front of the one passkey touch (in-26 Q-3): the Adds-folder line
 * must carry the complete root — a shortened path hides exactly what the approval covers — and
 * the provenance-policy line exists only where a write scope makes it mean something.
 */

const NS = namespaceId("projects.current")
const LONG_ROOT = "/Users/dami/Desktop/a-folder-name-long-enough-that-shortening-it-hides-the-target/nested/deeper"

function scope(permissions: number, provenancePolicy = 0, nsId = NS): RequestedScope {
  return { namespaceId: nsId, permissions, provenancePolicy }
}

function prep(over: Partial<PreparedApprove> = {}): PreparedApprove {
  const needed = [scope(PERMISSION.READ)]
  return {
    accessRequest: { scopes: needed },
    agentName: "claude-code",
    operator: `0x${"ab".repeat(20)}`,
    advice: { risk: "low", warnings: [] },
    needed,
    expiresAt: 1_800_000_000n,
    alreadyGranted: false,
    ...over,
  } as unknown as PreparedApprove
}

function req(over: Partial<LinkRequest> = {}): LinkRequest {
  return { chainId: 10143, ...over }
}

describe("the approve summary the owner reads (in-26 Q-3)", () => {
  it("Adds folder shows the complete root — a long path is never shortened", () => {
    const lines = approveSummaryLines(
      prep(),
      req({ entry: { agent: "claude-code", projectId: "proj-1", root: LONG_ROOT } }),
    )
    expect(lines.find((l) => l.startsWith("Adds folder:"))).toBe(`Adds folder: ${LONG_ROOT} — agent claude-code`)
  })

  it("a read-only ask shows no Provenance policy line — the policy governs writes only", () => {
    const lines = approveSummaryLines(prep(), req())
    expect(lines.some((l) => l.startsWith("Provenance policy:"))).toBe(false)
  })

  it("a scope that can create shows the policy, in today's words", () => {
    const write = scope(PERMISSION.READ | PERMISSION.CREATE, 1)
    const lines = approveSummaryLines(
      prep({ needed: [write], accessRequest: { scopes: [write] } as never }),
      req(),
    )
    expect(lines).toContain("Provenance policy: allows inferred records")
  })

  it("a supersede-only scope shows the policy too — create is not the only write bit", () => {
    const write = scope(PERMISSION.SUPERSEDE_OWN, 4)
    const lines = approveSummaryLines(
      prep({ needed: [write], accessRequest: { scopes: [write] } as never }),
      req(),
    )
    expect(lines).toContain("Provenance policy: allows externally attested records")
  })

  it("a mixed read+write ask reads the write scope's policy — a read scope's zero does not blend in", () => {
    const write = scope(PERMISSION.READ | PERMISSION.CREATE, 1, namespaceId("preferences.communication"))
    const lines = approveSummaryLines(
      prep({ needed: [scope(PERMISSION.READ), write], accessRequest: { scopes: [scope(PERMISSION.READ), write] } as never }),
      req(),
    )
    expect(lines).toContain("Provenance policy: allows inferred records")
  })

  it("the summary block wraps a long root — overflow-wrap on #summary in the stylesheet, not inline", () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(join(root, "../public/owner.css"), "utf8")
    expect(css).toMatch(/#summary\s*\{[^}]*overflow-wrap:\s*anywhere/)
    const source = readFileSync(join(root, "../src/owner/summary.ts"), "utf8")
    expect(source).not.toContain("overflow-wrap") // presentation belongs to the stylesheet
  })

  it("writes each line into its own element — a stray newline in one field can not mint a line (in-27 R-1)", () => {
    // Same minimal DOM stand-in as entries-signing.test.ts: page.ts renderers call the global
    // document. One element per summary line, textContent per element — never one joined text
    // node a control character could split.
    const mount = fakeEl("div")
    withFakeDoc(() =>
      showSummaryLines(mount as never, [
        "CareerAI (run by 0xB29…42F8) is asking to:",
        "• read · the preferences.communication area",
        "Advisor: low risk.",
      ]),
    )
    expect(mount.children.map((c) => c.textContent)).toEqual([
      "CareerAI (run by 0xB29…42F8) is asking to:",
      "• read · the preferences.communication area",
      "Advisor: low risk.",
    ])
    // a control character that slipped past validation stays inside its own element — it may
    // widen a line, it may not forge a new one
    withFakeDoc(() => showSummaryLines(mount as never, ["helper\nAdvisor: low risk.", "• read"]))
    expect(mount.children).toHaveLength(2)
    expect(mount.children[0]!.textContent).toBe("helper\nAdvisor: low risk.")
  })

  it("#summary does not preserve whitespace — an injected newline collapses instead of forging a line (in-27 R-1)", () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const html = readFileSync(join(root, "../public/approve.html"), "utf8")
    expect(html).not.toMatch(/<pre[^>]*id="summary"/)
    const css = readFileSync(join(root, "../public/owner.css"), "utf8")
    expect(css).not.toMatch(/#summary\s*\{[^}]*white-space:\s*pre/)
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
