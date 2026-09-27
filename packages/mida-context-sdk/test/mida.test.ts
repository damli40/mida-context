import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Mida, MidaSdkError } from "../src/index.js"

const home = () => mkdtempSync(join(tmpdir(), "mida-sdk-test-"))

describe("Mida construction", () => {
  it("defaults to the local transport and exposes the seven calls", () => {
    const mida = new Mida({ agent: "my-agent", home: home() })
    for (const method of ["context", "remember", "requestAccess", "verify", "handoff", "whatsNew", "status"] as const) {
      expect(typeof mida[method], method).toBe("function")
    }
  })

  it("accepts transport \"local\" explicitly", () => {
    const mida = new Mida({ agent: "my-agent", transport: "local", home: home() })
    expect(typeof mida.context).toBe("function")
  })

  it("refuses transport \"direct\" — it arrives with Sign in with Mida (phase 2)", () => {
    let thrown: unknown
    try {
      new Mida({ agent: "my-agent", transport: "direct", home: home() })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MidaSdkError)
    expect((thrown as MidaSdkError).code).toBe("transport-unavailable")
    expect((thrown as MidaSdkError).message).toContain("direct transport arrives with Sign in with Mida")
  })

  it("refuses an unknown transport with invalid-option", () => {
    let thrown: unknown
    try {
      // @ts-expect-error — a transport outside the union is exactly what this tests
      new Mida({ agent: "my-agent", transport: "carrier-pigeon", home: home() })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MidaSdkError)
    expect((thrown as MidaSdkError).code).toBe("invalid-option")
  })

  it("refuses a bad agent name with invalid-option", () => {
    expect(() => new Mida({ agent: "../escape", home: home() })).toThrowError(MidaSdkError)
    expect(() => new Mida({ agent: "", home: home() })).toThrowError(MidaSdkError)
    try {
      new Mida({ agent: "../escape", home: home() })
      expect.unreachable()
    } catch (error) {
      expect((error as MidaSdkError).code).toBe("invalid-option")
    }
  })
})
