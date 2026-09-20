import { privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import { PERMISSION } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { bytesOf } from "@mida/crypto"
import { createWriteContext } from "@mida/chain"
import type { Deployment, LocalWriteContext } from "@mida/chain"
import { ContextApiClient, RegistryReader } from "@mida/api"
import { FakeVaultAuthority } from "@mida/fake-vault"
import { MidaAgent } from "@mida/sdk"
import type { MidaHome } from "./home.js"
import { FileAccessRequestStore } from "./request-store.js"
import { listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets } from "./keys.js"
import type { AgentIdentity } from "./keys.js"
import { startPersistentApi } from "./api-server.js"

export interface Network {
  rpcUrl: string
  deployment: Deployment
  fund(address: Address): Promise<void>
}

export const NAMESPACE = "projects.current"
export const PURPOSE_ID = "project_assistance" as const
export const AGENT_PERMISSIONS = PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN
/** Below this balance an account is topped up before it has to send a transaction. */
const MIN_BALANCE_WEI = 50_000_000_000_000_000n

export class Runtime {
  readonly #agents = new Map<string, MidaAgent>()
  readonly #close: () => Promise<void>

  private constructor(
    readonly home: MidaHome,
    readonly network: Network,
    readonly ownerChain: LocalWriteContext,
    readonly ownerApi: ContextApiClient,
    readonly vault: FakeVaultAuthority,
    readonly reader: RegistryReader,
    readonly apiBaseUrl: string,
    close: () => Promise<void>,
  ) {
    this.#close = close
  }

  get owner(): Address {
    return this.vault.owner
  }

  static async open(home: MidaHome, network: Network): Promise<Runtime> {
    const secrets = loadOrCreateOwnerSecrets(home)
    const ownerAccount = privateKeyToAccount(secrets.privateKey)
    const server = await startPersistentApi({ rpcUrl: network.rpcUrl, deployment: network.deployment, dataDir: home.path("data") })
    const ownerChain = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: ownerAccount })
    const ownerApi = Runtime.#apiClient(server.baseUrl, network.deployment, ownerAccount)
    const vault = new FakeVaultAuthority({ seed: bytesOf(secrets.seed, 32), p256PrivateKey: secrets.p256PrivateKey, chain: ownerChain, api: ownerApi })
    const runtime = new Runtime(home, network, ownerChain, ownerApi, vault, new RegistryReader(ownerChain), server.baseUrl, server.close)
    for (const name of listAgentNames(home)) runtime.attach(loadAgentIdentity(home, name)!)
    return runtime
  }

  static #apiClient(baseUrl: string, deployment: Deployment, account: LocalAccount): ContextApiClient {
    return new ContextApiClient({ baseUrl, account, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry })
  }

  /** Builds the agent from its saved identity and the grants it completed before, and keeps it for `agent(name)`. */
  attach(identity: AgentIdentity): MidaAgent {
    const signer = privateKeyToAccount(identity.signerPrivateKey)
    const agent = new MidaAgent({
      agentId: identity.agentId,
      callbackOrigin: identity.callbackOrigin,
      encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
      chain: createWriteContext({ rpcUrl: this.network.rpcUrl, deployment: this.network.deployment, account: signer }),
      api: Runtime.#apiClient(this.apiBaseUrl, this.network.deployment, signer),
      requests: new FileAccessRequestStore(this.home, identity.name),
      grants: loadGrants(this.home, identity.name),
    })
    this.#agents.set(identity.name, agent)
    return agent
  }

  agent(name: string): MidaAgent {
    const agent = this.#agents.get(name)
    if (agent === undefined) throw new Error(`agent "${name}" is not set up on this machine; run init first`)
    return agent
  }

  async ensureFunded(address: Address): Promise<void> {
    const balance = await this.ownerChain.publicClient.getBalance({ address })
    if (balance < MIN_BALANCE_WEI) await this.network.fund(address)
  }

  close(): Promise<void> {
    return this.#close()
  }
}
