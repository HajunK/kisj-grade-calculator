// Shared across every data page (My Courses, Domain, GPA): the grading
// scale, theme-aware icon paths, the digit-roll number animation, the
// appData store (the in-memory mirror of the user's whole Firestore
// document), and the cloud-sync machinery that fills it in and keeps it
// there.

// US grading scale: lowest score (inclusive) for each letter grade tier.
const GRADE_SCALE = [
  { min: 98, slug: "a-plus", label: "A+" },
  { min: 93, slug: "a", label: "A" },
  { min: 90, slug: "a-minus", label: "A-" },
  { min: 87, slug: "b-plus", label: "B+" },
  { min: 83, slug: "b", label: "B" },
  { min: 80, slug: "b-minus", label: "B-" },
  { min: 77, slug: "c-plus", label: "C+" },
  { min: 73, slug: "c", label: "C" },
  { min: 70, slug: "c-minus", label: "C-" },
  { min: 67, slug: "d-plus", label: "D+" },
  { min: 63, slug: "d", label: "D" },
  { min: 60, slug: "d-minus", label: "D-" },
  { min: 0, slug: "f", label: "F" },
];

// "dark" or "light" — used for both grade-icons/ (letter grade badges) and
// icons/ (link, date, etc.), each with its own light/dark subfolder.
function themeFolder() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

// Letter-only PNGs (white, transparent) — the colored circle behind each is
// drawn in CSS from the img's data-slug (see img[data-slug] in domain.css),
// which is what makes them theme-aware, not separate light/dark files.
function gradeIconPath(slug) {
  return `grade-icons/${slug}.png`;
}

// The other theme-aware icon folder — link/unlink, date, hide/show, etc.
function uiIconPath(name) {
  return `icons/${themeFolder()}/${name}`;
}

// Kept so a theme switch still has one place to refresh every letter-grade
// icon from — though the letter PNGs themselves no longer differ by theme
// (only their CSS background does, which updates on its own).
window.refreshGradeIcons = function refreshGradeIcons() {
  document.querySelectorAll(".letter-grade[data-slug]").forEach((img) => {
    img.src = gradeIconPath(img.dataset.slug);
  });
};

