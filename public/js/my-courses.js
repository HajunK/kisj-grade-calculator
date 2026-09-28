// The 8 period-name inputs (shown in a popup opened from the account-menu
// dropdown — see openMyCoursesModal below), the course-catalog search
// dropdown, saving each period as it's typed, and the Calendar page's
// read-only assessment calendar.

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
  const field = input.closest(".schedule-field");
  const dropdown = field.querySelector(".schedule-dropdown");
  let highlightedIndex = -1;

  // Moved out to <body> as a position: fixed layer — inside the popup it
  // would be clipped by the card's own overflow/rounded edge (and a
  // transformed ancestor makes fixed positioning relative to the card, not
  // the screen). Any left over once the popup closes are swept up in
  // closeMyCoursesModal.
  dropdown.classList.add("schedule-dropdown--floating");
  document.body.appendChild(dropdown);

  // Sits under the field, or above it when there's more room there, and
  // shrinks to whatever fits so it never runs off the screen.
  const SCREEN_MARGIN = 8;
  const FIELD_GAP = 8;
  function positionDropdown() {
    if (!dropdown.isConnected || !field.isConnected) {
      window.removeEventListener("resize", positionDropdown);
      window.removeEventListener("scroll", positionDropdown, true);
      return;
    }
    if (dropdown.childElementCount === 0) return;

    const rect = field.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - FIELD_GAP - SCREEN_MARGIN;
    const spaceAbove = rect.top - FIELD_GAP - SCREEN_MARGIN;
    const wanted = Math.min(240, dropdown.scrollHeight);
    const openBelow = spaceBelow >= wanted || spaceBelow >= spaceAbove;

    dropdown.style.maxHeight = `${Math.max(80, Math.min(240, openBelow ? spaceBelow : spaceAbove))}px`;
    const width = Math.min(rect.width, window.innerWidth - SCREEN_MARGIN * 2);
    dropdown.style.width = `${width}px`;
    dropdown.style.left = `${Math.max(SCREEN_MARGIN, Math.min(rect.left, window.innerWidth - width - SCREEN_MARGIN))}px`;
    if (openBelow) {
      dropdown.style.top = `${rect.bottom + FIELD_GAP}px`;
      dropdown.style.bottom = "auto";
    } else {
      dropdown.style.bottom = `${window.innerHeight - rect.top + FIELD_GAP}px`;
      dropdown.style.top = "auto";
    }
  }
  window.addEventListener("resize", positionDropdown);
  window.addEventListener("scroll", positionDropdown, true);

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
    // Spaces are ignored on both sides, so "APLit" or "Algebra  II" still
    // match.
    const squash = (text) => text.toLowerCase().replace(/\s+/g, "");
    const query = squash(input.value);
    dropdown.innerHTML = "";
    highlightedIndex = -1;
    if (query === "") return;

    // Matches only from the start of a word ("calc" finds AP Calculus, "es"
    // doesn't find Chinese), in the full name or the short one. A word starts
    // after a space or other punctuation, like the "Dual" in
    // Individual/Dual Pursuits.
    const matches = (name) =>
      [...name.matchAll(/[a-z0-9]+/gi)].some((word) => squash(name.slice(word.index)).startsWith(query));
    // A short name typed out in full goes first, so "PE" leads with the PE
    // courses rather than whatever else has a word starting with "pe".
    const isExactShort = (course) => Boolean(course.short) && squash(course.short) === query;
    COURSE_CATALOG.filter((course) => matches(course.name) || (course.short && matches(course.short)))
      .sort((a, b) => Number(isExactShort(b)) - Number(isExactShort(a)))
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
    positionDropdown();
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
// assessment for any of the student's own 8 selected courses, Sunday
// through Saturday. Builds the current week plus the following 3. Rebuilt once the
// assessments collection loads, and whenever a period is typed/cleared.

const ASSESSMENT_CALENDAR_WEEK_COUNT = 4;
const ASSESSMENT_CALENDAR_WEEKDAYS_PER_WEEK = 7;

const CAL_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

// Assigned in period order, one per distinct course. Skips yellow and lime,
// which are too faint for a dot or pill text on a light background.
const COURSE_COLOR_PALETTE = ["red", "dark-blue", "orange", "purple", "light-blue", "green", "pink", "teal"];

// Every color the Course Colors picker offers, in picker order.
const COURSE_COLOR_CHOICES = [
  "red", "coral", "orange", "amber", "yellow", "lime", "true-green", "green",
  "teal", "cyan", "light-blue", "dark-blue", "indigo", "purple", "magenta", "pink",
  "rose", "brown", "slate", "gray",
];

// Each distinct typed course, in period order, with its color name: the one
// picked for it, else the palette's next default. Keyed by the typed name, so a
// course in two periods keeps one color.
function courseColorNames() {
  const picked = window.getPreferences().courseColors || {};
  const colors = new Map();
  loadPeriods().forEach((name) => {
    const trimmed = (name || "").trim();
    if (trimmed === "" || colors.has(trimmed)) return;
    const fallback = COURSE_COLOR_PALETTE[colors.size % COURSE_COLOR_PALETTE.length];
    colors.set(trimmed, COURSE_COLOR_CHOICES.includes(picked[trimmed]) ? picked[trimmed] : fallback);
  });
  return colors;
}

function courseColorAssignments() {
  return new Map([...courseColorNames()].map(([name, color]) => [name, `var(--color-${color})`]));
}

let openCourseColorPicker = null; // { anchor, panel }

// Same entrance and exit as Domain's date popup, but opening to the left of the
// dot and growing out of the side facing it.
function closeCourseColorPicker() {
  if (!openCourseColorPicker) return;
  const { panel } = openCourseColorPicker;
  openCourseColorPicker = null;
  // A swatch's tooltip won't get a mouseleave once its panel is gone.
  hideHoverTooltip();
  panel.classList.remove("course-color-picker--visible");
  setTimeout(() => panel.remove(), 180);
}

function openCourseColorPickerFor(anchor, courseName, currentColor) {
  const panel = document.createElement("div");
  panel.className = "course-color-picker";
  COURSE_COLOR_CHOICES.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "course-color-swatch";
    if (color === currentColor) swatch.classList.add("course-color-swatch--selected");
    swatch.style.setProperty("--chip-color", `var(--color-${color})`);
    swatch.setAttribute("aria-label", color.replace("-", " "));
    const colorLabel = color.replace("-", " ");
    attachHoverTooltip(swatch, colorLabel[0].toUpperCase() + colorLabel.slice(1));
    swatch.addEventListener("click", () => {
      closeCourseColorPicker();
      if (color === currentColor) return;
      const picked = { ...(window.getPreferences().courseColors || {}), [courseName]: color };
      window.setPreference("courseColors", picked);
    });
    panel.appendChild(swatch);
  });
  document.body.appendChild(panel);

  const dot = anchor.querySelector(".course-color-dot").getBoundingClientRect();
  // offsetWidth/Height, not getBoundingClientRect: the panel starts scaled
  // down, and the rect would measure that shrunken size.
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const dotCenterY = dot.top + dot.height / 2;
  const top = Math.max(8, Math.min(dotCenterY - height / 2, window.innerHeight - height - 8));
  panel.style.top = `${top}px`;
  // Leaves room for the pointer, whose tip sits 8px from the dot.
  panel.style.left = `${Math.max(8, dot.left - 24 - width)}px`;
  panel.style.setProperty("--pointer-y", `${dotCenterY - top}px`);
  panel.style.transformOrigin = `calc(100% + 16px) ${dotCenterY - top}px`;

  void panel.offsetWidth; // force reflow so the entrance transition below actually plays
  panel.classList.add("course-color-picker--visible");
  openCourseColorPicker = { anchor, panel };
}

document.addEventListener("click", (event) => {
  if (!openCourseColorPicker) return;
  if (event.target.closest(".course-color-picker") || openCourseColorPicker.anchor.contains(event.target)) return;
  closeCourseColorPicker();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCourseColorPicker();
});

// Which "Show on Calendar" filter an assessment falls under. Reassessments are
// entered as a custom type, so they're recognized by name.
function assessmentCategory(entry) {
  if (/reassess/i.test(entry.type)) return "reassessment";
  if (entry.type === "In-Class" || entry.type === "Testing Block" || entry.type === "Summative") return "summative";
  if (entry.type === "Homework" || entry.type === "Assignment") return "assignment";
  return "formative";
}

// Strips a trailing " (division)" — used to hide the division on a pill
// once it's unambiguous which one applies (see resolvedNames above).
function stripDivisionSuffix(courseName) {
  return courseName.replace(/ \([^)]*\)$/, "");
}

// Shows short in textEl in place of full whenever full would be cut off by
// windowEl (the two can be the same element). Checked once the window is laid
// out and again whenever its size changes, since a hidden grid can't be
// measured and a day's width follows the page's.
const nameFitObserver = new ResizeObserver((records) =>
  records.forEach(({ target }) => {
    if (!target.isConnected) nameFitObserver.unobserve(target);
    else target._fitName();
  })
);

function fitName(windowEl, textEl, full, short) {
  textEl.textContent = full;
  if (!short || short === full) return;
  windowEl._fitName = () => {
    textEl.textContent = full;
    if (textEl.scrollWidth > windowEl.clientWidth) textEl.textContent = short;
  };
  nameFitObserver.observe(windowEl);
}

// The Sunday that starts the (Sun-Sat) week containing `date`.
function startOfWeek(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
}

