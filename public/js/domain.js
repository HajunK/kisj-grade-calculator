// Domain page: class cards, Formative/Summative/Final Exam score entry,
// FA/SA/D + big-grade calculation, the link/unlink replacement animation,
// and the assessment-date calendar popup.

const EMPTY_SCORE_ROWS = 8;

// A valid 1x1 transparent GIF — used instead of leaving `src` unset, since
// an <img> with no src shows the browser's broken-image icon.
const TRANSPARENT_ICON = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function letterGradeForScore(score) {
  return GRADE_SCALE.find((tier) => score >= tier.min);
}

// One side of a score or fraction: digits only, at most one decimal point,
// and at most 1 decimal place.
function sanitizeScoreDigits(value) {
  const firstDot = value.indexOf(".");
  if (firstDot !== -1) {
    value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, "");
    value = value.slice(0, firstDot + 2);
  }
  return value;
}

// Strips a typed score down to plain digits (as sanitizeScoreDigits above),
// or — typing a "/" — a fraction's numerator and denominator, each
// sanitized the same way (e.g. "45/50"). A fraction is evaluated into a
// whole-number score on commit; see commitFractionInput. Does not enforce
// the 0-100 range itself — that's handled separately (and skipped
// mid-fraction, see the input handler) so an over-100 keystroke can be
// rejected outright instead of clamped.
function sanitizeScoreInput(raw) {
  const value = raw.replace(/[^0-9./]/g, "");
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return sanitizeScoreDigits(value);

  const numerator = sanitizeScoreDigits(value.slice(0, slashIndex));
  const denominator = sanitizeScoreDigits(value.slice(slashIndex + 1).replace(/\//g, ""));
  return `${numerator}/${denominator}`;
}

// Turns a committed "45/50"-style value into a whole-number score
// ((45/50) * 100, rounded) — "" if it isn't a complete, valid fraction.
// Anything without a "/" is returned untouched.
function commitFractionInput(value) {
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) return value;

  const numerator = parseFloat(value.slice(0, slashIndex));
  const denominator = parseFloat(value.slice(slashIndex + 1));
  if (isNaN(numerator) || !denominator) return "";

  const score = Math.round((numerator / denominator) * 100);
  return String(Math.max(0, Math.min(100, score)));
}

// Sets the row's icon to match the fully-committed score. Only called on
// blur/Enter — the icon and FA/SA/D don't update while still typing.
function updateScoreIcon(input) {
  const icon = input.parentElement.querySelector(".letter-grade");
  if (!icon) return;
  icon.classList.remove("letter-grade--preview");

  if (input.value === "") {
    icon.src = TRANSPARENT_ICON;
    icon.alt = "";
    delete icon.dataset.slug;
    icon.classList.add("letter-grade--empty");
    return;
  }

  const score = parseFloat(input.value);
  if (isNaN(score)) return;

  const tier = letterGradeForScore(score);
  icon.src = gradeIconPath(tier.slug);
  icon.alt = tier.label;
  icon.dataset.slug = tier.slug;
  icon.classList.remove("letter-grade--empty");
}

// Live preview while a score is still being typed: once the typed value
// reaches 50, shows what tier it would become at half opacity — leading
// digits below that aren't reliably close to their final value yet.
function updateScorePreview(input) {
  const icon = input.parentElement.querySelector(".letter-grade");
  if (!icon) return;

  // A fraction's numerator alone (e.g. the "45" in "45/50") isn't a
  // meaningful preview of the score it'll resolve to on commit.
  const isFraction = input.value.includes("/");
  const typed = isFraction ? NaN : parseFloat(input.value);
  if (!isNaN(typed) && typed >= 50) {
    const tier = letterGradeForScore(Math.min(typed, 100));
    icon.src = gradeIconPath(tier.slug);
    icon.alt = tier.label;
    icon.dataset.slug = tier.slug;
    icon.classList.remove("letter-grade--empty");
    icon.classList.add("letter-grade--preview");
    return;
  }

  icon.classList.remove("letter-grade--preview");
  const committed = input.dataset.rawValue;
  if (!committed) {
    icon.src = TRANSPARENT_ICON;
    icon.alt = "";
    delete icon.dataset.slug;
    icon.classList.add("letter-grade--empty");
    return;
  }

  const score = parseFloat(committed);
  if (isNaN(score)) return;
  const tier = letterGradeForScore(score);
  icon.src = gradeIconPath(tier.slug);
  icon.alt = tier.label;
  icon.dataset.slug = tier.slug;
  icon.classList.remove("letter-grade--empty");
}

// Reads the entered (non-empty) scores out of one Formatives/Summatives/
// Final Exam box.
function getBoxScores(box) {
  const scores = [];
  box.querySelectorAll(".score-value").forEach((input) => {
    if (input.value === "") return;
    const value = parseFloat(input.value);
    if (!isNaN(value)) scores.push(value);
  });
  return scores;
}

function average(numbers) {
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function findAssessmentBox(card, label) {
  return Array.from(card.querySelectorAll(".assessment-box")).find(
    (box) => box.querySelector(".assessment-label").textContent.trim() === label
  );
}

function scoreRowIndex(input) {
  const list = input.closest(".score-list");
  return Array.from(list.querySelectorAll(".score-value")).indexOf(input);
}

// Formatives/Summatives start with EMPTY_SCORE_ROWS slots each; filling in
// the last row of either grows both by one more, keeping the two lists
// (which scroll together) the same length. Doesn't apply to Final Exam.
function growScoreListsIfLastRowFilled(card, input) {
  if (input.value === "") return;

  const box = input.closest(".assessment-box");
  const label = box.querySelector(".assessment-label").textContent.trim();
  if (label !== "Formatives" && label !== "Summatives") return;

  const rows = box.querySelectorAll(".score-value");
  if (rows[rows.length - 1] !== input) return;

  const formativesBox = findAssessmentBox(card, "Formatives");
  const summativesBox = findAssessmentBox(card, "Summatives");
  if (!formativesBox || !summativesBox) return;

  formativesBox.querySelector(".score-list").appendChild(createScoreRow());
  summativesBox.querySelector(".score-list").appendChild(createScoreRow());
}

// The reverse of growScoreListsIfLastRowFilled: trims back down to enough
// rows to cover the last filled one plus one empty row, or
// EMPTY_SCORE_ROWS, whichever is more. Both boxes trim to whichever needs
// to stay longer, so they stay the same length.
function shrinkScoreListsIfTrailingRowsEmpty(card, input) {
  if (input.value !== "") return;

  const box = input.closest(".assessment-box");
  const label = box.querySelector(".assessment-label").textContent.trim();
  if (label !== "Formatives" && label !== "Summatives") return;

  const formativesBox = findAssessmentBox(card, "Formatives");
  const summativesBox = findAssessmentBox(card, "Summatives");
  if (!formativesBox || !summativesBox) return;

  const desiredLength = (assessmentBox) => {
    const rows = Array.from(assessmentBox.querySelectorAll(".score-value"));
    let lastFilledIndex = -1;
    rows.forEach((row, index) => {
      if (row.value !== "") lastFilledIndex = index;
    });
    return Math.max(EMPTY_SCORE_ROWS, lastFilledIndex + 2);
  };

  const target = Math.max(desiredLength(formativesBox), desiredLength(summativesBox));

  [formativesBox, summativesBox].forEach((assessmentBox) => {
    const list = assessmentBox.querySelector(".score-list");
    while (list.querySelectorAll(".score-value").length > target) {
      list.lastElementChild.remove();
    }
  });
}

// Only the first row of a Formatives/Summatives box ever gets a "Type here"
// hint, and only while every score in that box is still empty. Final Exam
// isn't included — it's a single row with no ambiguity.
function updateEmptyBoxPlaceholder(box) {
  const label = box.querySelector(".assessment-label").textContent.trim();
  if (label !== "Formatives" && label !== "Summatives") return;

  const inputs = box.querySelectorAll(".score-value");
  const firstInput = inputs[0];
  if (!firstInput) return;

  const hint = firstInput.parentElement.querySelector(".score-type-hint");
  if (!hint) return;

  const allEmpty = Array.from(inputs).every((input) => input.value === "");
  hint.textContent = allEmpty ? "Type here" : "";
}

// A Summative score higher than its same-row Formative score replaces that
// Formative's effective score/icon — unless the row has been manually
// unlinked (see updateFormativeLinkButton), in which case it's shown but
// not applied. The original typed Formative value is kept in
// data-raw-value, so it's restored when the field is re-focused for
// editing, and the replacement reverts automatically if the Summative is
// later lowered or cleared. `animate` plays the reveal/unreveal transition
// for deselecting the Formative field and toggling the link button; every
// other case applies instantly.
// recalculate=false lets restoreCardScores apply every row's replacement
// first and recalculate once at the end, instead of once per qualifying
// row — each of those would otherwise nudge the FA/SA/D breakdown to an
// intermediate value, burning the "skip the first roll" check before the
// true final value ever gets computed, so it visibly rolls in every load.
function applyFormativeReplacement(card, formativeInput, summativeInput, animate = false, recalculate = true) {
  if (document.activeElement === formativeInput) return;

  const rawFormative = formativeInput.dataset.rawValue ?? formativeInput.value;
  const rawSummative = summativeInput.dataset.rawValue ?? summativeInput.value;
  const fNum = parseFloat(rawFormative);
  const sNum = parseFloat(rawSummative);

  // "Qualifies" is the raw math — decides whether the link icon shows at
  // all. "Applied" additionally requires the row not to have been
  // manually unlinked, and decides what actually displays.
  const qualifies = rawFormative !== "" && rawSummative !== "" && !isNaN(fNum) && !isNaN(sNum) && sNum > fNum;

  // The very first time this row qualifies, seed it from Settings >
  // Replace formatives by default, rather than always starting linked.
  if (qualifies && formativeInput.dataset.unlinked === undefined && !window.getPreferences().replaceFormativesByDefault) {
    formativeInput.dataset.unlinked = "true";
  }

  const applied = qualifies && formativeInput.dataset.unlinked !== "true";
  const effective = applied ? rawSummative : rawFormative;

  const originalSpan = formativeInput.nextElementSibling;
  const hasOriginalSpan = originalSpan && originalSpan.classList.contains("score-original");
  const needsChange = formativeInput.value !== effective;

  if (animate && needsChange && hasOriginalSpan) {
    if (applied) {
      // Sets formativeInput.value synchronously — only the visuals are
      // still catching up.
      animateFormativeUnreveal(formativeInput, originalSpan, rawFormative, effective);
      updateScoreIcon(formativeInput);
      if (recalculate) recalculateCard(card);
    } else {
      // Snapshot what's on screen right now — animateFormativeReveal fades
      // this out, not whatever formativeInput.value is about to become, so
      // the number doesn't visibly jump to its new value before it fades.
      const oldEffective = formativeInput.value;
      // Same — the icon/recalculation reflect it as the animation starts,
      // not once it finishes.
      formativeInput.value = effective;
      formativeInput.dataset.lastValid = effective;
      updateScoreIcon(formativeInput);
      if (recalculate) recalculateCard(card);
      animateFormativeReveal(formativeInput, originalSpan, oldEffective, () => {
        originalSpan.textContent = "";
      });
    }
  } else {
    if (needsChange) {
      formativeInput.value = effective;
      updateScoreIcon(formativeInput);
      if (recalculate) recalculateCard(card);
    }

    if (hasOriginalSpan) {
      originalSpan.textContent = applied ? rawFormative : "";
    }
  }

  updateFormativeLinkButton(card, formativeInput, summativeInput, qualifies, applied);
}

// Re-applies the replacement rule for the row a just-committed score
// belongs to. Called on blur for both Formatives and Summatives inputs —
// only animated when it's the Formative field itself that was deselected.
function syncFormativeReplacementForRow(card, changedInput) {
  const box = changedInput.closest(".assessment-box");
  const label = box.querySelector(".assessment-label").textContent.trim();
  if (label !== "Formatives" && label !== "Summatives") return;

  const formativesBox = findAssessmentBox(card, "Formatives");
  const summativesBox = findAssessmentBox(card, "Summatives");
  if (!formativesBox || !summativesBox) return;

  const rowIndex = scoreRowIndex(changedInput);
  const formativeInput = formativesBox.querySelectorAll(".score-value")[rowIndex];
  const summativeInput = summativesBox.querySelectorAll(".score-value")[rowIndex];
  if (!formativeInput || !summativeInput) return;

  // Clearing either side invalidates the tracked link state — reset so the
  // row starts fresh (re-seeded from preferences) next time it qualifies.
  if (changedInput.value === "") {
    delete formativeInput.dataset.unlinked;
  }

  applyFormativeReplacement(card, formativeInput, summativeInput, label === "Formatives");
}

// Shows an icon between the two boxes, vertically aligned with a row that
// qualifies for replacement. unlink.png while applied (click to break the
// link); link.png while manually broken (click to re-apply). Positioned
// via JS and appended to .assessment-groups rather than nested in the
// scrolling .score-list, so it isn't clipped by the list's own overflow.
function updateFormativeLinkButton(card, formativeInput, summativeInput, qualifies, applied) {
  let btn = formativeInput._linkBtn;

  if (!qualifies) {
    if (btn) btn.remove();
    formativeInput._linkBtn = null;
    return;
  }

  const groups = card.querySelector(".assessment-groups");

  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "formative-link-btn";

    const icon = document.createElement("img");
    icon.className = "formative-link-icon";
    icon.alt = "";
    btn.appendChild(icon);

    // mousedown + preventDefault stops the browser from blurring whatever's
    // focused, so clicking never races the blur-triggered recalculation.
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      formativeInput.dataset.unlinked = formativeInput.dataset.unlinked === "true" ? "" : "true";
      applyFormativeReplacement(card, formativeInput, summativeInput, true);

      // recalculateCard's roll animation can slightly reflow this card
      // while it plays — track the row's position for that whole window
      // instead of once at click time, so the button doesn't visibly snap.
      const trackUntil = performance.now() + ROLL_DURATION_MS + 100;
      const track = () => {
        const liveBtn = formativeInput._linkBtn;
        if (liveBtn) positionFormativeLinkButton(groups, formativeInput, liveBtn);
        if (performance.now() < trackUntil) requestAnimationFrame(track);
      };
      requestAnimationFrame(track);
    });

    // The button lives outside its row's <li>, so plain CSS :hover on the
    // row can't react to it — toggle a class on the row instead.
    btn.addEventListener("mouseenter", () => {
      formativeInput.closest("li").classList.add("force-original");
    });
    btn.addEventListener("mouseleave", () => {
      formativeInput.closest("li").classList.remove("force-original");
    });

    groups.appendChild(btn);
    formativeInput._linkBtn = btn;
    btn._formativeInput = formativeInput;
  }

  btn.querySelector(".formative-link-icon").src = applied ? uiIconPath("unlink.png") : uiIconPath("link.png");
  positionFormativeLinkButton(groups, formativeInput, btn);
}

