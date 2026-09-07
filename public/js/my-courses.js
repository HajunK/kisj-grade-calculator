// My Courses page: the 8 period-name inputs, the course-catalog search
// dropdown, saving each period as it's typed, and the read-only assessment
// calendar.

function savePeriods(periods) {
  appData.periods = periods;
  pushDataToCloud();
}

// Saves the division picked for each period (parallel to periods, "" where
// not applicable/not yet picked).
function savePeriodDivisions(periodDivisions) {
  // Picking a division for a later period before an earlier one has ever
  // had one set leaves a sparse "hole" that reads back as undefined, not
  // "". Firestore's .set() rejects undefined outright, so densify first —
  // Array.from (not .map, which skips holes) fills every index.
  appData.periodDivisions = Array.from({ length: periodDivisions.length }, (_, i) => periodDivisions[i] || "");
  pushDataToCloud();
}

// After picking a course via Enter, move on to the next period's input with
// its text selected (ready to be typed over) — or, if this was Period 8
// (the last one), just deselect instead of wrapping around.
function moveToNextPeriod(input) {
  const index = Number(input.dataset.period);
  if (index >= 7) {
    input.blur();
    return;
  }
  const next = document.querySelector(`.schedule-input[data-period="${index + 1}"]`);
  if (next) {
    next.focus();
    next.select();
  }
}

// Type-to-search dropdown for a course-name input, sourced from
// COURSE_CATALOG. Matches use mousedown (not click) so the option is
// selected before the input's blur handler hides the dropdown. Also
// supports keyboard use: Up/Down moves a highlighted suggestion, Enter
// selects it — or, if nothing's been highlighted yet, the first suggestion.
function setupCourseDropdown(input) {
  const dropdown = input.closest(".schedule-field").querySelector(".schedule-dropdown");
  let highlightedIndex = -1;

  function items() {
    return Array.from(dropdown.querySelectorAll(".schedule-dropdown-item"));
  }

  function setHighlighted(index) {
    const all = items();
    all.forEach((item) => item.classList.remove("schedule-dropdown-item--highlighted"));
    highlightedIndex = index;
    if (index < 0 || index >= all.length) return;
    all[index].classList.add("schedule-dropdown-item--highlighted");
    all[index].scrollIntoView({ block: "nearest" });
  }

  function selectItem(item) {
    input.value = item.textContent;
    dropdown.innerHTML = "";
    // "change", not "input" — "input" would re-trigger renderMatches
    // (also bound to it), repopulating the dropdown with the just-
    // selected name matching itself.
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function renderMatches() {
    const query = input.value.trim().toLowerCase();
    dropdown.innerHTML = "";
    highlightedIndex = -1;
    if (query === "") return;

    COURSE_CATALOG.filter((course) => course.name.toLowerCase().includes(query))
      .slice(0, 8)
      .forEach((course) => {
        const item = document.createElement("li");
        item.className = "schedule-dropdown-item";
        item.textContent = course.name;
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          selectItem(item);
        });
        dropdown.appendChild(item);
      });
  }

  input.addEventListener("input", renderMatches);
  input.addEventListener("focus", renderMatches);
  input.addEventListener("blur", () => {
    setTimeout(() => {
      dropdown.innerHTML = "";
    }, 100);
  });

  input.addEventListener("keydown", (event) => {
    // Both checked before the dropdown-items early return, so they always
    // fire even with no matches showing.
    if (event.key === "Escape") {
      event.preventDefault();
      input.blur();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const all = items();
      if (all.length > 0) {
        selectItem(all[highlightedIndex >= 0 ? highlightedIndex : 0]);
      } else {
        // Nothing to autocomplete into — either the field's empty, or it
        // holds text matching no real course, cleared + warned right here
        // rather than letting the blur handler (which also refocuses on
        // rejection) fight moveToNextPeriod's own focus change.
        const name = input.value.trim();
        if (name !== "" && !findCourseCatalogEntry(name)) {
          showToast("The course you typed does not exist.");
          input.value = "";
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      moveToNextPeriod(input);
      return;
    }

    const all = items();
    if (all.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted(highlightedIndex < all.length - 1 ? highlightedIndex + 1 : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted(highlightedIndex > 0 ? highlightedIndex - 1 : all.length - 1);
    }
  });
}

// --- Assessment calendar ---
// Read-only, Google Calendar-style grid showing which days have an
// assessment for any of the student's own 8 selected courses. Weekends are
// skipped, freeing up width for 5 wider weekday columns instead of 7.
// Builds the current week plus the following 3. Rebuilt once the
// assessments collection loads, and whenever a period is typed/cleared.

const ASSESSMENT_CALENDAR_WEEK_COUNT = 4;
const ASSESSMENT_CALENDAR_WEEKDAYS_PER_WEEK = 5;

const CAL_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// The { name, periodIndex } pairs actually used to match this student's
// assessments, plus which base names are unambiguous. A divided course with
// a division already picked matches just that one combined name; with
// nothing picked yet, every division's combined name is included instead
// (ambiguous — any could be the student's actual section), all sharing that
// same period index. periodIndex is what lets an A/B-day assessment show
// only for a student whose period for that course actually meets that day.
function myAssessmentMatchEntries() {
  const periods = loadPeriods();
  const divisions = loadPeriodDivisions();
  const matchEntries = [];
  const resolvedNames = new Set();

  periods.forEach((name, index) => {
    const trimmed = (name || "").trim();
    if (trimmed === "") return;

    const course = findCourseCatalogEntry(trimmed);
    const divisionOptions = course && course.divisions;
    if (!divisionOptions || divisionOptions.length === 0) {
      matchEntries.push({ name: trimmed, periodIndex: index });
      return;
    }

    const picked = divisions[index] || "";
    if (picked) {
      matchEntries.push({ name: effectiveCourseName(trimmed, picked), periodIndex: index });
      resolvedNames.add(trimmed);
    } else {
      divisionOptions.forEach((division) =>
        matchEntries.push({ name: effectiveCourseName(trimmed, division), periodIndex: index })
      );
    }
  });

  return { matchEntries, resolvedNames };
}

// Strips a trailing " (division)" — used to hide the division on a pill
// once it's unambiguous which one applies (see resolvedNames above).
function stripDivisionSuffix(courseName) {
  return courseName.replace(/ \([^)]*\)$/, "");
}

// The Monday that starts the (Mon-Fri) week containing `date`.
function startOfWeek(date) {
  const day = date.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day; // a Sunday belongs to the week starting the day before
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
}

// Same as startOfWeek, except on a Sat/Sun it jumps ahead to the upcoming
// Monday instead — this week's own Mon-Fri are all already in the past by
// then, so the calendar's first row should open on the next weekday
// instead of a row of days that have already happened.
function firstVisibleWeekStart(date) {
  const day = date.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0) return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  if (day === 6) return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 2);
  return startOfWeek(date);
}

