# 01. One session-start read, timed step by step

**What it measures.** How long Mida takes to load a project's memory when a session starts, and
which steps take the time. Mida gives the read 7.5 seconds. Past that it stops waiting and the
session starts with no memory.

**Result (Oct 1 2026).** A project with 250 saved sessions, one encrypted checkpoint each. 5 reads.

| Step | Median | Slowest of 5 |
|---|---|---|
| Whole read | 6.12 s | 6.60 s |
| Check the agent is approved | 0.43 s | 0.85 s |
| List the saved checkpoints from the store | 2.07 s | 2.58 s |
| Check each checkpoint on Monad | 0.61 s | 0.94 s |
| Download and decrypt the checkpoints | 2.38 s | 2.79 s |
| Check for saves waiting in a shared batch | 0.14 s | 0.15 s |
| Read the facts saved with `mida remember` (runs alongside the checkpoint read) | 3.04 s | 3.23 s |

**What it decides.** At this size a median read finishes 1.4 s before the cut-off, and the slowest
of the five finished 0.9 s before it. Listing plus downloading and decrypting take 4.4 s of the
6.1 s. Both steps touch every saved checkpoint, so they take longer as the owner saves more. This
file times one size, so it cannot say how much each extra checkpoint adds.

The facts read (3.0 s) runs at the same time as the checkpoint read and never set the total in
these five runs. Both reads share one chain connection, and this file does not measure how much
the facts read slows the checkpoint read. Once the checkpoint read takes less than 3 s, the facts
read becomes the slowest step.

**How it was measured.** A measuring script copied the owner's real Mida home into a private
folder, ran the session-start read for one project against the copy five times with writes switched
off, and timed each step. The read code is the 0.1.1 release with timers added. Chain: Monad testnet
through the public RPC. The script is on a development branch and not in this repository yet. The
raw file is here. It holds times, counts, the public RPC address and a timestamp.

**Limits.**
- One machine, one owner, one project, 5 reads, one sitting.
- Each step is a median, so the steps do not add up to the whole read.
- 250 is the project's count. The read opens every checkpoint the owner has saved in every project
  and then keeps this project's (`readCheckpoints` in `apps/midad/src/skeleton.ts`). The run did not
  record that total.
- Nothing else was using the copy. A live session start shares the machine and the chain connection
  with saves in progress, and its time varies more (file 02).

**Status.** Reviewed Oct 2 2026: every number recomputed from the raw file by a second reader.

**Files.** Raw: [`01-session-start-read-busy-project.json`](01-session-start-read-busy-project.json)
(`p50` holds the medians, `p95` the slowest of 5, `runs` each read). Chart:
[`charts/01-session-start-breakdown-light.svg`](charts/01-session-start-breakdown-light.svg)
(dark: `-dark.svg`, editable: `.excalidraw`).