function buildAssessmentPill(entry, resolvedNames, onContextMenu, courseColors) {
  const pill = document.createElement("span");
  const category = assessmentCategory(entry);
  // Reassessments share the summative look, as in the "Show on Calendar" key.
  const kind = category === "assignment" ? "assignment" : category === "formative" ? "formative" : "summative";
  // A plain assignment, not classList.add — must come before every
  // classList.add call below, or it wipes them out.
  pill.className = `assessment-chip assessment-chip--${kind}`;
  attachHoverTooltip(
    pill,
    entry.type === "Testing Block"
      ? "Testing Block"
      : { summative: "Summative", reassessment: "Reassessment", formative: "Formative", assignment: "Assignment" }[category]
  );
  // Matches this pill up with itself across rebuilds (see animatePillChanges).
  pill.dataset.entryId = entry.id;

  const dot = document.createElement("span");
  dot.className = "assessment-chip-dot";
  pill.appendChild(dot);

  // Drop the "(division)" suffix once the student's picked division makes
  // it unambiguous.
  const strippedName = stripDivisionSuffix(entry.courseName);
  const label = resolvedNames.has(strippedName) ? strippedName : entry.courseName;
  const color = courseColors.get(entry.courseName) || courseColors.get(strippedName);
  if (color) pill.style.setProperty("--chip-color", color);
  // Text lives in its own inner .assessment-pill-text span — the outer
  // .assessment-pill-name is the fixed-width clipping window, this inner
  // one is what the hover marquee (see buildDayCell below) scrolls.
  const nameEl = document.createElement("span");
  nameEl.className = "assessment-pill-name";
  const nameText = document.createElement("span");
  nameText.className = "assessment-pill-text";
  // A custom label (e.g. "Reassessment") isn't told apart by the pill's style
  // alone, so its type text stays in the name.
  const isCustomType = !["In-Class", "Testing Block", "Summative", "Formative", "Assignment"].includes(entry.type);
  const shortLabel = shortCourseName(label);
  const withType = (name) => (isCustomType ? `${name} ${entry.type}` : name);
  nameEl.appendChild(nameText);
  fitName(nameEl, nameText, withType(label), shortLabel && withType(shortLabel));
  if (kind === "assignment") {
    // The course on top and what's due underneath, like a to-do item.
    const lines = document.createElement("span");
    lines.className = "assessment-chip-lines";
    const subtitle = document.createElement("span");
    subtitle.className = "assessment-chip-subtitle";
    subtitle.textContent = entry.title || "";
    lines.append(nameEl, subtitle);
    pill.appendChild(lines);
  } else {
    pill.appendChild(nameEl);
  }
  pill.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    onContextMenu(entry, pill);
  });
  return pill;
}

const PILL_FADE_MS = 200;
const PILL_MOVE_MS = 200;

// The pills each day showed, in order, keyed by date. Pills still on their way
// out from an earlier change are left out; as far as the calendar is
// concerned they're already gone.
function renderedPillsByDate(weeksContainer) {
  const byDate = new Map();
  weeksContainer.querySelectorAll(".assessment-week-day").forEach((cell) => {
    const pills = [...cell.querySelectorAll(".assessment-chip")].filter(
      (pill) => !pill.closest(".assessment-pill-slot--leaving")
    );
    byDate.set(
      cell.dataset.iso,
      pills.map((pill) => ({ id: pill.dataset.entryId, el: pill }))
    );
  });
  return byDate;
}

// A pill coming or going sits in a slot whose height is what animates: the pill
// can't shrink below its own padding and border, but a slot with overflow
// hidden can squeeze it down to nothing. A bottom margin of minus the list's
// gap cancels the gap too, so a closed slot takes no room at all.
function pillListGap(list) {
  return parseFloat(getComputedStyle(list).rowGap) || 0;
}

// The pills below move down to make room first, then the new one fades into
// the space.
function enterPill(pill) {
  const list = pill.parentElement;
  const slot = document.createElement("div");
  slot.className = "assessment-pill-slot";
  pill.replaceWith(slot);
  slot.appendChild(pill);
  const height = slot.offsetHeight;
  const gap = pillListGap(list);
  slot.animate(
    [
      { height: "0px", marginBottom: `${-gap}px` },
      { height: `${height}px`, marginBottom: "0px" },
    ],
    { duration: PILL_MOVE_MS, easing: "ease" }
  );
  // Held invisible by the fade's own backwards fill while the slot opens,
  // rather than by an inline opacity: pills have an opacity transition (for
  // the pick-a-date dimming), which would fade an inline 0 in gradually and
  // leave the pill showing, cut off, as its space opens.
  pill
    .animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: PILL_FADE_MS,
      delay: PILL_MOVE_MS,
      easing: "ease",
      fill: "backwards",
    })
    .finished.catch(() => {})
    .finally(() => {
      if (slot.isConnected && pill.parentElement === slot) slot.replaceWith(pill);
    });
}

// The pill fades out where it was, then its space closes and the pills below
// move up into it. before is the pill it goes back in front of (null: the end).
function leavePill(pill, list, before) {
  pill.getAnimations().forEach((animation) => animation.cancel());
  pill.style.opacity = "";
  pill.querySelectorAll(".assessment-pill-text").forEach((textEl) => {
    cancelMarqueeReturn(textEl);
    textEl.classList.remove("assessment-pill-text--marquee-in", "assessment-pill-text--marquee-loop");
  });
  const slot = document.createElement("div");
  slot.className = "assessment-pill-slot assessment-pill-slot--leaving";
  list.insertBefore(slot, before);
  slot.appendChild(pill);
  const height = slot.offsetHeight;
  const gap = pillListGap(list);
  pill
    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: PILL_FADE_MS, easing: "ease", fill: "forwards" })
    .finished.then(
      () =>
        slot.animate(
          [
            { height: `${height}px`, marginBottom: "0px" },
            { height: "0px", marginBottom: `${-gap}px` },
          ],
          { duration: PILL_MOVE_MS, easing: "ease", fill: "forwards" }
        ).finished
    )
    .catch(() => {})
    .finally(() => slot.remove());
}

// Compares each day's pills before and after a rebuild: new ones animate in,
// and ones that are gone are put back where they were so they can animate out.
function animatePillChanges(weeksContainer, pillsBefore) {
  weeksContainer.querySelectorAll(".assessment-week-day").forEach((cell) => {
    const before = pillsBefore.get(cell.dataset.iso);
    if (!before) return;
    const list = cell.querySelector(".assessment-week-day-pills");
    const pillsNow = [...list.querySelectorAll(".assessment-chip")];
    const idsNow = new Set(pillsNow.map((pill) => pill.dataset.entryId));
    const idsBefore = new Set(before.map(({ id }) => id));

    pillsNow.forEach((pill) => {
      if (!idsBefore.has(pill.dataset.entryId)) enterPill(pill);
    });
    // A departing pill goes back in just before the next pill after it that's
    // staying, so it leaves from the spot it was actually in.
    before.forEach(({ id, el }, index) => {
      if (idsNow.has(id)) return;
      const nextStaying = before.slice(index + 1).find((later) => idsNow.has(later.id));
      const anchor = nextStaying ? pillsNow.find((pill) => pill.dataset.entryId === nextStaying.id) : null;
      leavePill(el, list, anchor);
    });
  });
}

const CAL_MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// weekdayLabel is only passed for the top row, where each cell carries its
// column's weekday name above its date (there's no separate header row).
const MARQUEE_RETURN_FADE_MS = 250;
// How long the mouse has to stay still over a day before its names scroll.
const MARQUEE_REST_MS = 150;

// Leaving a scrolling name: rather than snapping back to its start mid-scroll,
// it fades out where it is, jumps back while invisible, and fades back in.
function returnMarqueeText(textEl) {
  const stopMarquee = () =>
    textEl.classList.remove("assessment-pill-text--marquee-in", "assessment-pill-text--marquee-loop");
  textEl.style.transition = `opacity ${MARQUEE_RETURN_FADE_MS}ms ease`;
  textEl.style.opacity = "0";
  textEl._marqueeReturnTimer = setTimeout(() => {
    stopMarquee();
    textEl.style.opacity = "";
    textEl._marqueeReturnTimer = setTimeout(() => {
      textEl.style.transition = "";
      textEl._marqueeReturnTimer = null;
    }, MARQUEE_RETURN_FADE_MS);
  }, MARQUEE_RETURN_FADE_MS);
}

function cancelMarqueeReturn(textEl) {
  if (!textEl._marqueeReturnTimer) return;
  clearTimeout(textEl._marqueeReturnTimer);
  textEl._marqueeReturnTimer = null;
  textEl.classList.remove("assessment-pill-text--marquee-in", "assessment-pill-text--marquee-loop");
  textEl.style.transition = "";
  textEl.style.opacity = "";
}

