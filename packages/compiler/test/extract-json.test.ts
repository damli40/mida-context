// Cases for extractJsonObject — the port of capture-worker.mjs's tolerant
// "first parseable top-level object" scanner. Named by the Task 4 plan:
// bare object, prose around it, code fence, braces inside strings, escaped
// quotes, no object → undefined.

import { describe, expect, it } from "vitest"
import { extractJsonObject } from "../src/index.js"

describe("extractJsonObject", () => {
  it("parses a bare object", () => {
    expect(extractJsonObject('{"objective":"x","n":1}')).toEqual({ objective: "x", n: 1 })
  })

  it("finds the object inside surrounding prose", () => {
    expect(extractJsonObject('Here you go: {"a":1} — hope that helps.')).toEqual({ a: 1 })
  })

  it("finds the object inside a code fence", () => {
    expect(extractJsonObject('Extracted:\n```json\n{"a":1,"b":[2]}\n```\nDone.')).toEqual({ a: 1, b: [2] })
  })

  it("ignores braces inside strings", () => {
    expect(extractJsonObject('{"a":"}{"}')).toEqual({ a: "}{" })
  })

  it("handles escaped quotes inside strings", () => {
    expect(extractJsonObject('{"a":"\\"}"}')).toEqual({ a: '"}' })
  })

  it("returns undefined when there is no object", () => {
    expect(extractJsonObject("not json at all")).toBeUndefined()
    expect(extractJsonObject("[1,2,3]")).toBeUndefined()
    expect(extractJsonObject('{"a":')).toBeUndefined()
  })
})
