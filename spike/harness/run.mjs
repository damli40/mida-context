// harness/run.mjs — run one A→B handoff experiment.
//
//   node harness/run.mjs --capture tool|hook|none --deliver inject|tool|none
//                        --run <n> [--a-seconds 240] [--dry-run]
//                        [--codex-auth <path>]
//                        [--agent-a-cmd|--agent-b-cmd '<json argv>'] (tests only)
//
// --dry-run creates the run dir + config files and PRINTS the two agent
// commands (one JSON object per line) instead of executing them.
// --codex-auth <path> symlinks <runDir>/codex-home/auth.json to that path so
// Agent B gets a login; the file is never opened, copied, or logged.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, "server", "mida-toy.mjs");
const CAPTURE_HOOK = path.join(ROOT, "hooks", "capture.mjs");
const INJECT_HOOK = path.join(ROOT, "hooks", "inject.mjs");
const TOY_TASK = path.join(ROOT, "toy-task");
const WATCH = "msUntilAvailable"; // string in bucket.mjs that ends A's run early

// ==================== AGENT COMMAND BLOCK ====================
// REVIEWER: these are the exact argv arrays handed to each agent CLI.
// Correct the flags here after testing them by hand — nothing else builds
// agent commands. EXTRACTOR_CMD is the cheap model the capture hook runs.
const EXTRACTOR_CMD =
  process.env.MIDA_SPIKE_EXTRACTOR_CMD ||
  '["claude","-p","--model","haiku","--setting-sources","project","--strict-mcp-config"]';

// A shell-exported Anthropic key overrides the normal Claude login and can
// silently produce a zero-token "success" — strip both names from Agent A's
// env (and, in capture-worker.mjs, the extractor's). Only a boolean saying
// the vars were present is ever recorded; values are never logged.
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

const agentAArgv = (prompt, { mcpConfig, settings }) => [
  "claude", "-p", prompt,
  "--model", "sonnet",
  "--permission-mode", "acceptEdits",
  "--allowedTools",
  "Edit Write Read Glob Grep Bash(node *) Bash(npm test*) Bash(git *) mcp__mida__mida_checkpoint",
  "--setting-sources", "project",
  "--strict-mcp-config",
  ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
  ...(settings ? ["--settings", settings] : []),
  "--output-format", "stream-json",
  "--verbose",
];

// REVIEWER (verified by hand 2026-09-20, codex-cli 0.142.5): Codex skips any hook the user has
// not personally trusted (it stores a hash of the command) — silently. The per-run bypass is
// acceptable here only because CODEX_HOME is a throwaway folder whose hooks this harness wrote.
const agentBArgv = () =>
  ["codex", "exec", "--dangerously-bypass-hook-trust", "Continue.",
    "--skip-git-repo-check", "--sandbox", "workspace-write"];
// =============================================================

const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const hookCmd = (script, env) =>
  `${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(" ")} node ${q(script)}`;
const git = (cwd, a) => execFileSync("git", a, { cwd, encoding: "utf8" });

function parseArgs(argv) {
  const args = { aSeconds: 240, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--a-seconds") args.aSeconds = Number(argv[++i]);
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!["tool", "hook", "none"].includes(args.capture)) throw new Error("bad --capture");
  if (!["inject", "tool", "none"].includes(args.deliver)) throw new Error("bad --deliver");
  if (args.run === undefined) throw new Error("--run required");
  return args;
}