function buildDayCell(weeksContainer, date, entriesByDate, resolvedNames, onContextMenu, courseColors, weekdayLabel = null) {
  const iso = toISODate(date);
  const today = new Date();

  const cell = document.createElement("div");
  cell.className = "assessment-week-day";
  cell.dataset.iso = iso;
  if (date.getDay() === 0 || date.getDay() === 6) cell.classList.add("assessment-week-day--weekend");

  if (weekdayLabel) {
    cell.classList.add("assessment-week-day--first-row");
    const weekday = document.createElement("span");
    weekday.className = "assessment-week-day-weekday";
    weekday.textContent = weekdayLabel;
    cell.appendChild(weekday);
  }

  // The 1st of a month also gets the month ("Dec"), to the left of the date
  // — which itself stays centered over the column like every other day's.
  // So does the grid's first cell, so the month is named from the start.
  const head = document.createElement("div");
  head.className = "assessment-week-day-head";
  const isFirstCell = weekdayLabel === CAL_WEEKDAY_LABELS[0];
  if (date.getDate() === 1 || isFirstCell) {
    const month = document.createElement("span");
    month.className = "assessment-week-day-month";
    month.textContent = CAL_MONTH_SHORT[date.getMonth()];
    head.appendChild(month);
  }

  const dayNumber = document.createElement("span");
  dayNumber.className = "assessment-week-day-number";
  dayNumber.textContent = String(date.getDate());
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    dayNumber.classList.add("assessment-week-day-number--today");
  }
  head.appendChild(dayNumber);
  cell.appendChild(head);

  // Testing blocks always lead the list — a stable sort, so entries
  // without one keep their original relative order.
  const entries = (entriesByDate[iso] || [])
    .slice()
    .sort((a, b) => Number(b.type === "Testing Block") - Number(a.type === "Testing Block"));

  const pillList = document.createElement("div");
  pillList.className = "assessment-week-day-pills";
  entries.forEach((entry) =>
    pillList.appendChild(buildAssessmentPill(entry, resolvedNames, onContextMenu, courseColors))
  );
  cell.appendChild(pillList);

  // Which school day it is, shown in the corner on hover.
  const dayType = allDayTypes[iso];
  if (dayType === "A" || dayType === "B") {
    const dayTypeLabel = document.createElement("span");
    dayTypeLabel.className = "assessment-week-day-type";
    dayTypeLabel.textContent = dayType;
    cell.appendChild(dayTypeLabel);
  }

  // LED-sign-style auto-scroll, but only for text that's actually cut off
  // — checked fresh on every hover, since which names overflow can change
  // with the day cell's own width. Starts on the one-shot "-in" variant
  // (see calendar.css) so the very first pass continues from the text's
  // current position instead of jumping offscreen first; once that pass's
  // animationend fires below, it hands off to the ordinary looping variant.
  // Starts only once the mouse comes to rest over the day, so sweeping across
  // the calendar doesn't set every name scrolling. Once it has started it
  // keeps going for as long as the mouse stays on the day, moving or not.
  let restTimer = null;
  let marqueeStarted = false;
  const startMarquee = () => {
    marqueeStarted = true;
    cell.querySelectorAll(".assessment-pill-text").forEach((textEl) => {
      if (textEl.scrollWidth > textEl.parentElement.clientWidth) {
        textEl.classList.add("assessment-pill-text--marquee-in");
      }
    });
  };
  const waitForRest = () => {
    if (marqueeStarted) return;
    clearTimeout(restTimer);
    restTimer = setTimeout(startMarquee, MARQUEE_REST_MS);
  };
  cell.addEventListener("mouseenter", () => {
    // Back before a leave's fade finished: drop it and start clean.
    cell.querySelectorAll(".assessment-pill-text").forEach(cancelMarqueeReturn);
    waitForRest();
  });
  cell.addEventListener("mousemove", waitForRest);
  cell.addEventListener("mouseleave", () => {
    clearTimeout(restTimer);
    marqueeStarted = false;
    cell
      .querySelectorAll(".assessment-pill-text--marquee-in, .assessment-pill-text--marquee-loop")
      .forEach(returnMarqueeText);
  });
  cell.addEventListener("animationend", (event) => {
    if (event.animationName !== "assessment-pill-marquee-in") return;
    event.target.classList.remove("assessment-pill-text--marquee-in");
    event.target.classList.add("assessment-pill-text--marquee-loop");
  });

  weeksContainer.appendChild(cell);
}

