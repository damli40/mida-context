// in-12 N-2 — the owner page's browser bundle reaches rpcTransport (sponsored.ts → transport.ts),
// and a browser realm has no `process`: any unguarded process.env read throws ReferenceError on
// the first request. This test BUILDS the browser entrypoint and RUNS it inside node:vm with no
// `process` global — a real request must go out and resolve, for both a public URL and loopback.
import { describe, expect, it } from "vitest"
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const HERE = dirname(fileURLToPath(import.meta.url))
const BROWSER_ENTRY = join(HERE, "..", "src", "browser.ts")

describe("the browser bundle (in-12 N-2)", () => {
  it("rpcTransport sends and resolves inside a realm with no `process` global", async () => {
    const entry = `
      import { rpcTransport } from ${JSON.stringify(BROWSER_ENTRY)}
      import { createPublicClient } from "viem"
      import { monadTestnet } from "viem/chains"
      globalThis.__run = async (url) => {
        const client = createPublicClient({ chain: monadTestnet, transport: rpcTransport(url) })
        return client.request({ method: "eth_chainId" })
      }
    `
    const result = await build({
      stdin: { contents: entry, resolveDir: HERE, loader: "ts" },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "mida-browser",
          setup(b) {
            b.onResolve({ filter: /^@mida\/chain(\/browser)?$/ }, () => ({ path: BROWSER_ENTRY }))
          },
        },
      ],
    })
    const code = result.outputFiles[0]!.text
    // the env knob must not appear as a bare `process` read anywhere the bundle can evaluate it
    expect(code.match(/(?<!globalThis\.)process\.env\.MIDA_RPC_MAX_PER_SECOND/g) ?? []).toEqual([])

    const sent: { url: string; body: unknown }[] = []
    const sandbox: Record<string, unknown> = {
      fetch: async (url: unknown, init?: { body?: string }) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        const id = (sent[sent.length - 1]!.body as { id?: unknown }).id
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result: "0x279f" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      Response,
      Request,
      Headers,
      URL,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      console,
      crypto: globalThis.crypto,
      DOMException,
    }
    sandbox.globalThis = sandbox
    sandbox.window = sandbox
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    const run = sandbox.__run as (url: string) => Promise<unknown>
    // a public RPC origin and a loopback one — the loopback branch used to read process.env too
    await expect(run("https://testnet-rpc.monad.xyz")).resolves.toBe("0x279f")
    await expect(run("http://127.0.0.1:8545")).resolves.toBe("0x279f")
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => (s.body as { method?: string }).method === "eth_chainId")).toBe(true)
  }, 120_000)
})
