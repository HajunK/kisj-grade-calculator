from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
import pytest

from menu_api.app import create_app
from menu_api.engine import available_menu, mutate

NOW = datetime(2026, 11, 9, 3, 0, tzinfo=timezone.utc)


class Repository:
    def __init__(self):
        self.states = {}
        self.menu = {"school": "HS", "weekStart": "2026-11-09", "weekEnd": "2026-11-15",
                     "source": {"url": "https://kis.ac/cafeteria-menus/?uid=5154", "title": "[HS] Week"},
                     "days": [{"date": "2026-11-09", "meals": {"lunch": {"en": [
                         {"section": option, "status": "printed", "text": "Menu " + option,
                          "lines": ["Menu " + option]} for option in ("A", "B")
                     ]}}}]}

    def get_menu(self, day):
        return self.menu if day.startswith("2026-11-") else None

    def get_state(self, day, meal):
        return self.states.get((day, meal), {})

    def mutate(self, day, meal, uid, action, option, now):
        metadata = available_menu(self.get_menu(day), day, meal)
        state = mutate(self.get_state(day, meal), uid, action, now,
                       [row["id"] for row in metadata["options"]], option)
        self.states[(day, meal)] = state
        return state, metadata


def verify(token):
    if token == "invalid":
        raise ValueError("invalid token")
    return {"uid": token, "email_verified": token != "unverified",
            "firebase": {"sign_in_provider": "google.com"}}


@pytest.fixture
def setup():
    repository = Repository()
    clock = [NOW]
    app = create_app(repository=repository, verifier=verify, clock=lambda: clock[0])
    with TestClient(app) as client:
        yield client, repository, clock


URL = "/v1/meals/2026-11-09/lunch"


def headers(token):
    return {"Authorization": "Bearer " + token}


def test_public_snapshot_never_exposes_other_student_state(setup):
    client, repository, _ = setup
    assert client.put(URL + "/choice", json={"option": "A"}, headers=headers("student-one")).status_code == 200
    public = client.get(URL)
    assert public.status_code == 200
    assert public.json()["myChoice"] is None
    assert public.json()["options"][0]["choiceCount"] == 1
    assert public.json()["options"][0]["queueCount"] == 1
    assert "student-one" not in public.text
    assert client.get(URL, headers=headers("student-two")).json()["myChoice"] is None
    assert public.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("authorization,status", [(None, 401), ("Basic fake", 401),
                                                    ("Bearer invalid", 401), ("Bearer unverified", 403)])
def test_writes_require_verified_google_identity(setup, authorization, status):
    client, repository, _ = setup
    response = client.put(URL + "/choice", json={"option": "A"},
                          headers={"Authorization": authorization} if authorization else {})
    assert response.status_code == status
    assert repository.states == {}


def test_duplicate_choice_switch_and_service_update_counts(setup):
    client, _, clock = setup
    first = client.put(URL + "/choice", json={"option": "A"}, headers=headers("first")).json()
    repeated = client.put(URL + "/choice", json={"option": "A"}, headers=headers("first")).json()
    assert repeated["myChoice"]["joinedAt"] == first["myChoice"]["joinedAt"]
    second = client.put(URL + "/choice", json={"option": "A"}, headers=headers("second")).json()
    assert second["myChoice"]["position"] == 2
    assert second["myChoice"]["estimatedWaitSeconds"] == 20
    changed = client.put(URL + "/choice", json={"option": "B"}, headers=headers("first")).json()
    assert [option["choiceCount"] for option in changed["options"]] == [1, 1]
    assert [option["queueCount"] for option in changed["options"]] == [1, 1]
    served = client.post(URL + "/served", headers=headers("first")).json()
    assert served["myChoice"]["status"] == "served"
    assert [option["choiceCount"] for option in served["options"]] == [1, 1]
    assert [option["queueCount"] for option in served["options"]] == [1, 0]
    assert client.put(URL + "/choice", json={"option": "A"}, headers=headers("first")).status_code == 409
    clock[0] += timedelta(minutes=46)
    expired = client.get(URL, headers=headers("second")).json()
    assert expired["myChoice"]["status"] == "expired"
    assert expired["options"][0]["queueCount"] == 0


def test_cannot_impersonate_uid_or_join_another_date(setup):
    client, repository, _ = setup
    assert client.put(URL + "/choice", json={"option": "A", "uid": "victim"}, headers=headers("attacker")).status_code == 422
    assert client.put("/v1/meals/2026-11-10/lunch/choice", json={"option": "A"}, headers=headers("first")).status_code == 409
    assert repository.states == {}


def test_cors_allows_frontend_and_not_unknown_origin(setup):
    client, _, _ = setup
    request_headers = {"Origin": "https://kisjcalc.com", "Access-Control-Request-Method": "PUT",
                       "Access-Control-Request-Headers": "Authorization,Content-Type"}
    assert client.options(URL + "/choice", headers=request_headers).headers["access-control-allow-origin"] == "https://kisjcalc.com"
    request_headers["Origin"] = "https://unrelated.example"
    assert "access-control-allow-origin" not in client.options(URL + "/choice", headers=request_headers).headers


def test_missing_menu_and_invalid_date_have_explicit_states(setup):
    client, _, _ = setup
    missing = client.get("/v1/meals/2026-11-02/lunch")
    assert missing.status_code == 200
    assert missing.json()["menuAvailable"] is False and missing.json()["options"] == []
    assert client.get("/v1/meals/20261109/lunch").status_code == 422


def test_config_rejects_unusable_service_rates():
    for value in (0, -1, "NaN", 0.5, 601):
        with pytest.raises(ValueError):
            create_app(service_seconds=value)
