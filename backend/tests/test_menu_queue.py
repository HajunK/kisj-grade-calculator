from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

import pytest

from menu_api.engine import MAX_STATE_BYTES, QueueError, available_menu, mutate, snapshot
import menu_api.repository as repository

NOW = datetime(2026, 11, 9, 3, 0, tzinfo=timezone.utc)
DATE = "2026-11-09"


def menu():
    return {"school": "HS", "weekStart": DATE, "weekEnd": "2026-11-15",
            "source": {"postId": "5154"}, "days": [{"date": DATE, "meals": {
                "lunch": {"ko": [{"section": "A", "text": "쌀밥", "lines": ["쌀밥"], "status": "printed"}],
                          "en": [{"section": "A", "text": "White Rice", "lines": ["White Rice"], "status": "printed"},
                                 {"section": "B", "text": "Noodles", "lines": ["Noodles"], "status": "printed"}]}}}]}


def choose(state, uid, option="A", now=NOW):
    return mutate(state, uid, "choose", now, ["A", "B"], option)


def test_menu_preserves_translations_and_requires_actual_printed_food():
    document = menu()
    document["days"][0]["meals"]["lunch"]["en"].append(
        {"section": "vegan", "text": "Veggies", "lines": ["Veggies"], "status": "printed"})
    result = available_menu(document, DATE, "lunch")
    assert [item["id"] for item in result["options"]] == ["A", "B"]
    assert result["options"][0]["menu"]["ko"] == {"text": "쌀밥", "lines": ["쌀밥"], "status": "printed"}
    assert result["options"][1]["menu"]["ko"] is None
    for language in ("ko", "en"):
        for row in document["days"][0]["meals"]["lunch"][language]:
            row["status"] = "placeholder"
    blank = available_menu(document, DATE, "lunch")
    assert blank["menuAvailable"] is True
    assert blank["options"] == []
    assert blank["closure"] is None


def test_explicit_closure_in_either_translation_disables_choices():
    document = menu()
    document["days"][0]["meals"]["lunch"]["ko"] = [
        {"section": "closure", "status": "closed", "closure": {"text": "CAFETERIA CLOSED"}}]
    result = available_menu(document, DATE, "lunch")
    assert result["menuAvailable"] is True
    assert result["options"] == []
    assert result["closure"]["text"] == "CAFETERIA CLOSED"
    assert not available_menu(menu(), "2026-11-16", "lunch")["menuAvailable"]
    assert not available_menu(None, DATE, "lunch")["menuAvailable"]


def test_published_blank_closed_and_missing_dates_are_distinct():
    document = menu()
    blank = available_menu(document, DATE, "breakfast")
    assert blank["menuAvailable"] is True
    assert blank["options"] == []
    assert blank["closure"] is None
    assert blank["source"] == {"postId": "5154", "weekStart": DATE, "weekEnd": "2026-11-15"}
    # A published week with no matching day must not leak a misleading source.
    missing = available_menu(document, "2026-11-10", "lunch")
    assert missing == {"menuAvailable": False, "source": None, "options": [], "closure": None}
    assert available_menu(document, "2026-11-16", "lunch")["source"] is None


def test_text_without_usable_printed_lines_never_creates_a_choice():
    document = menu()
    for language in ("ko", "en"):
        for row in document["days"][0]["meals"]["lunch"][language]:
            row["lines"] = ["   ", ""]
    result = available_menu(document, DATE, "lunch")
    assert result["menuAvailable"] is True
    assert result["options"] == []
    assert result["closure"] is None


def test_choice_joins_once_and_repeat_preserves_sequence_and_expiry():
    first = choose({}, "me")
    second = choose(first, "me", now=NOW + timedelta(minutes=10))
    assert second == first
    view = snapshot(second, "me", NOW, ["A", "B"])
    assert view["choiceCounts"] == {"A": 1, "B": 0}
    assert view["queueCounts"] == {"A": 1, "B": 0}
    assert view["myChoice"]["position"] == 1
    assert view["myChoice"]["estimatedWaitSeconds"] == 0
    assert "choices" not in view
    assert json.loads(json.dumps(first)) == first


