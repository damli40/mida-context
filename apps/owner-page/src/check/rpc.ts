import { bytesToHex } from "./bytes.js"
import { MONAD_TESTNET_RPC, P256_PRECOMPILE } from "./constants.js"

/**
 * One read-only `eth_call` to the P256VERIFY precompile. A precompile call carries no signature
 * and spends no gas — the page asks the chain whether the assertion bytes verify, nothing more.
 */
export function buildEthCallBody(input160: Uint8Array): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: P256_PRECOMPILE, data: `0x${bytesToHex(input160)}` }, "latest"],
  })
}

export type PrecompileOutcome = "verified" | "rejected" | "rpc-error" | "unreachable"

export interface PrecompileResult {
  outcome: PrecompileOutcome
  detail: string
}

/** RIP-7212 returns a 32-byte word of 1 on success and empty output on failure. Anything else is odd enough to say so. */
export function interpretEthCallResult(hexResult: string): PrecompileOutcome {
  const clean = hexResult.startsWith("0x") ? hexResult.slice(2) : hexResult
  if (clean === "") return "rejected"
  if (clean.length !== 64) return "rpc-error"
  return /^0{63}1$/.test(clean) ? "verified" : "rpc-error"
}

export async function callP256Precompile(
  input160: Uint8Array,
  fetchFn: typeof fetch = fetch,
  rpcUrl: string = MONAD_TESTNET_RPC,
): Promise<PrecompileResult> {
  let response: Response
  try {
    response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildEthCallBody(input160),
    })
  } catch (error) {
    return { outcome: "unreachable", detail: `the testnet RPC could not be reached (${(error as Error).message})` }
  }
  let json: { result?: string; error?: { message?: string } }
  try {
    json = (await response.json()) as typeof json
  } catch {
    return { outcome: "rpc-error", detail: `the RPC returned HTTP ${response.status} with no JSON body` }
  }
  if (json.error || typeof json.result !== "string") {
    return { outcome: "rpc-error", detail: `the RPC answered with an error (${json.error?.message ?? "no result field"})` }
  }
  const outcome = interpretEthCallResult(json.result)
  const detail =
    outcome === "verified"
      ? "the P256 precompile on Monad testnet returned 1 — the chain accepts this signature"
      : outcome === "rejected"
        ? "the P256 precompile returned empty output — the chain rejects this signature"
        : `the precompile returned an unexpected value (${json.result})`
  return { outcome, detail }
}
