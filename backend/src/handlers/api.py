"""API Gateway HTTP API (payload v2) -> Service. Also driven by backend/local_server.py.

ponytail: one function owns every route. Split into per-route functions with
narrower IAM roles once reviewer/pilot traffic is real (section 15.1).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import time

from domain.validation import MAX_BODY_BYTES, ApiError
from service import Config, Service

log = logging.getLogger()
log.setLevel(logging.INFO)

_service: Service | None = None


def service() -> Service:
    global _service
    if _service is None:
        config = Config.from_env()
        if os.environ.get("TABLE_NAME"):
            from storage.dynamo import DynamoStore

            store = DynamoStore(os.environ["TABLE_NAME"])
        else:
            from storage.local import LocalStore

            store = LocalStore()
        _service = Service(store, config)
    return _service


EVIDENCE_RE = re.compile(r"^/v1/hotspots/([A-Z0-9_]{1,64})/evidence$")


def _json(status: int, body: dict, request_id: str) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json; charset=utf-8", "cache-control": "no-store",
                    "x-request-id": request_id},
        "body": json.dumps(body, ensure_ascii=False),
    }


def _body(event: dict) -> object:
    raw = event.get("body") or ""
    data = base64.b64decode(raw) if event.get("isBase64Encoded") else raw.encode("utf-8")
    if len(data) > MAX_BODY_BYTES:
        raise ApiError(413, "BODY_TOO_LARGE", "Request body is too large.")
    try:
        return json.loads(data or b"null")
    except (ValueError, UnicodeDecodeError):
        raise ApiError(400, "INVALID_JSON", "Request body is not valid JSON.") from None


def _tts(query: dict, request_id: str) -> dict:
    """GET /v1/tts?text=&lang= -> MP3 (binary, base64 for API Gateway). Cacheable: same text, same audio."""
    from providers import external, tts

    text, lang = (query.get("text") or "").strip(), query.get("lang", "en")
    if not text or len(text) > tts.MAX_CHARS or lang not in tts.VOICES:
        return _json(400, {"error": {"code": "INVALID_TTS_REQUEST", "message": f"text 1-{tts.MAX_CHARS} chars, lang en|hi",
                                     "retryable": False, "requestId": request_id}}, request_id)
    try:
        audio = tts.synth(text, lang)
    except external.ProviderError as exc:
        return _json(503, {"error": {"code": "TTS_UNAVAILABLE", "message": str(exc), "retryable": True,
                                     "requestId": request_id}}, request_id)
    return {"statusCode": 200, "isBase64Encoded": True, "body": base64.b64encode(audio).decode(),
            "headers": {"content-type": "audio/mpeg", "cache-control": "public, max-age=604800", "x-request-id": request_id}}


def route(svc: Service, event: dict) -> tuple[int, dict]:
    method = event["requestContext"]["http"]["method"]
    path = event.get("rawPath", "/")
    query = event.get("queryStringParameters") or {}
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    claims = ((event["requestContext"].get("authorizer") or {}).get("jwt") or {}).get("claims")

    if method == "GET" and path == "/v1/status":
        return 200, svc.status()
    if method == "GET" and path == "/v1/hotspots":
        return 200, svc.hotspots_view(query.get("corridorId"))
    if method == "GET" and path == "/v1/hazards":
        return 200, svc.hazards(query.get("corridorId"))
    if method == "GET" and (m := EVIDENCE_RE.match(path)):
        return 200, svc.evidence(m.group(1))
    if method == "POST" and path == "/v1/observations":
        return svc.submit(_body(event), svc.principal_from(headers, claims))
    if method == "POST" and path == "/v1/routes/compare":
        return 200, svc.compare(_body(event))
    if method == "POST" and path == "/v1/reviews":
        return 200, svc.review(_body(event), svc.principal_from(headers, claims))
    if method == "POST" and path == "/v1/report-drafts":
        return 200, svc.report_draft(_body(event), svc.principal_from(headers, claims))
    if method == "GET" and path == "/v1/geocode":
        return 200, svc.geocode(query.get("q"), query.get("near"))
    if method == "GET" and path == "/v1/weather":
        return 200, svc.weather()
    if method == "POST" and path == "/v1/demo/control":
        return 200, svc.demo_control(_body(event), svc.principal_from(headers, claims))
    raise ApiError(404, "NOT_FOUND", "No such route.")


def handler(event: dict, context: object = None) -> dict:
    started = time.perf_counter()
    request_id = event.get("requestContext", {}).get("requestId", "local")
    if event.get("rawPath") == "/v1/tts" and event["requestContext"]["http"]["method"] == "GET":
        return _tts(event.get("queryStringParameters") or {}, request_id)  # binary, not the JSON envelope
    svc = service()
    try:
        status, body = route(svc, event)
        code = "OK"
    except ApiError as err:
        status, code = err.status, err.code
        body = {"error": {"code": err.code, "message": err.message, "retryable": err.retryable,
                          "requestId": request_id}}
    except Exception:  # never leak internals; the log has the trace
        log.exception("unhandled error")
        status, code = 500, "INTERNAL"
        body = {"error": {"code": "INTERNAL", "message": "Something went wrong.", "retryable": True,
                          "requestId": request_id}}
    # structured log: no report text, no contributor identity
    log.info(json.dumps({
        "requestId": request_id, "route": event.get("routeKey") or event.get("rawPath"),
        "status": status, "result": code, "namespace": svc.cfg.namespace,
        "revision": body.get("revision") if isinstance(body, dict) else None,
        "latencyMs": round((time.perf_counter() - started) * 1000, 1),
    }))
    return _json(status, body, request_id)
