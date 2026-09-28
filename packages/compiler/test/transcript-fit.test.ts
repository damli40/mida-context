// P-1 / B1 — typed-message conservation in fitMessages: every typed user
// message other than the pinned request must appear in EXACTLY ONE place —
// the newest-first fill OR the "messages you typed" group — and a message
// may leave the group only into its "[… N older messages of yours omitted …]"
// count line, whose N must equal the number not shown. Seeded-random search
// over realistic message mixes; promoted from the rvint fit-fuzz probe, which
// found messages landing in neither place while the count line claimed zero.

import { describe, expect, it } from "vitest"
import { fitMessages, twoEndedCut, type TypedMark } from "../src/transcript-lines.js"

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe.each([[false], [true]])("fitMessages typed-message conservation (small maxChars: %s)", (SMALL) => {
  it("never loses or duplicates a typed message", () => {
    const failures: string[] = []
    // 5,000 seeded trials per budget mode — the probe's 50,000 found the bug
    // at ~1–2% incidence, so this keeps a comfortable margin for the suite.
    for (let trial = 0; trial < 5_000 && failures.length < 3; trial++) {
      const r = rng(trial + 1)
      const n = 3 + Math.floor(r() * 140)
      const msgs: { role: string; block: string; typed?: TypedMark }[] = []
      const typedIdx: number[] = []
      for (let i = 0; i < n; i++) {
        const line = i + 1
        const isUser = i === 0 || r() < 0.45
        if (isUser) {
          const len = r() < 0.3 ? 1500 + Math.floor(r() * 3000) : 5 + Math.floor(r() * 300)
          const text = `U${line}-` + "w".repeat(len)
          msgs.push({ role: "user", block: `L${line} user:\n${twoEndedCut(text)}`, typed: { label: `L${line}`, order: line, text } })
          typedIdx.push(i)
        } else {
          const len = 20 + Math.floor(r() * (r() < 0.3 ? 6000 : 1500))
          msgs.push({ role: "assistant", block: `L${line} assistant:\n` + "a".repeat(len) })
        }
      }
      const maxChars = SMALL ? 2_000 + Math.floor(r() * 30_000) : 40_000
      const out = fitMessages(msgs, maxChars, false, 0, null, null, null)
      const text = out.text
      const gStart = text.indexOf("user — later messages you typed")
      const gEnd = gStart === -1 ? -1 : text.indexOf("\n\n", gStart)
      const group = gStart === -1 ? "" : text.slice(gStart, gEnd === -1 ? undefined : gEnd)
      const rest = gStart === -1 ? text : text.slice(0, gStart) + (gEnd === -1 ? "" : text.slice(gEnd))
      const omittedLine = /\[… (\d+) older messages of yours omitted …\]/.exec(group)
      const omittedOlder = omittedLine === null ? 0 : Number(omittedLine[1])
      let lost = 0
      for (const i of typedIdx) {
        if (i === 0) continue
        const m = msgs[i]!
        const inFill = rest.includes(m.block)
        const inGroup = group.includes(`\n${m.typed!.label}: `)
        if (inFill && inGroup) failures.push(`trial ${trial}: ${m.typed!.label} rendered twice (maxChars ${maxChars})`)
        if (!inFill && !inGroup) lost += 1
      }
      // a message may leave the group only into its "N older omitted" count line
      if (lost > omittedOlder) failures.push(`trial ${trial}: ${lost} typed message(s) in neither place, count line says ${omittedOlder} (maxChars ${maxChars})`)
      if (!SMALL && text.length > maxChars) failures.push(`trial ${trial}: text ${text.length} > maxChars ${maxChars}`)
    }
    expect(failures).toEqual([])
  })
})
