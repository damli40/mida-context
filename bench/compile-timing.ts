// CAP-11 — where does compile time go? The summary step takes ~50 s through
// `claude -p --model haiku` against 9–19 s in the spike; this tool measures the
// two halves of that question on the same prompt:
//   path A — today's default compile command exactly as drain-main.ts builds
//            it (DEFAULT_MODEL: claude -p --model <id> --setting-sources
//            project --strict-mcp-config, prompt on stdin), wall time per call
//   path B — one direct HTTPS POST to https://api.anthropic.com/v1/messages
//            with the same prompt, key read from process.env[<--key-env>] at
//            call time
// NEVER run in CI or by the bench runner: both paths call a real model. The
// key's VALUE is never printed, logged, put in an error, or written to disk;
// an unset variable exits `key-env-unset` naming the variable only.

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { request } from "node:https"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { DEFAULT_MODEL, buildExtractPrompt, scrubSecrets } from "../packages/compiler/src/index.js"

export interface TimingArgs {
  input: string
  n: number
  keyEnv: string
  model: string
}

type ParseResult = { ok: true; args: TimingArgs } | { ok: false; error: string }

const USAGE =
  "usage: compile-timing --input <file> [--n 5] --key-env <ENV_VAR_NAME> [--model haiku]"

/** Flag/value pairs only — argument errors name flags, never values. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const args: TimingArgs = { input: "", n: 5, keyEnv: "", model: "haiku" }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    const take = (): string | undefined => {
      i += 1
      return value
    }
    switch (flag) {
      case "--input": {
        const v = take()
        if (v === undefined || v.startsWith("--")) return { ok: false, error: "--input needs a file" }
        args.input = v
        break
      }
      case "--n": {
        const v = take()
        const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
        if (!Number.isInteger(n) || n < 1 || String(n) !== v) {
          return { ok: false, error: "--n needs a positive integer" }
        }
        args.n = n
        break
      }
      case "--key-env": {
        const v = take()
        if (v === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
          return { ok: false, error: "--key-env needs an environment variable NAME" }
        }
        args.keyEnv = v
        break
      }
      case "--model": {
        const v = take()
        if (v === undefined || v.startsWith("--")) return { ok: false, error: "--model needs an id" }
        args.model = v
        break
      }
      default:
        return { ok: false, error: `unknown argument ${flag}` }
    }
  }
  if (args.input === "") return { ok: false, error: "--input is required" }
  if (args.keyEnv === "") return { ok: false, error: "--key-env is required" }
  return { ok: true, args }
}

type CallResult = { ms: number; detail: string | null }

// Path A — the default compile command verbatim from compile.ts's DEFAULT_MODEL
// (drain-main.ts passes compileCheckpoint with no model override, so this argv
// IS what every drain runs), with --model's id substituted when given. Same
// child hygiene as compile.ts: the key names are stripped so a shell-exported
// key cannot hijack the CLI's own login, MIDA_INNER marks the subprocess so a
// capture hook ignores it, the child is its own process group so a timeout
// kills everything it spawned.
function runCliCall(prompt: string, model: string, timeoutMs = 90_000): Promise<CallResult> {
  const argv = [...DEFAULT_MODEL.argv]
  const at = argv.indexOf("--model")
  if (at >= 0 && at + 1 < argv.length) argv[at + 1] = model
  const t0 = Date.now()
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MIDA_INNER: "1" }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    let child
    try {
      child = spawn(argv[0] ?? "", argv.slice(1), {
        cwd: os.tmpdir(),
        env,
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      })
    } catch {
      resolve({ ms: Date.now() - t0, detail: "spawn-error" })
      return
    }
    let done = false
    const finish = (detail: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ms: Date.now() - t0, detail })
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
      child.stdout.destroy()
      child.stdin.destroy()
      finish("timeout")
    }, timeoutMs)
    // the reply text is discarded, so the attempt settles on 'exit' — there is
    // no stdout to wait for and no 'close' race that could hide a non-zero code
    child.on("error", () => finish("spawn-error"))
    child.on("exit", (code, signal) => {
      finish(code === 0 ? null : signal !== null ? `signal-${signal}` : `exit-${code}`)
    })
    child.stdout.resume() // drain the reply; the timing is what we want, not the text
    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
  })
}

// Path B — the raw HTTPS call the CLI wraps. The key arrives here as a
// function local, goes into one request header, and is never printed, logged,
// put in an error, or written anywhere. Non-2xx replies report the status
// code only; the body is drained and discarded.
function runApiCall(prompt: string, key: string, model: string, timeoutMs = 90_000): Promise<CallResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      max_tokens: 8_192,
      messages: [{ role: "user", content: prompt }],
    })
    const req = request(
      {
        method: "POST",
        host: "api.anthropic.com",
        path: "/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume() // drain; the status code is all we report
        res.on("end", () => {
          const status = res.statusCode ?? 0
          resolve({ ms: Date.now() - t0, detail: status >= 200 && status < 300 ? null : `http-${status}` })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve({ ms: Date.now() - t0, detail: "timeout" })
    })
    req.on("error", () => resolve({ ms: Date.now() - t0, detail: "request-error" }))
    req.end(body)
  })
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

/**
 * Returns the process exit code. Exported for the unit test, which covers
 * argument parsing and the key-env-unset exit only — no test may drive the
 * model paths.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`)
    return 2
  }
  const { input, n, keyEnv, model } = parsed.args
  const key = env[keyEnv]
  if (typeof key !== "string" || key === "") {
    process.stderr.write(`key-env-unset ${keyEnv}\n`)
    return 2
  }
  let raw: string
  try {
    raw = readFileSync(input, "utf8")
  } catch {
    process.stderr.write("input-unreadable\n")
    return 2
  }
  const prompt = buildExtractPrompt(scrubSecrets(raw))

  const aTimes: number[] = []
  const bTimes: number[] = []
  for (let i = 1; i <= n; i += 1) {
    const a = await runCliCall(prompt, model)
    aTimes.push(a.ms)
    console.log(`path-a[${i}] ${a.ms} ms${a.detail === null ? "" : ` (${a.detail})`}`)
    const b = await runApiCall(prompt, key, model)
    bTimes.push(b.ms)
    console.log(`path-b[${i}] ${b.ms} ms${b.detail === null ? "" : ` (${b.detail})`}`)
  }
  const aSorted = [...aTimes].sort((x, y) => x - y)
  const bSorted = [...bTimes].sort((x, y) => x - y)
  console.log(`path-a p50 ${percentile(aSorted, 0.5)} ms p95 ${percentile(aSorted, 0.95)} ms (n=${n})`)
  console.log(`path-b p50 ${percentile(bSorted, 0.5)} ms p95 ${percentile(bSorted, 0.95)} ms (n=${n})`)
  return 0
}

const invokedAs = process.argv[1] !== undefined ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (invokedAs) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
