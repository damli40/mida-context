// examples/sdk-basic.ts — the seven SDK calls, one after another, against a real Mida home.
//
// Run it from inside a Mida project folder (a folder `mida init`/`mida link` marked) with
// MIDA_HOME pointing at the home and MIDA_AGENT naming a provisioned agent:
//
//   MIDA_HOME=~/.mida MIDA_AGENT=codex node --import tsx examples/sdk-basic.ts
//
// The script asks the service what this agent may do, writes one memory, reads it back,
// verifies its chain proof, and prints the handoff and what's-new answers — the same text
// the agent adapters inject. Every refusal surfaces as a typed MidaSdkError, never an
// empty or stale answer.

import { Mida, isMidaSdkError } from "@mida-context/sdk"

const agent = process.env.MIDA_AGENT ?? "codex"
// project defaults to the folder you run this from; home to $MIDA_HOME, else ~/.mida
const mida = new Mida({ agent })

try {
  // status() always answers — up:false when the Mida service is not running.
  const status = await mida.status()
  console.log(status.text)
  if (!status.up) process.exit(1)

  // An agent can never approve itself: when the verdict is not "approved" the script files
  // the request the owner's `mida approve <agent>` completes, and stops.
  if (status.agent?.verdict !== "approved") {
    const request = await mida.requestAccess()
    console.log(`access requested — ${request.nextStep}`)
    process.exit(0)
  }

  // remember() writes one memory, always as AGENT_INFERRED — the service stamps provenance,
  // never the caller.
  const saved = await mida.remember({ namespace: "projects.current", content: { note: "sdk-basic was here" } })
  console.log(`remembered ${saved.id} (${saved.state})`)

  // context() reads what this agent's grants cover — chain order, whole records, byte budget.
  const { items } = await mida.context({ namespace: "projects.current", limit: 8_192 })
  const own = items.find((item) => item.id === saved.id)
  console.log(`context() returned ${items.length} item(s)`)

  // verify() checks one item against the chain: the commitment, the author it recorded, and
  // that a live grant let the write land.
  if (own !== undefined && own.state === "anchored") {
    const verdict = await mida.verify(own)
    console.log(`verify: ${verdict.valid ? "valid" : "INVALID"} — ${verdict.checks.map((check) => `${check.name} ${check.ok ? "ok" : "failed"}`).join(", ")}`)
  } else {
    console.log(`verify: skipped — the record is ${own?.state ?? "not visible yet"}, not anchored`)
  }

  // The two session texts the adapters inject, unchanged.
  const handoff = await mida.handoff()
  console.log(`handoff: ${handoff.kind}`)
  const news = await mida.whatsNew()
  console.log(`whatsNew: ${news.kind} — ${news.text}`)
} catch (error) {
  if (isMidaSdkError(error)) {
    console.error(`refused: ${error.code} — ${error.message}`)
    process.exit(1)
  }
  throw error
}
