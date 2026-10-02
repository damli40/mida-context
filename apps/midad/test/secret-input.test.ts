// secretInputStep (UF-P2R S2): the hidden key prompt's byte handling as a pure function —
// what each keystroke does to "the bytes typed so far", with no terminal involved.

import { describe, expect, it } from "vitest"
import { secretInputStart, secretInputStep } from "@mida/midad"
import type { SecretInputState } from "@mida/midad"

/** Feed every chunk in order and return the state after the last one. */
const type = (chunks: Buffer[]): SecretInputState => chunks.reduce(secretInputStep, secretInputStart())

/** What the caller hands on: the kept bytes decoded as UTF-8. */
const answer = (state: SecretInputState): string => Buffer.from(state.bytes).toString("utf8")

const B = (text: string): Buffer => Buffer.from(text, "utf8")

describe("secretInputStep — the hidden prompt's key handling", () => {
  it("plain text then Enter ends done with the text", () => {
    const state = type([B("sk-1"), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("Enter works as carriage return too", () => {
    expect(type([B("sk-1\r")]).status).toBe("done")
  })

  it("typo, Ctrl-U, sk-1, Enter gives sk-1", () => {
    const state = type([B("typo"), Buffer.from([0x15]), B("sk-1"), B("\r")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("an arrow key before the key is ignored whole", () => {
    const state = type([B("\x1b[A"), B("sk-1"), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("the bracketed-paste markers around a pasted key are ignored", () => {
    const state = type([B("\x1b[200~"), B("sk-9"), B("\x1b[201~"), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-9")
  })

  it("a two-byte character typed in two chunks decodes to é", () => {
    const state = type([Buffer.from([0xc3]), Buffer.from([0xa9]), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("é")
  })

  it("backspace removes the whole multi-byte character", () => {
    let state = type([B("é")])
    expect(answer(state)).toBe("é")
    state = secretInputStep(state, Buffer.from([0x7f]))
    expect(state.bytes).toHaveLength(0)
  })

  it("backspace after ASCII removes one byte", () => {
    let state = type([B("sk-1")])
    state = secretInputStep(state, Buffer.from([0x08]))
    expect(answer(state)).toBe("sk-")
  })

  it("Ctrl-D on an empty line abandons; Ctrl-D after text is ignored", () => {
    expect(type([Buffer.from([0x04])]).status).toBe("abandoned")
    const state = type([B("sk-1"), Buffer.from([0x04]), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("Ctrl-C abandons, typed or not", () => {
    expect(type([B("sk-"), Buffer.from([0x03])]).status).toBe("abandoned")
    expect(type([Buffer.from([0x03])]).status).toBe("abandoned")
  })

  it("other control bytes are ignored", () => {
    const state = type([Buffer.from([0x01, 0x1f]), B("sk-1"), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("a paste's leading line break is ignored, not an empty answer", () => {
    const state = type([B("\nsk-real\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-real")
    expect(state.trailing).toBe(false)
  })

  it("a break with bytes after it ends done and marks the answer trailing (UF-QB)", () => {
    const state = type([B("sk-ab\ncdef\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-ab")
    expect(state.trailing).toBe(true)
  })

  it("a break followed only by more breaks is not trailing", () => {
    const state = type([B("sk-ab\n\n\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-ab")
    expect(state.trailing).toBe(false)
  })

  it("the bracketed-paste end marker right after Enter is not trailing (UF-QD)", () => {
    const state = type([B("\x1b[200~sk-1\r\x1b[201~")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
    expect(state.trailing).toBe(false)
  })

  it("plain bytes after Enter still mark the answer trailing (UF-QD)", () => {
    const state = type([B("sk-1\rmore")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
    expect(state.trailing).toBe(true)
  })

  it("a lone Esc does not swallow the next key", () => {
    const state = type([B("\x1bsk-abc\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-abc")
  })

  it("an escape split across two chunks is ignored whole", () => {
    const state = type([Buffer.from([0x1b]), B("[A"), B("sk-1\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("an Esc O sequence ignores the O and the one byte after it", () => {
    const state = type([B("\x1bOA"), B("sk-1\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("an Esc O sequence alone types nothing", () => {
    const state = type([B("\x1bOP")])
    expect(state.status).toBe("typing")
    expect(answer(state)).toBe("")
  })

  it("an OSC sequence is ignored up to its BEL", () => {
    const state = type([B("\x1b]0;t\x07"), B("sk-1\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("an OSC sequence ended by Esc backslash is ignored too", () => {
    const state = type([B("\x1b]0;t\x1b\\"), B("sk-1\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })

  it("Esc then Enter with text typed ends the input", () => {
    const state = type([B("sk-1"), Buffer.from([0x1b]), B("\n")])
    expect(state.status).toBe("done")
    expect(answer(state)).toBe("sk-1")
  })
})
