import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets, scrubTranscript } from "../hooks/scrub.mjs";

const HEX64 = "abcdef0123456789".repeat(4);

test("scrub: env assignments whose value is wrapped in escaped quotes", () => {
  const out = scrubSecrets('export API_KEY=\\"hunter2-real-secret\\" && run');
  assert.ok(out.includes("API_KEY=[REDACTED]"), out);
  assert.ok(!out.includes("hunter2"), out);
});

test("scrub: JSON/YAML key-value pairs redact the value, keep the key", () => {
  for (const [input, key] of [
    ['"apiKey": "deadbeefcafe1234"', '"apiKey"'],
    ["privateKey: deadbeefcafe1234", "privateKey"],
    ["'client_secret' : 'deadbeefcafe1234'", "'client_secret'"],
    ["api_token=deadbeefcafe1234", "api_token"],
  ]) {
    const out = scrubSecrets(input);
    assert.ok(!out.includes("deadbeefcafe1234"), input);
    assert.ok(out.includes(key), input);
    assert.ok(out.includes("[REDACTED]"), input);
  }
});

test("scrub: short values and ordinary prose survive unchanged", () => {
  for (const text of [
    "the key idea is simple",
    'key: "user:42"',
    '"apiKey": "shrt"',
    '"password": "a long sentence here"',
  ]) {
    assert.equal(scrubSecrets(text), text, text);
  }
});

test("scrub: Bearer tokens redact in header and bare form", () => {
  for (const input of [
    "Authorization: Bearer tok-abc123def456",
    "Bearer tok-abc123def456",
    "authorization: bearer tok-abc123def456",
  ]) {
    const out = scrubSecrets(input);
    assert.ok(!out.includes("tok-abc123def456"), input);
    assert.ok(/[Bb]earer \[REDACTED\]/.test(out), input);
  }
});

test("scrub: bare 64-hex strings redact without a 0x prefix", () => {
  assert.equal(scrubSecrets(`pk ${HEX64} end`), "pk [REDACTED] end");
  assert.ok(!scrubSecrets(`0x${HEX64}`).includes(HEX64));
});

test("scrubTranscript: decoded JSON lines get every string scrubbed", () => {
  const line = JSON.stringify({ content: 'export API_KEY="hunter2-real-secret" && run' });
  const out = scrubTranscript(line);
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(JSON.parse(out).content.includes("[REDACTED]"), out);
});

test("scrubTranscript: sensitive JSON keys redact their values at any depth", () => {
  const line = JSON.stringify({
    cfg: { privateKey: HEX64, apiKey: "plainApiKeyValue42", note: "fine" },
  });
  const out = scrubTranscript(line);
  assert.ok(!out.includes(HEX64), out);
  assert.ok(!out.includes("plainApiKeyValue42"), out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.cfg.privateKey, "[REDACTED]");
  assert.equal(parsed.cfg.note, "fine");
});

test("scrubTranscript: unparseable lines fall back to raw scrubbing", () => {
  const line = 'broken tail API_KEY=\\"hunter2-real-secret\\" && run';
  const out = scrubTranscript(line);
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(out.includes("API_KEY=[REDACTED]"), out);
});

test("scrubTranscript: non-secret sentences survive a JSONL round trip", () => {
  const line = JSON.stringify({
    a: "the key idea is simple",
    b: 'key: "user:42"',
  });
  const parsed = JSON.parse(scrubTranscript(line));
  assert.equal(parsed.a, "the key idea is simple");
  assert.equal(parsed.b, 'key: "user:42"');
});
