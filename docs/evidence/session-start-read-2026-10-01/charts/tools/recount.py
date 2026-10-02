"""Recomputes every count and time in ../../02-session-start-outcomes.md from the raw file.
Run from charts/:  python3 tools/recount.py"""
import json, os, statistics

here = os.path.dirname(os.path.abspath(__file__))
runs = json.load(open(os.path.join(here, "..", "..", "02-session-start-outcomes.json")))["runs"]
FIX = 112  # first read after the Sep 29 batched-read fix: 155 checkpoints, read time 5.1 s
assert runs[FIX]["pages"] == 155 and runs[FIX]["readMs"] == 5111
assert all(r.get("reason") == "read-slow" for r in runs[FIX - 7:FIX])  # the seven timeouts in a row

def outcome(r):
    if r.get("partial"): return "part loaded"
    if r["kind"] == "handoff": return "full memory"
    if r["kind"] == "empty": return "nothing saved for this task"
    return {"read-slow": "timed out", "read-failed": "read failed"}.get(r["reason"], "no read: " + r["reason"])

def report(label, rows):
    began = [r for r in rows if not outcome(r).startswith("no read")]
    times = sorted(r["totalMs"] for r in began)
    print(f"\n{label}: {len(rows)} logged, {len(began)} began a read, median {statistics.median(times) / 1000:.1f} s")
    for name in ("full memory", "part loaded", "nothing saved for this task", "read failed", "timed out"):
        group = [r for r in began if outcome(r) == name]
        if not group: print(f"  {name:28s}  0"); continue
        t = sorted(r["totalMs"] for r in group); p = sorted(r["pages"] for r in group)
        # the log records a checkpoint count only for a read that loaded something
        size = f", checkpoints {p[0]} to {p[-1]}" if p[-1] > 0 else ""
        print(f"  {name:28s} {len(group):2d} ({round(100 * len(group) / len(began))}%)  "
              f"{t[0] / 1000:.1f} to {t[-1] / 1000:.1f} s, median {statistics.median(t) / 1000:.1f} s{size}")
    for r in rows:
        if outcome(r).startswith("no read"): print(f"  {outcome(r):28s} {r['totalMs']} ms")

report("After the fix (row 112 on)", runs[FIX:])
report("Before the fix (rows 0 to 111)", runs[:FIX])
report("Whole log", runs)
