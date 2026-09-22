#!/usr/bin/env node
// pnpm build:publish — builds the two installable packages under publish/:
//
//   publish/cli/dist/{mida,midad,mida-drain,mida-hook,mida-inject,mida-mcp}.js — one bundled ESM file
//     per entry point with a node shebang; every @mida/* workspace package is bundled in, every
//     third-party package stays external and lands in the generated package.json at the exact
//     version the workspace itself uses. kimi-model.mjs ships as-is beside the bundles.
//   publish/sdk/dist/index.js + index.d.ts — the SDK's public entry as ESM, with the inlined
//     workspace packages' declarations emitted under dist/types/ and every @mida/* specifier
//     rewritten to a relative path, so a consumer's tsc sees full types and no unresolved import.
//
// publish/*/package.json is generated from publish/names.json + the committed *.template.json —
// the package names live in that one file and nowhere else.
import { execFileSync } from "node:child_process"
import { buildSync } from "esbuild"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PUBLISH = join(ROOT, "publish")
const names = JSON.parse(readFileSync(join(PUBLISH, "names.json"), "utf8"))

const CLI_ENTRIES = {
  "mida": "apps/midad/src/cli.ts",
  "midad": "apps/midad/src/daemon-main.ts",
  "mida-drain": "apps/midad/src/drain-main.ts",
  "mida-hook": "apps/midad/src/hook-main.ts",
  "mida-inject": "apps/midad/src/inject-main.ts",
  "mida-mcp": "apps/midad/src/mcp-main.ts",
}

/** Every workspace package, keyed by name, discovered from its own package.json. */
function workspacePackages() {
  const map = new Map()
  for (const scope of ["packages", "apps"]) {
    const base = join(ROOT, scope)
    for (const dir of readdirSync(base)) {
      const manifestPath = join(base, dir, "package.json")
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      map.set(manifest.name, { dir: join(base, dir), manifest })
    }
  }
  return map
}

/** The workspace-dependency closure of `start` — every @mida/* package the bundle must inline. */
function workspaceClosure(start) {
  const ws = workspacePackages()
  const seen = new Set()
  const queue = [start]
  while (queue.length > 0) {
    const name = queue.pop()
    if (seen.has(name)) continue
    seen.add(name)
    const entry = ws.get(name)
    if (entry === undefined) throw new Error(`workspace package ${name} not found`)
    for (const dep of Object.keys(entry.manifest.dependencies ?? {})) {
      if (dep.startsWith("@mida/")) queue.push(dep)
    }
  }
  return [...seen]
}

/**
 * The third-party runtime dependencies of the closure, at the exact versions the workspace
 * declares — generated, never hand-copied. A version disagreement between two bundled packages
 * fails the build rather than silently picking one.
 */
function externalDependencies(packageNames) {
  const ws = workspacePackages()
  const deps = {}
  for (const name of packageNames) {
    for (const [dep, version] of Object.entries(ws.get(name).manifest.dependencies ?? {})) {
      if (dep.startsWith("@mida/")) continue
      if (deps[dep] !== undefined && deps[dep] !== version) {
        throw new Error(`version conflict for ${dep}: ${deps[dep]} vs ${version}`)
      }
      deps[dep] = version
    }
  }
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
}

/** esbuild `external` patterns for a dependency set — the package and every subpath. */
function externals(deps) {
  return Object.keys(deps).flatMap((dep) => [dep, `${dep}/*`])
}