// Wires the render; returns a render()
// function so callers elsewhere (e.g. a period being typed) can trigger a
// refresh. A no-op (returns null) on any page without the calendar markup.
function initAssessmentCalendar() {
  const cardEl = document.getElementById("my-courses-calendar-card");
  const weeksContainer = document.getElementById("assessment-cal-weeks");
  if (!weeksContainer) return null;

  const loadingEl = document.getElementById("assessment-cal-loading");

  // Which assessment ids were on screen after the last render — compared
  // on the next one so a render that changes nothing can be skipped.
  let previousPillIds = new Set();
  let previousMatchNamesKey = "";
  // False until this calendar has actually built its grid once — nothing
  // should animate in on the tab's own initial load, only on a genuinely
  // live change afterward (a filter, a new or removed assessment, etc.).
  let calendarSettled = false;
  // Ids of this render's self-added entries — read by handlePillContextMenu
  // below, kept fresh every render rather than threaded through the whole
  // buildDayCell/buildAssessmentPill call chain.
  let currentAddedIds = new Set();
  // "Show on Calendar" filters turned off. Deliberately not saved, so every
  // visit starts with everything shown.
  const hiddenCategories = new Set();

  function deleteAddedAssessment(id) {
    const entries = loadAddedAssessments();
    const removed = entries.find((entry) => entry.id === id);
    saveAddedAssessments(entries.filter((entry) => entry.id !== id));
    // Assignments were never suggested to admins, so there's nothing to take back.
    if (removed && removed.type !== "Assignment") unlogSuggestedAssessment(removed.date, removed.courseName, removed.type);
    render(true, false);
  }

  // Right-click on a pill: only a self-added entry can be removed —
  // anything from the admin-scheduled collection just explains why not.
  function handlePillContextMenu(entry, pillEl) {
    if (!currentAddedIds.has(entry.id)) {
      showToast("Only assessments added by you can be removed.");
      return;
    }
    deleteAddedAssessment(entry.id);
  }

  const CALENDAR_REVEAL_MS = 300;

  // Fades in only when actually asked to — never on page load itself,
  // even for an account that already has courses.
  function revealCalendarCard(animate) {
    if (!cardEl || !cardEl.hidden) return;
    cardEl.hidden = false;
    if (!animate) return;
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

    // Keyed by each assessment's resolved course name (division included), so
    // pills can look their color up directly.
    const colorNames = courseColorNames();
    const typedColors = courseColorAssignments();
    renderCourseColorLegend(colorNames);

    // Also reused as refreshAssessmentCalendar whenever a period/division
    // changes — skip if the assessments/day-type collections haven't
    // loaded yet; loadAssessmentData below guarantees a real render once they do.
    if (!assessmentsLoaded || !dayTypesLoaded) return;

    const { matchEntries, resolvedNames } = myAssessmentMatchEntries();
    const periods = loadPeriods();
    const courseColors = new Map([
      ...typedColors,
      ...matchEntries.map((entry) => [entry.name, typedColors.get((periods[entry.periodIndex] || "").trim())]),
    ]);
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
    renderUpcoming(schoolWideEntries.concat(effectiveAddedEntries), resolvedNames, courseColors, matchEntries);
    const matchingEntries = schoolWideEntries
      .concat(effectiveAddedEntries)
      .filter((entry) => !hiddenCategories.has(assessmentCategory(entry)));
    // Colors are part of the key, so picking a new one repaints the pills.
    const matchNamesKey =
      matchEntries.map((entry) => `${entry.name}|${entry.periodIndex}`).join(" ") + " " + [...colorNames.values()].join(" ");

    // loadAssessments can call this render's callback twice on the very
    // first load: once from a cache, then again once the real fetch
    // confirms it. If that confirmation shows the same assessments, skip
    // rebuilding the grid — otherwise it would replace pills still
    // mid-animation, cutting it short. matchNamesKey is checked
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
    // card's own reveal fade. Pills animate in and out on any later render,
    // just not on the calendar's own first-ever build (nothing should animate
    // in just from opening the tab).
    const animatePills = calendarSettled;
    calendarSettled = true;
    const pillsBefore = animatePills ? renderedPillsByDate(weeksContainer) : null;

    // The pill under the cursor is about to be replaced, and its mouseleave
    // won't fire to hide its tooltip.
    hideHoverTooltip();
    weeksContainer.innerHTML = "";
    const thisWeekStart = startOfWeek(new Date());
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
          handlePillContextMenu,
          courseColors,
          weekIndex === 0 ? CAL_WEEKDAY_LABELS[dayIndex] : null
        );
      }
    }
    previousPillIds = new Set(matchingEntries.map((entry) => entry.id));
    previousMatchNamesKey = matchNamesKey;

    // Reveal the real calendar (and hide the spinner) the first time this
    // runs. Done before the pill animations below, which measure pill heights
    // and can't inside a still-hidden grid.
    loadingEl.hidden = true;
    weeksContainer.hidden = false;

    if (pillsBefore) animatePillChanges(weeksContainer, pillsBefore);
  }

  // The Upcoming card: the next UPCOMING_LIMIT things due, soonest first, laid
  // out like Google Tasks, each with a circle to check it off. An assignment
  // still unchecked after its day stays at the top as overdue; an assessment
  // simply drops off once its day has passed.
  const upcomingList = document.getElementById("upcoming-list");
  let lastUpcomingArgs = null;

  // The blurred copy of the list shown under the header (see .upcoming-blur).
  // Re-copied whenever the list changes, and lined up with it on every
  // scroll and resize.
  const upcomingBlur = upcomingList && upcomingList.parentElement.querySelector(".upcoming-blur");
  let upcomingBlurCopy = null;

  function copyUpcomingForBlur() {
    upcomingBlurCopy = document.createElement("div");
    upcomingBlurCopy.className = "upcoming-blur-copy";
    upcomingBlurCopy.append(...[...upcomingList.children].map((node) => node.cloneNode(true)));
    upcomingBlur.replaceChildren(upcomingBlurCopy);
    placeUpcomingBlur();
  }

  function placeUpcomingBlur() {
    // For the fades, which leave the scrollbar alone (see .upcoming-list).
    // At least UPCOMING_SCROLLBAR_MIN_PX: an overlay scrollbar (macOS) takes
    // no room of its own, so it measures 0 while still drawn over the rows'
    // right padding.
    const scrollbarWidth = Math.max(UPCOMING_SCROLLBAR_MIN_PX, upcomingList.offsetWidth - upcomingList.clientWidth);
    upcomingList.closest(".todo-card").style.setProperty("--upcoming-scrollbar-w", `${scrollbarWidth}px`);
    upcomingBlur.style.top = `${upcomingList.offsetTop}px`;
    if (!upcomingBlurCopy) return;
    upcomingBlurCopy.style.marginLeft = `${upcomingList.offsetLeft}px`;
    // clientWidth, so the copy's rows wrap the same as the real ones beside
    // the scrollbar.
    upcomingBlurCopy.style.width = `${upcomingList.clientWidth}px`;
    upcomingBlurCopy.style.paddingTop = getComputedStyle(upcomingList).paddingTop;
    upcomingBlurCopy.style.transform = `translateY(${-upcomingList.scrollTop}px)`;
  }

  if (upcomingBlur) {
    let copyFrame = 0;
    new MutationObserver(() => {
      cancelAnimationFrame(copyFrame);
      copyFrame = requestAnimationFrame(copyUpcomingForBlur);
    }).observe(upcomingList, { childList: true, subtree: true, characterData: true, attributes: true });
    upcomingList.addEventListener("scroll", placeUpcomingBlur, { passive: true });
    new ResizeObserver(placeUpcomingBlur).observe(upcomingList);
  }

  // Whether the Completed section is open. Not saved: it starts closed.
  let completedExpanded = false;

  function renderUpcoming(entries, resolvedNames, courseColors, matchEntries) {
    if (!upcomingList) return;
    lastUpcomingArgs = [entries, resolvedNames, courseColors, matchEntries];
    const today = todayISODate();
    const completed = new Map(completedTaskRecords().map((record) => [record.id, record.completedAt]));
    const periodIndexOf = new Map(matchEntries.map((entry) => [entry.name, entry.periodIndex]));
    const due = entries
      .filter((entry) => !completed.has(entry.id))
      .filter((entry) => entry.date >= today || assessmentCategory(entry) === "assignment")
      .sort((a, b) => (a.date === b.date ? dueTimeRank(a) - dueTimeRank(b) : a.date < b.date ? -1 : 1))
      .slice(0, UPCOMING_LIMIT);

    // Checked off in the last COMPLETED_SHOWN_DAYS, most recent first.
    const recentCutoff = Date.now() - COMPLETED_SHOWN_DAYS * 86400000;
    const recentlyCompleted = entries
      .filter((entry) => completed.has(entry.id) && completed.get(entry.id) >= recentCutoff)
      .sort((a, b) => completed.get(b.id) - completed.get(a.id));

    const itemFor = (entry, done) => {
      const strippedName = stripDivisionSuffix(entry.courseName);
      const courseLabel = resolvedNames.has(strippedName) ? strippedName : entry.courseName;
      const color = courseColors.get(entry.courseName) || courseColors.get(strippedName);
      const periodIndex = periodIndexOf.get(entry.courseName);
      // An assignment turns overdue once its moment passes, not only once
      // its day has.
      const dueAt = upcomingDueAt(entry, periodIndex);
      const overdue =
        !done &&
        assessmentCategory(entry) === "assignment" &&
        (entry.date < today || (dueAt !== null && dueAt <= new Date()));
      return buildUpcomingItem(entry, courseLabel, color, periodIndex, overdue, done);
    };

    upcomingList.innerHTML = "";
    due.forEach((entry) => upcomingList.appendChild(itemFor(entry, false)));
    if (due.length === 0) {
      const empty = upcomingList.appendChild(document.createElement("li"));
      empty.className = "upcoming-empty";
      empty.textContent = "Nothing coming up";
    }
    if (recentlyCompleted.length > 0) {
      const toggleItem = upcomingList.appendChild(document.createElement("li"));
      const toggle = toggleItem.appendChild(document.createElement("button"));
      toggle.type = "button";
      toggle.className = "upcoming-completed-toggle";
      toggle.setAttribute("aria-expanded", String(completedExpanded));
      toggle.innerHTML = `<span>Completed (${recentlyCompleted.length})</span>${ICON_CHEVRON_DOWN}`;
      toggle.addEventListener("click", () => {
        completedExpanded = !completedExpanded;
        renderUpcoming(...lastUpcomingArgs);
      });
      if (completedExpanded) recentlyCompleted.forEach((entry) => upcomingList.appendChild(itemFor(entry, true)));
    }
    tickUpcomingCountdowns();
  }

  // Once a second: each item due within UPCOMING_COUNTDOWN_MS shows the time
  // left, its digits rolling like an odometer; one whose moment has come
  // rebuilds the list, so it can turn overdue or drop off.
  function tickUpcomingCountdowns() {
    const now = Date.now();
    let passed = false;
    upcomingList.querySelectorAll(".upcoming-item[data-due-at]").forEach((item) => {
      const countdown = item.querySelector(".upcoming-countdown");
      const left = Number(item.dataset.dueAt) - now;
      if (left <= 0 && !countdown.hidden) passed = true;
      const show = left > 0 && left < UPCOMING_COUNTDOWN_MS;
      // Appearing, it starts on the right numbers rather than rolling up to
      // them from nothing.
      const style = countdown.hidden ? "instant" : undefined;
      countdown.hidden = !show;
      if (!show) return;
      const totalSeconds = Math.ceil(left / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      // Rolled as three separate numbers: the roll picks its direction from
      // the number as a whole, so "2:14:05" as one would read as just 2.
      countdown.classList.toggle("upcoming-countdown--under-hour", hours === 0);
      animateNumberChange(countdown.querySelector(".upcoming-countdown-hours"), String(hours), style);
      animateNumberChange(
        countdown.querySelector(".upcoming-countdown-minutes"),
        String(minutes).padStart(2, "0"),
        style
      );
      animateNumberChange(
        countdown.querySelector(".upcoming-countdown-seconds"),
        String(seconds).padStart(2, "0"),
        style
      );
    });
    if (passed && lastUpcomingArgs) renderUpcoming(...lastUpcomingArgs);
  }
  if (upcomingList) setInterval(tickUpcomingCountdowns, 1000);

  // done: an item in the Completed section, whose ring un-checks it.
  function buildUpcomingItem(entry, courseLabel, color, periodIndex, overdue, done) {
    const item = document.createElement("li");
    item.className = "upcoming-item";
    if (done) item.classList.add("upcoming-item--done", "upcoming-item--completed");
    if (color) item.style.setProperty("--chip-color", color);

    const check = document.createElement("button");
    check.type = "button";
    check.className = "upcoming-check";
    check.setAttribute("aria-label", done ? "Mark not complete" : "Mark complete");
    check.innerHTML = '<span class="upcoming-check-icon" aria-hidden="true"></span>';
    item.appendChild(check);
    // Anywhere on the item, not just the ring: a click on the ring (or the
    // ring pressed with the keyboard) reaches here too.
    item.addEventListener("click", () =>
      done ? uncompleteUpcomingItem(entry.id) : completeUpcomingItem(item, entry.id)
    );

    const titleEl = item.appendChild(document.createElement("span"));
    titleEl.className = "upcoming-title";
    titleEl.textContent = upcomingTitle(entry);
    const courseEl = item.appendChild(document.createElement("span"));
    courseEl.className = "upcoming-course";
    courseEl.textContent = courseLabel;
    fitName(courseEl, courseEl, courseLabel, shortCourseName(courseLabel));

    const due = item.appendChild(document.createElement("div"));
    due.className = "upcoming-due";
    const chip = due.appendChild(document.createElement("span"));
    chip.className = "upcoming-date-chip";
    if (overdue) chip.classList.add("upcoming-date-chip--overdue");
    const time = entry.dueTime ? upcomingTimeLabel(entry.dueTime, periodIndex) : "";
    chip.textContent = upcomingDateLabel(entry.date) + (time ? `, ${time}` : "");
    // Under 12 hours out, a live countdown shows under the chip (see
    // tickUpcomingCountdowns). Not for something already done.
    const dueAt = done ? null : upcomingDueAt(entry, periodIndex);
    if (dueAt) {
      item.dataset.dueAt = String(dueAt.getTime());
      const countdown = due.appendChild(document.createElement("span"));
      countdown.className = "upcoming-countdown";
      countdown.hidden = true;
      countdown.innerHTML =
        '<span class="upcoming-countdown-hours-part"><span class="upcoming-countdown-hours"></span>:</span>' +
        '<span class="upcoming-countdown-minutes"></span>:<span class="upcoming-countdown-seconds"></span>';
    }
    return item;
  }

  // As in Google Tasks: the circle fills in with a check and the title is
  // struck through, then the item folds away and the next one due takes its
  // place. The toast's Undo puts it back.
  function completeUpcomingItem(item, id) {
    if (item.classList.contains("upcoming-item--done")) return;
    item.classList.add("upcoming-item--done");
    saveCompletedTasks([...completedTaskRecords(), { id, completedAt: Date.now() }]);
    setTimeout(() => foldAwayUpcomingItem(item), UPCOMING_DONE_HOLD_MS);

    const message = document.createDocumentFragment();
    message.append("Marked as complete. ");
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "toast-link";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => {
      hideToast();
      uncompleteUpcomingItem(id);
    });
    message.append(undo);
    showToast(message);
  }

  // The item fades out, then everything below it slides up into its space.
  // Opacity and transform only, which the browser can animate without
  // touching layout: shrinking the item's height instead relaid out and
  // repainted the whole (masked) list on every frame, and couldn't shrink
  // its padding, leaving a jump at the end. The list is then rebuilt
  // without it, every row landing right where the slide left it.
  function foldAwayUpcomingItem(item) {
    // Undone in the meantime, or the list already rebuilt.
    if (!item.isConnected) return;
    const shift = item.offsetHeight;
    const below = [];
    for (let row = item.nextElementSibling; row; row = row.nextElementSibling) below.push(row);
    const animations = [
      item.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: UPCOMING_FADE_MS,
        easing: "ease",
        fill: "forwards",
      }),
      ...below.map((row) =>
        row.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-shift}px)` }], {
          duration: UPCOMING_SLIDE_MS,
          delay: UPCOMING_FADE_MS * 0.6,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          fill: "forwards",
        })
      ),
    ];
    Promise.all(animations.map((animation) => animation.finished))
      .catch(() => {})
      .finally(() => {
        if (lastUpcomingArgs) renderUpcoming(...lastUpcomingArgs);
      });
  }

  // Back into the list, in its place by date.
  function uncompleteUpcomingItem(id) {
    saveCompletedTasks(completedTaskRecords().filter((record) => record.id !== id));
    if (lastUpcomingArgs) renderUpcoming(...lastUpcomingArgs);
  }

  function renderCourseColorLegend(colorNames) {
    const list = document.getElementById("course-color-list");
    if (!list) return;
    list.innerHTML = "";
    colorNames.forEach((color, name) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "course-color-item";
      button.style.setProperty("--chip-color", `var(--color-${color})`);
      const dot = document.createElement("span");
      dot.className = "course-color-dot";
      const label = document.createElement("span");
      label.className = "course-color-name";
      button.append(dot, label);
      fitName(label, label, name, shortCourseName(name));
      button.addEventListener("click", () => {
        const reopening = openCourseColorPicker && openCourseColorPicker.anchor === button;
        closeCourseColorPicker();
        if (!reopening) openCourseColorPickerFor(button, name, color);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  const filterButtons = document.querySelectorAll(".calendar-filter");
  filterButtons.forEach((btn) => {
    btn.setAttribute("aria-pressed", "true");
    btn.addEventListener("click", () => {
      const category = btn.dataset.category;
      const off = !hiddenCategories.has(category);
      if (off) hiddenCategories.add(category);
      else hiddenCategories.delete(category);
      btn.classList.toggle("calendar-filter--off", off);
      btn.setAttribute("aria-pressed", String(!off));
      render();
    });
  });
  // Course colors are saved preferences, so a pick made on another device
  // arrives this way too.
  window.addEventListener("app:preferences-changed", () => render());

  loadAssessmentData(() => render());

  return render;
}

// --- Add to calendar ---
// Lets a student add an assignment, or an assessment that isn't in the admin-
// scheduled collection yet — saved to their own addedAssessments (see
// shared.js), merged into the calendar above like any other entry. Missing
// assessments are also tallied in the school-wide "suggested" collection, so
// admins can see which come up across multiple students. Right-clicking a
// self-added pill removes it again — see handlePillContextMenu in
// initAssessmentCalendar.

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

// The types the + popup can add; noun goes in "New …" and "Add …".
const ADD_POPUP_TYPES = [
  { value: "Assignment", noun: "assignment" },
  { value: "Formative", noun: "formative" },
  { value: "Summative", noun: "summative" },
  { value: "Reassessment", noun: "reassessment" },
];
const CAL_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ADD_POPUP_STEP_MS = 220;
const UPCOMING_LIMIT = 10;
// How long a checked-off Upcoming item stays, struck through, before folding
// away.
const UPCOMING_DONE_HOLD_MS = 600;
// The narrowest strip kept clear of the Upcoming list's fades for its
// scrollbar.
const UPCOMING_SCROLLBAR_MIN_PX = 10;
// Then it fades out, and the items below slide up into its place.
const UPCOMING_FADE_MS = 150;
const UPCOMING_SLIDE_MS = 260;

// An Upcoming item's title: an assignment's own description, else what kind
// of assessment it is.
function upcomingTitle(entry) {
  if (assessmentCategory(entry) === "assignment") return entry.title || "Homework";
  return entry.type === "In-Class" ? "Summative" : entry.type;
}

// Orders things due the same day: the start of the day first, then by
// period, then by clock time.
function dueTimeRank(entry) {
  if (!entry.dueTime || entry.dueTime === "start") return -2;
  if (entry.dueTime === "period") return -1;
  const [hours, minutes] = entry.dueTime.split(":").map(Number);
  return hours * 60 + minutes;
}

// Like Google Tasks' date chip: a relative day nearby, the weekday within
// the week, else the weekday and date.
function upcomingDateLabel(iso) {
  const date = fromISODate(iso);
  const today = fromISODate(todayISODate());
  const days = Math.round((date - today) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return CAL_WEEKDAY_NAMES[date.getDay()];
  return `${CAL_WEEKDAY_LABELS[date.getDay()]}, ${window.formatPreferredDate(date)}`;
}

// "15:30" as "3:30 PM".
function formatClockTime(hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

// How far back the Upcoming card's Completed section goes.
const COMPLETED_SHOWN_DAYS = 14;

// What's been checked off, as { id, completedAt }. Ids of things that no
// longer exist anywhere (an assignment deleted, an assessment the admin
// removed) are dropped and the list saved without them, so it doesn't grow
// forever. Checked against every assessment, not just this student's current
// courses, so taking a course off My Courses for a while loses nothing.
function completedTaskRecords() {
  const records = loadCompletedTasks().map((record) =>
    // The ids-only form from before completedAt was kept; counted as done now.
    typeof record === "string" ? { id: record, completedAt: Date.now() } : record
  );
  if (!assessmentsLoaded) return records;
  const known = new Set([...allAssessments, ...loadAddedAssessments()].map((entry) => entry.id));
  const kept = records.filter((record) => known.has(record.id));
  if (kept.length !== records.length) saveCompletedTasks(kept);
  return kept;
}

// How close something has to be due before its countdown shows.
const UPCOMING_COUNTDOWN_MS = 12 * 60 * 60 * 1000;

// The moment something is due, from the admin's bell schedule: an assignment
// at its own time, the start of its class period, or the start of the school
// day; an assessment at the start of its class. null when there's no
// schedule to go by (no period times set, or the class doesn't meet that
// day).
function upcomingDueAt(entry, periodIndex) {
  const at = (hhmm) => {
    const [hours, minutes] = hhmm.split(":").map(Number);
    const date = fromISODate(entry.date);
    date.setHours(hours, minutes, 0, 0);
    return date;
  };
  const dueTime = assessmentCategory(entry) === "assignment" ? entry.dueTime || "start" : "period";
  if (/^\d{1,2}:\d{2}$/.test(dueTime)) return at(dueTime);
  const times = defaultPeriodTimes && defaultPeriodTimes.times;
  if (!times) return null;
  if (dueTime === "start") {
    const first = times.find((time) => time && time.start);
    return first ? at(first.start) : null;
  }
  // A period's start, on a day it actually meets: periods 1-4 on A days,
  // 5-8 on B days.
  if (periodIndex === undefined) return null;
  if (allDayTypes[entry.date] !== (periodIndex < 4 ? "A" : "B")) return null;
  const blockIndex = SCHEDULE_BLOCKS.findIndex((block) => block.slot === periodIndex % 4);
  const time = times[blockIndex];
  return time && time.start ? at(time.start) : null;
}

// The time part of the chip; nothing for the start of the day.
function upcomingTimeLabel(dueTime, periodIndex) {
  if (dueTime === "start") return "";
  if (dueTime === "period") return periodIndex === undefined ? "" : `Period ${periodIndex + 1}`;
  return formatClockTime(dueTime);
}
const CALENDAR_PICK_FADE_MS = 200;

// The next few days a course meets after today: its A-days (periods 1-4) or
// B-days (periods 5-8) on the school calendar. With no school calendar to go
// on, every weekday.
function upcomingClassDays(periodIndex, count) {
  const days = [];
  const today = new Date();
  const hasSchoolCalendar = Object.keys(allDayTypes).length > 0;
  for (let offset = 1; offset <= 120 && days.length < count; offset++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const dayType = allDayTypes[toISODate(date)];
    const meets = hasSchoolCalendar
      ? (dayType === "A" && periodIndex < 4) || (dayType === "B" && periodIndex >= 4)
      : date.getDay() !== 0 && date.getDay() !== 6;
    if (meets) days.push(date);
  }
  return days;
}

const ICON_BACK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4.5L6.5 10l5.5 5.5" /></svg>';
const ICON_CHEVRON_DOWN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5l5 5-5 5" /></svg>';

// The Upcoming card's + opens this, anchored under the button like a menu.
// The + menu picks the type, step 1 the course; picking a course turns the
// same popup into step 2, the details and date. An assignment is the
// student's own; an assessment is also suggested to admins, since it's one
// the school calendar is missing.
// Fills windowEl with text in the same clipping window and marquee as a
// Calendar pill's name, but scrolling as soon as hoverEl is hovered rather
// than waiting for the mouse to rest.
// shortText, if given, stands in for text whenever text is cut off (see
// fitName).
function attachHoverMarquee(hoverEl, windowEl, text, shortText = null) {
  const textEl = windowEl.appendChild(document.createElement("span"));
  textEl.className = "assessment-pill-text";
  fitName(windowEl, textEl, text, shortText);
  hoverEl.addEventListener("mouseenter", () => {
    cancelMarqueeReturn(textEl);
    if (textEl.scrollWidth > windowEl.clientWidth) textEl.classList.add("assessment-pill-text--marquee-in");
  });
  hoverEl.addEventListener("mouseleave", () => {
    if (
      textEl.classList.contains("assessment-pill-text--marquee-in") ||
      textEl.classList.contains("assessment-pill-text--marquee-loop")
    ) {
      returnMarqueeText(textEl);
    }
  });
  textEl.addEventListener("animationend", (event) => {
    if (event.animationName !== "assessment-pill-marquee-in") return;
    textEl.classList.remove("assessment-pill-text--marquee-in");
    textEl.classList.add("assessment-pill-text--marquee-loop");
  });
}

function initAddToCalendarPopup(refreshAssessmentCalendar) {
  const triggerBtn = document.getElementById("add-assessment-trigger-btn");
  if (!triggerBtn) return;
  attachHoverTooltip(triggerBtn, "Add to calendar");

  // Adding writes to this student's own addedAssessments (and suggested),
  // which needs a real uid. Signing in/out always reloads the page (see
  // handleAuthResolved), so currentUid here reflects this load's state.
  if (!currentUid) {
    triggerBtn.hidden = true;
    return;
  }

  let popup = null;
  let selectedType = ADD_POPUP_TYPES[0].value;
  let selectedCourse = null; // an addableCourseOptions() entry | null
  let selectedDate = null; // ISO string | null
  let title = "";
  // When on its day an assignment is due: "start" (the start of the day),
  // "period" (by the course's own period), or a custom "HH:MM".
  let dueTime = "start";

  const typeInfo = () => ADD_POPUP_TYPES.find((type) => type.value === selectedType);
  const isAssignment = () => selectedType === "Assignment";
  const colorFor = (option) => {
    const color = courseColorNames().get(option.displayName);
    return color ? `var(--color-${color})` : "var(--color-gray-dark)";
  };

  // The school-wide entry (if any) with the same course, type and date,
  // visible to this student's section or not. A course split across A- and
  // B-day sections can have one that only shows for the other section, so it
  // doesn't block adding one, but see submit() for why it isn't suggested.
  function matchingSchoolWideEntry() {
    if (!selectedCourse || !selectedDate) return null;
    return (
      allAssessments.find(
        (entry) =>
          entry.date === selectedDate && entry.courseName === selectedCourse.courseName && entry.type === selectedType
      ) || null
    );
  }

  // An assessment already on this student's calendar: one they added, or a
  // school-wide one their own section can see. Assignments can repeat.
  function isDuplicateSelection() {
    if (isAssignment() || !selectedCourse || !selectedDate) return false;
    const matchesSelection = (entry) =>
      entry.date === selectedDate && entry.courseName === selectedCourse.courseName && entry.type === selectedType;
    if (loadAddedAssessments().some(matchesSelection)) return true;
    const match = matchingSchoolWideEntry();
    return Boolean(match) && isAssessmentVisibleForPeriod(match, selectedCourse.periodIndex);
  }

  function canSubmit() {
    if (!selectedCourse || !selectedDate) return false;
    return !isDuplicateSelection();
  }

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function iconButton(icon, label, onClick) {
    const btn = el("button", "add-popup-icon-btn", icon);
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  // withDot puts the course's color dot in front of the title. A title too
  // long for one line switches to shortHeading if there is one, and past that
  // fades out at the edge and scrolls on hover, rather than wrapping.
  function header({ heading, shortHeading, back, withDot }) {
    const bar = el("div", "add-popup-header");
    if (back) bar.appendChild(iconButton(ICON_BACK, "Back", back));
    const title = bar.appendChild(el("h2", "add-popup-title"));
    if (withDot) title.appendChild(el("span", "add-popup-course-dot"));
    attachHoverMarquee(title, title.appendChild(el("span", "add-popup-title-text")), heading, shortHeading);
    return bar;
  }

  // Step 1: the course list. The type was picked from the + menu.
  function buildPickStep() {
    const step = el("div", "add-popup-step");
    step.appendChild(el("p", "add-popup-prompt")).textContent = "Which course?";
    const options = addableCourseOptions();
    if (options.length === 0) {
      step.appendChild(el("p", "add-popup-hint")).textContent =
        "Pick a division for your courses in My Courses first.";
      return step;
    }
    const list = el("div", "add-popup-courses");
    options.forEach((option) => {
      const row = el("button", "add-popup-course");
      row.type = "button";
      row.style.setProperty("--chip-color", colorFor(option));
      row.appendChild(el("span", "add-popup-course-dot"));
      const nameWindow = row.appendChild(el("span", "add-popup-course-name"));
      attachHoverMarquee(row, nameWindow, option.displayName, shortCourseName(option.displayName));
      row.appendChild(el("span", "add-popup-course-chevron", ICON_CHEVRON));
      // A-day periods (1-4) down the first column, B-day (5-8) down the second,
      // each in its period's row, so a course with no period set leaves a gap
      // rather than shifting the others.
      row.style.gridColumn = String(option.periodIndex < 4 ? 1 : 2);
      row.style.gridRow = String((option.periodIndex % 4) + 1);
      row.addEventListener("click", (event) => {
        selectedCourse = option;
        title = "";
        selectedDate = null;
        dueTime = "start";
        if (isAssignment()) {
          showStep(buildDetailsStep(), 1);
          return;
        }
        // An assessment has nothing to fill in but its date, so it skips the
        // second step: the date is picked straight off the calendar and saved.
        // Leaving the pick returns to this list.
        // Kept from the document handler, as with the date button (see
        // buildDetailsStep), and blurred so Escape draws no focus ring.
        event.stopPropagation();
        row.blur();
        startDatePick(
          (iso) => {
            selectedDate = iso;
            submit();
          },
          { cursor: event, activeEl: row }
        );
      });
      list.appendChild(row);
    });
    step.appendChild(list);
    return step;
  }

  // Step 2, for assignments only (assessments go straight to picking a date;
  // see buildPickStep): what's due, when, and the save button.
  function buildDetailsStep() {
    const step = el("div", "add-popup-step add-popup-step--details");
    // The course's color stands in for the accent everywhere on this step.
    step.style.setProperty("--chip-color", colorFor(selectedCourse));
    step.appendChild(
      header({
        withDot: true,
        heading: `${selectedCourse.displayName} ${typeInfo().noun}`,
        shortHeading: shortCourseName(selectedCourse.displayName) && `${shortCourseName(selectedCourse.displayName)} ${typeInfo().noun}`,
        back: () => {
          showStep(buildPickStep(), -1);
        },
      })
    );

    const addBtn = el("button", "add-popup-primary-btn");
    let timeField = null;
    const refresh = () => {
      addBtn.disabled = !canSubmit();
      showSelectedDate();
      if (timeField) timeField.syncToDate();
    };

    const input = el("input", "add-popup-input");
    input.type = "text";
    input.placeholder = "Describe the task";
    input.value = title;
    input.addEventListener("input", () => {
      title = input.value;
      refresh();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && canSubmit()) submit();
    });
    step.appendChild(input);
    step._focusTarget = input;

    const dueRow = step.appendChild(el("div", "add-popup-due-row"));
    dueRow.appendChild(el("span", "add-popup-label")).textContent = "Due Date";
    const nextClass = upcomingClassDays(selectedCourse.periodIndex, 1)[0];
    const now = new Date();
    const dayFromToday = (offset) => toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
    if (!selectedDate) selectedDate = nextClass ? toISODate(nextClass) : dayFromToday(1);

    // Clicking the date picks a new one straight off the big calendar (see
    // startDatePick).
    const dateBtn = dueRow.appendChild(
      el("button", "add-popup-date-btn", `<span class="add-popup-date-btn-text"></span><img class="add-popup-date-icon" src="${uiIconPath("date.png")}" alt="" />`)
    );
    dateBtn.type = "button";
    const dateBtnText = dateBtn.querySelector(".add-popup-date-btn-text");
    // Names the date where it can ("Next class", "Today", "Tomorrow"), else by
    // its weekday, then gives the date and which day of the rotation it is.
    function showSelectedDate() {
      const date = fromISODate(selectedDate);
      const relativeNames = { [dayFromToday(-1)]: "Yesterday", [dayFromToday(0)]: "Today", [dayFromToday(1)]: "Tomorrow" };
      const name =
        nextClass && selectedDate === toISODate(nextClass)
          ? "Next class"
          : relativeNames[selectedDate] || CAL_WEEKDAY_NAMES[date.getDay()];
      const dayType = allDayTypes[selectedDate];
      dateBtnText.innerHTML = "";
      dateBtnText.appendChild(el("span", "add-popup-date-label")).textContent = name;
      dateBtnText.appendChild(el("span", "add-popup-date-sub")).textContent =
        window.formatPreferredDate(date) + (dayType === "A" || dayType === "B" ? ` (${dayType}-day)` : "");
    }
    dateBtn.addEventListener("click", (event) => {
      // Kept from the document handler, which would read the click as outside
      // the popup once the dim layer is over it.
      event.stopPropagation();
      // Otherwise it keeps focus under the dim layer, and pressing Escape to
      // leave counts as keyboard use, which draws its focus ring.
      dateBtn.blur();
      startDatePick(
        (iso) => {
          selectedDate = iso;
          refresh();
        },
        { cursor: event }
      );
    });

    timeField = step.appendChild(buildDueTimeField());

    const footer = el("div", "add-popup-footer");
    addBtn.type = "button";
    addBtn.textContent = "Save";
    addBtn.addEventListener("click", submit);
    footer.append(addBtn);
    step.appendChild(footer);

    refresh();
    return step;
  }

  // The assignment's time on its due day. Its options open inside the popup,
  // which grows to fit them, rather than in a menu floating over it.
  function buildDueTimeField() {
    const field = el("div", "add-popup-time-field");
    const period = selectedCourse.periodIndex + 1;
    // A period only means a time on a day the admin has set as the course's
    // own day: periods 1-4 meet on A days, 5-8 on B days. Any other day has
    // no such period to go by.
    const periodKnown = () => allDayTypes[selectedDate] === (selectedCourse.periodIndex < 4 ? "A" : "B");
    const isWeekday = () => fromISODate(selectedDate).getDay() % 6 !== 0;
    // Each shown only on the dates it applies to.
    const presets = [
      { value: "start", label: "Start of the day", applies: () => true },
      { value: "period", label: `By Period ${period}`, applies: periodKnown },
      { value: "16:00", label: "By 4:00 PM", applies: isWeekday },
    ];
    const describe = () =>
      (presets.find((preset) => preset.value === dueTime) || { label: formatClockTime(dueTime) }).label;

    const row = field.appendChild(el("div", "add-popup-due-row"));
    row.appendChild(el("span", "add-popup-label")).textContent = "Time";
    const timeBtn = row.appendChild(
      el("button", "add-popup-date-btn", `<span class="add-popup-date-btn-text"></span>${ICON_CHEVRON_DOWN}`)
    );
    timeBtn.type = "button";
    const timeText = timeBtn.querySelector(".add-popup-date-btn-text");

    const options = field.appendChild(el("div", "add-popup-time-options"));
    options.hidden = true;
    const setOpen = (open) => {
      if (options.hidden === !open) return;
      // Closed with Custom chosen but no time typed: the highlight goes back
      // to whichever time is actually set.
      if (!open) sync();
      resizeAround(() => {
        options.hidden = !open;
        timeBtn.classList.toggle("add-popup-date-btn--open", open);
      });
    };
    timeBtn.addEventListener("click", () => setOpen(options.hidden));

    const presetBtns = presets.map((preset) => {
      const option = options.appendChild(el("button", "add-popup-time-option"));
      option.type = "button";
      option.textContent = preset.label;
      option.addEventListener("click", () => {
        dueTime = preset.value;
        sync();
        setOpen(false);
      });
      return option;
    });

    // Custom takes a typed time; Enter closes the list once one is in.
    const custom = options.appendChild(el("label", "add-popup-time-option add-popup-time-option--custom"));
    custom.appendChild(el("span")).textContent = "Custom";
    const customInput = custom.appendChild(el("input", "add-popup-time-input"));
    customInput.type = "time";
    // Highlighted the moment it's clicked (or tabbed to), before any time is
    // typed in, with the time field ready to type into.
    const chooseCustom = () => {
      presetBtns.forEach((option) => option.classList.remove("add-popup-time-option--selected"));
      custom.classList.add("add-popup-time-option--selected");
    };
    custom.addEventListener("focusin", chooseCustom);
    custom.addEventListener("click", () => {
      chooseCustom();
      customInput.focus();
    });
    customInput.addEventListener("input", () => {
      if (!customInput.value) return;
      dueTime = customInput.value;
      sync();
    });
    // Done typing: Enter, or AM/PM (the last part of the time) once the rest
    // is in. The field lets go of focus, so it stops showing the part being
    // typed into.
    customInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && customInput.value) {
        customInput.blur();
        setOpen(false);
      } else if (/^[ap]$/i.test(event.key) && customInput.value) {
        setTimeout(() => customInput.blur(), 0);
      }
    });

    function sync() {
      presetBtns.forEach((option, index) => (option.hidden = !presets[index].applies()));
      timeText.innerHTML = "";
      timeText.appendChild(el("span", "add-popup-date-label")).textContent = describe();
      const isPreset = presets.some((preset) => preset.value === dueTime);
      presetBtns.forEach((option, index) =>
        option.classList.toggle("add-popup-time-option--selected", presets[index].value === dueTime)
      );
      custom.classList.toggle("add-popup-time-option--selected", !isPreset);
      if (!isPreset) customInput.value = dueTime;
    }
    // A new date can take options away; one that was chosen falls back to the
    // start of the day.
    field.syncToDate = () => {
      const chosen = presets.find((preset) => preset.value === dueTime);
      if (chosen && !chosen.applies()) dueTime = "start";
      sync();
    };
    field.syncToDate();
    return field;
  }

  // Animates the popup's height across a change that resizes its content.
  function resizeAround(change) {
    const from = popup.offsetHeight;
    change();
    const to = popup.offsetHeight;
    if (from !== to) {
      popup.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ADD_POPUP_STEP_MS, easing: "ease" });
    }
  }

  // Swaps in the other step: the old one slides out one way as the new one
  // slides in from the other (direction 1 = forward, -1 = back), while the
  // popup's height eases between the two.
  function showStep(next, direction) {
    const current = popup.querySelector(".add-popup-step:not(.add-popup-step--leaving)");
    if (!current) {
      popup.appendChild(next);
      return;
    }
    resizeAround(() => {
      current.classList.add("add-popup-step--leaving");
      popup.appendChild(next);
    });
    const shift = 24 * direction;
    current
      .animate(
        [
          { opacity: 1, transform: "translateX(0)" },
          { opacity: 0, transform: `translateX(${-shift}px)` },
        ],
        { duration: ADD_POPUP_STEP_MS * 0.7, easing: "ease", fill: "forwards" }
      )
      .finished.catch(() => {})
      .finally(() => current.remove());
    next.animate(
      [
        { opacity: 0, transform: `translateX(${shift}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: ADD_POPUP_STEP_MS, easing: "ease" }
    );
    if (next._focusTarget) next._focusTarget.focus({ preventScroll: true });
  }

  function openPopup(type) {
    if (addableCourseOptions().length === 0 && loadPeriods().every((name) => !(name || "").trim())) {
      showToast("Add a course to My Courses first.");
      return;
    }
    selectedType = type;
    selectedCourse = null;
    selectedDate = null;
    title = "";
    dueTime = "start";

    popup = el("div", "add-popup");
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Add to calendar");
    document.body.appendChild(popup);
    const rect = triggerBtn.getBoundingClientRect();
    const top = rect.bottom + 8;
    popup.style.top = `${top}px`;
    popup.style.right = `${Math.max(16, window.innerWidth - rect.right)}px`;
    popup.style.maxHeight = `${window.innerHeight - top - 16}px`;

    const first = buildPickStep();
    showStep(first, 1);
    void popup.offsetWidth; // force reflow so the entrance transition below actually plays
    popup.classList.add("add-popup--visible");
  }

  // "Pick another date": everything but the big calendar dims, its pills fade
  // back, and the day clicked there becomes the date. Clicking the dimmed
  // area or pressing Escape leaves without picking.
  let datePick = null; // { overlay, box, onClick } while picking

  // cursor: where the pointer is, to start the "Select date" tooltip there.
  // activeEl: a course button that started this, kept looking hovered while
  // picking.
  function startDatePick(onPick, { cursor, activeEl } = {}) {
    const box = document.querySelector(".my-courses-calendar-box");
    if (!box || datePick) return;
    const overlay = el("div", "calendar-pick-overlay");
    document.body.appendChild(overlay);
    box.style.setProperty("--chip-color", colorFor(selectedCourse));
    box.classList.add("my-courses-calendar-box--raised", "my-courses-calendar-box--picking");

    // Capture phase, ahead of the pills' own handlers; stopped there so the
    // document handler doesn't count it as a click outside the popup.
    const onClick = (event) => {
      const cell = event.target.closest(".assessment-week-day");
      if (!cell) return;
      event.stopPropagation();
      endDatePick();
      onPick(cell.dataset.iso);
    };
    box.addEventListener("click", onClick, true);
    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      endDatePick();
    });
    document.documentElement.dataset.suppressTooltips = "true";
    hideHoverTooltip();
    if (activeEl) activeEl.classList.add("add-popup-course--active");
    const removeTooltip = cursor ? showCursorTooltip("Select date", cursor.clientX, cursor.clientY) : null;
    datePick = { overlay, box, onClick, activeEl, removeTooltip };
    void overlay.offsetWidth; // force reflow so the fade below actually plays
    overlay.classList.add("calendar-pick-overlay--visible");
  }

  function endDatePick() {
    if (!datePick) return;
    const { overlay, box, onClick, activeEl, removeTooltip } = datePick;
    datePick = null;
    if (activeEl) activeEl.classList.remove("add-popup-course--active");
    if (removeTooltip) removeTooltip();
    delete document.documentElement.dataset.suppressTooltips;
    box.removeEventListener("click", onClick, true);
    box.classList.remove("my-courses-calendar-box--picking");
    overlay.classList.remove("calendar-pick-overlay--visible");
    // Stays above the dim layer until it has faded, or it would dim with it.
    setTimeout(() => {
      overlay.remove();
      if (!datePick) box.classList.remove("my-courses-calendar-box--raised");
    }, CALENDAR_PICK_FADE_MS);
  }

  function closePopup() {
    endDatePick();
    if (!popup) return;
    const closing = popup;
    popup = null;
    closing.classList.remove("add-popup--visible");
    setTimeout(() => closing.remove(), 150);
  }

  function submit() {
    if (!canSubmit()) {
      if (isDuplicateSelection()) showToast("This is already on your calendar.");
      return;
    }
    const entry = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      date: selectedDate,
      courseName: selectedCourse.courseName,
      type: selectedType,
      createdAt: Date.now(),
    };
    if (isAssignment()) {
      // Left blank, it's just homework.
      entry.title = title.trim() || "Homework";
      entry.dueTime = dueTime;
    }

    saveAddedAssessments([...loadAddedAssessments(), entry]);
    // Assignments are personal. An assessment already scheduled server-side
    // under this same key, just for a section this student's A/B pattern
    // doesn't show it for (see isDuplicateSelection), has nothing new for the
    // admin to add either.
    if (!isAssignment() && !matchingSchoolWideEntry()) {
      logSuggestedAssessment(entry.date, entry.courseName, entry.type);
    }

    closePopup();
    if (refreshAssessmentCalendar) refreshAssessmentCalendar(true, true);
  }

  // The + first opens a short menu of what to add; picking one opens the
  // popup on that type. Same order as before the popup had its own tabs.
  const MENU_TYPES = ["Assignment", "Summative", "Formative", "Reassessment"];
  let menu = null;

  function closeMenu() {
    if (!menu) return;
    const closing = menu;
    menu = null;
    closing.classList.remove("popup-menu--visible");
    setTimeout(() => closing.remove(), 150);
  }

  function openMenu() {
    menu = el("div", "popup-menu");
    MENU_TYPES.forEach((type) => {
      const item = el("button", "popup-menu-item");
      item.type = "button";
      item.textContent = type;
      item.addEventListener("click", (event) => {
        // Kept from the document handler below, which would otherwise see a
        // click outside the popup it's about to open and close it again.
        event.stopPropagation();
        closeMenu();
        openPopup(type);
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const rect = triggerBtn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    void menu.offsetWidth; // force reflow so the entrance transition below actually plays
    menu.classList.add("popup-menu--visible");
  }

  // The click is left to reach the document, so an open account menu closes;
  // the handler below skips clicks on this button or inside the menu or popup.
  // The popup rebuilds parts of itself on click, so "inside" is judged by the
  // event's path, fixed when the click happened.
  triggerBtn.addEventListener("click", () => {
    if (menu) closeMenu();
    else if (popup) closePopup();
    else openMenu();
  });
  document.addEventListener("click", (event) => {
    const path = event.composedPath();
    if (path.includes(triggerBtn)) return;
    if (menu && !path.includes(menu)) closeMenu();
    if (popup && !path.includes(popup)) closePopup();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (menu) closeMenu();
    else if (datePick) endDatePick();
    else if (popup) closePopup();
  });
}

// Calendar page: sets up the read-only assessment calendar and its "Add to
// calendar" popup. A no-op on any other page (both check for
// their own page-specific markup and bail if it's missing). The period
// inputs themselves no longer live on this page at all — see
// openMyCoursesModal below, opened from the account-menu dropdown (see
// auth.js) on any page.
let myCoursesRefreshCalendar = null;

function initMyCoursesPage() {
  myCoursesRefreshCalendar = initAssessmentCalendar();
  initAddToCalendarPopup(myCoursesRefreshCalendar);
}

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
      if (myCoursesRefreshCalendar) myCoursesRefreshCalendar(true, true);
      refreshDomainClasses();
    });
    picker.appendChild(btn);
  });
}

