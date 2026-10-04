#!/usr/bin/env node
// pnpm check:publish — the clean-folder proof: the two packages install from their tarballs and
// run on a machine that has never seen this repo.
//
//   build → npm pack both → fresh dir under the OS temp dir → npm init -y →
//   npm install <both tarballs> --ignore-scripts → assert:
//     · npx mida --help exits 0 and prints the command list
//     · npx mida doctor on an empty MIDA_HOME prints checks, never a stack
//     · npx mida-hook claude-code on empty stdin exits 0 inside 2 s
//     · npx mida-mcp refuses a bad flag on stderr; an empty home refuses at startup (no identity,
//       before any daemon); a registered identity in a marked project starts the stdio server
//       and exits cleanly when the client closes stdin
//     · a 6-line consumer importing the SDK runs under plain node and type-checks with tsc
//     · the installed packages hold no .ts source, no .env, no test/ dirs, nothing under
//       brand/, and no 64-hex literal that is not a committed public constant
//
// Needs the network only for `npm install` of third-party deps; if the sandbox has none it says
// so plainly and exits non-zero. It never runs an agent, a model, or a chain send.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { npmCommand, toConfigPath } from "./build-publish-lib.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PUBLISH = join(ROOT, "publish")
const names = JSON.parse(readFileSync(join(PUBLISH, "names.json"), "utf8"))

const failures = []
function check(ok, label) {
  console.log(`${ok ? "ok:" : "FAIL:"} ${label}`)
  if (!ok) failures.push(label)
}
function run(argv, options = {}) {
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", ...options })
}
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

// ---------- 1. build + pack ----------

console.log("== build:publish")
execFileSync(process.execPath, [join(ROOT, "scripts", "build-publish.mjs")], { stdio: "inherit" })

const work = mkdtempSync(join(tmpdir(), "mida-clean-install-"))
const packs = join(work, "packs")
mkdirSync(packs, { recursive: true })
const tarballs = []
for (const dir of ["cli", "sdk"]) {
  const out = spawnSync(npmCommand("npm"), ["pack", "--pack-destination", packs], { cwd: join(PUBLISH, dir), encoding: "utf8" })
  const file = (out.stdout ?? "").trim().split("\n").pop()
  check(out.status === 0 && file !== undefined && existsSync(join(packs, file)), `npm pack publish/${dir}`)
  if (file !== undefined) tarballs.push(join(packs, file))
}

// ---------- 2. fresh project, install ----------

const project = join(work, "project")
mkdirSync(project, { recursive: true })
execFileSync(npmCommand("npm"), ["init", "-y"], { cwd: project, stdio: "pipe" })
const install = run([npmCommand("npm"), "install", ...tarballs, "--ignore-scripts"], { cwd: project, timeout: 300_000 })
if (install.status !== 0) {
  console.log((install.stderr ?? "") + (install.stdout ?? ""))
  console.log("npm install failed — this check needs the network for third-party dependencies;")
  console.log("if this sandbox has no network that is the reason, and it is a real failure, not a pass.")
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
}
const cliDir = join(project, "node_modules", names.cli)
const sdkDir = join(project, "node_modules", names.sdk)
check(existsSync(cliDir), `${names.cli} installed`)
check(existsSync(sdkDir), `${names.sdk} installed`)

const env = { ...process.env, MIDA_HOME: join(work, "mida-home") }

// ---------- 3. binary assertions ----------

const help = run([npmCommand("npx"), "--no-install", "mida", "--help"], { cwd: project, env })
check(help.status === 0, "npx mida --help exits 0")
check((help.stdout ?? "").includes("usage: mida init"), "--help prints the command list")

