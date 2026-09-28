// Shared across My Courses and Domain: fetches the school-wide assessments
// collection once per page load and exposes lookup helpers built on top.

let allAssessments = [];
// True once there's something to show, from cache or a real fetch — kept
// separate from assessmentsFetchDone so a cache hit can render instantly.
let assessmentsLoaded = false;
let assessmentsFetchDone = false;
const assessmentsLoadListeners = [];

// School-wide, not per-user, so one plain key is enough.
const ASSESSMENTS_CACHE_KEY = "cachedAssessments";

function readCachedAssessments() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSESSMENTS_CACHE_KEY));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedAssessments(data) {
  try {
    localStorage.setItem(ASSESSMENTS_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded, private browsing, etc. — cache is optional.
  }
}

// Calls back as soon as there's something to show (cached or fetched). If
// the first call was from cache, it's queued to fire again once the real
// fetch completes.
function loadAssessments(callback) {
  if (assessmentsLoaded) callback(allAssessments);
  if (!assessmentsFetchDone) assessmentsLoadListeners.push(callback);
}

function fetchAssessments() {
  if (typeof firebase === "undefined" || !firebase.firestore) return;
  firebase
    .firestore()
    .collection("assessments")
    .get()
    .then((snapshot) => {
      allAssessments = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      assessmentsLoaded = true;
      assessmentsFetchDone = true;
      writeCachedAssessments(allAssessments);
      assessmentsLoadListeners.splice(0).forEach((callback) => callback(allAssessments));
    })
    .catch((error) => console.error("Failed to load assessments:", error));
}

const cachedAssessments = readCachedAssessments();
if (cachedAssessments) {
  allAssessments = cachedAssessments;
  assessmentsLoaded = true;
}

// School-wide too — which days are A-days vs B-days, set by admins on the
// Assessments page. A date with no entry here is unset ("?"), and counts
// as visible to everyone.
let allDayTypes = {}; // ISO date -> "A" | "B"
let dayTypesLoaded = false;
let dayTypesFetchDone = false;
const dayTypesLoadListeners = [];

const DAY_TYPES_CACHE_KEY = "cachedDayTypes";

function readCachedDayTypes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DAY_TYPES_CACHE_KEY));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedDayTypes(data) {
  try {
    localStorage.setItem(DAY_TYPES_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded, private browsing, etc. — cache is optional.
  }
}

function loadDayTypes(callback) {
  if (dayTypesLoaded) callback(allDayTypes);
  if (!dayTypesFetchDone) dayTypesLoadListeners.push(callback);
}

function fetchDayTypes() {
  if (typeof firebase === "undefined" || !firebase.firestore) return;
  firebase
    .firestore()
    .collection("dayTypes")
    .get()
    .then((snapshot) => {
      allDayTypes = {};
      snapshot.docs.forEach((doc) => {
        allDayTypes[doc.id] = doc.data().type;
      });
      dayTypesLoaded = true;
      dayTypesFetchDone = true;
      writeCachedDayTypes(allDayTypes);
      dayTypesLoadListeners.splice(0).forEach((callback) => callback(allDayTypes));
    })
    .catch((error) => console.error("Failed to load day types:", error));
}

const cachedDayTypes = readCachedDayTypes();
if (cachedDayTypes) {
  allDayTypes = cachedDayTypes;
  dayTypesLoaded = true;
}

// The bell schedule every A-day/B-day follows (see SCHEDULE_BLOCKS below)
// — null until loaded, or if an admin has never actually set one up yet.
let defaultPeriodTimes = null; // { times: [{start,end}, ...] } | null
let periodTimesLoaded = false;
let periodTimesFetchDone = false;
const periodTimesLoadListeners = [];

const PERIOD_TIMES_CACHE_KEY = "cachedPeriodTimes";

function readCachedPeriodTimes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PERIOD_TIMES_CACHE_KEY));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedPeriodTimes(data) {
  try {
    localStorage.setItem(PERIOD_TIMES_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded, private browsing, etc. — cache is optional.
  }
}

function loadPeriodTimes(callback) {
  if (periodTimesLoaded) callback(defaultPeriodTimes);
  if (!periodTimesFetchDone) periodTimesLoadListeners.push(callback);
}

function fetchPeriodTimes() {
  if (typeof firebase === "undefined" || !firebase.firestore) return;
  firebase
    .firestore()
    .collection("periodTimes")
    .doc("default")
    .get()
    .then((doc) => {
      defaultPeriodTimes = doc.exists ? doc.data() : null;
      periodTimesLoaded = true;
      periodTimesFetchDone = true;
      writeCachedPeriodTimes(defaultPeriodTimes);
      periodTimesLoadListeners.splice(0).forEach((callback) => callback(defaultPeriodTimes));
    })
    .catch((error) => console.error("Failed to load period times:", error));
}

const cachedPeriodTimes = readCachedPeriodTimes();
if (cachedPeriodTimes) {
  defaultPeriodTimes = cachedPeriodTimes;
  periodTimesLoaded = true;
}

// Fires once assessments, day types, AND period times all have something
// to show.
function loadScheduleData(callback) {
  let assessmentsReady = false;
  let dayTypesReady = false;
  let periodTimesReady = false;
  const tryFire = () => {
    if (assessmentsReady && dayTypesReady && periodTimesReady) callback();
  };
  loadAssessments(() => {
    assessmentsReady = true;
    tryFire();
  });
  loadDayTypes(() => {
    dayTypesReady = true;
    tryFire();
  });
  loadPeriodTimes(() => {
    periodTimesReady = true;
    tryFire();
  });
}

// Fires once both assessments and day types have something to show —
// callers that filter by period need both loaded first, or an unfiltered
// list would flash before narrowing.
function loadAssessmentData(callback) {
  let assessmentsReady = false;
  let dayTypesReady = false;
  const tryFire = () => {
    if (assessmentsReady && dayTypesReady) callback();
  };
  loadAssessments(() => {
    assessmentsReady = true;
    tryFire();
  });
  loadDayTypes(() => {
    dayTypesReady = true;
    tryFire();
  });
}

// Built from local getFullYear/getMonth/getDate, not toISOString (UTC),
// which can land on the wrong calendar day depending on timezone.
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fromISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayISODate() {
  return toISODate(new Date());
}

// Periods 0-3 meet on A-days, periods 4-7 meet on B-days (see the A-Day/
// B-Day cards on My Courses). An entry on an unset ("?") date, a caller
// with no periodIndex to check against, or a Testing Block (school-wide,
// not tied to a single period meeting that day) is always visible.
function isAssessmentVisibleForPeriod(entry, periodIndex) {
  if (periodIndex == null || entry.type === "Testing Block") return true;
  const dayType = allDayTypes[entry.date];
  if (dayType === "A") return periodIndex < 4;
  if (dayType === "B") return periodIndex >= 4;
  return true;
}

// The school day's fixed shape: 4 class periods plus lunch after the
// second one, in order — every A-day and every B-day is laid out
// identically, just meeting a different set of courses. Block i's
// `slot` is what maps it to a clock time: periodIndex `slot` on an
// A-day, `slot + 4` on a B-day (see defaultPeriodTimes/SCHEDULE_BLOCKS
// consumers in class-countdown.js).
const SCHEDULE_BLOCKS = [
  { type: "class", slot: 0, label: "Period 1/4" },
  { type: "class", slot: 1, label: "Period 2/5" },
  { type: "lunch", label: "Lunch" },
  { type: "class", slot: 2, label: "Period 3/7" },
  { type: "class", slot: 3, label: "Period 4/8" },
];

// Whether right now falls inside today's school day — from the first
// class's start to the last class's end (per the Bell Schedule), passing
// time and lunch included, and only on an A/B day of the school calendar.
// Used by Settings > Privacy Blur > "During School".
function isDuringSchoolNow() {
  const now = new Date();
  const dayType = allDayTypes[toISODate(now)];
  if (dayType !== "A" && dayType !== "B") return false;

  const times = defaultPeriodTimes && defaultPeriodTimes.times;
  if (!times) return false;

  const toMinutes = (hhmm) => {
    const [hours, minutes] = hhmm.split(":").map(Number);
    return hours * 60 + minutes;
  };
  let first = null;
  let last = null;
  times.forEach((time) => {
    if (!time || !time.start || !time.end) return;
    const start = toMinutes(time.start);
    const end = toMinutes(time.end);
    if (first === null || start < first) first = start;
    if (last === null || end > last) last = end;
  });
  if (first === null) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return nowMinutes >= first && nowMinutes < last;
}

// Every assessment for one course, earliest first.
function assessmentsForCourse(courseName, periodIndex) {
  return allAssessments
    .filter((entry) => entry.courseName === courseName && isAssessmentVisibleForPeriod(entry, periodIndex))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Every assessment matching any of the given { name, periodIndex } pairs,
// earliest first — used to build My Courses' assessment calendar.
function assessmentsForCourses(courseEntries) {
  return allAssessments
    .filter((entry) =>
      courseEntries.some(
        ({ name, periodIndex }) => entry.courseName === name && isAssessmentVisibleForPeriod(entry, periodIndex)
      )
    )
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The nearest not-yet-past entry of a given type for a course — null if
// none.
function nearestUpcomingAssessment(courseName, type, periodIndex) {
  const today = todayISODate();
  return (
    assessmentsForCourse(courseName, periodIndex).find((entry) => entry.type === type && entry.date >= today) || null
  );
}

// The nearest not-yet-past entry of EITHER type for a course — null if
// none. Used by Domain's single concise "Next ...: ..." line below FA/SA/D.
function nearestUpcomingAnyAssessment(courseName, periodIndex) {
  const today = todayISODate();
  const schoolWide = assessmentsForCourse(courseName, periodIndex).find((entry) => entry.date >= today) || null;

  // Assessments this student added themselves (see the Calendar tab's "Add
  // to calendar") count too, but not their assignments. Not on every page
  // that loads this file, hence the typeof guard. On a tie the school-wide
  // entry wins — it's the real one.
  const own =
    typeof loadAddedAssessments === "function"
      ? loadAddedAssessments()
          .filter((entry) => entry.type !== "Assignment" && entry.courseName === courseName && entry.date >= today)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0] || null
      : null;

  if (!own) return schoolWide;
  if (!schoolWide) return own;
  return own.date < schoolWide.date ? own : schoolWide;
}

fetchAssessments();
fetchDayTypes();
fetchPeriodTimes();
