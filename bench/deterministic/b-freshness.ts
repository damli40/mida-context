// Group B — freshness. From docs/issue-register.md §3:
//   B1 seconds from last hook event until another agent can read it, p50/max,
//      including the drain killed mid-gap
//   B2 compiler time p50/p95 by model and call path — needs a real model: skipped
//   B3 StopFailure saves immediately
// B1/B3 run the real chain and the real save path; only the model is stubbed.

import { join } from "node:path"
import type { CompileInput } from "../../packages/compiler/src/index.js"
import {
  Runtime, approve, drainOnce, drainUntilSettled, enqueue, init, readCheckpoints, requestAccess,
} from "../../apps/midad/src/index.js"
import {
  appendTranscript, assistantText, benchChain, benchDir, benchHome, mark, stubCompile,
  userLine, writeTranscript,
} from "../lib/env.js"
import { needsRealModel, runGroup } from "../lib/checks.js"

const chain = await benchChain()
const dir = benchDir("b")
const home = benchHome("b")
const homeDir = join(dir, "user-home")
const cwd = join(dir, "work")
const PROJECT = "p-bench-b"
mark(cwd, PROJECT)
const runtime = await Runtime.open(home, chain.network)
await init(runtime, ["claude-code"])
await requestAccess(runtime, "claude-code")
await approve(runtime, "claude-code", cwd)
const compileCalls: CompileInput[] = []
const compile = stubCompile(compileCalls)

// B1 — red if a finished save stops being readable by the next agent, or if the
// mid-gap drain stops waiting out the save gap inside its lock (the job would
// linger for the NEXT hook instead of going out when due).
async function b1() {
  const t1 = writeTranscript(homeDir, "proj", "b1-flush.jsonl", [userLine("flush request")])
  const flushAt = Date.now()
  enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "b1-flush", transcriptPath: t1, cwd, error: null })
  await drainUntilSettled({ home, runtime, compile, homeDir })
  const read1 = await readCheckpoints(runtime, "claude-code", PROJECT)
  const flushSeconds = (Date.now() - flushAt) / 1000
  const flushReadable = read1.checkpoints.length === 1

  // Mid-gap: a PostToolUse arrives, the drain holds it for the 2 s gap and — with the
  // lock held — sleeps until it is due rather than dropping it for a later hook.
  const t2 = writeTranscript(homeDir, "proj", "b1-gap.jsonl", [userLine("gap request")])
  appendTranscript(t2, assistantText("one more step"))
  const gapAt = Date.now()
  enqueue(home, { agent: "claude-code", event: "PostToolUse", sessionId: "b1-gap", transcriptPath: t2, cwd, error: null })
  await drainUntilSettled({ home, runtime, compile, homeDir, minGapMs: 2_000 })
  const read2 = await readCheckpoints(runtime, "claude-code", PROJECT)
  const gapSeconds = (Date.now() - gapAt) / 1000
  const gapReadable = read2.checkpoints.length === 2
  return {
    pass: flushReadable && gapReadable,
    value: Math.max(flushSeconds, gapSeconds),
    limit: null,
    unit: "s",
    detail: { flushSeconds: Math.round(flushSeconds * 100) / 100, gapSeconds: Math.round(gapSeconds * 100) / 100, midGapWaitMs: 2000 },
  }
}

// B3 — red if a StopFailure event stops flushing: it must bypass the save gap
// like Stop, because the session is about to die with unsaved state.
async function b3() {
  const t = writeTranscript(homeDir, "proj", "b3.jsonl", [userLine("failing session")])
  const at = Date.now()
  enqueue(home, { agent: "claude-code", event: "StopFailure", sessionId: "b3", transcriptPath: t, cwd, error: "overloaded" })
  const result = await drainOnce({ home, runtime, compile, homeDir })
  const read = await readCheckpoints(runtime, "claude-code", PROJECT)
  return {
    pass: result.saved === 1 && read.checkpoints.length === 3,
    value: { saved: result.saved, seconds: Math.round(((Date.now() - at) / 1000) * 100) / 100 },
    limit: null,
  }
}

try {
  await runGroup([
    { id: "B1", run: b1 },
    needsRealModel("B2"),
    { id: "B3", run: b3 },
  ])
} finally {
  await runtime.close()
  await chain.env.stop()
}