const doctor = run([npmCommand("npx"), "--no-install", "mida", "doctor"], { cwd: project, env, timeout: 30_000 })
const doctorText = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`
check(
  doctorText.split("\n").some((line) => line.startsWith("ok:") || line.startsWith("PROBLEM:")),
  "mida doctor prints its checks on an empty home",
)
check(!/^\s+at\s/m.test(doctorText) && !doctorText.includes("node:internal"), "mida doctor prints no stack trace")

const hook = run([npmCommand("npx"), "--no-install", "mida-hook", "claude-code"], { cwd: project, env, input: "", timeout: 2_000 })
check(hook.status === 0 && !hook.error, "mida-hook claude-code on empty stdin exits 0 inside 2 s")

// the MCP adapter is a long-lived stdio server — what a spawn can prove is the refusal paths and
// that a well-formed launch comes up even with no daemon to reach, then exits on stdin close.
// the marker check runs before the startup gate: a folder without network.json is not a Mida
// home at all, so this fixture writes one — an empty object is enough; the daemon spawn it
// triggers exits on the malformed file rather than doing real chain work.
mkdirSync(env.MIDA_HOME, { recursive: true })
writeFileSync(join(env.MIDA_HOME, "network.json"), "{}\n")
// an empty home has no registered identity, so the launches below refuse at the gate — a wrong
// MIDA_HOME must never start a key-less daemon in the wrong place
const mcpBad = run([npmCommand("npx"), "--no-install", "mida-mcp", "--bogus"], { cwd: project, env, input: "", timeout: 10_000 })
check(
  mcpBad.status === 2 && (mcpBad.stderr ?? "").includes("usage: mida-mcp") && (mcpBad.stdout ?? "") === "",
  "mida-mcp --bogus exits 2 with the usage on stderr and a clean stdout",
)
// --as is required, and `assistant` is never a valid client identity — each client carries its
// own (mida install <client> provisions it), so both launch forms refuse before any daemon work
const mcpNoAs = run([npmCommand("npx"), "--no-install", "mida-mcp"], { cwd: project, env, input: "", timeout: 10_000 })
check(
  mcpNoAs.status === 2 && (mcpNoAs.stderr ?? "").includes("--as") && (mcpNoAs.stdout ?? "") === "",
  "mida-mcp without --as refuses at startup, on stderr",
)
const mcpAssistant = run([npmCommand("npx"), "--no-install", "mida-mcp", "--as", "assistant"], { cwd: project, env, input: "", timeout: 10_000 })
check(
  mcpAssistant.status === 2 && (mcpAssistant.stderr ?? "").includes("general assistant") && (mcpAssistant.stdout ?? "") === "",
  "mida-mcp --as assistant refuses — a general assistant never reads project context",
)
const mcpEmpty = run([npmCommand("npx"), "--no-install", "mida-mcp", "--as", "testclient"], { cwd: project, env, input: "", timeout: 10_000 })
check(
  mcpEmpty.status === 2 && (mcpEmpty.stderr ?? "").includes('no agent "testclient" is set up') && (mcpEmpty.stdout ?? "") === "",
  "mida-mcp on an empty home refuses at startup, naming the missing identity, on stderr",
)
mkdirSync(join(env.MIDA_HOME, "agents", "testclient"), { recursive: true })
writeFileSync(join(env.MIDA_HOME, "agents", "testclient", "identity.json"), "{}")
const mcpProject = join(work, "mida-project")
mkdirSync(join(mcpProject, ".mida"), { recursive: true })
writeFileSync(join(mcpProject, ".mida", "project.json"), JSON.stringify({ projectId: "p1" }))
const mcp = run([npmCommand("npx"), "--no-install", "mida-mcp", "--as", "testclient", "--project", mcpProject], { cwd: project, env, input: "", timeout: 10_000 })
check(mcp.status === 0 && !mcp.error, "mida-mcp starts with a registered identity and a marked project, and exits when the client closes stdio")

// ---------- 4. SDK consumer: runs under node, type-checks with tsc ----------

const consumerJs = join(project, "consumer.mjs")
writeFileSync(
  consumerJs,
  `import { Mida, MidaSdkError, isMidaSdkError } from ${JSON.stringify(names.sdk)}\n\n// the SDK loads and exposes the Mida class, the typed error and the type guard\nif (typeof Mida !== "function" || typeof isMidaSdkError !== "function") process.exit(1)\nif (!isMidaSdkError(new MidaSdkError("invalid-option", "x"), "invalid-option")) process.exit(1)\nconst mida = new Mida({ agent: "consumer" })\nfor (const method of ["context", "remember", "requestAccess", "verify", "handoff", "whatsNew", "status"]) {\n  if (typeof mida[method] !== "function") process.exit(1)\n}\nconsole.log("sdk ok")\n`,
)
const consumer = run([process.execPath, consumerJs], { cwd: project, env })
check(consumer.status === 0 && (consumer.stdout ?? "").trim() === "sdk ok", "SDK consumer runs under plain node")

