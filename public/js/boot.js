// Actually starts the app. The very last script loaded on every data page
// (after shared.js and the page-specific file): initPage() below, reached
// via handleAuthResolved(), calls whichever of initMyCoursesPage/
// initDomainPage/initGpaPage that page-specific file defined.
//
// Built around Firestore's real-time listener (onSnapshot) rather than a
// one-off .get(): every callback carries real metadata (fromCache,
// hasPendingWrites) saying definitively whether a value is confirmed by
// the server or just a local echo of an in-flight write. Not used as a
// perpetual live subscription, though — pages are built once from appData
// at load time, so the listener just waits for one trustworthy snapshot
// and then stops.

// Resolves with the first snapshot of users/{uid} Firestore confirms is
// real — not from cache, not an echo of a write still in flight — then
// stops listening. Rejects if none arrives within timeoutMs.
function waitForConfirmedUserDoc(uid, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error("Timed out waiting for a confirmed Firestore read"));
    }, timeoutMs);

    const unsubscribe = firebase
      .firestore()
      .collection("users")
      .doc(uid)
      .onSnapshot(
        (snapshot) => {
          if (settled || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(snapshot);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        }
      );
  });
}

// Turns a raw Firestore document (or {} if it doesn't exist) into the
// shape appData is always expected to have, with every field defaulted.
// Returns a Promise since the three grade fields need decrypting (see
// encryption.js) — key is this device's own AES-GCM key.
function normalizeCloudData(cloud, key) {
  return Promise.all([
    decryptValue(key, cloud.domainSnapshot, []),
    decryptValue(key, cloud.gpaClasses, []),
    decryptValue(key, cloud.domainScores, {}),
  ]).then(([domainSnapshot, gpaClasses, domainScores]) => ({
    periods: cloud.periods || [],
    periodDivisions: cloud.periodDivisions || [],
    hiddenCourses: cloud.hiddenCourses || [],
    addedAssessments: cloud.addedAssessments || [],
    domainSnapshot,
    gpaClasses,
    domainScores,
    // Round-tripped (never edited from this file) so pushDataToCloud()'s
    // plain .set() elsewhere doesn't wipe out preferences/email.
    preferences: cloud.preferences || {},
    email: cloud.email || "",
    lastModified: cloud.lastModified || 0,
  }));
}

// Signed-out edits are normally just in-memory scratch work, lost on
// navigation — but signing in shouldn't discard it if there's somewhere
// new for it to go (a brand-new account with nothing of its own yet).
// Stashed in localStorage since signing in triggers a full page reload.
// Cleared the moment it's read back — a one-shot carry-over.
const PENDING_ANONYMOUS_DATA_KEY = "pendingAnonymousData";

function appDataIsEmpty(data) {
  return (
    (data.periods || []).every((name) => !name || name.trim() === "") &&
    (data.domainSnapshot || []).length === 0 &&
    (data.gpaClasses || []).length === 0 &&
    Object.keys(data.domainScores || {}).length === 0 &&
    (data.hiddenCourses || []).length === 0 &&
    (data.addedAssessments || []).length === 0
  );
}

function writePendingAnonymousData(data) {
  try {
    // Just the fields a signed-out session could have touched —
    // preferences/email/lastModified aren't scratch work to carry over.
    const { periods, periodDivisions, hiddenCourses, domainSnapshot, gpaClasses, domainScores } = data;
    localStorage.setItem(
      PENDING_ANONYMOUS_DATA_KEY,
      JSON.stringify({ periods, periodDivisions, hiddenCourses, domainSnapshot, gpaClasses, domainScores })
    );
  } catch (error) {
    // ignore — a nice-to-have, not something sign-in should be blocked by
  }
}