/** Generates publish/<dir>/package.json from names.json + the committed template. */
function writePackageManifest(dir, name, templateFile, dependencies) {
  const template = JSON.parse(readFileSync(join(PUBLISH, templateFile), "utf8"))
  const manifest = { name, ...template, dependencies }
  writeFileSync(join(PUBLISH, dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

// ---------- CLI bundle ----------

const cliPkgs = workspaceClosure("@mida/midad")
const cliDeps = externalDependencies(cliPkgs)
const cliDist = join(PUBLISH, "cli", "dist")
rmSync(cliDist, { recursive: true, force: true })
mkdirSync(cliDist, { recursive: true })

buildSync({
  entryPoints: Object.entries(CLI_ENTRIES).map(([out, source]) => ({ in: join(ROOT, source), out })),
  outdir: cliDist,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: externals(cliDeps),
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
})
for (const file of readdirSync(cliDist).filter((f) => f.endsWith(".js"))) chmodSync(join(cliDist, file), 0o755)
// The checkpoint compiler spawns these scripts by path relative to its own module —
// openai-compatible-model.mjs is the real call; kimi-model.mjs is the compat shim that execs
// it. Both ship byte-for-byte beside the bundles.
copyFileSync(join(ROOT, "packages/compiler/src/openai-compatible-model.mjs"), join(cliDist, "openai-compatible-model.mjs"))
copyFileSync(join(ROOT, "packages/compiler/src/kimi-model.mjs"), join(cliDist, "kimi-model.mjs"))
writePackageManifest("cli", names.cli, "cli.package.template.json", cliDeps)

// ---------- SDK bundle ----------

const sdkPkgs = workspaceClosure("@mida/sdk")
const sdkDeps = externalDependencies(sdkPkgs)
const sdkDist = join(PUBLISH, "sdk", "dist")
rmSync(sdkDist, { recursive: true, force: true })
mkdirSync(sdkDist, { recursive: true })

buildSync({
  entryPoints: [{ in: join(ROOT, "packages/sdk/src/index.ts"), out: "index" }],
  outdir: sdkDist,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: externals(sdkDeps),
  logLevel: "info",
})

// Declarations: one tsc emit over the SDK's whole workspace closure, then every emitted file is
// relocated under dist/types/<pkg>/ and its @mida/* specifiers rewritten to relative paths.
const emitDir = mkdtempSync(join(tmpdir(), "mida-dts-"))
const tsconfig = join(emitDir, "tsconfig.json")
writeFileSync(
  tsconfig,
  JSON.stringify({
    extends: join(ROOT, "tsconfig.json"),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: ROOT,
      outDir: emitDir,
      // typeRoots defaults to a walk up from THIS file — a temp dir finds no @types, so pin it
      typeRoots: [join(ROOT, "node_modules", "@types")],
    },
    include: sdkPkgs.flatMap((name) => [join(workspacePackages().get(name).dir, "src", "**", "*.ts")]),
  }),
)
execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", tsconfig], { stdio: "inherit" })

const shortName = (name) => name.replace(/^@mida\//, "")
const specifiers = /(from\s*|import\s*\()\s*["']@mida\/([a-z-]+)([^"']*)["']/g
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}
for (const emitted of walk(emitDir)) {
  if (!emitted.endsWith(".d.ts")) continue
  // emitDir mirrors the repo: <packages|apps>/<dir>/src/<rest>.d.ts → dist/types/<pkg>/<rest>.d.ts
  const rel = relative(emitDir, emitted)
  const match = rel.match(/^(?:packages|apps)\/([^/]+)\/src\/(.+)$/)
  if (match === null) throw new Error(`unexpected emitted declaration path ${rel}`)
  const [, pkgDir, rest] = match
  const sourceText = readFileSync(emitted, "utf8")
  const rewritten = sourceText.replace(specifiers, (_m, kind, dep, rest_) => {
    const target = rest_ === "" ? `../${dep}/index.js` : `../${dep}${rest_}`
    return `${kind}"${target}"`
  })
  const out = join(sdkDist, "types", pkgDir, rest)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, rewritten)
}
// The public entry: a single barrel onto the emitted SDK declarations — a consumer's
// `import { MidaAgent } from "<sdk>"` resolves ./types/sdk/index.d.ts and never sees @mida/*.
writeFileSync(join(sdkDist, "index.d.ts"), `export * from "./types/sdk/index.js"\n`)
writePackageManifest("sdk", names.sdk, "sdk.package.template.json", sdkDeps)

rmSync(emitDir, { recursive: true, force: true })
console.log(`built publish/cli (${names.cli}) and publish/sdk (${names.sdk})`)
