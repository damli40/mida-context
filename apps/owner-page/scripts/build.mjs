// Produces dist/: one JS bundle, one CSS file, the HTML — the exact directory the Worker serves
// through its static-assets binding. Runs offline; esbuild resolves everything from node_modules.

import { build } from "esbuild"
import { copyFile, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(appRoot, "dist")

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

await build({
  entryPoints: [join(appRoot, "src/check/main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: join(dist, "check.js"),
  sourcemap: false,
  minify: false,
  logLevel: "info",
})

// The owner flows' shared import surface, bundled alone: the browser-safe proof — no node:
// module may reach this output — is a built artifact, not a promise. The flow pages get their
// own entries on top of this same graph.
// Modules inside the browser graph (fake-vault.ts, the store client's chain-views.js) import the
// "@mida/chain" package barrel, whose index re-exports local.js (child_process, fs, net) and
// deployment-fs.js (fs). Those files cannot be edited in this round, so the bundle resolves the
// bare specifier to the browser entry file instead: same exports for everything the graph
// actually uses, zero node: specifiers to resolve. esbuild's `alias` option cannot express this —
// it rewrites "@mida/chain/browser" to "@mida/chain/browser/browser" — hence a one-line plugin.
const repoRoot = join(appRoot, "../..")
const browserEntries = {
  name: "mida-browser-entries",
  setup(build) {
    build.onResolve({ filter: /^@mida\/chain(\/browser)?$/ }, () => ({
      path: join(repoRoot, "packages/chain/src/browser.ts"),
    }))
  },
}

await build({
  entryPoints: [join(appRoot, "src/owner/core.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: join(dist, "owner-core.js"),
  sourcemap: false,
  minify: false,
  logLevel: "info",
  plugins: [browserEntries],
})

await copyFile(join(appRoot, "public/check.html"), join(dist, "check.html"))
await copyFile(join(appRoot, "public/check.css"), join(dist, "check.css"))

console.log("dist/: check.js, owner-core.js, check.css, check.html")