// Vertically aligns a link/unlink button with its Formative row's current
// on-screen position, and hides it while that row is scrolled out of view.
function positionFormativeLinkButton(groups, formativeInput, btn) {
  const list = formativeInput.closest(".score-list");
  const row = formativeInput.closest("li");
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const groupsRect = groups.getBoundingClientRect();

  const visible = rowRect.bottom > listRect.top && rowRect.top < listRect.bottom;
  btn.style.display = visible ? "flex" : "none";
  if (!visible) return;

  btn.style.top = `${rowRect.top + rowRect.height / 2 - groupsRect.top}px`;
}

function repositionFormativeLinkButtons(card) {
  const groups = card.querySelector(".assessment-groups");
  groups.querySelectorAll(".formative-link-btn").forEach((btn) => {
    positionFormativeLinkButton(groups, btn._formativeInput, btn);
  });
}

// Pulls the numeric weight out of a percent label like "20%" — null if
// unset (e.g. "-"), which excludes that box from the domain calculation.
function parsePercent(text) {
  const match = /\d+(\.\d+)?/.exec(text);
  return match ? parseFloat(match[0]) : null;
}

// "instant" before the card has settled (its very first render, restoring
// saved scores on page load) so nothing animates in on refresh; "blur"
// once settled, for a score that turns from blank to real live.
function firstRevealStyle(card) {
  return card.dataset.settled === "true" ? "blur" : "instant";
}

function setBreakdownValue(card, index, value) {
  const span = card.querySelectorAll(".breakdown-value")[index];
  if (!span) return;
  animateNumberChange(span, value === null ? "-" : truncateToTwoDecimals(value), firstRevealStyle(card));
}

