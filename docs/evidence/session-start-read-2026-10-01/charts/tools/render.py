"""Export each named .excalidraw to SVG (Excalidraw's own exporter in headless Chrome), embed Virgil,
write light and dark files, and render a PNG of each light file for a visual check."""
import http.server, socketserver, subprocess, sys, threading, time, urllib.parse, os, re, tempfile, shutil
# Run from this folder's parent (charts/):  python3 tools/render.py <name> [<name> ...]
# Set PREVIEW=1 to also write PNG previews into a temp folder (path printed at the end).
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
profile = tempfile.mkdtemp(prefix="chart-chrome-")
preview = tempfile.mkdtemp(prefix="chart-preview-") if os.environ.get("PREVIEW") else None
def run_chrome(args, until, wait=60):
    p = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                          f"--user-data-dir={profile}"] + args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    while time.time() - t0 < wait and not until(): time.sleep(0.3)
    time.sleep(0.5); p.terminate()
    try: p.wait(10)
    except Exception: p.kill()
    return until()
got = {}
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/__preview": return super().do_GET()
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        bg = "#ffffff" if q["mode"] == "light" else "#0d1117"
        html = f'<body style="margin:0;background:{bg}"><img src="/{os.path.basename(q["name"])}-{q["mode"]}.svg" width="{float(q["w"])}" height="{float(q["h"])}">'
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(html.encode())
    def do_POST(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        got[os.path.basename(q["name"][0])] = body.decode()
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
here = os.path.dirname(os.path.abspath(__file__))
ref = open(os.path.join(here, "..", "..", "..", "..", "architecture", "mida-architecture-light.svg")).read()
defs = re.search(r"<defs>.*?</defs>", ref, re.S).group(0)
assert "data:font/woff2;base64," in defs and "excalidraw.com" not in defs
for name in sys.argv[1:]:
    ok = run_chrome(["--remote-debugging-port=0", f"http://127.0.0.1:{port}/tools/export.html?name={name}"], lambda: name in got or name + ".error" in got)
    assert name in got, got.get(name + ".error", "export timed out")
    svg, n = re.subn(r"<defs>.*?</defs>", lambda m: defs, got[name], count=1, flags=re.S)
    assert n == 1 and "excalidraw.com" not in svg, "a remote font link is left"
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)" width="[\d.]+" height="[\d.]+"', svg)
    w, h = float(m.group(1)), float(m.group(2))
    head = f'viewBox="0 0 {w:g} {h:g}" width="{w*2:g}" height="{h*2:g}"'
    open(name + "-light.svg", "w").write(svg.replace(m.group(0), head, 1))
    open(name + "-dark.svg", "w").write(svg.replace(m.group(0), head + ' filter="invert(93%) hue-rotate(180deg)"', 1))
    for mode in ("light", "dark") if preview else ():
        png = f"{preview}/{name}-{mode}.png"
        page = f"http://127.0.0.1:{port}/__preview?name={name}&mode={mode}&w={w}&h={h}"
        run_chrome(["--hide-scrollbars", f"--window-size={int(w)},{int(h)}", f"--screenshot={png}", page],
                   lambda: os.path.exists(png) and os.path.getsize(png) > 0, wait=30)
    print(name, "viewBox", w, h, "svg bytes", len(svg))
srv.shutdown()
shutil.rmtree(profile, ignore_errors=True)
if preview: print("previews in", preview)
