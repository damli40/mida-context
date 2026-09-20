// packages/sdk/test/restore-grants.test.ts
import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createWriteContext } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import type { Address, Hex } from "@mida/protocol"
import { MidaAgent } from "@mida/sdk"
import type { Grant } from "@mida/sdk"

const hex = (byte: string, bytes: number) => `0x${byte.repeat(bytes)}` as Hex
const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: hex("11", 20) as Address,
  contextRegistry: hex("22", 20) as Address,
  deploymentBlock: 0n,
  policyHashV1: hex("00", 32),
  vaultRpId: "localhost",
  vaultRpIdHash: hex("00", 32),
}
const AGENT_ID = hex("aa", 32)

function agentWith(grants: Grant[] | undefined) {
  const account = privateKeyToAccount(generatePrivateKey())
  // No network call happens in a constructor, so an unreachable RPC URL is fine here.
  const chain = createWriteContext({ rpcUrl: "http://127.0.0.1:9", deployment, account })
  const api = { account } as unknown as ConstructorParameters<typeof MidaAgent>[0]["api"]
  return new MidaAgent({ agentId: AGENT_ID, callbackOrigin: "https://x.example", encryptionPrivateKey: new Uint8Array(32).fill(7), chain, api, grants })
}

const grant = (agentId: Hex): Grant => ({
  owner: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" as Address,
  agentId,
  requestId: hex("01", 32),
  capabilities: [],
})

describe("MidaAgent restores grants completed in an earlier process", () => {
  it("starts with no grants when none are passed", () => {
    expect(agentWith(undefined).grants).toEqual([])
  })

  it("exposes a restored grant, with the owner address lower-cased like a freshly completed one", () => {
    const restored = agentWith([grant(AGENT_ID)]).grants
    expect(restored).toHaveLength(1)
    expect(restored[0]!.owner).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")
    expect(restored[0]!.requestId).toBe(hex("01", 32))
  })

  it("refuses a grant that belongs to a different agent", () => {
    expect(() => agentWith([grant(hex("bb", 32))])).toThrow(expect.objectContaining({ code: "AUTH_INVALID" }))
  })

  it("does not keep a reference to the caller's array", () => {
    const input = [grant(AGENT_ID)]
    const agent = agentWith(input)
    input.pop()
    expect(agent.grants).toHaveLength(1)
  })

  it("copies each capability object instead of sharing it with the caller", () => {
    const capability = { capabilityId: hex("c1", 32), namespaceId: hex("d1", 32), permissions: 1 } as unknown as Grant["capabilities"][number]
    const agent = agentWith([{ ...grant(AGENT_ID), capabilities: [capability] }])
    capability.permissions = 255
    expect(agent.grants[0]!.capabilities[0]!.permissions).toBe(1)
  })
})
