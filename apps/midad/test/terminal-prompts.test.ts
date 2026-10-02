// UF-QB3: the two real terminal prompts take their streams as parameters, so a fake
// PassThrough pair can drive them — no pty, no real terminal, and never a real binary.

import { describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import { terminalPromptOrAbandoned, terminalSecretPrompt } from "@mida/midad"

describe("the real terminal prompts (UF-QB)", () => {
  /** A fake stdin: a PassThrough with the TTY surface the prompts touch. */
  const fakeStdin = () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void }
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (m: boolean) => {
      stdin.isRaw = m
    }
    return stdin
  }
  const fakeStdout = () => {
    const out = new PassThrough()
    const written: string[] = []
    const orig = out.write.bind(out)
    out.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk))
      return (orig as (...a: unknown[]) => boolean)(chunk as never, ...rest as never[])
    }) as typeof out.write
    return { out, written }
  }

  it("the typed prompt resolves undefined when the stream ends before an answer, and ends the line", async () => {
    const stdin = fakeStdin()
    const { out, written } = fakeStdout()
    const answer = terminalPromptOrAbandoned("Pick: ", stdin, out)
    stdin.push(null)
    expect(await answer).toBe(undefined)
    expect(written).toContain("\n")
  })

  it("the typed prompt resolves the typed line and writes no extra break", async () => {
    const stdin = fakeStdin()
    const { out, written } = fakeStdout()
    const answer = terminalPromptOrAbandoned("Pick: ", stdin, out)
    stdin.write("2\n")
    expect(await answer).toBe("2")
    expect(written).not.toContain("\n")
    // a second prompt on the same streams still works
    const second = terminalPromptOrAbandoned("Again: ", stdin, out)
    stdin.write("yes\n")
    expect(await second).toBe("yes")
  })

  it("the hidden prompt answers, restores raw mode and drops its listeners", async () => {
    const stdin = fakeStdin()
    const { out } = fakeStdout()
    const before = stdin.listenerCount("data")
    const answer = terminalSecretPrompt("Key: ", stdin as never, out)
    expect(stdin.isRaw).toBe(true)
    stdin.write(Buffer.from("sk-live\n"))
    expect(await answer).toEqual({ key: "sk-live", trailing: false })
    expect(stdin.isRaw).toBe(false)
    expect(stdin.listenerCount("data")).toBe(before)
  })

  it("the hidden prompt resolves undefined on Ctrl-C, restores raw mode and drops its listeners", async () => {
    const stdin = fakeStdin()
    const { out, written } = fakeStdout()
    const before = stdin.listenerCount("data")
    const answer = terminalSecretPrompt("Key: ", stdin as never, out)
    stdin.write(Buffer.from([0x03]))
    expect(await answer).toBe(undefined)
    expect(stdin.isRaw).toBe(false)
    expect(stdin.listenerCount("data")).toBe(before)
    expect(written).toContain("\n")
    // a second prompt on the same streams still works after the abandon
    const second = terminalSecretPrompt("Key: ", stdin as never, out)
    stdin.write(Buffer.from("sk-2\n"))
    expect(await second).toEqual({ key: "sk-2", trailing: false })
    expect(stdin.isRaw).toBe(false)
  })
})