def test_switching_lines_updates_one_preference_and_joins_back_of_new_line():
    state = choose({}, "ahead", "B")
    state = choose(state, "me", "A")
    state = choose(state, "me", "B", NOW + timedelta(seconds=5))
    view = snapshot(state, "me", NOW + timedelta(seconds=5), ["A", "B"], 20)
    assert view["choiceCounts"] == {"A": 0, "B": 2}
    assert view["queueCounts"] == {"A": 0, "B": 2}
    assert view["myChoice"]["position"] == 2
    assert view["myChoice"]["estimatedWaitSeconds"] == 20
    assert view["prospectiveWaitSeconds"]["B"] == 40


def test_expiration_is_computed_without_writes_and_rejoin_does_not_double_count():
    state = choose({}, "me")
    original = deepcopy(state)
    expired = snapshot(state, "me", NOW + timedelta(minutes=45), ["A", "B"])
    assert state == original
    assert expired["myChoice"]["status"] == "expired"
    assert expired["choiceCounts"]["A"] == 1
    assert expired["queueCounts"]["A"] == 0
    rejoined = choose(state, "me", now=NOW + timedelta(minutes=46))
    assert rejoined["choices"]["me"]["sequence"] > original["choices"]["me"]["sequence"]
    assert snapshot(rejoined, "me", NOW + timedelta(minutes=46), ["A", "B"])["choiceCounts"]["A"] == 1


def test_leave_preserves_preference_and_rejoining_goes_behind_other_people():
    original = choose({}, "me")
    left = mutate(original, "me", "leave", NOW, ["A", "B"])
    assert original["choices"]["me"]["status"] == "queued"
    state = choose(left, "other")
    state = choose(state, "me", now=NOW + timedelta(seconds=10))
    view = snapshot(state, "me", NOW + timedelta(seconds=10), ["A", "B"])
    assert view["choiceCounts"]["A"] == 2
    assert view["myChoice"]["position"] == 2


def test_served_is_idempotent_and_cannot_be_undone_through_leave_or_choose():
    state = choose({}, "me")
    served = mutate(state, "me", "served", NOW, ["A", "B"])
    assert mutate(served, "me", "served", NOW, ["A", "B"]) == served
    assert mutate(served, "me", "leave", NOW, ["A", "B"]) == served
    with pytest.raises(QueueError) as error:
        choose(served, "me", "B")
    assert error.value.code == "already_served"
    assert error.value.status == 409
    view = snapshot(served, "me", NOW, ["A", "B"])
    assert view["choiceCounts"]["A"] == 1
    assert view["queueCounts"]["A"] == 0


def test_removed_options_and_elapsed_people_are_excluded_from_positions():
    state = choose({}, "expired")
    state = choose(state, "ahead", now=NOW + timedelta(minutes=20))
    state = choose(state, "me", now=NOW + timedelta(minutes=21))
    view = snapshot(state, "me", NOW + timedelta(minutes=45), ["A", "B"])
    assert view["myChoice"]["position"] == 2
    removed = snapshot(state, "me", NOW + timedelta(minutes=45), ["B"])
    assert removed["choiceCounts"]["A"] == 3
    assert removed["queueCounts"]["A"] == 0
    assert removed["myChoice"]["status"] == "unavailable"
    assert removed["myChoice"]["position"] is None
    with pytest.raises(QueueError) as error:
        mutate(state, "me", "choose", NOW, ["A"], "B")
    assert error.value.code == "option_unavailable"


def test_capacity_limits_admit_existing_users_but_never_a_801st_choice():
    choice = choose({}, "template")["choices"]["template"]
    state = {"choices": {f"u-{index}": {**choice, "sequence": index, "status": "left"}
                         for index in range(800)}, "nextSequence": {"A": 800, "B": 0}}
    with pytest.raises(QueueError) as error:
        choose(state, "new-user")
    assert error.value.code == "queue_capacity"
    assert error.value.status == 503
    assert len(choose(state, "u-0")["choices"]) == 800
    with pytest.raises(QueueError) as error:
        choose({"updatedAt": "x" * MAX_STATE_BYTES}, "new-user")
    assert error.value.status == 503


