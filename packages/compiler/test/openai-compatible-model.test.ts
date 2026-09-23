// openai-compatible-model.mjs (M3-D5) — the one OpenAI-compatible compile command, with the
// provider picked by argv[2]: deepseek | kimi | custom. These tests spawn the real script
// against a LOCAL fake HTTP server; no real model API is ever contacted. Keys are placeholders
// that must never appear in stdout, stderr or any error.
//
// Each provider reads its OWN variables: <PREFIX>_API_KEY / _BASE_URL / _MODEL|_MODEL_ID /
// _TIMEOUT_MS, and the endpoint path comes from the provider table — DeepSeek posts to
// /chat/completions directly under the base while Moonshot's lives under /v1.

import { afterEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("../src/openai-compatible-model.mjs", import.meta.url))
const KEY = "provider-test-key-" + "not-real"

interface Reply {
  status: number
  body?: unknown
  /** When true the request is accepted and never answered — the client timeout must fire. */
  hang?: boolean
}

interface Seen {
  method?: string
  path?: string
  authorization?: string
  body?: Record<string, unknown>
}

async function fakeApi(reply: Reply): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      seen.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
      })
      if (reply.hang === true) return
      res.writeHead(reply.status, { "content-type": "application/json" })
      res.end(JSON.stringify(reply.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

let server: { url: string; seen: Seen[]; close(): Promise<void> } | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

/** Runs the generic script as `openai-compatible-model.mjs <provider>` with a minimal env. */
function runModel(provider: string | undefined, input: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, provider === undefined ? [SCRIPT] : [SCRIPT, provider], {
      env: { PATH: process.env.PATH, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe("openai-compatible-model.mjs — provider argument", () => {
  it("a provider name that is not deepseek, kimi or custom exits 1 with a safe line and sends nothing", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "x" } }] } })
    for (const bad of ["deepseek-v4-pro", "openai", ""]) {
      const r = await runModel(bad, "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
      expect(r.code).toBe(1)
      expect(r.stdout).toBe("")
      expect(r.stderr).not.toContain(KEY)
    }
    expect(server.seen).toHaveLength(0)
    const missing = await runModel(undefined, "p", {})
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe("")
  })
})

describe("openai-compatible-model.mjs — deepseek provider", () => {
  it("posts to /chat/completions directly under the base, with the key in the header only and no temperature", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { role: "assistant", content: '{"objective":"x"}' } }] } })
    const r = await runModel("deepseek", "the extract prompt", {
      DEEPSEEK_API_KEY: KEY,
      DEEPSEEK_BASE_URL: server.url,
      DEEPSEEK_MODEL: "deepseek-flash",
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{"objective":"x"}')
    expect(r.stderr).toBe("")
    expect(server.seen).toHaveLength(1)
    const req = server.seen[0]!
    expect(req.method).toBe("POST")
    expect(req.path).toBe("/chat/completions")
    expect(req.authorization).toBe(`Bearer ${KEY}`)
    expect(req.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "the extract prompt" }],
      max_tokens: 8000,
    })
    expect("temperature" in req.body!).toBe(false)
    expect(JSON.stringify(req.body)).not.toContain(KEY)
  })

  it("a 429 exits 1 with exactly 'deepseek http 429' on stderr and nothing on stdout", async () => {
    server = await fakeApi({ status: 429, body: { error: { message: "rate limited" } } })
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("deepseek http 429\n")
  })

  it("an error body containing the key string is never echoed", async () => {
    server = await fakeApi({ status: 500, body: { error: `bad key ${KEY} rejected` } })
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("deepseek http 500\n")
    expect(r.stderr).not.toContain(KEY)
    expect(r.stdout).not.toContain(KEY)
  })

  it("a missing DEEPSEEK_API_KEY exits with the variable NAME and sends nothing", async () => {
    server = await fakeApi({ status: 200, body: {} })
    const r = await runModel("deepseek", "p", { DEEPSEEK_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("deepseek: DEEPSEEK_API_KEY is not set\n")
    expect(server.seen).toHaveLength(0)
  })

  it("plain http to a non-loopback host makes NO request — the key and text never leave", async () => {
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: "http://example.com" })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("deepseek: DEEPSEEK_BASE_URL must be https\n")
  })

  it("a server that never answers is given up on at DEEPSEEK_TIMEOUT_MS", async () => {
    server = await fakeApi({ status: 200, hang: true })
    const started = Date.now()
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url, DEEPSEEK_TIMEOUT_MS: "300" })
    expect(r.code).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.stderr).not.toContain(KEY)
  }, 10_000)

  it("DEEPSEEK_MODEL overrides the model name sent in the body", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "ok" } }] } })
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url, DEEPSEEK_MODEL: "deepseek-other" })
    expect(r.code).toBe(0)
    expect(server.seen[0]!.body!.model).toBe("deepseek-other")
  })
})

