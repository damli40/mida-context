import { describe, expect, it } from "vitest"
import { chipsFor, grantStatus, isTxHash, lagText, provenanceBadge, readersAfterRevoke } from "../src/me/model.js"

describe("chipsFor", () => {
  it("maps contract bits to the three chips and the rare fourth", () => {
    expect(chipsFor(1 | 2 | 4)).toEqual({ read: true, write: true, updateOwn: true, updateAny: false })
    expect(chipsFor(1)).toEqual({ read: true, write: false, updateOwn: false, updateAny: false })
    expect(chipsFor(8).updateAny).toBe(true)
  })
})
describe("provenanceBadge", () => {
  it("only owner-written sources say You said", () => {
    expect(provenanceBadge({ source: 1, authorName: "claude-code", lane: "direct", state: "anchored" })).toEqual({ kind: "you", text: "You said" })
    expect(provenanceBadge({ source: 2, authorName: "x", lane: "direct", state: "anchored" }).kind).toBe("you")
    expect(provenanceBadge({ source: 3, authorName: "codex", lane: "direct", state: "anchored" })).toEqual({ kind: "agent", text: "codex inferred" })
  })
  it("a pending batched save is only a claim", () => {
    expect(provenanceBadge({ source: 3, authorName: "codex", lane: "batched", state: "pending" })).toEqual({ kind: "claimed", text: "codex claimed" })
  })
  it("anything else is unknown, never You said", () => {
    expect(provenanceBadge({ source: 4, authorName: "codex", lane: "direct", state: "anchored" }).kind).toBe("unknown")
    expect(provenanceBadge({ source: null, authorName: "codex", lane: "direct", state: "anchored" }).kind).toBe("unknown")
  })
})
describe("isTxHash", () => {
  it("accepts only 32-byte lowercase hex", () => {
    expect(isTxHash("0x" + "a".repeat(64))).toBe(true)
    expect(isTxHash("0x" + "A".repeat(64))).toBe(false)
    expect(isTxHash("javascript:alert(1)")).toBe(false)
    expect(isTxHash("0x" + "a".repeat(63))).toBe(false)
  })
})
describe("lagText", () => {
  it("reads the index's block lag as seconds (~0.4 s/block) and flags > 150 blocks", () => {
    expect(lagText(23)).toEqual({ text: "≈ 9 s behind Monad", stale: false })
    expect(lagText(200).stale).toBe(true)
    expect(lagText(150).stale).toBe(false)
    expect(lagText(null)).toEqual({ text: "index unavailable", stale: true })
  })
})
describe("readersAfterRevoke", () => {
  it("every other agent the page knows — even unverified ones; the chain re-checks READ", () => {
    const a = ("0x" + "1".repeat(64)) as `0x${string}`, b = ("0x" + "2".repeat(64)) as `0x${string}`, c = ("0x" + "3".repeat(64)) as `0x${string}`
    // c is whatever non-live state — Unverified, blocked at the store — and must still be
    // offered to the chain: a live reader skipped here keeps only dead wraps after the rotate.
    expect(readersAfterRevoke([{ agentId: a }, { agentId: b }, { agentId: c }], a)).toEqual([b, c])
  })
})
describe("grantStatus", () => {
  it("the chain wins over the index", () => {
    expect(grantStatus({ indexSaysLive: true, chainSaysValid: true })).toEqual({ label: "Can read", flagged: false })
    expect(grantStatus({ indexSaysLive: true, chainSaysValid: false })).toEqual({ label: "Expired or revoked on Monad", flagged: true })
    expect(grantStatus({ indexSaysLive: false, chainSaysValid: false })).toEqual({ label: "Revoked", flagged: false })
    expect(grantStatus({ indexSaysLive: true, chainSaysValid: null })).toEqual({ label: "Unverified", flagged: true })
  })
})