def test_snapshot_reveals_no_other_user_ids_and_mutation_changes_only_caller():
    state = choose({}, "private-other-uid")
    before = deepcopy(state)
    state = choose(state, "me", "B")
    assert state["choices"]["private-other-uid"] == before["choices"]["private-other-uid"]
    assert "private-other-uid" not in json.dumps(snapshot(state, "me", NOW, ["A", "B"]))


class Conflict(Exception):
    pass


class FakeDocument:
    def __init__(self, db, path):
        self.db, self.path = db, path

    def get(self, transaction=None):
        if transaction is not None:
            assert not transaction.pending, "All Firestore reads must precede writes"
            transaction.reads.append(self.path)
        value = deepcopy(self.db.documents.get(self.path))
        return type("Document", (), {"exists": value is not None,
                                     "to_dict": lambda self: deepcopy(value)})()


class FakeTransaction:
    def __init__(self, db):
        self.db, self.reads, self.pending = db, [], []

    def set(self, document, value):
        assert len(self.reads) == 2
        assert self.reads[0].startswith("cafeteriaMenus/")
        assert self.reads[1].startswith("cafeteriaQueueSessions/")
        self.pending.append((document.path, deepcopy(value)))


class FakeDB:
    def __init__(self):
        self.documents = {f"cafeteriaMenus/hs-{DATE}": menu()}
        self.conflict_once = None
        self.attempts = 0

    def collection(self, name):
        db = self
        return type("Collection", (), {"document": lambda self, key: FakeDocument(db, name + "/" + key)})()

    def transaction(self):
        return FakeTransaction(self)


@pytest.fixture
def transaction_db(monkeypatch):
    def transactional(callback):
        def apply(transaction):
            db = transaction.db
            for _ in range(3):
                db.attempts += 1
                current = FakeTransaction(db)
                result = callback(current)
                if db.conflict_once:
                    inject = db.conflict_once
                    db.conflict_once = None
                    inject(db)
                    continue
                for path, value in current.pending:
                    db.documents[path] = deepcopy(value)
                return result
            raise Conflict
        return apply

    monkeypatch.setattr(repository.firestore, "transactional", transactional)
    return FakeDB()


def test_transaction_retries_from_current_state_and_preserves_both_joiners(transaction_db):
    db = transaction_db
    session_path = f"cafeteriaQueueSessions/{DATE}_lunch"
    db.conflict_once = lambda database: database.documents.update({session_path: choose({}, "concurrent")})
    repo = repository.FirestoreQueueRepository(db)
    state, metadata = repo.mutate(DATE, "lunch", "me", "choose", "A", NOW)
    assert db.attempts == 2
    assert set(state["choices"]) == {"concurrent", "me"}
    assert metadata["menuAvailable"] is True
    assert snapshot(state, "me", NOW, ["A", "B"])["myChoice"]["position"] == 2
    assert repo.get_state(DATE, "lunch") == state
    assert repo.get_menu("2026-11-15")["source"]["postId"] == "5154"


def test_transaction_rechecks_menu_after_conflict_before_accepting_choice(transaction_db):
    db = transaction_db
    db.conflict_once = lambda database: database.documents.clear()
    repo = repository.FirestoreQueueRepository(db)
    with pytest.raises(QueueError) as error:
        repo.mutate(DATE, "lunch", "me", "choose", "A", NOW)
    assert error.value.code == "menu_unavailable"
    assert f"cafeteriaQueueSessions/{DATE}_lunch" not in db.documents


def test_repository_forbids_writes_outside_today_in_seoul(transaction_db):
    repo = repository.FirestoreQueueRepository(transaction_db)
    before_seoul_midnight = datetime(2026, 11, 8, 14, 59, tzinfo=timezone.utc)
    with pytest.raises(QueueError) as error:
        repo.mutate(DATE, "lunch", "me", "choose", "A", before_seoul_midnight)
    assert error.value.code == "date_not_today"
    assert transaction_db.attempts == 0
