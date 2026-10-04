import { spawn as nodeSpawn } from "node:child_process"
import { pairingCode } from "@mida/protocol"
import { isWindows } from "../platform.js"

/**
 * Hand the owner action to the browser page. The link, the pairing code and the warning print
 * FIRST, before any spawn — if the machine cannot open a browser the owner still has everything
 * they need to paste the link themselves.
 */

export interface OpenOwnerLinkDeps {
  print?: (line: string) => void
  platform?: NodeJS.Platform | string
  /** Injectable for tests; defaults to node:child_process.spawn. */
  spawn?: (command: string, args: string[], options: { stdio: "ignore" }) => {
    on(event: "error", listener: (error: Error) => void): unknown
    on(event: "exit", listener: (code: number | null) => void): unknown
  }
}

export async function openOwnerLink(
  link: { url: string; requestBytes: Uint8Array },
  deps: OpenOwnerLinkDeps = {},
): Promise<void> {
  const print = deps.print ?? ((line: string) => console.log(line))
  print(link.url)
  print(`pairing code: ${pairingCode(link.requestBytes)}`)
  print("Only approve if the page shows this same code.")

  // only an https link is ever opened; the link is already printed, so anything else is
  // for the owner to open by hand
  if (!link.url.startsWith("https://")) return

  const platform = deps.platform ?? process.platform
  // rundll32 hands the URL to the default browser without cmd.exe, so an & in the link is not a
  // command separator. It runs by its full System32 path: a bare name resolves against the
  // current folder first, and a rundll32.exe planted in a cloned project would run here.
  const rundll32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\rundll32.exe`
  const opener: [string, string[]] | undefined =
    platform === "darwin"
      ? ["open", [link.url]]
      : platform === "linux"
        ? ["xdg-open", [link.url]]
        : isWindows(platform as NodeJS.Platform)
          ? [rundll32, ["url.dll,FileProtocolHandler", link.url]]
          : undefined
  if (opener === undefined) return

  const spawn = deps.spawn ?? (nodeSpawn as unknown as NonNullable<OpenOwnerLinkDeps["spawn"]>)
  await new Promise<void>((resolve) => {
    let child
    try {
      child = spawn(opener[0], opener[1], { stdio: "ignore" })
    } catch {
      print("Could not open a browser — open the link above yourself.")
      resolve()
      return
    }
    let settled = false
    const done = (fallback: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fallback) print("Could not open a browser — open the link above yourself.")
      resolve()
    }
    child.on("error", () => done(true))
    // resolve on exit, not close: close waits for stdio that a detached browser never ends
    child.on("exit", (code) => done(code !== 0))
    // the browser may keep running after it takes the link; approve must not wait on it
    const timer = setTimeout(() => done(false), 5000)
  })
}
