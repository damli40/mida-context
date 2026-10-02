// Fake agent CLI for agent-cli-run.test.ts. Reads all of stdin, appends one
// line to the file named by FAKE_CLI_COUNTER when set (how a test counts runs),
// then behaves per argv[2] or FAKE_CLI_MODE:
//   report       — a valid checkpoint whose progress/artifacts carry the
//                  process cwd, the folder's listing and two env probes
//   good         — a valid checkpoint object
//   limit        — prints a usage-limit line on stdout, exits 1
//   fail         — prints "some other failure" on stdout, exits 1
//   limit-stderr — the usage-limit line on stderr, empty stdout, exits 1

import fs from "node:fs"

const GOOD = {
  objective: "Implement the rate limiter",
  progress: ["skeleton written"],
  decisions: [{ decision: "lazy refill on each call", rationale: "timers are banned" }],
  rejected: [],
  constraints: [],
  artifacts: [],
  unresolvedIssue: null,
  nextAction: "add tests",
  remainingPlan: [],
  evidence: [],
}

const LIMIT_TEXT = "You've hit your session limit · resets 3:45pm"

const chunks = []
process.stdin.on("data", (c) => chunks.push(c))
process.stdin.on("end", () => {
  const counter = process.env.FAKE_CLI_COUNTER
  if (counter) fs.appendFileSync(counter, "x")

  const fenced = (obj) =>
    process.stdout.write("Here is the extracted checkpoint.\n```json\n" + JSON.stringify(obj) + "\n```\nDone.\n")

  switch (process.argv[2] ?? process.env.FAKE_CLI_MODE) {
    case "report":
      fenced({
        ...GOOD,
        progress: [
          `cwd:${process.cwd()}`,
          `files:${fs.readdirSync(process.cwd()).join(",")}`,
          `extra:${process.env.MIDA_TEST_EXTRA ?? "absent"}`,
          `anthropic:${"ANTHROPIC_API_KEY" in process.env ? process.env.ANTHROPIC_API_KEY : "absent"}`,
        ],
        artifacts: [process.cwd()],
      })
      break
    case "good":
      fenced(GOOD)
      break
    case "limit":
      process.stdout.write(LIMIT_TEXT + "\n")
      process.exit(1)
      break
    case "fail":
      process.stdout.write("some other failure\n")
      process.exit(1)
      break
    case "limit-stderr":
      process.stderr.write(LIMIT_TEXT + "\n")
      process.exit(1)
      break
    default:
      process.exit(2)
  }
})
