"""Drive the demo scenario and the AWS smoke test against a running API. stdlib only.

    set DEMO_ADMIN_KEY=...                       (local default: local-demo-admin)
    python scripts/demo.py --api http://127.0.0.1:8787 status
    python scripts/demo.py --api URL reset              # clears ONLY the demo namespace
    python scripts/demo.py --api URL report a           # synthetic contributor demo-a reports water
    python scripts/demo.py --api URL report b --kind NO_WATER_OBSERVED
    python scripts/demo.py --api URL advance 35         # demo clock +35 min (stale evidence)
    python scripts/demo.py --api URL fail on|off        # simulate route-provider failure
    python scripts/demo.py --api URL compare
    python scripts/demo.py --api URL smoke              # golden journey + retries + concurrency, prints request IDs

Every report this script sends is synthetic and is stored with provenance SYNTHETIC_DEMO.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

CORRIDOR, PAIR, HID = "MINTO_CP", "AJMERI_GATE_TO_CP", "MINTO_BRIDGE"


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.admin = os.environ.get("DEMO_ADMIN_KEY", "local-demo-admin")

    def call(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"content-type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return res.status, json.load(res), res.headers.get("x-request-id")
        except urllib.error.HTTPError as err:
            return err.code, json.load(err), err.headers.get("x-request-id")

    def control(self, body: dict):
        return self.call("POST", "/v1/demo/control", body, {"x-demo-admin-key": self.admin})

    def report(self, who: str, kind: str = "WATER_OBSERVED", event_id: str | None = None,
               minutes_ago: float = 0, mode: str | None = None, text: str | None = None,
               observed_at: str | None = None, depth: str | None = None, stalled: int | None = None):
        status = self.call("GET", "/v1/status")[1]
        mode = mode or status["clientMode"]
        server_now = datetime.fromisoformat(status["serverTime"].replace("Z", "+00:00"))
        body = {"schemaVersion": "1.0", "eventId": event_id or str(uuid.uuid4()), "hotspotId": HID,
                "kind": kind, "observedAt": observed_at or (server_now - timedelta(minutes=minutes_ago)).isoformat()
                .replace("+00:00", "Z"), "location": {"source": "selected_hotspot", "accuracyM": None},
                "clientMode": mode, "description": text}
        if depth:
            body["depthClaim"] = {"level": depth, "sourcePhrase": depth}
        if stalled is not None:
            body["stalledVehicles"] = stalled
        return self.call("POST", "/v1/observations", body, {"x-demo-contributor": f"demo-{who}"})

    def compare(self):
        return self.call("POST", "/v1/routes/compare", {"corridorId": CORRIDOR, "routePairId": PAIR})


def show(result) -> None:
    status, body, rid = result
    print(f"HTTP {status}  request-id {rid}")
    print(json.dumps(body, indent=2, ensure_ascii=False)[:4000])


def smoke(api: Api) -> int:
    """Golden journey. Exit code 0 only if every check holds."""
    failures = []

    def check(name: str, ok: bool, detail: object = "") -> None:
        print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    status = api.call("GET", "/v1/status")
    check("status reachable", status[0] == 200, status[1].get("modeLabel"))
    check("demo reset", api.control({"reset": True})[0] == 200)

    d = api.compare()
    check("E01 no reports -> baseline, no safety claim", d[1].get("selectedRouteId") == "A_VIA_MINTO", d[2])

    event = str(uuid.uuid4())
    at = api.call("GET", "/v1/status")[1]["serverTime"]
    first = api.report("a", event_id=event, text="Minto Bridge ke neeche paani hai", observed_at=at)
    check("report A accepted (201)", first[0] == 201, f"{first[1].get('state')} rev {first[1].get('revision')} req {first[2]}")
    replay = api.report("a", event_id=event, text="Minto Bridge ke neeche paani hai", observed_at=at)
    check("E03 retry is idempotent", replay[0] == 200 and replay[1].get("duplicate") is True, replay[2])
    changed = api.report("a", event_id=event, kind="NO_WATER_OBSERVED", observed_at=at)
    check("E04 same eventId, changed body -> 409", changed[0] == 409, changed[1].get("error", {}).get("code"))

    second = api.report("b")
    check("E06 second source -> CORROBORATED", second[1].get("state") == "CORROBORATED", second[2])
    d = api.compare()
    check("R01 baseline rejected, detour selected", d[1].get("selectedRouteId") == "B_VIA_SHIVAJI_FLYOVER",
          f"extra {d[1].get('extraMetres')} m / {d[1].get('extraSeconds')} s, req {d[2]}")

    codes: list[int] = []
    threads = [threading.Thread(target=lambda n=n: codes.append(api.report(f"c{n}")[0])) for n in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    evidence = api.call("GET", f"/v1/hotspots/{HID}/evidence")[1]
    stored = len(evidence.get("observations", []))
    check("E17 concurrent writes: no lost or phantom observation",
          stored == 2 + codes.count(201) and set(codes) <= {201, 409}, f"codes {codes}, stored {stored}")

    anon = api.call("POST", "/v1/observations", {"schemaVersion": "1.0"})
    check("S01 anonymous write rejected", anon[0] == 401)

    api.control({"clockOffsetMinutes": 35})
    hz = api.call("GET", f"/v1/hazards?corridorId={CORRIDOR}")[1]["hazards"][0]
    check("E11 aged-out evidence -> STALE, still avoided", hz["state"] == "STALE" and
          api.compare()[1].get("selectedRouteId") == "B_VIA_SHIVAJI_FLYOVER", hz["state"])

    api.control({"simulateRouteProviderFailure": True})
    fail = api.compare()
    check("R09 provider failure is explicit 503", fail[0] == 503, fail[1].get("error", {}).get("code"))
    api.control({"reset": True})
    print(f"\n{'ALL PASSED' if not failures else 'FAILED: ' + ', '.join(failures)}")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("DJN_API", "http://127.0.0.1:8787"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("reset")
    sub.add_parser("compare")
    sub.add_parser("smoke")
    r = sub.add_parser("report")
    r.add_argument("who", help="synthetic contributor suffix, e.g. a or b")
    r.add_argument("--kind", default="WATER_OBSERVED")
    r.add_argument("--minutes-ago", type=float, default=0)
    r.add_argument("--text")
    r.add_argument("--depth", choices=["ankle", "knee", "waist", "submerged"])
    r.add_argument("--stalled", type=int)
    sub.add_parser("weather")
    rain = sub.add_parser("rain", help="simulate model rain (mm/h) for the weather advisory; 'off' to clear")
    rain.add_argument("mm")
    dr = sub.add_parser("draft", help="extract a report draft from Hinglish text")
    dr.add_argument("text")
    a = sub.add_parser("advance")
    a.add_argument("minutes", type=int)
    f = sub.add_parser("fail")
    f.add_argument("state", choices=["on", "off"])
    args = ap.parse_args()
    api = Api(args.api)

    if args.cmd == "status":
        show(api.call("GET", "/v1/status"))
    elif args.cmd == "reset":
        show(api.control({"reset": True}))
    elif args.cmd == "compare":
        show(api.compare())
    elif args.cmd == "report":
        show(api.report(args.who, args.kind, minutes_ago=args.minutes_ago, text=args.text,
                        depth=args.depth, stalled=args.stalled))
    elif args.cmd == "weather":
        show(api.call("GET", "/v1/weather"))
    elif args.cmd == "rain":
        show(api.control({"simulateRainMmPerHour": None if args.mm == "off" else float(args.mm)}))
    elif args.cmd == "draft":
        show(api.call("POST", "/v1/report-drafts", {"text": args.text}, {"x-demo-contributor": "demo-a"}))
    elif args.cmd == "advance":
        show(api.control({"clockOffsetMinutes": args.minutes}))
    elif args.cmd == "fail":
        show(api.control({"simulateRouteProviderFailure": args.state == "on"}))
    elif args.cmd == "smoke":
        return smoke(api)
    return 0


if __name__ == "__main__":
    sys.exit(main())
