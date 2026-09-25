// Assessments admin page: a month-grid calendar for scheduling In-Class/
// Testing Block/Other assessments per course, stored in the school-wide
// `assessments` Firestore collection. Read is public; write is restricted
// server-side in firestore.rules to the emails in ADMIN_EMAILS — the
// page-level gating below is only cosmetic.
//
// Doesn't load shared.js/boot.js, so it duplicates the small ISO-date
// helpers rather than depending on assessments-shared.js.

const ADMIN_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ADMIN_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function adminToISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function adminFromISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

let adminAllAssessments = [];
let adminDayTypes = {}; // ISO date -> "A" | "B", absent = unset ("?")
// The regular schedule (periodTimes/default) — [{start,end}] x5, or null
// until an admin has actually set one up (or fetchAdminPeriodTimes just
// hasn't resolved yet — see adminPeriodTimesFetched, which tells the two
// apart).
let adminDefaultScheduleTimes = null;
let adminPeriodTimesFetched = false;
// Fixed 5-block shape every day follows (4 periods + lunch) — kept in sync
// with SCHEDULE_BLOCKS in assessments-shared.js, which this page doesn't
// load.
const ADMIN_SCHEDULE_BLOCK_LABELS = ["Period 1/4", "Period 2/5", "Lunch", "Period 3/7", "Period 4/8"];

// KISJ's actual regular bell schedule, index-aligned with
// ADMIN_SCHEDULE_BLOCK_LABELS — seeded into periodTimes/default the first
// time an admin actually marks a day A or B (see setDayType), so there's
// something sensible in there without a separate trip through the Bell
// Schedule popup first.
const DEFAULT_SCHEDULE_TIMES = [
  { start: "08:50", end: "10:13" },
  { start: "10:18", end: "11:41" },
  { start: "11:41", end: "12:30" },
  { start: "12:30", end: "13:53" },
  { start: "13:58", end: "15:21" },
];
let adminDisplayedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let adminSelectedDate = null; // ISO string, or null before any day is clicked
let adminSelectedType = "In-Class"; // "In-Class" | "Testing Block" | "Formative" | "Other"
let adminOtherTypeText = ""; // only used when adminSelectedType === "Other"
let adminSelectedDivision = ""; // "" = none picked / not applicable to the current course
let adminInitialized = false;
let adminToastEl = null;
let adminToastHideTimer = null;
const ADMIN_TOAST_VISIBLE_MS = 4000;

// Same bottom-center toast as shared.js's showSignInToast — reimplemented
// here since this page doesn't load shared.js.
function showAdminToast(message) {
  if (!adminToastEl) {
    adminToastEl = document.createElement("div");
    adminToastEl.className = "signin-toast";
    document.body.appendChild(adminToastEl);
    void adminToastEl.offsetWidth; // force reflow so the entrance below actually transitions
  }

  adminToastEl.textContent = message;
  adminToastEl.classList.add("signin-toast--visible");
  clearTimeout(adminToastHideTimer);
  adminToastHideTimer = setTimeout(() => {
    adminToastEl.classList.remove("signin-toast--visible");
  }, ADMIN_TOAST_VISIBLE_MS);
}

function fetchAdminAssessments(callback) {
  firebase
    .firestore()
    .collection("assessments")
    .get()
    .then((snapshot) => {
      adminAllAssessments = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (callback) callback();
    })
    .catch((error) => console.error("Failed to load assessments:", error));
}

function fetchAdminDayTypes(callback) {
  firebase
    .firestore()
    .collection("dayTypes")
    .get()
    .then((snapshot) => {
      adminDayTypes = {};
      snapshot.docs.forEach((doc) => {
        adminDayTypes[doc.id] = doc.data().type;
      });
      if (callback) callback();
    })
    .catch((error) => console.error("Failed to load day types:", error));
}

function fetchAdminPeriodTimes(callback) {
  firebase
    .firestore()
    .collection("periodTimes")
    .doc("default")
    .get()
    .then((doc) => {
      const data = doc.exists ? doc.data() : null;
      adminDefaultScheduleTimes = data && Array.isArray(data.times) ? data.times : null;
      adminPeriodTimesFetched = true;
      if (callback) callback();
    })
    .catch((error) => console.error("Failed to load period times:", error));
}

