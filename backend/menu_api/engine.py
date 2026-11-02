"""Pure state transitions for a bounded, self-reported cafeteria queue.

These positions describe the virtual queue only. No sensor measures the physical
line, and the configurable service time is an estimate rather than a calibration.
"""

from collections.abc import Iterable
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

OPTIONS = ("A", "B")
MEALS = ("breakfast", "lunch", "dinner")
QUEUE_TTL = timedelta(minutes=45)
MAX_CHOICES = 800
MAX_STATE_BYTES = 700_000
_STATUSES = {"queued", "left", "served", "expired"}
_CHOICE_FIELDS = {"option", "status", "sequence", "joinedAt", "expiresAt"}


class QueueError(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Queue timestamps must be timezone-aware datetimes")
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _time(value) -> datetime:
    try:
        if not isinstance(value, str):
            raise ValueError("Stored timestamps must be ISO strings")
        return _utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except (TypeError, ValueError) as error:
        raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503) from error


def _capacity(state: dict) -> None:
    try:
        size = len(json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError) as error:
        raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503) from error
    if size >= MAX_STATE_BYTES or len(state.get("choices", {})) > MAX_CHOICES:
        raise QueueError("queue_capacity", "The cafeteria queue is at capacity. Please try again later.", 503)


def _state(value: dict | None) -> dict:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503)
    result = deepcopy(value)
    result.setdefault("choices", {})
    result.setdefault("nextSequence", {option: 0 for option in OPTIONS})
    if not isinstance(result["choices"], dict) or not isinstance(result["nextSequence"], dict):
        raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503)
    _capacity(result)
    seen = {option: set() for option in OPTIONS}
    for uid, choice in result["choices"].items():
        if (not isinstance(uid, str) or not uid or len(uid) > 128
                or not isinstance(choice, dict) or set(choice) - _CHOICE_FIELDS
                or choice.get("option") not in OPTIONS or choice.get("status") not in _STATUSES
                or not isinstance(choice.get("sequence"), int) or isinstance(choice["sequence"], bool)
                or choice["sequence"] < 0):
            raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503)
        joined, expires = _time(choice.get("joinedAt")), _time(choice.get("expiresAt"))
        if expires <= joined or choice["sequence"] in seen[choice["option"]]:
            raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503)
        seen[choice["option"]].add(choice["sequence"])
    for option in OPTIONS:
        sequence = result["nextSequence"].get(option, 0)
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
            raise QueueError("queue_state_invalid", "The queue is temporarily unavailable.", 503)
        result["nextSequence"][option] = sequence
    return result


def _allowed(value: Iterable[str]) -> set[str]:
    result = set(value)
    if not result <= set(OPTIONS):
        raise ValueError("Only A/B cafeteria options are supported")
    return result


def _active(choice: dict, now: datetime, allowed: set[str]) -> bool:
    return (choice["status"] == "queued" and choice["option"] in allowed
            and _time(choice["expiresAt"]) > now)


def available_menu(menu: dict | None, date: str, meal: str) -> dict:
    """Extract authoritative printed A/B options without interpreting OCR lines."""
    result = {"menuAvailable": False, "source": None, "options": [], "closure": None}
    if meal not in MEALS:
        raise ValueError("Unsupported meal")
    if not menu or menu.get("school") != "HS":
        return result
    if not (menu.get("weekStart", "~") <= date <= menu.get("weekEnd", "")):
        return result
    matching = [day for day in menu.get("days", []) if day.get("date") == date]
    if len(matching) != 1:
        return result
    result["menuAvailable"] = True
    result["source"] = {**deepcopy(menu.get("source") or {}),
                        "weekStart": menu["weekStart"], "weekEnd": menu["weekEnd"]}
    translations = matching[0].get("meals", {}).get(meal, {})
    closure = {}
    for language in ("ko", "en"):
        for row in translations.get(language, []):
            if row.get("status") == "closed":
                closure[language] = deepcopy(row.get("closure") or {"text": row.get("text", "")})
    if closure:
        first = next(iter(closure.values()))
        result["closure"] = {"text": first.get("text", "Cafeteria closed"), "evidence": closure}
        return result
    for option in OPTIONS:
        translated = {"ko": None, "en": None}
        for language in translated:
            rows = []
            for row in translations.get(language, []):
                if row.get("section") != option or row.get("status") != "printed":
                    continue
                value = row.get("text", "")
                value = value.strip() if isinstance(value, str) else ""
                lines = [line.strip() for line in row.get("lines", [])
                         if isinstance(line, str) and line.strip()]
                if lines:
                    rows.append({"text": value, "lines": lines, "status": "printed"})
            if len(rows) > 1:
                # Ambiguous duplicated sections are never presented as a valid choice.
                raise QueueError("menu_invalid", "The published menu needs review before joining.", 503)
            if rows:
                translated[language] = rows[0]
        if any(translated.values()):
            result["options"].append({"id": option, "menu": translated})
    return result


