import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Mida, MidaSdkError, isMidaSdkError } from "../src/index.js"

/** A home with no daemon behind it — no socket file ever answers. */
const home = () => mkdtempSync(join(tmpdir(), "mida-sdk-transport-"))

describe("LocalTransport with no Mida service running", () => {
  it("status() reports the service down plainly instead of throwing", async () => {
    const mida = new Mida({ agent: "codex", home: home() })
    const answer = await mida.status()
    expect(answer.up).toBe(false)
    expect(answer.text).toContain("not answering")
    expect(answer.text).toContain("run any `mida` command to start it")
  })

  it("context() refuses service-unavailable and names the fix", async () => {
    const mida = new Mida({ agent: "codex", home: home() })
    const thrown = await mida.context({ namespace: "projects.current", limit: 10_000 }).catch((error) => error)
    expect(isMidaSdkError(thrown, "service-unavailable")).toBe(true)
    expect((thrown as MidaSdkError).message).toContain("run any `mida` command to start it")
  })

  it("remember(), handoff() and whatsNew() refuse the same way — nothing happened", async () => {
    const mida = new Mida({ agent: "codex", home: home() })
    for (const call of [
      () => mida.remember({ namespace: "projects.current", content: "x" }),
      () => mida.handoff(),
      () => mida.whatsNew(),
    ]) {
      const thrown = await call().catch((error) => error)
      expect(isMidaSdkError(thrown, "service-unavailable")).toBe(true)
      expect((thrown as MidaSdkError).message).toContain("Nothing happened")
    }
  })

  it("remember() validates before the socket — bad input never reaches a daemon", async () => {
    const mida = new Mida({ agent: "codex", home: home() })
    // these refuse even with no daemon listening — proof the SDK checks first
    for (const call of [
      () => mida.remember({ namespace: "auto", content: "x" }),
      () => mida.remember({ namespace: "no.such.area", content: "x" }),
      () => mida.remember({ namespace: "projects.current", content: "x", ...({ source: "USER_ASSERTED" } as object) }),
      () => mida.remember({ namespace: "projects.current", content: "x", supersedes: "not-hex" as never }),
      () => mida.context({ limit: 0 }),
      () => mida.context({ limit: 100, namespace: "projects.current", namespaces: ["profile.skills"] }),
    ]) {
      const thrown = await call().catch((error) => error)
      expect(thrown).toBeInstanceOf(MidaSdkError)
      expect(["invalid-option", "invalid-namespace"]).toContain((thrown as MidaSdkError).code)
    }
  })
})
