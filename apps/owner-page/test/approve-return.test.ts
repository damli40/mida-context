import { describe, expect, it, vi } from "vitest"
import type { Address } from "@mida/protocol"
import { UNACCEPTABLE_REQUEST_TEXT, parseOwnerResult } from "@mida/protocol"
import { base64UrlEncode } from "../src/check/bytes.js"

const OWNER = "0x1111111111111111111111111111111111111111" as Address
const AGENT = `0x${"22".repeat(32)}`
const NONCE = "abcdef0123456789"
const PORT = 4321

// The manifest-name refusal throws out of prepareApprove before any passkey prompt — the real
// throw is pinned in flows.test.ts and the rule itself in errors-constants.test.ts. Here the
// throw is staged so the page's own entry point is checked end to end: a refused request used
// to leave the terminal waiting out its ten-minute timeout (review 3.3).
vi.mock("../src/owner/flows.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/owner/flows.js")>()
  const { UnacceptableCharactersError } = await import("@mida/protocol")
  return {
    ...actual,
    prepareApprove: async () => {
      throw new UnacceptableCharactersError()
    },
  }
})

interface FakeEl {
  tag: string
  textContent: string
  hidden: boolean
  disabled: boolean
  childElementCount: number
  children: FakeEl[]
  appendChild(child: FakeEl): void
  replaceChildren(...nodes: FakeEl[]): void
  addEventListener(): void
}

function fakeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    textContent: "",
    hidden: false,
    disabled: false,
    childElementCount: 0,
    children: [],
    appendChild(child) {
      el.children.push(child)
    },
    replaceChildren(...nodes) {
      el.children = [...nodes]
      el.childElementCount = el.children.length
    },
    addEventListener() {},
  }
  return el
}

describe("approve entry — a refusal before signing answers the terminal (in-37)", () => {
  it("a refused manifest name returns the fixed sentence through the link's port", async () => {
    const ids = [
      "pairing-label",
      "pairing-code",
      "identity-line",
      "summary",
      "sign-list",
      "go",
      "error",
      "progress",
      "result",
      "result-status",
      "result-json",
    ]
    const els = new Map<string, FakeEl>()
    for (const id of ids) els.set(id, fakeEl("div"))

    const fragment = new URLSearchParams({
      v: "1",
      nonce: NONCE,
      port: String(PORT),
      req: base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            chainId: 10143,
            owner: OWNER,
            request: { agentId: AGENT },
            // a name the in-37 rule refuses — the look-alike quote and colon letters
            manifest: { name: `x${String.fromCharCode(0x02ba)} Advisor${String.fromCharCode(0xa4fd)} low risk. ${String.fromCharCode(0x02ba)}` },
          }),
        ),
      ),
    }).toString()

    const g = globalThis as Record<string, unknown>
    const saved = { document: g.document, location: g.location, window: g.window, navigator: g.navigator }
    const topLocation = { href: "" }
    g.document = {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: (tag: string) => fakeEl(tag),
    }
    g.location = { hash: `#${fragment}`, hostname: "app.midacontext.xyz" }
    g.window = {
      top: { location: topLocation },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    }
    Object.defineProperty(globalThis, "navigator", {
      value: { credentials: {} },
      configurable: true,
      writable: true,
    })
    try {
      await import("../src/owner/approve.js")
      // main() is fire-and-forget — a few turns let the refused prepare reach the catch.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))

      // The page shows the same fixed sentence it always did, and the sign button stays off.
      expect(els.get("error")!.textContent).toBe(UNACCEPTABLE_REQUEST_TEXT)
      expect(els.get("go")!.disabled).toBe(true)

      // And the terminal gets the failure at once — the same sentence as the reason — not a
      // ten-minute wait for a page that will never sign.
      expect(topLocation.href.startsWith(`http://127.0.0.1:${PORT}/mida-return#`)).toBe(true)
      const params = new URLSearchParams(new URL(topLocation.href).hash.slice(1))
      expect(params.get("nonce")).toBe(NONCE)
      const result = parseOwnerResult(params.get("result")!)
      expect(result.status).toBe("failed")
      expect(result.reason).toBe(UNACCEPTABLE_REQUEST_TEXT)
      expect(result.transactions).toEqual([])
      expect(result.operations).toEqual([])
    } finally {
      g.document = saved.document
      g.location = saved.location
      g.window = saved.window
      Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true, writable: true })
    }
  })
})
