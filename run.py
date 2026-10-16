"""One command to run DilliJalNav:  python run.py

1. installs what is missing (Python: segno for the QR code, edge-tts for the
   natural voice; npm packages for the app),
2. builds the app if the source changed since the last build,
3. starts the backend + app server (backend/local_server.py),
4. opens an HTTPS Cloudflare quick tunnel (the phone camera and GPS need HTTPS),
5. prints a QR code: scan it with the phone camera.

Ctrl+C stops everything. Options: --no-tunnel (LAN only, no camera on phones),
--port N, --rebuild.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
DIST = APP / "dist" / "index.html"
PY_NEEDS = {"segno": "segno", "edge_tts": "edge-tts"}
CLOUDFLARED_PATHS = [r"C:\Program Files (x86)\cloudflared\cloudflared.exe", r"C:\Program Files\cloudflared\cloudflared.exe"]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # QR blocks and Hindi on the Windows console


def say(msg: str) -> None:
    print(f"[run] {msg}", flush=True)


def ensure_python_packages() -> None:
    missing = [pkg for mod, pkg in PY_NEEDS.items() if importlib.util.find_spec(mod) is None]
    if missing:
        say("installing " + ", ".join(missing))
        subprocess.run([sys.executable, "-m", "pip", "install", "--user", "-q", *missing], check=True)
        importlib.invalidate_caches()


def npm() -> str:
    exe = shutil.which("npm")
    if not exe:
        sys.exit("[run] Node.js (npm) is required: https://nodejs.org")
    return exe


def build_app(force: bool) -> None:
    if not (APP / "node_modules").is_dir():
        say("npm install (first run)")
        subprocess.run([npm(), "install"], cwd=APP, check=True)
    sources = [p for d in ("src", "public") for p in (APP / d).rglob("*") if p.is_file()]
    sources += [APP / "index.html", APP / ".env.local"]
    newest = max((p.stat().st_mtime for p in sources if p.exists()), default=0)
    if force or not DIST.exists() or DIST.stat().st_mtime < newest:
        say("building the app")
        subprocess.run([npm(), "run", "build"], cwd=APP, check=True)
    else:
        say("app build is up to date")


def free_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    sys.exit("[run] no free port found")


def wait_http(url: str, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def lan_ip() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("8.8.8.8", 80))  # no packet is sent; this just picks the outgoing interface
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def start_tunnel(port: int, procs: list) -> str | None:
    exe = shutil.which("cloudflared") or next((p for p in CLOUDFLARED_PATHS if Path(p).exists()), None)
    if not exe:
        say("cloudflared not found - install it for the HTTPS phone link: winget install Cloudflare.cloudflared")
        return None
    say("opening HTTPS tunnel")
    proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    procs.append(proc)
    found: list[str] = []

    def read() -> None:  # keep draining the pipe for the tunnel's whole life
        for line in proc.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not found:
                found.append(m.group(0))

    threading.Thread(target=read, daemon=True).start()
    end = time.time() + 40
    while not found and time.time() < end and proc.poll() is None:
        time.sleep(0.3)
    if not found:
        say("tunnel did not come up")
        return None
    return found[0]


def check_tunnel(url: str) -> None:
    # a fresh quick tunnel can take a while before its DNS name resolves; checked after the QR is shown
    if wait_http(url + "/v1/status", 90):
        say("phone link is live - scan the QR")
    else:
        say("tunnel URL is not answering from this laptop yet - if the phone cannot open it, wait a minute and rescan")


def show_qr(url: str) -> None:
    import segno

    print()
    segno.make(url, error="l").terminal(compact=True, border=2)
    print(f"\n  Scan with your phone camera:  {url}\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Run DilliJalNav (backend + app + phone link)")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--no-tunnel", action="store_true", help="LAN link only (phone camera needs HTTPS, so it stays off)")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the app even if it looks up to date")
    args = ap.parse_args()

    ensure_python_packages()
    build_app(args.rebuild)

    port = free_port(args.port)
    host = "0.0.0.0" if args.no_tunnel else "127.0.0.1"
    procs: list[subprocess.Popen] = []
    try:
        say(f"starting server on port {port}")
        procs.append(subprocess.Popen([sys.executable, "-B", str(ROOT / "backend" / "local_server.py"),
                                       "--host", host, "--port", str(port)], cwd=ROOT))
        if not wait_http(f"http://127.0.0.1:{port}/v1/status", 20):
            sys.exit("[run] server did not start - see the error above")
        say(f"laptop:  http://127.0.0.1:{port}/")

        url = None if args.no_tunnel else start_tunnel(port, procs)
        if not url:
            url = f"http://{lan_ip()}:{port}/"
            if not args.no_tunnel:
                say("falling back to the LAN link (same Wi-Fi; restart with --no-tunnel so the phone can reach it)")
            say("plain http: maps and reports work on the phone, the camera does not")
        else:
            threading.Thread(target=check_tunnel, args=(url,), daemon=True).start()
        show_qr(url)
        say("running - press Ctrl+C to stop")
        while all(p.poll() is None for p in procs[:1]):
            time.sleep(1)
        say("server stopped")
    except KeyboardInterrupt:
        print()
        say("stopping")
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
