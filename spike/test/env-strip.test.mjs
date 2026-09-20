import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, tmpdir, runHook, waitFor, capturesSettled } from "./helpers.mjs";

// Placeholder values — only NAMES are ever inspected, never real secrets.
const SECRET_ENV = {
  ANTHROPIC_API_KEY: "sk-test-placeholder",
  ANTHROPIC_AUTH_TOKEN: "tok-test-placeholder",
};
const BANNED = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const SILENT = JSON.stringify(["node", "-e", "process.exit(0)"]);

function runHarness(runName, aCmd, extraEnv = {}) {
  return spawnSync(
    "node",
    [
      path.join(ROOT, "harness", "run.mjs"),
      "--capture", "none",
      "--deliver", "none",
      "--run", runName,
      "--a-seconds", "30",
      "--agent-a-cmd", aCmd,
      "--agent-b-cmd", SILENT,
    ],
    { encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 90_000 },
  );
}

test("harness strips ANTHROPIC_* from Agent A's env (G2)", () => {
  const r = runHarness(
    "t-g2-env",
    JSON.stringify(["node", path.join(ROOT, "test", "fake-agent-env.mjs")]),
    SECRET_ENV,
  );
  assert.equal(r.status, 0, r.stderr);
  const runDir = path.join(ROOT, "results", "none-none", "t-g2-env");

  const lines = fs
    .readFileSync(path.join(runDir, "a-output.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  const names = JSON.parse(lines.find((l) => l.startsWith("[")));
  for (const k of BANNED) assert.ok(!names.includes(k), `${k} reached Agent A`);
  assert.ok(names.includes("PATH"), "PATH should still reach the child");

  const runText = fs.readFileSync(path.join(runDir, "run.json"), "utf8");
  const run = JSON.parse(runText);
  assert.equal(run.apiKeyVarsStripped, true);
  assert.equal(run.aProducedOutput, true);
  assert.equal(run.aTurns, 1);
  // the secret VALUES must not be logged anywhere
  assert.ok(!runText.includes("sk-test-placeholder"));
  assert.ok(!runText.includes("tok-test-placeholder"));
});

test("worker strips ANTHROPIC_* from the extractor's env (G2)", async () => {
  const dir = tmpdir();
  const store = path.join(dir, "store");
  const namesFile = path.join(dir, "env-names.txt");
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
  );

  const r = runHook("capture.mjs", {
    env: {
      MIDA_SPIKE_STORE: store,
      MIDA_SPIKE_AGENT: "claude-code",
      MIDA_SPIKE_EXTRACTOR_CMD: JSON.stringify([
        "node",
        path.join(ROOT, "test", "stub-env-extractor.mjs"),
      ]),
      MIDA_STUB_OUT: namesFile,
      ...SECRET_ENV,
    },
    input: { hook_event_name: "Stop", session_id: "s1", transcript_path: transcript },
  });
  assert.equal(r.status, 0);
  assert.ok(
    await waitFor(() => fs.existsSync(namesFile) || capturesSettled(store), 10_000),
    "extractor never ran",
  );
  const names = JSON.parse(
    fs.readFileSync(namesFile, "utf8").split("\n").find((l) => l.startsWith("[")),
  );
  for (const k of BANNED) assert.ok(!names.includes(k), `${k} reached the extractor`);
  assert.ok(names.includes("PATH"), "PATH should still reach the extractor");
});

test("harness warns loudly when Agent A produces no output (G2)", () => {
  const r = runHarness("t-g2-silent", SILENT);
  assert.equal(r.status, 0, r.stderr);
  const runDir = path.join(ROOT, "results", "none-none", "t-g2-silent");
  const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(run.aProducedOutput, false);
  assert.equal(run.aTurns, 0);
  assert.match(r.stderr, /no assistant output/i, "missing loud warning on stderr");
});
