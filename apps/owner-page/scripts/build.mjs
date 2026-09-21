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

await copyFile(join(appRoot, "public/check.html"), join(dist, "check.html"))
await copyFile(join(appRoot, "public/check.css"), join(dist, "check.css"))

console.log("dist/: check.js, check.css, check.html")
