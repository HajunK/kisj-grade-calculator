// Site preferences: appearance (light/dark/system), date format, whether
// the FA/SA/D breakdown line shows, whether a new Formative starts linked
// to its Summative by default, and whether animations play at all. Loaded
// right after firebase-config.js so cached preferences apply before the
// rest of the page builds.
//
// Signed in, preferences live under their own "preferences" field on the
// user's Firestore doc, written with merge so this never touches the rest
// of the user's data. Signed out, they're kept in localStorage under
// PREFS_ANON_KEY instead, scoped to this device.

const DEFAULT_PREFERENCES = {
  appearance: "system", // "light" | "dark" | "system"
  dateFormat: "monthDay", // "monthDay" ("Aug 16") | "numeric" ("8/16") | "dayMonth" ("16 Aug") | "numericEU" ("16/8")
  showBreakdown: true, // the FA/SA/D line on Domain class cards
  showUpcomingAssessments: true, // the "Upcoming ...:" line on Domain class cards
  replaceFormativesByDefault: true, // a newly-qualifying Formative starts linked to its Summative
  animationsEnabled: true,
};

const PREFS_CACHE_PREFIX = "prefs_";
const PREFS_ANON_KEY = "prefs_anon";
const PREFS_LAST_UID_KEY = "lastKnownUid"; // same key app.js reads/writes
const APP_DATA_CACHE_PREFIX = "cachedAppData_"; // same key app.js reads/writes

function prefsCacheKeyFor(uid) {
  return PREFS_CACHE_PREFIX + uid;
}

const DATE_FORMAT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

window.formatPreferredDate = function formatPreferredDate(date, formatOverride) {
  const format = formatOverride || currentPrefs.dateFormat;
  const month = DATE_FORMAT_MONTHS[date.getMonth()];
  const day = date.getDate();
  const monthNum = date.getMonth() + 1;
  switch (format) {
    case "numeric":
      return `${monthNum}/${day}`;
    case "dayMonth":
      return `${day} ${month}`;
    case "numericEU":
      return `${day}/${monthNum}`;
    case "monthDay":
    default:
      return `${month} ${day}`;
  }
};

