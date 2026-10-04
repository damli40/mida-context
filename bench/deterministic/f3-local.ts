// Local-only runner for the F3 check body. f-scale.ts brings up a full Anvil +
// forge chain in benchChain() at module top before any check runs, which cannot
// work in a worktree without the contracts/lib submodules. F3 itself is a
// pure-reader check — it never touches the chain — so this file runs its body
// exactly: same inputs, same reads, same budgets, same measured values.
// Checked in with the rest of the bench; run with
// `node --import tsx bench/deterministic/f3-local.ts`.

import fs from "node:fs"
import { writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import { mergeCheckpoints, renderHandoff } from "../../packages/checkpoint/src/index.js"
import type { StoredCheckpoint } from "../../packages/checkpoint/src/index.js"
import { extractJsonObject, readConversation } from "../../packages/compiler/src/index.js"
import { benchDir, cleanupBenchDir, sampleCheckpoint, userLine } from "../lib/env.js"

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

const dir = benchDir("f")

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

// F3 — the f-scale.ts body verbatim: 2,500 progress entries render < 60 ms,
// 8 MB of unclosed braces parse < 1 s, a 100 MB transcript reads < 1 s with
// < 64 MB extra peak memory and still finds the messages typed in its middle.
async function f3() {
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

  const braces = "{".repeat(8 * 1024 * 1024)
  const t1 = performance.now()
  const parsed = extractJsonObject(braces)
  const parseMs = performance.now() - t1

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

// F3R — UF-C41B B2. The f-scale.ts F3R body verbatim: a REALISTIC 100 MB
// session (the reviewer's scan100.ts shape) — ~20 KB Writes, ~2 KB replies,
// Bash commands and 3 KB tool results, real Claude key order with "type" at
// each line's far end. Same limits as F3's transcript read.
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
  const outcome = await f3()
  console.log(JSON.stringify({ id: "F3", ...outcome }))
  const realistic = await f3r()
  console.log(JSON.stringify({ id: "F3R", ...realistic }))
} finally {
  // UF-C41C E6: the transcript fixtures are ~300 MB of scratch; a run removes
  // them unless KEEP_BENCH_DIR=1 asks for them to stay.
  cleanupBenchDir(dir)
}
