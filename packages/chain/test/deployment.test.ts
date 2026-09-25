import { describe, expect, it } from "vitest"
import { isMidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { parseDeployment } from "@mida/chain"
import type { Deployment } from "@mida/chain"

const DEPLOYMENT_JSON = {
  chainId: 31337,
  capabilityRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  contextRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  deploymentBlock: 5,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}
const BATCH_ANCHOR = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"

function fails(value: unknown): boolean {
  try {
    parseDeployment(value)
  } catch (error) {
    return isMidaError(error, "INVALID_WIRE")
  }
  return false
}

describe("deployment records with an optional BatchAnchor (plan Task 3)", () => {
  it("a record written before DeployBatchAnchor parses exactly as before", () => {
    const parsed = parseDeployment(DEPLOYMENT_JSON)
    expect(parsed.batchAnchor).toBeUndefined()
    expect(parsed.batchAnchorBlock).toBeUndefined()
    const expected: Deployment = {
      chainId: 31337n,
      capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
      deploymentBlock: 5n,
      policyHashV1: DEPLOYMENT_JSON.policyHashV1 as Hex,
      vaultRpId: "vault.mida.xyz",
      vaultRpIdHash: DEPLOYMENT_JSON.vaultRpIdHash as Hex,
    }
    expect(parsed).toEqual(expected)
  })

  it("a record with both keys parses them, lowercasing the address", () => {
    const parsed = parseDeployment({ ...DEPLOYMENT_JSON, batchAnchor: BATCH_ANCHOR, batchAnchorBlock: 9 })
    expect(parsed.batchAnchor).toBe(BATCH_ANCHOR.toLowerCase())
    expect(parsed.batchAnchorBlock).toBe(9n)
  })

  it("batchAnchorBlock accepts the decimal string vm.writeJson produces", () => {
    const parsed = parseDeployment({ ...DEPLOYMENT_JSON, batchAnchor: BATCH_ANCHOR, batchAnchorBlock: "9" })
    expect(parsed.batchAnchorBlock).toBe(9n)
  })

  it("one key without the other is refused", () => {
    expect(fails({ ...DEPLOYMENT_JSON, batchAnchor: BATCH_ANCHOR })).toBe(true)
    expect(fails({ ...DEPLOYMENT_JSON, batchAnchorBlock: 9 })).toBe(true)
  })

  it("malformed values are still refused", () => {
    expect(fails({ ...DEPLOYMENT_JSON, batchAnchor: "not-an-address", batchAnchorBlock: 9 })).toBe(true)
    expect(fails({ ...DEPLOYMENT_JSON, batchAnchor: BATCH_ANCHOR, batchAnchorBlock: -1 })).toBe(true)
  })
})