function buildAssessmentPill(entry, resolvedNames, previousPillIds, addedIds, onContextMenu) {
  const pill = document.createElement("span");
  const isRemovable = addedIds.has(entry.id);
  const isTestingBlock = entry.type === "Testing Block";
  // In-Class, Testing Block, and a self-added Summative (see "Add Missing
  // Assessment") share the summative color; a custom "Other" label or a
  // self-added Formative reuses the formative color.
  const isKnownType = entry.type === "In-Class" || entry.type === "Summative" || isTestingBlock;
  // A plain assignment, not classList.add — must come before every
  // classList.add call below, or it wipes them out.
  pill.className = `assessment-pill assessment-pill--${isKnownType ? "summative" : "formative"}`;
  if (isTestingBlock) pill.classList.add("assessment-pill--block");
  // Starts at opacity: 0 — render() reflows once the whole grid is built,
  // then sets it back to 1, so it dims in. Only for a pill that genuinely
  // wasn't showing on the last render (previousPillIds is null when
  // animations are off) — the whole grid rebuilds on every render, even
  // an unrelated keystroke elsewhere, so this stops already-visible
  // labels from re-fading.
  if (previousPillIds && !previousPillIds.has(entry.id)) pill.classList.add("assessment-pill--fade-in");
  // Drop the "(division)" suffix once the student's picked division makes
  // it unambiguous.
  const strippedName = stripDivisionSuffix(entry.courseName);
  const label = resolvedNames.has(strippedName) ? strippedName : entry.courseName;
  // Text lives in its own inner .assessment-pill-text span — the outer
  // .assessment-pill-name is the fixed-width clipping window, this inner
  // one is what the hover marquee (see buildDayCell below) scrolls.
  const nameEl = document.createElement("span");
  nameEl.className = "assessment-pill-name";
  const nameText = document.createElement("span");
  nameText.className = "assessment-pill-text";
  nameText.textContent = isKnownType ? label : `${label} ${entry.type}`;
  nameEl.appendChild(nameText);
  pill.appendChild(nameEl);
  // A second, muted line under the course name — the only thing telling
  // In-Class and Testing Block apart besides the rectangle shape.
  if (isTestingBlock) {
    const testingLabel = document.createElement("span");
    testingLabel.className = "assessment-pill-testing-label";
    const testingText = document.createElement("span");
    testingText.className = "assessment-pill-text";
    testingText.textContent = "Testing Block";
    testingLabel.appendChild(testingText);
    pill.appendChild(testingLabel);
  }
  if (isRemovable) {
    pill.classList.add("assessment-pill--removable");
    // Only after a real lingering hover, not the instant the cursor
    // crosses it — a quick left click reveals it immediately instead.
    let hoverTimer = null;
    pill.addEventListener("mouseenter", () => {
      hoverTimer = setTimeout(() => showRemoveHint(pill), 1500);
    });
    pill.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      hideRemoveHint();
    });
    pill.addEventListener("click", () => {
      clearTimeout(hoverTimer);
      showRemoveHint(pill);
    });
  }
  pill.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    onContextMenu(entry, pill);
  });
  return pill;
}

// Fades a pill to opacity 0 (matching .assessment-pill--fade-in's own
// 300ms) before calling back — used so a right-click delete visibly dims
// out instead of just vanishing on the next render. Skipped entirely with
// animations off, since there'd be nothing to wait for.
function fadeOutPill(pillEl, onComplete) {
  if (!window.animationsEnabled()) {
    onComplete();
    return;
  }
  pillEl.classList.add("assessment-pill--removing");
  void pillEl.offsetWidth; // force reflow so the transition above takes effect before the opacity change below
  pillEl.style.opacity = "0";
  setTimeout(onComplete, 300);
}

// Single shared tooltip element (same lazy-singleton pattern as
// shared.js's showToast) — position: fixed and appended to <body>, so it's
// never clipped by a day cell's own overflow-y: auto pill list.
let removeHintEl = null;

