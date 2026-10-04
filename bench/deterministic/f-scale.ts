// Group F — scale. From docs/issue-register.md §3:
//   F1 buildHandoff read time at 1/10/50/100 stored checkpoints, 3 repeats,
//      medians; plus save time at 100. Open measurement — a 50-checkpoint
//      median over 8,000 ms is a RED check, and the run must stop there.
//   F2 approve time against chain age — needs the testnet: skipped
//   F3 worst-case input budgets: 2,500 progress entries render < 60 ms;
//      8 MB of `{` parses < 1 s; a 100 MB transcript reads in < 1 s with < 64 MB extra peak
//      memory and still finds a message typed in its middle (CAP-27)
// F1 goes through the real chain and the real buildHandoff; F3 exercises the
// real render, extractor, and transcript reader, with each transcript read
// timed and memory-measured in a fresh child process (UF-C41C E6).

import fs from "node:fs"
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import { mergeCheckpoints, renderHandoff } from "../../packages/checkpoint/src/index.js"
import type { StoredCheckpoint } from "../../packages/checkpoint/src/index.js"
import { extractJsonObject, readConversation } from "../../packages/compiler/src/index.js"
import {
  Runtime, approve, approveProject, authorNamesFor, buildHandoff, init, requestAccess,
  saveCheckpoint,
} from "../../apps/midad/src/index.js"
import { benchChain, benchDir, benchHome, cleanupBenchDir, sampleCheckpoint, userLine } from "../lib/env.js"
import { needsTestnet, runGroup, median } from "../lib/checks.js"

// UF-C41C E6 child mode. The parent re-runs this file once per transcript read
// so each read's peak memory is measured against a fresh process's own
// high-water mark. maxRSS never falls, so a baseline taken after writing the
// file in the same process counts the write's peak too and reports ~0 MB.
// argv: --measure <file> <marker...>; stdout is one JSON line.
if (process.argv[2] === "--measure") {
  const file = process.argv[3]!
  const markers = process.argv.slice(4)
  const baseKb = process.resourceUsage().maxRSS
  const t = performance.now()
  const read = readConversation(file)
  const readMs = performance.now() - t
  const extraPeakMb = (process.resourceUsage().maxRSS - baseKb) / 1024
  process.stdout.write(JSON.stringify({ readMs, extraPeakMb, found: markers.every((m) => read.text.includes(m)) }))
  process.exit(0)
}

/** One assistant transcript line — the bulk of a long session is the agent's own output. */
const assistantLine = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } })

/** Times one transcript read in a fresh child; `found` is true when every marker is in its text. */
function measureRead(file: string, markers: string[]): { readMs: number; extraPeakMb: number; found: boolean } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--measure", file, ...markers],
    { encoding: "utf8" },
  )
  if (r.status !== 0) throw new Error(`measure child failed for ${file}: ${r.stderr}`)
  return JSON.parse(r.stdout) as { readMs: number; extraPeakMb: number; found: boolean }
}

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

  // a 100 MB transcript of tool output with three messages the user typed in the UNREAD middle:
  // ~1 MB past the 64 KiB head window, at ~50 MB, and ~1 MB before the 60 KB tail window — so a
  // scan that stops early, or reads only part of the middle, misses one and turns F3 red (review)
  const big = join(dir, "f3-big.jsonl")
  writeFileSync(big, JSON.stringify(userLine("tail marker zzz")) + "\n")
  const fd = fs.openSync(big, "a")
  const toolOutput = Buffer.from(`${JSON.stringify(assistantLine("f".repeat(1024 * 1024 - 64)))}\n`)
  const typed = (text: string) => fs.writeSync(fd, Buffer.from(JSON.stringify(userLine(text)) + "\n"))
  fs.writeSync(fd, toolOutput)
  typed("early typed marker: rename the module")
  for (let i = 0; i < 49; i += 1) fs.writeSync(fd, toolOutput)
  typed("middle typed marker: change the plan")
  for (let i = 0; i < 48; i += 1) fs.writeSync(fd, toolOutput)
  typed("late typed marker: ship on friday")
  fs.writeSync(fd, toolOutput)
  fs.writeSync(fd, Buffer.from(JSON.stringify(userLine("final tail marker")) + "\n"))
  fs.closeSync(fd)
  // peak memory (maxRSS is a high-water mark, in KB): what the read adds above everything before it.
  // A whole-file read (CAP-16: ~4x the file in memory) raises it far past 64 MB and turns this red;
  // growth that stays under an earlier step's peak is not seen — this guards the big regression only.
  // The read runs in a fresh child so its peak memory is its own (E6).
  const measured = measureRead(big, [
    "early typed marker: rename the module",
    "middle typed marker: change the plan",
    "late typed marker: ship on friday",
  ])
  const readMs = measured.readMs
  const extraPeakMb = measured.extraPeakMb
  const foundMiddle = measured.found
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