function writeConfigs(runDir, store, { capture, deliver, "codex-auth": codexAuth }) {
  const written = [];
  const write = (rel, text) => {
    const p = path.join(runDir, rel);
    fs.writeFileSync(p, text);
    written.push(p);
    return p;
  };
  if (capture === "tool") {
    write("claude-mcp.json", JSON.stringify({
      mcpServers: { mida: { command: "node", args: [SERVER],
        env: { MIDA_SPIKE_STORE: store, MIDA_SPIKE_AGENT: "claude-code" } } },
    }, null, 2));
  }
  if (capture === "hook") {
    const entry = [{ hooks: [{ type: "command", command: hookCmd(CAPTURE_HOOK, {
      MIDA_SPIKE_STORE: store, MIDA_SPIKE_AGENT: "claude-code",
      MIDA_SPIKE_EXTRACTOR_CMD: EXTRACTOR_CMD }) }] }];
    write("claude-settings.json", JSON.stringify({
      hooks: { Stop: entry, PreCompact: entry, SessionEnd: entry, PostToolUse: entry } }, null, 2));
  }
  fs.mkdirSync(path.join(runDir, "codex-home"), { recursive: true });
  if (codexAuth) {
    // Symlink only — the target's contents are never opened, copied, or
    // logged. resolve() makes a relative --codex-auth path absolute so the
    // link stays valid regardless of cwd.
    fs.symlinkSync(
      path.resolve(codexAuth),
      path.join(runDir, "codex-home", "auth.json"),
    );
  }
  if (deliver !== "none") {
    let toml = "";
    if (deliver === "tool") {
      toml += `[mcp_servers.mida]\ncommand = "node"\nargs = [${JSON.stringify(SERVER)}]\n\n` +
        `[mcp_servers.mida.env]\nMIDA_SPIKE_STORE = ${JSON.stringify(store)}\n` +
        `MIDA_SPIKE_AGENT = "codex"\n\n`;
    }
    if (deliver === "inject") {
      toml += `[[hooks.SessionStart]]\nmatcher = "startup|resume|clear|compact"\n\n` +
        `[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(
          hookCmd(INJECT_HOOK, { MIDA_SPIKE_STORE: store, MIDA_SPIKE_AGENT: "codex" }))}\n\n`;
    }
    // Always emit a capture hook for Codex so the reviewer can see whether
    // Codex fires Stop events at all.
    toml += `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\n` +
      `command = ${JSON.stringify(hookCmd(CAPTURE_HOOK, {
        MIDA_SPIKE_STORE: store, MIDA_SPIKE_AGENT: "codex",
        MIDA_SPIKE_EXTRACTOR_CMD: EXTRACTOR_CMD }))}\n`;
    write(path.join("codex-home", "config.toml"), toml);
  }
  return written;
}

function setupRun(args) {
  const runDir = path.join(ROOT, "results", `${args.capture}-${args.deliver}`, String(args.run));
  const store = path.join(runDir, "store");
  const work = path.join(runDir, "work");
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(store, { recursive: true });
  // TASK.md stays OUT of the work copy — a baseline Agent B could otherwise
  // read the objective and constraints from disk. A still gets the task from
  // the original file via the prompt below.
  fs.cpSync(TOY_TASK, work, {
    recursive: true,
    filter: (src) => path.basename(src) !== "TASK.md",
  });
  git(work, ["init", "-q"]);
  git(work, ["add", "-A"]);
  git(work, ["-c", "user.email=spike@local", "-c", "user.name=mida-spike",
    "commit", "-qm", "initial"]);
  return { runDir, store, work, configPaths: writeConfigs(runDir, store, args) };
}

function snapshotDiff(work, outFile) {
  fs.writeFileSync(outFile,
    `=== git status ===\n${git(work, ["status", "--porcelain"])}\n=== git diff ===\n${git(work, ["diff", "HEAD"])}`);
}

function summarize(store) {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(store, name), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const tally = (rows, key) => rows.reduce((m, r) => {
    const k = key(r); m[k] = (m[k] || 0) + 1; return m;
  }, {});
  return {
    checkpoints: read("checkpoints.jsonl").length,
    toolCalls: tally(read("calls.jsonl"), (c) => `${c.agent}:${c.tool}`),
    hookEvents: tally(read("hook-events.jsonl"), (e) => e.event ?? "unknown"),
  };
}

