// Group F — scale. From docs/issue-register.md §3:
//   F1 buildHandoff read time at 1/10/50/100 stored checkpoints, 3 repeats,
//      medians; plus save time at 100. Open measurement — a 50-checkpoint
//      median over 8,000 ms is a RED check, and the run must stop there.
//   F2 approve time against chain age — needs the testnet: skipped
//   F3 worst-case input budgets: 2,500 progress entries render < 60 ms;
//      8 MB of `{` parses < 1 s; a 100 MB transcript tail read < 131 KB
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
  const approval = await approveProject(runtime, { agent: "claude-code", cwd })
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
// reader must bound the bytes it touches.
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

  // a 100 MB transcript — count every byte the reader touches
  const big = join(dir, "f3-big.jsonl")
  const line = JSON.stringify(userLine("tail marker zzz")) + "\n"
  writeFileSync(big, line)
  const fd = fs.openSync(big, "a")
  const filler = Buffer.alloc(1024 * 1024, "f")
  for (let i = 0; i < 99; i += 1) fs.writeSync(fd, filler)
  fs.writeSync(fd, Buffer.from(JSON.stringify(userLine("final tail marker")) + "\n"))
  fs.closeSync(fd)
  let bytesRead = 0
  let insideReadFile = false
  const origReadFileSync = fs.readFileSync
  const origReadSync = fs.readSync
  // @ts-expect-error deliberate measurement shim around the real reader
  fs.readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
    insideReadFile = true
    try {
      const out = origReadFileSync(...args)
      bytesRead += out.length
      return out
    } finally {
      insideReadFile = false
    }
  }
  // @ts-expect-error deliberate measurement shim around the real reader
  fs.readSync = (...args: Parameters<typeof fs.readSync>) => {
    const n = origReadSync(...args)
    if (!insideReadFile) bytesRead += n
    return n
  }
  try {
    readConversation(big)
  } finally {
    fs.readFileSync = origReadFileSync
    fs.readSync = origReadSync
  }
  const TAIL_LIMIT = 131_072
  return {
    pass: renderMs < 60 && parseMs < 1_000 && parsed === undefined && bytesRead <= TAIL_LIMIT,
    value: { renderMs: Math.round(renderMs * 100) / 100, parseMs: Math.round(parseMs * 100) / 100, transcriptBytesRead: bytesRead },
    limit: { renderMs: 60, parseMs: 1_000, transcriptBytes: TAIL_LIMIT },
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