describe("openai-compatible-model.mjs — kimi provider (same code the shim invokes)", () => {
  it("posts to /v1/chat/completions under the base and fails as 'kimi http <status>'", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "ok" } }] } })
    const r = await runModel("kimi", "p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(r.code).toBe(0)
    expect(server.seen[0]!.path).toBe("/v1/chat/completions")
    expect(server.seen[0]!.authorization).toBe(`Bearer ${KEY}`)

    const limited = await fakeApi({ status: 503 })
    const r2 = await runModel("kimi", "p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: limited.url })
    expect(r2.code).toBe(1)
    expect(r2.stderr).toBe("kimi http 503\n")
    await limited.close()
  })
})

describe("openai-compatible-model.mjs — cache usage on stderr (M3-H)", () => {
  const okBody = (usage: unknown) => ({ choices: [{ message: { content: "ok" } }], usage })

  it("a deepseek usage object becomes 'cache hit=<n> miss=<m>' on stderr, stdout untouched", async () => {
    server = await fakeApi({ status: 200, body: okBody({ prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 42 }) })
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("ok")
    expect(r.stderr).toBe("cache hit=7 miss=42\n")
  })

  it("a full usage object yields all four numbers — the cache line AND 'tokens in=<p> out=<c>' (telemetry)", async () => {
    server = await fakeApi({
      status: 200,
      body: okBody({
        prompt_tokens: 50,
        completion_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 42,
      }),
    })
    const r = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("ok")
    expect(r.stderr).toBe("cache hit=7 miss=42\ntokens in=50 out=12\n")
  })

  it("kimi accepts the same two names plus its alternates — flat and nested cached_tokens", async () => {
    // the two deepseek-style names
    server = await fakeApi({ status: 200, body: okBody({ prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 9 }) })
    const same = await runModel("kimi", "p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(same.stderr).toBe("cache hit=3 miss=9\n")
    await server.close()

    // the flat alternate
    server = await fakeApi({ status: 200, body: okBody({ cached_tokens: 4, prompt_cache_miss_tokens: 9 }) })
    const flat = await runModel("kimi", "p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(flat.stderr).toBe("cache hit=4 miss=9\n")
    await server.close()

    // the nested alternate
    server = await fakeApi({
      status: 200,
      body: okBody({ prompt_tokens_details: { cached_tokens: 6 }, prompt_cache_miss_tokens: 9 }),
    })
    const nested = await runModel("kimi", "p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(nested.stderr).toBe("cache hit=6 miss=9\n")
  })

  it("no usage object — or one without a complete pair — prints nothing extra", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "ok" } }] } })
    const none = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(none.code).toBe(0)
    expect(none.stderr).toBe("")
    await server.close()

    // total_tokens alone is neither pair — the lines are pair-or-nothing
    server = await fakeApi({ status: 200, body: okBody({ total_tokens: 62 }) })
    const empty = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(empty.code).toBe(0)
    expect(empty.stderr).toBe("")
    await server.close()

    // and only one half of the token pair is still nothing
    server = await fakeApi({ status: 200, body: okBody({ prompt_tokens: 50 }) })
    const half = await runModel("deepseek", "p", { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url })
    expect(half.code).toBe(0)
    expect(half.stderr).toBe("")
  })
})