// Same idea for the other theme-aware icon folder (uiIconPath — link,
// date, hide/show, key, etc.), a live theme switch (Settings > Appearance,
// or the OS-level change while on "System") would otherwise leave every
// already-rendered one of these stuck showing its old theme's asset until
// the next full page load. These aren't tagged with a name like
// .letter-grade's data-slug, so this swaps the light/dark folder segment
// already present in each one's own current src instead.
window.refreshUiIcons = function refreshUiIcons() {
  const folder = themeFolder();
  document.querySelectorAll('img[src*="icons/light/"], img[src*="icons/dark/"]').forEach((img) => {
    img.src = img.src.replace(/icons\/(light|dark)\//, `icons/${folder}/`);
  });
};

// Tracks the in-progress roll animation per element, so rapid updates (e.g.
// typing quickly) restart cleanly instead of stacking cleanup timers.
const numberAnimations = new WeakMap();

const ROLL_DURATION_MS = 800;
const ROLL_STAGGER_MS = 60; // delay between each digit (left to right) settling

function measureCharWidth(referenceEl, char) {
  return measureCharWidths(referenceEl, char)[0];
}

// Measures each character's width as it renders within the full string,
// not in isolation, so font kerning between neighbors (e.g. a digit next
// to a decimal point) is captured — keeps the animated slot widths in
// agreement with the plain text the animation collapses back to.
function measureCharWidths(referenceEl, text) {
  if (text.length === 0) return [];

  const style = getComputedStyle(referenceEl);
  const probe = document.createElement("span");
  probe.textContent = text;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.style.fontWeight = style.fontWeight;
  probe.style.fontStyle = style.fontStyle;
  document.body.appendChild(probe);

  const textNode = probe.firstChild;
  const range = document.createRange();
  const widths = [];
  for (let i = 0; i < text.length; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    widths.push(range.getBoundingClientRect().width);
  }

  probe.remove();
  return widths;
}

// Rebuilds `element` as a strip of digit "reels" — each digit gets its own
// fixed-height, overflow-hidden slot containing a vertical run of digits,
// animated via transform: translateY so digits scroll past like an
// odometer. Non-digit characters (".", "-") render as plain static text.
//
// revealStyle is "instant" for a page load restoring saved scores — never
// animated at all, roll or otherwise, regardless of what oldText happens
// to be — and "blur" for a live change once the page has actually
// settled, which blurs a value into focus the moment it turns from blank
// ("-") to real, or otherwise rolls normally like any other live update.
// Where a roll still in progress is right now, read off how far each digit
// strip has scrolled. positions[i] is that character's digit as a fraction
// (5.3 = a 5 three-tenths of the way to 6), or null for a "." or "-"; widths[i]
// is its slot's width at this moment. text is the same thing rounded, for
// measuring widths. null when nothing is mid-roll.
function midRollState(element) {
  if (!numberAnimations.has(element)) return null;
  let text = "";
  const positions = [];
  const widths = [];
  const leaving = [];
  for (const child of element.children) {
    // A digit already shrinking away isn't part of the number anymore, but
    // it's kept so it can finish shrinking instead of vanishing.
    if (child.dataset.rollLeaving) {
      const style = getComputedStyle(child);
      leaving.push({ text: child.textContent, width: parseFloat(style.width), opacity: parseFloat(style.opacity) });
      continue;
    }
    widths.push(parseFloat(getComputedStyle(child).width));
    const strip = child.firstElementChild;
    if (!strip) {
      text += child.textContent;
      positions.push(null);
      continue;
    }
    const slotHeight = parseFloat(child.style.height);
    const transform = getComputedStyle(strip).transform;
    const offsetY = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
    const index = Math.min(strip.children.length - 1, Math.max(0, -offsetY / slotHeight));
    // Strip entries always count up by one, so the digit keeps counting up
    // through the fraction between two entries.
    const position = (Number(strip.children[Math.floor(index)].textContent) + (index - Math.floor(index))) % 10;
    positions.push(position);
    text += String(Math.round(position) % 10);
  }
  return text ? { text, positions, widths, leaving } : null;
}

function animateNumberChange(element, newText, revealStyle) {
  if (element.dataset.rollValue === newText) return;

  // Roll forward from whatever is showing, not from 0. A roll still under way
  // is picked up from exactly where its digits are, heading for the new target,
  // rather than snapping to its old target first.
  const midRoll = midRollState(element);
  const oldText = midRoll
    ? midRoll.text
    : element.dataset.rollValue !== undefined
      ? element.dataset.rollValue
      : element.textContent;

  // Cancels an earlier roll's own pending cleanup (see the setTimeout
  // below) and undoes the inline display it sets mid-roll — without this,
  // a change arriving before that timeout fires (e.g. typing a score right
  // after deleting one, before its roll-to-"-" finishes) would have its
  // own freshly-set text stomped later by the stale timeout, or silently
  // inherit the wrong display value.
  clearTimeout(numberAnimations.get(element));
  numberAnimations.delete(element);
  element.style.display = "";
  element.style.alignItems = "";

  if (revealStyle === "instant") {
    element.dataset.rollValue = newText;
    element.textContent = newText;
    return;
  }

  // "--" is the big Domain grade's own empty placeholder (see
  // updateDomainBadge); "-" is every other number's.
  if (revealStyle === "blur" && (oldText === "-" || oldText === "--")) {
    element.dataset.rollValue = newText;
    element.textContent = newText;
    // Paired with a slight opacity fade — blur alone reads flatter, this
    // closer to a natural focus-pull.
    element.style.filter = "blur(2px)";
    element.style.opacity = "0.4";
    void element.offsetWidth; // force reflow so the state above actually takes effect first
    element.style.transition = "filter 400ms ease-out, opacity 400ms ease-out";
    element.style.filter = "";
    element.style.opacity = "";
    return;
  }

  element.dataset.rollValue = newText;

  // Direction is decided by the number as a whole, not digit-by-digit —
  // e.g. 79 -> 86 spins every digit forward even though 6 < 9 on its own.
  const oldValue = parseFloat(oldText);
  const newValue = parseFloat(newText);
  const overallGoingUp = isNaN(oldValue) || isNaN(newValue) || newValue >= oldValue;

  const slotHeight = Math.ceil(parseFloat(getComputedStyle(element).fontSize) * 1.2);

  element.textContent = "";
  element.style.display = "inline-flex";
  element.style.alignItems = "flex-end";

  const oldWidths = measureCharWidths(element, oldText);
  const newWidths = measureCharWidths(element, newText);

  // Match digits by place value, not left-to-right index — otherwise
  // gaining/losing an integer digit (e.g. 99 -> 100) compares the wrong
  // pairs. Integer digits match from the right; decimal digits from the
  // left (right after the point).
  const newDot = newText.indexOf(".");
  const oldDot = oldText.indexOf(".");
  const newIntLen = newDot === -1 ? newText.length : newDot;
  const oldIntLen = oldDot === -1 ? oldText.length : oldDot;

  function correspondingOldIndex(i) {
    if (i < newIntLen) {
      const distanceFromRight = newIntLen - 1 - i;
      return oldIntLen - 1 - distanceFromRight;
    }
    const decimalOffset = i - (newDot + 1);
    return oldDot === -1 ? -1 : oldDot + 1 + decimalOffset;
  }

  let maxDelay = 0;
  const continuing = Boolean(midRoll);

  // Integer digits the new number no longer has (e.g. the "1" when 100 ->
  // 99) shrink to nothing and fade, instead of vanishing on the first frame.
  // Ones still shrinking from an interrupted roll carry on from where they are.
  const leavingDigits = continuing ? midRoll.leaving.slice() : [];
  for (let oldIndex = 0; oldIndex < oldIntLen - newIntLen; oldIndex++) {
    leavingDigits.push({
      text: oldText[oldIndex],
      width: continuing ? midRoll.widths[oldIndex] : oldWidths[oldIndex],
      opacity: 1,
    });
  }
  const leavingCurve = continuing ? "cubic-bezier(0.33, 1, 0.68, 1)" : "cubic-bezier(0.65, 0, 0.35, 1)";
  leavingDigits.forEach(({ text, width, opacity }) => {
    const leaving = document.createElement("span");
    leaving.dataset.rollLeaving = "true";
    leaving.style.cssText = `display:inline-block; overflow:hidden; height:${slotHeight}px; line-height:${slotHeight}px; width:${width}px; opacity:${opacity}; text-align:center; transition:none;`;
    leaving.textContent = text;
    element.appendChild(leaving);
    void leaving.offsetWidth; // commit the starting width before transitioning away from it
    leaving.style.transition = `width ${ROLL_DURATION_MS}ms ${leavingCurve}, opacity ${ROLL_DURATION_MS}ms ${leavingCurve}`;
    leaving.style.width = "0px";
    leaving.style.opacity = "0";
  });

  newText.split("").forEach((ch, i) => {
    if (!/[0-9]/.test(ch)) {
      const staticEl = document.createElement("span");
      staticEl.textContent = ch;
      staticEl.style.cssText = `display:inline-block; width:${newWidths[i]}px; text-align:center;`;
      element.appendChild(staticEl);
      return;
    }

    const finalDigit = Number(ch);
    const newWidth = newWidths[i];
    const oldIndex = correspondingOldIndex(i);
    const oldChar = oldIndex >= 0 && oldIndex < oldText.length ? oldText[oldIndex] : undefined;
    const hasOldDigit = /[0-9]/.test(oldChar);

    // A continued roll is already moving, so it skips the stagger and starts
    // fast then eases out, reading as one motion instead of a fresh start.
    const delay = continuing ? 0 : i * ROLL_STAGGER_MS;
    maxDelay = Math.max(maxDelay, delay);
    const curve = continuing ? "cubic-bezier(0.33, 1, 0.68, 1)" : "cubic-bezier(0.65, 0, 0.35, 1)";
    const easing = `${ROLL_DURATION_MS}ms ${curve} ${delay}ms`;

    // No corresponding old digit at this place value (e.g. the new leading
    // "1" when 99 -> 100) — rolls up from 0 instead. Mid roll, this is the
    // exact (possibly fractional) spot the digit is at.
    const midPosition = continuing && oldIndex >= 0 ? midRoll.positions[oldIndex] : null;
    const startPosition = midPosition !== null && midPosition !== undefined ? midPosition : hasOldDigit ? Number(oldChar) : 0;
    const startWhole = Math.floor(startPosition);
    const startFraction = startPosition - startWhole;

    // Every digit spins the same direction as the number overall, wrapping
    // 0-9 if needed (e.g. 9 -> 6 while increasing wraps forward). A digit
    // with no old value always rolls up from 0.
    const goingUp = hasOldDigit ? overallGoingUp : true;
    // Going up, the strip runs from the digit at or below the start up to the
    // final one. Going down, from the final one up to the digit at or above the
    // start. A start partway past the final digit has to wrap all the way round.
    const top = startWhole + (startFraction > 0 ? 1 : 0);
    let steps = goingUp ? finalDigit - startWhole : top - finalDigit;
    steps = ((steps % 10) + 10) % 10;
    if (steps === 0 && startFraction > 0) steps = 10;
    const stripLength = steps + 1;
    // How far into the strip the start sits, in entries.
    const startIndex = goingUp ? startFraction : steps - (top - startPosition);
    // Digits aren't all the same width, so the slot eases from the old digit's
    // width to the new one's alongside the roll instead of jumping to it. A
    // digit with no old counterpart grows in from nothing.
    const midWidth = continuing && oldIndex >= 0 ? midRoll.widths[oldIndex] : undefined;
    const startWidth = midWidth !== undefined ? midWidth : hasOldDigit ? oldWidths[oldIndex] : 0;
    const slot = document.createElement("span");
    slot.style.cssText = `display:inline-block; overflow:hidden; height:${slotHeight}px; width:${startWidth}px; text-align:center; transition:none;`;

    const strip = document.createElement("span");
    strip.style.cssText = "display:block; transition:none;";

    // Going up: digits listed start -> final; translateY(0) shows the old
    // one, scrolling to -max reveals the new one from below. Going down:
    // digits listed final -> start, starting scrolled to the bottom entry
    // and animating back to translateY(0), so the new digit drops in from
    // above.
    const base = goingUp ? startWhole : finalDigit;
    for (let d = 0; d < stripLength; d++) {
      const digitEl = document.createElement("span");
      digitEl.style.cssText = `display:block; height:${slotHeight}px; line-height:${slotHeight}px;`;
      digitEl.textContent = String((base + d) % 10);
      strip.appendChild(digitEl);
    }

    const maxOffset = (stripLength - 1) * slotHeight;
    const startTransform = -startIndex * slotHeight;
    const endTransform = goingUp ? -maxOffset : 0;
    strip.style.transform = `translateY(${startTransform}px)`;

    slot.appendChild(strip);
    element.appendChild(slot);

    // Force a layout flush so the resting frame commits before the
    // transitioned end state is applied.
    void strip.offsetHeight;
    strip.style.transition = `transform ${easing}`;
    strip.style.transform = `translateY(${endTransform}px)`;
    slot.style.transition = `width ${easing}`;
    slot.style.width = `${newWidth}px`;
  });

  const timer = setTimeout(() => {
    element.textContent = newText;
    element.style.display = "";
    element.style.alignItems = "";
    numberAnimations.delete(element);
  }, ROLL_DURATION_MS + maxDelay + 50);

  numberAnimations.set(element, timer);
}

// Truncates (not rounds) to N decimal places. The tiny epsilon guards
// against float error incorrectly truncating down a step.
function truncateToDecimals(value, decimals) {
  const factor = 10 ** decimals;
  const truncated = Math.floor(value * factor + 1e-9) / factor;
  return truncated.toFixed(decimals);
}

function truncateToTwoDecimals(value) {
  return truncateToDecimals(value, 2);
}

function truncateToFourDecimals(value) {
  return truncateToDecimals(value, 4);
}

function roundToFourDecimals(value) {
  return value.toFixed(4);
}

// All of this app's data lives only in memory (appData) and in Firestore —
// nothing is written to localStorage or read back from it directly. Signed
// out, appData just holds whatever's been entered for the current page
// view and is lost on navigation.
let appData = {
  periods: [],
  // Parallel to periods — index i holds the division picked for periods[i]
  // (e.g. "10" for an English section), or "" if none has been picked.
  periodDivisions: [],
  // Card display names currently hidden from Domain — plain names, not
  // scores, so this stays unencrypted alongside periods/periodDivisions.
  hiddenCourses: [],
  // Assessments a student added themselves (My Courses' "Add Missing
  // Summative") that aren't in the school-wide assessments collection —
  // { id, date, courseName, type, createdAt }. Plain course names/dates,
  // not scores, so this also stays unencrypted.
  addedAssessments: [],
  // The assessments and assignments checked off in the Calendar tab's
  // Upcoming list, as { id, completedAt }. Plain ids and times, so
  // unencrypted too.
  completedTasks: [],
  domainSnapshot: [],
  gpaClasses: [],
  domainScores: {},
  preferences: {},
  // Round-tripped (never edited from this file) so pushDataToCloud()'s
  // plain .set() below doesn't wipe out the email auth.js saves.
  email: "",
  lastModified: 0,
};

function loadPeriods() {
  return appData.periods;
}

function loadPeriodDivisions() {
  // A cached appData written before this field existed won't have it at
  // all — fall back to empty rather than crash call sites expecting an array.
  return appData.periodDivisions || [];
}

function loadHiddenCourses() {
  return appData.hiddenCourses || [];
}

function saveHiddenCourses(names) {
  appData.hiddenCourses = names;
  pushDataToCloud();
}

function loadAddedAssessments() {
  return appData.addedAssessments || [];
}

function saveAddedAssessments(entries) {
  appData.addedAssessments = entries;
  pushDataToCloud();
}

function loadCompletedTasks() {
  return appData.completedTasks || [];
}

function saveCompletedTasks(ids) {
  appData.completedTasks = ids;
  pushDataToCloud();
}

// --- Cloud sync (Firestore) ---
// Firestore is the only source of truth. localStorage is only a
// same-device speed optimization, so navigating between pages (a
// multi-page site) doesn't have to wait on a network round-trip to render.

let currentUid = null;

// Order-independent for objects (Firestore doesn't preserve map field key
// order), order-dependent for arrays (periods[0] is Period 1, not
// interchangeable with periods[1]).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
}

