"""Builds the session-start evidence charts as .excalidraw files (horizontal bar charts).
Numbers come from ../01-*.json and ../02-*.json; each chart's rows name the fields they use.
tools/recount.py prints the counts for chart 02 from the raw file."""
import json

CHAR = 0.52  # rough Virgil glyph width as a share of the font size

def hbar(name, title, subtitles, rows, px, ticks, tick_label, value_label, legend, footnote,
         limit=None, gap_before_last=False, x0=330):
    els, seed = [], [2000]
    def base(id_, type_, x, y, w, h, stroke, bg="transparent", rough=1, **extra):
        seed[0] += 2
        e = {"angle": 0, "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": rough,
             "opacity": 100, "groupIds": [], "frameId": None, "seed": seed[0], "version": 1,
             "versionNonce": seed[0] + 1, "isDeleted": False, "boundElements": None, "updated": 1,
             "link": None, "locked": False, "id": id_, "type": type_, "x": x, "y": y, "width": w,
             "height": h, "strokeColor": stroke, "backgroundColor": bg, "roundness": None}
        e.update(extra); els.append(e)
    def text(id_, s, x, y, size=15, color="#1e1e1e", anchor_right=None):
        w = len(s) * size * CHAR
        if anchor_right is not None: x = anchor_right - w
        else: w = len(s) * size * 0.64   # generous box so the exported canvas never clips a label
        base(id_, "text", x, y, w, round(size * 1.25), color, text=s, originalText=s, fontSize=size,
             fontFamily=1, textAlign="right" if anchor_right is not None else "left", verticalAlign="top",
             containerId=None, lineHeight=1.25, baseline=round(size * 0.92))
    def line(id_, x, y, dx, dy, color, dashed=False):
        base(id_, "line", x, y, abs(dx), abs(dy), color, rough=0, points=[[0, 0], [dx, dy]],
             startBinding=None, endBinding=None, startArrowhead=None, endArrowhead=None,
             lastCommittedPoint=None, strokeSharpness="sharp", strokeStyle="dashed" if dashed else "solid")

    text("title", title, 60, 40, 24)
    for i, s in enumerate(subtitles):
        text(f"subtitle-{i}", s, 60, 76 + i * 21, 15, "#495057")
    top, pitch, bar = 76 + len(subtitles) * 21 + 34, 46, 28
    for i, (label, value, (stroke, fill)) in enumerate(rows):
        y = top + i * pitch + (16 if gap_before_last and i == len(rows) - 1 else 0)
        text(f"label-{i}", label, 0, y + 5, 15, anchor_right=x0 - 14)
        base(f"bar-{i}", "rectangle", x0, y, round(value * px, 1), bar, stroke, fill, roundness={"type": 3})
        text(f"value-{i}", value_label(value), x0 + value * px + 10, y + 5, 15, stroke)
    bottom = top + len(rows) * pitch + (16 if gap_before_last else 0)
    line("axis-y", x0, top - 14, 0, bottom - top + 14, "#495057")
    line("axis-x", x0, bottom, ticks[-1] * px + 20, 0, "#495057")
    for t in ticks:
        line(f"tick-{t}", x0 + t * px, bottom, 0, 6, "#495057")
        text(f"tick-label-{t}", tick_label(t), x0 + t * px - 8, bottom + 10, 13, "#495057")
    if limit:
        lx = x0 + limit[0] * px
        line("limit", lx, top - 14, 0, bottom - top + 14, "#c92a2a", dashed=True)
        text("limit-label", limit[1], lx - 74, top - 38, 14, "#c92a2a")
    ly = bottom + 48
    for j, ((stroke, fill), what) in enumerate(legend):
        base(f"legend-box-{j}", "rectangle", 60, ly + j * 28, 18, 18, stroke, fill, roundness={"type": 3})
        text(f"legend-{j}", what, 88, ly + j * 28, 13, "#495057")
    for k, s in enumerate(footnote):
        text(f"footnote-{k}", s, 60, ly + len(legend) * 28 + 6 + k * 19, 13, "#495057")
    ids = [e["id"] for e in els]
    assert len(ids) == len(set(ids)), "duplicate ids"
    assert not any(e["type"] == "diamond" for e in els)
    doc = {"type": "excalidraw", "version": 2, "source": "claude-code-excalidraw-skill", "elements": els,
           "appState": {"gridSize": 20, "viewBackgroundColor": "#ffffff"}, "files": {}}
    json.dump(doc, open(name + ".excalidraw", "w"), indent=1)
    print(name, len(els), "elements")

RED, BLUE = ("#c92a2a", "#ffc9c9"), ("#1971c2", "#a5d8ff")
YELLOW, GREY, GREEN = ("#f08c00", "#ffec99"), ("#1e1e1e", "#dee2e6"), ("#2f9e44", "#b2f2bb")

# 01: medians of 5 reads, 01-session-start-read-busy-project.json (p50.steps, p50.totalMs).
# "Other read work" is p50.totalMs minus the four timed steps above it.
hbar("01-session-start-breakdown", "Where a session start spends its time",
     ["One read in the busiest project: 250 saved sessions, median of 5 reads on Monad testnet, Oct 1 2026.",
      "Timed on the 0.1.1 read code. Past 7.5 s the session starts with no memory."],
     [("Check the agent is approved", 0.43, BLUE), ("List the saved checkpoints", 2.07, RED),
      ("Check each checkpoint on Monad", 0.61, BLUE), ("Download and decrypt the checkpoints", 2.38, RED),
      ("Other read work", 0.63, BLUE), ("Read facts saved with mida remember", 3.04, YELLOW),
      ("Whole read", 6.12, GREY)],
     px=86, ticks=(0, 2, 4, 6, 8), tick_label=lambda t: f"{t} s", value_label=lambda v: f"{v:.1f} s",
     legend=[(RED, "Grows as you save more. The planned memory index is designed to remove these two steps."),
             (YELLOW, "Runs at the same time as the checkpoint read, so it is not added to the total."),
             (BLUE, "Other steps.")],
     footnote=["Bars are medians of 5 reads. \"Other read work\" is the whole read minus the four steps above it."],
     limit=(7.5, "7.5 s limit"), gap_before_last=True)

# 02: the 26 started reads from row 112 of 02-session-start-outcomes.json on (runs[].kind / reason /
# partial). Row 112 is the first read after the Sep 29 batched-read fix; tools/recount.py prints these.
N = 26
hbar("02-session-start-outcomes", "What 26 real session starts got from Mida",
     ["Every Claude Code session start in the log of one owner's Mida service that began a read,",
      "from the Sep 29 read fix to Oct 1 2026."],
     [("Full memory loaded", 17, GREEN), ("Part of the memory loaded", 3, YELLOW),
      ("Nothing saved for this task yet", 3, GREY),
      ("Timed out: started with no memory", 3, RED)],
     px=30, ticks=(0, 5, 10, 15, 20), tick_label=lambda t: f"{t}",
     value_label=lambda v: f"{v}  ({round(100 * v / N)}%)",
     legend=[(RED, "The session started without its memory: 3 of 26 starts."),
             (YELLOW, "The read returned with only part of the memory: 3 of 26 starts.")],
     footnote=["Before the fix the same log holds 96 starts: 30 timed out and 13 loaded only part.",
               "Not shown: 1 start in a folder that is not a Mida project."])