function showRemoveHint(pillEl) {
  if (!removeHintEl) {
    removeHintEl = document.createElement("div");
    removeHintEl.className = "assessment-pill-remove-hint";
    removeHintEl.textContent = "Right-click to remove assessment";
    document.body.appendChild(removeHintEl);
  }
  const rect = pillEl.getBoundingClientRect();
  removeHintEl.style.left = `${rect.left + rect.width / 2}px`;
  removeHintEl.style.top = `${rect.top - 6}px`;
  removeHintEl.classList.add("assessment-pill-remove-hint--visible");
}

function hideRemoveHint() {
  if (removeHintEl) removeHintEl.classList.remove("assessment-pill-remove-hint--visible");
}

function buildDayCell(weeksContainer, date, entriesByDate, resolvedNames, previousPillIds, addedIds, onContextMenu) {
  const iso = toISODate(date);
  const today = new Date();

  const cell = document.createElement("div");
  cell.className = "assessment-week-day";

  const dayNumber = document.createElement("span");
  dayNumber.className = "assessment-week-day-number";
  dayNumber.textContent = String(date.getDate());
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    dayNumber.classList.add("assessment-week-day-number--today");
  }
  cell.appendChild(dayNumber);

  // Testing blocks always lead the list — a stable sort, so entries
  // without one keep their original relative order.
  const entries = (entriesByDate[iso] || [])
    .slice()
    .sort((a, b) => Number(b.type === "Testing Block") - Number(a.type === "Testing Block"));

  const pillList = document.createElement("div");
  pillList.className = "assessment-week-day-pills";
  entries.forEach((entry) =>
    pillList.appendChild(buildAssessmentPill(entry, resolvedNames, previousPillIds, addedIds, onContextMenu))
  );
  cell.appendChild(pillList);

  // LED-sign-style auto-scroll, but only for text that's actually cut off
  // — checked fresh on every hover, since which names overflow can change
  // with the day cell's own width. Starts on the one-shot "-in" variant
  // (see style.css) so the very first pass continues from the text's
  // current position instead of jumping offscreen first; once that pass's
  // animationend fires below, it hands off to the ordinary looping variant.
  cell.addEventListener("mouseenter", () => {
    cell.querySelectorAll(".assessment-pill-text").forEach((textEl) => {
      if (textEl.scrollWidth > textEl.parentElement.clientWidth) {
        textEl.classList.add("assessment-pill-text--marquee-in");
      }
    });
  });
  cell.addEventListener("mouseleave", () => {
    cell
      .querySelectorAll(".assessment-pill-text--marquee-in, .assessment-pill-text--marquee-loop")
      .forEach((textEl) => {
        textEl.classList.remove("assessment-pill-text--marquee-in", "assessment-pill-text--marquee-loop");
      });
  });
  cell.addEventListener("animationend", (event) => {
    if (event.animationName !== "assessment-pill-marquee-in") return;
    event.target.classList.remove("assessment-pill-text--marquee-in");
    event.target.classList.add("assessment-pill-text--marquee-loop");
  });

  weeksContainer.appendChild(cell);
}