// Pending crossfade-completion timeouts, keyed by fade layer — cleared on
// every new crossfade so a rapid run of tier changes can't have an older
// one's delayed cleanup stomp a newer tier back onto the base badge after
// the fact (same stale-timeout hazard as animateNumberChange's own).
const badgeFadeTimeouts = new WeakMap();

const DOMAIN_BADGE_FADE_MS = 200;

// Crossfades the big domain badge from its current tier to a new one. A
// plain <img src> swap has nothing to interpolate between, so instead the
// new icon is loaded into the absolutely-positioned fade layer stacked on
// top (see .letter-grade-lg-fade) and its opacity is what actually
// transitions in; the base layer only catches up once that's finished,
// then the fade layer resets to invisible ready for next time.
function crossfadeBadgeIcon(wrap, badge, tier) {
  const fadeLayer = wrap.querySelector(".letter-grade-lg-fade");
  if (!fadeLayer) {
    badge.src = gradeIconPath(tier.slug);
    badge.alt = tier.label;
    badge.dataset.slug = tier.slug;
    return;
  }

  clearTimeout(badgeFadeTimeouts.get(fadeLayer));

  if (!window.animationsEnabled()) {
    badge.src = gradeIconPath(tier.slug);
    badge.alt = tier.label;
    badge.dataset.slug = tier.slug;
    fadeLayer.style.opacity = "";
    badgeFadeTimeouts.delete(fadeLayer);
    return;
  }

  // Set while still invisible (opacity: 0 is the fade layer's resting
  // state) so the new icon never flashes in before the transition below.
  fadeLayer.src = gradeIconPath(tier.slug);
  fadeLayer.alt = tier.label;
  fadeLayer.style.opacity = "1";

  badgeFadeTimeouts.set(
    fadeLayer,
    setTimeout(() => {
      badge.src = gradeIconPath(tier.slug);
      badge.alt = tier.label;
      badge.dataset.slug = tier.slug;
      fadeLayer.style.opacity = "";
      badgeFadeTimeouts.delete(fadeLayer);
    }, DOMAIN_BADGE_FADE_MS)
  );
}

function updateDomainBadge(card, domain) {
  const summary = card.querySelector(".grade-summary");
  const gradeValueEl = summary.querySelector(".grade-value");
  let wrap = summary.querySelector(".letter-grade-lg-wrap");
  let badge = wrap ? wrap.querySelector(".letter-grade--lg:not(.letter-grade-lg-fade)") : null;

  if (domain === null) {
    if (wrap) wrap.remove();
    // Goes through animateNumberChange (not a direct textContent set) so
    // its roll-memory (dataset.rollValue) actually updates to "-" — set
    // directly, the next real score would roll from whatever the last
    // valid score was instead of growing in fresh, since that's the last
    // value the animation would remember.
    animateNumberChange(gradeValueEl, "-", firstRevealStyle(card));
    return;
  }

  const rounded = Math.round(domain);
  const tier = letterGradeForScore(rounded);

  if (!wrap) {
    wrap = document.createElement("span");
    wrap.className = "letter-grade-lg-wrap";

    badge = document.createElement("img");
    badge.className = "letter-grade letter-grade--lg";

    const fadeLayer = document.createElement("img");
    fadeLayer.className = "letter-grade letter-grade--lg letter-grade-lg-fade";
    fadeLayer.alt = "";
    fadeLayer.setAttribute("aria-hidden", "true");

    wrap.append(badge, fadeLayer);
    summary.insertBefore(wrap, gradeValueEl);

    // First-ever appearance, not a tier change — no fade, same as before.
    badge.src = gradeIconPath(tier.slug);
    badge.alt = tier.label;
    badge.dataset.slug = tier.slug;
  } else if (badge.dataset.slug !== tier.slug) {
    crossfadeBadgeIcon(wrap, badge, tier);
  }

  animateNumberChange(gradeValueEl, String(rounded), firstRevealStyle(card));
}

// Recomputes FA, SA, D, and the big grade badge for one class card. Each
// assessment box contributes using its own base weight (e.g. 20%); boxes
// with no scores entered are excluded from that weighted average.
function recalculateCard(card) {
  let weightedSum = 0;
  let weightTotal = 0;
  let faAverage = null;
  let saAverage = null;

  card.querySelectorAll(".assessment-box").forEach((box) => {
    const label = box.querySelector(".assessment-label").textContent.trim();
    const avg = average(getBoxScores(box));

    if (label === "Formatives") faAverage = avg;
    if (label === "Summatives") saAverage = avg;
    if (avg === null) return;

    const weight = parseFloat(box.dataset.baseWeight);
    if (isNaN(weight)) return;

    weightedSum += avg * weight;
    weightTotal += weight;
  });

  const domain = weightTotal > 0 ? weightedSum / weightTotal : null;

  setBreakdownValue(card, 0, faAverage);
  setBreakdownValue(card, 1, saAverage);
  setBreakdownValue(card, 2, domain);
  updateDomainBadge(card, domain);
  saveDomainSnapshot();
  persistCardScores(card);
}

// Persists each Domain class's name + current letter grade so the GPA page
// can pull them in via "Paste from Domain Tab". A no-op on any other page.
function saveDomainSnapshot() {
  const container = document.querySelector('.classes-container[data-dynamic="true"]');
  if (!container) return;

  const snapshot = Array.from(container.querySelectorAll(".class-card")).map((card) => {
    const badge = card.querySelector(".letter-grade--lg:not(.letter-grade-lg-fade)");
    return {
      name: card.querySelector(".class-name").textContent,
      slug: badge ? badge.dataset.slug || null : null,
      label: badge ? badge.alt : null,
    };
  });
  appData.domainSnapshot = snapshot;
  pushDataToCloud();
}

// Every class card's actual entered scores, keyed by class name, so a page
// reload can rebuild the same score lists instead of starting empty.
function loadDomainScores() {
  return appData.domainScores;
}

function saveDomainScores(scores) {
  appData.domainScores = scores;
  pushDataToCloud();
}

function serializeCardScores(card) {
  const name = card.querySelector(".class-name").textContent;
  const formativesBox = findAssessmentBox(card, "Formatives");
  const summativesBox = findAssessmentBox(card, "Summatives");
  const finalBox = findAssessmentBox(card, "Final Exam");

  // Stored as actual numbers (null for empty), not strings — dataset.
  // rawValue/input.value are strings only because that's what the DOM
  // hands back.
  const values = (box) =>
    box
      ? Array.from(box.querySelectorAll(".score-value")).map((input) => {
          const raw = input.dataset.rawValue ?? input.value;
          return raw === "" ? null : Number(raw);
        })
      : [];

  const formativeInputs = formativesBox ? Array.from(formativesBox.querySelectorAll(".score-value")) : [];
  const summativeInputs = summativesBox ? Array.from(summativesBox.querySelectorAll(".score-value")) : [];

  // Every score row gets the same date-picker UI, so both boxes need
  // their own saved array here.
  const datesFor = (inputs) =>
    inputs.map((input) => {
      const label = input.parentElement.querySelector(".score-date-label");
      return (label && label.dataset.isoDate) || "";
    });

  const unlinkedRows = [];
  formativeInputs.forEach((input, index) => {
    if (input.dataset.unlinked === "true") unlinkedRows.push(index);
  });

  return {
    name,
    formative: values(formativesBox),
    summative: values(summativesBox),
    final: values(finalBox),
    formativeDates: datesFor(formativeInputs),
    summativeDates: datesFor(summativeInputs),
    unlinkedRows,
  };
}

function persistCardScores(card) {
  const data = serializeCardScores(card);
  const all = loadDomainScores();
  all[data.name] = data;
  saveDomainScores(all);
}