// F3R — UF-C41B B2. The same transcript read, but over a REALISTIC 100 MB
// session (the reviewer's scan100.ts shape): ~20 KB Writes, ~2 KB replies,
// Bash commands and 3 KB tool results, real Claude key order — "type" sits at
// each line's far end. The old scan parsed every middle assistant line up to
// 256 KB, which took this read to about 1,100 ms; the fix marks candidates and
// re-reads only enough to fill the trail. Same limits as F3's transcript read.
async function f3r() {
  const asstReal = (parts: unknown[]) =>
    JSON.stringify({
      parentUuid: "p",
      isSidechain: false,
      userType: "external",
      cwd: "/w",
      sessionId: "s",
      version: "2.1.0",
      gitBranch: "main",
      message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: parts, stop_reason: null, usage: { input_tokens: 1 } },
      requestId: "req_1",
      type: "assistant",
      uuid: "u",
      timestamp: "2026-10-01T00:00:00Z",
    })
  const toolResult = () =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r".repeat(3_000) }] } })
  const real = join(dir, "f3-real.jsonl")
  writeFileSync(real, JSON.stringify(userLine("REQ")) + "\n")
  const fd = fs.openSync(real, "a")
  let size = 0
  let n = 0
  let chunk: string[] = []
  while (size < 100_000_000) {
    const k = n % 4
    const line =
      k === 0
        ? asstReal([{ type: "tool_use", name: "Write", input: { file_path: `/w/f${n}.ts`, content: "w".repeat(20_000) } }])
        : k === 1
          ? asstReal([{ type: "text", text: "step " + n + " " + "t".repeat(2_000) }])
          : k === 2
            ? asstReal([{ type: "tool_use", name: "Bash", input: { command: "pnpm test " + n } }])
            : toolResult()
    chunk.push(line)
    size += line.length + 1
    n++
    if (chunk.length >= 500) {
      fs.writeSync(fd, chunk.join("\n") + "\n")
      chunk = []
    }
  }
  if (chunk.length) fs.writeSync(fd, chunk.join("\n") + "\n")
  fs.closeSync(fd)
  const realRead = measureRead(real, ["what it did in between"])
  const readMs = realRead.readMs
  const extraPeakMb = realRead.extraPeakMb
  const trailShown = realRead.found

  // UF-C41C E2: a middle of nothing but small assistant records, 100 MB of
  // ~370-byte lines in real key order, every one a step candidate. Trimming
  // the kept list on each mark made this read take ~2.5 s; batched trims keep
  // it under the same 1 s limit.
  const small = join(dir, "f3-small.jsonl")
  writeFileSync(small, JSON.stringify(userLine("REQ")) + "\n")
  const fd2 = fs.openSync(small, "a")
  let size2 = 0
  let m = 0
  let chunk2: string[] = []
  while (size2 < 100_000_000) {
    const line = asstReal([{ type: "text", text: `step ${m}` }])
    chunk2.push(line)
    size2 += line.length + 1
    m++
    if (chunk2.length >= 2_000) {
      fs.writeSync(fd2, chunk2.join("\n") + "\n")
      chunk2 = []
    }
  }
  if (chunk2.length) fs.writeSync(fd2, chunk2.join("\n") + "\n")
  fs.closeSync(fd2)
  const smallRead = measureRead(small, ["what it did in between"])
  const smallReadMs = smallRead.readMs
  const smallExtraPeakMb = smallRead.extraPeakMb
  const smallTrailShown = smallRead.found
  return {
    pass: readMs < 1_000 && extraPeakMb < 64 && trailShown && smallReadMs < 1_000 && smallExtraPeakMb < 64 && smallTrailShown,
    value: {
      transcriptReadMs: Math.round(readMs),
      transcriptExtraPeakMb: Math.round(extraPeakMb * 10) / 10,
      trailShown,
      smallRecordsLines: m,
      smallRecordsReadMs: Math.round(smallReadMs),
      smallRecordsExtraPeakMb: Math.round(smallExtraPeakMb * 10) / 10,
      smallRecordsTrailShown: smallTrailShown,
    },
    limit: { transcriptReadMs: 1_000, transcriptExtraPeakMb: 64, trailShown: true, smallRecordsReadMs: 1_000, smallRecordsExtraPeakMb: 64, smallRecordsTrailShown: true },
  }
}

try {
  await runGroup([
    { id: "F1", run: f1 },
    needsTestnet("F2"),
    { id: "F3", run: f3 },
    { id: "F3R", run: f3r },
  ])
} finally {
  await runtime.close()
  await chain.env.stop()
  // UF-C41C E6: the transcript fixtures are ~300 MB of scratch; a run removes
  // them (and the small temp Mida home) unless KEEP_BENCH_DIR=1 asks for them
  // to stay.
  cleanupBenchDir(dir)
  cleanupBenchDir(home.root)
}
