#!/usr/bin/env node
// The Kimi compile model for mida (R5-8): the extract prompt arrives on stdin,
// the model's answer text goes to stdout. A direct HTTPS POST replaces the
// `claude` program start-up — measured Sep 21 at 8–12 s against Haiku's 20–24 s
// on the same transcript (docs/evidence/compile-model-speed-2026-09-21.json).
//
//   KIMI_API_KEY    required — Bearer credential. It lives in the environment
//                   only: never argv (it would show in `ps`), never printed,
//                   never logged, never written to disk, never in an error.
//   KIMI_BASE_URL   default https://api.moonshot.ai — tests point it at a fake.
//                   Whatever this names receives the API key AND the session's
//                   text, so the only schemes accepted are https:// everywhere
//                   and http:// on a loopback host (127.0.0.1, ::1, localhost).
//   KIMI_MODEL      default kimi-k2.7-code-highspeed.
//   KIMI_TIMEOUT_MS default 120000.
//
// The request sends NO temperature: Moonshot refuses any value but 1, so the
// body carries only model, messages and max_tokens (8000).
//
// Failure contract: any non-200 exits 1 with exactly "kimi http <status>" on
// stderr — the response body is never echoed, so a body that happened to
// contain the key cannot leak. Other failures get one safe line; stdout stays
// empty on every failure path.

const base = (process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai").replace(/\/+$/, "")
const model = process.env.KIMI_MODEL ?? "kimi-k2.7-code-highspeed"
const timeoutMs = Number.parseInt(process.env.KIMI_TIMEOUT_MS ?? "120000", 10)
const key = process.env.KIMI_API_KEY

const fail = (line) => {
  process.stderr.write(line + "\n")
  process.exit(1)
}

if (typeof key !== "string" || key === "") fail("kimi: KIMI_API_KEY is not set")
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("kimi: KIMI_TIMEOUT_MS is not a number")

// The endpoint check runs before stdin is even read: an http URL pointing anywhere but loopback
// would ship the key and the transcript to a stranger, so the answer is exit 1 and NO request.
let endpointOk = false
try {
  const url = new URL(base)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  endpointOk =
    url.protocol === "https:" ||
    (url.protocol === "http:" && (host === "127.0.0.1" || host === "::1" || host === "localhost"))
} catch {
  endpointOk = false
}
if (!endpointOk) fail("kimi: KIMI_BASE_URL must be https")

const chunks = []
process.stdin.on("data", (c) => chunks.push(c))
process.stdin.on("end", async () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 8000 }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status !== 200) {
      // drain the socket so it frees — the body itself is never read as text
      await res.arrayBuffer().catch(() => {})
      fail(`kimi http ${res.status}`)
    }
    const data = await res.json().catch(() => undefined)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== "string") fail("kimi: response held no message")
    process.stdout.write(content)
    process.exit(0)
  } catch (error) {
    fail(error instanceof Error && error.name === "TimeoutError" ? "kimi: request timed out" : "kimi: request failed")
  }
})
process.stdin.on("error", () => fail("kimi: stdin failed"))