def mutate(state: dict | None, uid: str, action: str, now: datetime,
           allowed_options: Iterable[str], option: str | None = None) -> dict:
    """Return a new state, preserving a saved choice when leaving or being served."""
    now = _utc(now)
    allowed = _allowed(allowed_options)
    result = _state(state)
    if not isinstance(uid, str) or not uid or len(uid) > 128:
        raise ValueError("A verified Firebase UID is required")
    if action not in {"choose", "leave", "served"}:
        raise QueueError("invalid_action", "Unsupported queue action.", 400)
    choices = result["choices"]
    existing = choices.get(uid)
    if action == "choose":
        if existing and existing["status"] == "served":
            raise QueueError("already_served", "You have already marked yourself served for this meal.", 409)
        if not allowed:
            raise QueueError("menu_unavailable", "No cafeteria choices are available for this meal.", 409)
        if option not in allowed:
            raise QueueError("option_unavailable", "That cafeteria option is unavailable for this meal.", 409)
        if existing and existing["option"] == option and _active(existing, now, allowed):
            return result
        if uid not in choices and len(choices) >= MAX_CHOICES:
            raise QueueError("queue_capacity", "The cafeteria queue is at capacity. Please try again later.", 503)
        issued = [record["sequence"] for record in choices.values() if record["option"] == option]
        sequence = max(result["nextSequence"][option], max(issued, default=-1) + 1)
        result["nextSequence"][option] = sequence + 1
        choices[uid] = {"option": option, "status": "queued", "sequence": sequence,
                        "joinedAt": _iso(now), "expiresAt": _iso(now + QUEUE_TTL)}
    elif action == "leave":
        if existing is None or existing["status"] in {"left", "served"}:
            return result
        existing["status"] = "left"
    else:
        if existing and existing["status"] == "served":
            return result
        if existing is None or not _active(existing, now, allowed):
            raise QueueError("not_queued", "Join an available line before marking yourself served.", 409)
        existing["status"] = "served"
    result["updatedAt"] = _iso(now)
    _capacity(result)
    return result


def snapshot(state: dict | None, uid: str, now: datetime, allowed_options: Iterable[str],
             service_seconds: int = 20) -> dict:
    """Derive all public aggregates and only the requesting user's private state."""
    now = _utc(now)
    allowed = _allowed(allowed_options)
    if not isinstance(service_seconds, int) or isinstance(service_seconds, bool) or service_seconds <= 0:
        raise ValueError("service_seconds must be a positive integer")
    state = _state(state)
    choices = state["choices"]
    choice_counts = {option: 0 for option in OPTIONS}
    active = {option: [] for option in OPTIONS}
    for record in choices.values():
        choice_counts[record["option"]] += 1
        if _active(record, now, allowed):
            active[record["option"]].append(record)
    queue_counts = {option: len(active[option]) for option in OPTIONS}
    mine = deepcopy(choices.get(uid))
    if mine:
        mine["position"] = None
        mine["estimatedWaitSeconds"] = None
        if _active(mine, now, allowed):
            mine["position"] = 1 + sum(record["sequence"] < mine["sequence"] for record in active[mine["option"]])
            mine["estimatedWaitSeconds"] = (mine["position"] - 1) * service_seconds
        elif mine["status"] == "queued":
            mine["status"] = "expired" if _time(mine["expiresAt"]) <= now else "unavailable"
    return {
        "choiceCounts": choice_counts, "queueCounts": queue_counts,
        "prospectiveWaitSeconds": {option: queue_counts[option] * service_seconds for option in OPTIONS},
        "myChoice": mine, "serviceSeconds": service_seconds,
    }
