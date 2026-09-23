#!/usr/bin/env node
// openai-compatible-model.mjs — the one OpenAI-compatible compile call (M3-D5).
//
//   node openai-compatible-model.mjs <deepseek|kimi|custom>   (transcript prompt on stdin)
//
// The provider picks its OWN variables and endpoint path from the table below — the same
// table the TypeScript side mirrors in model-choice.ts; keep the two in step:
//
//   provider   key var                    base var (default)                  model var (default)                path
//   deepseek   DEEPSEEK_API_KEY           DEEPSEEK_BASE_URL (api.deepseek.com)  DEEPSEEK_MODEL (deepseek-flash)   /chat/completions
//   kimi       KIMI_API_KEY               KIMI_BASE_URL (api.moonshot.ai)       KIMI_MODEL (kimi-k2.7-code-…)/v1/chat/completions
//   custom     MIDA_COMPILE_API_KEY       MIDA_COMPILE_BASE_URL (required)      MIDA_COMPILE_MODEL_ID (required)  /chat/completions
//              (optional — a local server may need none)
//
// Deliberate properties:
//   - the API key is NEVER an argument — it arrives by environment only, goes only into
//     the Authorization header, and is never printed, logged, or embedded in an error.
//   - the request body is fixed — no temperature, one user message, max_tokens 8000 — so a
//     provider or model change cannot silently change the call shape.
//   - the endpoint must be https, or http on loopback only (a local ollama-style server);
//     a remote http endpoint is refused before the transcript is ever read or sent.
//   - failures are written to stderr as "<provider> http <status>" and the process exits 1
//     with NOTHING on stdout — stderr is the controlled channel; the response body itself is
//     never echoed.
//   - on success two more stderr lines are allowed: "cache hit=<n> miss=<m>", printed only when
//     the response's usage object carries the provider's cache counters (deepseek:
//     prompt_cache_hit_tokens / prompt_cache_miss_tokens; kimi: the same two names, or
//     cached_tokens / prompt_tokens_details.cached_tokens for the hit — the exact field is
//     unverified, so any of them counts, and no pair means no line), and "tokens in=<p> out=<c>",
//     printed only when usage carries prompt_tokens and completion_tokens. Nothing else from
//     the body is ever printed.
import { isIP } from "node:net"

const PROVIDERS = {
  deepseek: {
    keyVar: "DEEPSEEK_API_KEY",
    baseVar: "DEEPSEEK_BASE_URL",
    baseDefault: "https://api.deepseek.com",
    modelVar: "DEEPSEEK_MODEL",
    modelDefault: "deepseek-flash",
    timeoutVar: "DEEPSEEK_TIMEOUT_MS",
    path: "/chat/completions",
  },
  kimi: {
    keyVar: "KIMI_API_KEY",
    baseVar: "KIMI_BASE_URL",
    baseDefault: "https://api.moonshot.ai",
    modelVar: "KIMI_MODEL",
    modelDefault: "kimi-k2.7-code-highspeed",
    timeoutVar: "KIMI_TIMEOUT_MS",
    path: "/v1/chat/completions",
  },
  custom: {
    keyVar: "MIDA_COMPILE_API_KEY", // optional — a local server may need none
    baseVar: "MIDA_COMPILE_BASE_URL", // required — where YOUR endpoint listens
    baseDefault: undefined,
    modelVar: "MIDA_COMPILE_MODEL_ID", // required — the model id your endpoint knows
    modelDefault: undefined,
    timeoutVar: "MIDA_COMPILE_TIMEOUT_MS",
    path: "/chat/completions",
  },
}

const provider = PROVIDERS[process.argv[2] ?? ""]

const fail = (line) => {
  process.stderr.write(`${line}\n`)
  process.exit(1)
}

if (provider === undefined) fail("openai-compatible-model: provider must be deepseek, kimi or custom")
const name = process.argv[2]

const key = process.env[provider.keyVar]
if (provider.keyVar !== "MIDA_COMPILE_API_KEY" && (key === undefined || key === "")) fail(`${name}: ${provider.keyVar} is not set`)
const base = process.env[provider.baseVar] ?? provider.baseDefault
if (base === undefined) fail(`${name}: ${provider.baseVar} is not set`)
const model = process.env[provider.modelVar] ?? provider.modelDefault
if (model === undefined) fail(`${name}: ${provider.modelVar} is not set`)
const timeoutMs = Number(process.env[provider.timeoutVar] ?? "120000")
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail(`${name}: ${provider.timeoutVar} is not a number`)

// The endpoint must be https — or http on a loopback address, so a local
// ollama-style server is allowed but nothing plain-text ever leaves the machine.
// This check runs BEFORE the transcript is read: a bad endpoint never sees it.
let url
try {
  url = new URL(`${base.replace(/\/+$/, "")}${provider.path}`)
} catch {
  fail(`${name}: ${provider.baseVar} must be https`)
}
// url.hostname keeps IPv6 brackets ("[::1]") — strip them before comparing
const host = url.hostname.replace(/^\[|\]$/g, "")
const loopbackHttp =
  url.protocol === "http:" && (host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127.")))
if (!(url.protocol === "https:" || loopbackHttp)) {
  fail(`${name}: ${provider.baseVar} must be https`)
}

let input = ""
process.stdin.setEncoding("utf8")
try {
  for await (const chunk of process.stdin) input += chunk
} catch {
  fail(`${name}: stdin failed`)
}

try {
  const headers = { "content-type": "application/json" }
  if (key !== undefined && key !== "") headers.authorization = `Bearer ${key}`
  const response = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: input }],
      max_tokens: 8000,
    }),
  })
  if (response.status !== 200) {
    // drain the socket so it frees — the body itself is never read as text, never echoed
    await response.arrayBuffer().catch(() => {})
    fail(`${name} http ${response.status}`)
  }
  // a 200 whose body is not JSON or holds no message content is the controlled failure too
  const body = await response.json().catch(() => undefined)
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== "string" || content === "") fail(`${name}: response held no content`)
  process.stdout.write(content)
  // the usage lines go to the controlled stderr channel — numbers only, and only
  // when the provider actually reported both halves of each pair
  const usage = body?.usage
  if (usage !== null && typeof usage === "object") {
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
    const hit =
      num(usage.prompt_cache_hit_tokens) ?? num(usage.cached_tokens) ?? num(usage.prompt_tokens_details?.cached_tokens)
    const miss = num(usage.prompt_cache_miss_tokens)
    if (hit !== undefined && miss !== undefined) process.stderr.write(`cache hit=${hit} miss=${miss}\n`)
    const input = num(usage.prompt_tokens)
    const output = num(usage.completion_tokens)
    if (input !== undefined && output !== undefined) process.stderr.write(`tokens in=${input} out=${output}\n`)
  }
} catch (error) {
  fail(error instanceof Error && error.name === "TimeoutError" ? `${name}: request timed out` : `${name}: request failed`)
}