// Builds the weekday header + wires the render; returns a render()
// function so callers elsewhere (e.g. a period being typed) can trigger a
// refresh. A no-op (returns null) on any page without the calendar markup.
function initAssessmentCalendar() {
  const cardEl = document.getElementById("my-courses-calendar-card");
  const weeksContainer = document.getElementById("assessment-cal-weeks");
  if (!weeksContainer) return null;

  const weekdayRow = document.getElementById("assessment-cal-weekdays");
  const loadingEl = document.getElementById("assessment-cal-loading");

  // Which assessment ids were on screen after the last render — compared
  // on the next one so a pill only fades in when it's genuinely new.
  let previousPillIds = new Set();
  let previousMatchNamesKey = "";
  // False until this calendar has actually built its grid once — nothing
  // should fade in on the tab's own initial load, only on a genuinely
  // live change afterward (a new suggestion, a period edit, etc.).
  let calendarSettled = false;
  // Ids of this render's self-added entries — read by handlePillContextMenu
  // below, kept fresh every render rather than threaded through the whole
  // buildDayCell/buildAssessmentPill call chain.
  let currentAddedIds = new Set();

  function deleteAddedAssessment(id) {
    const entries = loadAddedAssessments();
    const removed = entries.find((entry) => entry.id === id);
    saveAddedAssessments(entries.filter((entry) => entry.id !== id));
    if (removed) unlogSuggestedAssessment(removed.date, removed.courseName, removed.type);
    render(true, false);
  }

  // Right-click on a pill: only a self-added entry can be removed —
  // anything from the admin-scheduled collection just explains why not.
  function handlePillContextMenu(entry, pillEl) {
    if (!currentAddedIds.has(entry.id)) {
      showToast("Only assessments added by you can be removed.");
      return;
    }
    // The tooltip is a body-level singleton, not scoped to this pill — it
    // won't get cleaned up on its own once the pill it's pointing at fades
    // out and disappears from under it.
    hideRemoveHint();
    fadeOutPill(pillEl, () => deleteAddedAssessment(entry.id));
  }

  CAL_WEEKDAY_LABELS.forEach((day) => {
    const span = document.createElement("span");
    span.textContent = day;
    weekdayRow.appendChild(span);
  });

  const CALENDAR_REVEAL_MS = 300;

  // Fades in only when actually asked to — never on page load itself,
  // even for an account that already has courses.
  function revealCalendarCard(animate) {
    if (!cardEl || !cardEl.hidden) return;
    cardEl.hidden = false;
    if (!animate || !window.animationsEnabled()) return;
    cardEl.style.opacity = "0";
    cardEl.style.transition = `opacity ${CALENDAR_REVEAL_MS}ms ease`;
    void cardEl.offsetWidth; // force reflow so the "0" above actually takes effect first
    cardEl.style.opacity = "1";
  }

  function hideCalendarCard() {
    if (!cardEl || cardEl.hidden) return;
    cardEl.hidden = true;
    cardEl.style.opacity = "";
    cardEl.style.transition = "";
  }

  // commit/animate default to true/false so a call with no arguments
  // (the page's initial load) still gets a correct instant show-or-hide
  // decision, just never animated. A live edit passes both explicitly:
  // while still typing (commit=false), visibility is untouched; finishing
  // and leaving the field is what reveals/fades.
  function render(commit = true, animate = false) {
    // Whole card starts hidden — nothing to show with no courses typed.
    const hasAnyCourse = loadPeriods().some((name) => (name || "").trim() !== "");
    if (commit) {
      if (hasAnyCourse) revealCalendarCard(animate);
      else hideCalendarCard();
    }
    if (!hasAnyCourse) return;

    // Also reused as refreshAssessmentCalendar whenever a period/division
    // changes — skip if the assessments/day-type collections haven't
    // loaded yet; loadAssessmentData below guarantees a real render once they do.
    if (!assessmentsLoaded || !dayTypesLoaded) return;

    const { matchEntries, resolvedNames } = myAssessmentMatchEntries();
    const matchNames = new Set(matchEntries.map((entry) => entry.name));
    const schoolWideEntries = assessmentsForCourses(matchEntries);
    // Alongside the school-wide collection: assessments this student added
    // themselves (see "Add Missing Assessment"), filtered to whichever of
    // their current courses each one was added against.
    const addedEntries = loadAddedAssessments().filter((entry) => matchNames.has(entry.courseName));

    // A self-added entry becomes redundant the moment the admin schedules
    // (or accepts a suggestion for) the exact same {date, courseName, type}
    // — drop it from this student's own list rather than showing the same
    // assessment twice, once from each source.
    const schoolWideKeys = new Set(schoolWideEntries.map((entry) => `${entry.date}|${entry.courseName}|${entry.type}`));
    const staleAdded = addedEntries.filter((entry) => schoolWideKeys.has(`${entry.date}|${entry.courseName}|${entry.type}`));
    let effectiveAddedEntries = addedEntries;
    if (staleAdded.length > 0) {
      const staleIds = new Set(staleAdded.map((entry) => entry.id));
      saveAddedAssessments(loadAddedAssessments().filter((entry) => !staleIds.has(entry.id)));
      effectiveAddedEntries = addedEntries.filter((entry) => !staleIds.has(entry.id));
    }

    currentAddedIds = new Set(effectiveAddedEntries.map((entry) => entry.id));
    const matchingEntries = schoolWideEntries.concat(effectiveAddedEntries);
    const matchNamesKey = matchEntries.map((entry) => `${entry.name}|${entry.periodIndex}`).join(" ");

    // loadAssessments can call this render's callback twice on the very
    // first load: once from a cache, then again once the real fetch
    // confirms it. If that confirmation shows the same assessments, skip
    // rebuilding the grid — otherwise it would replace pills still
    // mid fade-in, cutting the animation short. matchNamesKey is checked
    // too, not just the entry ids — a division just being picked can
    // leave the exact same entries on screen while still needing a
    // rebuild, since which of them now count as unambiguous changed.
    if (!weeksContainer.hidden && matchNamesKey === previousMatchNamesKey) {
      const currentPillIds = new Set(matchingEntries.map((entry) => entry.id));
      const unchanged =
        currentPillIds.size === previousPillIds.size && [...currentPillIds].every((id) => previousPillIds.has(id));
      if (unchanged) return;
    }

    const entriesByDate = {};
    matchingEntries.forEach((entry) => {
      (entriesByDate[entry.date] = entriesByDate[entry.date] || []).push(entry);
    });

    // Not gated on the `animate` param above — that one only controls the
    // card's own reveal fade. A genuinely new pill should fade in on any
    // later render; null here means either animations are off entirely,
    // or this is the calendar's own first-ever build (nothing should fade
    // in just from opening the tab).
    const previousPillIdsForThisRender = calendarSettled && window.animationsEnabled() ? previousPillIds : null;
    calendarSettled = true;

    weeksContainer.innerHTML = "";
    const thisWeekStart = firstVisibleWeekStart(new Date());
    for (let weekIndex = 0; weekIndex < ASSESSMENT_CALENDAR_WEEK_COUNT; weekIndex++) {
      for (let dayIndex = 0; dayIndex < ASSESSMENT_CALENDAR_WEEKDAYS_PER_WEEK; dayIndex++) {
        const date = new Date(
          thisWeekStart.getFullYear(),
          thisWeekStart.getMonth(),
          thisWeekStart.getDate() + weekIndex * 7 + dayIndex
        );
        buildDayCell(
          weeksContainer,
          date,
          entriesByDate,
          resolvedNames,
          previousPillIdsForThisRender,
          currentAddedIds,
          handlePillContextMenu
        );
      }
    }
    previousPillIds = new Set(matchingEntries.map((entry) => entry.id));
    previousMatchNamesKey = matchNamesKey;

    // Reveal the real calendar (and hide the spinner) the first time this
    // runs. Done before the pill fade-in below, since a pill inside a
    // still-hidden grid can't visibly transition.
    loadingEl.hidden = true;
    weekdayRow.hidden = false;
    weeksContainer.hidden = false;

    if (previousPillIdsForThisRender) {
      void weeksContainer.offsetWidth; // force reflow so every new pill's opacity: 0 above actually takes effect first
      weeksContainer.querySelectorAll(".assessment-pill--fade-in").forEach((pill) => {
        pill.style.opacity = "1";
      });
    }
  }

  loadAssessmentData(() => render());

  return render;
}

