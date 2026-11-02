from menu_scraper import store


class Snapshot:
    def __init__(self, data):
        self.exists = data is not None
        self.data = data

    def to_dict(self):
        return self.data


class Document:
    def __init__(self, db, path):
        self.db, self.path = db, path

    def get(self, **kwargs):
        return Snapshot(self.db.data.get(self.path))


class Collection:
    def __init__(self, db, name):
        self.db, self.name = db, name

    def document(self, name):
        return Document(self.db, (self.name, name))


class Database:
    def __init__(self, data=None):
        self.data = data or {}

    def collection(self, name):
        return Collection(self, name)

    def transaction(self):
        return self

    def set(self, document, data):
        self.data[document.path] = data


def test_older_post_cannot_replace_newer_week_but_gets_cached(monkeypatch):
    monkeypatch.setattr(store.firestore, "transactional", lambda function: function)
    current = {"school": "HS", "source": {"postId": "102"}}
    db = Database({("cafeteriaMenus", "hs-2026-11-09"): current})
    old = {"school": "HS", "weekStart": "2026-11-09", "source": {"postId": "101"},
           "sourceHash": "older-hash", "pipelineVersion": 1}
    assert store.publish(db, old) == "superseded"
    assert db.data[("cafeteriaMenus", "hs-2026-11-09")] is current
    assert db.data[("cafeteriaMenuSources", "hs-101")]["status"] == "superseded"
    assert store.unchanged(db, "101", "older-hash", 1)


def test_hash_cache_does_not_hide_missing_week_or_pipeline_revision():
    db = Database({("cafeteriaMenuSources", "hs-101"): {
        "menuId": "hs-2026-11-09", "sourceHash": "same", "pipelineVersion": 1,
    }})
    assert not store.unchanged(db, "101", "same", 1)
    db.data[("cafeteriaMenus", "hs-2026-11-09")] = {"school": "HS"}
    assert store.unchanged(db, "101", "same", 1)
    assert not store.unchanged(db, "101", "revised", 1)
    assert not store.unchanged(db, "101", "same", 2)
