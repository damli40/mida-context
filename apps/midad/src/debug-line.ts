import { BaseError } from "viem"
import { displaySafeLine } from "@mida/protocol"
import { chainRefusalReason } from "./chain-busy.js"

/**
 * The refusal code an error earns at the `mida` command's printing boundary: its own string
 * `code` when it carries one, `chain-busy` when the chain could not be asked (in-6 R4),
 * `CHAIN_CALL_FAILED` for a viem chain error, `UNEXPECTED` for everything else. Never `ERROR` —
 * the Sep 22 incident was a bare `refused: ERROR` that named nothing (CHAIN-09). Naming lives
 * here and only here: `toMidaError` and its callers keep their behaviour.
 */
export function refusalCode(error: unknown): string {
  // before the code read: a chain that could not answer names its real reason — busy,
  // misconfigured or refused-key (in-11 R-8)
  const chainReason = chainRefusalReason(error)
  if (chainReason !== undefined) return chainReason
  const code = (error as { code?: unknown } | null | undefined)?.code
  // the code is untrusted text a store or chain wrote — fold it before it reaches a refused: line
  if (typeof code === "string" && code !== "") return displaySafeLine(code, 64)
  if (error instanceof BaseError) return "CHAIN_CALL_FAILED"
  return "UNEXPECTED"
}

/**
 * The masked one-line detail `MIDA_DEBUG=1` asks for: each level's name, shortMessage ?? message
 * and details, walking `cause` up to five levels of the chain. Long hex runs (keys, signatures,
 * hashes) collapse to `<hex>` so the line can name a failure without echoing material; the first
 * six newline-lines are kept, joined by " / ", and the detail is capped at 900 characters.
 * For an error with no cause this is exactly the line the old inline blocks printed.
 */
export function debugLine(error: unknown): string {
  const texts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const e = current as {
      name?: unknown
      shortMessage?: unknown
      message?: unknown
      details?: unknown
      cause?: unknown
    }
    const text = [e.name, e.shortMessage ?? e.message, e.details]
      .filter((part) => typeof part === "string")
      .join(" | ")
    if (text !== "") texts.push(text)
    current = e.cause
  }
  const text = texts
    .join("\n")
    .split("\n")
    .slice(0, 6)
    .join(" / ")
    .replace(/[0-9a-fA-F]{40,}/g, "<hex>")
    .slice(0, 900)
  return `debug: ${text}`
}
