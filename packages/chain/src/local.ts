import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Hex } from "@mida/protocol"
import { loadDeployment } from "./deployment-fs.js"
import type { Deployment } from "./deployment.js"

/** Development tooling for tests and the CLI. Never used against a real network. */
export const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? `${homedir()}/.foundry/bin`

let contractsDir: string | undefined
/**
 * The contracts/ directory, resolved on first use and cached. It must stay lazy: this module is bundled
 * into the store Worker, where `import.meta.url` is not a parseable URL — evaluating
 * fileURLToPath(new URL(…)) at module scope would throw on startup. The Worker never calls this.
 */
export function CONTRACTS_DIR(): string {
  return (contractsDir ??= fileURLToPath(new URL("../../../contracts/", import.meta.url)))
}

/** Anvil's public, pre-funded development keys (mnemonic "test test ... junk"). Never use on a real network. */
export const ANVIL_PRIVATE_KEYS: readonly Hex[] = Object.freeze([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
])

export interface LocalNode {
  rpcUrl: string
  hardfork: string
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}

async function waitForRpc(rpcUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`)
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      })
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`anvil did not answer at ${rpcUrl}`)
}

/** Starts a fresh Anvil on a free port. hardfork "default" keeps Anvil's default (Osaka, native P256 at 0x100). */
export async function startAnvil(options: { hardfork?: string } = {}): Promise<LocalNode> {
  const hardfork = options.hardfork ?? "default"
  const port = await freePort()
  const args = ["--port", String(port), "--silent", ...(hardfork === "default" ? [] : ["--hardfork", hardfork])]
  const child = spawn(`${FOUNDRY_BIN}/anvil`, args, { stdio: "ignore" })
  const rpcUrl = `http://127.0.0.1:${port}`
  await waitForRpc(rpcUrl, child)
  return {
    rpcUrl,
    hardfork,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
      }),
  }
}

/**
 * Fallback age for a lock with no readable `owner` file: an old-format lock, or a holder killed
 * between mkdir and writing the owner. A lock whose `owner` pid is running is never left behind,
 * however old the directory is — a live deploy that is merely slow keeps its lock.
 */
const DEPLOY_LOCK_STALE_MS = 5 * 60_000

/** A takeover holds `${lockDir}.steal` for milliseconds; past this its holder was killed mid-steal. */
const DEPLOY_LOCK_STEAL_STALE_MS = 30_000

/** The pid in `${lockDir}/owner`, or undefined when the file is missing or unreadable. */
function lockOwnerPid(lockDir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(lockDir, "owner"), "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** True while `pid` names a running process; EPERM means it runs but we may not signal it. */
function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * True when the lock at `lockDir` was left behind: its `owner` file names a pid that is no longer
 * running, or it has no readable `owner` file and the directory is older than `staleMs`. A lock
 * whose owner pid is still running is never left behind, however old the directory is — a live
 * deploy that is merely slow (a sleeping laptop) keeps its lock (UF-K). A leftover naming a pid
 * since recycled by an unrelated process makes waiters time out; the timeout names the pid and
 * the folder so a person can remove it.
 */
function lockLeftBehind(lockDir: string, staleMs: number): boolean {
  const owner = lockOwnerPid(lockDir)
  if (owner !== undefined) return !pidIsRunning(owner)
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs
  } catch {
    return false // the lock vanished between the failed mkdir and this check
  }
}

/**
 * Takes a directory lock, waiting up to `waitMs`. The holder's pid is written to `owner` inside the
 * lock directory. A left-behind lock — owner pid gone, or ownerless and older than `staleMs`
 * (PROC-07: one such leftover made every later test file wait out the full ten minutes behind a
 * lock nobody held) — is removed and taken; a lock whose owner pid is running is never taken,
 * however old. Takeover is serialised through a `${lockDir}.steal` mutex directory so several
 * waiters cannot remove and take the same lock at once, and the lock is re-checked inside the
 * mutex before it is removed — another waiter may have retaken it meanwhile. `beforeTakeover`
 * (tests only; deployLocal never passes it) is awaited after the lock is first seen left behind
 * and before the `.steal` directory is made — it widens that race window deterministically.
 */
