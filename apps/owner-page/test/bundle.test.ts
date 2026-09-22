import { describe, expect, it } from "vitest"
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The browser-safe guarantee as a test, not a promise: the owner page's shared import surface
 * (src/owner/core.ts, which pulls in @mida/chain, @mida/fake-vault, @mida/api through their
 * browser entries) is bundled for platform "browser" and the output must contain no node:
 * builtin specifier and no CommonJS require. A regression in any upstream file — a new
 * `import "node:fs"` on a re-exported module, a barrel that grew a node-only line — fails here.
 */
describe("owner-core browser bundle", () => {
  it("bundles with zero node: imports and no require() calls", async () => {
    const result = await build({
      entryPoints: [join(appRoot, "src/owner/core.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
      // Same redirect as scripts/build.mjs: modules inside the graph (fake-vault.ts,
      // chain-views.js) import the "@mida/chain" barrel, which re-exports node-only files that
      // cannot be edited this round — resolving the bare specifier to the browser entry keeps
      // the scan honest about what the page actually loads.
      plugins: [{
        name: "mida-browser-entries",
        setup(build) {
          build.onResolve({ filter: /^@mida\/chain(\/browser)?$/ }, () => ({
            path: join(appRoot, "../../packages/chain/src/browser.ts"),
          }))
        },
      }],
    })
    const code = result.outputFiles.map((file) => file.text).join("\n")
    // `require("…")` with a string literal is an actual CommonJS call site; the word alone can
    // appear inside comments or strings in third-party code and is not evidence of anything.
    expect(code).not.toMatch(/node:/)
    expect(code).not.toMatch(/\brequire\s*\(\s*["']/)
    // Guard against a vacuous pass: the graph must really contain the chain/vault/store code —
    // the ABIs alone are tens of KB, so a "bundle" this small would mean nothing was imported.
    expect(code.length).toBeGreaterThan(100_000)
  })
})
