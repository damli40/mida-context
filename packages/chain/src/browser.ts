/**
 * The browser-safe surface of @mida/chain for the owner page bundle. index.ts also exports
 * local.ts (node:child_process, node:fs, node:net, node:os) and deployment.ts's loadDeployment
 * (node:fs) — neither can exist in a browser bundle, so this entry names the safe modules
 * explicitly. The bundle test in apps/owner-page scans the built output and fails on "node:".
 *
 * deployment.js is re-exported only partially on purpose: parseDeployment/chainFor/Deployment are
 * pure data + viem chains, while loadDeployment and DEFAULT_DEPLOYMENTS_DIR touch the filesystem
 * and are deliberately absent here so nothing can reach them transitively.
 */
export * from "./abis.js"
export { LOCAL_CHAIN_ID, MONAD_TESTNET_CHAIN_ID, MULTICALL3_ADDRESS, chainFor, parseDeployment } from "./deployment.js"
export type { Deployment } from "./deployment.js"
export * from "./logs.js"
export * from "./history.js"
export * from "./registry.js"
export * from "./gas.js"
export * from "./writes.js"
export * from "./sponsored.js"
// transport.js is already inside this graph (writes.js and sponsored.js import rpcTransport) and
// is browser-safe — fetch, URL and viem's http, no node builtins. The owner page's @mida/api
// error mapper needs isChainBusy/ChainBusyError from here (in-9: it crashed both bundles).
export * from "./transport.js"