export async function takeDirLock(
  lockDir: string,
  options: { waitMs: number; staleMs: number; beforeTakeover?: () => void | Promise<void> },
): Promise<void> {
  const deadline = Date.now() + options.waitMs
  for (;;) {
    try {
      mkdirSync(lockDir)
      try {
        writeFileSync(join(lockDir, "owner"), String(process.pid))
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true }) // don't leave an ownerless lock behind
        throw error
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    if (lockLeftBehind(lockDir, options.staleMs)) {
      await options.beforeTakeover?.()
      const stealDir = `${lockDir}.steal`
      let stealing = true
      try {
        mkdirSync(stealDir)
      } catch {
        stealing = false
        // Another waiter holds `.steal`. It keeps it for milliseconds, so one older than
        // DEPLOY_LOCK_STEAL_STALE_MS was left behind by a killed stealer — remove it and loop.
        try {
          if (Date.now() - statSync(stealDir).mtimeMs > DEPLOY_LOCK_STEAL_STALE_MS)
            rmSync(stealDir, { recursive: true, force: true })
        } catch {
          // raced: the stealer finished, or another waiter removed it first
        }
      }
      if (stealing) {
        try {
          // Re-check under the mutex: another process may have retaken the lock meanwhile.
          if (lockLeftBehind(lockDir, options.staleMs)) rmSync(lockDir, { recursive: true, force: true })
        } finally {
          rmSync(stealDir, { recursive: true, force: true })
        }
        // UF-K: straight back to the take. A waiter whose own wait ran out must not remove the
        // lock and then throw "held" — it would leave the freed lock to the next waiter while
        // reporting failure itself.
        continue
      }
    }
    if (Date.now() > deadline) {
      const owner = lockOwnerPid(lockDir)
      throw new Error(
        `deploy lock ${lockDir} held for ${options.waitMs / 1000}s${owner === undefined ? "" : ` by pid ${owner}`}. If no test run is active, delete that folder.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * Releases the lock at `lockDir` when this process owns it. Does nothing — and never throws — when
 * the lock is already gone or belongs to another process, so a deploy whose lock was taken over
 * cannot remove the new holder's lock from its `finally`.
 */
export function releaseDirLock(lockDir: string): void {
  if (lockOwnerPid(lockDir) !== process.pid) return
  try {
    rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // already gone — nothing to release
  }
}

/**
 * Deploys with contracts/script/Deploy.s.sol, then DeployBatchAnchor.s.sol beside it, and returns the
 * parsed deployment file (batchAnchor + batchAnchorBlock set). Every local Anvil writes the same
 * deployments/31337.json, so deployments from parallel test files are serialized with a directory lock.
 */
export async function deployLocal(options: { rpcUrl: string; privateKey?: Hex }): Promise<Deployment> {
  const privateKey = options.privateKey ?? ANVIL_PRIVATE_KEYS[0]!
  const lockDir = `${CONTRACTS_DIR()}deployments/.deploy-lock`
  // The wait must outlast the full-suite queue: every test file that deploys serializes here
  // (two forge runs each), and a wave of waiters easily stacks past two minutes. The deadline
  // still bounds a genuinely stuck lock — it just stops firing on normal queue depth. A lock
  // whose owner pid is running is never taken over, however long it has been held.
  await takeDirLock(lockDir, { waitMs: 600_000, staleMs: DEPLOY_LOCK_STALE_MS })
  try {
    const result = spawnSync(
      `${FOUNDRY_BIN}/forge`,
      ["script", "script/Deploy.s.sol", "--rpc-url", options.rpcUrl, "--broadcast", "--private-key", privateKey],
      { cwd: CONTRACTS_DIR(), encoding: "utf8", env: { ...process.env, VAULT_RP_ID: process.env.VAULT_RP_ID ?? "vault.mida.xyz" } },
    )
    if (result.status !== 0) throw new Error(`forge script failed:\n${result.stdout}\n${result.stderr}`)
    const anchorResult = spawnSync(
      `${FOUNDRY_BIN}/forge`,
      ["script", "script/DeployBatchAnchor.s.sol", "--rpc-url", options.rpcUrl, "--broadcast", "--private-key", privateKey],
      { cwd: CONTRACTS_DIR(), encoding: "utf8" },
    )
    if (anchorResult.status !== 0)
      throw new Error(`forge script DeployBatchAnchor failed:\n${anchorResult.stdout}\n${anchorResult.stderr}`)
    return loadDeployment(31337n)
  } finally {
    releaseDirLock(lockDir)
  }
}

/** Anvil-only: sets an address balance so generated agent signers can pay gas in local tests. */
export async function fundLocal(rpcUrl: string, address: string, wei: bigint = 10n ** 20n): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${wei.toString(16)}`] }),
  })
  const body = (await response.json()) as { error?: unknown }
  if (body.error !== undefined) throw new Error(`anvil_setBalance failed: ${JSON.stringify(body.error)}`)
}

/** Anvil-only: moves chain time forward and mines one block, for expiry tests. */
export async function increaseLocalTime(rpcUrl: string, seconds: bigint): Promise<void> {
  for (const [method, params] of [["evm_increaseTime", [Number(seconds)]], ["evm_mine", []]] as const) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    const body = (await response.json()) as { error?: unknown }
    if (body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
  }
}
