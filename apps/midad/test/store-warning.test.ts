// in-12 N-7: a store deployed before in-3 has no GET /write-authority — the client warns once
// per process, and inside midad that line must land in the daemon's log (logs/daemon.jsonl),
// not the stderr of a detached process that nobody reads.

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { parseDeployment } from "@mida/chain"
import { MidaHome } from "@mida/midad"
import { apiClient } from "../src/runtime.js"

const ACCOUNT = privateKeyToAccount(`0x${"12".repeat(32)}`)
const DEPLOYMENT = parseDeployment({
  chainId: "31337",
  capabilityRegistry: "0x2222222222222222222222222222222222222222",
  contextRegistry: "0x3333333333333333333333333333333333333333",
  deploymentBlock: "0",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"55".repeat(32)}`,
  policyHashV1: `0x${"66".repeat(32)}`,
})

const INPUT = {
  owner: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  namespaceId: `0x${"ab".repeat(32)}` as `0x${string}`,
  capabilityId: `0x${"cd".repeat(32)}` as `0x${string}`,
}

/** The old store: every route answers Hono's plain-text 404 — there is no /write-authority. */
async function oldStore(): Promise<{ url: string; host: string; close(): Promise<void> }> {
  const server = createHttpServer((_req, res) => {
    res.setHeader("content-type", "text/plain")
    res.statusCode = 404
    res.end("404 Not Found")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url: `http://${host}`, host, close: () => new Promise<void>((done) => server.close(() => done())) }
}

describe("the old-store warning reaches the daemon log (in-12 N-7)", () => {
  it("a client built with a home logs store-predates-write-check to daemon.jsonl, once, off stderr", async () => {
    // a fresh module graph: the client's once-per-process flag starts unspent
    vi.resetModules()
    const { apiClient: freshApiClient } = await import("../src/runtime.js")
    const store = await oldStore()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-store-warning-")))
      const client = freshApiClient(store.url, DEPLOYMENT, ACCOUNT, undefined, home)
      await expect(client.writeAuthority(INPUT)).resolves.toEqual({ ok: true })
      await expect(client.writeAuthority(INPUT)).resolves.toEqual({ ok: true })

      const lines = readFileSync(home.path("logs/daemon.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const warnings = lines.filter((line) => line.event === "store-warning")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.detail).toContain("store-predates-write-check")
      expect(warnings[0]!.detail).toContain(store.host)
      expect(warnings[0]!.detail).toContain("redeploy the store")
      // stderr of the detached process stays clean — the log is where the owner looks
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await store.close()
    }
  })

  it("a home-less client keeps the stderr default — bare callers still see the line", async () => {
    // the top-level apiClient shares this file's original module instance, whose
    // once-per-process flag was never spent (the first test imported a fresh graph)
    const store = await oldStore()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const client = apiClient(store.url, DEPLOYMENT, ACCOUNT)
      await expect(client.writeAuthority(INPUT)).resolves.toEqual({ ok: true })
      const lines = warn.mock.calls.flat().filter((line): line is string => typeof line === "string")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("store-predates-write-check")
    } finally {
      warn.mockRestore()
      await store.close()
    }
  })
})