// The first real A/B marked while there's genuinely no schedule yet (not
// just fetchAdminPeriodTimes still in flight — adminPeriodTimesFetched is
// what tells those two apart) seeds periodTimes/default with KISJ's actual
// regular schedule, so there's something sensible in there right away.
// Never overwrites one that's already set, custom or otherwise.
function seedDefaultScheduleTimesIfMissing() {
  if (!adminPeriodTimesFetched || adminDefaultScheduleTimes) return;
  adminDefaultScheduleTimes = DEFAULT_SCHEDULE_TIMES;
  firebase
    .firestore()
    .collection("periodTimes")
    .doc("default")
    .set({ times: DEFAULT_SCHEDULE_TIMES })
    .catch((error) => {
      console.error("Failed to seed the default bell schedule:", error);
      adminDefaultScheduleTimes = null;
    });
}

// value is "A", "B", or null to clear back to unset ("?").
function setDayType(iso, value) {
  const previous = adminDayTypes[iso] || null;
  if (value) adminDayTypes[iso] = value;
  else delete adminDayTypes[iso];
  renderAdminCalendar();

  const doc = firebase.firestore().collection("dayTypes").doc(iso);
  (value ? doc.set({ type: value }) : doc.delete()).catch((error) => {
    console.error("Failed to save day type:", error);
    alert("Something went wrong saving that day type. Please try again.");
    if (previous) adminDayTypes[iso] = previous;
    else delete adminDayTypes[iso];
    renderAdminCalendar();
  });

  if (value) seedDefaultScheduleTimesIfMissing();
}

// Builds ADMIN_SCHEDULE_BLOCK_LABELS.length rows of start/end
// <input type="time"> pairs into container, pre-filled from times (or
// blank if null/missing) — shared by the default-schedule card and each
// day's own override section.
function renderScheduleRows(container, times) {
  container.innerHTML = "";
  ADMIN_SCHEDULE_BLOCK_LABELS.forEach((label, index) => {
    const row = document.createElement("div");
    row.className = "admin-schedule-row";

    const labelEl = document.createElement("span");
    labelEl.className = "admin-schedule-row-label";
    labelEl.textContent = label;

    const startInput = document.createElement("input");
    startInput.type = "time";
    startInput.className = "admin-schedule-time-input";
    startInput.value = (times && times[index] && times[index].start) || "";

    const sep = document.createElement("span");
    sep.className = "admin-schedule-row-sep";
    sep.textContent = "–";

    const endInput = document.createElement("input");
    endInput.type = "time";
    endInput.className = "admin-schedule-time-input";
    endInput.value = (times && times[index] && times[index].end) || "";

    row.append(labelEl, startInput, sep, endInput);
    container.appendChild(row);
  });
}

// The inverse of renderScheduleRows — reads the current input values back
// out in the same [{start,end}] x5 shape.
function readScheduleRows(container) {
  const inputs = container.querySelectorAll(".admin-schedule-time-input");
  const times = [];
  for (let i = 0; i < inputs.length; i += 2) {
    times.push({ start: inputs[i].value, end: inputs[i + 1].value });
  }
  return times;
}

function scheduleRowsComplete(times) {
  return times.every((block) => block.start && block.end);
}

// The Bell Schedule popup — opened via the clock icon next to the A/B/?
// toggle, not tied to whichever day happens to be selected. Rebuilt fresh
// on each open, same pattern as the other popups in this app (Add
// Missing Assessment, "Learn More", the confirm dialog): entrance/exit
// both animate via --visible, toggled off with a delayed removal so the
// reverse transition (see closeScheduleModal) actually gets to play.
let scheduleModalOverlay = null;

