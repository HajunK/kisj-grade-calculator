// The Menu tab. Everything shown here comes from the menu API: a snapshot is
// replaced only by a newer snapshot, never edited locally, so a count or a place
// in line on screen is always one the server confirmed. Wrapped in a function
// because auth.js and preferences.js declare page-wide names such as "auth".
(function () {
  "use strict";

  const DEFAULT_API_BASE = "https://kisj-api.nolgoshipda.me";
  const TIMEZONE = "Asia/Seoul";
  const MEALS = ["breakfast", "lunch", "dinner"];
  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
  const LANGUAGE_NAMES = { en: "English", ko: "Korean" };
  const EXTRA_LABELS = { vegan: "Vegan", special: "Special", always: "Always available" };
  const LANGUAGE_KEY = "menuLanguage";

  const DEFAULT_POLL_SECONDS = 15;
  const MAX_POLL_SECONDS = 120;
  const REQUEST_TIMEOUT_MS = 15000;
  const ACTION_ERROR_MS = 30000;
  // Auth normally resolves in well under this. If it hasn't, the public menu
  // still loads and the student's own state follows once it does.
  const AUTH_WAIT_MS = 4000;
  const MAX_TICKS = 60;

  // The override carries the student's ID token wherever it points, so a link
  // must never be able to set it on the real site. Local browser tests only.
  function resolveApiBase() {
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!local) return DEFAULT_API_BASE;
    let override = new URLSearchParams(location.search).get("api");
    if (!override) {
      try {
        override = localStorage.getItem("menuApiBase");
      } catch (error) {
        override = null;
      }
    }
    return (override || DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  const API_BASE = resolveApiBase();

  const dom = {
    title: document.getElementById("menu-title"),
    dateLabel: document.getElementById("menu-date-label"),
    dateInput: document.getElementById("menu-date"),
    prevDay: document.getElementById("menu-prev-day"),
    nextDay: document.getElementById("menu-next-day"),
    today: document.getElementById("menu-today"),
    meal: document.getElementById("menu-meal"),
    lang: document.getElementById("menu-lang"),
    notices: document.getElementById("menu-notices"),
    body: document.getElementById("menu-body"),
    live: document.getElementById("menu-live"),
  };

  const state = {
    date: null,
    meal: null,
    lang: "en",
    // undefined until auth first resolves, then null (signed out) or the user.
    user: undefined,
    authUsable: true,
    tokenRejected: false,
    started: false,
    snapshot: null,
    loadError: null,
    refreshFailedAt: null,
    actionError: null,
    actionErrorAt: 0,
    pending: null,
    // Bumped on any date, meal, or account change. Work started under an older
    // value is stale and must not touch the screen.
    generation: 0,
    controller: null,
    pollTimer: null,
    failures: 0,
    retryAfterSeconds: null,
    enterNext: true,
    focusTicketNext: false,
    restoreFocusKey: null,
    estimateOpen: false,
    lastSignature: null,
    lastNotices: null,
  };

  // Dates and times

  function seoulNowParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function seoulToday() {
    const now = seoulNowParts();
    return `${now.year}-${now.month}-${now.day}`;
  }

  // Only picks what opens first. It makes no claim about when meals are served.
  function defaultMeal() {
    const now = seoulNowParts();
    const minutes = Number(now.hour) * 60 + Number(now.minute);
    if (minutes < 9 * 60 + 30) return "breakfast";
    if (minutes < 14 * 60) return "lunch";
    return "dinner";
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function addDays(value, days) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  function shortDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (typeof window.formatPreferredDate === "function") return window.formatPreferredDate(date);
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  }

  function longDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(year, month - 1, day));
    return `${weekday}, ${shortDate(value)}`;
  }

  function clockTime(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit" }).format(date);
  }

  // Rounded up, so the estimate doesn't promise less than its own arithmetic.
  function waitParts(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    if (seconds === 0) return { value: "0", unit: "min" };
    if (seconds < 60) return { value: "<1", unit: "min" };
    return { value: String(Math.ceil(seconds / 60)), unit: "min" };
  }

  function plural(count, one, many) {
    return count === 1 ? one : many;
  }

  // Menu text

  function isPrinted(block) {
    return Boolean(
      block &&
        block.status === "printed" &&
        Array.isArray(block.lines) &&
        block.lines.some((line) => typeof line === "string" && line.trim())
    );
  }

  function pickBlock(menu, language) {
    const other = language === "en" ? "ko" : "en";
    if (menu && isPrinted(menu[language])) return { block: menu[language], language, fallback: false };
    if (menu && isPrinted(menu[other])) return { block: menu[other], language: other, fallback: true };
    return null;
  }

  const CODES_ONLY = /^\(\d{1,2}(?:[.,]\s*\d{1,2})*\)$/;
  const TRAILING_CODES = /\s*(\(\d{1,2}(?:[.,]\s*\d{1,2})*\))$/;

  function isUnfinished(text) {
    const opened = (text.match(/[[(]/g) || []).length;
    const closed = (text.match(/[\])]/g) || []).length;
    return opened > closed || /\/$/.test(text);
  }

  // OCR hard-wraps at the printed cell's width, so one dish can arrive as
  // "... [origin" then "country]" then "(05,06)". This only regroups the printed
  // pieces in order. It never drops or interprets any of them.
  function toDishes(lines) {
    const dishes = [];
    lines.forEach((raw) => {
      const line = typeof raw === "string" ? raw.trim() : "";
      if (!line) return;
      const last = dishes[dishes.length - 1];
      if (last && CODES_ONLY.test(line)) {
        last.codes = last.codes ? `${last.codes} ${line}` : line;
        return;
      }
      if (last && !last.codes && isUnfinished(last.name)) {
        last.name = `${last.name} ${line}`;
      } else {
        dishes.push({ name: line, codes: null });
      }
      const current = dishes[dishes.length - 1];
      const trailing = current.name.match(TRAILING_CODES);
      if (trailing && trailing.index > 0) {
        current.name = current.name.slice(0, trailing.index);
        current.codes = trailing[1];
      }
    });
    return dishes;
  }

  // DOM helpers. All server text goes through textContent, never HTML parsing.

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, kind, onClick, disabled, focusKey) {
    const node = el("button", `menu-btn menu-btn--${kind}`, label);
    node.type = "button";
    node.disabled = Boolean(disabled);
    if (focusKey) node.dataset.focusKey = focusKey;
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  function safeSourceUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch (error) {
      return null;
    }
  }

  function buildDishes(selection) {
    const list = el("ul", "menu-dishes");
    list.lang = selection.language;
    toDishes(selection.block.lines).forEach((dish) => {
      const item = el("li");
      item.appendChild(document.createTextNode(dish.name));
      if (dish.codes) item.appendChild(el("span", "menu-dish-codes", dish.codes));
      list.appendChild(item);
    });
    return list;
  }

  function buildTicks(count, position) {
    const strip = el("div", "menu-ticks");
    strip.setAttribute("role", "img");
    strip.setAttribute(
      "aria-label",
      position
        ? `${count} ${plural(count, "student", "students")} in line. You are number ${position}.`
        : `${count} ${plural(count, "student", "students")} in line.`
    );
    if (count === 0) {
      strip.appendChild(el("span", "menu-ticks-empty"));
      return strip;
    }
    const shown = Math.min(count, MAX_TICKS);
    for (let index = 1; index <= shown; index += 1) {
      const tick = el("span", "menu-tick");
      if (position) {
        if (index === position) tick.classList.add("menu-tick--you");
        else if (index > position) tick.classList.add("menu-tick--behind");
      }
      strip.appendChild(tick);
    }
    if (count > shown) strip.appendChild(el("span", "menu-ticks-more", `+${count - shown}`));
    return strip;
  }

  function buildStat(label, value, unit) {
    const stat = el("div", "menu-stat");
    stat.appendChild(el("dt", null, label));
    const number = el("dd", null, value);
    if (unit) number.appendChild(el("span", "menu-stat-unit", unit));
    stat.appendChild(number);
    return stat;
  }

  // Requests

  class ApiError extends Error {
    constructor(status, message, retryAfterSeconds) {
      super(message);
      this.status = status;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  function genericMessage(status) {
    if (status === 401) return "Your sign-in could not be confirmed. Sign out and sign in again.";
    if (status === 403) return "This account can't choose a menu. Sign in with your Google account.";
    if (status === 429) return "Too many requests. Wait a moment and try again.";
    if (status >= 500) return "The menu service is having trouble. Try again in a moment.";
    return "The menu service rejected that request.";
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  // Refuses a malformed body rather than drawing blank or invented counts.
  function isReadableSnapshot(data) {
    return Boolean(
      data &&
        typeof data.menuAvailable === "boolean" &&
        Array.isArray(data.options) &&
        data.options.every((option) => Number.isFinite(option.choiceCount) && Number.isFinite(option.queueCount))
    );
  }

  async function send(method, path, options, user, forceRefresh) {
    const headers = { Accept: "application/json" };
    if (user) headers.Authorization = `Bearer ${await user.getIdToken(forceRefresh)}`;
    if (options.body) headers["Content-Type"] = "application/json";
    return fetch(API_BASE + path, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      cache: "no-store",
      credentials: "omit",
    });
  }

  async function request(method, path, options) {
    const user = state.user || null;
    const generation = state.generation;
    let publicFallback = false;
    async function sendAttempt(forceRefresh) {
      try {
        return await send(method, path, options, user, forceRefresh);
      } catch (error) {
        if (method !== "GET" || !user || (error && error.name === "AbortError") || options.signal?.aborted) throw error;
        // Token acquisition can fail before an HTTP response exists. Public
        // reading still works without it; a write must keep its identity.
        publicFallback = true;
        return send(method, path, options, null, false);
      }
    }
    let response = await sendAttempt(false);
    if (response.status === 401 && user && !publicFallback) {
      // An expired token is normal. A forced refresh settles whether it's more.
      response = await sendAttempt(true);
      if (response.status === 401 && method === "GET") {
        // The public menu shouldn't vanish over a sign-in problem.
        if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
        publicFallback = true;
        response = await send(method, path, options, null, false);
      }
    }
    if (response.ok && user && state.user === user && state.generation === generation) {
      state.tokenRejected = publicFallback;
    }
    const data = await readJson(response);
    if (!response.ok) {
      const detail = data && data.error ? data.error : {};
      const message = typeof detail.message === "string" && detail.message ? detail.message : genericMessage(response.status);
      const header = Number(response.headers.get("Retry-After"));
      const retryAfter = Number.isFinite(detail.retryAfterSeconds) ? detail.retryAfterSeconds : header || null;
      throw new ApiError(response.status, message, retryAfter);
    }
    if (!isReadableSnapshot(data)) {
      throw new ApiError(response.status, "The menu service sent a response this page can't read.");
    }
    return data;
  }

  function mealPath() {
    return `/v1/meals/${encodeURIComponent(state.date)}/${encodeURIComponent(state.meal)}`;
  }

  function abortCurrent() {
    if (state.controller) state.controller.abort();
    state.controller = null;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function startRequest() {
    abortCurrent();
    const controller = new AbortController();
    state.controller = controller;
    controller.timer = setTimeout(() => {
      controller.timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    return controller;
  }

  function isStaleAbort(error, controller) {
    return Boolean(error && error.name === "AbortError" && !controller.timedOut);
  }

  function describeFailure(error) {
    if (error instanceof ApiError) return error.message;
    return "Could not reach the menu service. Check your connection and try again.";
  }

  function acceptSnapshot(snapshot) {
    state.snapshot = snapshot;
    state.loadError = null;
    state.refreshFailedAt = null;
    state.failures = 0;
    state.retryAfterSeconds = null;
  }

  // Polling

  function nextPollDelayMs() {
    const asked = state.snapshot && Number(state.snapshot.pollAfterSeconds);
    const base = asked >= 5 ? Math.min(asked, MAX_POLL_SECONDS) : DEFAULT_POLL_SECONDS;
    const backedOff = Math.min(base * 2 ** state.failures, MAX_POLL_SECONDS);
    return Math.max(backedOff, state.retryAfterSeconds || 0) * 1000;
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (document.hidden || state.pending || !state.date) return;
    state.pollTimer = setTimeout(load, nextPollDelayMs());
  }

  async function load() {
    if (state.pending) return;
    const generation = state.generation;
    const controller = startRequest();
    try {
      const snapshot = await request("GET", mealPath(), { signal: controller.signal });
      if (generation !== state.generation) return;
      if (snapshot.date !== state.date || snapshot.meal !== state.meal) return;
      acceptSnapshot(snapshot);
    } catch (error) {
      if (isStaleAbort(error, controller) || generation !== state.generation) return;
      state.failures += 1;
      state.retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds || null : null;
      if (state.snapshot) state.refreshFailedAt = new Date().toISOString();
      else state.loadError = describeFailure(error);
    } finally {
      clearTimeout(controller.timer);
    }
    if (generation !== state.generation) return;
    if (state.actionError && Date.now() - state.actionErrorAt > ACTION_ERROR_MS) state.actionError = null;
    render();
    schedulePoll();
  }

  // Student actions

  async function mutate(action, method, path, body, option) {
    if (state.pending || !state.user || !state.snapshot) return;
    const generation = state.generation;
    state.pending = { action, option };
    state.actionError = null;
    const controller = startRequest();
    render();
    let failed = false;
    try {
      const snapshot = await request(method, mealPath() + path, { body, signal: controller.signal });
      if (generation !== state.generation) return;
      acceptSnapshot(snapshot);
      state.focusTicketNext = true;
      announce(describeOutcome(action, snapshot));
    } catch (error) {
      if (isStaleAbort(error, controller) || generation !== state.generation) return;
      failed = true;
      state.actionError = describeFailure(error);
      state.actionErrorAt = Date.now();
      state.retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds || null : null;
    } finally {
      clearTimeout(controller.timer);
    }
    if (generation !== state.generation) return;
    state.pending = null;
    render();
    // A failure usually means this screen was out of date, so catch up rather
    // than leave the same doomed button in place. Whether a timed-out request
    // landed is unknown until this returns, too.
    if (failed) load();
    else schedulePoll();
  }

  function describeOutcome(action, snapshot) {
    const mine = snapshot.myChoice;
    if (action === "leave") return "You left the line. Your choice still counts.";
    if (action === "served") return "Marked as served.";
    if (mine && mine.status === "queued") return `You joined line ${mine.option}, number ${mine.position} in line.`;
    return "Saved.";
  }

  function announce(message) {
    dom.live.textContent = message;
  }

  function chooseOption(option) {
    mutate("choose", "PUT", "/choice", { option }, option);
  }

  function leaveLine() {
    mutate("leave", "DELETE", "/queue");
  }

  function markServed() {
    mutate("served", "POST", "/served");
  }

  // Reuses auth.js's own button, so there is one sign-in path.
  function startSignIn() {
    const signIn = document.querySelector(".auth-signin-btn");
    if (signIn) signIn.click();
  }

  // View changes

  function resetView() {
    state.generation += 1;
    abortCurrent();
    state.snapshot = null;
    state.loadError = null;
    state.refreshFailedAt = null;
    state.actionError = null;
    state.pending = null;
    state.failures = 0;
    state.retryAfterSeconds = null;
    state.enterNext = true;
    state.focusTicketNext = false;
    state.restoreFocusKey = null;
  }

  function writeUrl() {
    const url = new URL(location.href);
    url.searchParams.set("date", state.date);
    url.searchParams.set("meal", state.meal);
    history.replaceState(null, "", url);
  }

  function selectView(date, meal) {
    if (date === state.date && meal === state.meal) return;
    state.date = date;
    state.meal = meal;
    dom.dateInput.value = date;
    writeUrl();
    resetView();
    render();
    if (state.started) load();
  }

  function setUser(user) {
    const previous = state.user;
    const previousUid = previous ? previous.uid : null;
    const nextUid = user ? user.uid : null;
    state.user = user;
    if (previous !== undefined && previousUid === nextUid) return;
    state.tokenRejected = false;
    // Signed-out data is safe to keep while the first auth answer lands. Any
    // real change of account must not show the old account's place in line.
    if (previous === undefined && !user && state.snapshot) {
      render();
      return;
    }
    resetView();
    state.started = true;
    render();
    load();
  }

  // Rendering

  function renderControls() {
    const today = (state.snapshot && state.snapshot.today) || seoulToday();
    dom.title.textContent = MEAL_LABELS[state.meal];
    dom.dateLabel.textContent = longDate(state.date);
    // A poll must not wipe a date someone is partway through typing.
    if (document.activeElement !== dom.dateInput) dom.dateInput.value = state.date;
    dom.today.hidden = state.date === today;

    dom.meal.querySelectorAll(".segmented-option").forEach((option) => {
      const active = option.dataset.value === state.meal;
      option.classList.toggle("segmented-option--active", active);
      option.setAttribute("aria-pressed", String(active));
    });

    const available = languagesWithText(state.snapshot);
    const shownLanguage = available.has(state.lang) ? state.lang : [...available][0];
    dom.lang.hidden = available.size === 0;
    dom.lang.querySelectorAll(".segmented-option").forEach((option) => {
      const language = option.dataset.value;
      const active = language === shownLanguage;
      option.disabled = !available.has(language);
      option.classList.toggle("segmented-option--active", active);
      option.setAttribute("aria-pressed", String(active));
    });
  }

  function languagesWithText(snapshot) {
    const found = new Set();
    if (!snapshot) return found;
    [...usableOptions(snapshot), ...usableExtras(snapshot)].forEach((entry) => {
      ["en", "ko"].forEach((language) => {
        if (entry.menu && isPrinted(entry.menu[language])) found.add(language);
      });
    });
    return found;
  }

  // The server already filters these. Rechecked because offering a choice that
  // has no printed food is the one mistake this page must not make.
  function usableOptions(snapshot) {
    return snapshot.options
      .filter((option) => (option.id === "A" || option.id === "B") && pickBlock(option.menu, "en"))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function usableExtras(snapshot) {
    return Array.isArray(snapshot.extras) ? snapshot.extras.filter((extra) => pickBlock(extra.menu, "en")) : [];
  }

  function renderNotices(snapshot) {
    const nodes = [];
    if (!state.authUsable) {
      nodes.push(el("p", "menu-notice", "Sign-in could not load on this network, so you can read the menu but can't join a line."));
    } else if (state.tokenRejected) {
      nodes.push(el("p", "menu-notice", "Your sign-in could not be confirmed. Sign out and sign in again to join a line."));
    }
    if (state.refreshFailedAt) {
      const shown = snapshot ? clockTime(snapshot.updatedAt) : null;
      const message = shown
        ? `Could not refresh. These counts are from ${shown}. Retrying.`
        : "Could not refresh. These counts may be out of date. Retrying.";
      nodes.push(el("p", "menu-notice", message));
    }
    if (state.actionError) {
      const alert = el("p", "menu-notice menu-notice--alert", state.actionError);
      alert.setAttribute("role", "alert");
      nodes.push(alert);
    }
    if (snapshot && usableOptions(snapshot).length > 0 && !snapshot.canChoose) {
      if (snapshot.date > snapshot.today) nodes.push(el("p", "menu-notice", "Choosing opens on the day of the meal."));
      else if (snapshot.date < snapshot.today) nodes.push(el("p", "menu-notice", "This meal has passed. These are the final choices."));
      else nodes.push(el("p", "menu-notice", "Choosing is closed for this meal right now."));
    }
    // Reinserting an alert makes a screen reader read it again on every poll.
    const key = nodes.map((node) => node.className + node.textContent).join("|");
    if (key === state.lastNotices) return;
    state.lastNotices = key;
    dom.notices.replaceChildren(...nodes);
  }

  function buildEmpty(title, body) {
    const panel = el("section", "menu-empty");
    panel.appendChild(el("h2", "menu-empty-title", title));
    if (body) panel.appendChild(el("p", "menu-empty-body", body));
    return panel;
  }

  function buildLoading() {
    const panel = el("section", "menu-empty menu-loading");
    panel.appendChild(el("span", "menu-spinner"));
    panel.appendChild(el("span", null, "Loading the menu"));
    return panel;
  }

  function buildLoadError() {
    const panel = buildEmpty("Could not load this menu", state.loadError);
    panel.appendChild(
      button("Try again", "primary", () => {
        state.loadError = null;
        state.failures = 0;
        state.retryAfterSeconds = null;
        render();
        load();
      })
    );
    return panel;
  }

  function buildEmptyMenu(snapshot) {
    if (!snapshot.menuAvailable) {
      return buildEmpty(
        "This week's menu isn't published yet",
        "It appears here once the school posts it. There is nothing to choose for this date until then."
      );
    }
    if (snapshot.closure) {
      return buildEmpty("Cafeteria closed", "The published menu marks the cafeteria as closed for this meal.");
    }
    return buildEmpty("No menu printed for this meal", "The published menu leaves this meal blank, so there is nothing to choose.");
  }

  function pendingLabel(action) {
    if (action === "leave") return "Leaving";
    if (action === "served") return "Saving";
    return "Joining";
  }

  function buildTicket(snapshot) {
    const mine = snapshot.myChoice;
    if (!mine) return null;
    const isToday = snapshot.date === snapshot.today;
    const ended = clockTime(mine.expiresAt);
    const ticket = el("section", "menu-ticket");
    ticket.tabIndex = -1;
    ticket.id = "menu-ticket";
    const text = el("div");
    ticket.appendChild(text);

    if (mine.status === "queued") {
      ticket.classList.add("menu-ticket--queued");
      text.appendChild(el("h2", "menu-ticket-title", `You are in line for Menu ${mine.option}`));
      const figures = el("div", "menu-ticket-figures");
      if (Number.isFinite(mine.position)) {
        const place = el("span", "menu-ticket-figure");
        place.appendChild(el("strong", null, String(mine.position)));
        const ahead = mine.position - 1;
        place.appendChild(document.createTextNode(ahead === 0 ? "in line, no one ahead of you" : `in line, ${ahead} ahead of you`));
        figures.appendChild(place);
      }
      const wait = waitParts(mine.estimatedWaitSeconds);
      if (wait) {
        const time = el("span", "menu-ticket-figure");
        time.appendChild(el("strong", null, wait.value));
        time.appendChild(document.createTextNode(`${wait.unit} estimated wait`));
        figures.appendChild(time);
      }
      text.appendChild(figures);
      if (ended) text.appendChild(el("p", "menu-ticket-note", `Your place is held until ${ended}.`));

      const pending = state.pending;
      const actions = el("div", "menu-ticket-actions");
      actions.appendChild(
        button(pending && pending.action === "served" ? pendingLabel("served") : "Got my meal", "primary", markServed, pending, "served")
      );
      actions.appendChild(
        button(pending && pending.action === "leave" ? pendingLabel("leave") : "Leave line", "secondary", leaveLine, pending, "leave")
      );
      ticket.appendChild(actions);
      return ticket;
    }

    if (mine.status === "served") {
      text.appendChild(el("h2", "menu-ticket-title", `You got your meal from Menu ${mine.option}`));
      return ticket;
    }

    if (!isToday) {
      text.appendChild(el("h2", "menu-ticket-title", `You chose Menu ${mine.option}`));
      return ticket;
    }

    if (mine.status === "left") {
      text.appendChild(el("h2", "menu-ticket-title", `You left the line for Menu ${mine.option}`));
      text.appendChild(el("p", "menu-ticket-note", "Your choice still counts. Join a line below if you change your mind."));
    } else if (mine.status === "expired") {
      text.appendChild(el("h2", "menu-ticket-title", `Your place in line for Menu ${mine.option} ended`));
      text.appendChild(
        el("p", "menu-ticket-note", `${ended ? `It ended at ${ended}. ` : ""}Your choice still counts. Join a line below if you still need a meal.`)
      );
    } else if (mine.status === "unavailable") {
      text.appendChild(el("h2", "menu-ticket-title", `Menu ${mine.option} is no longer on the published menu`));
      text.appendChild(el("p", "menu-ticket-note", "Your place in that line ended. Choose again below."));
    } else {
      return null;
    }
    return ticket;
  }

  function buildLineAction(snapshot, option) {
    if (!snapshot.canChoose) return null;
    const mine = snapshot.myChoice;
    const id = option.id;
    const wrap = el("div", "menu-line-action");
    if (mine && mine.status === "served") return null;
    if (mine && mine.status === "queued" && mine.option === id) {
      wrap.appendChild(el("p", "menu-line-here", "You are in this line"));
      return wrap;
    }
    if (state.user === undefined) {
      wrap.appendChild(button("Checking sign-in", "primary", null, true));
      return wrap;
    }
    if (!state.user) {
      if (state.authUsable) wrap.appendChild(button(`Sign in to choose ${id}`, "primary", startSignIn, false, `signin-${id}`));
      else wrap.appendChild(button("Sign-in unavailable", "primary", null, true));
      return wrap;
    }

    const pending = state.pending;
    const thisPending = pending && pending.action === "choose" && pending.option === id;
    const focusKey = `choose-${id}`;
    const onClick = () => chooseOption(id);
    if (mine && mine.status === "queued") {
      wrap.appendChild(button(thisPending ? "Switching" : `Switch to ${id}`, "secondary", onClick, pending, focusKey));
      wrap.appendChild(el("p", "menu-line-hint", `Moves you to the back of line ${id}.`));
    } else if (mine && mine.option === id && mine.status !== "unavailable") {
      wrap.appendChild(button(thisPending ? pendingLabel("choose") : `Rejoin line ${id}`, "primary", onClick, pending, focusKey));
    } else {
      wrap.appendChild(button(thisPending ? pendingLabel("choose") : `Choose ${id} and join line`, "primary", onClick, pending, focusKey));
    }
    return wrap;
  }

  function buildLine(snapshot, option) {
    const mine = snapshot.myChoice;
    const isToday = snapshot.date === snapshot.today;
    const isPast = snapshot.date < snapshot.today;
    const mineHere = Boolean(mine && mine.option === option.id);
    const queuedHere = mineHere && mine.status === "queued";

    const line = el("article", "menu-line");
    const dishes = el("div", "menu-line-dishes");
    const heading = el("h2", "menu-line-name", `Menu ${option.id}`);
    if (mineHere) heading.appendChild(el("span", "menu-line-tag", "Your choice"));
    dishes.appendChild(heading);
    const selection = pickBlock(option.menu, state.lang);
    dishes.appendChild(buildDishes(selection));
    if (selection.fallback) {
      dishes.appendChild(el("p", "menu-lang-note", `Printed in ${LANGUAGE_NAMES[selection.language]} only.`));
    }
    line.appendChild(dishes);

    const queue = el("div", "menu-line-queue");
    if (isToday) {
      const position = queuedHere && Number.isFinite(mine.position) ? mine.position : null;
      queue.appendChild(buildTicks(option.queueCount, position));
      const stats = el("dl", "menu-stats");
      const seconds = queuedHere ? mine.estimatedWaitSeconds : option.estimatedWaitSeconds;
      const wait = waitParts(seconds);
      stats.appendChild(buildStat(queuedHere ? "Your wait" : "Wait if you join", wait ? wait.value : "-", wait ? wait.unit : null));
      stats.appendChild(buildStat("In line", String(option.queueCount)));
      stats.appendChild(buildStat("Chose this", String(option.choiceCount)));
      queue.appendChild(stats);
    } else if (isPast) {
      const stats = el("dl", "menu-stats");
      stats.appendChild(buildStat("Chose this", String(option.choiceCount)));
      queue.appendChild(stats);
    }
    const action = buildLineAction(snapshot, option);
    if (action) queue.appendChild(action);
    if (queue.children.length > 0) line.appendChild(queue);
    return line;
  }

  function buildExtras(snapshot) {
    const extras = usableExtras(snapshot);
    if (extras.length === 0) return null;
    const section = el("section", "menu-extras");
    section.setAttribute("aria-label", "Also served");
    extras.forEach((extra) => {
      const selection = pickBlock(extra.menu, state.lang);
      const block = el("div");
      block.appendChild(el("h3", "menu-extra-name", EXTRA_LABELS[extra.id] || "Also served"));
      block.appendChild(buildDishes(selection));
      if (selection.fallback) {
        block.appendChild(el("p", "menu-lang-note", `Printed in ${LANGUAGE_NAMES[selection.language]} only.`));
      }
      section.appendChild(block);
    });
    return section;
  }

  function estimateAssumption(options) {
    const rates = [...new Set(options.map((option) => option.serviceSecondsPerPerson).filter(Number.isFinite))];
    if (rates.length === 0) return "";
    if (rates.length === 1) return `It assumes ${rates[0]} seconds per person.`;
    const each = options.map((option) => `${option.serviceSecondsPerPerson} for line ${option.id}`).join(" and ");
    return `It assumes ${each}, in seconds per person.`;
  }

  function buildEstimateNote(snapshot, options) {
    if (options.length === 0 || snapshot.date !== snapshot.today) return null;
    const details = el("details", "menu-estimate");
    details.open = state.estimateOpen;
    details.addEventListener("toggle", () => {
      state.estimateOpen = details.open;
    });
    details.appendChild(el("summary", null, "Estimate based on students who joined here"));
    const measured = options.every((option) => option.estimateCalibrated === true);
    const parts = [
      estimateAssumption(options),
      measured ? "That rate comes from measured service times." : "That rate is an assumption, not a measurement.",
      "Students waiting at the counter who didn't join here aren't counted, so the real line can be longer.",
    ];
    details.appendChild(el("p", "menu-estimate-body", parts.filter(Boolean).join(" ")));
    return details;
  }

  function buildFoot(snapshot, options) {
    const foot = el("footer", "menu-foot");
    foot.appendChild(buildEstimateNote(snapshot, options) || el("span"));

    const meta = el("div", "menu-foot-meta");
    const stamp = el("p");
    stamp.id = "menu-updated";
    meta.appendChild(stamp);
    if (snapshot.source) {
      const url = safeSourceUrl(snapshot.source.url);
      const label = snapshot.source.title || "School menu post";
      const line = el("p");
      if (url) {
        const link = el("a", null, label);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        line.appendChild(link);
      } else {
        line.textContent = label;
      }
      meta.appendChild(line);
    }
    foot.appendChild(meta);
    return foot;
  }

  function buildSnapshotBody(snapshot) {
    const nodes = [];
    const options = usableOptions(snapshot);
    const ticket = buildTicket(snapshot);
    if (ticket) nodes.push(ticket);
    if (options.length === 0) {
      nodes.push(buildEmptyMenu(snapshot));
    } else {
      const lines = el("div", "menu-lines");
      if (options.length === 1) lines.classList.add("menu-lines--single");
      options.forEach((option) => lines.appendChild(buildLine(snapshot, option)));
      nodes.push(lines);
    }
    const extras = buildExtras(snapshot);
    if (extras) nodes.push(extras);
    nodes.push(buildFoot(snapshot, options));
    return nodes;
  }

  // A poll usually changes nothing. Skipping the rebuild keeps keyboard focus,
  // text selection, and screen readers undisturbed. updatedAt moves on every
  // poll, so it is left out and its one line is updated on its own.
  function bodySignature(snapshot) {
    return JSON.stringify([
      snapshot ? { ...snapshot, updatedAt: null } : null,
      state.loadError,
      state.lang,
      state.pending,
      state.user === undefined ? "unknown" : state.user ? state.user.uid : null,
      state.authUsable,
    ]);
  }

  function renderUpdatedStamp(snapshot) {
    const stamp = document.getElementById("menu-updated");
    if (!stamp) return;
    const updated = snapshot ? clockTime(snapshot.updatedAt) : null;
    stamp.textContent = updated ? `Updated ${updated}` : "";
  }

  function renderBody(snapshot) {
    const active = document.activeElement;
    const focusKey = (active && active.dataset && active.dataset.focusKey) || state.restoreFocusKey;
    let nodes;
    if (snapshot) nodes = buildSnapshotBody(snapshot);
    else if (state.loadError) nodes = [buildLoadError()];
    else nodes = [buildLoading()];
    dom.body.replaceChildren(...nodes);
    dom.body.setAttribute("aria-busy", String(!snapshot && !state.loadError));

    if (snapshot && state.enterNext) {
      state.enterNext = false;
      dom.body.classList.remove("menu-body--enter");
      void dom.body.offsetWidth;
      dom.body.classList.add("menu-body--enter");
    }

    state.restoreFocusKey = null;
    if (state.focusTicketNext) {
      state.focusTicketNext = false;
      const ticket = document.getElementById("menu-ticket");
      if (ticket) ticket.focus();
      return;
    }
    if (!focusKey) return;
    const again = dom.body.querySelector(`[data-focus-key="${focusKey}"]`);
    // Disabled while a request runs, so focus returns once it finishes.
    if (again && again.disabled) state.restoreFocusKey = focusKey;
    else if (again) again.focus();
  }

  function render() {
    const snapshot = state.snapshot;
    renderControls();
    renderNotices(snapshot);
    const signature = bodySignature(snapshot);
    if (signature !== state.lastSignature) {
      state.lastSignature = signature;
      renderBody(snapshot);
    }
    renderUpdatedStamp(snapshot);
  }

  // Wiring

  function readLanguage() {
    let saved = null;
    try {
      saved = localStorage.getItem(LANGUAGE_KEY);
    } catch (error) {
      saved = null;
    }
    if (saved === "en" || saved === "ko") return saved;
    return (navigator.language || "").toLowerCase().startsWith("ko") ? "ko" : "en";
  }

  function wireControls() {
    dom.dateInput.addEventListener("change", () => {
      if (isValidDate(dom.dateInput.value)) selectView(dom.dateInput.value, state.meal);
      else dom.dateInput.value = state.date;
    });
    dom.prevDay.addEventListener("click", () => selectView(addDays(state.date, -1), state.meal));
    dom.nextDay.addEventListener("click", () => selectView(addDays(state.date, 1), state.meal));
    dom.today.addEventListener("click", () => selectView((state.snapshot && state.snapshot.today) || seoulToday(), state.meal));
    dom.meal.addEventListener("click", (event) => {
      const option = event.target.closest(".segmented-option");
      if (option) selectView(state.date, option.dataset.value);
    });
    dom.lang.addEventListener("click", (event) => {
      const option = event.target.closest(".segmented-option");
      if (!option || option.disabled || option.dataset.value === state.lang) return;
      state.lang = option.dataset.value;
      try {
        localStorage.setItem(LANGUAGE_KEY, state.lang);
      } catch (error) {
        // Storage is optional.
      }
      render();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // A running mutation still has to finish and report back.
        if (!state.pending) abortCurrent();
      } else if (state.started && !state.pending) {
        load();
      }
    });
    window.addEventListener("online", () => {
      if (state.started && !state.pending) load();
    });
    // The date label follows the saved date format.
    window.addEventListener("app:preferences-changed", () => {
      if (state.date) renderControls();
    });
  }

  function wireAuth() {
    let authInstance = null;
    try {
      authInstance = firebase.auth();
    } catch (error) {
      // A network filter can block the Firebase script. The menu is still public.
      authInstance = null;
    }
    if (!authInstance) {
      state.authUsable = false;
      setUser(null);
      return;
    }
    authInstance.onAuthStateChanged(setUser);
    setTimeout(() => {
      if (state.started) return;
      state.started = true;
      load();
    }, AUTH_WAIT_MS);
  }

  function start() {
    const params = new URLSearchParams(location.search);
    const date = params.get("date");
    const meal = params.get("meal");
    state.date = isValidDate(date) ? date : seoulToday();
    state.meal = MEALS.includes(meal) ? meal : defaultMeal();
    state.lang = readLanguage();
    writeUrl();

    // Keeps the open tab in view where the bar scrolls sideways on a phone.
    const activeTab = document.querySelector(".tab-bar .tab--active");
    if (activeTab) activeTab.scrollIntoView({ block: "nearest", inline: "center" });

    wireControls();
    render();
    wireAuth();
  }

  start();
})();
