import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT, tmpdir, validCp, readJsonl } from "./helpers.mjs";

test("server: lists the two tools and round-trips a checkpoint", async () => {
  const store = tmpdir();
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(ROOT, "server", "mida-toy.mjs")],
    env: { ...process.env, MIDA_SPIKE_STORE: store, MIDA_SPIKE_AGENT: "test-agent" },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["mida_checkpoint", "mida_handoff"]);

    const cp = validCp();
    const r1 = await client.callTool({ name: "mida_checkpoint", arguments: cp });
    assert.equal(r1.isError, undefined);
    assert.match(r1.content[0].text, /stored/i);

    const r2 = await client.callTool({ name: "mida_handoff", arguments: {} });
    assert.match(r2.content[0].text, /Implement the TokenBucket rate limiter/);
    assert.match(r2.content[0].text, /MIDA HANDOFF/);
  } finally {
    await client.close();
  }

  const calls = readJsonl(path.join(store, "calls.jsonl"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.tool), ["mida_checkpoint", "mida_handoff"]);
  assert.ok(calls.every((c) => c.agent === "test-agent" && c.ok === true));

  // calls.jsonl must not contain any argument text
  const raw = fs.readFileSync(path.join(store, "calls.jsonl"), "utf8");
  assert.ok(!raw.includes("Implement the TokenBucket rate limiter"));
  assert.ok(!raw.includes("evt-00000001"));
});

test("server: mida_handoff on empty store returns the no-handoff message", async () => {
  const store = tmpdir();
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(ROOT, "server", "mida-toy.mjs")],
    env: { ...process.env, MIDA_SPIKE_STORE: store, MIDA_SPIKE_AGENT: "codex" },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "mida_handoff", arguments: {} });
    assert.match(r.content[0].text, /No Mida handoff exists for this workspace\./);
  } finally {
    await client.close();
  }
});
