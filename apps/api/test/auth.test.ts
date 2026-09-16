import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, createContextApi } from "@mida/api"
import type { RegistryReader } from "@mida/api"

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}
const NOW = 1_800_000_000n

function setup(dataDir: string = mkdtempSync(join(tmpdir(), "mida-auth-"))) {
  // Authentication runs before any chain read; an empty body reaches the handler, which rejects it as INVALID_WIRE.
  const { app } = createContextApi({ reader: {} as RegistryReader, deployment, dataDir, clock: () => NOW })
  const captured: Array<{ url: string; init: RequestInit }> = []
  const account = privateKeyToAccount(generatePrivateKey())
  const client = (options: Partial<ConstructorParameters<typeof ContextApiClient>[0]> = {}) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => NOW,
      fetch: async (url, init) => {
        captured.push({ url, init })
        return app.request(url, init)
      },
      ...options,
    })
  return { app, client, captured, dataDir }
}

describe("§12.1 request authentication", () => {
  it("rejects an unsigned request before any handler runs", async () => {
    const { client } = setup()
    await expect(client().request("POST", "/revocations", { body: {}, signed: false })).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("accepts a correctly signed request, so the handler's own validation is what fails", async () => {
    const { app, client, captured } = setup()
    await expect(client().request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    const response = await app.request(captured[0]!.url, captured[0]!.init)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "REPLAY" } })
  })

  it("still rejects a replay after the API restarts on the same data directory", async () => {
    const first = setup()
    await expect(first.client().request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    const restarted = setup(first.dataDir)
    const response = await restarted.app.request(first.captured[0]!.url, first.captured[0]!.init)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "REPLAY" } })
  })

  it("rejects a timestamp more than 60 seconds away and accepts exactly 60", async () => {
    const { client } = setup()
    await expect(client({ clock: () => NOW - 61n }).request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(client({ clock: () => NOW + 61n }).request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(client({ clock: () => NOW - 60n }).request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "INVALID_WIRE" })
  })

  it("binds the exact body bytes, the method, the target and the registry", async () => {
    const { app, client } = setup()
    const tamper = (mutate: (url: string, init: RequestInit) => [string, RequestInit]) =>
      client({ fetch: async (url, init) => app.request(...mutate(url, init)) }).request("POST", "/revocations", { body: { agentId: "0x00" } })
    await expect(tamper((url, init) => [url, { ...init, body: new TextEncoder().encode("{}") }])).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(tamper((url, init) => [url.replace("/revocations", "/revocations/x/cancel"), init])).rejects.toMatchObject({
      code: expect.stringMatching(/AUTH_INVALID|NOT_FOUND/),
    })
    await expect(
      client({ capabilityRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }).request("POST", "/revocations", { body: {} }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("canonicalizes query order and rejects a repeated query key", async () => {
    const { app, client } = setup()
    await expect(client().request("POST", "/revocations", { body: {}, query: { b: "2", a: "1" } })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    const repeated = client({ fetch: async (url, init) => app.request(`${url}&a=3`, init) })
    await expect(repeated.request("POST", "/revocations", { body: {}, query: { a: "1" } })).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })
})