function buildScheduleModal() {
  const overlay = document.createElement("div");
  overlay.className = "admin-schedule-overlay";
  overlay.innerHTML = `
    <div class="admin-schedule-dialog">
      <button type="button" class="admin-schedule-close-btn" aria-label="Close">×</button>
      <h2 class="admin-schedule-title">Bell Schedule</h2>
      <div class="admin-schedule-rows"></div>
      <button type="button" class="admin-schedule-save-btn">Save Schedule</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const rows = overlay.querySelector(".admin-schedule-rows");
  const saveBtn = overlay.querySelector(".admin-schedule-save-btn");
  renderScheduleRows(rows, adminDefaultScheduleTimes);

  overlay.querySelector(".admin-schedule-close-btn").addEventListener("click", closeScheduleModal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeScheduleModal();
  });

  saveBtn.addEventListener("click", () => {
    const times = readScheduleRows(rows);
    if (!scheduleRowsComplete(times)) {
      showAdminToast("Fill in every start and end time first.");
      return;
    }
    saveBtn.disabled = true;
    firebase
      .firestore()
      .collection("periodTimes")
      .doc("default")
      .set({ times })
      .then(() => {
        adminDefaultScheduleTimes = times;
        showAdminToast("Schedule saved.");
        closeScheduleModal();
      })
      .catch((error) => {
        console.error("Failed to save schedule:", error);
        showAdminToast("Something went wrong saving the schedule. Please try again.");
        saveBtn.disabled = false;
      });
  });

  return overlay;
}

function openScheduleModal() {
  scheduleModalOverlay = buildScheduleModal();
  const dialog = scheduleModalOverlay.querySelector(".admin-schedule-dialog");
  const animate = window.animationsEnabled();
  if (!animate) {
    dialog.classList.add("admin-schedule-dialog--instant");
    scheduleModalOverlay.classList.add("admin-schedule-overlay--instant");
  }
  void dialog.offsetWidth; // force reflow so the entrance transition below actually plays
  dialog.classList.add("admin-schedule-dialog--visible");
  scheduleModalOverlay.classList.add("admin-schedule-overlay--visible");
  if (!animate) {
    void dialog.offsetWidth; // commit the instant state before re-enabling the transition
    dialog.classList.remove("admin-schedule-dialog--instant");
    scheduleModalOverlay.classList.remove("admin-schedule-overlay--instant");
  }
}

function closeScheduleModal() {
  if (!scheduleModalOverlay) return;
  const closingOverlay = scheduleModalOverlay;
  const dialog = closingOverlay.querySelector(".admin-schedule-dialog");
  scheduleModalOverlay = null;
  if (!window.animationsEnabled()) {
    closingOverlay.remove();
    return;
  }
  // Reverses the entrance transition above.
  dialog.classList.remove("admin-schedule-dialog--visible");
  closingOverlay.classList.remove("admin-schedule-overlay--visible");
  setTimeout(() => closingOverlay.remove(), 250);
}

function initScheduleModal() {
  const openBtn = document.getElementById("admin-schedule-open-btn");
  if (!openBtn) return;
  openBtn.addEventListener("click", openScheduleModal);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && scheduleModalOverlay) closeScheduleModal();
  });
}

// Read-only A/B/? label for one day cell's top-right corner — the actual
// picker lives in the day panel instead (see setupDayTypeToggle below).
function buildDayTypeLabel(iso) {
  const label = document.createElement("span");
  label.className = "assessment-calendar-day-type";
  label.textContent = adminDayTypes[iso] || "";
  return label;
}

let dayTypeToggleContainer = null;
let dayTypeToggleThumb = null;

// The day panel's own A/B/? picker, next to its title — sets the currently
// selected day's type. Same sliding-thumb pattern as setupTypeToggle below,
// except which option counts as "active" changes with adminSelectedDate
// instead of a fixed local variable, so positioning is refreshed by
// syncDayTypeToggle (called from renderDayPanel) rather than only on click.
function setupDayTypeToggle() {
  dayTypeToggleContainer = document.getElementById("admin-day-type-toggle");
  if (!dayTypeToggleContainer) return;

  dayTypeToggleThumb = document.createElement("span");
  dayTypeToggleThumb.className = "segmented-thumb";
  dayTypeToggleContainer.insertBefore(dayTypeToggleThumb, dayTypeToggleContainer.firstChild);

  dayTypeToggleContainer.querySelectorAll(".segmented-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!adminSelectedDate || btn.classList.contains("segmented-option--active")) return;
      setDayType(adminSelectedDate, btn.dataset.value === "?" ? null : btn.dataset.value);
    });
  });
}

function syncDayTypeToggle() {
  if (!dayTypeToggleContainer) return;
  dayTypeToggleContainer.hidden = !adminSelectedDate;
  if (!adminSelectedDate) return;

  const activeType = adminDayTypes[adminSelectedDate] || "?";
  let activeOption = null;
  dayTypeToggleContainer.querySelectorAll(".segmented-option").forEach((btn) => {
    const isActive = btn.dataset.value === activeType;
    btn.classList.toggle("segmented-option--active", isActive);
    if (isActive) activeOption = btn;
  });
  if (!activeOption) return;

  dayTypeToggleThumb.style.transition = "none";
  dayTypeToggleThumb.style.left = `${activeOption.offsetLeft}px`;
  dayTypeToggleThumb.style.width = `${activeOption.offsetWidth}px`;
  void dayTypeToggleThumb.offsetWidth; // force reflow so the "none" transition above takes effect first
  dayTypeToggleThumb.style.transition = "";
}

function deleteAssessment(id) {
  const index = adminAllAssessments.findIndex((entry) => entry.id === id);
  const removed = index === -1 ? null : adminAllAssessments[index];

  // Optimistic — remove locally and re-render before the Firestore round
  // trip completes.
  if (removed) {
    adminAllAssessments.splice(index, 1);
    renderAdminCalendar();
  }

  firebase
    .firestore()
    .collection("assessments")
    .doc(id)
    .delete()
    .catch((error) => {
      console.error("Failed to delete assessment:", error);
      alert("Something went wrong deleting that assessment. Please try again.");
      // Put it back — the delete didn't actually happen.
      if (removed) {
        adminAllAssessments.splice(index, 0, removed);
        renderAdminCalendar();
      }
    });
}

function addAssessment(courseName, type) {
  if (!adminSelectedDate) return;
  firebase
    .firestore()
    .collection("assessments")
    .add({ type, date: adminSelectedDate, courseName, createdAt: Date.now() })
    .then(() => fetchAdminAssessments(renderAdminCalendar))
    .catch((error) => {
      console.error("Failed to add assessment:", error);
      alert("Something went wrong adding that assessment. Please try again.");
    });
}

// Type-to-search dropdown for the add-form's course-name field, sourced
// from COURSE_CATALOG. onCourseChange fires whenever the typed/picked
// text changes, so the caller can keep the division picker in sync.
function setupAdminCourseDropdown(input, onCourseChange) {
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
    if (onCourseChange) onCourseChange();
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

  input.addEventListener("input", () => {
    renderMatches();
    if (onCourseChange) onCourseChange();
  });
  input.addEventListener("focus", renderMatches);
  input.addEventListener("blur", () => {
    setTimeout(() => {
      dropdown.innerHTML = "";
    }, 100);
  });

  input.addEventListener("keydown", (event) => {
    // Checked before the dropdown-items early return so Escape always
    // deselects the field even with no matches showing.
    if (event.key === "Escape") {
      event.preventDefault();
      input.blur();
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
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectItem(all[highlightedIndex >= 0 ? highlightedIndex : 0]);
    }
  });
}

// Division circles for the add-form's course field — shown only once the
// typed/picked text exactly matches a divided course. A course change
// invalidates whatever division was already picked.
function syncAdminDivisionPicker(input) {
  const field = document.getElementById("admin-division-field");
  const picker = document.getElementById("admin-division-picker");
  const course = findCourseCatalogEntry(input.value.trim());
  const divisions = course && course.divisions;

  if (!divisions || divisions.length === 0) {
    field.hidden = true;
    picker.innerHTML = "";
    adminSelectedDivision = "";
    return;
  }

  if (!divisions.includes(adminSelectedDivision)) {
    adminSelectedDivision = "";
  }

  field.hidden = false;
  picker.innerHTML = "";
  divisions.forEach((division) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "division-option";
    btn.textContent = division;
    btn.classList.toggle("division-option--selected", division === adminSelectedDivision);
    // mousedown + preventDefault, not click — clicking would otherwise
    // blur the course input first, which could rebuild this picker out
    // from under the click before it fires.
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    btn.addEventListener("click", () => {
      adminSelectedDivision = division;
      picker.querySelectorAll(".division-option").forEach((b) => b.classList.remove("division-option--selected"));
      btn.classList.add("division-option--selected");
    });
    picker.appendChild(btn);
  });
}

// In-Class/Testing Block/Formative/Other picker for the add-form — same
// sliding-pill pattern as Settings' segmented controls, tracking a local
// variable instead of a saved preference.
function setupTypeToggle() {
  const container = document.getElementById("admin-type-toggle");
  const options = container.querySelectorAll(".segmented-option");
  const otherInput = document.getElementById("admin-type-other-input");

  const thumb = document.createElement("span");
  thumb.className = "segmented-thumb";
  container.insertBefore(thumb, container.firstChild);

  // animate=false (the initial call below) jumps straight there — the
  // thumb shouldn't slide in from the left edge on first paint.
  const positionThumb = (option, animate) => {
    if (!animate) thumb.style.transition = "none";
    thumb.style.left = `${option.offsetLeft}px`;
    thumb.style.width = `${option.offsetWidth}px`;
    if (!animate) {
      void thumb.offsetWidth; // force reflow so the "none" transition above takes effect first
      thumb.style.transition = "";
    }
  };

  options.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("segmented-option--active")) return;
      adminSelectedType = btn.dataset.value;
      options.forEach((other) => other.classList.toggle("segmented-option--active", other === btn));
      positionThumb(btn, window.animationsEnabled());

      otherInput.hidden = adminSelectedType !== "Other";
      if (adminSelectedType === "Other") otherInput.focus();
    });
  });

  otherInput.addEventListener("input", () => {
    adminOtherTypeText = otherInput.value;
  });

  positionThumb(container.querySelector(".segmented-option--active"), false);

  // Re-sync once Inter itself has loaded — the initial position above is
  // measured against the fallback font (font-display: swap), whose
  // character widths don't match Inter's.
  if (document.fonts) {
    document.fonts.ready.then(() => {
      positionThumb(container.querySelector(".segmented-option--active"), false);
    });
  }
}

// Display order for the day panel's entry list — anything not listed here
// (a custom "Other" label) sorts after all three of these.
const ADMIN_TYPE_SORT_ORDER = ["Testing Block", "In-Class", "Formative"];

function adminTypeSortRank(type) {
  const index = ADMIN_TYPE_SORT_ORDER.indexOf(type);
  return index === -1 ? ADMIN_TYPE_SORT_ORDER.length : index;
}

function renderDayPanel(entriesForDay) {
  const title = document.getElementById("admin-day-title");
  const list = document.getElementById("admin-day-entries");
  const form = document.getElementById("admin-add-form");

  syncDayTypeToggle();

  if (!adminSelectedDate) {
    title.textContent = "Select a day";
    list.innerHTML = "";
    form.hidden = true;
    return;
  }

  const date = adminFromISODate(adminSelectedDate);
  title.textContent = `${ADMIN_MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  form.hidden = false;

  list.innerHTML = "";
  if (entriesForDay.length === 0) {
    const empty = document.createElement("li");
    empty.className = "admin-day-entry-empty";
    empty.textContent = "Nothing scheduled yet.";
    list.appendChild(empty);
    return;
  }

  // Testing Block always leads, then In-Class, then Formative, then any
  // other (custom "Other") label — alphabetical by course name within
  // each of those groups.
  const sortedEntries = entriesForDay.slice().sort((a, b) => {
    const rankDiff = adminTypeSortRank(a.type) - adminTypeSortRank(b.type);
    return rankDiff !== 0 ? rankDiff : a.courseName.localeCompare(b.courseName);
  });

  sortedEntries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "admin-day-entry";

    const name = document.createElement("span");
    name.className = "admin-day-entry-name";
    name.textContent = entry.courseName;

    const type = document.createElement("span");
    // Colored the same way My Courses' own pills are — In-Class and
    // Testing Block share the summative color; Formative and a custom
    // "Other" label both reuse the formative color.
    const isKnownType = entry.type === "In-Class" || entry.type === "Testing Block";
    const pillStyle = isKnownType ? "summative" : "formative";
    type.className = `assessment-calendar-entry-type assessment-pill--${pillStyle}`;
    type.textContent = entry.type;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "admin-day-entry-delete";
    deleteBtn.setAttribute("aria-label", "Delete assessment");
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", () => deleteAssessment(entry.id));

    li.append(name, type, deleteBtn);
    list.appendChild(li);
  });
}

