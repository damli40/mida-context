// Group F — scale. From docs/issue-register.md §3:
//   F1 buildHandoff read time at 1/10/50/100 stored checkpoints, 3 repeats,
//      medians; plus save time at 100. Open measurement — a 50-checkpoint
//      median over 8,000 ms is a RED check, and the run must stop there.
//   F2 approve time against chain age — needs the testnet: skipped
//   F3 worst-case input budgets: 2,500 progress entries render < 60 ms;
//      8 MB of `{` parses < 1 s; a 100 MB transcript reads in < 1 s with < 64 MB extra peak
//      memory and still finds a message typed in its middle (CAP-27)
// F1 goes through the real chain and the real buildHandoff; F3 exercises the
// real render, extractor, and transcript reader in-process.

import fs from "node:fs"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { mergeCheckpoints, renderHandoff } from "../../packages/checkpoint/src/index.js"
import type { StoredCheckpoint } from "../../packages/checkpoint/src/index.js"
import { extractJsonObject, readConversation } from "../../packages/compiler/src/index.js"
import {
  Runtime, approve, approveProject, authorNamesFor, buildHandoff, init, requestAccess,
  saveCheckpoint,
} from "../../apps/midad/src/index.js"
import { benchChain, benchDir, benchHome, sampleCheckpoint, userLine } from "../lib/env.js"
import { needsTestnet, runGroup, median } from "../lib/checks.js"

/** One assistant transcript line — the bulk of a long session is the agent's own output. */
const assistantLine = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } })

const chain = await benchChain()
const dir = benchDir("f")
const home = benchHome("f")
const runtime = await Runtime.open(home, chain.network)
await init(runtime, ["claude-code"])
await requestAccess(runtime, "claude-code")
await approve(runtime, "claude-code")

// F1 — red if the 50-checkpoint median crosses 8,000 ms. That red is a STOP
// signal for the whole task: the owner decides whether a cache is the answer;
// the benchmark reports and halts.
async function f1() {
  const cwd = join(dir, "work-f1")
  mkdirSync(cwd, { recursive: true })
  const { approval } = await approveProject(runtime, { agent: "claude-code", cwd })
  const milestones = [1, 10, 50, 100]
  const medians: Record<string, number> = {}
  const saveMs: number[] = []
  let saved = 0
  let save100 = 0
  for (const milestone of milestones) {
    while (saved < milestone) {
      saved += 1
      const sessionId = `f1-s${Math.floor((saved - 1) / 10)}`
      const result = await saveCheckpoint(runtime, "claude-code", {
        projectId: approval.projectId,
        sessionId,
        continuesSession: null,
        compiledBy: "bench",
        checkpoint: sampleCheckpoint({
          eventId: `ev-f1-${String(saved).padStart(4, "0")}`,
          createdAt: new Date(Date.parse("2026-09-21T10:00:00Z") + saved * 1000).toISOString(),
          objective: "scale read",
          progress: [`entry ${saved}`],
        }),
      })
      saveMs.push(result.milliseconds)
      if (saved === 100) save100 = result.milliseconds
    }
    const times: number[] = []
    for (let r = 0; r < 3; r += 1) {
      const t0 = performance.now()
      await buildHandoff(runtime, { agent: "claude-code", cwd, authorNames: authorNamesFor(runtime) })
      times.push(performance.now() - t0)
    }
    medians[String(milestone)] = Math.round(median(times) * 10) / 10
  }
  const median50 = medians["50"]!
  return {
    pass: median50 <= 8_000,
    value: median50,
    limit: 8_000,
    unit: "ms",
    detail: { medians, saveMsAt100: Math.round(save100 * 10) / 10, saveMsMedian: Math.round(median(saveMs) * 10) / 10 },
  }
}

// F3 — red if any worst-case input escapes its budget: the render must stay
// linear, the extractor must give up on unclosed JSON fast, and the transcript
// reader must stay fast and small on a 100 MB file. CAP-27: the old budget was
// bytes read (< 131 KB, a tail window), but PROV-09's fix streams the WHOLE file
// on purpose, so no message the user typed in the unread middle is ever lost.
// What matters is what that costs: time and peak memory (CAP-16's failure was
// 438 MB of memory, not bytes) — and that the middle message is really found.
async function f3() {
  // 2,500 progress entries through the real merge+render path
  const fat = sampleCheckpoint({
    eventId: "ev-f3-01",
    createdAt: "2026-09-21T10:00:00.000Z",
    progress: Array.from({ length: 2_500 }, (_, i) => `progress entry ${i} ${"x".repeat(40)}`),
  })
  const stored: StoredCheckpoint = {
    checkpoint: fat, projectId: "p-f3", sessionId: "f3", continuesSession: null,
    compiledBy: "bench", contextId: `0x${"ab".repeat(32)}`, authorId: `0x${"cd".repeat(20)}`,
  }
  const merged = mergeCheckpoints([stored])!
  const t0 = performance.now()
  const rendered = renderHandoff(merged)
  const renderMs = performance.now() - t0

  // 8 MB of unclosed braces — the extractor must fail fast, not quadratically
  const braces = "{".repeat(8 * 1024 * 1024)
  const t1 = performance.now()
  const parsed = extractJsonObject(braces)
  const parseMs = performance.now() - t1

  // a 100 MB transcript: the request, ~50 MB of tool output, a message the user typed, ~49 MB more
  const big = join(dir, "f3-big.jsonl")
  writeFileSync(big, JSON.stringify(userLine("tail marker zzz")) + "\n")
  const fd = fs.openSync(big, "a")
  const toolOutput = Buffer.from(`${JSON.stringify(assistantLine("f".repeat(1024 * 1024 - 64)))}\n`)
  for (let i = 0; i < 50; i += 1) fs.writeSync(fd, toolOutput)
  fs.writeSync(fd, Buffer.from(JSON.stringify(userLine("middle typed marker: change the plan")) + "\n"))
  for (let i = 0; i < 49; i += 1) fs.writeSync(fd, toolOutput)
  fs.writeSync(fd, Buffer.from(JSON.stringify(userLine("final tail marker")) + "\n"))
  fs.closeSync(fd)
  // peak memory (maxRSS is a high-water mark, in KB): what the read adds above everything before it.
  // A whole-file read (CAP-16: ~4x the file in memory) raises it far past 64 MB and turns this red;
  // growth that stays under an earlier step's peak is not seen — this guards the big regression only.
  const peakBeforeKb = process.resourceUsage().maxRSS
  const t2 = performance.now()
  const read = readConversation(big)
  const readMs = performance.now() - t2
  const extraPeakMb = (process.resourceUsage().maxRSS - peakBeforeKb) / 1024
  const foundMiddle = read.text.includes("middle typed marker: change the plan")
  return {
    pass: renderMs < 60 && parseMs < 1_000 && parsed === undefined && readMs < 1_000 && extraPeakMb < 64 && foundMiddle,
    value: {
      renderMs: Math.round(renderMs * 100) / 100,
      parseMs: Math.round(parseMs * 100) / 100,
      transcriptReadMs: Math.round(readMs),
      transcriptExtraPeakMb: Math.round(extraPeakMb * 10) / 10,
      foundMiddleTypedMessage: foundMiddle,
    },
    limit: { renderMs: 60, parseMs: 1_000, transcriptReadMs: 1_000, transcriptExtraPeakMb: 64, foundMiddleTypedMessage: true },
  }
}

try {
  await runGroup([
    { id: "F1", run: f1 },
    needsTestnet("F2"),
    { id: "F3", run: f3 },
  ])
} finally {
  await runtime.close()
  await chain.env.stop()
}