function readAndClearPendingAnonymousData() {
  try {
    const raw = localStorage.getItem(PENDING_ANONYMOUS_DATA_KEY);
    localStorage.removeItem(PENDING_ANONYMOUS_DATA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

const guessedUid = readLastKnownUid();
if (guessedUid) {
  const guessedCache = readCachedAppData(guessedUid);
  if (guessedCache) {
    currentUid = guessedUid;
    appData = guessedCache;
    hasInitializedPage = true;
    initPage();
  }
}

// Firebase persists auth across reloads, so on every page load (a
// multi-page site) this fires again for an already-signed-in user.
if (typeof firebase !== "undefined" && firebase.auth) {
  firebase.auth().onAuthStateChanged((user) => {
    const resolvedUid = user ? user.uid : null;

    // Signed out: appData resets empty, this device's cache and the
    // last-known-uid marker are dropped (a shared-computer privacy
    // measure), and the page renders blank.
    if (!user) {
      if (currentUid) localStorage.removeItem(cacheKeyFor(currentUid));
      clearLastKnownUid();
      currentUid = null;
      resetAppData();
      handleAuthResolved();
      return;
    }

    // currentUid !== resolvedUid (not currentUid && currentUid !== resolvedUid)
    // deliberately, so this also catches currentUid being null — the page
    // rendered signed out and is now signing in. Reload rather than
    // reconcile in place, so currentUid and appData only ever change
    // together, right before a fresh render.
    if (hasInitializedPage && currentUid !== resolvedUid) {
      // Only signing IN (not switching accounts), and only if there's
      // something worth saving.
      if (!currentUid && !appDataIsEmpty(appData)) {
        writePendingAnonymousData(appData);
      }
      writeLastKnownUid(resolvedUid);
      handleAuthResolved(); // hasInitializedPage is already true -> reloads
      return;
    }

    currentUid = resolvedUid;
    writeLastKnownUid(resolvedUid);
    clearOtherCachedAppData(resolvedUid);
    const cached = readCachedAppData(resolvedUid);

    // Renders the cache immediately so there's something on screen right
    // away — never treated as final. The confirmed snapshot below always
    // follows up and decides what appData ends up being.
    if (cached && !hasInitializedPage) {
      appData = cached;
      handleAuthResolved();
    }

    // 8000ms — a buffer above what a normal confirmed read actually takes
    // (well under 5s), so this should only bind on a genuinely struggling
    // connection.
    waitForConfirmedUserDoc(resolvedUid, 8000)
      .then((snapshot) => {
        const cloud = snapshot.exists ? snapshot.data() : {};
        // Blocks on a mandatory decryption-code prompt (see encryption.js)
        // only if this device doesn't already have the key and there's
        // real encrypted data to be locked out of.
        return resolveDeviceKeyForBoot(resolvedUid, cloud).then((key) => normalizeCloudData(cloud, key));
      })
      .then((fresh) => {
        // A brand-new, confirmed-empty account inherits whatever was
        // typed anonymously on this device just before signing in.
        const pending = readAndClearPendingAnonymousData();
        if (pending && appDataIsEmpty(fresh)) {
          appData = { ...fresh, ...pending };
          writeCachedAppData(resolvedUid, appData);
          pushDataToCloud();
          handleAuthResolved();
          return;
        }

        // Compare only the actual data, not lastModified — two writes can
        // land at different times even when nothing meaningful changed.
        // Purely to skip a redundant re-render; a confirmed snapshot is
        // always applied regardless.
        const { lastModified: freshModified, ...freshData } = fresh;
        const { lastModified: cachedModified, ...cachedData } = cached || {};
        if (cached && deepEqual(freshData, cachedData)) return;

        appData = fresh;
        writeCachedAppData(resolvedUid, fresh);
        handleAuthResolved();
      })
      .catch((error) => {
        // If we already rendered from cache, leave it be. If not, there's
        // nothing to show but empty.
        console.error("[boot] Failed to confirm Firestore data:", error);
        if (!cached && !hasInitializedPage) {
          resetAppData();
          // resetAppData() blanks email too, but this device is still
          // genuinely signed in — Firebase Auth already knows the real
          // one, independent of the Firestore read that just failed.
          appData.email = user.email || "";
          handleAuthResolved();
        }
      });
  });
} else {
  // Firebase didn't load — only render if the optimistic guess above didn't.
  if (!hasInitializedPage) initPage();
}
