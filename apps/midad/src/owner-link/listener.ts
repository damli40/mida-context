import { createServer } from "node:http"
import type { Server } from "node:http"
import { randomBytes } from "node:crypto"
import { sha256 } from "@noble/hashes/sha2.js"
import { parseOwnerResult } from "@mida/protocol"
import type { OwnerLinkResult } from "@mida/protocol"

/**
 * The terminal's half of the owner-page return channel. The page finishes its work and navigates
 * to `http://127.0.0.1:<port>/mida-return#nonce=…&result=…`; the fragment never leaves the
 * browser, so the tiny page this listener serves reads `location.hash` and POSTs it back. One
 * listener waits for exactly one result, bound to one nonce — anything else is refused.
 */

const RETURN_PATH = "/mida-return"
const MAX_BODY_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** The 8-byte nonce the link and the result share — 16 lowercase hex characters. */
export function newOwnerNonce(): string {
  return randomBytes(8).toString("hex")
}

export interface ReturnListener {
  port: number
  /** Resolves once with the decoded result; rejects OWNER_LINK_TIMEOUT / OWNER_LINK_CLOSED. */
  result: Promise<OwnerLinkResult>
  close(): void
}

// The inline script is the only thing the CSP allows — its hash is pinned in the header, so the
// page cannot grow a second script without the header changing too. Keep it on one line: the
// hash below is computed over exactly these bytes.
const RETURN_SCRIPT =
  `fetch("/mida-return",{method:"POST",body:location.hash.slice(1)})` +
  `.then(function(r){document.getElementById("m").textContent=r.ok?"You can close this tab":"Return to your terminal"})` +
  `.catch(function(){document.getElementById("m").textContent="Return to your terminal"})`

const RETURN_SCRIPT_SHA256 = Buffer.from(sha256(new TextEncoder().encode(RETURN_SCRIPT))).toString("base64")

const RETURN_PAGE = `<!doctype html><meta charset="utf-8"><title>Mida</title>` +
  `<p id="m">Returning the result to your terminal…</p>` +
  `<script>${RETURN_SCRIPT}</script>`

const RETURN_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    `default-src 'none'; script-src 'sha256-${RETURN_SCRIPT_SHA256}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const

export function listenerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * Bind 127.0.0.1 on an ephemeral port and wait for the page's one POST. The promise resolves with
 * the decoded result exactly once: a wrong nonce, a second POST, or a POST after settle gets 409;
 * a malformed body gets 400; any other path gets 404. No CORS headers — the only allowed caller
 * is the page this server just served.
 */
export function startReturnListener(input: { nonce: string; timeoutMs?: number }): Promise<ReturnListener> {
  const nonce = input.nonce
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let resolveResult: (r: OwnerLinkResult) => void
  let rejectResult: (e: Error) => void
  const resultPromise = new Promise<OwnerLinkResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // The waiter attaches handlers later; an unhandled rejection on timeout/close must not crash the process.
  resultPromise.catch(() => {})

  let settled = false
  let server: Server
  const timer = setTimeout(() => {
    finish(undefined, listenerError("OWNER_LINK_TIMEOUT", "the owner page did not return within 10 minutes"))
  }, timeoutMs)
  timer.unref()

  function finish(result: OwnerLinkResult | undefined, error?: Error): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      server.close()
    } catch {
      // already closing
    }
    if (result !== undefined) resolveResult(result)
    else rejectResult(error ?? listenerError("OWNER_LINK_CLOSED", "the listener was closed before a result arrived"))
  }

  function readBody(req: import("node:http").IncomingMessage, done: (body: string | null) => void): void {
    const chunks: Buffer[] = []
    let total = 0
    let tooBig = false
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        // keep draining so the socket stays alive long enough to send the 400
        tooBig = true
        return
      }
      if (!tooBig) chunks.push(chunk)
    })
    req.on("end", () => done(tooBig ? null : Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => done(null))
  }

  function handlePost(body: string, res: import("node:http").ServerResponse): void {
    if (settled) {
      res.writeHead(409, { "content-type": "text/plain" }).end("this listener already has its result")
      return
    }
    const params = new URLSearchParams(body)
    const gotNonce = params.get("nonce")
    const encoded = params.get("result")
    if (gotNonce === null || encoded === null) {
      res.writeHead(400, { "content-type": "text/plain" }).end("the return needs nonce and result")
      return
    }
    if (gotNonce !== nonce) {
      res.writeHead(409, { "content-type": "text/plain" }).end("that result is not for this terminal")
      return
    }
    let result: OwnerLinkResult
    try {
      result = parseOwnerResult(encoded)
    } catch (error) {
      res.writeHead(400, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : "bad result")
      return
    }
    if (result.nonce !== gotNonce) {
      res.writeHead(400, { "content-type": "text/plain" }).end("the result's nonce does not match the fragment's")
      return
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    finish(result)
  }

  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url ?? ""
      if (req.method === "GET" && url === RETURN_PATH) {
        res.writeHead(200, RETURN_PAGE_HEADERS).end(RETURN_PAGE)
        return
      }
      if (req.method === "POST" && url === RETURN_PATH) {
        readBody(req, (body) => {
          if (body === null) {
            if (!res.writableEnded) res.writeHead(400, { "content-type": "text/plain" }).end("the return body is too large")
            return
          }
          handlePost(body, res)
        })
        return
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found")
    })
    server.on("error", (error) => {
      finish(undefined, listenerError("OWNER_LINK_CLOSED", `the return listener failed: ${error.message}`))
      reject(error)
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(listenerError("OWNER_LINK_CLOSED", "the return listener could not bind"))
        return
      }
      resolve({
        port: address.port,
        result: resultPromise,
        close: () => finish(undefined),
      })
    })
  })
}
