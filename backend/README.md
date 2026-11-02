# HS cafeteria menu ingestion

This is a scheduled job, with no HTTP server or inbound port. The existing
frontend uses Firebase Hosting, Authentication and Firestore. No custom backend
was found in the repository or live Cloud Functions inventory; Cloud Run was disabled.

## Pipeline

1. Read the [KIS Jeju cafeteria board](https://kis.ac/cafeteria-menus/) with its HS filter.
2. Independently require `[HS]` in both the list entry and the opened post.
3. Prefer downloadable PDFs. Otherwise download only images inside the post's
   content, excluding site logos and navigation. The November 9-15, 2026 post
   provides Korean and English PNGs, rather than a PDF.
4. Render PDFs locally and OCR with Tesseract's Korean and English language packs.
   Detect the printed dates, date-column boundaries, meal dividers and option labels.
5. Merge languages by date, preserve A/B, vegan, special and shared sections,
   and write an archived JSON file.
6. Atomically publish the week plus its source-hash cache to Firestore. Identical
   attachments skip OCR on subsequent runs. A changed attachment at the same URL
   is processed again. An older post cannot overwrite a newer post for the same week.

Failures return a nonzero exit code and retain existing Firebase data. The job
continues processing other HS posts so one bad attachment does not block all updates.
Unknown layouts and inconsistent week dates require a reviewed adapter before publishing.

## Local use

Python 3.12 and the `tesseract` executable are required. On Ubuntu, install the OCR
engine and language data with:

```sh
sudo apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor
```

From the repository root:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r backend/requirements.txt pytest
PYTHONPATH=backend .venv/bin/python -m menu_scraper --dry-run --limit 3 --output backend/var/menus
.venv/bin/python -m pytest -q
```

`uv` creates an isolated Python environment and installs the pinned dependencies.
`PYTHONPATH=backend` makes the scraper module importable from the repository root.
`--dry-run` downloads and OCRs real menus but never accesses Firebase. `--limit 3`
checks the three newest HS posts, so a future menu does not hide the previous week.
`--output` selects the local archive folder. All files under `backend/var/` are ignored by git.

If Korean data is installed outside Tesseract's default location, set
`TESSDATA_PREFIX` to the directory containing `eng.traineddata` and `kor.traineddata`.

To publish, provide a server credential outside the repository:

```sh
export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/firebase.json
PYTHONPATH=backend .venv/bin/python -m menu_scraper --output backend/var/menus
```

The browser's Firebase configuration is public project identification and cannot
authorize server writes. The job uses the Firebase Admin SDK and server IAM instead.
The deployed credential uses the project's existing Firebase Admin SDK service
account. Keep its JSON root-protected, mount it read-only, and never copy it into
the source tree, image build context, vault, logs or git. `--force` bypasses the
content-hash cache when a deliberate OCR re-run is needed.

## Firestore and JSON

Firebase project: `kisj-grade-calculator`.

| Path | Purpose | Client access |
|---|---|---|
| `cafeteriaMenus/hs-YYYY-MM-DD` | A week, identified by its printed Monday | Public read, no client writes |
| `cafeteriaMenuSources/hs-POST_ID` | Attachment hash, pipeline version, publication status | Server only |

Each menu document contains:

```json
{
  "schemaVersion": 1,
  "pipelineVersion": 1,
  "school": "HS",
  "weekStart": "2026-11-09",
  "weekEnd": "2026-11-15",
  "languages": ["ko", "en"],
  "days": [{
    "date": "2026-11-09",
    "meals": {
      "breakfast": {
        "en": [{"section": "A", "text": "", "lines": [], "status": "blank"}]
      }
    }
  }],
  "sharedSections": {},
  "notes": {},
  "source": {},
  "sourceHash": "sha256 digest",
  "ocr": {"engine": "tesseract", "reviewed": false}
}
```

The abbreviated example omits the other six dates and meal/language entries.
`text` preserves OCR text, including printed allergen codes; `lines` are OCR lines,
not a guaranteed one-dish-per-line list. Wrapped names remain wrapped. Shared
Always/Plus Bar rows stay separate because some span several dates. A blank cell
means the source was blank; it is not a claim that the cafeteria is closed.
An explicit merged closure notice is recorded as `status: "closed"`, with the
OCR evidence under `closure`. Shared sections list any `excludedDates` from that
notice. Decorative closure graphics are excluded from food text.
OCR output is marked unreviewed. Source URLs and attachment SHA-256 hashes allow
checking the original. Choose menus by the date range, since the newest post can
be for a future week. No future menu is relabeled as the current week.

## Safe rules deployment

The live project has rules newer than this repository. This command fetches the
current live rules and adds only the two menu collections, preserving all existing
access controls. It uses the current `gcloud` login, which stores no token in the repo.

```sh
.venv/bin/python backend/deploy/publish_rules.py
.venv/bin/python backend/deploy/publish_rules.py --apply
```

The first command compiles the proposed rules and runs 30 access-control tests
for anonymous users, students and admins. `--apply` additionally activates them,
after saving the previous ruleset to `/tmp/kisj-menu-rules-backup.json` and checking
that another deploy has not changed the live rules during validation. Review and
reconcile newer live rules before using a full `firebase deploy` from this checkout.

## Oracle deployment

`Dockerfile` includes Tesseract and both language packs. The Ubuntu install script
uses Podman, which runs containers without a persistent Docker daemon. The job
uses the host network for outbound HTTPS and publishes no ports; it creates no
container bridge or host firewall rules. Inside the container it runs as UID 10001
with a read-only filesystem, dropped capabilities, temporary `/tmp`, one CPU and
1.5 GiB RAM limits. Files are mounted separately for credentials and local archives.

Copy only these source paths to the selected server's `/opt/kisj-menu/backend/`:

- `Dockerfile`, `.dockerignore`, `requirements.txt`
- `menu_scraper/*.py`
- `deploy/install.sh`, `deploy/kisj-menu.service`, `deploy/kisj-menu.timer`

Do not use a broad rsync or copy `.env` files. Provision the Firebase credential
separately as `/etc/kisj-menu/firebase.json`; the install script sets UID 10001 and
mode 0400 inside a root-only directory. Then run:

```sh
cd /opt/kisj-menu/backend
sudo bash deploy/install.sh
```

This builds the image, installs systemd units, runs an initial sync, and enables
the timer only after that sync succeeds. The timer checks hourly around minute 17
in Asia/Seoul, with up to 120 seconds of jitter. `Persistent=true` runs a missed
schedule after a reboot. No paid OCR API is used.

```sh
sudo systemctl list-timers kisj-menu.timer
sudo journalctl -u kisj-menu.service -n 60 --no-pager
sudo systemctl start kisj-menu.service
```

These commands show the next scheduled run, show recent job logs, and trigger an
immediate run. Archives are under `/var/lib/kisj-menu/menus/`. A successful later
run should report unchanged sources and skip OCR.

Stop scheduling without deleting data:

```sh
sudo systemctl disable --now kisj-menu.timer
```

Before rebuilding an existing deployment, preserve the current image with
`sudo podman tag localhost/kisj-menu:current localhost/kisj-menu:previous`. If a
new image fails, retag `previous` to `current` and start the service again.
