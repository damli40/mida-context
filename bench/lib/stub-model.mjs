// The deterministic stand-in for the model command compileCheckpoint spawns.
// It is never a real model: it reads stdin, optionally captures what it was
// sent (D1 reads that file to prove the transcript reached the model scrubbed),
// then prints one JSON checkpoint for the mode named on the command line.
//
//   node stub-model.mjs <mode> [captureFile]
//
// modes:
//   ok           a valid checkpoint
//   invalid      JSON that fails the checkpoint schema (missing/wrong fields)
//   fat          a valid checkpoint whose protected fields exceed the payload cap
//   echo-secrets a valid checkpoint that embeds fake secrets the model "echoed"
//   reasoning    extra prose around the JSON, exercising the extractor
//   hang         spawns a grandchild that holds stdout, writes both pids to the
//                capture file as JSON, then never exits (H4 must kill the group)
//
// All fake secrets are built by concatenation — no secret-shaped literal is committed.

const [mode, captureFile] = process.argv.slice(2)

if (mode === "hang") {
  // A grandchild sharing this process group and holding the stdout pipe: if the
  // caller only kills the parent, the pipe stays open and its wait never ends.
  const { spawn } = await import("node:child_process")
  const { writeFileSync } = await import("node:fs")
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "inherit" })
  writeFileSync(captureFile, JSON.stringify({ pid: process.pid, child: child.pid }))
  setInterval(() => {}, 1e9)
} else {
  let input = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) input += chunk
  if (captureFile !== undefined) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(captureFile, input)
  }
}

const fakeSecrets = () => [
  "sk-" + "ant-" + "x".repeat(40),
  "gh" + "p_" + "a".repeat(24),
  "0x" + "f".repeat(64),
  "AKIA" + "ABCD".repeat(4),
  "xox" + "b" + "-" + "1234".repeat(4),
  "e".repeat(64),
  "-----BEGIN " + "PRIVATE KEY-----\nQUJD\n-----END " + "PRIVATE KEY-----",
  "API_" + "KEY=z".repeat(16),
]

const base = {
  eventId: "cp-stub-model",
  agent: "claude-code",
  source: "hook-compiler",
  createdAt: "2026-09-21T10:00:00.000Z",
  objective: "stub objective",
  originalRequest: null,
  progress: ["stub progress"],
  decisions: [],
  rejected: [],
  constraints: [],
  artifacts: [],
  unresolvedIssue: null,
  nextAction: "stub next",
  remainingPlan: ["stub step"],
  evidence: [],
}

const print = (checkpoint) => {
  process.stdout.write(JSON.stringify({ checkpoint }) + "\n")
}

switch (mode) {
  case "ok":
    print(base)
    break
  case "invalid":
    // right shape on the outside, wrong inside: progress is not a list, no objective
    print({ ...base, objective: 7, progress: "not-a-list" })
    break
  case "fat":
    // protected fields alone exceed the payload cap — wrap must refuse it
    print({ ...base, remainingPlan: Array.from({ length: 50 }, (_, i) => `step ${i} ${"s".repeat(2000)}`) })
    break
  case "echo-secrets":
    print({ ...base, progress: fakeSecrets(), constraints: [fakeSecrets()[0]] })
    break
  case "reasoning":
    process.stdout.write(`I looked at the transcript and here is the checkpoint:\n${JSON.stringify({ checkpoint: base })}\nDone.\n`)
    break
  case "hang":
    setInterval(() => {}, 1e9)
    break
  default:
    process.stderr.write(`stub-model: unknown mode ${mode}\n`)
    process.exit(2)
}
