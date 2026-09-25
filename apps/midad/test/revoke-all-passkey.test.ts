import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, loadOwnerAddress, runCli, saveOwnerMode } from "@mida/midad"
import type { CliDeps } from "@mida/midad"
import { requestHash } from "@mida/protocol"
import type { OwnerLinkResult } from "@mida/protocol"

/**
 * `mida revoke --all` on a passkey home, end to end through runCli: the terminal lists every
 * approved agent and asks one typed yes, then each agent gets its own owner-link round — the
 * passkey is asked once per revocation, never once for the batch. The approvals here are REAL:
 * the home is software-initialised first so the agents genuinely hold live capabilities on the
 * local Anvil, then owner/mode.json flips to passkey (the same state `mida migrate` can leave).
 * The fake page's "success" revokes nothing, so each agent's chain proof fails and lands in
 * `failed` — which is exactly what lets the test count page rounds.
 */
describe("mida revoke --all on a passkey home (I4)", () => {
  let env: ScenarioEnvironment

  beforeAll(async () => {
    env = await localEnvironment()
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("one terminal yes, then one page round per approved agent", async () => {
    const home = new MidaHome(join(mkdtempSync(join(tmpdir(), "mida-pkrev-")), "home"))
    const network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    const lines: string[] = []
    // software mode first: init + two real approvals, so three agents hold live capabilities
    // (init grants assistant its general-assistance scopes itself)
    const setup = (...argv: string[]) =>
      runCli(argv, {
        home, network,
        print: () => {},
        prompt: async () => "yes",
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await setup("init")).toBe(0)
    expect(await setup("request", "codex")).toBe(0)
    expect(await setup("approve", "codex")).toBe(0)
    expect(await setup("request", "claude-code")).toBe(0)
    expect(await setup("approve", "claude-code")).toBe(0)
    const owner = loadOwnerAddress(home)!
    // the same home now answers as a passkey home: owner-address.json is already the real owner
    saveOwnerMode(home, "passkey")

    const rounds: string[] = []
    const asked: string[] = []
    let resolveResult: ((r: OwnerLinkResult) => void) | undefined
    const run2 = (answer: string) =>
      runCli(["revoke", "--all"], {
        home,
        network,
        print: (line) => lines.push(line),
        prompt: async (question) => {
          asked.push(question)
          return answer
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        ownerLink: {
          startListener: async () => ({
            port: 4701,
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
              owner,
              transactions: [],
              operations: [],
            })
          },
        },
      } satisfies CliDeps)

    expect(await run2("yes")).toBe(1)
    // the list ran once before the ask; then each approved agent got its own revoke round
    expect(asked).toEqual(["Type yes to revoke all: "])
    for (const name of ["assistant", "claude-code", "codex"]) {
      expect(lines).toContain(`${name} holds an approval`)
    }
    expect(rounds).toHaveLength(3)
    expect(rounds[0]).toContain("/revoke#")
    // every agent failed at the chain proof — the fake page sent no revocation — and all are
    // named; a success the chain cannot prove is a page mismatch (possible tampering), not a decline
    expect(lines.at(-1)).toBe("revoked: none; failed: assistant (page-mismatch), claude-code (page-mismatch), codex (page-mismatch)")

    // a non-yes answer asks the page nothing at all — and revokes nothing either
    rounds.length = 0
    asked.length = 0
    expect(await run2("no")).toBe(1)
    expect(asked).toEqual(["Type yes to revoke all: "])
    expect(rounds).toHaveLength(0)
    expect(lines.at(-1)).toBe("not revoked")
    // no revoked markers were written — every agent is still live
    expect(home.has("agents/codex/revoked.json")).toBe(false)
    expect(home.has("agents/claude-code/revoked.json")).toBe(false)
  }, 300_000)

  it("nobody approved says so without opening the page", async () => {
    const home = new MidaHome(join(mkdtempSync(join(tmpdir(), "mida-pkrev-empty-")), "home"))
    saveOwnerMode(home, "passkey")
    home.writeSecretJson("owner-address.json", { address: `0x${"ab".repeat(20)}` })
    const lines: string[] = []
    const code = await runCli(["revoke", "--all"], {
      home,
      network: { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund },
      print: (line) => lines.push(line),
      prompt: async () => "yes",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      ownerLink: { openLink: async () => { throw new Error("the page must never open") } },
    })
    expect(code).toBe(0)
    expect(lines).toContain("nothing to revoke — no agent holds an approval")
  }, 120_000)
})
