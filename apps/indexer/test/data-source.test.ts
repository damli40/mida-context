// Envio 3 reads HyperSync only with an ENVIO_API_TOKEN, and Envio Cloud's free plan has no
// environment variables to hold one: an indexer left on HyperSync there waits forever with no
// data (Sep 30, 2026). This pins the fix: Envio's own config loader must give Monad testnet the
// public RPC as its sync source and no HyperSync URL at all.
import { describe, expect, it } from "vitest"
import "./helpers.js"
import * as Core from "envio/src/Core.res.mjs"

describe("data source", () => {
  it("reads Monad testnet through the public RPC, never HyperSync", () => {
    const config = JSON.parse(Core.getConfigJson(undefined, undefined))
    const chain = config.evm.chains.monadTestnet
    expect(chain.id).toBe(10143)
    expect(chain.hypersync).toBeUndefined()
    expect(chain.rpcs).toEqual([
      { url: "https://testnet-rpc.monad.xyz", for: "sync", initialBlockInterval: 100, intervalCeiling: 100 },
    ])
  })
})