function cacheKeyFor(uid) {
  return `cachedAppData_${uid}`;
}

function readCachedAppData(uid) {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKeyFor(uid)));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedAppData(uid, data) {
  try {
    localStorage.setItem(cacheKeyFor(uid), JSON.stringify(data));
  } catch {
    // ignore — cache is optional
  }
}

// Removes any other signed-in user's cached data lying around on this
// device — only the current user's cache is kept.
function clearOtherCachedAppData(uid) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && key.startsWith("cachedAppData_") && key !== cacheKeyFor(uid)) {
      localStorage.removeItem(key);
    }
  }
}

// A plain marker of who was last confirmed signed in, synchronously
// readable unlike Firebase's own async auth state — used only as a first
// guess for instant rendering; Firebase's resolution is the final word.
const LAST_UID_KEY = "lastKnownUid";

function readLastKnownUid() {
  return localStorage.getItem(LAST_UID_KEY);
}

function writeLastKnownUid(uid) {
  try {
    localStorage.setItem(LAST_UID_KEY, uid);
  } catch {
    // ignore
  }
}

function clearLastKnownUid() {
  localStorage.removeItem(LAST_UID_KEY);
}

let sharedToastEl = null;
let sharedToastHideTimer = null;
const SHARED_TOAST_VISIBLE_MS = 4000;

