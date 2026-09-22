import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PERMISSION, PROVENANCE_POLICY } from "@mida/protocol"
import { connectAgent } from "@mida/sdk"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, Runtime, approve, init, revoke } from "@mida/midad"
import type { Network } from "@mida/midad"

const STEP_TIMEOUT = 60_000

/**
 * The installable SDK's front door against the CLI's provisioning: `mida init` makes the home,
 * `connectAgent` loads it, the SDK files a request, `mida approve` completes it, the agent reads
 * and writes, `mida revoke` shuts it off. If the on-disk formats ever drift apart this fails.
 */
describe("SDK connectAgent ↔ mida approve interop on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let homePath: string
  let runtime: Runtime
  const step = (name: string, fn: () => Promise<void>) => it(name, fn, STEP_TIMEOUT)

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    homePath = mkdtempSync(join(tmpdir(), "mida-connect-e2e-"))
    runtime = await Runtime.open(new MidaHome(homePath), network)
    // The daemon writes this when it comes up; the owner-runtime path does not. Writing it here
    // simulates the live-daemon state an installed SDK consumer finds.
    writeFileSync(join(homePath, "api-url.json"), JSON.stringify({ baseUrl: runtime.apiBaseUrl }))
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  step("1. init provisions sdk-agent into a home connectAgent can load", async () => {
    await init(runtime, ["sdk-agent"])
    const conn = connectAgent({ name: "sdk-agent", midaHome: homePath, env: {} })
    expect(conn.owner.toLowerCase()).toBe(runtime.owner.toLowerCase())
  })

  step("2. the SDK files the request; `mida approve` finds it through the shared on-disk formats", async () => {
    const conn = connectAgent({ name: "sdk-agent", midaHome: homePath, env: {} })
    const request = await conn.requestAccess({
      purposeId: "project_assistance",
      scopes: [
        {
          namespace: "projects.current",
          permissions: PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN,
          provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE,
        },
        { namespace: "profile.skills", permissions: PERMISSION.READ },
      ],
    })
    expect(request.requestId).toMatch(/^0x[0-9a-f]{64}$/)
    const approval = await approve(runtime, "sdk-agent")
    expect(approval.capabilityIds.length).toBeGreaterThan(0)
  })

  step("3. a fresh connect sees the grant and can write and read back", async () => {
    const conn = connectAgent({ name: "sdk-agent", midaHome: homePath, env: {} })
    const written = await conn.agent.create(conn.owner, "projects.current", {
      value: { note: "written through the packaged SDK" },
      kind: "EPISODE",
      source: "AGENT_INFERRED",
    })
    const objects = await conn.agent.read(conn.owner, "projects.current")
    expect(objects.map((object) => object.contextId)).toContain(written.contextId)
  })

  step("4. `mida revoke` cuts the agent off: reads and writes refuse", async () => {
    await revoke(runtime, "sdk-agent")
    const conn = connectAgent({ name: "sdk-agent", midaHome: homePath, env: {} })
    await expect(conn.agent.read(conn.owner, "projects.current")).rejects.toMatchObject({
      code: expect.stringMatching(/^(CAPABILITY_DENIED|CAPABILITY_REVOKED|NOT_FOUND)$/),
    })
    await expect(
      conn.agent.create(conn.owner, "projects.current", { value: "x", kind: "EPISODE", source: "AGENT_INFERRED" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(CAPABILITY_DENIED|CAPABILITY_REVOKED|NOT_FOUND)$/) })
  })
})
