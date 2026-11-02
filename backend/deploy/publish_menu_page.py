"""Add the standalone menu page while retaining every unrelated live Hosting file.

Default is a read-only deployment plan. --apply creates and releases a version.
This checkout predates the live SPA, so a full Hosting deployment is inappropriate.
"""

import argparse
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote
import urllib.request


def page_files(public):
    html = (public / "menu.html").read_text()
    assets = set(re.findall(r'(?:href|src)="((?:css|js)/[^"?]+\.(?:css|js))"', html))
    assets.update({"fonts/inter-latin.woff2", "icons/close.svg"})
    result = {"/menu-assets/" + path: (public / path).read_bytes() for path in assets}
    html = html.replace('href="css/', 'href="/menu-assets/css/')
    html = html.replace('src="js/', 'src="/menu-assets/js/')
    html = html.replace('href="fonts/', 'href="/menu-assets/fonts/')
    result["/menu.html"] = html.encode()
    return result


def preserve_files(existing, additions):
    for path in additions:
        if path != "/menu.html" and not path.startswith("/menu-assets/"):
            raise ValueError("Only the menu namespace may be published")
    return {**existing, **additions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", default="kisj-grade-calculator")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path, default=Path("/tmp/kisj-menu-hosting-backup.json"))
    args = parser.parse_args()
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
               "x-goog-user-project": "kisj-grade-calculator"}
    base = "https://firebasehosting.googleapis.com/v1beta1/"

    def api(path, data=None, method=None):
        request = urllib.request.Request(base + path,
            data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    def latest():
        return api(f"sites/{args.site}/releases?pageSize=1")["releases"][0]

    release = latest()
    version = api(release["version"]["name"])
    existing, cursor = {}, ""
    while True:
        page = api(version["name"] + "/files?pageSize=1000" + ("&pageToken=" + quote(cursor) if cursor else ""))
        existing.update({entry["path"]: entry["hash"] for entry in page.get("files", [])})
        cursor = page.get("nextPageToken")
        if not cursor:
            break
    public = Path(__file__).resolve().parents[2] / "public"
    compressed = {path: gzip.compress(data, mtime=0) for path, data in page_files(public).items()}
    payloads = {hashlib.sha256(data).hexdigest(): data for data in compressed.values()}
    hashes = {path: hashlib.sha256(data).hexdigest() for path, data in compressed.items()}
    merged = preserve_files(existing, hashes)
    print(f"Retaining {len(existing)} existing paths; publishing {len(hashes)} menu paths")
    if not args.apply:
        return
    args.backup.write_text(json.dumps({"release": release, "version": version, "files": existing}, indent=2) + "\n")
    created = api(f"sites/{args.site}/versions", {"config": deepcopy(version.get("config", {}))})
    populated = api(created["name"] + ":populateFiles", {"files": merged})
    for digest in populated.get("uploadRequiredHashes", []):
        if digest not in payloads:
            raise RuntimeError("Hosting requested an unrelated live file; refusing to alter the existing release")
        request = urllib.request.Request(populated["uploadUrl"] + "/" + digest, data=payloads[digest],
            headers={**headers, "Content-Type": "application/octet-stream"}, method="POST")
        with urllib.request.urlopen(request, timeout=60) as response:
            response.read()
    api(created["name"] + "?updateMask=status", {"status": "FINALIZED"}, method="PATCH")
    if latest()["version"]["name"] != version["name"]:
        raise RuntimeError("Another Hosting deploy occurred; rerun against that version")
    api(f"sites/{args.site}/releases?versionName=" + quote(created["name"], safe="/"), {}, method="POST")
    if latest()["version"]["name"] != created["name"]:
        raise RuntimeError("Hosting release verification failed")
    print("Menu page released:", f"https://{args.site}.web.app/menu")
    print("Previous release saved to", args.backup)


if __name__ == "__main__":
    main()
