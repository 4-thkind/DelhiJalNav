"""DynamoDB adapter. One table, keys `PK`/`SK`, TTL attribute `cleanupAt`.

Item layout (section 8.1 of the brief):
  NS#<ns>#HOTSPOT#<id>  STATE                          versioned aggregate (attribute `revision`)
  NS#<ns>#HOTSPOT#<id>  OBS#<observedAt>#<eventId>     immutable observation
  NS#<ns>#HOTSPOT#<id>  REVIEW#<reviewedAt>#<id>       reviewer decision
  NS#<ns>#ACTOR#<src>   EVENT#<eventId>                idempotency record + payload hash
  NS#<ns>#CONTROL       CONTROL                        demo clock / failure switches

Documents are stored as one JSON string attribute (`doc`) so no float/Decimal
conversion happens anywhere. TTL is retention only; freshness is computed by
the policy from `observedAt`, never from whether a row still exists.
"""
from __future__ import annotations

import json
import os
from datetime import timedelta

from domain.policy import parse_iso
from storage.local import DuplicateEvent, RevisionConflict

RETENTION = timedelta(days=int(os.environ.get("RETENTION_DAYS", "7")))
MAX_PAGES = 20


def _hotspot_pk(ns: str, hid: str) -> str:
    return f"NS#{ns}#HOTSPOT#{hid}"


def _s(v: str) -> dict:
    return {"S": v}


def _n(v: int) -> dict:
    return {"N": str(int(v))}


def _cleanup(at_iso: str) -> int:
    return int((parse_iso(at_iso) + RETENTION).timestamp())