// --- Add Missing Assessment modal ---
// Lets a student log a summative/formative that isn't in the admin-
// scheduled assessments collection yet — saved to their own
// addedAssessments (see shared.js), merged into the calendar above like any
// other entry. Also tallied in the school-wide "suggested" collection, so
// admins can see which missing assessments come up across multiple
// students. Right-clicking a self-added pill removes it again — see
// handlePillContextMenu in initAssessmentCalendar.

const ADD_ASSESSMENT_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ADD_ASSESSMENT_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Every period whose course is unambiguous right now (no divisions, or a
// division already picked) — the courses this modal can log an assessment
// against. displayName is the plain typed name (shown on the button);
// courseName is the fully resolved name (what gets saved/matched).
// periodIndex is carried along so isDuplicateSelection can tell whether a
// same-key school-wide entry is actually visible to this student's own
// section, the same way the calendar itself decides pill visibility.
function addableCourseOptions() {
  const periods = loadPeriods();
  const divisions = loadPeriodDivisions();
  const options = [];

  periods.forEach((name, index) => {
    const trimmed = (name || "").trim();
    if (trimmed === "") return;

    const course = findCourseCatalogEntry(trimmed);
    const divisionOptions = course && course.divisions;
    if (!divisionOptions || divisionOptions.length === 0) {
      options.push({ displayName: trimmed, courseName: trimmed, periodIndex: index });
      return;
    }

    const picked = divisions[index] || "";
    if (picked) options.push({ displayName: trimmed, courseName: effectiveCourseName(trimmed, picked), periodIndex: index });
  });

  return options;
}

// Deterministic, non-cryptographic string hash — used only to build a
// stable "suggested" doc id from {date, courseName, type}, so repeated
// suggestions of the same assessment land on the same doc instead of
// creating duplicates.
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// Tags a student-added assessment (Summative or Formative) with who
// suggested it in the school-wide "suggested" collection — keyed by a hash
// of {date, courseName, type}, so the same suggestion from multiple
// students lands on one shared document instead of creating duplicates.
// The "count" is just emails.length — arrayUnion is what makes a repeat
// suggestion from the same email a no-op instead of double-counting them.
function suggestedAssessmentDocId(date, courseName, type) {
  return simpleHash(`${date}|${courseName}|${type}`);
}

function logSuggestedAssessment(date, courseName, type) {
  if (!currentUid || typeof firebase === "undefined" || !firebase.firestore) return;
  const email = (auth.currentUser && auth.currentUser.email) || "";
  if (!email) return;
  firebase
    .firestore()
    .collection("suggested")
    .doc(suggestedAssessmentDocId(date, courseName, type))
    .set(
      {
        date,
        courseName,
        type,
        emails: firebase.firestore.FieldValue.arrayUnion(email),
        lastAddedAt: Date.now(),
      },
      { merge: true }
    )
    .catch((error) => console.error("Failed to log suggested assessment:", error));
}

// Reverses logSuggestedAssessment when a student deletes their own added
// entry — a transaction, not a plain arrayRemove, since deleting the doc
// outright (once no emails would be left) has to be a deliberate branch
// based on what's actually stored right now, not assumed from this one
// client's own view of it.
function unlogSuggestedAssessment(date, courseName, type) {
  if (!currentUid || typeof firebase === "undefined" || !firebase.firestore) return;
  const email = (auth.currentUser && auth.currentUser.email) || "";
  if (!email) return;
  const docRef = firebase.firestore().collection("suggested").doc(suggestedAssessmentDocId(date, courseName, type));
  firebase
    .firestore()
    .runTransaction((transaction) =>
      transaction.get(docRef).then((snapshot) => {
        if (!snapshot.exists) return;
        const remainingEmails = (snapshot.data().emails || []).filter((existing) => existing !== email);
        if (remainingEmails.length === 0) {
          transaction.delete(docRef);
        } else {
          transaction.update(docRef, { emails: remainingEmails });
        }
      })
    )
    .catch((error) => console.error("Failed to remove suggested assessment:", error));
}

function initAddAssessmentModal(refreshAssessmentCalendar) {
  const triggerBtn = document.getElementById("add-assessment-trigger-btn");
  if (!triggerBtn) return;

  // Suggesting/adding an assessment writes to this student's own
  // addedAssessments and the school-wide suggested collection — both need
  // a real uid. Signing in/out always reloads the page (see
  // handleAuthResolved), so currentUid here already reflects this load's
  // actual state, not a stale guess.
  if (!currentUid) {
    triggerBtn.hidden = true;
    return;
  }

  let overlay = null;
  let selectedCourse = null; // { displayName, courseName } | null
  let selectedType = "Summative"; // "Summative" | "Formative"
  let selectedDate = null; // ISO string | null
  let displayedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  function buildOverlay() {
    const el = document.createElement("div");
    el.className = "add-assessment-overlay";
    el.innerHTML = `
      <div class="add-assessment-dialog">
        <button type="button" class="add-assessment-close-btn" aria-label="Close">×</button>
        <h2 class="add-assessment-title">Add Missing Assessment</h2>
        <div class="add-assessment-body">
          <div class="add-assessment-column">
            <span class="add-assessment-section-label">Course</span>
            <div class="add-assessment-course-grid"></div>
            <span class="add-assessment-section-label add-assessment-type-label">Type</span>
            <div class="segmented-control add-assessment-type-toggle">
              <button type="button" class="segmented-option segmented-option--active" data-value="Summative">Summative</button>
              <button type="button" class="segmented-option" data-value="Formative">Formative</button>
            </div>
          </div>
          <div class="add-assessment-column">
            <span class="add-assessment-section-label">Assessment Date</span>
            <div class="assessment-calendar-header">
              <button type="button" class="assessment-calendar-nav-btn add-assessment-cal-prev" aria-label="Previous month">‹</button>
              <span class="assessment-calendar-label add-assessment-cal-label"></span>
              <button type="button" class="assessment-calendar-nav-btn add-assessment-cal-next" aria-label="Next month">›</button>
            </div>
            <div class="assessment-calendar-weekday-row add-assessment-cal-weekdays"></div>
            <div class="assessment-calendar-grid add-assessment-cal-grid"></div>
          </div>
        </div>
        <button type="button" class="add-assessment-submit-btn">Add Assessment to Calendar</button>
      </div>
    `;
    document.body.appendChild(el);

    ADD_ASSESSMENT_WEEKDAY_LABELS.forEach((day) => {
      const span = document.createElement("span");
      span.textContent = day;
      el.querySelector(".add-assessment-cal-weekdays").appendChild(span);
    });

    const typeToggle = el.querySelector(".add-assessment-type-toggle");
    const typeThumb = document.createElement("span");
    typeThumb.className = "segmented-thumb";
    typeToggle.insertBefore(typeThumb, typeToggle.firstChild);

    const positionTypeThumb = (option, animate) => {
      if (!animate) typeThumb.style.transition = "none";
      typeThumb.style.left = `${option.offsetLeft}px`;
      typeThumb.style.width = `${option.offsetWidth}px`;
      if (!animate) {
        void typeThumb.offsetWidth; // force reflow so the "none" transition above takes effect first
        typeThumb.style.transition = "";
      }
    };

    typeToggle.querySelectorAll(".segmented-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("segmented-option--active")) return;
        selectedType = btn.dataset.value;
        typeToggle
          .querySelectorAll(".segmented-option")
          .forEach((other) => other.classList.toggle("segmented-option--active", other === btn));
        positionTypeThumb(btn, window.animationsEnabled());
        updateSubmitEnabled();
      });
    });

    el.querySelector(".add-assessment-close-btn").addEventListener("click", closeModal);
    el.addEventListener("click", (event) => {
      if (event.target === el) closeModal();
    });
    el.querySelector(".add-assessment-cal-prev").addEventListener("click", () => {
      displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() - 1, 1);
      renderCalendar();
    });
    el.querySelector(".add-assessment-cal-next").addEventListener("click", () => {
      displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 1);
      renderCalendar();
    });
    el.querySelector(".add-assessment-submit-btn").addEventListener("click", submit);

    el._positionTypeThumb = positionTypeThumb;
    return el;
  }

  // The school-wide entry (if any) matching the current Course/Type/Date
  // selection — regardless of whether it's actually visible on this
  // student's own calendar right now. A course split across A-day and
  // B-day sections can have a same-key entry that only shows for the
  // OTHER section (see isAssessmentVisibleForPeriod), which this student
  // has no way to see — so its mere existence shouldn't block them from
  // adding their own, but see submit() for why it still shouldn't suggest.
  function matchingSchoolWideEntry() {
    if (!selectedCourse || !selectedDate) return null;
    return (
      allAssessments.find(
        (entry) =>
          entry.date === selectedDate && entry.courseName === selectedCourse.courseName && entry.type === selectedType
      ) || null
    );
  }

  // True once the current Course/Type/Date already matches one of this
  // student's own added entries, or a school-wide one that's actually
  // visible to them (same {date, courseName, type} as suggested's own
  // dedupe key). A school-wide match that ISN'T visible to this student's
  // own section doesn't count — see matchingSchoolWideEntry above.
  function isDuplicateSelection() {
    if (!selectedCourse || !selectedDate) return false;
    const matchesSelection = (entry) =>
      entry.date === selectedDate && entry.courseName === selectedCourse.courseName && entry.type === selectedType;
    if (loadAddedAssessments().some(matchesSelection)) return true;

    const match = matchingSchoolWideEntry();
    return Boolean(match) && isAssessmentVisibleForPeriod(match, selectedCourse.periodIndex);
  }

  function updateSubmitEnabled() {
    overlay.querySelector(".add-assessment-submit-btn").disabled =
      !selectedCourse || !selectedDate || isDuplicateSelection();
  }

  function renderCourseGrid() {
    const grid = overlay.querySelector(".add-assessment-course-grid");
    grid.innerHTML = "";
    const options = addableCourseOptions();

    if (options.length === 0) {
      const hint = document.createElement("p");
      hint.className = "add-assessment-empty-hint";
      hint.textContent = "Pick a division for your courses on this page first.";
      grid.appendChild(hint);
      return;
    }

    options.forEach((option) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "add-assessment-course-btn";
      btn.textContent = option.displayName;
      btn.classList.toggle(
        "add-assessment-course-btn--selected",
        Boolean(selectedCourse) && selectedCourse.courseName === option.courseName
      );
      btn.addEventListener("click", () => {
        selectedCourse = option;
        renderCourseGrid();
        updateSubmitEnabled();
      });
      grid.appendChild(btn);
    });
  }

  function renderCalendar() {
    const grid = overlay.querySelector(".add-assessment-cal-grid");
    const label = overlay.querySelector(".add-assessment-cal-label");
    const year = displayedMonth.getFullYear();
    const month = displayedMonth.getMonth();
    label.textContent = `${ADD_ASSESSMENT_MONTH_NAMES[month]} ${year}`;

    grid.innerHTML = "";
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < firstWeekday; i++) {
      const filler = document.createElement("span");
      filler.className = "assessment-calendar-day assessment-calendar-day--outside";
      grid.appendChild(filler);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = toISODate(new Date(year, month, day));
      const dayBtn = document.createElement("button");
      dayBtn.type = "button";
      dayBtn.className = "assessment-calendar-day";

      const dayNumber = document.createElement("span");
      dayNumber.className = "assessment-calendar-day-number";
      dayNumber.textContent = String(day);
      if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) {
        dayNumber.classList.add("assessment-calendar-day-number--today");
      }
      dayBtn.appendChild(dayNumber);

      if (selectedDate === iso) dayBtn.classList.add("assessment-calendar-day--selected");

      dayBtn.addEventListener("click", () => {
        selectedDate = iso;
        renderCalendar();
        updateSubmitEnabled();
      });

      grid.appendChild(dayBtn);
    }
  }

  function openModal() {
    if (addableCourseOptions().length === 0) {
      showToast("Add a course to My Courses first.");
      return;
    }

    selectedCourse = null;
    selectedType = "Summative";
    selectedDate = null;
    displayedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    overlay = buildOverlay();
    renderCourseGrid();
    renderCalendar();
    updateSubmitEnabled();
    overlay._positionTypeThumb(overlay.querySelector(".segmented-option--active"), false);

    const dialog = overlay.querySelector(".add-assessment-dialog");
    const animate = window.animationsEnabled();
    if (!animate) {
      dialog.classList.add("add-assessment-dialog--instant");
      overlay.classList.add("add-assessment-overlay--instant");
    }
    void dialog.offsetWidth; // force reflow so the entrance transition below actually plays
    dialog.classList.add("add-assessment-dialog--visible");
    overlay.classList.add("add-assessment-overlay--visible");
    if (!animate) {
      void dialog.offsetWidth; // commit the instant state before re-enabling the transition
      dialog.classList.remove("add-assessment-dialog--instant");
      overlay.classList.remove("add-assessment-overlay--instant");
    }
  }

  function closeModal() {
    if (!overlay) return;
    const closingOverlay = overlay;
    const dialog = closingOverlay.querySelector(".add-assessment-dialog");
    overlay = null;
    if (!window.animationsEnabled()) {
      closingOverlay.remove();
      return;
    }
    // Reverses the entrance transition (see openModal) — same
    // remove-class-then-wait pattern as fadeOutPill's own 300ms below.
    dialog.classList.remove("add-assessment-dialog--visible");
    closingOverlay.classList.remove("add-assessment-overlay--visible");
    setTimeout(() => closingOverlay.remove(), 250);
  }

  function submit() {
    if (!selectedCourse) {
      showToast("Pick a course first.");
      return;
    }
    if (!selectedDate) {
      showToast("Pick a date first.");
      return;
    }
    if (isDuplicateSelection()) {
      showToast("This assessment is already on the calendar.");
      return;
    }

    const entry = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      date: selectedDate,
      courseName: selectedCourse.courseName,
      type: selectedType,
      createdAt: Date.now(),
    };

    saveAddedAssessments([...loadAddedAssessments(), entry]);
    // Already scheduled server-side under this same key, just for a
    // section this student's own A/B-day pattern doesn't show it for (see
    // isDuplicateSelection) — nothing new for the admin to add, so this
    // doesn't get suggested to them again.
    if (!matchingSchoolWideEntry()) {
      logSuggestedAssessment(entry.date, entry.courseName, entry.type);
    }

    showToast(`Added to ${selectedCourse.displayName}'s calendar.`);
    closeModal();
    if (refreshAssessmentCalendar) refreshAssessmentCalendar(true, true);
  }

  triggerBtn.addEventListener("click", openModal);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay) closeModal();
  });
}

