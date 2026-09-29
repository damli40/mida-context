import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BaseError, HttpRequestError } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, NEEDS_TERMINAL_LINE, Runtime, USAGE, approveProject, checkProject, devinHooksStatus, loadAgentIdentity, loadOrCreateOwnerSecrets, loadOwnerAddress, macosProtectedFolderNote, ownerCommandNotice, ownerRefusalLine, runCli, runCliWithRuntime, runDoctor, FileAccessRequestStore, saveAgentIdentity, CLI_COMMANDS, OWNER_COMMANDS, TERMINAL_COMMANDS } from "@mida/midad"
import type { AgentIdentity, Network, ResolvedNetwork, ServiceRuntime } from "@mida/midad"
import { accessRequestTypedData, encodeUint64 } from "@mida/protocol"
import type { AccessRequest, Hex } from "@mida/protocol"
import { manifestBodyHash } from "@mida/grant-advisor"
import { FakeVaultAuthority } from "@mida/fake-vault"
import { AGENT_ID, manifestBody, signManifest } from "../../../packages/grant-advisor/test/fixtures.js"

describe("the crude mida command", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  // the folder the owner-commands "run in" — `approve` writes this folder's row into the
  // owner-signed approved-projects list, which is exactly what `read <agent> <projectId>`
  // checks for since the G12 gate landed
  let projectDir: string
  const lines: string[] = []
  // the prompt dep stands in for a human typing at the terminal — every approve here answers yes —
  // and the terminal deps stand in for the real TTY the owner commands refuse to run without
  const run = (...argv: string[]) =>
    runCli(argv, { home, network, cwd: projectDir, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-")))
    projectDir = mkdtempSync(join(tmpdir(), "mida-cli-proj-"))
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("rejects an unknown command, an unknown agent and a missing project with exit code 2", async () => {
    expect(await run("frobnicate")).toBe(2)
    expect(await run("approve", "cursor")).toBe(2)
    expect(await run("read", "codex")).toBe(2)
  })

  it("walks the whole demo: init, approve both, save, read, revoke, refused", async () => {
    expect(await run("init")).toBe(0)
    expect(await run("request", "claude-code")).toBe(0)
    expect(await run("approve", "claude-code")).toBe(0)
    // approve wrote this folder's marker — reads name ITS project id; any other
    // id answers project-mismatch before the store is ever asked (L1)
    const projectId = (JSON.parse(readFileSync(join(projectDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    expect(await run("save-demo", "claude-code", projectId)).toBe(0)
    expect(await run("read", "codex", projectId)).toBe(1)
    expect(await run("request", "codex")).toBe(0)
    expect(await run("approve", "codex")).toBe(0)
    expect(await run("read", "codex", projectId)).toBe(0)
    expect(await run("revoke", "claude-code")).toBe(0)
    expect(await run("read", "claude-code", projectId)).toBe(1)
    expect(await run("read", "codex", projectId)).toBe(0)
    // the G12 folder gate answers before the chain is asked — and the marker revoke left behind
    // turns the not-approved answer into the honest "the owner revoked this" line
    expect(lines).toContain(
      "Mida: claude-code's access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.",
    )
  }, 300_000)

  it("request on an already-approved agent is guidance, not a failure — exit 0 (in-15 J-5)", async () => {
    // Sep 27 live: `request claude-code && request codex && request devin` stopped at the first
    // — the already-approved line is the honest next step, so it must not break a && chain.
    // Self-contained: approve a fresh agent here so the second request really is the second.
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-j5-")))
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home: fresh, network, cwd: projectDir, print: (line) => out.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("init")).toBe(0)
    expect(await run2("request", "codex")).toBe(0)
    expect(await run2("approve", "codex")).toBe(0)
    out.length = 0
    expect(await run2("request", "codex")).toBe(0)
    expect(out).toContain(
      "codex is already approved on chain. To use it in THIS folder, run `mida approve codex` here (no transaction, nothing to pay).",
    )
  }, 300_000)

  it("kicks the daemon after a successful approve and revoke so the service notices, and never otherwise", async () => {
    const kicks: string[] = []
    const kick = () => (kicks.push("x"), Promise.resolve())
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: () => {}, kickDaemon: kick, prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    // request grants nothing by itself — no kick
    expect(await run2("request", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(1)
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(2)
    // a command that fails does not kick: claude-code has no pending request now
    expect(await run2("approve", "claude-code")).toBe(1)
    expect(kicks).toHaveLength(2)
    // undo the revoke so the last test's home still has a live agent
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("a successful init clears a recorded out-of-gas wait so the session's saves resume at once (in-29 S-2)", async () => {
    // the drain's own backoff record for a session whose last save the chain refused for gas —
    // init's funding pass makes it stale, so the wait must not hold the retry back another
    // backoff period
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-gasreset-")))
    fresh.writeSecretJson("queue/state/s-gas.json", {
      transcriptBytes: 10,
      lastLineHash: "",
      savedAt: "2026-09-29T10:00:00.000Z",
      attempts: 5,
      failedAt: new Date().toISOString(),
      reason: "out-of-gas",
    })
    const run2 = (...argv: string[]) =>
      runCli(argv, { home: fresh, network, print: () => {}, prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("init")).toBe(0)
    const state = fresh.readJson<{ attempts?: number; failedAt?: string }>("queue/state/s-gas.json")
    expect(state?.attempts).toBeUndefined()
    expect(state?.failedAt).toBeUndefined()
  }, 300_000)

  it("approve prints the ask and the advice, waits for 'yes', and signs nothing without it", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const answers: string[] = []
    const printedBeforeAsk: (string | undefined)[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); printedBeforeAsk.push(lines.at(-1)); return answers.shift() ?? "" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code is live from the tests above; a fresh ask needs a revoked agent first
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    answers.push("no")
    expect(await run2("approve", "claude-code")).toBe(1)
    // the owner saw the request, the advisor's read on it, and the question — then declined
    expect(lines.some((line) => line.includes("claude-code is asking for"))).toBe(true)
    expect(lines.some((line) => line.includes("grant advisor"))).toBe(true)
    expect(asked).toEqual(["Type yes to approve: "])
    // the disclosure is the last thing printed before the ask: plain text now, no recall later
    expect(printedBeforeAsk[0]).toBe("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
    expect(lines).toContain("not approved")
    // nothing was signed: the pending request is still there, waiting
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)
    // an explicit yes signs
    answers.push("yes")
    expect(await run2("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve, revoke and remember refuse when there is no real terminal; init is exempt", async () => {
    const refusals: string[] = []
    const noStdin = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => refusals.push(line), prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true })
    const noStdout = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => refusals.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: false })
    expect(await noStdin("approve", "claude-code")).toBe(2)
    expect(await noStdin("revoke", "claude-code")).toBe(2)
    expect(await noStdin("remember", "a fact")).toBe(2)
    expect(await noStdout("approve", "claude-code")).toBe(2)
    expect(refusals.filter((line) => line === NEEDS_TERMINAL_LINE)).toHaveLength(4)
    // init changes no agent's access, so it may run without a terminal
    expect(await noStdin("init")).toBe(0)
  }, 300_000)

  it("the yes-prompt drains whatever was already buffered before it asks, then waits for a fresh answer (R4-10)", async () => {
    const order: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: () => {},
        drainInput: async () => { order.push("drain") },
        prompt: async () => { order.push("prompt"); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a fresh ask needs a revoked-then-requested agent
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    // the drain ran before the question was printed — input pasted while approve ran is dropped
    expect(order).toEqual(["drain", "prompt"])
  }, 300_000)

  it("install claude-desktop registers its own identity, files the pending request and writes the client config (I1)", async () => {
    const lines: string[] = []
    const work = mkdtempSync(join(tmpdir(), "mida-desktop-work-"))
    mkdirSync(join(work, ".mida"))
    writeFileSync(join(work, ".mida", "project.json"), JSON.stringify({ projectId: "p-desktop" }))
    const config = join(mkdtempSync(join(tmpdir(), "mida-desktop-cfg-")), "claude_desktop_config.json")
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
        cwd: work, claudeDesktopConfig: config,
      })
    expect(await run2("install", "claude-desktop")).toBe(0)
    // the identity is the client's own — a project-context agent, never `assistant`
    const identity = loadAgentIdentity(home, "claude-desktop")
    expect(identity?.name).toBe("claude-desktop")
    expect(identity?.purposeId).not.toBe("general_assistance")
    // the pending request is what `mida approve claude-desktop` in this folder completes
    expect(home.has("agents/claude-desktop/pending-request.json")).toBe(true)
    const entry = JSON.parse(readFileSync(config, "utf8")).mcpServers["mida-claude-desktop"]
    expect(entry.args).toEqual(["--as", "claude-desktop", "--project", work])
    expect(entry.env).toEqual({ MIDA_HOME: home.root })
    expect(lines).toContain("next: run `mida approve claude-desktop` in this folder")
    // a re-run is a no-op: same file, no new identity, no second request
    expect(await run2("install", "claude-desktop")).toBe(0)
    expect(lines.filter((line) => line === "already installed")).toHaveLength(1)
    // the registered client name is a real approve target even though it is not a built-in agent
    expect(await run2("approve", "claude-desktop")).toBe(0)
    expect(lines.some((line) => line.startsWith("approved claude-desktop"))).toBe(true)
  }, 300_000)

  it("install cursor writes <cwd>/.cursor/mcp.json with ${workspaceFolder} and its own identity (I1)", async () => {
    const lines: string[] = []
    const work = mkdtempSync(join(tmpdir(), "mida-cursor-work-"))
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true, cwd: work,
      })
    expect(await run2("install", "cursor")).toBe(0)
    const entry = JSON.parse(readFileSync(join(work, ".cursor", "mcp.json"), "utf8")).mcpServers["mida-cursor"]
    expect(entry.args).toEqual(["--as", "cursor", "--project", "${workspaceFolder}"])
    expect(entry.env).toEqual({ MIDA_HOME: home.root })
    expect(loadAgentIdentity(home, "cursor")?.name).toBe("cursor")
    expect(lines).toContain("next: run `mida approve cursor` in this folder")
    // the per-workspace config carries personal absolute paths — the owner is told not to commit it
    expect(lines.filter((line) => line.includes(".cursor/mcp.json") && line.includes("commit"))).toHaveLength(1)
  }, 300_000)

  it("install warns when the launcher sits inside a macOS-protected folder — and installs anyway (in-15 J-7)", async () => {
    // Sep 27 live: Claude Desktop's MCP entry showed "Server disconnected"; its log said
    // /bin/sh: …/bin/mida-mcp: Operation not permitted. macOS blocks apps without Files and
    // Folders access from exec'ing a launcher under ~/Desktop, ~/Documents or ~/Downloads.
    const fakeHome = mkdtempSync(join(tmpdir(), "mida-macos-home-"))
    const protectedLauncher = join(fakeHome, "Desktop", "mida-context", "bin", "mida-mcp")
    const config = join(mkdtempSync(join(tmpdir(), "mida-desktop-cfg-")), "claude_desktop_config.json")
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
        cwd: projectDir, claudeDesktopConfig: config,
        homeDir: fakeHome, platform: "darwin", launcherPath: protectedLauncher,
      })
    expect(await run2("install", "claude-desktop")).toBe(0)
    // the warning names both fixes — grant the app access, or run Mida outside the three folders
    expect(lines).toContain(
      `note: macOS protects ~/Desktop, ~/Documents and ~/Downloads — the mida-claude-desktop launcher ` +
        `is inside one at ${protectedLauncher}, so macOS may block Claude Desktop from running it: ` +
        `grant Claude Desktop access in System Settings → Privacy & Security → Files and Folders, or run Mida outside those folders`,
    )
    // and the install still lands — the note is a warning, never a refusal
    expect(JSON.parse(readFileSync(config, "utf8")).mcpServers["mida-claude-desktop"].args).toContain("--as")

    // a launcher outside the three folders — or any install off macOS — earns no note
    const lines2: string[] = []
    const runLinux = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines2.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
        cwd: mkdtempSync(join(tmpdir(), "mida-cursor-work-")),
        homeDir: fakeHome, platform: "linux", launcherPath: protectedLauncher,
      })
    expect(await runLinux("install", "cursor")).toBe(0)
    expect(lines2.every((line) => !line.includes("macOS protects"))).toBe(true)
    const lines3: string[] = []
    const runOutside = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines3.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
        cwd: mkdtempSync(join(tmpdir(), "mida-cursor-work-")),
        homeDir: fakeHome, platform: "darwin", launcherPath: join(fakeHome, "opt", "mida", "bin", "mida-mcp"),
      })
    expect(await runOutside("install", "cursor")).toBe(0)
    expect(lines3.every((line) => !line.includes("macOS protects"))).toBe(true)
  }, 300_000)

  it("the macOS protected-folder check sees through symlinks and case (in-16 K-8)", () => {
    // The J-7 check was a plain string prefix on the typed path: a checkout reached through a
    // symlink (~/work → ~/Desktop/app) or a case-different spelling never warned. Both sides are
    // now resolved to real paths and lowercased before the prefix compare.
    const homeDir = mkdtempSync(join(tmpdir(), "mida-j7-home-"))
    mkdirSync(join(homeDir, "Desktop", "mida-context", "bin"), { recursive: true })
    const realLauncher = join(homeDir, "Desktop", "mida-context", "bin", "mida-mcp")
    writeFileSync(realLauncher, "#!/bin/sh\n")
    // a launcher reached through a symlink that hides the protected folder
    symlinkSync(join(homeDir, "Desktop", "mida-context"), join(homeDir, "work"))
    const linkedLauncher = join(homeDir, "work", "bin", "mida-mcp")
    expect(macosProtectedFolderNote("cursor", linkedLauncher, homeDir, "darwin")).toContain("macOS protects")
    // the resolved real path of that same launcher
    expect(macosProtectedFolderNote("cursor", realpathSync(linkedLauncher), homeDir, "darwin")).toContain("macOS protects")
    // a case-different spelling — macOS's filesystem matches case-insensitively
    expect(macosProtectedFolderNote("cursor", join(homeDir, "desktop", "mida-context", "bin", "mida-mcp"), homeDir, "darwin")).toContain("macOS protects")
    // a path genuinely outside the folders still earns no note
    expect(macosProtectedFolderNote("cursor", join(homeDir, "opt", "bin", "mida-mcp"), homeDir, "darwin")).toBeUndefined()
    // and a sibling whose name merely shares the prefix ("Desktops") is not a match
    mkdirSync(join(homeDir, "Desktops", "bin"), { recursive: true })
    const sibling = join(homeDir, "Desktops", "bin", "mida-mcp")
    writeFileSync(sibling, "#!/bin/sh\n")
    expect(macosProtectedFolderNote("cursor", sibling, homeDir, "darwin")).toBeUndefined()
  })

  it("install devin provisions the identity and writes the hook config — init alone registers no devin (in-9)", async () => {
    // A fresh home: `init` must NOT register a devin identity for an owner who never asked —
    // and `mida install devin` is where one comes from (the in-7 default-list change reversed).
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-devincli-")))
    const config = join(mkdtempSync(join(tmpdir(), "mida-devincfg-")), "config.json")
    const out: string[] = []
    const run3 = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: projectDir, print: (line) => out.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true, devinConfig: config,
      })
    expect(await run3("init")).toBe(0)
    expect(loadAgentIdentity(fresh, "devin")).toBeUndefined()

    expect(await run3("install", "devin")).toBe(0)
    // the install did the provisioning AND the hook edit — `mida approve devin` completes it
    expect(loadAgentIdentity(fresh, "devin")?.name).toBe("devin")
    expect(fresh.has("agents/devin/pending-request.json")).toBe(true)
    expect(devinHooksStatus(config)).toBe("installed")
    // this build does not know where Devin keeps MCP servers — the install says so, once
    const noMcpNote = "devin: MCP server not added. This build does not know where Devin keeps MCP servers; hooks are installed."
    expect(out).toContain(noMcpNote)
    expect(out).toContain("next: run `mida approve devin` in this folder")
    // --no-mcp on a rerun: hooks already there, no MCP attempted, the note stays silent
    expect(await run3("install", "devin", "--no-mcp")).toBe(0)
    expect(out.filter((line) => line === noMcpNote)).toHaveLength(1)
    // and the provisioned name is a real approve target even though it is not a default agent
    expect(await run3("approve", "devin")).toBe(0)
    expect(out.some((line) => line.startsWith("approved devin"))).toBe(true)
  }, 300_000)

  it("the real `mida install devin --no-mcp` reaches the owner command — not runInstall's refusal (in-28)", async () => {
    // main sends `install devin` (two words) to the owner path because it provisions an
    // identity; the three-word --no-mcp form instead fell into runInstall, which refuses
    // devin outright. A spawned non-TTY run answers needs-terminal ONLY if it reached the
    // owner path — the one discriminator between the two routes.
    const spawnHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-route-home-")))
    const deployment = env.deployment
    spawnHome.writeSecretJson("network.json", {
      rpcUrl: env.rpcUrl,
      deployment: {
        chainId: deployment.chainId.toString(10),
        capabilityRegistry: deployment.capabilityRegistry,
        contextRegistry: deployment.contextRegistry,
        deploymentBlock: deployment.deploymentBlock.toString(10),
        vaultRpId: deployment.vaultRpId,
        vaultRpIdHash: deployment.vaultRpIdHash,
        policyHashV1: deployment.policyHashV1,
        ...(deployment.batchAnchor === undefined
          ? {}
          : { batchAnchor: deployment.batchAnchor, batchAnchorBlock: deployment.batchAnchorBlock!.toString(10) }),
      },
    })
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(repo, "apps/midad/src/cli.ts"), "install", "devin", "--no-mcp"],
        {
          env: {
            HOME: mkdtempSync(join(tmpdir(), "mida-route-os-")),
            MIDA_HOME: spawnHome.root,
            PATH: process.env.PATH ?? "",
          },
          cwd: mkdtempSync(join(tmpdir(), "mida-route-cwd-")),
        },
      )
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")))
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")))
      child.on("error", reject)
      child.on("exit", (code) => done({ status: code, stdout, stderr }))
    })
    // needs-terminal says the owner path ran; "is an owner command" says runInstall refused it
    expect(res.status).toBe(2)
    expect(res.stdout).toContain(NEEDS_TERMINAL_LINE)
    expect(res.stdout).not.toContain("is an owner command")
  }, 120_000)

  it("an expired pending request refuses BEFORE the history scan — no 'about N requests' line (in-15 J-2)", async () => {
    // Sep 27 live: `approve --all` printed "checking devin's history on the chain (about 928
    // requests)…" before answering REQUEST_EXPIRED. The window needs only the chain's clock.
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-expired-")))
    const out: string[] = []
    const progress: string[] = []
    const run3 = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: projectDir, print: (line) => out.push(line),
        progress: (line) => progress.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await run3("init")).toBe(0)
    expect(await run3("request", "codex")).toBe(0)
    // a properly signed request whose window closed two hours ago — anvil's latest block is
    // always minutes old at worst, so this is safely expired by the chain's own clock
    const identity = loadAgentIdentity(fresh, "codex")!
    const pending = fresh.readJson<{ request: AccessRequest }>("agents/codex/pending-request.json")!.request
    const { agentSignature: _dropped, ...unsigned } = pending
    const wallNow = BigInt(Math.floor(Date.now() / 1000))
    const stale = {
      ...unsigned,
      requestId: `0x${randomBytes(32).toString("hex")}` as Hex,
      issuedAt: encodeUint64(wallNow - 7_260n),
      requestExpiresAt: encodeUint64(wallNow - 7_200n),
    }
    const request = { ...stale, agentSignature: await privateKeyToAccount(identity.signerPrivateKey).signTypedData(accessRequestTypedData(stale)) }
    await new FileAccessRequestStore(fresh, "codex").save(request)
    fresh.writeSecretJson("agents/codex/pending-request.json", { request })
    progress.length = 0
    expect(await run3("approve", "codex")).toBe(1)
    expect(out).toContain("codex's request has expired (a request lasts 5 minutes): run `mida request codex` and approve again")
    expect(progress.some((line) => line.includes("history on the chain"))).toBe(false)
  }, 300_000)

  it("install <client> asks for a real terminal like approve, a non-client is usage, the daemon refuses it", async () => {
    const out: string[] = []
    expect(await runCli(["install", "cursor"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true,
      cwd: mkdtempSync(join(tmpdir(), "mida-cursor-work-")),
    })).toBe(2)
    expect(out).toEqual([NEEDS_TERMINAL_LINE])
    // there is no chatgpt client — the ChatGPT desktop app is the Codex app and runs as `codex`
    expect(await run("install", "chatgpt")).toBe(2)
    expect(lines.at(-1)).toBe(USAGE)
    // through the daemon's /cli route it is refused like every owner command
    const refused: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["install", "cursor"], stub, (line) => refused.push(line))).toBe(2)
    expect(refused[0]).toContain("mida install")
  })

  it("MIDA_DEBUG=1 prints a masked debug line on failure; unset prints nothing extra (R4-8)", async () => {
    const hex = `0x${"ab".repeat(40)}`
    const failingPrompt = async () => {
      throw new Error(`execution reverted: ${hex} with more data`)
    }
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => out.push(line),
        drainInput: async () => {},
        prompt: failingPrompt,
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code was approved by the test above — a fresh ask needs it revoked and re-requested
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    const prev = process.env.MIDA_DEBUG
    try {
      process.env.MIDA_DEBUG = "1"
      out.length = 0
      expect(await run2("approve", "claude-code")).toBe(1)
      const debug = out.find((line) => line.startsWith("debug:"))
      expect(debug).toBeDefined()
      expect(debug).toContain("<hex>")
      expect(debug).not.toContain(hex)
      expect(out.some((line) => line.startsWith("refused:"))).toBe(true)
      delete process.env.MIDA_DEBUG
      out.length = 0
      expect(await run2("approve", "claude-code")).toBe(1)
      expect(out.every((line) => !line.startsWith("debug:"))).toBe(true)
      expect(out.join("\n")).not.toContain(hex)
    } finally {
      if (prev === undefined) delete process.env.MIDA_DEBUG
      else process.env.MIDA_DEBUG = prev
    }
    // restore: the pending request is still waiting — approve it for real
    expect(await run("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("remember names the context area before the ask and after the write, and waits for a typed yes (R5-3)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const order: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network,
        print: (line) => {
          lines.push(line)
          if (line.startsWith("area:")) order.push("area")
        },
        prompt: async (question) => {
          asked.push(question)
          order.push("prompt")
          return "yes"
        },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await run2("remember", "prefers short answers")).toBe(0)
    // the owner saw WHERE the fact will live before being asked to confirm, and again after it landed
    expect(lines).toContain("area: preferences.communication (agents with READ on this area will see it)")
    expect(asked).toEqual(["Type yes to remember: "])
    expect(lines.at(-1)).toMatch(/^remembered 0x[0-9a-f]{64} in preferences\.communication$/)
    expect(order).toEqual(["area", "prompt", "area"])
  }, 300_000)

  it("an answer other than yes stores nothing (R5-3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "no", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("remember", "should never be stored")).toBe(1)
    expect(lines).toContain("area: preferences.communication (agents with READ on this area will see it)")
    expect(lines.some((line) => line.startsWith("remembered "))).toBe(false)
    // and the declined fact is really not there to read back
    lines.length = 0
    expect(await run2("read", "--as", "claude-code")).toBe(0)
    expect(lines.join("\n")).not.toContain("should never be stored")
  }, 300_000)

  it("mida read labels every item with the context area it lives in (R5-3)", async () => {
    const lines: string[] = []
    // run in the folder the shared `run` helper approves agents into — the G12 folder gate
    // reads the approved-projects row the last `run("approve", "claude-code")` wrote there
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, cwd: projectDir, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    // a fact from the remember test above, labelled with its area
    expect(await run2("read", "--as", "claude-code")).toBe(0)
    // every fact line names itself since in-4 I8: its short id and the chain's stamp follow the text
    expect(lines.some((line) => /^  preferences\.communication: prefers short answers \(id [0-9a-f]{8}, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/.test(line))).toBe(true)
    // checkpoints carry their area too — resolved from the record's namespace id.
    // The project id read must be THIS folder's marker id (L1) — anything else mismatches.
    const projectId = (JSON.parse(readFileSync(join(projectDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    expect(await run2("save-demo", "claude-code", projectId)).toBe(0)
    lines.length = 0
    expect(await run2("read", "claude-code", projectId)).toBe(0)
    expect(lines.some((line) => /^  projects\.current: 0x[0-9a-f]{64} written by /.test(line))).toBe(true)
  }, 300_000)

  it("a fact holding terminal escapes and a bidi override prints one clean line (in-40 L-4)", async () => {
    const before = lines.length
    // ESC+[, the bidi override and a newline all count as terminal paint; remember accepts them
    // (they are refused only in fields that carry meaning), so the print layer must fold them
    expect(await run("remember", "plain start[2J[Hmiddle‮end\nrest")).toBe(0)
    expect(await run("read", "--as", "claude-code")).toBe(0)
    const dirty = lines.slice(before).find((line) => line.includes("plain start") && line.includes("(id "))
    expect(dirty).toBeDefined()
    // every refused character became one space, collapsed — the fact stays one printed line
    expect(dirty).toMatch(/^  preferences\.communication: plain start \[2J \[Hmiddle end rest \(id [0-9a-f]{8}/)
    expect(dirty).not.toContain("")
    expect(dirty).not.toContain("‮")
    expect(dirty).not.toContain("\n")
  })

  it("a fact's zero-width joiners survive the display fold (in-40 L-4)", async () => {
    const before = lines.length
    expect(await run("remember", "can be ‍ joined")).toBe(0)
    const after = lines.length
    expect(await run("read", "--as", "claude-code")).toBe(0)
    expect(lines.slice(after).some((line) => line.includes("can be ‍ joined"))).toBe(true)
  })

  it("a namespace id the tree cannot name prints its first ten characters, never nothing (R5-3)", async () => {
    const { namespaceLabel } = await import("@mida/midad")
    const { namespaceId } = await import("@mida/protocol")
    expect(namespaceLabel(namespaceId("projects.current"))).toBe("projects.current")
    const foreign = `0x${"f1".repeat(32)}`
    expect(namespaceLabel(foreign)).toBe("0xf1f1f1f1…")
  })

  it("a refused wrap for one agent never hides the landed revoke — chain line first, then per-agent key lines (M3-D4)", async () => {
    // The Sep-22 incident: a revoke that failed after staging its deny left codex store-blocked,
    // and the NEXT revoke's repair pass aborted on codex's refused wrap — assistant never got the
    // new key and the printed line read "refused" for a revoke that had succeeded on chain.
    const runtime = await Runtime.open(home, network)
    try {
      const codexId = loadAgentIdentity(home, "codex")!.agentId
      await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId: codexId })
    } finally {
      await runtime.close()
    }

    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => out.push(line),
        progress: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    // M2: the post-revoke read must reach past the folder gate, so it runs in the
    // approved folder with its own marker's project id — a bare `read` would be
    // refused as not-approved whether the revoke had landed or not
    const projectId = (JSON.parse(readFileSync(join(projectDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    const readInProject = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        cwd: projectDir,
        print: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    // sanity: the same read succeeds while the grant and the folder row are live
    expect(await readInProject("read", "claude-code", projectId)).toBe(0)
    // the chain revoke succeeds — the exit code says so even though one wrap is refused
    expect(await run2("revoke", "claude-code")).toBe(0)
    // the chain answer leads: before any per-agent key line, and it is not "refused"
    const chainLine = out.findIndex((line) => line.startsWith("revoked claude-code on chain"))
    expect(chainLine).toBeGreaterThanOrEqual(0)
    expect(out[chainLine]).toMatch(/— tx 0x[0-9a-f]{64}/)
    // right after the tx line: what revoking does and does not do (T7)
    expect(out[chainLine + 1]).toBe("This stops future reads through Mida. It does not erase what claude-code already read.")
    // assistant got the new key; codex's refused wrap names its fix — and nothing calls the whole
    // revoke refused
    expect(out).toContain("new read key sent to assistant")
    const failedLine = out.find((line) => line.startsWith("could not send the new key to codex:"))
    expect(failedLine).toBeDefined()
    expect(failedLine).toContain("run `mida approve codex`")
    expect(out.every((line) => !line.startsWith("refused:"))).toBe(true)
    for (const keyLine of ["new read key sent to assistant", failedLine!]) {
      expect(out.indexOf(keyLine)).toBeGreaterThan(chainLine)
    }

    // cleanup, by the command the line itself names: approve clears the stale deny
    expect(await run2("approve", "codex")).toBe(1) // already-approved answer — the deny is gone first
    expect(out.some((line) => line === "cleared a stale block at the store left by a failed revoke")).toBe(true)
    // and claude-code's revoke really did land — the same read that succeeded above is
    // refused now, with the line the landed revoke's marker produces. The revoke removes
    // the folder's approval row, so the refusal arrives through checkProject's
    // not-approved + revoked-marker answer — which only exists because the chain revoke
    // ran — never the plain not-approved line a folder gate failure would print (M2)
    expect(await readInProject("read", "claude-code", projectId)).toBe(1)
    expect(out.at(-1)).toBe(
      "Mida: claude-code's access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.",
    )
  }, 300_000)

  it("a refused wrap's store reason prints folded on the per-agent line — no ESC, one line (in-41 U-2)", async () => {
    // `failure.reason` is error text the store or chain handed back — a wipe sequence or a
    // forged newline in it must never reach the owner's terminal as written.
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-fold-revoke-")))
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home: fresh, network, print: (line) => out.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("init")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    expect(await run2("request", "codex")).toBe(0)
    expect(await run2("approve", "codex")).toBe(0)
    out.length = 0
    const esc = String.fromCharCode(0x1b)
    const spy = vi
      .spyOn(FakeVaultAuthority.prototype, "publishReaderWraps")
      .mockRejectedValue(new Error(`store says ${esc}[2J wipe\nforged second line`))
    try {
      expect(await run2("revoke", "claude-code")).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const failedLine = out.find((line) => line.startsWith("could not send the new key to codex:"))
    expect(failedLine).toBeDefined()
    expect(failedLine).not.toContain(esc)
    expect(failedLine).not.toContain("\n")
    expect(failedLine).toContain("store says [2J wipe")
    expect(failedLine).toContain("run `mida approve codex`")
  }, 300_000)

  it("`revoke --all` folds the same store reason on every failure line (in-41 U-2)", async () => {
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-fold-all-")))
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home: fresh, network, print: (line) => out.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("init")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    expect(await run2("request", "codex")).toBe(0)
    expect(await run2("approve", "codex")).toBe(0)
    out.length = 0
    const esc = String.fromCharCode(0x1b)
    const spy = vi
      .spyOn(FakeVaultAuthority.prototype, "publishReaderWraps")
      .mockRejectedValue(new Error(`store says ${esc}[2J wipe\nforged second line`))
    try {
      await run2("revoke", "--all")
    } finally {
      spy.mockRestore()
    }
    const failedLines = out.filter((line) => line.startsWith("could not send the new key to "))
    expect(failedLines.length).toBeGreaterThan(0)
    for (const line of failedLines) {
      expect(line).not.toContain(esc)
      expect(line).not.toContain("\n")
      expect(line).toContain("store says [2J wipe")
    }
  }, 300_000)

  it("an already-approved approve says what the folder listing did — never 'run the command you just ran' (M3-D4)", async () => {
    // The Sep-22 incident's second lie: approve answered "already approved — to use THIS folder,
    // run mida approve codex here", naming the very command that was just run. Now the line says
    // whether the folder's list row was added or was already there.
    const dir = mkdtempSync(join(tmpdir(), "mida-proj-"))
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        cwd: dir,
        print: (line) => out.push(line),
        progress: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    expect(await run2("approve", "codex")).toBe(0)
    expect(out).toContain("codex is already approved on chain. This folder is now approved for codex too (no transaction).")
    out.length = 0
    expect(await run2("approve", "codex")).toBe(0)
    expect(out).toContain("codex is already approved on chain. This folder was already approved for codex.")
    // and neither answer tells the owner to re-run the command they just ran
    expect(out.every((line) => !line.includes("run `mida approve codex` here"))).toBe(true)
  }, 300_000)

  it("migrate is an owner command: a real terminal is required and the daemon socket refuses it", async () => {
    const out: string[] = []
    const noTty = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => out.push(line), prompt: async () => "yes",
        stdinIsTTY: false, stdoutIsTTY: true, env: {}, migrateTarget: env.deployment, startService: () => {},
      })
    expect(await noTty("migrate")).toBe(2)
    expect(await noTty("migrate", "--undo")).toBe(2)
    expect(out.filter((line) => line === NEEDS_TERMINAL_LINE)).toHaveLength(2)
    // through the daemon's /cli route it is refused like every owner command
    const refused: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["migrate"], stub, (line) => refused.push(line))).toBe(2)
    expect(refused[0]).toContain("mida migrate")
    expect(await runCliWithRuntime(["migrate", "--undo"], stub, () => {})).toBe(2)
    // a flag it does not know is usage, not a half-run
    expect(await run("migrate", "--sideways")).toBe(2)
  })

  it("mida migrate says there is nothing to move when the saved contract is already the target", async () => {
    const out: string[] = []
    const code = await runCli(["migrate"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      env: {}, migrateTarget: env.deployment, startService: () => {},
    })
    expect(code).toBe(0)
    expect(out.join("\n")).toContain("nothing to move")
  }, 300_000)

  it("mida migrate --undo refuses when no backup exists", async () => {
    const out: string[] = []
    const code = await runCli(["migrate", "--undo"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      env: {}, migrateTarget: env.deployment, startService: () => {},
    })
    expect(code).toBe(1)
    expect(out.join("\n").toLowerCase()).toContain("backup")
  }, 300_000)

  it("a mismatched setup tells migrate what it is moving — never 'run mida migrate' — while other commands keep the old notice", () => {
    const resolved = {
      network: {}, saved: true, contractSource: "network.json", builtIn: {},
      mismatch: {
        saved: "0xaaaa00000000000000000000000000000000aa",
        builtIn: "0xbbbb00000000000000000000000000000000bb",
      },
      storage: { url: undefined, source: "local" },
      sponsor: { url: undefined, source: "local" },
    } as unknown as ResolvedNetwork
    const move = ownerCommandNotice(resolved, "migrate")
    expect(move).toBe("moving this setup from contract 0xaaaa… to 0xbbbb…")
    expect(move).not.toContain("mida migrate")
    // every other owner command still hears the pointer to migrate
    const other = ownerCommandNotice(resolved, "approve")
    expect(other).toContain("run `mida migrate`")
    // and a setup that matches the built-in contract hears nothing at all
    expect(ownerCommandNotice({ ...resolved, mismatch: undefined } as ResolvedNetwork, "migrate")).toBeUndefined()
  })

  it("approve --all lists every pending request, asks once, and approves each (I3)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // two pending: claude-code is still revoked from the revoke test above, so a request files
    // a fresh one; cursor's pending request is the one `mida install cursor` left behind
    expect(await run2("request", "claude-code")).toBe(0)
    expect(home.has("agents/cursor/pending-request.json")).toBe(true)
    expect(await run2("approve", "--all")).toBe(0)
    // one list, then the single shared ask — never a per-agent prompt
    expect(asked).toEqual(["Type yes to approve all: "])
    expect(lines.filter((line) => line.endsWith("is asking for:")).length).toBe(2)
    expect(lines.filter((line) => line.startsWith("It will see this context as plain text.")).length).toBe(1)
    expect(lines.some((line) => line.startsWith("approved claude-code"))).toBe(true)
    expect(lines.some((line) => line.startsWith("approved cursor"))).toBe(true)
    expect(lines.at(-1)).toBe("approved: claude-code, cursor")
    // both pending files are consumed — nothing waits anymore
    expect(home.has("agents/claude-code/pending-request.json")).toBe(false)
    expect(home.has("agents/cursor/pending-request.json")).toBe(false)
    // and the nothing-pending answer is honest: exit 0, no prompt at all
    asked.length = 0
    expect(await run2("approve", "--all")).toBe(0)
    expect(asked).toHaveLength(0)
    expect(lines.at(-1)).toBe("nothing to approve — no agent has a pending request")
  }, 300_000)

  it("approve --all with anything but yes approves nobody (I3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "no",
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a fresh pending request for a revoked agent — claude-code was approved above, so revoke first
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "--all")).toBe(1)
    expect(lines).toContain("not approved")
    expect(lines.some((line) => line.startsWith("approved claude-code"))).toBe(false)
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)
    // restore: a yes approves it for real
    expect(await run("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve --all continues past a failing agent — the summary names both (I3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // codex real-pending (it is live, so revoke+request); cursor gets a stale file whose
    // requestId the store never held — approve refuses it with no-pending-request
    expect(await run2("revoke", "codex")).toBe(0)
    expect(await run2("request", "codex")).toBe(0)
    home.writeSecretJson("agents/cursor/pending-request.json", {
      request: {
        requestId: `0x${"ab".repeat(32)}`,
        scopes: [{ namespaceId: `0x${"11".repeat(32)}`, permissions: 1, provenancePolicy: 0 }],
        capabilityExpiresAt: "1999999999",
      },
    })
    expect(await run2("approve", "--all")).toBe(1)
    expect(lines.some((line) => line.startsWith("approved codex"))).toBe(true)
    expect(lines).toContain("cursor has no pending request — run `mida request cursor` first")
    expect(lines.at(-1)).toBe("approved: codex; failed: cursor (no-pending-request)")
    expect(home.has("agents/codex/pending-request.json")).toBe(false)
    home.remove("agents/cursor/pending-request.json")
  }, 300_000)

  it("approve --all runs the grant advisor per agent and never sends an expired request", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a real pending request for claude-code — then its validity window is moved into the past
    // and it is re-signed with the agent's own signer key, so the advisor's freshness check is
    // the only thing that refuses it
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    const identity = loadAgentIdentity(home, "claude-code")!
    const original = home.readJson<{ request: AccessRequest }>("agents/claude-code/pending-request.json")!.request
    const { agentSignature: _dropped, ...unsigned } = original
    const now = BigInt(Math.floor(Date.now() / 1000))
    const stale = {
      ...unsigned,
      requestId: `0x${"ee".repeat(32)}` as Hex,
      issuedAt: encodeUint64(now - 400n),
      requestExpiresAt: encodeUint64(now - 300n),
    }
    const expired = { ...stale, agentSignature: await privateKeyToAccount(identity.signerPrivateKey).signTypedData(accessRequestTypedData(stale)) }
    await new FileAccessRequestStore(home, "claude-code").save(expired)
    home.writeSecretJson("agents/claude-code/pending-request.json", { request: expired })

    // the expired request is named and excluded BEFORE the ask — no prompt, nothing signed
    expect(await run2("approve", "--all")).toBe(1)
    expect(asked).toHaveLength(0)
    expect(lines.some((line) => line.includes("claude-code") && line.includes("has expired") && line.includes("`mida request claude-code`"))).toBe(true)
    expect(lines.at(-1)).toBe("approved: none; failed: claude-code (REQUEST_EXPIRED)")
    // and the stale request still waits — nothing consumed it
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)

    // a fresh request passes the advisor; its verdict is part of the one combined list
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "--all")).toBe(0)
    expect(lines.some((line) => line.startsWith("grant advisor:"))).toBe(true)
    expect(lines.at(-1)).toBe("approved: claude-code")
  }, 300_000)

  it("a partial approve --all still kicks the daemon — one agent's grant landed", async () => {
    const kicks: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: () => {}, kickDaemon: () => kicks.push("x"),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code re-requested for a real approval; cursor's stale file fails the store lookup
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    home.writeSecretJson("agents/cursor/pending-request.json", {
      request: {
        requestId: `0x${"cd".repeat(32)}`,
        scopes: [{ namespaceId: `0x${"11".repeat(32)}`, permissions: 1, provenancePolicy: 0 }],
        capabilityExpiresAt: "1999999999",
      },
    })
    kicks.length = 0
    expect(await run2("approve", "--all")).toBe(1)
    // claude-code's approve landed, so the daemon was poked even though the batch exits 1
    expect(kicks).toHaveLength(1)
    home.remove("agents/cursor/pending-request.json")
  }, 300_000)

  it("approve --all says 'was already approved' when the folder's row was already there (G14)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-proj-"))
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, cwd: dir, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a real pending request for codex, kept before the single approve consumes it
    expect(await run2("revoke", "codex")).toBe(0)
    expect(await run2("request", "codex")).toBe(0)
    const identity = loadAgentIdentity(home, "codex")!
    const original = home.readJson<{ request: AccessRequest }>("agents/codex/pending-request.json")!.request
    expect(await run2("approve", "codex")).toBe(0) // chain grant + this folder's list row
    // file a second, fresh-signed request for scopes codex already holds: the batch's listOnly
    // arm runs, and with the row already written "now approved" would be a lie
    const { agentSignature: _dropped, ...unsigned } = original
    const now = BigInt(Math.floor(Date.now() / 1000))
    const fresh = {
      ...unsigned,
      requestId: `0x${"ff".repeat(32)}` as Hex,
      nonce: `0x${"ff".repeat(32)}` as Hex,
      // grantAdviceFor validates the window against the CHAIN's last block timestamp, not the
      // wall clock — a fresh anvil block can lag `now` by more than a small margin, and then
      // issuedAt lands in the chain's future and the request reads as out-of-window
      issuedAt: encodeUint64(now - 120n),
      requestExpiresAt: encodeUint64(now + 300n),
    }
    const request = { ...fresh, agentSignature: await privateKeyToAccount(identity.signerPrivateKey).signTypedData(accessRequestTypedData(fresh)) }
    await new FileAccessRequestStore(home, "codex").save(request)
    home.writeSecretJson("agents/codex/pending-request.json", { request })
    lines.length = 0
    expect(await run2("approve", "--all")).toBe(0)
    expect(lines).toContain("codex is already approved on chain. This folder was already approved for codex.")
    expect(lines.every((line) => !line.includes("is now approved for codex"))).toBe(true)
  }, 300_000)

  // AUTH-15 (Sep 27 demo break): once the agents hold their grant, `mida request` files
  // nothing — so `approve --all` in a fresh folder printed "nothing to approve" and left
  // every live agent without this folder's row. The batch must cover the same case a
  // single approve covers: live grant, no row yet → list the folder, no transaction.
  it("approve --all in a new folder approves THIS folder for agents that already hold the grant (AUTH-15)", async () => {
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-a1-home-")))
    const setupDir = mkdtempSync(join(tmpdir(), "mida-a1-setup-"))
    const newDir = mkdtempSync(join(tmpdir(), "mida-a1-folder-"))
    const quiet = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: setupDir, print: () => {},
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await quiet("init")).toBe(0)
    expect(await quiet("request", "claude-code")).toBe(0)
    expect(await quiet("approve", "claude-code")).toBe(0)
    expect(await quiet("request", "codex")).toBe(0)
    expect(await quiet("approve", "codex")).toBe(0)

    const asked: string[] = []
    const inNew = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: newDir, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    lines.length = 0
    expect(await inNew("approve", "--all")).toBe(0)
    // one shared confirmation covered the whole batch
    expect(asked).toEqual(["Type yes to approve all: "])
    const projectId = (JSON.parse(readFileSync(join(newDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    for (const name of ["claude-code", "codex"]) {
      expect(lines).toContain(`${name} already holds a live grant; this lists it for project ${projectId} (this folder)`)
      expect(lines).toContain(`${name} is already approved on chain. This folder is now approved for ${name} too (no transaction).`)
    }
    // N2: the sweep the yes covers is counted and named on the line right above it
    const plainText = lines.indexOf("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
    expect(lines[plainText + 1]).toBe("2 agents will gain this folder: claude-code, codex")
    expect(lines.at(-1)).toBe("approved: claude-code, codex")
    // both rows landed in the owner-signed list for THIS folder's project
    const root = realpathSync.native(newDir)
    const list = fresh.readJson<{ entries: { agent: string; projectId: string; root: string }[] }>("approved-projects.json")
    for (const name of ["claude-code", "codex"]) {
      expect(list?.entries.some((e) => e.agent === name && e.projectId === projectId && e.root === root)).toBe(true)
    }
    // and doctor's project line lists the folder under the project the batch just made
    const docLines: string[] = []
    await runDoctor({ home: fresh, print: (line) => docLines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    const projectLine = docLines.find((line) => line.startsWith(`ok: project ${projectId.slice(0, 8)}`))
    expect(projectLine).toBeDefined()
    expect(projectLine).toContain(root)

    // a second run: everything already lists — the honest nothing-line, and no ask
    asked.length = 0
    expect(await inNew("approve", "--all")).toBe(0)
    expect(asked).toHaveLength(0)
    expect(lines.at(-1)).toBe("nothing to approve — every agent with permission is already approved for this folder")
  }, 300_000)

  it("approve --all mixes a pending request, a folder-only approval and a never-requested agent (AUTH-15)", async () => {
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-a1mix-home-")))
    const setupDir = mkdtempSync(join(tmpdir(), "mida-a1mix-setup-"))
    const newDir = mkdtempSync(join(tmpdir(), "mida-a1mix-folder-"))
    const quiet = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: setupDir, print: () => {},
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await quiet("init")).toBe(0)
    expect(await quiet("request", "claude-code")).toBe(0)
    expect(await quiet("approve", "claude-code")).toBe(0)
    // codex is asked but not yet approved — its pending request joins the same batch;
    // zzz-agent holds a real identity file but was never granted on chain
    expect(await quiet("request", "codex")).toBe(0)
    const fake: AgentIdentity = {
      name: "zzz-agent",
      agentId: AGENT_ID,
      signerPrivateKey: `0x${"66".repeat(32)}`,
      encryptionPrivateKey: `0x${"77".repeat(32)}`,
      encryptionPublicKey: `0x${"88".repeat(32)}`,
      callbackOrigin: "https://zzz-agent.mida.example",
      purposeId: "project_assistance",
      manifest: await signManifest(manifestBody()),
      manifestHash: manifestBodyHash(manifestBody()),
    }
    await saveAgentIdentity(fresh, fake)

    const asked: string[] = []
    const inNew = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: newDir, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    lines.length = 0
    expect(await inNew("approve", "--all")).toBe(0)
    expect(asked).toEqual(["Type yes to approve all: "])
    const projectId = (JSON.parse(readFileSync(join(newDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    // all three kinds sit in the one combined preview
    expect(lines.some((line) => line === "codex is asking for:")).toBe(true)
    expect(lines).toContain(`claude-code already holds a live grant; this lists it for project ${projectId} (this folder)`)
    expect(lines).toContain("zzz-agent: no permission yet — run `mida request zzz-agent` first")
    // N2: only the live-grant agent is counted — the pending request is what --all always meant
    expect(lines).toContain("1 agent will gain this folder: claude-code")
    // the yes covers the pending grant and the folder listing alike
    expect(lines.some((line) => line.startsWith("approved codex tx "))).toBe(true)
    expect(lines).toContain("claude-code is already approved on chain. This folder is now approved for claude-code too (no transaction).")
    // the never-requested agent is reported, not a failure — the batch still exits 0
    expect(lines.at(-1)).toBe("approved: claude-code, codex")
    const root = realpathSync.native(newDir)
    const list = fresh.readJson<{ entries: { agent: string; projectId: string; root: string }[] }>("approved-projects.json")
    for (const name of ["claude-code", "codex"]) {
      expect(list?.entries.some((e) => e.agent === name && e.projectId === projectId && e.root === root)).toBe(true)
    }
    expect(list?.entries.some((e) => e.agent === "zzz-agent")).toBeFalsy()
  }, 300_000)

  it("the Sep-27 rehearsal sequence: request's already-approved hint, then approve --all approves the folder (AUTH-15)", async () => {
    const fresh = new MidaHome(mkdtempSync(join(tmpdir(), "mida-a1seq-home-")))
    const setupDir = mkdtempSync(join(tmpdir(), "mida-a1seq-setup-"))
    const newDir = mkdtempSync(join(tmpdir(), "mida-a1seq-folder-"))
    const quiet = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: setupDir, print: () => {},
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await quiet("init")).toBe(0)
    expect(await quiet("request", "claude-code")).toBe(0)
    expect(await quiet("approve", "claude-code")).toBe(0)

    const inNew = (...argv: string[]) =>
      runCli(argv, {
        home: fresh, network, cwd: newDir, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    lines.length = 0
    // `request` in the new folder can only say already-approved — nothing is filed, so
    // the batch that used to key on pending files found nothing to do (the break)
    expect(await inNew("request", "claude-code")).toBe(0)
    expect(lines).toContain("claude-code is already approved on chain. To use it in THIS folder, run `mida approve claude-code` here (no transaction, nothing to pay).")
    expect(fresh.has("agents/claude-code/pending-request.json")).toBe(false)
    expect(await inNew("approve", "--all")).toBe(0)
    const projectId = (JSON.parse(readFileSync(join(newDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    const list = fresh.readJson<{ entries: { agent: string; projectId: string; root: string }[] }>("approved-projects.json")
    expect(list?.entries.some((e) => e.agent === "claude-code" && e.projectId === projectId && e.root === realpathSync.native(newDir))).toBe(true)
  }, 300_000)

  it("revoke --all lists every approved agent, asks once, and revokes each (I4)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    let lastBeforeAsk: string | undefined
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); lastBeforeAsk = lines.at(-1); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // M2: the post-revoke read below must reach past the folder gate, so it runs in the
    // approved folder with its own marker's project id. claude-code is already approved
    // on chain — this approve only writes THIS folder's row (no transaction) — and the
    // same read must succeed BEFORE the revoke, so the refusal afterwards can only be
    // the landed revoke, never a folder gate that was never open
    const projectId = (JSON.parse(readFileSync(join(projectDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    const readInProject = (...argv: string[]) =>
      runCli(argv, {
        home, network, cwd: projectDir, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await run("approve", "claude-code")).toBe(0)
    expect(await readInProject("read", "claude-code", projectId)).toBe(0)
    // every agent that still holds an approval: the four project agents above plus assistant,
    // whose general-assistance grant init sent at the start of this file
    expect(await run2("revoke", "--all")).toBe(0)
    expect(asked).toEqual(["Type yes to revoke all: "])
    for (const name of ["assistant", "claude-code", "claude-desktop", "codex", "cursor"]) {
      expect(lines).toContain(`${name} holds an approval`)
      expect(lines.some((line) => line.startsWith(`revoked ${name} on chain`))).toBe(true)
      expect(lines).toContain(`This stops future reads through Mida. It does not erase what ${name} already read.`)
    }
    // the whole list printed before the single ask — nothing was revoked sight-unseen
    expect(lastBeforeAsk).toBe("cursor holds an approval")
    expect(lines.at(-1)).toBe("revoked: assistant, claude-code, claude-desktop, codex, cursor")
    // and a revocation is real: the same read that just succeeded is refused now, with
    // the revoked-agent line the landed revoke's folder marker produces — never the
    // plain not-approved answer a folder gate failure would print (M2)
    expect(await readInProject("read", "claude-code", projectId)).toBe(1)
    expect(lines.at(-1)).toBe(
      "Mida: claude-code's access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.",
    )
    // a second run finds nobody approved — exit 0, no prompt at all
    asked.length = 0
    expect(await run2("revoke", "--all")).toBe(0)
    expect(asked).toHaveLength(0)
    expect(lines.at(-1)).toBe("nothing to revoke — no agent in this Mida home holds an approval")
  }, 300_000)

  it("revoke --all with anything but yes revokes nobody (I4)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    // run in the folder the shared `run` helper approves agents into — the re-approve below
    // writes this folder's row, which the end-of-test read needs to pass the G12 gate
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, cwd: projectDir, print: (line) => lines.push(line),
        // yes to a single agent's own ask; the batch question is the one this test declines
        prompt: async (question) => { asked.push(question); return question === "Type yes to revoke all: " ? "no" : "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // re-approve one agent so the list is not empty — everything was revoked above
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    asked.length = 0
    expect(await run2("revoke", "--all")).toBe(1)
    expect(asked).toEqual(["Type yes to revoke all: "])
    expect(lines).toContain("claude-code holds an approval")
    expect(lines).toContain("not revoked")
    expect(lines.some((line) => line.startsWith("revoked "))).toBe(false)
    // still really approved: no marker, and the read still goes through — naming
    // the folder's own project id, the only id the L1 gate accepts here
    expect(home.has("agents/claude-code/revoked.json")).toBe(false)
    const projectId = (JSON.parse(readFileSync(join(projectDir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId
    expect(await run2("read", "claude-code", projectId)).toBe(0)
    // restore the all-revoked state the next test builds on
    expect(await run2("revoke", "claude-code")).toBe(0)
  }, 300_000)

  it("revoke --all continues past a failing agent — the summary names both (I4)", async () => {
    const lines: string[] = []
    const kicks: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        kickDaemon: () => kicks.push("x"),
        prompt: async (question) => {
          // cursor's records vanish between the batch's list and its turn — the batch must survive it
          if (question === "Type yes to revoke all: ") {
            for (const file of ["identity.json", "signer.json", "grants.json"]) home.remove(`agents/cursor/${file}`)
          }
          return "yes"
        },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // codex is really approved again; cursor is listed off the grants.json its revoke left —
    // clearing the marker is exactly what `mida approve` does when it re-grants
    expect(await run2("request", "codex")).toBe(0)
    expect(await run2("approve", "codex")).toBe(0)
    home.remove("agents/cursor/revoked.json")
    kicks.length = 0
    expect(await run2("revoke", "--all")).toBe(1)
    expect(lines.some((line) => line.startsWith("revoked codex on chain"))).toBe(true)
    expect(lines).toContain("cursor is not set up on this machine — run `mida init` first")
    expect(lines.at(-1)).toBe("revoked: codex; failed: cursor (agent-unidentified)")
    // codex's revoke really landed even though cursor's failed — marker written, daemon poked
    expect(home.has("agents/codex/revoked.json")).toBe(true)
    expect(kicks).toHaveLength(1)
  }, 300_000)

  it("revoke --all scans every agents folder — a stray grant is listed, an expired grant is not, a broken identity is named", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    const owner = loadOwnerAddress(home)!
    const grant = (agentId: Hex, expiresAt: string) => [
      {
        owner,
        agentId,
        requestId: `0x${"33".repeat(32)}`,
        capabilities: [
          {
            namespaceId: `0x${"55".repeat(32)}`,
            permissions: 1,
            provenancePolicy: 0,
            expiresAt,
            capabilityId: `0x${"66".repeat(32)}`,
            transactionHash: `0x${"77".repeat(32)}`,
          },
        ],
      },
    ]
    // stray: no identity.json at all — grants.json alone must still put it on the list
    home.writeSecretJson("agents/stray/grants.json", grant(`0x${"44".repeat(32)}` as Hex, "0"))
    // stale: a loadable identity, but its only grant record expired long ago — not an approval
    saveAgentIdentity(home, {
      name: "stale",
      agentId: `0x${"88".repeat(32)}` as Hex,
      signerPrivateKey: `0x${"99".repeat(32)}` as Hex,
      encryptionPrivateKey: `0x${"aa".repeat(32)}` as Hex,
      encryptionPublicKey: `0x${"bb".repeat(32)}` as Hex,
      callbackOrigin: "https://stale.mida.example",
      purposeId: "project_assistance",
      manifest: {} as never,
      manifestHash: `0x${"cc".repeat(32)}` as Hex,
    })
    home.writeSecretJson("agents/stale/grants.json", grant(`0x${"88".repeat(32)}` as Hex, "1700000000"))
    // cursor's folder survives the earlier test empty — an agent whose identity cannot be loaded
    // is reported by name, never silently dropped from the scan
    expect(home.has("agents/cursor/identity.json")).toBe(false)

    expect(await run2("revoke", "--all")).toBe(1)
    expect(lines).toContain("stray holds an approval")
    expect(lines).not.toContain("stale holds an approval")
    expect(lines).toContain("cursor is not set up on this machine — run `mida init` first")
    expect(asked).toEqual(["Type yes to revoke all: "])
    // stray's listed grant turns out to hold nothing on chain — reported, not counted as revoked
    expect(lines).toContain("stray: nothing to revoke")
    expect(lines.at(-1)).toBe("revoked: none; failed: cursor (agent-unidentified)")
    home.remove("agents/stray/grants.json")
    home.remove("agents/stray/revoked.json")
    home.remove("agents/stale/grants.json")
    home.remove("agents/stale/identity.json")
  }, 300_000)

  it("never prints a secret: no output line contains any key stored in the home folder", () => {
    const secrets: string[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder)) {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== "data") walk(full)
        } else if (/secrets|signer|identity/.test(entry)) {
          const text = readFileSync(full, "utf8")
          for (const match of text.matchAll(/"(?:privateKey|seed|p256PrivateKey|signerPrivateKey|encryptionPrivateKey)":\s*"(0x[0-9a-f]{64})"/g)) secrets.push(match[1]!)
        }
      }
    }
    walk(home.root)
    expect(secrets.length).toBeGreaterThanOrEqual(8)
    const output = lines.join("\n")
    for (const secret of secrets) expect(output.includes(secret)).toBe(false)
  })
})

/**
 * CHAIN-09 — the Sep 22 incident: `mida request claude-code` printed `refused: ERROR` and nothing
 * else because the chain call had failed with an error Mida did not recognise. Now a chain error
 * names the setup's contract and the flag that shows why; a debug context appends the masked line.
 */
describe("named refusals on agent commands (CHAIN-09)", () => {
  const REGISTRY = "0xf07d000000000000000000000000000000000042"
  const stubRuntime = (thrown: unknown) =>
    ({
      home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-refusal-"))),
      chain: { deployment: { capabilityRegistry: REGISTRY } },
      agent: () => {
        throw thrown
      },
    }) as unknown as ServiceRuntime

  it("a coded chain error prints the contract line, never refused: ERROR", async () => {
    const lines: string[] = []
    const thrown = new Error("chain refused") as Error & { code: string }
    thrown.code = "CHAIN_CALL_FAILED"
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(thrown), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      "the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why",
    ])
    expect(lines.join("\n")).not.toContain("ERROR")
  })

  it("a transport failure — the chain could not be asked — is the busy line, never 'not approved' (in-6 R4)", async () => {
    const lines: string[] = []
    // the real shape a network failure arrives in: an HttpRequestError with no status
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new HttpRequestError({ url: "http://rpc.test" })), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      "Monad is busy right now — nothing was sent or decided; wait a moment and run the same command again",
    ])
    expect(lines.join("\n")).not.toContain("not approved")
  })

  it("a viem failure that carries no transport signal names the contract, not 'busy' (in-11 R-8)", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new BaseError("boom")), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      "the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why",
    ])
  })

  it("a non-chain error is refused: UNEXPECTED, never refused: ERROR", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new Error("weird")), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual(["refused: UNEXPECTED"])
  })

  it("with debug on, the catch also prints exactly one masked debug: line", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["request", "claude-code"],
      stubRuntime(new BaseError("boom")),
      (line) => lines.push(line),
      { debug: true },
    )
    expect(code).toBe(1)
    expect(lines.filter((line) => line.startsWith("debug:"))).toHaveLength(1)
    expect(lines[0]).toBe("the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why")
    expect(lines[1]).toBe("debug: BaseError | boom")
  })

  it("without debug there is no debug: line and no error message", async () => {
    const lines: string[] = []
    await runCliWithRuntime(["request", "claude-code"], stubRuntime(new BaseError("a secret reason")), (line) => lines.push(line), {
      debug: false,
    })
    expect(lines.every((line) => !line.startsWith("debug:"))).toBe(true)
    expect(lines.join("\n")).not.toContain("a secret reason")
  })

  it("mida read --as <unregistered> prints the no-identity line, not a bare code", async () => {
    const stub = stubRuntime(new Error("unreached"))
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "ghost", "projects.current"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([`Mida: no agent "ghost" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
    expect(lines.every((line) => !line.startsWith("refused:"))).toBe(true)
  })

  it("mida read --as <corrupt identity> says the file exists but cannot be read — never 'not set up'", async () => {
    const stub = stubRuntime(new Error("unreached"))
    mkdirSync(join(stub.home.root, "agents", "corrupt"), { recursive: true })
    writeFileSync(join(stub.home.root, "agents", "corrupt", "identity.json"), "not json")
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "corrupt", "projects.current"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      `Mida: corrupt's identity in this Mida home (${stub.home.root}) exists but could not be read. Nothing was shared. Run \`mida doctor\`.`,
    ])
  })

  it("an agent name that cannot be an identity is still usage — never read under it", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "a b"], stubRuntime(new Error("unreached")), (line) => lines.push(line))
    expect(code).toBe(2)
    expect(lines).toEqual([USAGE])
  })

  it("the read --as name rule matches the MCP and key-store cap: 65 chars is usage, 64 proceeds (F9)", async () => {
    const stub = stubRuntime(new Error("unreached"))
    const lines: string[] = []
    const over = await runCliWithRuntime(["read", "--as", "a".repeat(65), "projects.current"], stub, (line) => lines.push(line))
    expect(over).toBe(2)
    expect(lines).toEqual([USAGE])
    lines.length = 0
    const at = await runCliWithRuntime(["read", "--as", "a".repeat(64), "projects.current"], stub, (line) => lines.push(line))
    // 64 chars is a legal name that is simply unregistered — the identity gate answers, not usage
    expect(at).toBe(1)
    expect(lines).toEqual([`Mida: no agent "${"a".repeat(64)}" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
  })

  it("a read whose agent's identity is gone prints the same no-identity line", async () => {
    const notSetup = Object.assign(new Error("gone"), { code: "agent-not-setup" })
    const stub = stubRuntime(notSetup)
    // the G12 folder gate runs first, so the read must come from a folder this home approved
    // for codex — only then does the missing-identity answer reach the caller
    Object.assign(stub, { owner: privateKeyToAccount(loadOrCreateOwnerSecrets(stub.home).privateKey).address })
    const folder = mkdtempSync(join(tmpdir(), "mida-g12-approved-"))
    await approveProject(stub as unknown as Runtime, { agent: "codex", cwd: folder })
    // the read names the folder's own project id — any other id is refused by the
    // L1 mismatch gate before the missing-identity answer could ever be reached
    const marker = JSON.parse(readFileSync(join(folder, ".mida", "project.json"), "utf8")) as { projectId: string }
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "codex", marker.projectId], stub, (line) => lines.push(line), { cwd: folder })
    expect(code).toBe(1)
    expect(lines).toEqual([`Mida: no agent "codex" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
  })

  /** A loadable identity file — the fields loadAgentIdentity checks, nothing more. */
  const writeIdentity = (home: MidaHome, name: string, purposeId = "project_assistance") => {
    const key = `0x${"ab".repeat(32)}`
    mkdirSync(join(home.root, "agents", name), { recursive: true })
    writeFileSync(
      join(home.root, "agents", name, "identity.json"),
      JSON.stringify({
        name,
        agentId: key,
        signerPrivateKey: key,
        encryptionPrivateKey: key,
        encryptionPublicKey: key,
        manifestHash: key,
        callbackOrigin: "http://localhost",
        purposeId,
        manifest: {},
      }),
    )
  }
  /** A folder carrying a project marker with the given id. */
  const markedFolder = (projectId: string) => {
    const dir = mkdtempSync(join(tmpdir(), "mida-f7-proj-"))
    mkdirSync(join(dir, ".mida"))
    writeFileSync(join(dir, ".mida", "project.json"), JSON.stringify({ projectId }))
    return dir
  }

  it("read --as projects.current refuses when this folder is not approved for the agent (F7)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-f7-")))
    writeIdentity(home, "reader")
    // the stub carries no store or reader: if the refusal were skipped, readCheckpoints would
    // throw and the catch would print "refused: …" — the assertion would fail loudly
    const stub = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as ServiceRuntime
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["read", "--as", "reader", "projects.current"],
      stub,
      (line) => lines.push(line),
      { cwd: markedFolder("p1") },
    )
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("an approval for a different folder does not open this folder's checkpoint list (F7)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-f7-")))
    writeIdentity(home, "reader")
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const stub = { home, owner } as unknown as ServiceRuntime
    // approve the agent on one folder…
    const approved = mkdtempSync(join(tmpdir(), "mida-f7-approved-"))
    await approveProject(stub as unknown as Runtime, { agent: "reader", cwd: approved })
    const marker = JSON.parse(readFileSync(join(approved, ".mida", "project.json"), "utf8")) as { projectId: string }
    // …then read from a different folder that carries the same project id — folder-mismatch
    const other = markedFolder(marker.projectId)
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["read", "--as", "reader", "projects.current"],
      stub,
      (line) => lines.push(line),
      { cwd: other },
    )
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("read <agent> <projectId> refuses when this folder is not approved for the agent (G12)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g12-")))
    writeIdentity(home, "reader")
    // the stub carries no store or reader: a skipped folder gate falls into readCheckpoints,
    // which throws on the bare stub and the catch prints "refused: …" — this fails loudly
    const stub = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as ServiceRuntime
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["read", "reader", "p1"],
      stub,
      (line) => lines.push(line),
      { cwd: markedFolder("p1") },
    )
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("an approval for a different folder does not open read <agent> <projectId> (G12)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g12-")))
    writeIdentity(home, "reader")
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const stub = { home, owner } as unknown as ServiceRuntime
    // approve the agent on one folder…
    const approved = mkdtempSync(join(tmpdir(), "mida-g12-approved-"))
    await approveProject(stub as unknown as Runtime, { agent: "reader", cwd: approved })
    const marker = JSON.parse(readFileSync(join(approved, ".mida", "project.json"), "utf8")) as { projectId: string }
    // …then read that same project id from a different folder that carries it — folder-mismatch
    const other = markedFolder(marker.projectId)
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["read", "reader", marker.projectId],
      stub,
      (line) => lines.push(line),
      { cwd: other },
    )
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("read <agent> <projectId> with no caller folder names no folder to approve — the same refusal (G12)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g12-")))
    writeIdentity(home, "reader")
    const stub = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as ServiceRuntime
    const lines: string[] = []
    // the daemon accepts a /cli body that carries no cwd and passes undefined through — a call
    // that names no folder cannot hold a folder approval, so it gets the same not-approved line
    const code = await runCliWithRuntime(["read", "reader", "p1"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("read <agent> <projectId> naming a different project's id is refused — the approval is for THIS folder's project (L1)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-l1-")))
    writeIdentity(home, "reader")
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    // no store or reader on the stub: if the gate let the call through, readCheckpoints
    // would throw and the catch's "refused: …" line would fail the assertion loudly
    const stub = { home, owner } as unknown as ServiceRuntime
    // approved in folder A — its list row carries A's marker project id…
    const approved = mkdtempSync(join(tmpdir(), "mida-l1-approved-"))
    await approveProject(stub as unknown as Runtime, { agent: "reader", cwd: approved })
    const marker = JSON.parse(readFileSync(join(approved, ".mida", "project.json"), "utf8")) as { projectId: string }
    const lines: string[] = []
    // …then a read from that approved folder naming project B's id is refused, and
    // nothing about B — no checkpoint ids, no authors — is ever printed
    const code = await runCliWithRuntime(
      ["read", "reader", "p-other"],
      stub,
      (line) => lines.push(line),
      { cwd: approved },
    )
    expect(code).toBe(1)
    expect(lines).toEqual([`project-mismatch: this folder is approved for ${marker.projectId}, not p-other`])
  })

  it("save-demo <agent> <projectId> enforces the same folder↔project check as read (in-15 J-6)", async () => {
    // Sep 27 live: `save-demo claude-code hosted-check` saved from a folder approved for a
    // different project while `read` refused. A guard on one path but not the other — the
    // save path must answer exactly what read answers.
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-j6-")))
    writeIdentity(home, "reader")
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const stub = { home, owner } as unknown as ServiceRuntime
    const approved = mkdtempSync(join(tmpdir(), "mida-j6-approved-"))
    await approveProject(stub as unknown as Runtime, { agent: "reader", cwd: approved })
    const marker = JSON.parse(readFileSync(join(approved, ".mida", "project.json"), "utf8")) as { projectId: string }
    const lines: string[] = []
    const mismatched = await runCliWithRuntime(
      ["save-demo", "reader", "p-other"],
      stub,
      (line) => lines.push(line),
      { cwd: approved },
    )
    expect(mismatched).toBe(1)
    expect(lines).toEqual([`project-mismatch: this folder is approved for ${marker.projectId}, not p-other`])
    // an unapproved folder refuses the same way read does — a save is never written under it
    lines.length = 0
    const unapproved = await runCliWithRuntime(
      ["save-demo", "reader", "p1"],
      stub,
      (line) => lines.push(line),
      { cwd: markedFolder("p1") },
    )
    expect(unapproved).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
    // the matching project id passes the gate — the bare stub has no save path, so the
    // loud refusal below is proof the check itself let the command through (not project-mismatch)
    lines.length = 0
    const matching = await runCliWithRuntime(
      ["save-demo", "reader", marker.projectId],
      stub,
      (line) => lines.push(line),
      { cwd: approved },
    )
    expect(matching).toBe(1)
    expect(lines.every((line) => !line.includes("project-mismatch") && !line.includes("not approved"))).toBe(true)
  })

  it("read --as assistant projects.current names the real fix, never request+approve assistant (G8)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g8-")))
    writeIdentity(home, "assistant", "general_assistance")
    const stub = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as ServiceRuntime
    const lines: string[] = []
    // a folder with no .mida marker anywhere — the "make it one" hint must not loop the owner
    // into approving an identity that can never hold a project row
    const code = await runCliWithRuntime(
      ["read", "--as", "assistant", "projects.current"],
      stub,
      (line) => lines.push(line),
      { cwd: mkdtempSync(join(tmpdir(), "mida-g8-unmarked-")) },
    )
    expect(lines).toEqual(["Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`."])
    expect(code).toBe(0)
  })

  it("request assistant answers the general-assistant line — never 'run mida approve assistant' (G8)", async () => {
    const already = Object.assign(new Error("already approved"), { code: "already-approved" })
    // the chain answers "nothing live" so the request reaches the already-approved throw
    const stub = Object.assign(stubRuntime(already), { reader: { activeCapabilityIds: async () => [] } })
    writeIdentity(stub.home, "assistant", "general_assistance")
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "assistant"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`."])
  })

  it("ownerRefusalLine's already-approved arm names the real fix for assistant too (G8)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g8-")))
    writeIdentity(home, "assistant", "general_assistance")
    const already = Object.assign(new Error("already approved"), { code: "already-approved" })
    expect(ownerRefusalLine("request", "assistant", already, undefined, undefined, home)).toBe(
      "Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`.",
    )
    // a real project-context agent keeps the approve hint
    writeIdentity(home, "codex")
    expect(ownerRefusalLine("request", "codex", already, undefined, undefined, home)).toBe(
      "codex is already approved on chain. To use it in THIS folder, run `mida approve codex` here (no transaction, nothing to pay).",
    )
  })

  /**
   * lk-1 — `mida link` runs where the owner typed it: folder B joins the project the named
   * folder belongs to. Rows are owner-signed local data, so these tests need no chain and no
   * `mida init`: a fresh home's owner address comes from the local key file.
   */
  const folderHome = (prefix: string) => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), prefix)))
    const owner = {
      home,
      owner: privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address,
    } as unknown as Runtime
    const network = { deployment: { capabilityRegistry: REGISTRY } } as unknown as Network
    return { home, owner, network }
  }

  it("mida link writes B's marker with A's project id and one signed row per approved agent (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-link-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-link-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-link-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-link" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    await approveProject(owner, { agent: "codex", cwd: dirA })

    const lines: string[] = []
    const asked: string[] = []
    const runB = (...argv: string[]) =>
      runCli(argv, {
        home, network, cwd: dirB, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await runB("link", dirA)).toBe(0)
    // the owner saw the project, A's marker folder, B's canonical path and the agents — then typed yes
    expect(asked).toEqual(["Type yes to link: "])
    expect(lines.some((line) => line.includes("p-link"))).toBe(true)
    expect(lines.some((line) => line.includes("claude-code") && line.includes("codex"))).toBe(true)
    expect(lines.at(-1)).toBe(`linked ${realpathSync(dirB)} to project p-link for claude-code, codex`)
    // B's own marker now names A's project
    const marker = JSON.parse(readFileSync(join(dirB, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toBe("p-link")
    // one signed row per agent that was approved for A — verified through the security gate
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirB })).toMatchObject({ ok: true })
    expect(await checkProject(owner, { agent: "codex", cwd: dirB })).toMatchObject({ ok: true })

    // already linked: same answer as approve's no-op — exit 0, nothing changes
    lines.length = 0
    expect(await runB("link", dirA)).toBe(0)
    expect(lines.at(-1)).toContain("already linked")
  })

  it("mida link needs a real terminal, is refused through the daemon, and 'no' writes nothing (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-linkref-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-linkref-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-linkref-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-lref" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })

    // an agent-launched or scripted run never gets the ask
    const refused: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: dirB, print: (line) => refused.push(line),
      prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true,
    })).toBe(2)
    expect(refused).toEqual([NEEDS_TERMINAL_LINE])
    // through the daemon's /cli route it is refused like every owner command
    const daemonLines: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-link-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["link", dirA], stub, (line) => daemonLines.push(line))).toBe(2)
    expect(daemonLines[0]).toContain("mida link")
    // an answer other than yes leaves B exactly as it was
    const out: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: dirB, print: (line) => out.push(line),
      prompt: async () => "no", stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(1)
    expect(out).toContain("not approved")
    expect(existsSync(join(dirB, ".mida"))).toBe(false)
  })

  it("mida link refuses: no project on the named folder, B IS A, B's own different project (lk-1)", async () => {
    const { home, network } = folderHome("mida-linkx-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-linkx-a-"))
    const bare = mkdtempSync(join(tmpdir(), "mida-linkx-bare-"))
    const dirC = mkdtempSync(join(tmpdir(), "mida-linkx-c-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-lx" }))
    mkdirSync(join(dirC, ".mida"))
    writeFileSync(join(dirC, ".mida", "project.json"), JSON.stringify({ projectId: "p-c-own" }))
    const out: string[] = []
    const runIn = (cwd: string, ...argv: string[]) =>
      runCli(argv, {
        home, network, cwd, print: (line) => out.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    // <folder> names no project — nothing to join
    expect(await runIn(bare, "link", bare)).toBe(1)
    expect(out.at(-1)).toContain("no .mida/project.json")
    // B IS A — the folder already is the project's marker folder
    expect(await runIn(dirA, "link", dirA)).toBe(1)
    expect(out.at(-1)).toContain("already IS")
    // and none of the refusals wrote a marker anywhere new
    expect(existsSync(join(bare, ".mida"))).toBe(false)
  })

  it("mida link on a folder with its own project is a folder move, not a dead end (in-16 K-2)", async () => {
    const { home, owner, network } = folderHome("mida-move-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-move-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-move-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-a" }))
    mkdirSync(join(dirB, ".mida"))
    writeFileSync(join(dirB, ".mida", "project.json"), JSON.stringify({ projectId: "p-b" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    await approveProject(owner, { agent: "claude-code", cwd: dirB })

    const lines: string[] = []
    const asked: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: dirB, print: (line) => lines.push(line),
      prompt: async (question) => { asked.push(question); return "yes" },
      stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    // the owner saw the folder-move wording — what B leaves, and that X's history is not copied
    expect(lines).toEqual([
      "This folder currently belongs to project p-b.",
      "Project p-b:",
      "• 1 folder",
      "• unknown number of saved checkpoints",
      "Linking will move this folder to project p-a.",
      "The existing checkpoints stay in project p-b's history.",
      "They will NOT be copied into project p-a or appear in project p-a's handoffs.",
      expect.stringContaining("moved") as unknown as string,
    ])
    expect(asked).toEqual(["Continue? Type yes: "])
    // one signed write moved B: its p-b row is gone, its p-a row is in, the marker flipped
    const marker = JSON.parse(readFileSync(join(dirB, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toBe("p-a")
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirB })).toMatchObject({ ok: true })
  })

  it("a declined folder move changes nothing — the marker and every signed row stay (in-16 K-2)", async () => {
    const { home, owner, network } = folderHome("mida-moveno-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-moveno-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-moveno-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-a" }))
    mkdirSync(join(dirB, ".mida"))
    writeFileSync(join(dirB, ".mida", "project.json"), JSON.stringify({ projectId: "p-b" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    await approveProject(owner, { agent: "claude-code", cwd: dirB })
    const before = (home.readJson("approved-projects.json") as { entries: unknown[] }).entries.length

    const out: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: dirB, print: (line) => out.push(line),
      prompt: async () => "no", stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(1)
    expect(out).toContain("not approved")
    const marker = JSON.parse(readFileSync(join(dirB, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toBe("p-b")
    expect((home.readJson("approved-projects.json") as { entries: unknown[] }).entries).toHaveLength(before)
  })

  it("mida link with the wrong argument count is usage, like every command (lk-1)", async () => {
    const { home, network } = folderHome("mida-linkuse-home-")
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, cwd: mkdtempSync(join(tmpdir(), "mida-linkuse-")), print: (line) => out.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await run2("link")).toBe(2)
    expect(await run2("link", "a", "b")).toBe(2)
    expect(out.filter((line) => line === USAGE)).toHaveLength(2)
  })

  it("mida unlink removes B's rows and its marker after the typed yes — A keeps working (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-unlink-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-unlink-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-unlink-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-ul" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    await approveProject(owner, { agent: "codex", cwd: dirA })

    const lines: string[] = []
    const asked: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: dirB, print: (line) => lines.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    lines.length = 0

    expect(await runCli(["unlink"], {
      home, network, cwd: dirB, print: (line) => lines.push(line),
      prompt: async (question) => { asked.push(question); return "yes" },
      stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    // the owner saw what goes away — the rows, the marker — and that the project keeps A
    expect(asked).toEqual(["Type yes to unlink: "])
    expect(lines.some((line) => line.includes("p-ul"))).toBe(true)
    expect(lines.some((line) => line.includes(realpathSync(dirA)))).toBe(true)
    expect(lines.at(-1)).toContain("unlinked")
    // B's marker and both its rows are gone; A's rows and marker are untouched
    expect(existsSync(join(dirB, ".mida"))).toBe(false)
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirA })).toMatchObject({ ok: true })
    expect(await checkProject(owner, { agent: "codex", cwd: dirA })).toMatchObject({ ok: true })
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirB })).toEqual({ ok: false, reason: "not-a-project" })
  })

  it("mida unlink needs a real terminal, is refused through the daemon, and 'no' changes nothing (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-uref-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-uref-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-uref-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-uref" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    await runCli(["link", dirA], {
      home, network, cwd: dirB, print: () => {},
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
    })

    const refused: string[] = []
    expect(await runCli(["unlink"], {
      home, network, cwd: dirB, print: (line) => refused.push(line),
      prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true,
    })).toBe(2)
    expect(refused).toEqual([NEEDS_TERMINAL_LINE])
    const daemonLines: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-unlink-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["unlink"], stub, (line) => daemonLines.push(line))).toBe(2)
    expect(daemonLines[0]).toContain("mida unlink")
    // an answer other than yes keeps B's marker and its row
    const out: string[] = []
    expect(await runCli(["unlink"], {
      home, network, cwd: dirB, print: (line) => out.push(line),
      prompt: async () => "no", stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(1)
    expect(out).toContain("not approved")
    expect(existsSync(join(dirB, ".mida", "project.json"))).toBe(true)
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirB })).toMatchObject({ ok: true })
  })

  it("mida unlink refuses on the project's only folder and where nothing is marked (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-ux-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-ux-a-"))
    const bare = mkdtempSync(join(tmpdir(), "mida-ux-bare-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-ux" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    const out: string[] = []
    const runIn = (cwd: string, ...argv: string[]) =>
      runCli(argv, {
        home, network, cwd, print: (line) => out.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    // the only folder cannot leave — that would orphan the project
    expect(await runIn(dirA, "unlink")).toBe(1)
    expect(out.at(-1)).toContain("orphan")
    // and a folder with no project marker has nothing to unlink
    expect(await runIn(bare, "unlink")).toBe(1)
    expect(out.at(-1)).toContain("nothing to unlink")
    // a stray argument is usage, like every command
    expect(await runIn(bare, "unlink", "x")).toBe(2)
    expect(out.at(-1)).toBe(USAGE)
    // nothing moved: A is still approved and marked
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirA })).toMatchObject({ ok: true })
    expect(existsSync(join(dirA, ".mida", "project.json"))).toBe(true)
  })

  it("mida unlink --folder removes a deleted folder's rows from anywhere (in-16 B3)", async () => {
    const { home, owner, network } = folderHome("mida-unflag-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-unflag-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-unflag-b-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-unflag" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    await approveProject(owner, { agent: "codex", cwd: dirA })
    // link B, then delete it — the folder unlink would have to run inside is gone
    const lines: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: dirB, print: (line) => lines.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    const gone = realpathSync(dirB)
    rmSync(dirB, { recursive: true, force: true })

    const out: string[] = []
    const asked: string[] = []
    expect(await runCli(["unlink", "--folder", gone], {
      home, network, cwd: dirA, print: (line) => out.push(line),
      prompt: async (q) => { asked.push(q); return "yes" }, stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    expect(asked).toEqual(["Type yes to unlink: "])
    expect(out.some((line) => line.includes("is gone"))).toBe(true)
    expect(out.at(-1)).toContain("unlinked")
    // B's rows left the signed list for every agent; A's stand
    const file = home.readJson<{ entries: { root: string }[] }>("approved-projects.json")!
    expect(file.entries).toHaveLength(2)
    expect(file.entries.every((e) => e.root === realpathSync(dirA))).toBe(true)
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirA })).toMatchObject({ ok: true })
  })

  it("mida link run inside a subfolder of the source is the stated no-op — exit 0, no writes (in-16 B4)", async () => {
    const { home, owner, network } = folderHome("mida-linksub-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-linksub-a-"))
    const sub = join(dirA, "sub")
    mkdirSync(sub)
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-lsub" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    const lines: string[] = []
    const asked: string[] = []
    expect(await runCli(["link", dirA], {
      home, network, cwd: sub, print: (line) => lines.push(line),
      prompt: async (q) => { asked.push(q); return "yes" }, stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    // no question was asked — linking the subfolder would silently split it off, so the plan
    // answers "already belongs" and exits clean
    expect(asked).toEqual([])
    expect(lines.at(-1)).toContain("already")
    expect(existsSync(join(sub, ".mida"))).toBe(false)
  })

  it("a refused link on a fresh home creates no owner secrets (in-16 L8)", async () => {
    // no loadOrCreateOwnerSecrets — this home has never had owner material
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-fresh-home-")))
    const network = { deployment: { capabilityRegistry: REGISTRY } } as unknown as Network
    const dirB = mkdtempSync(join(tmpdir(), "mida-fresh-b-"))
    const out: string[] = []
    expect(await runCli(["link", join(dirB, "does-not-exist")], {
      home, network, cwd: dirB, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(1)
    expect(out.at(-1)).toContain("not a folder that exists")
    // the refusal asked nothing and created nothing — secrets appear only once a write needs them
    expect(home.has("owner/secrets.json")).toBe(false)
  })

  it("mida unlink --folder needs its argument and refuses unknown flags (in-16 B3)", async () => {
    const { home, network } = folderHome("mida-unarg-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-unarg-a-"))
    const out: string[] = []
    const runIn = (...argv: string[]) =>
      runCli(argv, {
        home, network, cwd: dirA, print: (line) => out.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await runIn("unlink", "--folder")).toBe(2)
    expect(out.at(-1)).toBe(USAGE)
    expect(await runIn("unlink", "--bogus", "x")).toBe(2)
  })

  it("mida project new marks a fresh project in a bare folder — no parent, no question (lk-1)", async () => {
    const { home, network } = folderHome("mida-pnew-home-")
    const bare = mkdtempSync(join(tmpdir(), "mida-pnew-bare-"))
    const lines: string[] = []
    const asked: string[] = []
    expect(await runCli(["project", "new"], {
      home, network, cwd: bare, print: (line) => lines.push(line),
      prompt: async (question) => { asked.push(question); return "yes" },
      stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe(0)
    // nothing to confirm against — no parent project to leave, so no question is asked
    expect(asked).toEqual([])
    const marker = JSON.parse(readFileSync(join(bare, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toMatch(/^[0-9a-f-]{36}$/)
    expect(lines.some((line) => line.includes(marker.projectId))).toBe(true)
    expect(lines.at(-1)).toContain("mida approve")
  })

  it("mida project new inside a project asks which project the folder stops using (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-pnest-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-pnest-a-"))
    const nested = join(dirA, "inner")
    mkdirSync(nested)
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-pnest" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    const lines: string[] = []
    const run = (answer: string) =>
      runCli(["project", "new"], {
        home, network, cwd: nested, print: (line) => lines.push(line),
        prompt: async () => answer, stdinIsTTY: true, stdoutIsTTY: true,
      })
    // no — nothing is written, the folder still belongs to the parent
    expect(await run("no")).toBe(1)
    expect(lines).toContain("not approved")
    expect(lines.some((line) => line.includes("p-pnest"))).toBe(true)
    expect(existsSync(join(nested, ".mida"))).toBe(false)
    // yes — a fresh id in nested's own marker; the parent's rows are untouched
    expect(await run("yes")).toBe(0)
    const marker = JSON.parse(readFileSync(join(nested, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).not.toBe("p-pnest")
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirA })).toMatchObject({ ok: true })
    // and claude-code is NOT approved for the new project — approval is per project
    expect(await checkProject(owner, { agent: "claude-code", cwd: nested })).toEqual({ ok: false, reason: "not-approved" })
  })

  it("mida project new needs a real terminal and is refused through the daemon (lk-1)", async () => {
    const { home, network } = folderHome("mida-pref-home-")
    const bare = mkdtempSync(join(tmpdir(), "mida-pref-bare-"))
    const refused: string[] = []
    expect(await runCli(["project", "new"], {
      home, network, cwd: bare, print: (line) => refused.push(line),
      prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true,
    })).toBe(2)
    expect(refused).toEqual([NEEDS_TERMINAL_LINE])
    const daemonLines: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-pnew-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["project", "new"], stub, (line) => daemonLines.push(line))).toBe(2)
    expect(daemonLines[0]).toContain("mida project")
    expect(existsSync(join(bare, ".mida"))).toBe(false)
  })

  it("mida project new refuses a folder that is already its own project, and wrong args (lk-1)", async () => {
    const { home, owner, network } = folderHome("mida-px-home-")
    const dirA = mkdtempSync(join(tmpdir(), "mida-px-a-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "p-px" }))
    await approveProject(owner, { agent: "claude-code", cwd: dirA })
    const out: string[] = []
    const runIn = (cwd: string, ...argv: string[]) =>
      runCli(argv, {
        home, network, cwd, print: (line) => out.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    // already its own project — a second marker would strand the old one's rows
    expect(await runIn(dirA, "project", "new")).toBe(1)
    expect(out.at(-1)).toContain("p-px")
    // wrong subcommand and stray args are usage, like every command
    expect(await runIn(dirA, "project")).toBe(2)
    expect(out.at(-1)).toBe(USAGE)
    expect(await runIn(dirA, "project", "old")).toBe(2)
    expect(await runIn(dirA, "project", "new", "extra")).toBe(2)
    expect(await checkProject(owner, { agent: "claude-code", cwd: dirA })).toMatchObject({ ok: true })
  })
})

/**
 * in-15 J-8 — the dev launcher `bin/mida` must run on a checkout that has no `.env`: node
 * fails hard when an `--env-file` target is missing, and older Node has no
 * `--env-file-if-exists`, so the script passes the flag only when the file exists. The test
 * root is a throwaway checkout holding only the three paths the script touches.
 */
describe("the dev launcher bin/mida (in-15 J-8)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

  const makeRoot = (prefix = "mida-bin-") => {
    const root = mkdtempSync(join(tmpdir(), prefix))
    mkdirSync(join(root, "bin"), { recursive: true })
    mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true })
    mkdirSync(join(root, "apps", "midad", "src"), { recursive: true })
    writeFileSync(join(root, "bin", "mida"), readFileSync(join(repoRoot, "bin", "mida"), "utf8"))
    writeFileSync(join(root, "node_modules", "tsx", "dist", "loader.mjs"), "")
    writeFileSync(join(root, "apps", "midad", "src", "cli.ts"), 'console.log(`sentinel=${process.env.MIDA_J8_SENTINEL ?? "unset"}`)\n')
    return root
  }

  const runLauncher = (root: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn("sh", [join(root, "bin", "mida")], { env: { PATH: process.env.PATH ?? "" } })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("error", reject)
      child.on("close", (code) => done({ code, stdout, stderr }))
    })

  it("runs with no .env — and an existing .env is still loaded", async () => {
    const root = makeRoot()
    const bare = await runLauncher(root)
    expect(bare.code).toBe(0)
    expect(bare.stdout).toContain("sentinel=unset")
    writeFileSync(join(root, ".env"), "MIDA_J8_SENTINEL=found\n")
    const loaded = await runLauncher(root)
    expect(loaded.code).toBe(0)
    expect(loaded.stdout).toContain("sentinel=found")
  }, 60_000)

  it("loads .env when the checkout path contains a space (in-16 K-5)", async () => {
    // An unquoted $ENV_ARG split `--env-file=/tmp/mida bin/…/.env` at the space — node then saw a
    // missing flag target and stray arguments. The quoted expansion passes it as one argument.
    const root = makeRoot("mida bin space-")
    writeFileSync(join(root, ".env"), "MIDA_J8_SENTINEL=spaced\n")
    const loaded = await runLauncher(root)
    expect(loaded.code).toBe(0)
    expect(loaded.stdout).toContain("sentinel=spaced")
  }, 60_000)
})

// in-18: the three command tables' membership is part of the trust model — `task` reads
// checkpoints so it may run through the daemon (/cli) but never as an owner or bare-terminal
// command; `add-agent` and `export` stay owner + terminal + listed. Pinned so a later command
// move cannot silently widen what the socket or a non-terminal will run.
describe("the command tables' membership is pinned (in-18)", () => {
  it("task is a daemon-routable command but never an owner or terminal command", () => {
    expect(CLI_COMMANDS).toContain("task")
    expect(OWNER_COMMANDS).not.toContain("task")
    expect(TERMINAL_COMMANDS).not.toContain("task")
  })

  it("add-agent and export are listed, owner-only and terminal-bound", () => {
    for (const command of ["add-agent", "export"]) {
      expect(CLI_COMMANDS).toContain(command)
      expect(OWNER_COMMANDS).toContain(command)
      expect(TERMINAL_COMMANDS).toContain(command)
    }
  })
})