// Generic bottom-center floating message — reused for anything needing a
// brief, dismissable heads-up.
// message is plain text, or a node when the toast needs a link in it.
function showToast(message) {
  if (!sharedToastEl) {
    sharedToastEl = document.createElement("div");
    sharedToastEl.className = "signin-toast";
    document.body.appendChild(sharedToastEl);
    void sharedToastEl.offsetWidth; // force reflow so the entrance below actually transitions
  }

  sharedToastEl.replaceChildren(message);
  sharedToastEl.classList.add("signin-toast--visible");
  clearTimeout(sharedToastHideTimer);
  sharedToastHideTimer = setTimeout(() => {
    sharedToastEl.classList.remove("signin-toast--visible");
  }, SHARED_TOAST_VISIBLE_MS);
}

function hideToast() {
  if (!sharedToastEl) return;
  clearTimeout(sharedToastHideTimer);
  sharedToastEl.classList.remove("signin-toast--visible");
}

// Chrome's own title tooltip, but see-through and quicker to appear: a single
// shared element on <body>, shown just below the cursor once it has rested on
// the element for HOVER_TOOLTIP_DELAY_MS. Like the native one it doesn't
// follow the cursor: it stays where it is while the mouse moves, and jumps to
// the cursor's new spot once the mouse rests again.
const HOVER_TOOLTIP_DELAY_MS = 400;
// The closest it comes to any edge of the window.
const HOVER_TOOLTIP_EDGE_GAP = 8;
let hoverTooltipEl = null;
let hoverTooltipTimer = null;

