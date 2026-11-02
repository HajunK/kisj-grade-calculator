"""Add only menu rules to the live ruleset, preserving newer deployed app rules.

Uses the currently signed-in gcloud account. No credentials are stored.
Default: compile and test. --apply additionally activates the tested ruleset.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import urllib.request

MENU_RULES = """
    // Public HS menus, written only by the scheduled server Admin SDK.
    match /cafeteriaMenus/{menuId} {
      allow read: if true;
      allow write: if false;
    }
    match /cafeteriaMenuSources/{sourceId} {
      allow read, write: if false;
    }
"""


def merge_rules(content):
    if "match /cafeteriaMenus/" in content or "match /cafeteriaMenuSources/" in content:
        if MENU_RULES.strip() in content:
            return content
        raise ValueError("Live menu rules already exist with different content; review before replacing")
    anchor = "match /databases/{database}/documents {"
    if content.count(anchor) != 1:
        raise ValueError("Could not safely locate the Firestore document rules block")
    return content.replace(anchor, anchor + "\n" + MENU_RULES, 1)


def tests():
    cases = []
    for auth in (None, {"uid": "test-student", "token": {"email": "student@example.test"}},
                 {"uid": "test-admin", "token": {"email": "hajunk105@gmail.com"}}):
        for collection, read in (("cafeteriaMenus", "ALLOW"), ("cafeteriaMenuSources", "DENY")):
            for method in ("get", "list", "create", "update", "delete"):
                path = f"/databases/(default)/documents/{collection}/hs-2026-11-09"
                cases.append({
                    "expectation": read if method in {"get", "list"} else "DENY",
                    "request": {"path": path, "method": method, "auth": auth,
                                "resource": {"data": {"school": "HS"}}},
                    "resource": {"data": {"school": "HS"}},
                })
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="kisj-grade-calculator")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path, default=Path("/tmp/kisj-menu-rules-backup.json"))
    args = parser.parse_args()
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
               "x-goog-user-project": args.project}

    def api(path, data=None, method=None):
        request = urllib.request.Request(
            "https://firebaserules.googleapis.com/v1/" + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers=headers, method=method,
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    release_path = f"projects/{args.project}/releases/cloud.firestore"
    release = api(release_path)
    ruleset = api(release["rulesetName"])
    source = deepcopy(ruleset["source"])
    files = [file for file in source["files"] if file["name"] == "firestore.rules"]
    if len(files) != 1:
        raise ValueError("Expected one live firestore.rules file")
    old = files[0]["content"]
    files[0]["content"] = merge_rules(old)
    files[0].pop("fingerprint", None)
    result = api(f"projects/{args.project}:test", {"source": source, "testSuite": {"testCases": tests()}})
    issues = [issue for issue in result.get("issues", []) if issue.get("severity") == "ERROR"]
    failed = [test for test in result.get("testResults", []) if test.get("state") != "SUCCESS"]
    if issues or failed or len(result.get("testResults", [])) != len(tests()):
        raise RuntimeError(json.dumps({"issues": issues, "failures": failed})[:8000])
    print(f"Menu rules compiled; {len(tests())} access-control tests passed")
    if args.apply and files[0]["content"] != old:
        args.backup.write_text(json.dumps({"release": release, "ruleset": ruleset}, indent=2) + "\n")
        created = api(f"projects/{args.project}/rulesets", {"source": source})
        # Abort if another deploy occurred after our read/test.
        if api(release_path)["rulesetName"] != release["rulesetName"]:
            raise RuntimeError("Live rules changed during deployment; retry against the new version")
        api(release_path + "?updateMask=rulesetName", {
            "release": {"name": release_path, "rulesetName": created["name"]},
        }, method="PATCH")
        if api(release_path)["rulesetName"] != created["name"]:
            raise RuntimeError("Rules activation verification failed")
        print("Menu rules activated; all pre-existing rules retained. Backup:", args.backup)
    elif args.apply:
        print("Menu rules already active")


if __name__ == "__main__":
    main()