function renderAdminCalendar() {
  const grid = document.getElementById("admin-cal-grid");
  const label = document.getElementById("admin-cal-label");
  const year = adminDisplayedMonth.getFullYear();
  const month = adminDisplayedMonth.getMonth();
  label.textContent = `${ADMIN_MONTH_NAMES[month]} ${year}`;

  const entriesByDate = {};
  adminAllAssessments.forEach((entry) => {
    (entriesByDate[entry.date] = entriesByDate[entry.date] || []).push(entry);
  });

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
    const iso = adminToISODate(new Date(year, month, day));
    const dayBtn = document.createElement("button");
    dayBtn.type = "button";
    dayBtn.className = "assessment-calendar-day";

    // A separate inner span so "today" can be a small circle sized around
    // just the number, rather than filling the whole cell.
    const dayNumber = document.createElement("span");
    dayNumber.className = "assessment-calendar-day-number";
    dayNumber.textContent = String(day);
    if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) {
      dayNumber.classList.add("assessment-calendar-day-number--today");
    }
    dayBtn.appendChild(dayNumber);
    dayBtn.appendChild(buildDayTypeLabel(iso));

    // One dot per assessment scheduled that day — except every 5 are shown
    // as a single square instead (like a tally), so a busy day's row of
    // marks never grows wider than its cell.
    if (entriesByDate[iso] && entriesByDate[iso].length > 0) {
      const dots = document.createElement("div");
      dots.className = "assessment-calendar-day-dots";
      const count = entriesByDate[iso].length;
      for (let i = 0; i < Math.floor(count / 5); i++) {
        const square = document.createElement("span");
        square.className = "assessment-calendar-day-dot assessment-calendar-day-dot--five";
        dots.appendChild(square);
      }
      for (let i = 0; i < count % 5; i++) {
        const dot = document.createElement("span");
        dot.className = "assessment-calendar-day-dot";
        dots.appendChild(dot);
      }
      dayBtn.appendChild(dots);
    }
    if (adminSelectedDate === iso) dayBtn.classList.add("assessment-calendar-day--selected");

    dayBtn.addEventListener("click", () => {
      adminSelectedDate = iso;
      renderAdminCalendar();
    });

    grid.appendChild(dayBtn);
  }

  renderDayPanel(entriesByDate[adminSelectedDate] || []);
}