// Only defined on a page that also loads domain.js — a no-op everywhere
// else (Calendar, GPA). animate=true fades the change in/out the same way
// the manual hide button on Domain does (see fadeInCard/fadeOutAndRemoveCard
// there), since unlike the page's own first render, this is a live edit
// happening while Domain might already be on screen.
function refreshDomainClasses() {
  if (typeof renderDomainClasses === "function") renderDomainClasses(true);
}

// .schedule-field grows to fill whatever room .show-course-btn frees up
// when it disappears (see syncShowCourseButton) — flex: 1 does that
// instantly on its own, but a brief transition reads better than a snap.
// Classic FLIP: measure the width before removing the button, lock it in
// place with an explicit flex-basis, then transition to the new natural
// width once the button's actually gone.
function animateFieldGrowth(field, hideBtn) {
  const startWidth = field.getBoundingClientRect().width;
  hideBtn();
  const endWidth = field.getBoundingClientRect().width;

  // getBoundingClientRect measures the border box (content + padding), but
  // flex-basis sizes .schedule-field's own content box by default (its
  // padding: 6px 10px isn't included) — locking flex-basis to those
  // measured widths without this would render ~20px too wide the entire
  // time (its own left+right padding), overshooting past the real end
  // width until the lock is released, worse the less room .show-course-btn
  // itself was actually taking (e.g. a row with a division picker too).
  field.style.boxSizing = "border-box";
  field.style.transition = "none";
  field.style.flex = `0 0 ${startWidth}px`;
  void field.offsetWidth; // force reflow so the starting width above takes effect first
  field.style.transition = "flex-basis 250ms ease";
  field.style.flex = `0 0 ${endWidth}px`;

  field.addEventListener(
    "transitionend",
    () => {
      // Back to the CSS class's own flex: 1 and content-box sizing — this
      // was only ever a temporary lock for the animation, not a permanent
      // fixed width.
      field.style.transition = "";
      field.style.flex = "";
      field.style.boxSizing = "";
    },
    { once: true }
  );
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
    animateFieldGrowth(row.querySelector(".schedule-field"), () => {
      btn.hidden = true;
    });
    showToast(`View ${name} in the Domain Tab`);
    refreshDomainClasses();
  };
}