function hideHoverTooltip() {
  clearTimeout(hoverTooltipTimer);
  if (hoverTooltipEl) hoverTooltipEl.classList.remove("hover-tooltip--visible");
}

// Whole-pixel width (and position, below): at a fractional edge the 1px rim
// renders softer on that side than the others.
function sizeHoverTooltip(tooltip) {
  tooltip.style.width = "";
  tooltip.style.width = `${Math.ceil(tooltip.getBoundingClientRect().width)}px`;
}

// Just below the cursor, kept on screen: slid left of it near the right edge,
// and flipped above it near the bottom, as the native one does.
function placeHoverTooltip(tooltip, x, y) {
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = Math.min(Math.round(x), window.innerWidth - width - HOVER_TOOLTIP_EDGE_GAP);
  const below = Math.round(y) + 18;
  const top = below + height > window.innerHeight - HOVER_TOOLTIP_EDGE_GAP ? Math.round(y) - 8 - height : below;
  tooltip.style.left = `${Math.max(HOVER_TOOLTIP_EDGE_GAP, left)}px`;
  tooltip.style.top = `${Math.max(HOVER_TOOLTIP_EDGE_GAP, top)}px`;
}

// A tooltip that shows at once and follows the cursor anywhere on the page,
// for a mode that takes over the page (like the Calendar's date picking).
// Separate from the hover one, which that mode keeps suppressed. Returns a
// function that removes it.
function showCursorTooltip(text, x, y) {
  const tooltip = document.createElement("div");
  tooltip.className = "hover-tooltip";
  tooltip.textContent = text;
  document.body.appendChild(tooltip);
  sizeHoverTooltip(tooltip);
  placeHoverTooltip(tooltip, x, y);
  const follow = (event) => placeHoverTooltip(tooltip, event.clientX, event.clientY);
  document.addEventListener("mousemove", follow);
  void tooltip.offsetWidth; // force reflow so the fade-in below actually plays
  tooltip.classList.add("hover-tooltip--visible");
  return () => {
    document.removeEventListener("mousemove", follow);
    tooltip.classList.remove("hover-tooltip--visible");
    setTimeout(() => tooltip.remove(), 150);
  };
}

