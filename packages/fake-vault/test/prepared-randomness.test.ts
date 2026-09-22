import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Hex } from "@mida/protocol"
import { generateX25519KeyPair, hexOf } from "@mida/crypto"
import { ANVIL_PRIVATE_KEYS, createWriteContext, deployLocal, startAnvil } from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { RegistryReader } from "@mida/api"
import { predictAgentId, provisionAgent } from "@mida/fake-vault"
import type { AgentDeclaration } from "@mida/fake-vault"

const DECLARATIONS: AgentDeclaration[] = [{ namespace: "goals.career", permissions: ["READ"] }]

describe("provisionAgent prepared randomness (migrate B1)", () => {
  let node: LocalNode
  let deployment: Deployment
  let operator: LocalWriteContext
  let reader: RegistryReader

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!) })
    reader = new RegistryReader(operator)
  }, 180_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("a caller-supplied salt registers exactly predictAgentId", async () => {
    const agentSalt: Hex = hexOf(randomBytes(32))
    const expected = predictAgentId({ deployment, operator: operator.account.address, agentSalt })
    const agent = await provisionAgent({
      operator,
      name: "PreparedSalt",
      purposeId: "career_coaching",
      declarations: DECLARATIONS,
      callbackOrigin: "https://prepared.example",
      agentSalt,
    })
    expect(agent.agentId).toBe(expected)
    expect(await reader.getAgent(expected)).toMatchObject({ agentId: expected, active: true })
  })

  it("a caller-supplied encryption pair is the one registered on chain", async () => {
    const encryption = generateX25519KeyPair()
    const agent = await provisionAgent({
      operator,
      name: "PreparedKeys",
      purposeId: "career_coaching",
      declarations: DECLARATIONS,
      callbackOrigin: "https://keys.example",
      encryption,
    })
    expect(agent.encryptionPublicKey).toBe(hexOf(encryption.publicKey))
    expect(agent.encryptionPrivateKey).toEqual(encryption.privateKey)
    expect(await reader.getAgent(agent.agentId)).toMatchObject({ encryptionPublicKey: hexOf(encryption.publicKey) })
  })

  it("omitting them keeps the random behaviour — two provisions never share an id or a key", async () => {
    const a = await provisionAgent({ operator, name: "RandomA", purposeId: "career_coaching", declarations: DECLARATIONS, callbackOrigin: "https://a.example" })
    const b = await provisionAgent({ operator, name: "RandomB", purposeId: "career_coaching", declarations: DECLARATIONS, callbackOrigin: "https://b.example" })
    expect(a.agentId).not.toBe(b.agentId)
    expect(a.encryptionPublicKey).not.toBe(b.encryptionPublicKey)
    expect(await reader.getAgent(a.agentId)).toMatchObject({ active: true })
    expect(await reader.getAgent(b.agentId)).toMatchObject({ active: true })
  })
})