// Wires every .schedule-input inside a freshly-built My Courses popup —
// loads its saved value, sets up the catalog dropdown/division
// picker/show-course button, and persists on input/change/blur/clear.
// Split out from openMyCoursesModal below since the popup's markup is
// rebuilt from scratch on every open (see buildScheduleRowHTML).
function wireScheduleRows(overlay) {
  const periods = loadPeriods();
  const firstPeriodInput = overlay.querySelector('.schedule-input[data-period="0"]');

  // Only Period 1 ever gets the placeholder, and only while every period is
  // still empty — once any course is entered anywhere, it goes away.
  const updateFirstPeriodPlaceholder = () => {
    if (!firstPeriodInput) return;
    const allEmpty = loadPeriods().every((name) => !name || name.trim() === "");
    firstPeriodInput.placeholder = allEmpty ? "Start typing here" : "";
    return allEmpty;
  };
  const showingPlaceholder = updateFirstPeriodPlaceholder();

  // The placeholder above only means anything if it's actually focused —
  // auto-select it (nothing to select yet, but this also focuses the
  // field) so the popup opens ready to type into immediately.
  if (showingPlaceholder && firstPeriodInput) {
    firstPeriodInput.focus();
    firstPeriodInput.select();
  }

  overlay.querySelectorAll(".schedule-input").forEach((input) => {
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
      // Only on a finished edit (Enter, picking from the list, or leaving the
      // field), not every keystroke: the calendar's pills and Course Colors
      // would otherwise follow each half-typed name ("kore"), and a Domain
      // card would fade out and in on every letter. null on any page without
      // the calendar (e.g. Domain, GPA).
      if (!commit) return;
      if (myCoursesRefreshCalendar) myCoursesRefreshCalendar(true, true);
      refreshDomainClasses();
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

// --- My Courses popup ---
// Opened from the account-menu dropdown (see auth.js), on whichever page
// the user happens to be on — Calendar, Domain, or GPA (the only pages
// that load this file). Built fresh each time, same as Settings/Login Keys
// (see settings-modal.js), rather than toggled on static markup, since
// there's no longer a page that's guaranteed to already have these rows
// sitting in its DOM.

let myCoursesModalOverlay = null;

function buildScheduleRowHTML(index) {
  return `
    <div class="schedule-row">
      <span class="schedule-label">Period ${index + 1}</span>
      <div class="schedule-field">
        <input class="schedule-input" type="text" autocomplete="off" data-period="${index}" />
        <button class="schedule-clear-btn" type="button" aria-label="Clear"><span class="close-icon" aria-hidden="true"></span></button>
        <ul class="schedule-dropdown"></ul>
      </div>
      <div class="division-picker" hidden></div>
      <button class="show-course-btn" type="button" data-period="${index}" aria-label="Show hidden course" hidden>
        <img class="show-course-icon" alt="" />
      </button>
    </div>
  `;
}

function openMyCoursesModal() {
  // One popup at a time — mirrors closeMyCoursesModal's own guarded call
  // from settings-modal.js.
  if (typeof closeSettingsModal === "function") closeSettingsModal();
  closeMyCoursesModal();

  // A-day (Periods 1-4) / B-day (Periods 5-8) split — same divider as the
  // Settings popup's own rows (see .settings-divider).
  const rowsHTML = Array.from({ length: 8 }, (_, index) => {
    const divider = index === 4 ? `<div class="settings-divider"></div>` : "";
    return divider + buildScheduleRowHTML(index);
  }).join("");
  const overlay = document.createElement("div");
  overlay.className = "settings-modal-overlay";
  overlay.innerHTML = `
    <div class="settings-card my-courses-modal-card settings-modal-card">
      <button type="button" class="settings-modal-close-btn" aria-label="Close"><span class="close-icon" aria-hidden="true"></span></button>
      <h2 class="settings-title">My Courses</h2>
      ${rowsHTML}
    </div>
  `;
  document.body.appendChild(overlay);
  myCoursesModalOverlay = overlay;

  wireScheduleRows(overlay);

  overlay.querySelector(".settings-modal-close-btn").addEventListener("click", closeMyCoursesModal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeMyCoursesModal();
  });

  const card = overlay.querySelector(".settings-modal-card");
  void card.offsetWidth; // force reflow so the entrance transition below actually plays
  card.classList.add("settings-modal-card--visible");
  overlay.classList.add("settings-modal-overlay--visible");
}

function closeMyCoursesModal() {
  if (!myCoursesModalOverlay) return;
  const closingOverlay = myCoursesModalOverlay;
  const card = closingOverlay.querySelector(".settings-modal-card");
  myCoursesModalOverlay = null;
  // Course-suggestion lists live on <body> while the popup is open (see
  // setupCourseDropdown).
  document.querySelectorAll("body > .schedule-dropdown--floating").forEach((el) => el.remove());
  // Reverses the entrance transition above.
  card.classList.remove("settings-modal-card--visible");
  closingOverlay.classList.remove("settings-modal-overlay--visible");
  setTimeout(() => closingOverlay.remove(), 250);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && myCoursesModalOverlay) closeMyCoursesModal();
});
