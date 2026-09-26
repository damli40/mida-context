// in-11 R-3: a client built after in-3 must keep working against a store deployed before it.
// The old store answers /write-authority — and every route it never had — with Hono's
// plain-text 404, which is "this check does not exist yet", not a refusal. And a non-JSON
// body on ANY response must surface as an error carrying the HTTP status, never the bare
// SyntaxError the drain used to retry as "chain-error" until the job gave up.

import { describe, expect, it, vi } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { MidaError } from "@mida/protocol"
import { ContextApiClient, StoreHttpError } from "../src/client.js"

const ACCOUNT = privateKeyToAccount(`0x${"12".repeat(32)}`)
const OWNER = "0x1111111111111111111111111111111111111111" as const
const NAMESPACE = `0x${"ab".repeat(32)}` as const
const CAPABILITY = `0x${"cd".repeat(32)}` as const

function makeClient(fetch: (input: string, init: RequestInit) => Promise<Response>): ContextApiClient {
  return new ContextApiClient({
    baseUrl: "https://store.example",
    account: ACCOUNT,
    chainId: 10143n,
    capabilityRegistry: "0x2222222222222222222222222222222222222222",
    fetch,
  })
}

const plainText = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } })

describe("a new client against a store that predates the write check (in-11 R-3)", () => {
  it("a plain-text 404 on /write-authority means 'old store' — the save proceeds, with one named line per process", async () => {
    vi.resetModules()
    const { ContextApiClient: FreshClient } = await import("../src/client.js")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = new FreshClient({
      baseUrl: "https://store.example",
      account: ACCOUNT,
      chainId: 10143n,
      capabilityRegistry: "0x2222222222222222222222222222222222222222",
      fetch: async () => plainText(404, "404 Not Found"),
    })

    const input = { owner: OWNER, namespaceId: NAMESPACE, capabilityId: CAPABILITY }
    await expect(client.writeAuthority(input)).resolves.toEqual({ ok: true })
    // and the second save proceeds the same way — without repeating the line
    await expect(client.writeAuthority(input)).resolves.toEqual({ ok: true })

    const lines = warn.mock.calls.flat().filter((line): line is string => typeof line === "string")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("store-predates-write-check")
    expect(lines[0]).toContain("store.example")
    expect(lines[0]).toContain("redeploy the store to enable the pending-revoke check")
    warn.mockRestore()
  })

  it("a coded JSON 404 is the current store giving a real answer — never the compat path", async () => {
    const client = makeClient(
      async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such capability" } }), { status: 404, headers: { "content-type": "application/json" } }),
    )
    await expect(client.writeAuthority({ owner: OWNER, namespaceId: NAMESPACE, capabilityId: CAPABILITY })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("a non-JSON refusal on any route is a status-carrying failure, never a SyntaxError", async () => {
    const client = makeClient(async () => plainText(502, "Bad Gateway"))
    const caught = await client.getManifest(`0x${"ee".repeat(32)}`).catch((error) => error)
    expect(caught).toBeInstanceOf(StoreHttpError)
    expect(caught).not.toBeInstanceOf(SyntaxError)
    expect(caught.status).toBe(502)
    expect(caught.code).toBe("STORE_UNREACHABLE")
  })

  it("the old store's plain-text 404 on a route that is not /write-authority is named, not parsed", async () => {
    const client = makeClient(async () => plainText(404, "404 Not Found"))
    const caught = await client.listRevocations().catch((error) => error)
    expect(caught).toBeInstanceOf(StoreHttpError)
    expect(caught.status).toBe(404)
    // and it is not mistaken for a protocol answer
    expect(caught).not.toBeInstanceOf(MidaError)
  })
})