function initAdminPage() {
  ADMIN_WEEKDAY_LABELS.forEach((day) => {
    const span = document.createElement("span");
    span.textContent = day;
    document.getElementById("admin-cal-weekdays").appendChild(span);
  });

  const courseInput = document.querySelector(".admin-course-input");
  setupAdminCourseDropdown(courseInput, () => syncAdminDivisionPicker(courseInput));
  setupTypeToggle();
  setupDayTypeToggle();
  initScheduleModal();

  // Only courses that exist in COURSE_CATALOG can be scheduled — anything
  // else warns instead of silently accepting it. Checked on blur, not
  // every keystroke, since partial text while typing is expected.
  courseInput.addEventListener("blur", () => {
    const name = courseInput.value.trim();
    if (name && !findCourseCatalogEntry(name)) {
      showAdminToast("The course you typed does not exist.");
    }
  });

  document.getElementById("admin-cal-prev").addEventListener("click", () => {
    adminDisplayedMonth = new Date(adminDisplayedMonth.getFullYear(), adminDisplayedMonth.getMonth() - 1, 1);
    adminSelectedDate = null;
    renderAdminCalendar();
  });
  document.getElementById("admin-cal-next").addEventListener("click", () => {
    adminDisplayedMonth = new Date(adminDisplayedMonth.getFullYear(), adminDisplayedMonth.getMonth() + 1, 1);
    adminSelectedDate = null;
    renderAdminCalendar();
  });

  document.getElementById("admin-add-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector(".admin-course-input");
    const name = input.value.trim();
    if (!name) return;

    const course = findCourseCatalogEntry(name);
    if (!course) {
      showAdminToast("The course you typed does not exist.");
      return;
    }

    if (course.divisions && !adminSelectedDivision) {
      alert("Pick a division first — this course tests on different days for each one.");
      return;
    }

    const otherInput = document.getElementById("admin-type-other-input");
    const otherText = adminOtherTypeText.trim();
    if (adminSelectedType === "Other" && !otherText) {
      alert("Type a label for the custom assessment type first.");
      return;
    }
    const type = adminSelectedType === "Other" ? otherText : adminSelectedType;

    addAssessment(effectiveCourseName(name, adminSelectedDivision), type);
    input.value = "";
    syncAdminDivisionPicker(input);
    otherInput.value = "";
    adminOtherTypeText = "";
  });

  fetchAdminPeriodTimes();
  fetchAdminDayTypes(() => fetchAdminAssessments(renderAdminCalendar));
}

// Purely cosmetic — the real gate is firestore.rules, checking the same
// email server-side.
function handleAdminAuthState(user) {
  const isAdmin = Boolean(user && ADMIN_EMAILS.includes(user.email));
  document.getElementById("admin-not-authorized").hidden = isAdmin;
  document.getElementById("admin-calendar-layout").hidden = !isAdmin;

  if (isAdmin && !adminInitialized) {
    adminInitialized = true;
    initAdminPage();
  }
}

auth.onAuthStateChanged(handleAdminAuthState);