writeFileSync(
  join(project, "consumer.ts"),
  `import { Mida, MidaSdkError, isMidaSdkError } from ${JSON.stringify(names.sdk)}\nimport type { ContextInput, ContextItem, ContextResult, MidaOptions, Transport, VerifyResult } from ${JSON.stringify(names.sdk)}\nconst options: MidaOptions = { agent: "consumer" }\nconst mida: Transport = new Mida(options)\nconst input: ContextInput = { namespace: "projects.current", limit: 1024 }\nexport { mida, input, MidaSdkError, isMidaSdkError }\nexport type { ContextItem, ContextResult, VerifyResult }\n`,
)
writeFileSync(
  join(project, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [toConfigPath(join(ROOT, "node_modules", "@types"))],
    },
    include: ["consumer.ts"],
  }),
)
const tsc = run([process.execPath, join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
  cwd: project,
  timeout: 120_000,
})
check(tsc.status === 0, `SDK consumer type-checks with tsc --noEmit${tsc.status === 0 ? "" : ` (${(tsc.stdout ?? "").split("\n")[0]})`}`)

// ---------- 5. what shipped inside the tarballs ----------

// The scan's job is to catch a secret baked into the bundle. A 64-hex literal that is also in
// the committed source is a public constant (a namespace id, a policy hash, a curve parameter);
// one that is not would be a generated secret — so every literal must appear in the repo.
const sourceLiterals = new Set()
for (const scope of ["apps", "packages", "contracts", "scripts", "publish"]) {
  const base = join(ROOT, scope)
  if (!existsSync(base)) continue
  for (const file of walk(base)) {
    if (/node_modules|\.tgz$/.test(file)) continue
    try {
      for (const match of readFileSync(file, "utf8").matchAll(/0x[0-9a-fA-F]{64}/g)) sourceLiterals.add(match[0])
    } catch {
      // an unreadable source file contributes nothing — it also ships nothing
    }
  }
}

for (const pkg of [cliDir, sdkDir]) {
  const rel = toConfigPath(relative(project, pkg))
  // only the package's own files — a nested node_modules is npm's dep copies, not our ship list;
  // the rel path is forward-slashed so the segment checks below work on Windows too
  const files = [...walk(pkg)]
    .map((f) => ({ abs: f, rel: toConfigPath(relative(pkg, f)) }))
    .filter((f) => !f.rel.split("/").includes("node_modules"))
  check(files.every((f) => !f.rel.endsWith(".ts") || f.rel.endsWith(".d.ts")), `${rel}: no .ts source except .d.ts`)
  check(files.every((f) => !/(^|\/)\.env(\.|$)/.test(f.rel)), `${rel}: no .env`)
  check(files.every((f) => !/(^|\/)test(s)?\//.test(f.rel)), `${rel}: no test folders`)
  check(files.every((f) => !f.rel.includes("brand")), `${rel}: nothing under brand/`)
  const alien = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file.abs, "utf8")
    } catch {
      continue
    }
    for (const match of text.matchAll(/0x[0-9a-fA-F]{64}/g)) {
      if (!sourceLiterals.has(match[0])) alien.push(`${file.rel}: ${match[0].slice(0, 18)}…`)
    }
  }
  check(alien.length === 0, `${rel}: every 64-hex literal is a committed public constant${alien.length === 0 ? "" : ` — alien: ${alien.join(", ")}`}`)
}

// ---------- done ----------

rmSync(work, { recursive: true, force: true })
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nclean-install check passed")
