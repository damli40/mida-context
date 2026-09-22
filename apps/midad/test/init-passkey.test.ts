import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, loadOwnerMode, runCli, saveOwnerMode } from "@mida/midad"
import type { CliDeps, Network } from "@mida/midad"
import { pairingCode, requestHash } from "@mida/protocol"
import type { OwnerLinkResult } from "@mida/protocol"

/**
 * `mida init --passkey` against a fake page: the injected listener resolves with a crafted
 * result, the injected opener records the link, and the chain read + agent provisioning are
 * stubbed. The test covers the parts that decide safety — when files get written, what the
 * owner sees — not the chain itself (the real chain path is covered by the software-mode
 * end-to-end suite).
 */

const OWNER = "0x1111111111111111111111111111111111111111"
const PUB_X = `0x${"aa".repeat(32)}` as `0x${string}`
const PUB_Y = `0x${"bb".repeat(32)}` as `0x${string}`

const NETWORK = {
  rpcUrl: "http://127.0.0.1:1",
  deployment: {
    chainId: 31337n,
    capabilityRegistry: "0x2222222222222222222222222222222222222222",
    contextRegistry: "0x3333333333333333333333333333333333333333",
    agentRegistry: "0x4444444444444444444444444444444444444444",
    deploymentBlock: 0n,
    vaultRpId: "vault.mida.xyz",
    vaultRpIdHash: `0x${"00".repeat(32)}`,
    policyHashV1: `0x${"00".repeat(32)}`,
  },
} as unknown as Network

function successResult(nonce: string, reqBytes: Uint8Array): OwnerLinkResult {
  return {
    v: 1,
    status: "success",
    nonce,
    requestHash: requestHash(reqBytes),
    owner: OWNER,
    transactions: [`0x${"cc".repeat(32)}`],
    operations: [],
    publicKey: { x: PUB_X, y: PUB_Y },
  }
}

interface FakePage {
  url?: string
  status?: OwnerLinkResult["status"]
  reason?: string
}

