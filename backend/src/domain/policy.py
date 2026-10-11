"""Evidence policy `flood-policy-v1`: observations -> hazard state.

Pure functions, injected clock, no I/O. Every number here is a configurable
prototype policy, not a hydrological claim. See section 7 of the brief.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

POLICY_VERSION = "flood-policy-v1"

POSITIVE = frozenset({"WATER_OBSERVED", "ROAD_BLOCKED_REPORTED"})
NEGATIVE = frozenset({"NO_WATER_OBSERVED"})
KINDS = POSITIVE | NEGATIVE | {"UNSURE"}

#: States that keep an underpass out of every route for the prototype.
RESTRICTING = frozenset({"REPORTED", "CORROBORATED", "CONFLICTED", "STALE"})


@dataclass(frozen=True)
class Policy:
    freshness: timedelta = timedelta(minutes=30)
    future_tolerance: timedelta = timedelta(minutes=2)


def parse_iso(value: str) -> datetime:
    """ISO 8601 with an explicit UTC offset or Z. Naive times are rejected."""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timestamp must include a UTC offset")
    return dt.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _at(obs: dict) -> datetime:
    return parse_iso(obs["observedAt"])


def evaluate(
    observations: list[dict],
    now: datetime,
    policy: Policy = Policy(),
    last_known_positive_at: str | None = None,
    clear_review: dict | None = None,
) -> dict:
    """Deterministic hazard state for one hotspot at `now`.

    observations: accepted observations ({eventId, sourceKey, kind, observedAt, withdrawn?}).
    last_known_positive_at: carried on the stored state so aged-out rows cannot erase caution.
    clear_review: the latest accepted reviewer clear decision ({reviewedAt, ...}) if any.
    """
    horizon = now + policy.future_tolerance
    usable = [o for o in observations if not o.get("withdrawn") and _at(o) <= horizon]

    lkp = parse_iso(last_known_positive_at) if last_known_positive_at else None
    for o in usable:
        if o["kind"] in POSITIVE and (lkp is None or _at(o) > lkp):
            lkp = _at(o)

    cutoff = parse_iso(clear_review["reviewedAt"]) if clear_review else None
    window_start = now - policy.freshness

    # one effective contribution per source: its latest fresh, decisive report
    latest: dict[str, dict] = {}
    for o in sorted(usable, key=_at):
        if _at(o) <= window_start or o["kind"] not in POSITIVE | NEGATIVE:
            continue
        if cutoff is not None and _at(o) <= cutoff:
            continue
        latest[o["sourceKey"]] = o

    positives = [o for o in latest.values() if o["kind"] in POSITIVE]
    negatives = [o for o in latest.values() if o["kind"] in NEGATIVE]

    if positives:
        first_positive = min(_at(o) for o in positives)
        conflicting = [o for o in negatives if _at(o) > first_positive]
        if conflicting:
            state, reason = "CONFLICTED", "NEGATIVE_AFTER_POSITIVE"
        elif len(positives) >= 2:
            state, reason = "CORROBORATED", "DISTINCT_SOURCES_AGREE"
        else:
            state, reason = "REPORTED", "SINGLE_FRESH_REPORT"
        effective = positives + conflicting
        next_at = min(_at(o) for o in effective) + policy.freshness
    elif cutoff is not None and now < cutoff + policy.freshness:
        state, reason, effective = "RECENTLY_CLEAR_REPORTED", "REVIEWED_CLEAR", []
        next_at = cutoff + policy.freshness
    elif lkp is not None and (cutoff is None or lkp > cutoff):
        # absence of fresh reports is not clearance
        state, reason, effective, next_at = "STALE", "POSITIVE_AGED_OUT_UNRESOLVED", [], None
    else:
        state, reason, effective, next_at = "UNKNOWN", "NO_FRESH_EVIDENCE", negatives, None
        if negatives:
            next_at = min(_at(o) for o in negatives) + policy.freshness

    latest_at = max((_at(o) for o in usable), default=None)
    return {
        "state": state,
        "reasonCode": reason,
        "restricts": state in RESTRICTING,
        "policyVersion": POLICY_VERSION,
        "evaluatedAt": iso(now),
        "freshSources": {"positive": len(positives), "negative": len(negatives)},
        "effectiveObservationIds": sorted(o["eventId"] for o in effective),
        "lastKnownPositiveAt": iso(lkp) if lkp else None,
        "latestObservationAt": iso(latest_at) if latest_at else None,
        "clearReviewedAt": iso(cutoff) if cutoff else None,
        "nextTransitionAt": iso(next_at) if next_at else None,
    }


def check_clear_review(
    cited_ids: list[str],
    observations: list[dict],
    now: datetime,
    policy: Policy = Policy(),
    last_known_positive_at: str | None = None,
) -> str | None:
    """Return an error code, or None when a reviewer may record a clear decision.

    P0 rule: at least two newer, fresh NO_WATER_OBSERVED reports from distinct
    sources, and no positive report after the earliest cited one.
    """
    by_id = {o["eventId"]: o for o in observations if not o.get("withdrawn")}
    cited = [by_id.get(i) for i in dict.fromkeys(cited_ids)]
    if len(cited) < 2 or any(o is None for o in cited):
        return "REVIEW_NEEDS_TWO_KNOWN_OBSERVATIONS"
    if any(o["kind"] not in NEGATIVE for o in cited):
        return "REVIEW_CITES_NON_NEGATIVE"
    if len({o["sourceKey"] for o in cited}) < 2:
        return "REVIEW_NEEDS_DISTINCT_SOURCES"
    if any(_at(o) <= now - policy.freshness for o in cited):
        return "REVIEW_CITES_STALE_OBSERVATION"
    earliest = min(_at(o) for o in cited)
    if last_known_positive_at and earliest <= parse_iso(last_known_positive_at):
        return "REVIEW_OLDER_THAN_POSITIVE"
    if any(o["kind"] in POSITIVE and _at(o) > earliest for o in by_id.values()):
        return "POSITIVE_AFTER_CITED_NEGATIVE"
    return None
