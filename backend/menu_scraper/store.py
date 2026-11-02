"""Atomic publication and content-hash caching in the existing Firestore project."""

import json

from google.cloud import firestore

MENUS = "cafeteriaMenus"
SOURCES = "cafeteriaMenuSources"


def unchanged(db, post_id: str, digest: str, version: int) -> bool:
    snapshot = db.collection(SOURCES).document(f"hs-{post_id}").get()
    data = snapshot.to_dict() if snapshot.exists else {}
    if data.get("sourceHash") != digest or data.get("pipelineVersion") != version:
        return False
    menu_id = data.get("menuId")
    return bool(menu_id and db.collection(MENUS).document(menu_id).get().exists)


def publish(db, menu: dict) -> str:
    if menu.get("school") != "HS":
        raise ValueError("Only HS menus may be published")
    if len(json.dumps(menu, ensure_ascii=False).encode()) > 850_000:
        raise ValueError("Menu is too large for one Firestore document")
    menu_id = f"hs-{menu['weekStart']}"
    document = db.collection(MENUS).document(menu_id)
    source = db.collection(SOURCES).document(f"hs-{menu['source']['postId']}")

    @firestore.transactional
    def commit(transaction):
        existing = document.get(transaction=transaction)
        current = existing.to_dict() if existing.exists else {}
        marker = {
            "school": "HS", "menuId": menu_id,
            "sourceHash": menu["sourceHash"], "pipelineVersion": menu["pipelineVersion"],
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        # An older archive post must never replace a newer revision of the same week.
        if int(current.get("source", {}).get("postId", 0)) > int(menu["source"]["postId"]):
            transaction.set(source, {**marker, "status": "superseded"})
            return "superseded"
        transaction.set(document, {**menu, "updatedAt": firestore.SERVER_TIMESTAMP})
        transaction.set(source, {**marker, "status": "published"})
        return "published"

    return commit(db.transaction())