// Stored as { prefs, modified } — modified guards against a stale
// confirmation fetch overwriting a just-applied change (see below).
function readCachedPrefs(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.prefs && typeof parsed.prefs === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

function writeCachedPrefs(key, prefs, modified) {
  try {
    localStorage.setItem(key, JSON.stringify({ prefs, modified }));
  } catch (error) {
    // ignore — cache is optional
  }
}

// "system" defers to the OS — see watchSystemTheme below for what keeps
// this in sync while the page stays open.
function resolveTheme(appearance) {
  if (appearance === "dark") return "dark";
  if (appearance === "light") return "light";
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Settings.js listens for this to re-sync its controls once the real
// confirmed preferences come back (sign-in) or revert (sign-out).
function notifyPreferencesChanged() {
  window.dispatchEvent(new CustomEvent("app:preferences-changed"));
}

function applyPreferences(prefs) {
  document.documentElement.dataset.theme = resolveTheme(prefs.appearance);
  if (prefs.showBreakdown === false) {
    document.documentElement.dataset.hideBreakdown = "true";
  } else {
    delete document.documentElement.dataset.hideBreakdown;
  }
  if (prefs.showUpcomingAssessments === false) {
    document.documentElement.dataset.hideUpcomingAssessments = "true";
  } else {
    delete document.documentElement.dataset.hideUpcomingAssessments;
  }
}

// Re-applies the resolved theme the moment the OS setting changes, while
// appearance is "system". Torn down/rebuilt on every preferences change.
let systemThemeQuery = null;
function onSystemThemeChange() {
  document.documentElement.dataset.theme = resolveTheme("system");
  if (typeof window.refreshGradeIcons === "function") window.refreshGradeIcons();
}
function watchSystemTheme(appearance) {
  if (systemThemeQuery) {
    systemThemeQuery.removeEventListener("change", onSystemThemeChange);
    systemThemeQuery = null;
  }
  if (appearance !== "system" || !window.matchMedia) return;
  systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeQuery.addEventListener("change", onSystemThemeChange);
}

// The appData cache used elsewhere round-trips whatever "preferences" it
// last fetched, and re-uploads it verbatim on every unrelated save (a
// plain, non-merge .set()) — updating it here too keeps that from stomping
// this change back to its old value.
function syncAppDataCache(uid, prefs, timestamp) {
  try {
    const key = APP_DATA_CACHE_PREFIX + uid;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const cached = JSON.parse(raw);
    cached.preferences = { ...prefs, modified: timestamp };
    cached.lastModified = timestamp;
    localStorage.setItem(key, JSON.stringify(cached));
  } catch (error) {
    // ignore
  }
}

let prefsUid = null;
try {
  prefsUid = localStorage.getItem(PREFS_LAST_UID_KEY);
} catch (error) {
  prefsUid = null;
}

// Best guess, applied synchronously before Firebase has even loaded.
// appliedPrefsModified tracks how recent that guess is, so the confirmation
// fetch below can tell a genuinely newer read apart from a stale one. No
// known uid falls back to the anonymous local preferences.
const initialCached = (prefsUid && readCachedPrefs(prefsCacheKeyFor(prefsUid))) || readCachedPrefs(PREFS_ANON_KEY);
let currentPrefs = { ...DEFAULT_PREFERENCES, ...(initialCached ? initialCached.prefs : null) };
let appliedPrefsModified = initialCached ? initialCached.modified || 0 : 0;

applyPreferences(currentPrefs);
watchSystemTheme(currentPrefs.appearance);

window.getPreferences = function getPreferences() {
  return { ...currentPrefs };
};

window.animationsEnabled = function animationsEnabled() {
  return currentPrefs.animationsEnabled !== false;
};

window.setPreference = function setPreference(key, value) {
  currentPrefs = { ...currentPrefs, [key]: value };
  applyPreferences(currentPrefs);
  watchSystemTheme(currentPrefs.appearance);
  if (typeof window.refreshGradeIcons === "function") window.refreshGradeIcons();

  if (!prefsUid || typeof firebase === "undefined" || !firebase.firestore) {
    // Not signed in — keep it locally, scoped to this device.
    writeCachedPrefs(PREFS_ANON_KEY, currentPrefs, Date.now());
    return;
  }

  const timestamp = Date.now();
  appliedPrefsModified = timestamp;
  writeCachedPrefs(prefsCacheKeyFor(prefsUid), currentPrefs, timestamp);
  syncAppDataCache(prefsUid, currentPrefs, timestamp);
  firebase
    .firestore()
    .collection("users")
    .doc(prefsUid)
    .set({ preferences: { ...currentPrefs, modified: timestamp }, lastModified: timestamp }, { merge: true })
    .catch((error) => console.error("Failed to save preferences:", error));
};

if (typeof firebase !== "undefined" && firebase.auth) {
  firebase.auth().onAuthStateChanged((user) => {
    if (!user) {
      prefsUid = null;
      appliedPrefsModified = 0;
      // Revert to this browser's own anonymous preferences, not the defaults.
      const anon = readCachedPrefs(PREFS_ANON_KEY);
      currentPrefs = { ...DEFAULT_PREFERENCES, ...(anon ? anon.prefs : null) };
      applyPreferences(currentPrefs);
      watchSystemTheme(currentPrefs.appearance);
      if (typeof window.refreshGradeIcons === "function") window.refreshGradeIcons();
      notifyPreferencesChanged();
      return;
    }

    prefsUid = user.uid;
    firebase
      .firestore()
      .collection("users")
      .doc(user.uid)
      // source: "server" — a plain .get() right after sign-in can be
      // satisfied from Firestore's local cache before the real doc has
      // synced down, making this look like a user with no saved
      // preferences at all.
      .get({ source: "server" })
      .then((snapshot) => {
        const cloud = snapshot.exists ? snapshot.data() : {};
        const cloudPrefs = cloud.preferences || {};
        const confirmedModified = cloudPrefs.modified || 0;

        // This read can race a write already in flight from this device —
        // only trust it if it's not older than what's already applied.
        if (confirmedModified < appliedPrefsModified) return;

        const { modified, ...rest } = cloudPrefs;
        const confirmed = { ...DEFAULT_PREFERENCES, ...rest };
        appliedPrefsModified = confirmedModified;
        writeCachedPrefs(prefsCacheKeyFor(user.uid), confirmed, confirmedModified);
        currentPrefs = confirmed;
        applyPreferences(currentPrefs);
        watchSystemTheme(currentPrefs.appearance);
        if (typeof window.refreshGradeIcons === "function") window.refreshGradeIcons();
        notifyPreferencesChanged();
      })
      .catch((error) => console.error("Failed to load preferences:", error));
  });
}