/** runCli deps that stand in for the page, the browser opener, the chain key read and provisioning. */
function fakeDeps(home: MidaHome, lines: string[], page: FakePage = {}): CliDeps {
  let resolveResult: ((r: OwnerLinkResult) => void) | undefined
  return {
    home,
    network: NETWORK,
    print: (line) => lines.push(line),
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ownerLink: {
      startListener: async () => ({
        port: 4321,
        result: new Promise<OwnerLinkResult>((resolve) => {
          resolveResult = resolve
        }),
        close: () => {},
      }),
      openLink: async (link, linkDeps) => {
        page.url = link.url
        // The opener's contract: link, pairing code and the compare warning print before any
        // browser spawn — the fake prints the same lines the real one would.
        linkDeps.print(`pairing code: ${pairingCode(link.requestBytes)}`)
        linkDeps.print("Only approve if the page shows this same code.")
        // The fake page "answers" the moment the link is opened, like a real browser would.
        const fragment = link.url.split("#")[1]!
        const params = new URLSearchParams(fragment)
        const bytes = Uint8Array.from(atob(params.get("req")!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
        const result =
          page.status === undefined || page.status === "success"
            ? successResult(params.get("nonce")!, bytes)
            : {
                v: 1 as const,
                status: page.status,
                nonce: params.get("nonce")!,
                requestHash: requestHash(bytes),
                owner: null,
                transactions: [],
                operations: [],
                ...(page.reason !== undefined ? { reason: page.reason } : {}),
              }
        resolveResult!(result)
      },
      readOwnerKey: async () => ({ qx: BigInt(PUB_X), qy: BigInt(PUB_Y) }),
      provision: async () => ({ "claude-code": `0x${"dd".repeat(32)}` }),
    },
  }
}

const dir = () => mkdtempSync(join(tmpdir(), "mida-init-passkey-"))

describe("mida init --passkey", () => {
  it("refuses a home that already holds a software owner key — exit 2, nothing written", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "software")
    const lines: string[] = []
    const code = await runCli(["init", "--passkey"], fakeDeps(home, lines))
    expect(code).toBe(2)
    expect(lines).toContain("this home already has a software owner key; a passkey owner needs a fresh MIDA_HOME")
    expect(home.has("owner/secrets.json")).toBe(false)
    expect(loadOwnerMode(home)).toBe("software")
  })

  it("refuses a software init on a passkey home — the modes never mix", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "passkey")
    const lines: string[] = []
    const code = await runCli(["init"], fakeDeps(home, lines))
    expect(code).toBe(2)
    expect(lines.some((line) => line.includes("passkey"))).toBe(true)
    expect(home.has("owner/secrets.json")).toBe(false)
  })

  it("refuses remember on a passkey home — exit 2, and never touches owner secrets", async () => {
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "passkey")
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const lines: string[] = []
    const code = await runCli(["remember", "I like tea"], fakeDeps(home, lines))
    expect(code).toBe(2)
    expect(lines).toContain("remember is not available with a passkey owner yet")
    expect(home.has("owner/secrets.json")).toBe(false)
  })

  it("happy path: opens the signup link, verifies the key on chain, then writes the home", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const page: FakePage = {}
    const code = await runCli(["init", "--passkey"], fakeDeps(home, lines, page))
    expect(code).toBe(0)
    // the link went to the signup flow on the page origin and carries v/req/port/nonce
    expect(page.url).toContain("https://app.midacontext.xyz/signup#v=1&req=")
    expect(page.url).toContain("&port=4321&nonce=")
    // files land only after the chain check passed
    expect(loadOwnerMode(home)).toBe("passkey")
    expect(home.readJson<{ address: string }>("owner-address.json")?.address).toBe(OWNER)
    expect(home.readJson<{ rpcUrl: string }>("network.json")?.rpcUrl).toBe(NETWORK.rpcUrl)
    // the identity line is on every passkey command's output
    expect(lines).toContain("Your passkey is your Mida identity. Use the same passkey you originally registered.")
    expect(lines.some((line) => line.startsWith("pairing code: "))).toBe(true)
    // never a software owner key
    expect(home.has("owner/secrets.json")).toBe(false)
  })

  it("a cancelled page prints its reason and writes nothing", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runCli(["init", "--passkey"], fakeDeps(home, lines, { status: "cancelled", reason: "the passkey prompt was dismissed" }))
    expect(code).toBe(2)
    expect(lines).toContain("the passkey prompt was dismissed")
    expect(home.has("owner/mode.json")).toBe(false)
    expect(home.has("owner-address.json")).toBe(false)
    expect(home.has("network.json")).toBe(false)
  })

  it("a failed page prints its reason and writes nothing", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runCli(["init", "--passkey"], fakeDeps(home, lines, { status: "failed", reason: "the sponsor refused" }))
    expect(code).toBe(2)
    expect(lines).toContain("the sponsor refused")
    expect(home.has("owner/mode.json")).toBe(false)
    expect(home.has("owner-address.json")).toBe(false)
  })

  it("a key on chain that is not the page's key is a mismatch — nothing is written", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const deps = fakeDeps(home, lines)
    deps.ownerLink!.readOwnerKey = async () => ({ qx: 1n, qy: 2n })
    const code = await runCli(["init", "--passkey"], deps)
    expect(code).toBe(1)
    expect(lines).toContain("the approval page returned something that does not match this request")
    expect(home.has("owner/mode.json")).toBe(false)
    expect(home.has("owner-address.json")).toBe(false)
  })

  it("a success result with no owner key registered on chain is a mismatch", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const deps = fakeDeps(home, lines)
    deps.ownerLink!.readOwnerKey = async () => null
    const code = await runCli(["init", "--passkey"], deps)
    expect(code).toBe(1)
    expect(lines).toContain("the approval page returned something that does not match this request")
    expect(home.has("owner/mode.json")).toBe(false)
  })

  it("a result carrying secret-looking material is refused by the real listener before anything is written", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runCli(["init", "--passkey"], {
      home,
      network: NETWORK,
      print: (line) => lines.push(line),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      ownerLink: {
        // the REAL listener — the fake "page" POSTs a result smuggling a 32-byte `seed`,
        // then a well-formed result so the round can settle
        openLink: async (link) => {
          const params = new URLSearchParams(link.url.split("#")[1])
          const port = params.get("port")!
          const nonce = params.get("nonce")!
          const url = `http://127.0.0.1:${port}/mida-return`
          const post = (result: unknown) =>
            fetch(url, { method: "POST", body: `nonce=${nonce}&result=${Buffer.from(JSON.stringify(result)).toString("base64url")}` })
          const bad = await post({
            v: 1,
            status: "success",
            nonce,
            requestHash: `0x${"00".repeat(32)}`,
            owner: OWNER,
            transactions: [],
            operations: [],
            seed: `0x${"ee".repeat(32)}`,
          })
          expect(bad.status).toBe(400)
          // a refused result does not settle the listener — a valid one still lands
          const reqBytes = Uint8Array.from(atob(params.get("req")!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
          const good = await post(successResult(nonce, reqBytes))
          expect(good.status).toBe(200)
        },
        readOwnerKey: async () => ({ qx: BigInt(PUB_X), qy: BigInt(PUB_Y) }),
        provision: async () => ({}),
      },
    })
    expect(code).toBe(0)
    expect(loadOwnerMode(home)).toBe("passkey")
  })
})
