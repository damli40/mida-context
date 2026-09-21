// kimi-model.mjs (R5-8) — the Moonshot-backed compile model command. These tests spawn the real
// script against a LOCAL fake HTTP server; the real api.moonshot.ai is never contacted. The key
// is a placeholder that must never appear in stdout, stderr or any error.

import { afterEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("../src/kimi-model.mjs", import.meta.url))
const KEY = "kimi-test-key-" + "not-real"

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

/** Runs the script with a minimal env — proves it needs nothing beyond its own variables. */
function runModel(input: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe("kimi-model.mjs — the Moonshot compile command (R5-8)", () => {
  it("a 200 answer writes the message text to stdout, and the request carries the key only in the header", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { role: "assistant", content: '{"objective":"x"}' } }] } })
    const r = await runModel("the extract prompt", {
      KIMI_API_KEY: KEY,
      KIMI_BASE_URL: server.url,
      KIMI_MODEL: "kimi-k2.7-code-highspeed",
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{"objective":"x"}')
    expect(r.stderr).toBe("")
    expect(server.seen).toHaveLength(1)
    const req = server.seen[0]!
    expect(req.method).toBe("POST")
    expect(req.path).toBe("/v1/chat/completions")
    expect(req.authorization).toBe(`Bearer ${KEY}`)
    // the contract Moonshot answers: model + messages + max_tokens, and NO temperature —
    // the API refuses any value but 1, so the body must not send it at all
    expect(req.body).toEqual({
      model: "kimi-k2.7-code-highspeed",
      messages: [{ role: "user", content: "the extract prompt" }],
      max_tokens: 8000,
    })
    expect("temperature" in req.body!).toBe(false)
    // the key rides the header only — never the body
    expect(JSON.stringify(req.body)).not.toContain(KEY)
  })

  it("a 429 exits 1 with exactly 'kimi http 429' on stderr and nothing on stdout", async () => {
    server = await fakeApi({ status: 429, body: { error: { message: "rate limited" } } })
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("kimi http 429\n")
  })

  it("an error body containing the key string is never echoed", async () => {
    server = await fakeApi({ status: 500, body: { error: `bad key ${KEY} rejected` } })
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("kimi http 500\n")
    expect(r.stderr).not.toContain(KEY)
    expect(r.stdout).not.toContain(KEY)
  })

  it("a 200 answer with no message content fails without echoing the body", async () => {
    server = await fakeApi({ status: 200, body: { note: `key ${KEY} looked fine` } })
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).not.toContain(KEY)
  })

  it("a missing KIMI_API_KEY fails before any request is made", async () => {
    server = await fakeApi({ status: 200, body: {} })
    const r = await runModel("p", { KIMI_BASE_URL: server.url })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr.trim()).not.toBe("")
    expect(server.seen).toHaveLength(0)
  })

  it("a server that never answers is given up on at the timeout", async () => {
    server = await fakeApi({ status: 200, hang: true })
    const started = Date.now()
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: server.url, KIMI_TIMEOUT_MS: "300" })
    expect(r.code).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.stderr).not.toContain(KEY)
  }, 10_000)

  it("plain http to a non-loopback host makes NO request — the key and text never leave", async () => {
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: "http://example.com" })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("kimi: KIMI_BASE_URL must be https\n")
  })

  it("an http URL that WOULD route to a listener still sends nothing — 0.0.0.0 is not loopback", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "x" } }] } })
    const port = new URL(server.url).port
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: `http://0.0.0.0:${port}` })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("kimi: KIMI_BASE_URL must be https\n")
    expect(server.seen).toHaveLength(0)
  })

  it("a value that is not a URL at all gets the same refusal, no request", async () => {
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: "not a url" })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("kimi: KIMI_BASE_URL must be https\n")
  })

  it("http on localhost is the allowed loopback exception — the test fake works", async () => {
    server = await fakeApi({ status: 200, body: { choices: [{ message: { content: "ok" } }] } })
    const port = new URL(server.url).port
    const r = await runModel("p", { KIMI_API_KEY: KEY, KIMI_BASE_URL: `http://localhost:${port}` })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("ok")
    expect(server.seen).toHaveLength(1)
  })
})
