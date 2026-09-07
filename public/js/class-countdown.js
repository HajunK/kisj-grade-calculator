// "Time left in class" pill — bottom-left, ticking live every second.
// Built on SCHEDULE_BLOCKS/defaultPeriodTimes/allDayTypes (see
// assessments-shared.js), loadPeriods() and animateNumberChange (see
// shared.js), so this only does anything on a page that loads all of
// those (My Courses, Domain).

let classCountdownEl = null;
let classCountdownTimer = null;

// "08:50" -> 530 (minutes since midnight).
function parseTimeToMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

// The school block happening right now, if any — { block, dayType,
// minutesLeft } — null outside school hours, on a weekend/unset ("?")
// day, or if the admin hasn't set up a schedule at all yet. Only ever
// resolved against TODAY: this is a live "right now" readout, not
// something that looks ahead.
function currentScheduleBlock() {
  const now = new Date();
  const iso = toISODate(now);
  const dayType = allDayTypes[iso];
  if (dayType !== "A" && dayType !== "B") return null;

  const times = defaultPeriodTimes && defaultPeriodTimes.times;
  if (!times) return null;

  // Fractional so minutesLeft below ticks smoothly within the minute,
  // rather than only changing once a whole minute rolls over.
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  for (let i = 0; i < SCHEDULE_BLOCKS.length; i++) {
    const time = times[i];
    if (!time || !time.start || !time.end) continue;
    const start = parseTimeToMinutes(time.start);
    const end = parseTimeToMinutes(time.end);
    if (nowMinutes >= start && nowMinutes < end) {
      return { block: SCHEDULE_BLOCKS[i], dayType, minutesLeft: end - nowMinutes };
    }
  }
  return null;
}

// Whatever's actually rendered directly behind the pill's current
// on-screen position — walks up from there past any transparent
// ancestors to the first real (non-transparent) background color, or
// null if nothing opaque is found before the page itself.
function colorBehindPill(el) {
  if (typeof document.elementsFromPoint !== "function") return null;

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const stack = document.elementsFromPoint(x, y);
  const behindPill = stack.find((node) => node !== el && !el.contains(node));
  if (!behindPill) return null;

  for (let node = behindPill; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  }
  return null;
}

// Different tabs lay out differently, and this is position: fixed over
// content that keeps scrolling underneath it (a different amount on
// different devices, per different viewport heights) — so what's behind
// it isn't one fixed color to hardcode against. Sampled live instead, and
// the border only turns on once that color is genuinely the same as the
// pill's own (see .class-countdown-pill--needs-outline in style.css).
function updatePillContrastOutline() {
  if (!classCountdownEl || classCountdownEl.hidden) return;
  const behind = colorBehindPill(classCountdownEl);
  const ownBackground = getComputedStyle(classCountdownEl).backgroundColor;
  classCountdownEl.classList.toggle("class-countdown-pill--needs-outline", behind === ownBackground);
}

// rAF-throttled — scroll fires far more often than a frame renders, and
// this only needs to be current by the next paint.
let pillContrastFrame = null;
function schedulePillContrastCheck() {
  if (pillContrastFrame) return;
  pillContrastFrame = requestAnimationFrame(() => {
    pillContrastFrame = null;
    updatePillContrastOutline();
  });
}

function buildCountdownEl() {
  const el = document.createElement("div");
  el.className = "class-countdown-pill";
  el.innerHTML = `
    <svg class="class-countdown-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="class-countdown-time"></span>
    <span class="class-countdown-sep">·</span>
    <span class="class-countdown-label"></span>
  `;
  document.body.appendChild(el);
  return el;
}

function updateClassCountdown() {
  const current = currentScheduleBlock();
  if (!current) {
    if (classCountdownEl) classCountdownEl.hidden = true;
    return;
  }

  let label;
  if (current.block.type === "lunch") {
    label = "Lunch";
  } else {
    // slot 0-3 -> Period 1-4 on an A-day, Period 5-8 on a B-day — same
    // convention as every other periodIndex check in the app.
    const periodIndex = current.block.slot + (current.dayType === "A" ? 0 : 4);
    const courseName = (loadPeriods()[periodIndex] || "").trim();
    // Nothing typed in for this period on My Courses — nothing to show.
    if (!courseName) {
      if (classCountdownEl) classCountdownEl.hidden = true;
      return;
    }
    label = courseName;
  }

  // Reappearing after being hidden (first ever showing, or the gap
  // between classes) shouldn't roll from whatever stale number was left
  // over from before — only an actual live tick while already on screen
  // should animate.
  const wasHidden = !classCountdownEl || classCountdownEl.hidden;
  if (!classCountdownEl) classCountdownEl = buildCountdownEl();
  classCountdownEl.hidden = false;

  const minutesLeft = Math.max(0, Math.floor(current.minutesLeft));
  const timeEl = classCountdownEl.querySelector(".class-countdown-time");
  animateNumberChange(timeEl, `${minutesLeft}m`, wasHidden ? "instant" : undefined);
  classCountdownEl.querySelector(".class-countdown-label").textContent = label;
  updatePillContrastOutline();
}

function initClassCountdown() {
  if (typeof loadScheduleData !== "function") return; // page doesn't load assessments-shared.js

  // capture: true — scroll events don't bubble, so this is what catches
  // one from a nested scroller (e.g. Domain's .classes-container), not
  // just the page's own. Re-checked here rather than only once a second
  // so a scroll mid-tick doesn't leave a stale outline state showing.
  window.addEventListener("scroll", schedulePillContrastCheck, { capture: true, passive: true });
  window.addEventListener("resize", schedulePillContrastCheck);

  loadScheduleData(() => {
    updateClassCountdown();
    // Cleared first — loadScheduleData's callback can fire twice (once
    // from cache, once from a real fetch confirming/replacing it), and a
    // second interval stacked on the first would double-update every tick.
    clearInterval(classCountdownTimer);
    classCountdownTimer = setInterval(updateClassCountdown, 1000);
  });
}
