// Fake extractor model for compile.test.ts. Reads all of stdin, appends it
// to the file named by FAKE_MODEL_STDIN_LOG when set, writes the NAMES of its
// environment variables (never values) to FAKE_MODEL_ENV_LOG when set, then
// behaves per FAKE_MODEL_MODE:
//   good     — a valid checkpoint object wrapped in a sentence + ```json fence
//   extra    — the same plus unknown keys: notes, confidence, originalRequest
//   garbage  — prints "not json"
//   badshape — prints {"objective":5} (parses, fails validation)
//   fail     — exits 3
//   hang     — sleeps 60 s (the timeout must kill it)
//   flaky    — fails unless the counter file named by FAKE_MODEL_COUNTER
//              already holds 2; increments the counter each run
//   grandchild — spawns a 60 s child with INHERITED stdout, writes its pid
//              to FAKE_MODEL_PID_LOG, then hangs: the timeout must kill the
//              whole process group or the held-open pipe stalls "close"
//   leaky    — good, but progress[0] carries a secret the compiler must scrub
//   reasoning — prints only {"thinking":"x"} (no content fields → no-json)
//   longitem — good, but progress[0] is 2,001 chars (over the schema limit)
//   wide     — good, but decisions has 51 entries (over the schema limit)
//   echo-previous — parses the JSON on the line after "PREVIOUS CHECKPOINT" in
//              its stdin and echoes it back with one extra progress item: the
//              block must reach the model intact and parseable
//   stderr-fail — writes "kimi http 429" to stderr, exits 1 (stderrDetail tests)
//   cache-stats — GOOD on stdout plus "cache hit=11 miss=22" on stderr, exit 0:
//              the provider's usage line a compile with stderrDetail reads
//   cache-stats-bad — GOOD on stdout plus a malformed "cache hit=…" line on
//              stderr: the parse must ignore it and still succeed
//   shape-flaky — badshape on its FIRST run, good after (counts runs in
//              FAKE_MODEL_COUNTER): the same-provider shape retry's target
//   nojson-flaky — "not json" on its FIRST run, good after (same counter)
//   badshape-count — badshape on every run, counting them: proves the retry
//              fired once on the primary and never on a fallback
//
// The mode comes from argv[2] when present, else FAKE_MODEL_MODE — argv lets a
// primary and a fallback command differ inside one compile even though both
// children share the same environment.

import fs from "node:fs"
import { spawn } from "node:child_process"

const GOOD = {
  objective: "Implement the rate limiter",
  progress: ["skeleton written"],
  decisions: [{ decision: "lazy refill on each call", rationale: "timers are banned" }],
  rejected: [{ approach: "background interval refill", why: "no-timers constraint" }],
  constraints: ["no dependencies"],
  artifacts: ["/Users/x/proj/src/a.ts", "/Users/x/notes.md"],
  unresolvedIssue: null,
  nextAction: "add tests",
  remainingPlan: ["2. add tests", "3. write README"],
  evidence: [{ field: "artifacts[0]", ref: "file:/Users/x/proj/src/a.ts" }],
}

const chunks = []
process.stdin.on("data", (c) => chunks.push(c))
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString("utf8")
  if (process.env.FAKE_MODEL_STDIN_LOG) {
    fs.appendFileSync(process.env.FAKE_MODEL_STDIN_LOG, input)
  }
  if (process.env.FAKE_MODEL_ENV_LOG) {
    fs.writeFileSync(process.env.FAKE_MODEL_ENV_LOG, Object.keys(process.env).join("\n"))
  }

  const fenced = (obj) =>
    process.stdout.write(
      "Here is the extracted checkpoint.\n```json\n" + JSON.stringify(obj) + "\n```\nDone.\n",
    )

  // counted() bumps the file named by FAKE_MODEL_COUNTER and returns the run's
  // 0-based index — how a test proves which provider ran and how many times
  const counted = () => {
    const counterFile = process.env.FAKE_MODEL_COUNTER
    let n = 0
    if (counterFile) {
      try {
        n = Number.parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0
      } catch {
        n = 0
      }
      fs.writeFileSync(counterFile, String(n + 1))
    }
    return n
  }

  switch (process.argv[2] ?? process.env.FAKE_MODEL_MODE) {
    case "good":
      fenced(GOOD)
      break
    case "extra":
      fenced({ ...GOOD, notes: "x", confidence: 0.9, originalRequest: "model wrote this" })
      break
    case "garbage":
      process.stdout.write("not json")
      break
    case "badshape":
      process.stdout.write('{"objective":5}')
      break
    case "fail":
      process.exit(3)
      break
    case "hang":
      setTimeout(() => process.exit(0), 60_000)
      break
    case "flaky": {
      if (counted() === 2) fenced(GOOD)
      else process.exit(3)
      break
    }
    case "shape-flaky": {
      if (counted() === 0) process.stdout.write('{"objective":5}')
      else fenced(GOOD)
      break
    }
    case "nojson-flaky": {
      if (counted() === 0) process.stdout.write("not json")
      else fenced(GOOD)
      break
    }
    case "badshape-count": {
      counted()
      process.stdout.write('{"objective":5}')
      break
    }
    case "grandchild": {
      const g = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        stdio: ["ignore", "inherit", "ignore"],
      })
      if (process.env.FAKE_MODEL_PID_LOG) {
        fs.writeFileSync(process.env.FAKE_MODEL_PID_LOG, String(g.pid))
      }
      setTimeout(() => process.exit(0), 60_000)
      break
    }
    case "leaky":
      fenced({ ...GOOD, progress: ["set API_KEY=sk-live-abcdefgh12345678 in env"] })
      break
    case "reasoning":
      process.stdout.write('{"thinking":"x"}')
      break
    case "longitem":
      fenced({ ...GOOD, progress: ["x".repeat(2001)] })
      break
    case "wide":
      fenced({
        ...GOOD,
        decisions: Array.from({ length: 51 }, (_, i) => ({ decision: `d${i}`, rationale: "r" })),
      })
      break
    case "stderr-fail":
      process.stderr.write("kimi http 429\n")
      process.exit(1)
      break
    case "cache-stats":
      process.stderr.write("cache hit=11 miss=22\n")
      fenced(GOOD)
      break
    case "cache-stats-bad":
      process.stderr.write("cache hit=soon miss=later\n")
      fenced(GOOD)
      break
    case "echo-previous": {
      const lines = input.split("\n")
      const i = lines.findIndex((l) => l.startsWith("PREVIOUS CHECKPOINT"))
      if (i === -1) process.exit(4)
      const prev = JSON.parse(lines[i + 1])
      prev.progress = [...prev.progress, "echo-previous saw the block"]
      fenced(prev)
      break
    }
    default:
      process.exit(2)
  }
})
