"""Local demo server: the same Lambda handler behind Python's http.server.

    python backend/local_server.py [--port 8787]

Serves /v1/* through handlers.api.handler (in-process store, APP_MODE=local-demo
unless set) and app/dist as static files when it has been built. No SAM, Docker
or AWS account needed. This is the "Local demo" mode of the brief - it proves
the domain logic, not DynamoDB/IAM behaviour.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
# repo-root .env (git-ignored) for local secrets such as GOOGLE_MAPS_API_KEY; real env vars win
_env = Path(__file__).resolve().parent.parent / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _k, _, _v = _line.partition("=")
        if _k.strip() and not _k.lstrip().startswith("#") and _v:
            os.environ.setdefault(_k.strip(), _v.split("#")[0].strip())
os.environ.setdefault("APP_MODE", "local-demo")
os.environ.setdefault("DEMO_ADMIN_KEY", "local-demo-admin")

from handlers.api import handler  # noqa: E402

DIST = ROOT.parent / "app" / "dist"
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(BaseHTTPRequestHandler):
    def _api(self) -> None:
        parts = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", "replace") if length else None
        event = {
            "rawPath": parts.path,
            "queryStringParameters": dict(parse_qsl(parts.query)) or None,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
            "isBase64Encoded": False,
            "requestContext": {"http": {"method": self.command}, "requestId": str(uuid.uuid4())},
        }
        result = handler(event)
        payload = base64.b64decode(result["body"]) if result.get("isBase64Encoded") else result["body"].encode("utf-8")
        self.send_response(result["statusCode"])
        for k, v in result["headers"].items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _static(self) -> None:
        path = urlsplit(self.path).path
        target = (DIST / path.lstrip("/")).resolve()
        if not target.is_relative_to(DIST.resolve()) or not target.is_file():
            target = DIST / "index.html"  # SPA shell
        if not target.is_file():
            self.send_error(404, "app/dist not built - run `npm run build` in app/, or use `npm run dev`")
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("content-type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self._api() if self.path.startswith("/v1/") else self._static()

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/v1/"):
            self._api()
        else:
            self.send_error(405)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[local] " + (fmt % args) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(json.dumps({"listening": f"http://{args.host}:{args.port}", "mode": os.environ["APP_MODE"],
                      "staticApp": DIST.is_dir()}))
    server.serve_forever()


if __name__ == "__main__":
    main()
