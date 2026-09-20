import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, Runtime, revoke } from "@mida/midad"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-revoke-guard-")))

describe("revoke's agent-id resolution", () => {
  it("a permission error reading the local files propagates — it is never mistaken for a missing file", async () => {
    const home = freshHome()
    // A loader that throws EACCES stands in for a file the process is not allowed to read. If revoke
    // swallowed it the way it swallows a missing file, the wrong agent could be revoked silently.
    home.readJson = (() => {
      throw Object.assign(new Error("read denied"), { code: "EACCES" })
    }) as MidaHome["readJson"]
    await expect(revoke({ home } as Runtime, "anyname")).rejects.toMatchObject({ code: "EACCES" })
  })
})
