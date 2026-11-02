"""HTTP boundary: Firebase identity, dated meals, privacy and queue responses."""

from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
import logging
import math
import os
from threading import RLock
from time import monotonic
from typing import Literal
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import auth, firestore
from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.api_core.exceptions import GoogleAPICallError
from pydantic import BaseModel, ConfigDict

from .engine import QueueError, available_menu, snapshot
from .repository import FirestoreQueueRepository

LOGGER = logging.getLogger("menu_api")
SEOUL = ZoneInfo("Asia/Seoul")
Meal = Literal["breakfast", "lunch", "dinner"]
DEFAULT_ORIGINS = (
    "https://kisjcalc.com", "https://www.kisjcalc.com", "https://kiscal.app",
    "https://www.kiscal.app", "https://kisj-grade-calculator.web.app",
    "https://kisj-grade-calculator.firebaseapp.com",
)


class Choice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    option: Literal["A", "B"]


class FirebaseResources:
    def __init__(self):
        self.lock = RLock()
        self.app = None
        self.repository = None

    def ensure(self):
        with self.lock:
            if self.app is None:
                self.app = firebase_admin.initialize_app(
                    options={"projectId": os.getenv("FIREBASE_PROJECT_ID", "kisj-grade-calculator")},
                    name="menu-queue-api",
                )
                self.repository = FirestoreQueueRepository(firestore.client(self.app))
        return self.repository

    def verify(self, token):
        self.ensure()
        return auth.verify_id_token(token, app=self.app, check_revoked=True)

    def close(self):
        if self.app is not None:
            self.repository.db.close()
            firebase_admin.delete_app(self.app)


class ReadCache:
    """Cache private raw state only, never a response containing a student's choice."""
    def __init__(self, ttl=2):
        self.ttl = ttl
        self.lock = RLock()
        self.values = {}

    def get(self, key, load):
        # Serialize a cache miss so simultaneous browser polls share one read.
        with self.lock:
            cached = self.values.get(key)
            if cached and cached[0] > monotonic():
                return cached[1]
            value = load()
            if len(self.values) > 256:
                self.values.clear()
            self.values[key] = (monotonic() + self.ttl, value)
            return value

    def clear(self):
        with self.lock:
            self.values.clear()


class WriteLimiter:
    def __init__(self, limit=30):
        self.limit = limit
        self.lock = RLock()
        self.requests = defaultdict(deque)

    def check(self, uid):
        now = monotonic()
        with self.lock:
            if len(self.requests) > 4096:
                self.requests = defaultdict(deque, {
                    key: values for key, values in self.requests.items()
                    if values and values[-1] > now - 60
                })
            values = self.requests[uid]
            while values and values[0] <= now - 60:
                values.popleft()
            if len(values) >= self.limit:
                raise QueueError("rate_limited", "Too many changes. Wait a minute and try again.", 429)
            values.append(now)