// Spawn a child with a hard lifetime cap; SIGTERM then SIGKILL after 5 s.
// abortSignal triggers an early stop (reason taken from signal.reason).
// stripEnv names env vars to remove from the child's inherited environment.
function runChild(argv, { cwd, env, stripEnv = [], stdout, stderr, limitMs, abortSignal }) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    for (const k of stripEnv) delete childEnv[k];
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: childEnv, stdio: ["ignore", stdout, stderr],
    });
    const started = Date.now();
    let reason = "exit";
    const stop = (why) => {
      reason = why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const timer = setTimeout(() => stop("timeout"), limitMs);
    abortSignal?.addEventListener("abort", () => stop(abortSignal.reason || "aborted"), { once: true });
    const done = (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, seconds: Math.round((Date.now() - started) / 1000), reason });
    };
    child.on("exit", done);
    child.on("error", (err) => {
      reason = `spawn error: ${err.message}`;
      done(null);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runDir, store, work, configPaths } = setupRun(args);

  const taskText = fs.readFileSync(path.join(TOY_TASK, "TASK.md"), "utf8") +
    (args.capture === "tool"
      ? "\n\nUse the mida_checkpoint tool after each step and each design decision."
      : "");
  const codexHome = path.join(runDir, "codex-home");
  // --agent-a-cmd / --agent-b-cmd (JSON argv strings) exist for tests so the
  // harness can run fake agents without the real CLIs; defaults stay the
  // constant block above.
  const commands = [
    { agent: "A", cwd: work, env: {}, argv: args["agent-a-cmd"]
      ? JSON.parse(args["agent-a-cmd"])
      : agentAArgv(taskText, {
          mcpConfig: configPaths.find((p) => p.endsWith("claude-mcp.json")),
          settings: configPaths.find((p) => p.endsWith("claude-settings.json")),
        }) },
    { agent: "B", cwd: work, env: { CODEX_HOME: codexHome },
      argv: args["agent-b-cmd"] ? JSON.parse(args["agent-b-cmd"]) : agentBArgv() },
  ];
  if (args.dryRun) {
    for (const c of commands) process.stdout.write(JSON.stringify(c) + "\n");
    return;
  }

  // --- Agent A ---
  const apiKeyVarsStripped = API_KEY_VARS.some(
    (k) => process.env[k] !== undefined || commands[0].env[k] !== undefined,
  );
  const aOut = fs.openSync(path.join(runDir, "a-output.jsonl"), "w");
  const abort = new AbortController();
  const poll = setInterval(() => {
    try {
      if (fs.readFileSync(path.join(work, "src", "bucket.mjs"), "utf8").includes(WATCH)) {
        abort.abort("msUntilAvailable implemented");
      }
    } catch { /* file not written yet */ }
  }, 2000);
  const a = await runChild(commands[0].argv, {
    cwd: work, env: commands[0].env, stripEnv: API_KEY_VARS, stdout: aOut, stderr: "inherit",
    limitMs: args.aSeconds * 1000, abortSignal: abort.signal,
  });
  clearInterval(poll);
  fs.closeSync(aOut);

  // Count assistant turns in A's stream-json output. A run where A emitted
  // nothing must never look normal — warn loudly on stderr.
  let aTurns = 0;
  try {
    for (const line of fs.readFileSync(path.join(runDir, "a-output.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      try {
        if (JSON.parse(line).type === "assistant") aTurns++;
      } catch { /* partial or non-JSON line */ }
    }
  } catch { /* no output file */ }
  const aProducedOutput = aTurns > 0;
  if (!aProducedOutput) {
    console.error(
      "*** WARNING: Agent A produced no assistant output (aTurns=0). Check the " +
        "Claude login/quota — a dead shell API key is one cause. Treat this run as invalid. ***",
    );
  }
  snapshotDiff(work, path.join(runDir, "a-final.diff"));

  // The capture hook returns instantly but leaves work in
  // store/inflight/*.json; a detached worker finishes the checkpoint. Wait
  // for the queue to drain (max 150 s) so B sees all captures, then record
  // how long that took and how many jobs were abandoned.
  const inflightDir = path.join(store, "inflight");
  const inflightLeft = () => {
    try {
      return fs.readdirSync(inflightDir).length;
    } catch {
      return 0;
    }
  };
  const waitStart = Date.now();
  while (inflightLeft() > 0 && Date.now() - waitStart < 150_000) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const captureWaitMs = Date.now() - waitStart;
  const inflightAbandoned = inflightLeft();

  // --- Agent B ---
  // REVIEWER: a fresh CODEX_HOME has no login. Seed <runDir>/codex-home with
  // auth (or point B at your real home) before real runs — not automated here.
  const bOut = fs.openSync(path.join(runDir, "b-output.txt"), "w");
  const b = await runChild(commands[1].argv, {
    cwd: work, env: commands[1].env, stdout: bOut, stderr: bOut, limitMs: 600_000,
  });
  fs.closeSync(bOut);
  snapshotDiff(work, path.join(runDir, "b-final.diff"));

  const tests = spawnSync("node", ["--test"], { cwd: work, encoding: "utf8" });
  const run = {
    capture: args.capture, deliver: args.deliver, run: Number(args.run),
    aStopReason: a.reason, aSeconds: a.seconds,
    aTurns, aProducedOutput, apiKeyVarsStripped,
    captureWaitMs, inflightAbandoned,
    bSeconds: b.seconds, bExitCode: b.exitCode,
    ...summarize(store),
    testsPassAfterB: tests.status === 0,
  };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));
  process.stdout.write(JSON.stringify(run) + "\n");
}

main().catch((err) => {
  console.error(`harness: ${err.message}`);
  process.exit(1);
});
