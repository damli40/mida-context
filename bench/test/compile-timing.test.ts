// compile-timing.ts calls a real model, so nothing here may drive the model
// paths — this covers argument parsing and the key-env-unset exit only.
// NOTE: the root vitest include covers packages/*/test and apps/*/test; bench
// files are outside it, so this file is not collected by `pnpm test`.

import { describe, expect, it, vi } from "vitest"
import { main, parseArgs } from "../compile-timing.js"

describe("parseArgs", () => {
  it("parses the required flags and applies the defaults", () => {
    const r = parseArgs(["--input", "t.txt", "--key-env", "MY_KEY"])
    expect(r).toEqual({ ok: true, args: { input: "t.txt", n: 5, keyEnv: "MY_KEY", model: "haiku" } })
  })

  it("accepts --n and --model overrides", () => {
    const r = parseArgs(["--input", "t.txt", "--key-env", "K", "--n", "12", "--model", "claude-x"])
    expect(r).toEqual({ ok: true, args: { input: "t.txt", n: 12, keyEnv: "K", model: "claude-x" } })
  })

  it("refuses a missing --input and a missing --key-env", () => {
    expect(parseArgs(["--key-env", "K"]).ok).toBe(false)
    expect(parseArgs(["--input", "t.txt"]).ok).toBe(false)
  })

  it("refuses a non-integer --n", () => {
    for (const v of ["0", "abc", "2.5", "-3", "05"]) {
      expect(parseArgs(["--input", "t", "--key-env", "K", "--n", v]).ok).toBe(false)
    }
  })

  it("refuses a --key-env value that is not a variable name", () => {
    for (const v of ["1BAD", "A-B", "a b", "--input"]) {
      expect(parseArgs(["--input", "t", "--key-env", v]).ok).toBe(false)
    }
  })

  it("refuses unknown arguments and dangling flag values", () => {
    expect(parseArgs(["--input", "t", "--key-env", "K", "--bogus"]).ok).toBe(false)
    expect(parseArgs(["--input"]).ok).toBe(false)
  })
})

describe("key-env-unset", () => {
  it("exits 2 naming only the variable when the key variable is unset", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const code = await main(["--input", "does-not-exist.txt", "--key-env", "MIDA_TEST_KEY"], {} as NodeJS.ProcessEnv)
      expect(code).toBe(2)
      const written = spy.mock.calls.map((c) => String(c[0])).join("")
      expect(written).toBe("key-env-unset MIDA_TEST_KEY\n")
    } finally {
      spy.mockRestore()
    }
  })

  it("treats an empty variable as unset, and checks the key before the input file", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const code = await main(
        ["--input", "does-not-exist.txt", "--key-env", "MIDA_TEST_KEY"],
        { MIDA_TEST_KEY: "" } as NodeJS.ProcessEnv,
      )
      expect(code).toBe(2)
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("key-env-unset")
    } finally {
      spy.mockRestore()
    }
  })
})