function attachHoverTooltip(element, text) {
  let cursor = null;
  const showSoon = (event) => {
    // Ignores the tiny jitter of a hand resting on a trackpad.
    if (cursor && Math.hypot(event.clientX - cursor.x, event.clientY - cursor.y) < 2) return;
    cursor = { x: event.clientX, y: event.clientY };
    clearTimeout(hoverTooltipTimer);
    hoverTooltipTimer = setTimeout(() => {
      // Set while something (like the Calendar's date picking) takes over
      // the page and tooltips would only get in the way.
      if (document.documentElement.dataset.suppressTooltips) return;
      if (!hoverTooltipEl) {
        hoverTooltipEl = document.createElement("div");
        hoverTooltipEl.className = "hover-tooltip";
        document.body.appendChild(hoverTooltipEl);
      }
      hoverTooltipEl.textContent = text;
      sizeHoverTooltip(hoverTooltipEl);
      placeHoverTooltip(hoverTooltipEl, cursor.x, cursor.y);
      hoverTooltipEl.classList.add("hover-tooltip--visible");
    }, HOVER_TOOLTIP_DELAY_MS);
  };
  element.addEventListener("mouseenter", showSoon);
  element.addEventListener("mousemove", showSoon);
  // Like the native one, a click dismisses it; this also stops it hovering over
  // whatever the click opens.
  element.addEventListener("mousedown", hideHoverTooltip);
  element.addEventListener("mouseleave", () => {
    cursor = null;
    hideHoverTooltip();
  });
}

