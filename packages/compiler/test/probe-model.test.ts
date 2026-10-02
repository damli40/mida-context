// probeModel (UF-P2a): one throwaway run per summariser entry so `mida summarizer
// test` can say whether a model can write a summary at all. Fake commands only —
// the real claude/codex are never spawned in a test.

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROBE_TRANSCRIPT, buildExtractPrompt, probeModel, type ModelCommand } from "../src/index.js"

const cmd = (script: string, over: Partial<ModelCommand> = {}): ModelCommand => ({
  argv: [process.execPath, "-e", script],
  label: "test-probe",
  ...over,
})

describe("probeModel", () => {
  it("sends the real extraction prompt — the command's stdin equals buildExtractPrompt(PROBE_TRANSCRIPT) (UF-P2R)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "mida-probe-")), "stdin.txt")
    const r = await probeModel(
      cmd(
        `let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{require("node:fs").writeFileSync(process.env.MIDA_PROBE_OUT,d);process.stdout.write('{"objective":"test"}')})`,
        { env: { MIDA_PROBE_OUT: out } },
      ),
    )
    expect(r.ok).toBe(true)
    expect(readFileSync(out, "utf8")).toBe(buildExtractPrompt(PROBE_TRANSCRIPT))
  })

  it("is ok when the answer holds a JSON object with a string objective", async () => {
    const r = await probeModel(cmd(`process.stdout.write('{"objective":"test","nextAction":"none"}')`))
    expect(r.ok).toBe(true)
    expect(typeof r.ms).toBe("number")
  })

  it("is ok when the JSON sits inside prose and a fence", async () => {
    const r = await probeModel(
      cmd(`process.stdout.write('Sure!\\n\`\`\`json\\n{"objective":"test"}\\n\`\`\`\\nDone.')`),
    )
    expect(r.ok).toBe(true)
  })

  it("a successful run without usable JSON is failed with the no-JSON detail", async () => {
    const r = await probeModel(cmd(`process.stdout.write('no json here')`))
    expect(r).toMatchObject({ ok: false, why: "failed", detail: "no JSON in the answer" })
  })

  it("an object without a string objective is failed too", async () => {
    const r = await probeModel(cmd(`process.stdout.write('{"objective":42}')`))
    expect(r).toMatchObject({ ok: false, why: "failed", detail: "no JSON in the answer" })
  })

  it("a usage-limit run is why: limit", async () => {
    const r = await probeModel(
      cmd(`process.stdout.write("You've hit your session limit"); process.exit(1)`, { agentCli: true }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.why).toBe("limit")
    expect(r.detail).toContain("(usage limit)")
  })

  it("a command that does not exist is why: missing", async () => {
    const r = await probeModel({ argv: ["mida-probe-no-such-binary-xyz"], label: "gone" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.why).toBe("missing")
    expect(r.detail.startsWith("spawn:")).toBe(true)
  })

  it("a command that never answers is why: timeout", async () => {
    const r = await probeModel(cmd(`setTimeout(() => {}, 60000)`, { timeoutMs: 60 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.why).toBe("timeout")
    expect(r.detail.startsWith("timeout")).toBe(true)
  })

  it("a plain non-zero exit is why: failed and keeps its detail", async () => {
    const r = await probeModel(cmd(`process.exit(3)`))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.why).toBe("failed")
    expect(r.detail).toContain("exit 3")
  })
})
