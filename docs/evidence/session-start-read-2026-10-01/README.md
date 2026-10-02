# Session-start read: evidence, Oct 1 2026

How long Mida takes to load a project's memory when a session starts, and what real session starts
got. One file per measurement. Raw files hold times, counts, the public RPC address and a
timestamp: no content, paths, wallet addresses or session ids.

| # | What | Result | Write-up | Chart |
|---|---|---|---|---|
| 01 | One read in a project with 250 saved sessions, timed step by step | 6.1 s median against a 7.5 s cut-off | [01](01-session-start-read-busy-project.md) | [light](charts/01-session-start-breakdown-light.svg), [dark](charts/01-session-start-breakdown-dark.svg) |
| 02 | What 26 real session starts got after the Sep 29 read fix | 17 loaded everything, 3 loaded part, 3 timed out with nothing, 3 had nothing saved for the task | [02](02-session-start-outcomes.md) | [light](charts/02-session-start-outcomes-light.svg), [dark](charts/02-session-start-outcomes-dark.svg) |

**Not measured.** How much each extra checkpoint adds to the read. A session start on a new
account with a handful of saves. Anything on a second machine or a second owner.

**Checking the numbers.** From `charts/`, `python3 tools/recount.py` recomputes file 02 from its raw
file. File 01's medians are the `p50` block of its raw file.

**Rebuilding the charts.** From `charts/`, `python3 tools/charts.py` writes the `.excalidraw` files
(the numbers are in that script, each with the raw field it came from). Then
`python3 tools/render.py 01-session-start-breakdown 02-session-start-outcomes` exports them with
Excalidraw's own exporter in headless Chrome and embeds the font from
`docs/architecture/mida-architecture-light.svg`. It needs Google Chrome and network access to
esm.sh.
