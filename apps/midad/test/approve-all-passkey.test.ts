import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { FileAccessRequestStore, MidaHome, runCli, saveAgentIdentity, saveOwnerMode } from "@mida/midad"
import type { AgentIdentity, CliDeps } from "@mida/midad"
import { requestHash } from "@mida/protocol"
import type { AccessRequest, Address, OwnerLinkResult } from "@mida/protocol"
import { PERMISSION } from "@mida/protocol"
import { manifestBodyHash } from "@mida/grant-advisor"
import {
  AGENT_ID,
  CHAIN_ID,
  REGISTRY,
  manifestBody,
  signManifest,
  signRequest,
  unsignedRequest,
} from "../../../packages/grant-advisor/test/fixtures.js"

/**
 * `mida approve --all` on a passkey home, end to end through runCli: the terminal prints one
 * combined list and asks one typed yes, then each agent gets its own owner-link round — the
 * passkey is asked once per signature, never once for the batch. The chain here is the real
 * local Anvil: the fake page's "success" carries no real transactions, so each agent's grant
 * proof fails and lands in `failed` — which is exactly what lets the test count page rounds.
 */

const OWNER = `0x${"ab".repeat(20)}` as Address

async function identity(name: string): Promise<AgentIdentity> {
  return {
    name,
    agentId: AGENT_ID,
    signerPrivateKey: `0x${"66".repeat(32)}`,
    encryptionPrivateKey: `0x${"77".repeat(32)}`,
    encryptionPublicKey: `0x${"88".repeat(32)}`,
    callbackOrigin: `https://${name}.mida.example`,
    purposeId: "project_assistance",
    manifest: await signManifest(manifestBody()),
    manifestHash: manifestBodyHash(manifestBody()),
  }
}

/** A pending request the store really holds — the same two files `mida request` leaves. */
async function pendingRequest(home: MidaHome, name: string): Promise<AccessRequest> {
  const request = await signRequest(unsignedRequest([{ namespace: "projects.current", permissions: PERMISSION.READ | PERMISSION.CREATE }]))
  await new FileAccessRequestStore(home, name).save(request)
  home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
  return request
}

describe("mida approve --all on a passkey home (I3)", () => {
  let env: ScenarioEnvironment

  beforeAll(async () => {
    env = await localEnvironment()
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("one terminal yes, then one page round per agent — passkey prompts never batch", async () => {
    const home = new MidaHome(join(mkdtempSync(join(tmpdir(), "mida-pkall-")), "home"))
    saveOwnerMode(home, "passkey")
    home.writeSecretJson("owner-address.json", { address: OWNER })
    for (const name of ["codex", "cursor"]) {
      await saveAgentIdentity(home, await identity(name))
      await pendingRequest(home, name)
    }
    const rounds: string[] = []
    const asked: string[] = []
    const lines: string[] = []
    let resolveResult: ((r: OwnerLinkResult) => void) | undefined
    const run2 = (answer: string) =>
      runCli(["approve", "--all"], {
        home,
        network: { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund },
        print: (line) => lines.push(line),
        prompt: async (question) => {
          asked.push(question)
          return answer
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        ownerLink: {
          startListener: async () => ({
            port: 4700,
            result: new Promise<OwnerLinkResult>((resolve) => {
              resolveResult = resolve
            }),
            close: () => {},
          }),
          openLink: async (link) => {
            rounds.push(link.url)
            const params = new URLSearchParams(link.url.split("#")[1]!)
            // a "success" with no transactions: the chain proof fails per agent — the point is
            // that the page was reached once per agent at all
            resolveResult!({
              v: 1,
              status: "success",
              nonce: params.get("nonce")!,
              requestHash: requestHash(link.requestBytes),
              owner: OWNER,
              transactions: [],
              operations: [],
            })
          },
        },
      } satisfies CliDeps)

    expect(await run2("yes")).toBe(1)
    // the combined ask ran once, then each agent went through its own owner-link round
    expect(asked).toEqual(["Type yes to approve all: "])
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toContain("/approve#")
    // the combined list ran once before the ask — two "is asking for" entries before the
    // disclosure (each agent's own round prints its ask again, above its passkey prompt)
    const constraintsIndex = lines.findIndex((line) => line.startsWith("It will see this context as plain text."))
    expect(constraintsIndex).toBeGreaterThan(0)
    expect(lines.slice(0, constraintsIndex).filter((line) => line.endsWith("is asking for:")).length).toBe(2)
    expect(lines.filter((line) => line.startsWith("It will see this context as plain text.")).length).toBe(1)
    // both agents failed at the chain proof and both are named
    expect(lines.at(-1)).toBe("approved: none; failed: codex (declined), cursor (declined)")

    // a non-yes answer asks the page nothing at all
    rounds.length = 0
    asked.length = 0
    expect(await run2("no")).toBe(1)
    expect(asked).toEqual(["Type yes to approve all: "])
    expect(rounds).toHaveLength(0)
    expect(lines.at(-1)).toBe("not approved")
    // both pending requests are still waiting
    expect(home.has("agents/codex/pending-request.json")).toBe(true)
    expect(home.has("agents/cursor/pending-request.json")).toBe(true)
  }, 120_000)

  it("nothing pending says so without opening the page", async () => {
    const home = new MidaHome(join(mkdtempSync(join(tmpdir(), "mida-pkall-empty-")), "home"))
    saveOwnerMode(home, "passkey")
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const lines: string[] = []
    const code = await runCli(["approve", "--all"], {
      home,
      network: { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund },
      print: (line) => lines.push(line),
      prompt: async () => "yes",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      ownerLink: { openLink: async () => { throw new Error("the page must never open") } },
    })
    expect(code).toBe(0)
    expect(lines).toContain("nothing to approve — no agent has a pending request")
  }, 120_000)
})
