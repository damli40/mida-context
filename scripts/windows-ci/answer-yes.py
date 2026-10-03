"""Run a command in a pseudo-console and type `yes` at each "Type yes" prompt.

Usage: python answer-yes.py <program> [args...]
Approve and revoke refuse to run without a real terminal; pywinpty gives them one.
Exit code: the command's own, or 124 when it is still running after 240 seconds.
"""
import re
import sys
import time

from winpty import PtyProcess

PROMPT = re.compile(r"[Tt]ype yes[^\n:]*:")
proc = PtyProcess.spawn(sys.argv[1:])
seen = ""
deadline = time.time() + 240
while proc.isalive() and time.time() < deadline:
    try:
        chunk = proc.read(1024)
    except EOFError:
        break
    sys.stdout.write(chunk)
    sys.stdout.flush()
    seen += chunk
    if PROMPT.search(seen):
        time.sleep(1)
        proc.write("yes\r\n")
        seen = ""
if proc.isalive():
    proc.terminate(force=True)
    sys.exit(124)
sys.exit(proc.exitstatus or 0)