// Rebuilds a class card's score lists from whatever was last saved for a
// class with this name, restoring each Formative's date and manual unlink
// state before re-running the replacement logic.
function restoreCardScores(card, name) {
  const saved = loadDomainScores()[name];
  if (!saved) return;

  const formativesBox = findAssessmentBox(card, "Formatives");
  const summativesBox = findAssessmentBox(card, "Summatives");
  const finalBox = findAssessmentBox(card, "Final Exam");

  if (formativesBox && summativesBox) {
    const list1 = formativesBox.querySelector(".score-list");
    const list2 = summativesBox.querySelector(".score-list");
    const needed = Math.max(
      list1.querySelectorAll(".score-value").length,
      list2.querySelectorAll(".score-value").length,
      (saved.formative || []).length,
      (saved.summative || []).length
    );
    while (list1.querySelectorAll(".score-value").length < needed) list1.appendChild(createScoreRow());
    while (list2.querySelectorAll(".score-value").length < needed) list2.appendChild(createScoreRow());
  }

  const restoreBoxRows = (box, savedValues) => {
    if (!box || !savedValues) return;
    const inputs = box.querySelectorAll(".score-value");
    savedValues.forEach((value, index) => {
      const input = inputs[index];
      // Not a plain falsy check — a genuine score of 0 is falsy too and
      // shouldn't be treated as "unfilled".
      if (!input || value === null || value === undefined) return;
      const text = String(value);
      input.value = text;
      input.dataset.rawValue = text;
      input.dataset.lastValid = text;
      updateScoreIcon(input);
    });
  };

  restoreBoxRows(formativesBox, saved.formative);
  restoreBoxRows(summativesBox, saved.summative);
  restoreBoxRows(finalBox, saved.final);

  if (formativesBox && summativesBox) {
    const formativeInputs = formativesBox.querySelectorAll(".score-value");
    const summativeInputs = summativesBox.querySelectorAll(".score-value");

    const restoreDates = (inputs, savedDates) => {
      (savedDates || []).forEach((isoDate, index) => {
        const input = inputs[index];
        const label = input && input.parentElement.querySelector(".score-date-label");
        if (label && isoDate) {
          label.dataset.isoDate = isoDate;
          label.textContent = formatAssessmentDate(fromISODate(isoDate));
        }
      });
    };

    restoreDates(formativeInputs, saved.formativeDates);
    restoreDates(summativeInputs, saved.summativeDates);

    // Explicitly marks every restored row "true"/"false" — undefined is
    // reserved for a row never actually evaluated yet.
    const unlinkedSet = new Set(saved.unlinkedRows || []);
    formativeInputs.forEach((input, index) => {
      input.dataset.unlinked = unlinkedSet.has(index) ? "true" : "false";
    });

    formativeInputs.forEach((formativeInput, index) => {
      if (summativeInputs[index]) applyFormativeReplacement(card, formativeInput, summativeInputs[index], false, false);
    });
  }

  [formativesBox, summativesBox].forEach((box) => {
    if (box) updateEmptyBoxPlaceholder(box);
  });

  recalculateCard(card);
}

// While typing, sanitizes the raw value (range/decimal/leading-zero rules)
// and updates the live 50%-opacity preview (see updateScorePreview) — FA/
// SA/D and the fully-committed icon still stay untouched until the field
// is deselected (blur/Enter), see below.
document.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.classList.contains("score-value")) return;

  const sanitized = sanitizeScoreInput(input.value);
  // A fraction's own range (e.g. "150/200" is a valid, in-range 75) isn't
  // knowable until it's complete — that check happens on commit instead
  // (see commitFractionInput), not here against the bare numerator.
  const isFraction = sanitized.includes("/");
  const numeric = parseFloat(sanitized);
  const isOverMax = !isFraction && sanitized !== "" && sanitized !== "." && !isNaN(numeric) && numeric > 100;
  // Reject a leading zero only when it's followed by another digit (e.g.
  // "05"), not a plain "0", the start of a decimal like "0.5", or "0/...".
  const hasInvalidLeadingZero =
    !isFraction && sanitized.length > 1 && sanitized[0] === "0" && sanitized[1] !== ".";

  if (isOverMax || hasInvalidLeadingZero) {
    // Reject the keystroke entirely instead of correcting it after the fact.
    input.value = input.dataset.lastValid !== undefined ? input.dataset.lastValid : input.defaultValue;
  } else {
    input.value = sanitized;
    input.dataset.lastValid = sanitized;
  }

  updateScorePreview(input);
});

// Deselecting the field (clicking away, or Enter — see the keydown handler
// below) is the only thing that commits the score: updates its icon and
// recalculates the card's FA/SA/D.
document.addEventListener(
  "blur",
  (event) => {
    if (!event.target.classList.contains("score-value")) return;
    // A typed fraction (e.g. "45/50") only ever exists mid-edit — commit
    // resolves it to the whole-number score it stands for.
    event.target.value = commitFractionInput(event.target.value);
    if (event.target.value.endsWith(".")) {
      event.target.value = event.target.value.slice(0, -1);
    }
    event.target.dataset.rawValue = event.target.value;

    // A deleted score has no assessment date anymore.
    if (event.target.value === "") {
      const dateLabel = event.target.parentElement.querySelector(".score-date-label");
      if (dateLabel) {
        dateLabel.textContent = "";
        delete dateLabel.dataset.isoDate;
      }
    }

    const card = event.target.closest(".class-card");
    if (card) syncFormativeReplacementForRow(card, event.target);

    updateScoreIcon(event.target);
    // Before recalculateCard (which persists the card) — shrinking after
    // would save the pre-trim row count and recreate them on next load.
    if (card) shrinkScoreListsIfTrailingRowsEmpty(card, event.target);
    if (card) recalculateCard(card);
    if (card) growScoreListsIfLastRowFilled(card, event.target);

    const box = event.target.closest(".assessment-box");
    if (box) updateEmptyBoxPlaceholder(box);
  },
  true
);

const FORMATIVE_REVEAL_MS = 280;
const FORMATIVE_DATE_ICON_FADE_MS = 120;

// The big (replaced) number slides out to the left and fades, while the
// small gray original-score number scales up and moves to where the big
// number used to sit — a FLIP-style transform animation between two
// otherwise unrelated elements.
function animateFormativeReveal(input, originalSpan, oldText, onDone) {
  if (!window.animationsEnabled()) {
    onDone();
    return;
  }

  // The caller already committed input.value to its new (post-replacement)
  // number before this runs — captured here so it can be restored once the
  // fade-out below is done, after oldText below takes its place meanwhile.
  const newText = input.value;

  // Marks the row so its score-original stays visible for the whole
  // animation, even if a date is set or the cursor leaves the link/unlink
  // button mid-animation. Cleared once the animation completes.
  const row = originalSpan.closest("li");
  if (row) row.classList.add("swap-animating");

  const inputRect = input.getBoundingClientRect();
  const spanRect = originalSpan.getBoundingClientRect();

  // Left-edge to left-edge, not center to center — paired with
  // transform-origin: left center in CSS, so the small number travels
  // (and grows) all the way to where the big number's digits start.
  const dx = inputRect.left - spanRect.left;
  const dy = inputRect.top + inputRect.height / 2 - (spanRect.top + spanRect.height / 2);
  const inputFontSize = parseFloat(getComputedStyle(input).fontSize);
  const spanFontSize = parseFloat(getComputedStyle(originalSpan).fontSize);
  const scale = inputFontSize / spanFontSize;

  // Text isn't itself animatable, so what fades out has to actually still
  // read as the old number the whole time — restored to newText only once
  // it's invisible again below, mirroring animateFormativeUnreveal's own
  // hidden-value swap in the other direction.
  input.style.transition = "none";
  input.value = oldText;
  input.style.transform = "translateX(0)";
  input.style.opacity = "1";

  originalSpan.style.transition = "none";
  originalSpan.style.transform = "translateY(-50%)";
  originalSpan.style.color = "";

  // The date button overlaps where the small number is about to grow
  // into, so it fades out fast and stays hidden until the animation lands.
  const dateBtn = input.parentElement.querySelector(".score-date-btn");
  const hasDateBtn = Boolean(dateBtn);
  if (hasDateBtn) {
    dateBtn.style.transition = `opacity ${FORMATIVE_DATE_ICON_FADE_MS}ms ease`;
    dateBtn.style.opacity = "0";
  }

  void input.offsetWidth; // force reflow so the "none" transition above takes effect first

  input.style.transition = `transform ${FORMATIVE_REVEAL_MS}ms ease, opacity ${FORMATIVE_REVEAL_MS}ms ease`;
  input.style.transform = "translateX(-24px)";
  input.style.opacity = "0";

  originalSpan.style.transition = `transform ${FORMATIVE_REVEAL_MS}ms ease, color ${FORMATIVE_REVEAL_MS}ms ease`;
  originalSpan.style.transform = `translateY(-50%) translate(${dx}px, ${dy}px) scale(${scale})`;
  originalSpan.style.color = "var(--color-text-primary)";

  // A little longer than the transition itself, since a CSS transition
  // only starts counting on the next paint.
  setTimeout(() => {
    input.value = newText; // swapped back while still faded out, so this never flashes into view
    input.style.transition = "";
    input.style.transform = "";
    input.style.opacity = "";
    originalSpan.style.transition = "";
    originalSpan.style.transform = "";
    originalSpan.style.color = "";
    if (hasDateBtn) {
      dateBtn.style.transition = "";
      dateBtn.style.opacity = "";
    }
    if (row) row.classList.remove("swap-animating");
    onDone();
  }, FORMATIVE_REVEAL_MS + 60);
}

