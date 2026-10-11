import { describe, expect, it } from "vitest"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome } from "@mida/midad"
import { loadBlockTimes, saveBlockTimes } from "../src/block-times.js"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-block-times-")))

describe("state/block-times.json — CHAIN-04 (Oct 5): block times survive a restart", () => {
  it("round-trips the map for the same chain", () => {
    const home = freshHome()
    saveBlockTimes(home, 10143n, new Map([[5n, 1_700_000_005n], [6n, 1_700_000_006n]]))
    expect(loadBlockTimes(home, 10143n)).toEqual(new Map([[5n, 1_700_000_005n], [6n, 1_700_000_006n]]))
  })

  it("ignores a file written for another chain", () => {
    const home = freshHome()
    saveBlockTimes(home, 31337n, new Map([[5n, 99n]]))
    expect(loadBlockTimes(home, 10143n).size).toBe(0)
  })

  it("reads a missing or corrupt file as empty and never throws", () => {
    const home = freshHome()
    expect(loadBlockTimes(home, 10143n).size).toBe(0)
    home.writeSecretFile("state/block-times.json", "{not json")
    expect(loadBlockTimes(home, 10143n).size).toBe(0)
  })

  it("keeps only entries that are plain non-negative integers", () => {
    const home = freshHome()
    home.writeSecretJson("state/block-times.json", { chainId: "10143", blocks: { "5": "100", x: "1", "6": 7, "7": "-1", "8": "1e3" } })
    expect([...loadBlockTimes(home, 10143n)]).toEqual([[5n, 100n]])
  })

  it.skipIf(process.platform === "win32")("is written owner-only, like every state file", () => {
    const home = freshHome()
    saveBlockTimes(home, 10143n, new Map([[5n, 100n]]))
    expect(statSync(home.path("state/block-times.json")).mode & 0o777).toBe(0o600)
  })
})
