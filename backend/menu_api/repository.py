"""Private Firestore session storage with transactional menu validation."""

from datetime import date as Date, datetime, timedelta
from zoneinfo import ZoneInfo

from google.api_core import exceptions as google_errors
from google.cloud import firestore

from .engine import MEALS, QueueError, available_menu, mutate as mutate_state

MENUS = "cafeteriaMenus"
SESSIONS = "cafeteriaQueueSessions"


def _date(value: str) -> Date:
    try:
        day = Date.fromisoformat(value)
        if day.isoformat() != value:
            raise ValueError("Non-canonical date")
        return day
    except (TypeError, ValueError) as error:
        raise QueueError("invalid_date", "Use a date in YYYY-MM-DD format.", 400) from error


def _meal(value: str) -> str:
    if value not in MEALS:
        raise QueueError("invalid_meal", "Choose breakfast, lunch, or dinner.", 400)
    return value


class FirestoreQueueRepository:
    def __init__(self, db):
        self.db = db

    def _menu_ref(self, date: str):
        day = _date(date)
        monday = day - timedelta(days=day.weekday())
        return self.db.collection(MENUS).document(f"hs-{monday.isoformat()}")

    def _state_ref(self, date: str, meal: str):
        day = _date(date)
        return self.db.collection(SESSIONS).document(f"{day.isoformat()}_{_meal(meal)}")

    def get_menu(self, date: str) -> dict | None:
        document = self._menu_ref(date).get()
        return document.to_dict() if document.exists else None

    def get_state(self, date: str, meal: str) -> dict:
        document = self._state_ref(date, meal).get()
        return document.to_dict() if document.exists else {}

    def mutate(self, date: str, meal: str, uid: str, action: str,
               option: str | None, now: datetime) -> tuple[dict, dict]:
        day = _date(date)
        _meal(meal)
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("Queue timestamps must be timezone-aware datetimes")
        if day != now.astimezone(ZoneInfo("Asia/Seoul")).date():
            raise QueueError("date_not_today", "You can join only today's cafeteria queue (Asia/Seoul).", 409)
        menu_ref = self._menu_ref(date)
        state_ref = self._state_ref(date, meal)

        @firestore.transactional
        def commit(transaction):
            # Both reads must happen before the write. A transaction retry reads
            # current menu availability and sequence counters again.
            menu_document = menu_ref.get(transaction=transaction)
            state_document = state_ref.get(transaction=transaction)
            menu = menu_document.to_dict() if menu_document.exists else None
            current = state_document.to_dict() if state_document.exists else {}
            metadata = available_menu(menu, date, meal)
            allowed = [item["id"] for item in metadata["options"]]
            updated = mutate_state(current, uid, action, now, allowed, option)
            if updated != current and (current or updated["choices"]):
                updated = {**updated, "date": date, "meal": meal}
                transaction.set(state_ref, updated)
            return updated, metadata

        try:
            return commit(self.db.transaction())
        except (google_errors.Aborted, google_errors.DeadlineExceeded,
                google_errors.ResourceExhausted, google_errors.ServiceUnavailable) as error:
            raise QueueError("queue_busy", "The queue is busy. Please try again.", 503) from error