// A signed-out edit never reaches Firestore — this is the chokepoint
// every page's saves funnel through.
function showSignInToast() {
  showToast("Sign in to save your data!");
}

function pushDataToCloud() {
  if (!currentUid) {
    showSignInToast();
    return;
  }
  // Stamped on every write so a page that reads Firestore before this
  // write lands (a real race) can tell its own data is actually newer.
  appData.lastModified = Date.now();
  // The local cache stays plaintext — encryption hides data from
  // Firestore, not from this device's own storage.
  writeCachedAppData(currentUid, appData);

  if (typeof firebase === "undefined" || !firebase.firestore) return;

  const uid = currentUid;
  // Snapshotted now — appData's encrypted fields are always replaced
  // wholesale, never mutated in place, so this shallow copy is safe even
  // if another save starts while this encryption is in flight.
  const snapshot = { ...appData };
  getDeviceKey(uid)
    .then((key) => encryptAppDataForCloud(snapshot, key))
    .then((encrypted) => firebase.firestore().collection("users").doc(uid).set(encrypted))
    .catch((error) => console.error("Failed to save to Firestore:", error));
}

function resetAppData() {
  appData = {
    periods: [],
    periodDivisions: [],
    hiddenCourses: [],
    addedAssessments: [],
    completedTasks: [],
    domainSnapshot: [],
    gpaClasses: [],
    domainScores: {},
    preferences: {},
    email: "",
    lastModified: 0,
  };
}

// Builds/populates whichever page this is from appData. Each init*Page
// function only exists as a global if that page's own script was loaded —
// exactly one of these three calls does anything.
function initPage() {
  if (typeof initMyCoursesPage === "function") initMyCoursesPage();
  if (typeof initDomainPage === "function") initDomainPage();
  if (typeof initGpaPage === "function") initGpaPage();
  if (typeof initClassCountdown === "function") initClassCountdown();
}

// initPage() is safe to run once, not a second time on top of itself
// (duplicate class cards, double-bound listeners). A sign-in/out while
// already initialized just reloads instead of calling it again directly.
let hasInitializedPage = false;

function handleAuthResolved() {
  if (hasInitializedPage) {
    console.log("[boot] handleAuthResolved: already rendered — reloading", { appData });
    location.reload();
    return;
  }
  console.log("[boot] handleAuthResolved: rendering for the first time", { appData });
  hasInitializedPage = true;
  initPage();
}
