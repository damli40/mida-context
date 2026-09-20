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

import fs from "node:fs"

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

  switch (process.env.FAKE_MODEL_MODE) {
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
      if (n === 2) fenced(GOOD)
      else process.exit(3)
      break
    }
    default:
      process.exit(2)
  }
})
