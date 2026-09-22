/**
 * The one import surface the three owner flows use. Everything the page needs from the Mida
 * packages comes through the packages' `browser` entries (`@mida/chain/browser` and friends)
 * — never the package barrels, which can reach node-only modules (deployment files, local
 * Anvil, file-backed stores). NOTE: never write the glob form of that path in a comment; its
 * star-slash closes the comment early and the rest of the file stops parsing. The deployment
 * is imported as JSON at build time; the page never reads a file.
 *
 * The bundle test scans the built output for "node:" and "require(" — this file is the entry
 * that proves the whole import graph stays browser-safe.
 */
import deploymentJson from "../../../../contracts/deployments/10143.json" with { type: "json" }
import { parseDeployment } from "@mida/chain/browser"
import type { Deployment } from "@mida/chain/browser"

/** The deployment this page acts on — imported as JSON at build time, validated by the same parser the CLI uses. */
export const DEPLOYMENT: Deployment = parseDeployment(deploymentJson)

/** Live public endpoints the page may reach — the CSP in src/headers.ts allows exactly these. */
export const RPC_URL = "https://testnet-rpc.monad.xyz"
export const STORE_URL = "https://store.midacontext.xyz"
export const SPONSOR_URL = "https://sponsor.midacontext.xyz"

// --- re-exports: flows import from here and nowhere else -------------------------------------
export {
  SponsorDidNotPay,
  SponsorPending,
  capabilityRegistryAbi,
  contextRegistryAbi,
  contractGas,
  createSponsoredSender,
  latestTimestamp,
  ownerHistory,
  readAgentRecord,
  toMidaError,
} from "@mida/chain/browser"
export type { ChainContext, SponsoredReceipt, SponsoredSender, TxKind, WriteContext } from "@mida/chain/browser"
export { ContextApiClient, RegistryReader } from "@mida/api/browser"
export type { CapabilityView, ContextApiClientOptions, ContextApiRoutes } from "@mida/api/browser"
export { fakePrfOutput, toAccessRequestStruct } from "@mida/fake-vault/browser"
export type { VaultAuthority, VaultContextApi } from "@mida/fake-vault/browser"
export { POLICY_HASH_V1, adviseGrant, assertFinalSelection } from "@mida/grant-advisor"
export type { GrantAdvisorInput } from "@mida/grant-advisor"
export {
  assertNonZeroKey,
  bytesOf,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  hexOf,
  prfSalt,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
export type { EpochKeyPair } from "@mida/crypto"
export {
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  accessRequestHash,
  canonicalizeNamespace,
  decodeUint64,
  encodeUint64,
  grantDigest,
  isZeroBytes,
  namespaceById,
  namespaceId,
  sortScopes,
  toWebAuthnAuthStruct,
} from "@mida/protocol"
export type {
  AccessGrantResponse,
  AccessRequest,
  Address,
  GrantAdvice,
  GrantedCapability,
  Hex,
  OwnerAgentHistory,
  ReaderEpochWrap,
  SignedAgentCapabilityManifest,
  WebAuthnAuthStruct,
} from "@mida/protocol"

// The owner modules themselves — re-exported so the bundle test proves they stay browser-safe too.
export * from "./secrets.js"
export * from "./webauthn.js"
export * from "./send.js"
export * from "./authority.js"
