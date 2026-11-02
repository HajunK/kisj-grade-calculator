import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("publish_rules", Path(__file__).parents[1] / "deploy/publish_rules.py")
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)


def test_live_rules_patch_is_additive_and_idempotent():
    original = """rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /private/{id} { allow read: if request.auth != null; }
  }
}"""
    merged = rules.merge_rules(original)
    assert merged.replace("\n" + rules.MENU_RULES, "", 1) == original
    assert rules.merge_rules(merged) == merged


def test_rules_patch_refuses_conflicting_existing_menu_rules():
    with pytest.raises(ValueError, match="different content"):
        rules.merge_rules("match /cafeteriaMenus/{id} { allow write: if true; }")


def test_private_queue_rules_are_additive_and_idempotent():
    original = "service cloud.firestore { match /databases/{database}/documents { } }"
    patched = rules.merge_queue_rules(original)
    assert patched.replace("\n" + rules.QUEUE_RULES, "", 1) == original
    assert rules.merge_queue_rules(patched) == patched
    assert len(rules.queue_tests()) == 30
