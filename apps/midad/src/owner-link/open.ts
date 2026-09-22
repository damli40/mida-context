import { spawn as nodeSpawn } from "node:child_process"
import { pairingCode } from "@mida/protocol"

/**
 * Hand the owner action to the browser page. The link, the pairing code and the warning print
 * FIRST, before any spawn — if the machine cannot open a browser the owner still has everything
 * they need to paste the link themselves.
 */

export interface OpenOwnerLinkDeps {
  print?: (line: string) => void
  platform?: NodeJS.Platform | string
  /** Injectable for tests; defaults to node:child_process.spawn. */
  spawn?: (command: string, args: string[]) => {
    on(event: "error", listener: (error: Error) => void): unknown
    on(event: "close", listener: (code: number | null) => void): unknown
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

  const platform = deps.platform ?? process.platform
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined
  if (command === undefined) return

  const spawn = deps.spawn ?? (nodeSpawn as unknown as NonNullable<OpenOwnerLinkDeps["spawn"]>)
  await new Promise<void>((resolve) => {
    let child
    try {
      child = spawn(command, [link.url])
    } catch {
      print("Could not open a browser — open the link above yourself.")
      resolve()
      return
    }
    child.on("error", () => {
      print("Could not open a browser — open the link above yourself.")
      resolve()
    })
    child.on("close", (code) => {
      if (code !== 0) print("Could not open a browser — open the link above yourself.")
      resolve()
    })
  })
}