// My Courses page: load saved period names into the inputs, wire up the
// search dropdown, save as the user types, and show/hide each row's clear
// (×) button based on whether it has a value. A no-op on any other page.
function initMyCoursesPage() {
  const scheduleInputs = document.querySelectorAll(".schedule-input");
  if (scheduleInputs.length === 0) return;

  const periods = loadPeriods();
  const firstPeriodInput = document.querySelector('.schedule-input[data-period="0"]');

  // Only Period 1 ever gets the placeholder, and only while every period is
  // still empty — once any course is entered anywhere, it goes away.
  const updateFirstPeriodPlaceholder = () => {
    if (!firstPeriodInput) return;
    const allEmpty = loadPeriods().every((name) => !name || name.trim() === "");
    firstPeriodInput.placeholder = allEmpty ? "Start typing here" : "";
  };
  updateFirstPeriodPlaceholder();

  const refreshAssessmentCalendar = initAssessmentCalendar();
  initAddAssessmentModal(refreshAssessmentCalendar);

  // Shows a row of division circles next to a period's input once its
  // typed text exactly matches a course that has them; removes them
  // otherwise, correcting a stale division left over from a previously
  // different course in this slot. commit=false (while typing) only ever
  // updates what's shown, never what's saved — a keystroke mid-edit
  // briefly not matching any catalog course shouldn't wipe an
  // already-picked division. commit=true (blur, a real selection, clear)
  // is when a stale division actually gets corrected/persisted.
  function syncDivisionPicker(input, index, commit = true) {
    const row = input.closest(".schedule-row");
    const picker = row.querySelector(".division-picker");
    const course = findCourseCatalogEntry(input.value.trim());
    const divisions = course && course.divisions;

    const allDivisions = loadPeriodDivisions();
    const saved = allDivisions[index] || "";

    if (!divisions || divisions.length === 0) {
      picker.hidden = true;
      picker.innerHTML = "";
      if (commit && saved) {
        allDivisions[index] = "";
        savePeriodDivisions(allDivisions);
      }
      return;
    }

    const current = divisions.includes(saved) ? saved : "";
    if (commit && current !== saved) {
      allDivisions[index] = current;
      savePeriodDivisions(allDivisions);
    }

    picker.hidden = false;
    picker.innerHTML = "";

    // Absolutely positioned in CSS, so adding it never shifts the circles
    // below — only shown while nothing's been picked yet.
    if (!current) {
      const label = document.createElement("span");
      label.className = "division-picker-label";
      label.textContent = "Select division";
      picker.appendChild(label);
    }

    divisions.forEach((division) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "division-option";
      btn.textContent = division;
      btn.classList.toggle("division-option--selected", division === current);
      // mousedown + preventDefault — clicking would otherwise blur the
      // course-name input first, whose blur handler rebuilds this whole
      // picker, destroying this button before its click fires.
      btn.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      btn.addEventListener("click", () => {
        const all = loadPeriodDivisions();
        all[index] = division;
        savePeriodDivisions(all);
        // Rebuilt rather than patched — the "Select your division" label
        // above also needs to disappear.
        syncDivisionPicker(input, index);
        // A real, finished choice — same as any other commit.
        if (refreshAssessmentCalendar) refreshAssessmentCalendar(true, true);
      });
      picker.appendChild(btn);
    });
  }

  // Shows the show-course button next to a period whenever the course
  // currently typed there has at least one card hidden on Domain — a
  // combo course can have either of its two cards hidden independently.
  function syncShowCourseButton(input, index) {
    const row = input.closest(".schedule-row");
    const btn = row.querySelector(".show-course-btn");
    if (!btn) return;

    const name = input.value.trim();
    const cardNames = name ? expandCourseNames([name]) : [];
    const hidden = loadHiddenCourses();
    const relevant = cardNames.filter((cardName) => hidden.includes(cardName));

    btn.hidden = relevant.length === 0;
    if (relevant.length === 0) return;

    const icon = btn.querySelector(".show-course-icon");
    if (icon && !icon.src) icon.src = uiIconPath("show.png");

    // Re-bound on every sync so it always un-hides whatever's actually
    // relevant right now, since the course in this slot may have changed.
    btn.onclick = () => {
      saveHiddenCourses(loadHiddenCourses().filter((cardName) => !relevant.includes(cardName)));
      btn.hidden = true;
      showToast(`View ${name} in the Domain Tab`);
    };
  }

  scheduleInputs.forEach((input) => {
    const index = Number(input.dataset.period);
    const field = input.closest(".schedule-field");
    const clearBtn = field.querySelector(".schedule-clear-btn");

    const updateHasValue = () => {
      field.classList.toggle("has-value", input.value.trim() !== "");
    };

    input.value = periods[index] || "";
    updateHasValue();
    setupCourseDropdown(input);
    syncDivisionPicker(input, index);
    syncShowCourseButton(input, index);

    const persist = (commit) => {
      const current = loadPeriods();
      current[index] = input.value;
      savePeriods(current);
      updateHasValue();
      updateFirstPeriodPlaceholder();
      syncDivisionPicker(input, index, commit);
      syncShowCourseButton(input, index);
      // commit decides whether this can reveal/hide the calendar at all
      // (not mid-keystroke) and, when it does, whether that's animated.
      if (refreshAssessmentCalendar) refreshAssessmentCalendar(commit, commit);
    };
    // "input" (every keystroke) never commits a division correction.
    // "change" and a direct blur both do.
    input.addEventListener("input", () => persist(false));
    input.addEventListener("change", () => persist(true));

    // Only a real catalog course or a blank field is allowed to leave this
    // cell. Anything else gets rejected back: cleared, refocused, and
    // warned. This also covers Escape (see setupCourseDropdown's own
    // handler, which just calls input.blur()).
    input.addEventListener("blur", () => {
      const name = input.value.trim();
      if (name !== "" && !findCourseCatalogEntry(name)) {
        showToast("The course you typed does not exist.");
        input.value = "";
        persist(true);
        // Deferred so this wins over the browser's own in-progress focus
        // transition, which could otherwise override a synchronous call.
        setTimeout(() => input.focus(), 0);
        return;
      }
      persist(true);
    });

    clearBtn.addEventListener("click", () => {
      input.value = "";
      persist(true);
      input.focus();
    });
  });
}
