import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MidaError, assertHex } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import type { Chain } from "viem"
import { foundry, monadTestnet } from "viem/chains"

/** Contents of contracts/deployments/<chainId>.json, written by contracts/script/Deploy.s.sol (plan Task 20). */
export interface Deployment {
  chainId: bigint
  capabilityRegistry: Address
  contextRegistry: Address
  deploymentBlock: bigint
  policyHashV1: Hex
  vaultRpId: string
  vaultRpIdHash: Hex
}

export const LOCAL_CHAIN_ID = 31337n
export const MONAD_TESTNET_CHAIN_ID = 10143n

export const DEFAULT_DEPLOYMENTS_DIR = fileURLToPath(new URL("../../../contracts/deployments/", import.meta.url))

function wire(detail: string): never {
  throw new MidaError("INVALID_WIRE", `deployment: ${detail}`)
}

function address(value: unknown, key: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) wire(`${key} must be an address`)
  return value.toLowerCase() as Address
}

function integer(value: unknown, key: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value)
  return wire(`${key} must be a non-negative integer`)
}

export function parseDeployment(json: unknown): Deployment {
  if (json === null || typeof json !== "object" || Array.isArray(json)) wire("must be an object")
  const record = json as Record<string, unknown>
  if (typeof record.vaultRpId !== "string" || record.vaultRpId.length === 0) wire("vaultRpId must be a non-empty string")
  if (typeof record.policyHashV1 !== "string" || typeof record.vaultRpIdHash !== "string") wire("hashes must be strings")
  return {
    chainId: integer(record.chainId, "chainId"),
    capabilityRegistry: address(record.capabilityRegistry, "capabilityRegistry"),
    contextRegistry: address(record.contextRegistry, "contextRegistry"),
    deploymentBlock: integer(record.deploymentBlock, "deploymentBlock"),
    policyHashV1: assertHex(record.policyHashV1.toLowerCase(), 32),
    vaultRpId: record.vaultRpId,
    vaultRpIdHash: assertHex(record.vaultRpIdHash.toLowerCase(), 32),
  }
}

export function loadDeployment(chainId: bigint, directory: string = DEFAULT_DEPLOYMENTS_DIR): Deployment {
  const path = `${directory.replace(/\/$/, "")}/${chainId}.json`
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new MidaError("NOT_FOUND", `no deployment file at ${path}`)
  }
  const deployment = parseDeployment(JSON.parse(text))
  if (deployment.chainId !== chainId) wire(`${path} is for chain ${deployment.chainId}`)
  return deployment
}

/** Only the two networks Project 1 targets. Monad testnet comes from viem, never a hand-written object. */
export function chainFor(chainId: bigint): Chain {
  if (chainId === LOCAL_CHAIN_ID) return foundry
  if (chainId === MONAD_TESTNET_CHAIN_ID) return monadTestnet
  throw new MidaError("INVALID_WIRE", `unsupported chain ${chainId}`)
}
