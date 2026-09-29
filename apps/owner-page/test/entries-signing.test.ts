import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CHAIN_ID } from "../../../packages/grant-advisor/test/fixtures.js"
import { signableProjectRows } from "../src/owner/flows.js"
import { showEntriesToSign, showListReSigned } from "../src/owner/page.js"
import type { LinkRequest } from "../src/owner/link.js"

/**
 * Review fix 4: the approve signature covers every row in the link's project list plus the new
 * row — and until now the page showed none of them, so a crafted link could get rows signed the
 * owner never saw. These tests run the real renderer against a minimal DOM stand-in and check
 * that what the DOM lists is exactly what the signature will cover.
 */

interface FakeElement {
  tag: string
  className: string
  textContent: string
  children: FakeElement[]
  appendChild(child: FakeElement): void
  replaceChildren(...nodes: FakeElement[]): void
}

function fakeEl(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    className: "",
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

function collectText(el: FakeElement): string {
  return [el.textContent, ...el.children.map(collectText)].join("\n")
}

function collectTags(el: FakeElement, tag: string): FakeElement[] {
  return [...el.children.flatMap((c) => collectTags(c, tag)), ...(el.tag === tag ? [el] : [])]
}

const ROW_1 = { agent: `0x${"11".repeat(32)}`, projectId: "11111111-2222-3333-4444-555555555555", root: `0x${"a1".repeat(32)}`, approvedAt: "2026-09-01T00:00:00.000Z" }
const ROW_2 = { agent: `0x${"22".repeat(32)}`, projectId: "66666666-7777-8888-9999-000000000000", root: `0x${"b2".repeat(32)}`, approvedAt: "2026-09-10T00:00:00.000Z" }
const REPLACED = { agent: `0x${"33".repeat(32)}`, projectId: "abababab-abab-abab-abab-abababababab", root: `0x${"c3".repeat(32)}`, approvedAt: "2026-08-01T00:00:00.000Z" }
const NEW_ENTRY = { agent: REPLACED.agent, projectId: REPLACED.projectId, root: REPLACED.root }

function req(): LinkRequest {
  return {
    chainId: Number(CHAIN_ID),
    project: { id: NEW_ENTRY.projectId, label: "mida-context" },
    entry: NEW_ENTRY,
    entries: [ROW_1, ROW_2, REPLACED],
  }
}

describe("showEntriesToSign", () => {
  let saved: unknown
  beforeEach(() => {
    saved = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = { createElement: (tag: string) => fakeEl(tag) }
  })
  afterEach(() => {
    ;(globalThis as { document?: unknown }).document = saved
  })

  it("lists every row the signature covers — the new row plus each kept existing row", () => {
    const rows = signableProjectRows(req())
    expect(rows).not.toBeNull()
    // The link carried a stale row for this (agent, projectId, root) — it is replaced, not re-signed.
    expect(rows!.existing).toEqual([ROW_1, ROW_2])
    const mount = fakeEl("section")
    showEntriesToSign(mount as never, { added: rows!.added, existing: rows!.existing, projectLabel: "mida-context" })

    const text = collectText(mount)
    // New row: project label + id prefix.
    expect(text).toContain("mida-context")
    expect(text).toContain(NEW_ENTRY.projectId.slice(0, 10))
    // Count of existing rows being re-signed.
    expect(text).toContain("2")
    // Every covered row is listed — each existing row's projectId appears, and the agent's name
    // appears in full inside quotes (in-30 T-2, NIT 4): a cut-down id is no name at all.
    for (const row of rows!.existing) {
      expect(text).toContain(row.projectId)
      expect(text).toContain(`agent "${row.agent}"`)
      expect(text).toContain(row.root.slice(0, 10))
    }
    // The expandable fold: one <details>, one <li> per covered existing row.
    expect(collectTags(mount, "details")).toHaveLength(1)
    expect(collectTags(mount, "li")).toHaveLength(rows!.existing.length)
  })

  it("no stale row sneaks back in — the replaced row is not listed as an existing row", () => {
    const rows = signableProjectRows(req())
    const mount = fakeEl("section")
    showEntriesToSign(mount as never, { added: rows!.added, existing: rows!.existing })
    const listItems = collectTags(mount, "li")
    // REPLACED shares the new row's key triple — it must appear only as the new row, never in the list.
    expect(listItems).toHaveLength(2)
    expect(listItems.map((li) => li.textContent)).not.toContain(REPLACED.projectId)
  })

  it("a first approval re-signs zero existing rows", () => {
    const rows = signableProjectRows({ chainId: Number(CHAIN_ID), entry: NEW_ENTRY })
    const mount = fakeEl("section")
    showEntriesToSign(mount as never, { added: rows!.added, existing: rows!.existing })
    expect(collectText(mount)).toContain("0")
    expect(collectTags(mount, "li")).toHaveLength(0)
  })

  it("the new row puts its id first and the link's label last — a label's early ” can only trail (in-33)", () => {
    // A `”` inside the label closes the curly quotes before the id, so the old row
    // (`“label” — id real`) let a label forge `— id fake` ahead of the real one. Id first:
    // whatever the label carries sits after the value the signature binds.
    const rows = signableProjectRows(req())
    const mount = fakeEl("section")
    showEntriesToSign(mount as never, { added: rows!.added, existing: rows!.existing, projectLabel: `x” — id deadbeef00` })
    const added = collectTags(mount, "p")[1]!
    expect(added.textContent).toBe(`id ${NEW_ENTRY.projectId.slice(0, 10)}… — “x” — id deadbeef00”`)
    expect(added.textContent.indexOf("id abababab")).toBeLessThan(added.textContent.indexOf("deadbeef00"))
  })

  it("existing rows put agent and root first and the link's projectId last (in-33)", () => {
    // The projectId is unquoted and unshortened — `p — agent "x" — root /y` reads as a benign
    // row with the real fields trailing. Moved last, a forged row sits after the real fields.
    const forged = { ...ROW_1, projectId: `p — agent "claude-code" — root /srv/ok` }
    const rows = signableProjectRows({ ...req(), entries: [forged, ROW_2, REPLACED] })
    const mount = fakeEl("section")
    showEntriesToSign(mount as never, { added: rows!.added, existing: rows!.existing })
    const items = collectTags(mount, "li")
    expect(items[0]!.textContent).toBe(`agent "${forged.agent}" — root ${short10(forged.root)} — id ${forged.projectId}`)
    expect(items[1]!.textContent).toBe(`agent "${ROW_2.agent}" — root ${short10(ROW_2.root)} — id ${ROW_2.projectId}`)
  })
})

/** The same 10-char shortening page.ts applies to ids and roots on the sign rows. */
function short10(value: string): string {
  return value.length > 10 ? `${value.slice(0, 10)}…` : value
}

describe("showListReSigned (the revoke-page fold)", () => {
  let saved: unknown
  beforeEach(() => {
    saved = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = { createElement: (tag: string) => fakeEl(tag) }
  })
  afterEach(() => {
    ;(globalThis as { document?: unknown }).document = saved
  })

  it("quotes the agent's own name in full on every row it keeps — same rule as approve (in-30 T-2, NIT 4)", () => {
    const mount = fakeEl("section")
    showListReSigned(mount as never, [ROW_1, ROW_2])
    const text = collectText(mount)
    for (const row of [ROW_1, ROW_2]) {
      expect(text).toContain(`agent "${row.agent}"`)
      expect(text).not.toContain(`${row.agent.slice(0, 10)}…`)
    }
  })
})
