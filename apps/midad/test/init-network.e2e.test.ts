// Plan A Task 2, check E6: `init` never rewrites network.json. A setup's contract is bound the
// first time init writes it — re-running init on the same home leaves the file byte-identical,
// and a file that names a different contract than this run resolves is a `deployment-mismatch`
// refusal before any chain call, never a silent move (the Sep 22 incident: a re-init moved an
// old home to the new contract and its data dropped out of view).

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, Runtime, init } from "@mida/midad"

const STEP_TIMEOUT = 60_000

describe("init never rewrites network.json (E6)", () => {
  let env: ScenarioEnvironment
  beforeAll(async () => {
    env = await localEnvironment()
  }, 600_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("a second init leaves the file byte-identical; a file naming another contract refuses and stays untouched", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-init-network-")))
    const runtime = await Runtime.open(home, { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund })
    const file = home.path("network.json")
    try {
      await init(runtime, [])
      const first = readFileSync(file)
      expect(first.length).toBeGreaterThan(0)

      // Re-running init — the resume path — must not touch the file at all.
      await init(runtime, [])
      expect(readFileSync(file)).toEqual(first)

      // A file that now names a different contract than this run resolves: init refuses before
      // any chain call, and the refusal leaves the file exactly as it found it. The sentinels
      // make "before any chain call" testable — the first chain-touching members init would
      // reach blow up with a marker, so a refusal that arrives anyway proves the check ran first.
      const stored = JSON.parse(first.toString("utf8")) as { deployment: { capabilityRegistry: string } }
      stored.deployment.capabilityRegistry = "0x000000000000000000000000000000000000dEaD"
      writeFileSync(file, JSON.stringify(stored, null, 2))
      const touched = new Error("the chain was touched before the mismatch check")
      runtime.ensureFunded = async () => { throw touched }
      runtime.reader.ownerP256Key = async () => { throw touched }
      await expect(init(runtime, [])).rejects.toMatchObject({ code: "deployment-mismatch" })
      expect(readFileSync(file, "utf8")).toBe(JSON.stringify(stored, null, 2))
    } finally {
      await runtime.close()
    }
  }, 300_000)
})