// The reverse of animateFormativeReveal, played on deselecting a Formative
// field whose newly-typed score still qualifies for replacement: the raw
// number shrinks and grays down into the small original-score spot, while
// the new (replaced) big number fades in from the left.
function animateFormativeUnreveal(input, originalSpan, rawText, effectiveText) {
  if (!window.animationsEnabled()) {
    originalSpan.textContent = rawText;
    input.value = effectiveText;
    return;
  }

  const row = originalSpan.closest("li");
  if (row) row.classList.add("swap-animating");

  originalSpan.textContent = rawText;

  const inputRect = input.getBoundingClientRect();
  const spanRect = originalSpan.getBoundingClientRect();
  const dx = inputRect.left - spanRect.left;
  const dy = inputRect.top + inputRect.height / 2 - (spanRect.top + spanRect.height / 2);
  const inputFontSize = parseFloat(getComputedStyle(input).fontSize);
  const spanFontSize = parseFloat(getComputedStyle(originalSpan).fontSize);
  const scale = inputFontSize / spanFontSize;

  // Start state (instant) mirrors the end state of animateFormativeReveal.
  input.style.transition = "none";
  input.value = effectiveText;
  input.style.transform = "translateX(-24px)";
  input.style.opacity = "0";

  originalSpan.style.transition = "none";
  originalSpan.style.transform = `translateY(-50%) translate(${dx}px, ${dy}px) scale(${scale})`;
  originalSpan.style.color = "var(--color-text-primary)";

  void input.offsetWidth; // force reflow so the "none" transitions above take effect first

  input.style.transition = `transform ${FORMATIVE_REVEAL_MS}ms ease, opacity ${FORMATIVE_REVEAL_MS}ms ease`;
  input.style.transform = "translateX(0)";
  input.style.opacity = "1";

  originalSpan.style.transition = `transform ${FORMATIVE_REVEAL_MS}ms ease, color ${FORMATIVE_REVEAL_MS}ms ease`;
  originalSpan.style.transform = "translateY(-50%)";
  originalSpan.style.color = "";

  setTimeout(() => {
    input.style.transition = "";
    input.style.transform = "";
    input.style.opacity = "";
    originalSpan.style.transition = "";
    originalSpan.style.transform = "";
    originalSpan.style.color = "";
    if (row) row.classList.remove("swap-animating");
  }, FORMATIVE_REVEAL_MS + 60);
}

// Tracks whether the mousedown about to trigger a score-value's focus
// landed on its letter-grade icon rather than the text itself (label-wrapped
// icon clicks focus the input too). Set on mousedown, which — per the label
// activation spec — always fires before the click-driven focus it precedes.
let scoreFocusViaIcon = null;

document.addEventListener(
  "mousedown",
  (event) => {
    if (!event.target.classList.contains("letter-grade")) return;
    const label = event.target.closest(".score-list li label");
    scoreFocusViaIcon = label ? label.querySelector(".score-value") : null;
  },
  true
);

// Editing a Formative field should start from what was actually typed,
// not a Summative-replaced display value. Clicking the icon selects the
// whole value; clicking the text just places the cursor at the end.
document.addEventListener(
  "focus",
  (event) => {
    if (!event.target.classList.contains("score-value")) return;

    const input = event.target;
    const viaIcon = scoreFocusViaIcon === input;
    scoreFocusViaIcon = null;

    const placeCaret = () => {
      if (viaIcon) {
        input.select();
      } else {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    };

    const raw = input.dataset.rawValue;
    if (raw === undefined || input.value === raw) {
      if (viaIcon) input.select();
      return;
    }

    const originalSpan = input.nextElementSibling;
    const hasOriginalSpan = originalSpan && originalSpan.classList.contains("score-original");

    const finish = () => {
      input.value = raw;
      input.dataset.lastValid = raw;
      if (hasOriginalSpan) originalSpan.textContent = "";
      placeCaret();
    };

    if (hasOriginalSpan) {
      // input.value hasn't been touched yet here — still the value that's
      // meant to fade away, so it doubles as its own oldText.
      animateFormativeReveal(input, originalSpan, input.value, finish);
    } else {
      finish();
    }
  },
  true
);

// Tab moves straight to the next row's score in the same box. Without
// this, native Tab order would land on this row's own date button next,
// not the next score.
function moveToNextScoreCell(input) {
  const list = input.closest(".score-list");
  const inputs = Array.from(list.querySelectorAll(".score-value"));
  const next = inputs[inputs.indexOf(input) + 1];
  if (!next) return false;
  next.focus();
  next.select();
  return true;
}

document.addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("score-value")) return;

  // Pressing Enter or Escape deselects the field, which triggers the blur
  // handler above to finalize the icon/FA/SA/D update for whatever was
  // fully typed.
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    event.target.blur();
    return;
  }

  // Only intercepted when there's actually a next row in this box — on the
  // last row, Shift+Tab included, native Tab order is left alone.
  if (event.key === "Tab" && !event.shiftKey) {
    if (moveToNextScoreCell(event.target)) event.preventDefault();
  }
});

function createScoreRow() {
  const li = document.createElement("li");
  const label = document.createElement("label");

  const icon = document.createElement("img");
  icon.className = "letter-grade letter-grade--empty";
  icon.src = TRANSPARENT_ICON;
  icon.alt = "";

  const input = document.createElement("input");
  input.className = "score-value";
  input.type = "text";
  input.inputMode = "decimal";

  // A separate, non-interactive hint (not a real placeholder) so it can
  // sit further left without moving where the input's caret starts.
  const typeHint = document.createElement("span");
  typeHint.className = "score-type-hint";

  // Only ever populated for a Formative row whose score has been replaced
  // by a higher same-row Summative — shows the original typed score.
  const original = document.createElement("span");
  original.className = "score-original";

  // Set once a day is picked in the calendar popup below — the assessment
  // date, e.g. "Aug 10". Empty (and hidden) until then.
  const dateLabel = document.createElement("span");
  dateLabel.className = "score-date-label";

  // Hover-only hint button, shown for a filled score — opens the small
  // calendar popup (see openScoreDateCalendarFor below).
  const dateBtn = document.createElement("button");
  dateBtn.type = "button";
  dateBtn.className = "score-date-btn";
  dateBtn.setAttribute("aria-label", "Show date");

  const dateIcon = document.createElement("img");
  dateIcon.className = "score-date-icon";
  dateIcon.src = uiIconPath("date.png");
  dateIcon.alt = "";
  dateBtn.appendChild(dateIcon);

  // mousedown + preventDefault stops the browser from blurring a
  // currently-focused score-value input, which would otherwise trigger
  // the Formative-unreveal animation and swallow this click.
  dateBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleScoreDateCalendar(dateBtn, dateLabel);
  });

  label.appendChild(icon);
  label.appendChild(typeHint);
  label.appendChild(input);
  label.appendChild(original);
  label.appendChild(dateLabel);
  label.appendChild(dateBtn);
  li.appendChild(label);
  return li;
}

// --- Score date calendar popup ---
// Opened from a row's date button (see createScoreRow above). Only lets you
// navigate within the current school year: August through the following
// July. Rendered into document.body (not nested in .score-list) so it isn't
// clipped by the list's own scroll area.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const SCHOOL_YEAR_START_MONTH = 7; // August, 0-based
const SCHOOL_YEAR_END_MONTH = 6; // July, 0-based

// Formatted per the user's Settings > Date format preference — see
// formatPreferredDate in preferences.js.
function formatAssessmentDate(date) {
  return window.formatPreferredDate(date);
}

// What's actually saved/restored is always this plain YYYY-MM-DD; display
// formatting happens at render time so it can follow the current date
// format preference. Built from local getFullYear/getMonth/getDate, not
// toISOString (UTC), which can land on a different calendar day.
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

// The most recent August through the following July, relative to today.
function schoolYearBounds(today = new Date()) {
  const year = today.getFullYear();
  const startYear = today.getMonth() >= SCHOOL_YEAR_START_MONTH ? year : year - 1;
  return {
    start: new Date(startYear, SCHOOL_YEAR_START_MONTH, 1),
    end: new Date(startYear + 1, SCHOOL_YEAR_END_MONTH, 1),
  };
}

