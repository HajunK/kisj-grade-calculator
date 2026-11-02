import argparse
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import sys

import firebase_admin
from firebase_admin import firestore
import pytesseract

from . import PIPELINE_VERSION
from .ocr import combine, read_page
from .source import discover, fetch, parse_post, render, session, source_hash
from .store import publish, unchanged

LOGGER = logging.getLogger("menu_scraper")


def run(*, output: Path, limit: int = 3, db=None, force: bool = False) -> dict:
    available = set(pytesseract.get_languages(config=""))
    if not {"eng", "kor"} <= available:
        raise RuntimeError("Tesseract requires eng and kor language packs (or set TESSDATA_PREFIX)")
    output.mkdir(parents=True, exist_ok=True)
    counts = {"published": 0, "exported": 0, "unchanged": 0, "superseded": 0, "failed": 0}
    with session() as client:
        posts = discover(client, limit)
        for candidate in posts:
            try:
                post, urls = parse_post(fetch(client, candidate.url).decode("utf-8"), candidate)
                assets = [(url, fetch(client, url)) for url in urls]
                digest = source_hash(assets)
                if db is not None and not force and unchanged(db, post.uid, digest, PIPELINE_VERSION):
                    counts["unchanged"] += 1
                    LOGGER.info("HS post %s unchanged", post.uid)
                    continue
                pages, metadata = [], []
                for asset_index, (url, data) in enumerate(assets):
                    suffix = ".pdf" if data.startswith(b"%PDF-") else ".image"
                    (output / f"hs-{post.uid}-{asset_index}{suffix}").write_bytes(data)
                    for page_index, image in enumerate(render(data)):
                        page = read_page(image)
                        pages.append(page)
                        metadata.append({"url": url, "page": page_index + 1, "language": page["language"],
                                         "sha256": hashlib.sha256(data).hexdigest()})
                menu = {
                    **combine(pages), "schemaVersion": 1, "pipelineVersion": PIPELINE_VERSION,
                    "sourceHash": digest,
                    "source": {"postId": post.uid, "title": post.title, "url": post.url,
                               "publishedAt": post.published_at, "attachments": metadata},
                    "ocr": {"engine": "tesseract", "version": str(pytesseract.get_tesseract_version()),
                            "generatedAt": datetime.now(timezone.utc).isoformat(),
                            "reviewed": False},
                }
                path = output / f"hs-{menu['weekStart']}-post-{post.uid}.json"
                temporary = path.with_suffix(".json.tmp")
                temporary.write_text(json.dumps(menu, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                temporary.replace(path)
                status = publish(db, menu) if db is not None else "exported"
                counts[status] += 1
                LOGGER.info("HS post %s: %s week %s (%s)", post.uid, status, menu["weekStart"], menu["languages"])
            except Exception:
                counts["failed"] += 1
                LOGGER.exception("HS post %s failed; existing Firestore menu retained", candidate.uid)
    LOGGER.info("Result: %s", counts)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape only HS menu PDFs/images into JSON and Firestore")
    parser.add_argument("--dry-run", action="store_true", help="Export JSON without reading or writing Firebase")
    parser.add_argument("--force", action="store_true", help="Re-run OCR even when the source hash is unchanged")
    parser.add_argument("--limit", type=int, default=3, help="Number of recent HS posts, including future weeks (1-10)")
    parser.add_argument("--output", type=Path, default=Path("var/menus"), help="Local PDF/image and JSON archive directory")
    parser.add_argument("--project", default=os.getenv("FIREBASE_PROJECT_ID", "kisj-grade-calculator"))
    args = parser.parse_args()
    if not 1 <= args.limit <= 10:
        parser.error("--limit must be between 1 and 10")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = None
    if not args.dry_run:
        # Reads GOOGLE_APPLICATION_CREDENTIALS or workload identity; never uses browser config keys.
        app = firebase_admin.initialize_app(options={"projectId": args.project})
        db = firestore.client(app)
    try:
        counts = run(output=args.output, limit=args.limit, db=db, force=args.force)
        return 1 if counts["failed"] else 0
    finally:
        if db is not None:
            db.close()
            firebase_admin.delete_app(app)


if __name__ == "__main__":
    sys.exit(main())
