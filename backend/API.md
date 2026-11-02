# Menu choices and virtual queues

API: `https://kisj-api.nolgoshipda.me`

Frontend: `https://kisj-grade-calculator.web.app/menu`

Selecting Menu A or B joins that queue immediately. Each signed-in student has
one saved preference for each date and meal. Switching options changes that
preference and moves the student to the back of the new line. Repeating the same
active choice preserves their place and expiry.

## Counts and wait estimates

- `choiceCount` counts students whose saved preference is that option, including
  those who have left, received their meal, or let their ticket expire.
- `queueCount` counts only tickets still queued and not expired.
- Tickets expire 45 minutes after joining. Polling does not extend them.
- A student can leave the queue or mark their own meal received. Their saved
  preference remains counted. A served student cannot rejoin the same dated meal.
- Only published A/B sections with printed menu lines can be selected. Missing,
  blank and explicitly closed meals cannot create tickets.
- Joining and changing queues is limited to today in Asia/Seoul. Other dates are
  available for browsing. Past active queues are zero; future counts are zero.

The initial service-time assumption is **20 seconds per person**. For someone
joining now, estimated wait is `queueCount * 20` seconds. For a student already
queued, it is `(position - 1) * 20` seconds. Leaving, being served and expiry
change positions and estimates. The interface labels this as an estimate based
on students who joined through the app. It does not measure the physical line,
and the service rate has not been calibrated against cafeteria observations.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Process health |
| GET | `/v1/meals/{date}/{meal}` | Menu, aggregate counts, estimates and optional own ticket |
| PUT | `/v1/meals/{date}/{meal}/choice` | Choose and join, JSON `{"option":"A"}` or `{"option":"B"}` |
| DELETE | `/v1/meals/{date}/{meal}/queue` | Leave own queue, retaining preference |
| POST | `/v1/meals/{date}/{meal}/served` | Mark own meal received |

Dates use `YYYY-MM-DD`; meal is `breakfast`, `lunch`, or `dinner`.
Every successful meal endpoint returns a complete snapshot. Menu reads are public.
Adding `Authorization: Bearer <Firebase ID token>` includes only the caller's
private ticket. All mutations require a verified Google account from the existing
Firebase project. User IDs are taken from verified tokens, never the request body.

Each snapshot includes `today`, `canChoose`, `menuAvailable`, `source`, `closure`,
`options`, `myChoice`, `updatedAt`, and `pollAfterSeconds`. Each option contains
its `id`, Korean/English printed menu blocks, preference/queue counts, estimated
wait, service-time assumption and `estimateCalibrated: false`. Closure text is
kept as source evidence; the frontend shows a clear closure message rather than
OCR noise.

`myChoice` is null for anonymous readers or a student without a preference. It
otherwise contains the option, status, join/expiry time, and position/wait when
active. Status is `queued`, `left`, `served`, `expired`, or `unavailable` after a
menu revision removes that option. No other student's ID, name or email is returned.

Errors have `{"error":{"code":"...","message":"..."}}`. Invalid authentication
returns 401, an unverified account 403, invalid input 422, an invalid queue action
409, rate limiting 429, and transient database/capacity failures 503. Repeated
leave requests are safe and do not undo served status.

## Storage and consistency

`cafeteriaQueueSessions/{date}_{meal}` is a private Firestore document containing
one record per UID and sequence counters. The server transaction reads both the
current published menu and queue state before writing. Firestore retries read
both again, so menu revisions and simultaneous joins do not bypass validation.
Preference counts and positions are derived from those records instead of
client-maintained counters.

The initial implementation supports up to 800 preferences and a 700,000-byte
state per dated meal. A bounded two-second cache stores private raw state only;
each request builds its own response after identity verification. Mutations
invalidate the cache. One API worker keeps the cache and 30-changes-per-minute
per-user limiter consistent. This is a small-school design; larger deployment
would need partitioned sessions or counters.

## Run and test

```sh
uv pip install --python .venv/bin/python -r backend/api-requirements.txt pytest httpx
PYTHONPATH=backend .venv/bin/python -m uvicorn menu_api.app:app --host 127.0.0.1 --port 8088
.venv/bin/python -m pytest -q
```

`uvicorn` serves the API. It binds only to loopback on the Oracle host; a dedicated
Cloudflare Tunnel supplies public HTTPS without opening inbound firewall ports.
The service reads `GOOGLE_APPLICATION_CREDENTIALS` from a root-protected mounted
file, reusing the existing Firebase server identity. Credentials are never included
in source, image, URLs or application logs.

The frontend polls every 15 seconds while visible, aborts stale requests when the
date, meal or account changes, and renders server-confirmed counts. It refreshes
expired tokens and backs off on service errors. Local testing can use
`?api=http://127.0.0.1:8088`; API overrides are ignored on deployed hostnames.

## Deployment and operations

- Host: `ssh oracle`, `utility-kr1`, 1 OCPU / 6 GB RAM.
- API source: `/opt/kisj-menu/backend/menu_api/`.
- API unit: `kisj-menu-api.service`, non-root container, 512 MiB / half-CPU cap.
- Tunnel unit: `kisj-menu-tunnel.service`, separate tunnel-specific credential.
- Hostname: `kisj-api.nolgoshipda.me`, routed only to loopback port 8088.
- The hourly OCR scraper and family DNS services are independent of the API.

The initial service rate is configured by `MENU_SERVICE_SECONDS` in the API
container command. Change that whole-number value after measuring actual service
time, then restart the API. It is an assumed effective time per person for each line.

```sh
sudo systemctl status kisj-menu-api kisj-menu-tunnel
sudo journalctl -u kisj-menu-api -n 40 --no-pager
```

These show service state and recent API logs. Health checks made from scripts
should identify themselves, for example `User-Agent: KISJMenuHealth/1.0`;
Cloudflare's browser checks may reject Python's default library user agent.

The live Firebase site has a newer SPA bundle than this checkout. Publish the
standalone menu page with `backend/deploy/publish_menu_page.py --apply`: it retains
all existing file hashes/configuration and adds only `/menu.html` plus isolated
`/menu-assets/` dependencies. It aborts if another deployment occurs during its
work. Use `publish_rules.py --queues --apply` to add server-only queue rules while
preserving newer live rules. Do not run a full Hosting or rules deployment from
this older checkout. Rollback metadata is saved locally under `/tmp/kisj-menu-*`;
retain it on the server before cleanup.