def create_app(repository=None, verifier=None, clock=None, service_seconds=None, allowed_origins=None):
    resources = FirebaseResources()
    state_cache = ReadCache()
    limiter = WriteLimiter()
    now = clock or (lambda: datetime.now(timezone.utc))
    seconds = float(service_seconds if service_seconds is not None else os.getenv("MENU_SERVICE_SECONDS", "20"))
    if not math.isfinite(seconds) or not 1 <= seconds <= 600:
        raise ValueError("MENU_SERVICE_SECONDS must be between 1 and 600 seconds")
    if not seconds.is_integer():
        raise ValueError("MENU_SERVICE_SECONDS must be a whole number of seconds")
    seconds = int(seconds)
    origins = allowed_origins if allowed_origins is not None else os.getenv("MENU_API_ALLOWED_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",")

    @asynccontextmanager
    async def lifespan(app):
        yield
        resources.close()

    application = FastAPI(title="KISJ HS menu queues", version="1.0.0", lifespan=lifespan,
                          docs_url=None, redoc_url=None, openapi_url=None)
    application.add_middleware(CORSMiddleware, allow_origins=origins,
                               allow_origin_regex=r"http://(?:localhost|127\.0\.0\.1)(?::\d{1,5})?",
                               allow_methods=["GET", "PUT", "POST", "DELETE"],
                               allow_headers=["Authorization", "Content-Type"], allow_credentials=False,
                               expose_headers=["Retry-After"], max_age=600)

    @application.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Vary"] = ", ".join(sorted(set(
            part.strip() for part in (response.headers.get("Vary", "") + ",Origin,Authorization").split(",") if part.strip()
        )))
        return response

    @application.exception_handler(QueueError)
    async def domain_error(request, error):
        headers = {"Retry-After": "60"} if error.status == 429 else {}
        return JSONResponse(status_code=error.status,
                            content={"error": {"code": error.code, "message": error.message}}, headers=headers)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        return JSONResponse(status_code=422, content={"error": {
            "code": "invalid_request", "message": "Use a valid meal date and option A or B.",
        }})

    @application.exception_handler(GoogleAPICallError)
    async def database_error(request, error):
        # Never include database content, user IDs or credential details in a response.
        LOGGER.warning("Firestore request failed: %s", type(error).__name__)
        return JSONResponse(status_code=503, content={"error": {
            "code": "temporarily_unavailable", "message": "Menu service is busy. Try again shortly.",
        }})

    def repo():
        return repository if repository is not None else resources.ensure()

    def identity(header, required=False):
        if not header:
            if required:
                raise QueueError("sign_in_required", "Sign in with Google to join a queue.", 401)
            return None
        scheme, separator, token = header.partition(" ")
        if scheme.lower() != "bearer" or not separator or not token or len(token) > 16384:
            raise QueueError("invalid_token", "Sign in again to continue.", 401)
        try:
            claims = (verifier or resources.verify)(token)
        except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError, auth.RevokedIdTokenError,
                auth.UserDisabledError, ValueError):
            raise QueueError("invalid_token", "Sign in again to continue.", 401) from None
        except Exception:
            LOGGER.warning("Firebase identity verification temporarily unavailable")
            raise QueueError("auth_unavailable", "Sign-in verification is unavailable. Try again shortly.", 503) from None
        uid = claims.get("uid") or claims.get("sub")
        if not isinstance(uid, str) or not 1 <= len(uid) <= 128:
            raise QueueError("invalid_token", "Sign in again to continue.", 401)
        if (claims.get("email_verified") is not True
                or claims.get("firebase", {}).get("sign_in_provider") != "google.com"):
            if required:
                raise QueueError("verified_google_required", "Use a verified Google account to join a queue.", 403)
            return None
        return uid

    def valid_date(value):
        try:
            parsed = date.fromisoformat(value)
            if parsed.isoformat() != value or not 2020 <= parsed.year <= 2100:
                raise ValueError
        except ValueError:
            raise QueueError("invalid_date", "Use a date in YYYY-MM-DD format.", 422) from None
        return parsed

    def response(day, meal, uid, state=None, metadata=None):
        if metadata is None:
            menu = state_cache.get(("menu", day), lambda: repo().get_menu(day))
            metadata = available_menu(menu, day, meal)
        today = now().astimezone(SEOUL).date().isoformat()
        if day > today:
            state = {}
            uid = None
        elif state is None:
            state = state_cache.get(("state", day, meal), lambda: repo().get_state(day, meal))
        ids = [option["id"] for option in metadata["options"]]
        queues = snapshot(state, uid, now(), ids if day == today else [], service_seconds=seconds)
        if day < today and queues["myChoice"] and queues["myChoice"]["status"] == "unavailable":
            queues["myChoice"]["status"] = "expired"
        options = []
        for option in metadata["options"]:
            key = option["id"]
            options.append({**option, "choiceCount": queues["choiceCounts"][key],
                            "queueCount": queues["queueCounts"][key],
                            "estimatedWaitSeconds": queues["prospectiveWaitSeconds"][key],
                            "serviceSecondsPerPerson": seconds, "estimateCalibrated": False})
        closure = metadata.get("closure")
        return {"date": day, "meal": meal, "timezone": "Asia/Seoul", **metadata,
                "today": today, "canChoose": day == today and bool(options),
                "closure": {"scope": "allMeals", "sourceText": closure.get("text", "")} if closure else None,
                "options": options, "myChoice": queues["myChoice"],
                "updatedAt": now().isoformat(), "pollAfterSeconds": 15}

    def change(day, meal, action, authorization, option=None):
        parsed = valid_date(day)
        uid = identity(authorization, required=True)
        if parsed != now().astimezone(SEOUL).date():
            raise QueueError("not_today", "You can join or change queues only for today in Korea.", 409)
        limiter.check(uid)
        state, metadata = repo().mutate(day, meal, uid, action, option, now())
        state_cache.clear()
        # The transaction returns the exact menu version it validated.
        return response(day, meal, uid, state=state, metadata=metadata)

    @application.get("/health")
    def health():
        return {"status": "ok", "service": "kisj-menu-queue"}

    @application.get("/v1/meals/{day}/{meal}")
    def get_meal(day: str, meal: Meal, authorization: str | None = Header(default=None)):
        valid_date(day)
        return response(day, meal, identity(authorization))

    @application.put("/v1/meals/{day}/{meal}/choice")
    def choose(day: str, meal: Meal, body: Choice, authorization: str | None = Header(default=None)):
        return change(day, meal, "choose", authorization, body.option)

    @application.delete("/v1/meals/{day}/{meal}/queue")
    def leave(day: str, meal: Meal, authorization: str | None = Header(default=None)):
        return change(day, meal, "leave", authorization)

    @application.post("/v1/meals/{day}/{meal}/served")
    def served(day: str, meal: Meal, authorization: str | None = Header(default=None)):
        return change(day, meal, "served", authorization)

    return application


app = create_app()
