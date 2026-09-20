import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";

const VARIANTS = [
  ["tool", "inject"],
  ["tool", "tool"],
  ["hook", "inject"],
  ["hook", "tool"],
  ["none", "none"],
];

function dryRun(capture, deliver, run, extra = []) {
  const r = spawnSync(
    "node",
    [path.join(ROOT, "harness", "run.mjs"), "--capture", capture, "--deliver", deliver, "--run", run, ...extra, "--dry-run"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `expected 2 JSON lines, got: ${r.stdout}`);
  return { lines: lines.map((l) => JSON.parse(l)), stdout: r.stdout, runDir: path.join(ROOT, "results", `${capture}-${deliver}`, run) };
}

for (const [capture, deliver] of VARIANTS) {
  test(`harness --dry-run ${capture}/${deliver}`, () => {
    const run = `t-${capture}-${deliver}`;
    const { lines, runDir } = dryRun(capture, deliver, run);

    // two parseable command lines
    assert.equal(lines[0].agent, "A");
    assert.equal(lines[1].agent, "B");
    assert.equal(lines[0].argv[0], "claude");
    assert.equal(lines[1].argv[0], "codex");
    assert.ok(lines[0].cwd.endsWith(path.join(run, "work")));
    assert.ok(lines[1].env.CODEX_HOME.endsWith("codex-home"));

    // run directory + work copy + store exist
    assert.ok(fs.existsSync(path.join(runDir, "store")));
    assert.ok(fs.existsSync(path.join(runDir, "work", "src", "bucket.mjs")));
    assert.ok(!fs.existsSync(path.join(runDir, "work", "TASK.md")));

    // per-variant config files, and only those
    const has = (rel) => fs.existsSync(path.join(runDir, rel));
    assert.equal(has("claude-mcp.json"), capture === "tool");
    assert.equal(has("claude-settings.json"), capture === "hook");
    assert.equal(has(path.join("codex-home", "config.toml")), deliver !== "none");

    // agent A wiring
    const aArgv = lines[0].argv.join(" ");
    assert.equal(aArgv.includes("--mcp-config"), capture === "tool");
    assert.equal(aArgv.includes("--settings"), capture === "hook");
    assert.equal(
      lines[0].argv[2].includes("mida_checkpoint tool after each step"),
      capture === "tool",
    );

    // nothing written outside the run dir
    for (const stray of ["claude-mcp.json", "claude-settings.json", "codex-home", "work", "store"]) {
      assert.ok(!fs.existsSync(path.join(ROOT, stray)), `stray ${stray} at repo root`);
    }
  });
}

test("harness: work/ must not leak the task to a no-Mida Agent B (F5)", () => {
  const { runDir } = dryRun("none", "none", "t-f5-baseline");
  const work = path.join(runDir, "work");
  assert.ok(!fs.existsSync(path.join(work, "TASK.md")), "TASK.md must not be copied into work/");
  // nothing in work/ may state the constraints or the step plan
  const banned = ["no timers", "lazy refill", "KeyedLimiter"];
  const stack = [work];
  while (stack.length) {
    const p = stack.pop();
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
    } else if (st.isFile()) {
      const text = fs.readFileSync(p, "utf8");
      for (const s of banned) {
        assert.ok(!text.includes(s), `${path.relative(work, p)} leaks "${s}"`);
      }
    }
  }
});

test("harness: --codex-auth links codex-home/auth.json without leaking it (F6)", () => {
  // the "auth file" — contents must stay inside this file and nothing else
  const secret = "codex-auth-SECRET-d0-n0t-c0py-" + crypto.randomUUID();
  const authFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mida-auth-")), "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ token: secret }));

  const { stdout, runDir } = dryRun("none", "none", "t-f6-auth", ["--codex-auth", authFile]);
  const link = path.join(runDir, "codex-home", "auth.json");

  assert.ok(fs.lstatSync(link).isSymbolicLink(), "auth.json must be a symlink");
  assert.equal(fs.realpathSync(link), fs.realpathSync(authFile));

  // the secret content appears nowhere in the dry-run output...
  assert.ok(!stdout.includes(secret), "secret leaked into dry-run output");
  // ...nor inside any regular file in the run dir (the symlink itself is skipped)
  const stack = [runDir];
  while (stack.length) {
    const p = stack.pop();
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
    } else if (st.isFile() && !st.isSymbolicLink()) {
      assert.ok(
        !fs.readFileSync(p, "utf8").includes(secret),
        `${path.relative(runDir, p)} contains the auth secret`,
      );
    }
  }
});

test("harness --dry-run hook variant wires PostToolUse too (F4)", () => {
  const { runDir } = dryRun("hook", "inject", "t-hook-posttooluse");
  const settings = JSON.parse(
    fs.readFileSync(path.join(runDir, "claude-settings.json"), "utf8"),
  );
  for (const ev of ["Stop", "PreCompact", "SessionEnd", "PostToolUse"]) {
    assert.ok(settings.hooks[ev]?.length, `missing hook wiring for ${ev}`);
  }
});
