import { createPublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import type { Hex } from "@mida/protocol"
import { MONAD_TESTNET_CHAIN_ID, chainFor, createWriteContext, loadDeployment, rpcTransport, sendValue } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import type { Network } from "./runtime.js"
import { HOSTED_SPONSOR_URL, HOSTED_STORAGE_URL, serviceUrl } from "./runtime.js"

/** The funder's per-account top-up — same value the dev environments use. */
const TESTNET_FUNDING_WEI = 200_000_000_000_000_000n
const DEPLOYER_KEY = /^0x[0-9a-fA-F]{64}$/

/**
 * The funder closure testnetNetwork builds when DEPLOYER_PRIVATE_KEY is set — extracted so
 * resolveNetwork can fund the deployment IT resolved (a saved record's contract, not
 * necessarily the built-in one) exactly the same way. Undefined without the key; a set key
 * that is not a 0x-prefixed 32-byte hex value is refused, as before.
 */
export function funderFor(
  env: Record<string, string | undefined>,
  rpcUrl: string,
  deployment: Deployment,
): Network["fund"] | undefined {
  const key = env.DEPLOYER_PRIVATE_KEY
  if (key === undefined) return undefined
  if (!DEPLOYER_KEY.test(key)) {
    throw new Error("DEPLOYER_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex key")
  }
  const funder = createWriteContext({ rpcUrl, deployment, account: privateKeyToAccount(key as Hex) })
  const funding = BigInt(env.TESTNET_FUNDING_WEI ?? TESTNET_FUNDING_WEI)
  return async (address) => {
    const receipt = await sendValue(funder, { to: address, value: funding }, "funding")
    // Monad's asynchronous execution budgets an EOA's inflight gas spend against state from
    // k=3 blocks ago — waiting past the lag keeps consecutive funds eligible (same rule the
    // dev environment's funder follows).
    const lag = 4n
    while ((await funder.publicClient.getBlockNumber()) < receipt.blockNumber + lag) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/**
 * The network the `mida` command runs against: Monad testnet, always. Everything else comes from
 * the environment and every variable is optional — the published package must work with no .env
 * at all:
 *
 *   MONAD_TESTNET_RPC     the RPC endpoint (default: the public testnet RPC)
 *   MIDA_DEPLOYMENTS_DIR  a contracts/deployments folder to read instead of the embedded record
 *                         (local-Anvil development only)
 *   DEPLOYER_PRIVATE_KEY  a funded dev key — when set, it tops wallets up exactly as the repo's
 *                         own runs do; when unset, the owner wallet funds the others itself
 *   TESTNET_FUNDING_WEI   the funder's per-account top-up
 *   MIDA_STORAGE_URL      the Context API (default: the hosted store; "off" runs the local one)
 *   MIDA_SPONSOR_URL      the gas sponsor (default: the hosted sponsor; "off" pays own gas)
 *
 * The chain-id check is the one RPC call worth making here: a wrong-RPC mistake would write
 * registrations to the wrong chain and nothing afterwards would explain why.
 */
export async function testnetNetwork(env: Record<string, string | undefined>): Promise<Network> {
  const rpcUrl = env.MONAD_TESTNET_RPC ?? monadTestnet.rpcUrls.default.http[0]
  const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID, env.MIDA_DEPLOYMENTS_DIR)
  const probe = createPublicClient({ chain: chainFor(deployment.chainId), batch: { multicall: true }, transport: rpcTransport(rpcUrl) })
  const chainId = await probe.getChainId()
  if (BigInt(chainId) !== deployment.chainId) {
    throw new Error(`RPC ${rpcUrl} is chain ${chainId}, not Monad testnet ${deployment.chainId}`)
  }

  const fund = funderFor(env, rpcUrl, deployment)

  return {
    rpcUrl,
    deployment,
    ...(fund === undefined ? {} : { fund }),
    // init persists both to network.json, so the daemon and the drainer see them without the
    // variables — "off" stores nothing and keeps the local store / self-paid gas
    storageUrl: serviceUrl(env.MIDA_STORAGE_URL, HOSTED_STORAGE_URL),
    sponsorUrl: serviceUrl(env.MIDA_SPONSOR_URL, HOSTED_SPONSOR_URL),
  }
}
