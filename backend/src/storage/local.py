"""In-process store for the local demo and tests.

Same contract as the DynamoDB adapter, including revision checks and
idempotency, so domain behaviour is identical. It is NOT a DynamoDB emulator:
transactions, IAM and consistency semantics are proven only by the AWS smoke test.
"""
from __future__ import annotations

import copy
import threading


class RevisionConflict(Exception):
    """The hotspot state changed since it was read."""


class DuplicateEvent(Exception):
    """The (source, eventId) idempotency record already exists."""


class LocalStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: dict[tuple[str, str], dict] = {}
        self._obs: dict[tuple[str, str], list[dict]] = {}
        self._reviews: dict[tuple[str, str], list[dict]] = {}
        self._idem: dict[tuple[str, str, str], dict] = {}
        self._control: dict[str, dict] = {}

    def get_state(self, ns: str, hid: str) -> dict | None:
        with self._lock:
            return copy.deepcopy(self._states.get((ns, hid)))

    def list_observations(self, ns: str, hid: str, since: str) -> list[dict]:
        with self._lock:
            # ISO-8601 Z strings sort chronologically
            return [copy.deepcopy(o) for o in self._obs.get((ns, hid), []) if o["observedAt"] >= since]

    def get_idempotency(self, ns: str, source_key: str, event_id: str) -> dict | None:
        with self._lock:
            return copy.deepcopy(self._idem.get((ns, source_key, event_id)))

    def count_recent(self, ns: str, source_key: str, since: str) -> int:
        with self._lock:
            return sum(1 for (n, s, _), r in self._idem.items()
                       if n == ns and s == source_key and r["createdAt"] >= since)

    def commit(self, ns: str, hid: str, expected_revision: int, state: dict,
               observation: dict | None = None, idempotency: dict | None = None,
               review: dict | None = None) -> None:
        with self._lock:
            if idempotency and (ns, idempotency["sourceKey"], idempotency["eventId"]) in self._idem:
                raise DuplicateEvent()
            current = self._states.get((ns, hid), {}).get("revision", 0)
            if current != expected_revision:
                raise RevisionConflict()
            self._states[(ns, hid)] = copy.deepcopy(state)
            if observation:
                self._obs.setdefault((ns, hid), []).append(copy.deepcopy(observation))
            if idempotency:
                self._idem[(ns, idempotency["sourceKey"], idempotency["eventId"])] = copy.deepcopy(idempotency)
            if review:
                self._reviews.setdefault((ns, hid), []).append(copy.deepcopy(review))

    def get_control(self, ns: str) -> dict:
        with self._lock:
            return copy.deepcopy(self._control.get(ns, {}))

    def set_control(self, ns: str, doc: dict) -> None:
        with self._lock:
            self._control[ns] = copy.deepcopy(doc)

    def reset(self, ns: str) -> None:
        with self._lock:
            for table in (self._states, self._obs, self._reviews):
                for key in [k for k in table if k[0] == ns]:
                    del table[key]
            for key in [k for k in self._idem if k[0] == ns]:
                del self._idem[key]
            self._control.pop(ns, None)