let openScoreDateCalendar = null; // { button, dateLabel, panel }

function closeScoreDateCalendar() {
  if (!openScoreDateCalendar) return;
  const { button, panel } = openScoreDateCalendar;
  button.classList.remove("score-date-btn--active");
  openScoreDateCalendar = null;

  if (!window.animationsEnabled()) {
    panel.remove();
    return;
  }
  // Reverses the entrance transition (see openScoreDateCalendarFor) —
  // shrinks back into the same corner it grew from, whether closed by
  // picking a date, hitting Remove, clicking outside, or switching to a
  // different row's panel (toggleScoreDateCalendar calls this before
  // opening the new one, so the two briefly animate past each other).
  panel.classList.remove("score-date-calendar--visible");
  setTimeout(() => panel.remove(), 180);
}

function renderScoreDateCalendar(panel, displayedMonth, bounds, dateLabel) {
  panel.innerHTML = "";

  // Only offer to remove a date that's actually set.
  if (dateLabel.textContent !== "") {
    const clearRow = document.createElement("div");
    clearRow.className = "score-date-calendar-clear-row";

    const clearLabel = document.createElement("span");
    clearLabel.className = "score-date-calendar-clear-label";
    clearLabel.textContent = `Taken on ${dateLabel.textContent}`;

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "score-date-calendar-clear-btn";
    clearBtn.textContent = "Remove";
    clearBtn.setAttribute("aria-label", "Remove date");
    clearBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      dateLabel.textContent = "";
      delete dateLabel.dataset.isoDate;
      const card = dateLabel.closest(".class-card");
      if (card) persistCardScores(card);
      closeScoreDateCalendar();
    });

    clearRow.appendChild(clearLabel);
    clearRow.appendChild(clearBtn);
    panel.appendChild(clearRow);
  }

  const header = document.createElement("div");
  header.className = "score-date-calendar-header";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "score-date-nav-btn";
  prevBtn.textContent = "‹";
  prevBtn.setAttribute("aria-label", "Previous month");

  const label = document.createElement("span");
  label.className = "score-date-calendar-label";
  label.textContent = `${MONTH_NAMES[displayedMonth.getMonth()]} ${displayedMonth.getFullYear()}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "score-date-nav-btn";
  nextBtn.textContent = "›";
  nextBtn.setAttribute("aria-label", "Next month");

  const atStart =
    displayedMonth.getFullYear() === bounds.start.getFullYear() && displayedMonth.getMonth() === bounds.start.getMonth();
  const atEnd =
    displayedMonth.getFullYear() === bounds.end.getFullYear() && displayedMonth.getMonth() === bounds.end.getMonth();
  prevBtn.disabled = atStart;
  nextBtn.disabled = atEnd;

  // stopPropagation matters — rebuilding the panel below detaches this
  // button mid-click, so without it the bubbling click reaches the
  // document-level outside-click listener and closes the popup right
  // after it's rebuilt.
  prevBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (atStart) return;
    renderScoreDateCalendar(panel, new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() - 1, 1), bounds, dateLabel);
  });
  nextBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (atEnd) return;
    renderScoreDateCalendar(panel, new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 1), bounds, dateLabel);
  });

  header.append(prevBtn, label, nextBtn);
  panel.appendChild(header);

  const weekdayRow = document.createElement("div");
  weekdayRow.className = "score-date-grid score-date-weekday-row";
  WEEKDAY_LABELS.forEach((day) => {
    const cell = document.createElement("span");
    cell.className = "score-date-weekday";
    cell.textContent = day;
    weekdayRow.appendChild(cell);
  });
  panel.appendChild(weekdayRow);

  const grid = document.createElement("div");
  grid.className = "score-date-grid";

  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  for (let i = 0; i < firstWeekday; i++) {
    const filler = document.createElement("span");
    filler.className = "score-date-day score-date-day--outside";
    grid.appendChild(filler);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dayBtn = document.createElement("button");
    dayBtn.type = "button";
    dayBtn.className = "score-date-day";
    dayBtn.textContent = String(day);
    if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) {
      dayBtn.classList.add("score-date-day--today");
    }
    dayBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      grid
        .querySelectorAll(".score-date-day--selected")
        .forEach((el) => el.classList.remove("score-date-day--selected"));
      dayBtn.classList.add("score-date-day--selected");
      const picked = new Date(year, month, day);
      dateLabel.dataset.isoDate = toISODate(picked);
      dateLabel.textContent = formatAssessmentDate(picked);
      const card = dateLabel.closest(".class-card");
      if (card) persistCardScores(card);
      closeScoreDateCalendar();
    });
    grid.appendChild(dayBtn);
  }

  panel.appendChild(grid);
}

function openScoreDateCalendarFor(button, dateLabel) {
  const panel = document.createElement("div");
  panel.className = "score-date-calendar";
  document.body.appendChild(panel);

  const bounds = schoolYearBounds();
  const today = new Date();
  const initialMonth =
    today >= bounds.start && today < bounds.end ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(bounds.start);
  renderScoreDateCalendar(panel, initialMonth, bounds, dateLabel);

  const rect = button.getBoundingClientRect();
  const panelLeft = Math.min(rect.left, window.innerWidth - 260);
  panel.style.position = "fixed";
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.left = `${panelLeft}px`;

  // Scales in from whichever corner sits closest to the button that opened
  // it. Vertically that's always the top edge — the panel always opens
  // just below the button — but horizontally it isn't always the panel's
  // own left edge: panelLeft's own clamp (kicking in near the screen's
  // right edge) can shove the panel left of where the button actually
  // sits, putting the button closer to the panel's right side instead.
  const panelWidth = panel.getBoundingClientRect().width;
  const buttonCenterX = rect.left + rect.width / 2 - panelLeft;
  const originXPercent = Math.max(0, Math.min(100, (buttonCenterX / panelWidth) * 100));
  panel.style.transformOrigin = `${originXPercent}% 0%`;

  const animate = window.animationsEnabled();
  if (!animate) panel.classList.add("score-date-calendar--instant");
  void panel.offsetWidth; // force reflow so the entrance transition below actually plays
  panel.classList.add("score-date-calendar--visible");
  if (!animate) {
    void panel.offsetWidth; // commit the instant state before re-enabling the transition
    panel.classList.remove("score-date-calendar--instant");
  }

  button.classList.add("score-date-btn--active");
  openScoreDateCalendar = { button, dateLabel, panel };
}

function toggleScoreDateCalendar(button, dateLabel) {
  const reopening = openScoreDateCalendar && openScoreDateCalendar.button === button;
  closeScoreDateCalendar();
  if (!reopening) openScoreDateCalendarFor(button, dateLabel);
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".score-date-btn") || event.target.closest(".score-date-calendar")) return;
  closeScoreDateCalendar();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openScoreDateCalendar) closeScoreDateCalendar();
});

function createAssessmentBox(labelText, percentText, rowCount = EMPTY_SCORE_ROWS) {
  const box = document.createElement("div");
  box.className = "assessment-box";
  box.dataset.baseWeight = parsePercent(percentText);

  const label = document.createElement("span");
  label.className = "assessment-label";
  label.textContent = labelText;

  const list = document.createElement("ul");
  list.className = "score-list";
  for (let i = 0; i < rowCount; i++) {
    list.appendChild(createScoreRow());
  }

  box.appendChild(label);
  box.appendChild(list);
  updateEmptyBoxPlaceholder(box);
  return box;
}

// Keeps two score-list scroll positions in lockstep by raw pixel offset
// (not proportional to each list's own max scroll).
function linkScoreListScroll(listA, listB) {
  let syncing = false;
  const sync = (source, target) => {
    if (syncing) return;
    syncing = true;
    target.scrollTop = source.scrollTop;
    syncing = false;
  };
  listA.addEventListener("scroll", () => sync(listA, listB));
  listB.addEventListener("scroll", () => sync(listB, listA));
}

// hasFinal decides the grading split: 20% formative / 60% summative / 20%
// final if the course has one, otherwise 20% formative / 80% summative.
// matchName defaults to the plain display name — for a divided course,
// the caller passes the combined name instead, so this card's "Next ..."
// line finds the right division's date while its title stays plain.
// periodIndex (the My Courses period slot this card came from) is what
// lets an A/B-day assessment only count for a card whose period actually
// meets that day — null for the sample placeholder cards, which show every
// assessment unfiltered since they have no real period.
function addClassCard(name, hasFinal, matchName = name, hideable = true, periodIndex = null) {
  const card = document.createElement("div");
  card.className = "class-card";

  // Hides this specific card — a combo course's two cards are hidden
  // independently. hideable=false for the sample placeholder cards, which
  // have no My Courses period behind them to ever show them again from.
  let hideBtn = null;
  if (hideable) {
    hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "card-hide-btn";
    hideBtn.setAttribute("aria-label", "Hide course");
    const hideIcon = document.createElement("img");
    hideIcon.className = "card-hide-icon";
    hideIcon.src = uiIconPath("hide.png");
    hideIcon.alt = "";
    hideBtn.appendChild(hideIcon);
    hideBtn.addEventListener("click", () => hideClassCard(card, name));
  }

  const title = document.createElement("h2");
  title.className = "class-name";
  title.textContent = name;

  const summary = document.createElement("div");
  summary.className = "grade-summary";

  const gradeValue = document.createElement("span");
  gradeValue.className = "grade-value";
  gradeValue.textContent = "-";

  summary.appendChild(gradeValue);

  const breakdown = document.createElement("p");
  breakdown.className = "grade-breakdown";
  breakdown.append(
    "FA ",
    Object.assign(document.createElement("span"), { className: "breakdown-value", textContent: "-" }),
    " ",
    Object.assign(document.createElement("span"), { className: "divider", textContent: "|" }),
    " SA ",
    Object.assign(document.createElement("span"), { className: "breakdown-value", textContent: "-" }),
    " ",
    Object.assign(document.createElement("span"), { className: "divider", textContent: "|" }),
    " D ",
    Object.assign(document.createElement("span"), { className: "breakdown-value", textContent: "-" })
  );

  const nextAssessmentLine = document.createElement("p");
  nextAssessmentLine.className = "next-assessment-line";

  const groups = document.createElement("div");
  groups.className = "assessment-groups";

  const fsRow = document.createElement("div");
  fsRow.className = "assessment-fs-row";
  const formativesBox = createAssessmentBox("Formatives", "20%");
  const summativesBox = createAssessmentBox("Summatives", hasFinal ? "60%" : "80%");
  fsRow.appendChild(formativesBox);
  fsRow.appendChild(summativesBox);
  // A child of .assessment-groups, not a sibling — it draws from the same
  // fixed budget locked further down, so an upcoming assessment shrinks
  // Formatives/Summatives to make room instead of growing the whole card
  // (and every other card in the row with it).
  groups.appendChild(nextAssessmentLine);
  groups.appendChild(fsRow);
  const formativeList = formativesBox.querySelector(".score-list");
  const summativeList = summativesBox.querySelector(".score-list");
  linkScoreListScroll(formativeList, summativeList);

  if (hideBtn) card.appendChild(hideBtn);
  card.appendChild(title);
  card.appendChild(summary);
  card.appendChild(breakdown);
  card.appendChild(groups);

  // Keeps each row's link/unlink button aligned with its Formative row as
  // the (synced) lists scroll.
  formativeList.addEventListener("scroll", () => repositionFormativeLinkButtons(card));
  summativeList.addEventListener("scroll", () => repositionFormativeLinkButtons(card));

  // Connects the card to the page — needed before measuring anything
  // below, and before Final Exam (if any) is added.
  document.querySelector(".classes-container").appendChild(card);

  // Locks .assessment-groups to the height its initial content naturally
  // takes up — flex: 1 alone has no ceiling, so an unconstrained flex
  // chain just grows to fit whatever's inside it. This ceiling is what
  // lets typing enough scores scroll within a fixed-size box instead of
  // stretching the whole card, and lets Final Exam carve its space out of
  // this same budget instead of adding on top of it. flex-basis with
  // grow/shrink zeroed so it sticks.
  const baseGroupsHeight = groups.getBoundingClientRect().height;
  groups.style.flex = `0 0 ${baseGroupsHeight}px`;
  groups.dataset.baseHeight = baseGroupsHeight;

  if (hasFinal) {
    const finalBox = createAssessmentBox("Final Exam", "20%", 1);
    finalBox.classList.add("assessment-box--wide");
    groups.appendChild(finalBox);
  }

  restoreCardScores(card, name);
  // From here on, any further recalculation is a live change, not the
  // page-load restore above — see firstRevealStyle.
  card.dataset.settled = "true";
  updateNextAssessmentLine(card, matchName, periodIndex);
  return card;
}

const CARD_HIDE_MS = 250;

// Remembers name as hidden and removes the card, animated only if
// Settings > Animations is on. Un-hidden again via the matching show
// button in My Courses.
function hideClassCard(card, name) {
  const hidden = loadHiddenCourses();
  if (!hidden.includes(name)) saveHiddenCourses([...hidden, name]);

  showToast(`${name} hidden. Show it again in My Courses.`);

  if (!window.animationsEnabled()) {
    card.remove();
    return;
  }

  card.style.transition = `opacity ${CARD_HIDE_MS}ms ease`;
  card.style.opacity = "0";
  setTimeout(() => card.remove(), CARD_HIDE_MS);
}

const FULL_WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Relative label for the card's "Upcoming ...:" line — "Today"/"Tomorrow",
// otherwise the bare day name. Null once more than 5 days out (the caller
// hides the whole line then).
function formatRelativeAssessmentLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);

  const daysUntil = Math.round((target - today) / 86400000);
  if (daysUntil < 0 || daysUntil > 5) return null;
  if (daysUntil === 0) return "Today";
  if (daysUntil === 1) return "Tomorrow";
  return FULL_WEEKDAY_NAMES[target.getDay()];
}

// Fills in the card's "Next ...: ..." line once the school-wide assessment
// calendar has loaded — registered per-card so it works whether that
// fetch finishes before or after this card exists.
function updateNextAssessmentLine(card, name, periodIndex) {
  loadAssessmentData(() => {
    const line = card.querySelector(".next-assessment-line");
    const groups = card.querySelector(".assessment-groups");
    const breakdown = card.querySelector(".grade-breakdown");
    if (!line || !groups) return;

    const baseHeight = parseFloat(groups.dataset.baseHeight);

    const next = nearestUpcomingAnyAssessment(name, periodIndex);
    line.innerHTML = "";
    // Read once the line is confirmed empty, not from dataset.baseOffsetTop
    // (a position snapshot taken back in addClassCard, before
    // restoreCardScores replaces the "-" placeholders with real FA/SA/D
    // values) — that snapshot can no longer be trusted as "the untightened
    // state" by the time this runs.
    const marginBefore = parseFloat(getComputedStyle(breakdown).marginBottom);
    if (!next) {
      groups.style.flex = `0 0 ${baseHeight}px`;
      repositionFormativeLinkButtons(card);
      return;
    }
    const label = formatRelativeAssessmentLabel(fromISODate(next.date));
    if (!label) {
      groups.style.flex = `0 0 ${baseHeight}px`;
      repositionFormativeLinkButtons(card);
      return;
    }

    // The date is a separate span so it can be colored black while the
    // label itself stays this line's muted gray.
    line.append(
      `Upcoming ${next.type}: `,
      Object.assign(document.createElement("span"), {
        className: "next-assessment-line-date",
        textContent: label,
      })
    );

    // Filling in the line above also tightens .grade-breakdown's own
    // margin-bottom (see the :has() rule in style.css) — read directly
    // rather than inferred from a page-position diff, which would also
    // pick up any unrelated shift (webfont swap, restoreCardScores) between
    // the two measurements and wrongly count it as space this line added.
    const marginAfter = parseFloat(getComputedStyle(breakdown).marginBottom);
    const spaceAddedAbove = marginAfter - marginBefore;
    groups.style.flex = `0 0 ${baseHeight - spaceAddedAbove}px`;

    // Rows were already positioned (by restoreCardScores, which runs
    // synchronously before this) against .assessment-groups' pre-shrink
    // layout — the line above just moved them, so any link/unlink button
    // needs to catch up to where its row actually ended up.
    repositionFormativeLinkButtons(card);
  });
}

// Bring any cards already in the page in line with the real calculation.
document.querySelectorAll(".class-card").forEach(recalculateCard);

// Domain page: build a class card for each named period, using the course
// catalog to decide whether it gets a Final Exam box. A no-op on any
// other page.
function initDomainPage() {
  const dynamicClassesContainer = document.querySelector('.classes-container[data-dynamic="true"]');
  if (!dynamicClassesContainer) return;

  // The horizontal scrollbar only shows while actually scrolling, then
  // fades back out (see .classes-container--scrolling in style.css) —
  // idle-timeout reset on every scroll event rather than a fixed-length
  // one-shot, so it keeps showing through a long continuous scroll.
  let classesScrollingTimeout = null;
  dynamicClassesContainer.addEventListener("scroll", () => {
    dynamicClassesContainer.classList.add("classes-container--scrolling");
    clearTimeout(classesScrollingTimeout);
    classesScrollingTimeout = setTimeout(() => {
      dynamicClassesContainer.classList.remove("classes-container--scrolling");
    }, 800);
  });

  const periods = loadPeriods();
  const divisions = loadPeriodDivisions();
  const entries = periods
    .map((name, index) => ({ name: (name || "").trim(), division: divisions[index] || "", periodIndex: index }))
    .filter((entry) => entry.name !== "");

  if (entries.length === 0) {
    // No real courses yet: show two sample cards (one with a Final Exam,
    // one without) so the layout doesn't look empty, plus a hint card
    // pointing to My Courses. All three disappear once a real course exists.
    addClassCard("Course with Finals", true, undefined, false);
    addClassCard("Course without Finals", false, undefined, false);

    const hint = document.createElement("p");
    hint.className = "domain-empty-hint";
    const link = document.createElement("a");
    link.href = "my-courses";
    link.textContent = "My Courses";
    hint.append("Start by adding your", document.createElement("br"), "courses at ", link);
    dynamicClassesContainer.appendChild(hint);
  } else {
    // Card display names — a combo course's two cards are hidden
    // independently of each other.
    const hidden = new Set(loadHiddenCourses());

    // Not expandCourseNames' flat map here — that would lose each
    // period's own index, and with it the division that goes with it.
    entries.forEach(({ name, division, periodIndex }) => {
      const course = findCourseCatalogEntry(name);
      if (course && course.combo) {
        // The division belongs to the combo course as a whole — both
        // cards look up the same picked division's date.
        const matchName = effectiveCourseName(name, division);
        course.combo.forEach((sub) => {
          if (!hidden.has(sub.name)) addClassCard(sub.name, sub.final, matchName, true, periodIndex);
        });
      } else if (!hidden.has(name)) {
        addClassCard(name, course ? course.final : false, effectiveCourseName(name, division), true, periodIndex);
      }
    });
  }

  // Whatever just got built above is the actual content now — hide the
  // loading spinner in favor of it.
  const loading = document.getElementById("domain-loading");
  if (loading) loading.hidden = true;
}

// --- "Learn More" grade-protection modal ---
// Static, informational content (adapted from "How Your Grades Are
// Protected") — rebuilt fresh on each open, same pattern as My Courses'
// Add Missing Assessment modal, even though nothing here is actually
// dynamic.
function initGradeProtectionModal() {
  const triggerBtn = document.getElementById("grade-protection-learn-more-btn");
  if (!triggerBtn) return;

  let overlay = null;

  // Same four sample grades as the source PDF, using the app's own real
  // grade badge icons instead of redrawing them.
  const SAMPLE_GRADES = [
    { slug: "a", label: "A", score: "94" },
    { slug: "b-plus", label: "B+", score: "89" },
    { slug: "a-minus", label: "A-", score: "91" },
    { slug: "a-plus", label: "A+", score: "100" },
  ];

  const CIPHER_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Purely cosmetic gibberish, regenerated fresh on every open — more than
  // enough to overflow .grade-protection-cipher-box's own fixed height, so
  // it scrolls instead of ever looking sparse.
  function randomCipherText() {
    const bytes = crypto.getRandomValues(new Uint8Array(250));
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += CIPHER_CHARS[bytes[i] % CIPHER_CHARS.length];
    return text;
  }

  function buildOverlay() {
    const el = document.createElement("div");
    el.className = "grade-protection-overlay";
    el.innerHTML = `
      <div class="grade-protection-dialog">
        <button type="button" class="grade-protection-close-btn" aria-label="Close">×</button>
        <h2 class="grade-protection-title">How Your Grades Are Protected</h2>
        <p class="grade-protection-intro">
          KISJ Grade Calculator uses
          <a href="https://en.wikipedia.org/wiki/End-to-end_encryption" target="_blank" rel="noopener noreferrer"
            >end-to-end encryption</a
          >
          to ensure your grades cannot be accessed by any third party, including the app developer.
        </p>

        <h3 class="grade-protection-section-title">Creating Your Account</h3>
        <p class="grade-protection-section-text">
          When you create an account, your browser generates a unique, random
          <strong>encryption key</strong> — a secret code that tells your browser how to scramble and
          unscramble your data so no one else can read it.
        </p>

        <h3 class="grade-protection-section-title">Storing the Key</h3>
        <p class="grade-protection-section-text">
          Your encryption key is only saved on your device. You can find it in Settings → Login Keys.
        </p>

        <div class="grade-protection-compare">
          <div class="grade-protection-compare-column">
            <span class="grade-protection-compare-heading">What you see</span>
            <div class="grade-protection-grades" id="grade-protection-grades"></div>
          </div>
          <div class="grade-protection-compare-column">
            <span class="grade-protection-compare-heading">What is stored</span>
            <div class="grade-protection-cipher-box" id="grade-protection-cipher"></div>
            <div class="grade-protection-key-note">
              <img class="grade-protection-key-icon" id="grade-protection-key-icon" alt="" />
              <span>The key that <u>only your device knows</u> is needed to decrypt this data.</span>
            </div>
          </div>
        </div>

        <h3 class="grade-protection-section-title">Encrypting Your Grades</h3>
        <p class="grade-protection-section-text">
          When you add or edit a grade, your browser encrypts it before sending it to the database. Only
          scrambled, unreadable data is transmitted or stored.
        </p>

        <h3 class="grade-protection-section-title">Decrypting Your Grades</h3>
        <p class="grade-protection-section-text">
          When you return to view your grades, your browser uses your key to decrypt the database on your device.
        </p>
      </div>
    `;
    document.body.appendChild(el);

    const gradesEl = el.querySelector("#grade-protection-grades");
    SAMPLE_GRADES.forEach(({ slug, label, score }) => {
      const row = document.createElement("div");
      row.className = "grade-protection-grade-row";
      const badge = document.createElement("img");
      badge.className = "letter-grade";
      badge.src = gradeIconPath(slug);
      badge.alt = label;
      const scoreEl = document.createElement("span");
      scoreEl.textContent = score;
      row.append(badge, scoreEl);
      gradesEl.appendChild(row);
    });

    el.querySelector("#grade-protection-cipher").textContent = randomCipherText();
    el.querySelector("#grade-protection-key-icon").src = uiIconPath("key.png");

    el.querySelector(".grade-protection-close-btn").addEventListener("click", closeModal);
    el.addEventListener("click", (event) => {
      if (event.target === el) closeModal();
    });

    return el;
  }

  function openModal() {
    overlay = buildOverlay();
    const dialog = overlay.querySelector(".grade-protection-dialog");
    const animate = window.animationsEnabled();
    if (!animate) {
      dialog.classList.add("grade-protection-dialog--instant");
      overlay.classList.add("grade-protection-overlay--instant");
    }
    void dialog.offsetWidth; // force reflow so the entrance transition below actually plays
    dialog.classList.add("grade-protection-dialog--visible");
    overlay.classList.add("grade-protection-overlay--visible");
    if (!animate) {
      void dialog.offsetWidth; // commit the instant state before re-enabling the transition
      dialog.classList.remove("grade-protection-dialog--instant");
      overlay.classList.remove("grade-protection-overlay--instant");
    }
  }

  function closeModal() {
    if (!overlay) return;
    const closingOverlay = overlay;
    const dialog = closingOverlay.querySelector(".grade-protection-dialog");
    overlay = null;
    if (!window.animationsEnabled()) {
      closingOverlay.remove();
      return;
    }
    // Reverses the entrance transition above (see openModal).
    dialog.classList.remove("grade-protection-dialog--visible");
    closingOverlay.classList.remove("grade-protection-overlay--visible");
    setTimeout(() => closingOverlay.remove(), 250);
  }

  triggerBtn.addEventListener("click", openModal);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay) closeModal();
  });
}

initGradeProtectionModal();