describe("openai-compatible-model.mjs — custom provider (your own endpoint)", () => {
  it("needs no key: no Authorization header is sent when MIDA_COMPILE_API_KEY is unset", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "ok" } }] } })
    // an Ollama-style base: the /v1 prefix is part of the base URL the user supplies
    const r = await runModel("custom", "p", {
      MIDA_COMPILE_BASE_URL: `${server.url}/v1`,
      MIDA_COMPILE_MODEL_ID: "qwen-local",
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("ok")
    const req = server.seen[0]!
    expect(req.path).toBe("/v1/chat/completions")
    expect(req.authorization).toBeUndefined()
    expect(req.body).toEqual({ model: "qwen-local", messages: [{ role: "user", content: "p" }], max_tokens: 8000 })
  })

  it("sends the Bearer header only when MIDA_COMPILE_API_KEY is set", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "ok" } }] } })
    const r = await runModel("custom", "p", {
      MIDA_COMPILE_API_KEY: KEY,
      MIDA_COMPILE_BASE_URL: server.url,
      MIDA_COMPILE_MODEL_ID: "m",
    })
    expect(r.code).toBe(0)
    expect(server.seen[0]!.authorization).toBe(`Bearer ${KEY}`)
  })

  it("missing MIDA_COMPILE_BASE_URL / MIDA_COMPILE_MODEL_ID exit naming the variable — no request", async () => {
    server = await fakeApi({ status: 200, body: {} })
    const noBase = await runModel("custom", "p", { MIDA_COMPILE_MODEL_ID: "m" })
    expect(noBase.code).toBe(1)
    expect(noBase.stdout).toBe("")
    expect(noBase.stderr).toBe("custom: MIDA_COMPILE_BASE_URL is not set\n")

    const noModel = await runModel("custom", "p", { MIDA_COMPILE_BASE_URL: server.url })
    expect(noModel.code).toBe(1)
    expect(noModel.stderr).toBe("custom: MIDA_COMPILE_MODEL_ID is not set\n")

    expect(server.seen).toHaveLength(0)
  })

  it("the https/loopback rule applies to custom too — a remote http endpoint is refused", async () => {
    const r = await runModel("custom", "p", { MIDA_COMPILE_BASE_URL: "http://192.0.2.1:11434/v1", MIDA_COMPILE_MODEL_ID: "m" })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("custom: MIDA_COMPILE_BASE_URL must be https\n")
  })

  it("a bracketed-IPv6 loopback base passes the endpoint check — [::1] IS ::1", async () => {
    // nothing listens on [::1]:1, so the request itself must fail — the point is the
    // refusal is NOT "must be https": the URL check accepted the loopback address
    const r = await runModel("custom", "p", { MIDA_COMPILE_BASE_URL: "http://[::1]:1/v1", MIDA_COMPILE_MODEL_ID: "m", MIDA_COMPILE_TIMEOUT_MS: "2000" })
    expect(r.code).toBe(1)
    expect(r.stderr).not.toContain("must be https")
  })

  it("a failure keeps the '<name> http <status>' contract and never echoes the body", async () => {
    server = await fakeApi({ status: 500, body: { error: `key ${KEY} in body` } })
    const r = await runModel("custom", "p", {
      MIDA_COMPILE_API_KEY: KEY,
      MIDA_COMPILE_BASE_URL: server.url,
      MIDA_COMPILE_MODEL_ID: "m",
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("custom http 500\n")
    expect(r.stderr).not.toContain(KEY)
  })
})
