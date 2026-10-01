import { describe, expect, it } from "vitest"
import { provenanceBadge } from "../src/me/model.js"

describe("provenanceBadge", () => {
  it("only owner-written sources say You said", () => {
    expect(provenanceBadge({ source: 1, authorName: "claude-code", lane: "direct", state: "anchored" })).toEqual({ kind: "you", text: "You said" })
    expect(provenanceBadge({ source: 2, authorName: "x", lane: "direct", state: "anchored" }).kind).toBe("you")
    expect(provenanceBadge({ source: 3, authorName: "codex", lane: "direct", state: "anchored" })).toEqual({ kind: "agent", text: "codex inferred" })
  })
  it("only an anchored row carries provenance — pending, unverified and unknown all read Source unknown", () => {
    // A pending batched save's own claim, an unverified row, and a row whose chain check failed
    // are equally unable to prove who said what.
    for (const state of ["pending", "unverified", "unknown"] as const) {
      expect(provenanceBadge({ source: 3, authorName: "codex", lane: "batched", state })).toEqual({ kind: "unknown", text: "Source unknown" })
      expect(provenanceBadge({ source: 1, authorName: "claude-code", lane: "direct", state })).toEqual({ kind: "unknown", text: "Source unknown" })
    }
  })
  it("anything else is unknown, never You said", () => {
    expect(provenanceBadge({ source: 4, authorName: "codex", lane: "direct", state: "anchored" }).kind).toBe("unknown")
    expect(provenanceBadge({ source: null, authorName: "codex", lane: "direct", state: "anchored" }).kind).toBe("unknown")
  })
})
