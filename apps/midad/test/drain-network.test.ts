import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, agentApprovedOnChain } from "@mida/midad"

/**
 * in-6 R7: the drainer's read-only approval check resolves its RPC the same way the rest of the
 * daemon does — resolveNetwork precedence (MONAD_TESTNET_RPC, then network.json, then the public
 * default). Before the fix it read network.json's rpcUrl directly, so one process could answer
 * about a different RPC than the daemon that spawned it.
 *
 * The fake fetch answers the one eth_call the check makes (activeCapabilityIds → an empty list)
 * and records which URL was asked — the assertion is about the URL, not the answer.
 */

const OWNER = `0x${"dd".repeat(20)}`
const DEPLOYMENT = {
  chainId: "31337",
  capabilityRegistry: "0x2222222222222222222222222222222222222222",
  contextRegistry: "0x3333333333333333333333333333333333333333",
  deploymentBlock: "0",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"55".repeat(32)}`,
  policyHashV1: `0x${"44".repeat(32)}`,
}

// ABI-encoded empty bytes32[] — offset 32, then length 0
const EMPTY_LIST = `0x${"0".repeat(63)}20${"0".repeat(64)}`

function homeWithNetwork(rpcUrl: string): MidaHome {
  const home = new MidaHome(join(mkdtempSync(join(tmpdir(), "mida-drainnet-")), "home"))
  home.writeSecretJson("agents/claude-code/identity.json", {
    name: "claude-code",
    agentId: `0x${"1".repeat(64)}`,
    signerPrivateKey: `0x${"2".repeat(64)}`,
    encryptionPrivateKey: `0x${"3".repeat(64)}`,
    encryptionPublicKey: `0x${"4".repeat(64)}`,
    callbackOrigin: "https://agent.test",
    purposeId: "test",
    manifest: {},
    manifestHash: `0x${"5".repeat(64)}`,
  })
  home.writeSecretJson("network.json", { rpcUrl, deployment: DEPLOYMENT })
  return home
}

async function withFetch<T>(urls: string[], fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    if (!url.startsWith("http://env-rpc.test")) throw new Error(`test fetch: unexpected URL ${url}`)
    const request = JSON.parse(String(init?.body ?? "{}")) as { id?: number | string }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? 1, result: EMPTY_LIST }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

describe("the drainer resolves its RPC like the rest of the daemon (in-6 R7)", () => {
  it("MONAD_TESTNET_RPC beats the saved network.json rpcUrl", async () => {
    const home = homeWithNetwork("http://127.0.0.1:1")
    const urls: string[] = []
    const owner = OWNER as `0x${string}`
    const approved = await withFetch(urls, () =>
      agentApprovedOnChain(home, "claude-code", async () => owner, { MONAD_TESTNET_RPC: "http://env-rpc.test" }),
    )
    expect(approved).toBe(false)
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((url) => url.startsWith("http://env-rpc.test"))).toBe(true)
  })

  it("with no env the saved rpcUrl is used", async () => {
    const home = homeWithNetwork("http://env-rpc.test")
    const urls: string[] = []
    const owner = OWNER as `0x${string}`
    const approved = await withFetch(urls, () =>
      agentApprovedOnChain(home, "claude-code", async () => owner, {}),
    )
    expect(approved).toBe(false)
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((url) => url.startsWith("http://env-rpc.test"))).toBe(true)
  })
})
