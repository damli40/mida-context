// Fake agent CLI for agent-cli-run.test.ts (UF-P1R): Codex prints the prompt
// back on stderr before its answer — this fixture does the same so the limit
// check must prove it reads the tool's OWN lines, never the echoed prompt.
// Reads stdin fully, echoes it verbatim on stderr, counts runs in
// FAKE_CLI_COUNTER, then behaves per argv[2]:
//   fail         — "some other failure" on stdout, exit 1
//   limit        — a usage-limit line on stderr after the echo, exit 1
//   echo-limit   — a 6,000-character echo tail, then the limit line, exit 1
//   a+b+...      — run n uses spec[n-1] (the last spec repeats):
//                  lets a chain test give attempt 1 "plain failure" and
//                  attempt 2 "limit" on the SAME command
//   limit-first  — the limit line first, then 6,000 characters of tail:
//                  the kept tail never reaches it — honestly missed
//   hang         — never exits (the timeout path)
//   env          — prints which ANTHROPIC_* names the child could see, exit 0

import fs from "node:fs"

const LIMIT_TEXT = "You've hit your session limit · resets 3:45pm"

const spec = (process.argv[2] ?? "fail").split("+")

const chunks = []
process.stdin.on("data", (c) => chunks.push(c))
process.stdin.on("end", () => {
  const counter = process.env.FAKE_CLI_COUNTER
  const n = counter && fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0
  if (counter) fs.appendFileSync(counter, "x")
  const mode = spec[Math.min(n, spec.length - 1)]

  // the prompt back on stderr, like Codex does
  process.stderr.write(chunks.join(""))

  switch (mode) {
    case "fail":
      process.stdout.write("some other failure\n")
      process.exit(1)
      break
    case "limit":
      process.stderr.write(LIMIT_TEXT + "\n")
      process.exit(1)
      break
    case "echo-limit":
      process.stderr.write("x".repeat(6000) + "\n")
      process.stderr.write(LIMIT_TEXT + "\n")
      process.exit(1)
      break
    case "limit-first":
      process.stderr.write(LIMIT_TEXT + "\n")
      process.stderr.write("x".repeat(6000) + "\n")
      process.exit(1)
      break
    case "hang":
      setInterval(() => {}, 60_000)
      break
    case "env":
      process.stdout.write(
        "```json\n" +
          JSON.stringify({
            objective: "env probe",
            progress: [
              "anthropic:" +
                (Object.keys(process.env)
                  .filter((k) => k.startsWith("ANTHROPIC_"))
                  .join(",") || "absent"),
            ],
            decisions: [],
            rejected: [],
            constraints: [],
            artifacts: [],
            unresolvedIssue: null,
            nextAction: "none",
            remainingPlan: [],
            evidence: [],
          }) +
          "\n```\n",
      )
      process.exit(0)
      break
    default:
      process.exit(2)
  }
})