class DynamoStore:
    def __init__(self, table: str, client=None) -> None:
        if client is None:
            import boto3  # present in the Lambda runtime; not needed for local tests

            client = boto3.client("dynamodb")
        self.c, self.table = client, table

    # ------------------------------------------------------------- reads
    def _get(self, pk: str, sk: str) -> dict | None:
        item = self.c.get_item(TableName=self.table, Key={"PK": _s(pk), "SK": _s(sk)},
                               ConsistentRead=True).get("Item")
        return json.loads(item["doc"]["S"]) if item else None

    def _query(self, **kwargs) -> list[dict]:
        items, start = [], None
        for _ in range(MAX_PAGES):
            if start:
                kwargs["ExclusiveStartKey"] = start
            page = self.c.query(TableName=self.table, ConsistentRead=True, **kwargs)
            items += page.get("Items", [])
            start = page.get("LastEvaluatedKey")
            if not start:
                return items
        raise RuntimeError("query exceeded page bound")

    def get_state(self, ns: str, hid: str) -> dict | None:
        return self._get(_hotspot_pk(ns, hid), "STATE")

    def list_observations(self, ns: str, hid: str, since: str) -> list[dict]:
        items = self._query(
            KeyConditionExpression="PK = :pk AND SK BETWEEN :a AND :b",
            ExpressionAttributeValues={":pk": _s(_hotspot_pk(ns, hid)), ":a": _s(f"OBS#{since}"),
                                       ":b": _s("OBS#~")},
        )
        return [json.loads(i["doc"]["S"]) for i in items]

    def get_idempotency(self, ns: str, source_key: str, event_id: str) -> dict | None:
        return self._get(f"NS#{ns}#ACTOR#{source_key}", f"EVENT#{event_id}")

    def count_recent(self, ns: str, source_key: str, since: str) -> int:
        total, start = 0, None
        for _ in range(MAX_PAGES):
            kwargs = {"ExclusiveStartKey": start} if start else {}
            page = self.c.query(
                TableName=self.table, Select="COUNT",
                KeyConditionExpression="PK = :pk AND begins_with(SK, :e)",
                FilterExpression="createdAt >= :since",
                ExpressionAttributeValues={":pk": _s(f"NS#{ns}#ACTOR#{source_key}"), ":e": _s("EVENT#"),
                                           ":since": _s(since)},
                **kwargs,
            )
            total += page.get("Count", 0)
            start = page.get("LastEvaluatedKey")
            if not start:
                break
        return total

    # ------------------------------------------------------------ writes
    def commit(self, ns: str, hid: str, expected_revision: int, state: dict,
               observation: dict | None = None, idempotency: dict | None = None,
               review: dict | None = None) -> None:
        """One transaction: idempotency + observation/review + state guarded by revision."""
        pk = _hotspot_pk(ns, hid)
        items: list[dict] = []
        idem_index = state_index = None

        if idempotency:
            idem_index = len(items)
            items.append({"Put": {
                "TableName": self.table,
                "Item": {"PK": _s(f"NS#{ns}#ACTOR#{idempotency['sourceKey']}"),
                         "SK": _s(f"EVENT#{idempotency['eventId']}"),
                         "doc": _s(json.dumps(idempotency)), "createdAt": _s(idempotency["createdAt"]),
                         "cleanupAt": _n(_cleanup(idempotency["createdAt"]))},
                "ConditionExpression": "attribute_not_exists(PK)",
            }})
        if observation:
            items.append({"Put": {
                "TableName": self.table,
                "Item": {"PK": _s(pk), "SK": _s(f"OBS#{observation['observedAt']}#{observation['eventId']}"),
                         "doc": _s(json.dumps(observation)),
                         "cleanupAt": _n(_cleanup(observation["receivedAt"]))},
                "ConditionExpression": "attribute_not_exists(PK)",
            }})
        if review:
            items.append({"Put": {
                "TableName": self.table,
                "Item": {"PK": _s(pk), "SK": _s(f"REVIEW#{review['reviewedAt']}#{review['reviewId']}"),
                         "doc": _s(json.dumps(review)), "cleanupAt": _n(_cleanup(review["reviewedAt"]))},
                "ConditionExpression": "attribute_not_exists(PK)",
            }})

        state_index = len(items)
        put_state = {
            "TableName": self.table,
            # aggregate state carries no TTL: unresolved caution must not silently disappear
            "Item": {"PK": _s(pk), "SK": _s("STATE"), "revision": _n(state["revision"]),
                     "doc": _s(json.dumps(state))},
        }
        if expected_revision == 0:
            put_state["ConditionExpression"] = "attribute_not_exists(PK)"
        else:
            put_state["ConditionExpression"] = "revision = :rev"
            put_state["ExpressionAttributeValues"] = {":rev": _n(expected_revision)}
        items.append({"Put": put_state})

        try:
            self.c.transact_write_items(TransactItems=items)
        except Exception as exc:  # botocore ClientError; matched by code so boto3 is optional here
            response = getattr(exc, "response", {}) or {}
            if response.get("Error", {}).get("Code") != "TransactionCanceledException":
                raise
            reasons = [r.get("Code") for r in response.get("CancellationReasons", [])]
            failed = lambda i: i is not None and i < len(reasons) and reasons[i] == "ConditionalCheckFailed"  # noqa: E731
            if failed(idem_index):
                raise DuplicateEvent() from exc
            if failed(state_index):
                raise RevisionConflict() from exc
            raise  # throttling, validation, conflicting transaction: not a duplicate

    # ------------------------------------------------------- demo control
    def get_control(self, ns: str) -> dict:
        return self._get(f"NS#{ns}#CONTROL", "CONTROL") or {}

    def set_control(self, ns: str, doc: dict) -> None:
        self.c.put_item(TableName=self.table, Item={"PK": _s(f"NS#{ns}#CONTROL"), "SK": _s("CONTROL"),
                                                     "doc": _s(json.dumps(doc))})

    def reset(self, ns: str) -> None:
        """Demo namespaces only (the service enforces that). Small-table scan by design."""
        start = None
        for _ in range(MAX_PAGES):
            kwargs = {"ExclusiveStartKey": start} if start else {}
            page = self.c.scan(TableName=self.table, ProjectionExpression="PK, SK",
                               FilterExpression="begins_with(PK, :p)",
                               ExpressionAttributeValues={":p": _s(f"NS#{ns}#")}, **kwargs)
            for item in page.get("Items", []):
                self.c.delete_item(TableName=self.table, Key={"PK": item["PK"], "SK": item["SK"]})
            start = page.get("LastEvaluatedKey")
            if not start:
                return
