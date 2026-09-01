// GPA page: the class list (grade picker, link/unlink-independent letter
// badges), unweighted/weighted GPA calculation, and "Paste from Domain
// Tab".

function loadDomainSnapshot() {
  return appData.domainSnapshot;
}

const GPA_SCALE = {
  "a-plus": 4.0,
  a: 4.0,
  "a-minus": 3.667,
  "b-plus": 3.333,
  b: 3.0,
  "b-minus": 2.667,
  "c-plus": 2.333,
  c: 2.0,
  "c-minus": 1.667,
  "d-plus": 1.333,
  d: 1.0,
  "d-minus": 0.667,
  f: 0.0,
};

function loadGpaClasses() {
  return appData.gpaClasses;
}

function closeAllGpaDropdowns() {
  document.querySelectorAll(".gpa-grade-dropdown").forEach((dropdown) => {
    dropdown.innerHTML = "";
  });
}

// Builds either a real letter-grade icon or, if this class has no grade
// yet, a hollow gray-outlined ring.
function createGpaBadgeContent(slug, label) {
  if (!slug) {
    const span = document.createElement("span");
    span.className = "grade-badge--empty";
    return span;
  }
  const img = document.createElement("img");
  img.className = "letter-grade";
  img.src = gradeIconPath(slug);
  img.dataset.slug = slug;
  img.alt = label || "";
  return img;
}

function setGpaRowGrade(row, slug, label) {
  row.dataset.slug = slug || "";
  const btn = row.querySelector(".gpa-grade-badge-btn");
  btn.innerHTML = "";
  btn.appendChild(createGpaBadgeContent(slug, label));
}

const GPA_BADGE_TRANSITION_MS = 180;

// Scroll-driven grade change: crossfades the single badge icon into the
// next tier, sliding up or down depending on direction.
function animateGpaBadgeChange(row, slug, label, direction) {
  if (!window.animationsEnabled()) {
    setGpaRowGrade(row, slug, label);
    return;
  }

  const btn = row.querySelector(".gpa-grade-badge-btn");

  // Fast scrolling can call this again before the previous transition's
  // cleanup fires — cancel it and collapse down to just the still-mid-
  // flight incoming icon, which becomes this call's starting point.
  if (btn._gpaBadgeCleanup) {
    clearTimeout(btn._gpaBadgeCleanup);
    btn._gpaBadgeCleanup = null;
  }
  while (btn.children.length > 1) btn.firstElementChild.remove();

  const oldContent = btn.firstElementChild;
  const newContent = createGpaBadgeContent(slug, label);

  row.dataset.slug = slug || "";

  // direction: 1 = moved to a lower tier — the old icon exits upward
  // while the new one enters from below. -1 is the mirror image.
  const exitY = direction > 0 ? "-10px" : "10px";
  const enterY = direction > 0 ? "10px" : "-10px";

  newContent.style.position = "absolute";
  newContent.style.inset = "0";
  newContent.style.opacity = "0";
  newContent.style.transform = `translateY(${enterY})`;
  newContent.style.transition = "none";
  btn.appendChild(newContent);

  // Anchored to the exact same box as newContent — without inset:0 too,
  // it drifts diagonally instead of exiting straight up/down.
  if (oldContent) {
    oldContent.style.position = "absolute";
    oldContent.style.inset = "0";
  }

  void btn.offsetWidth; // force reflow so the "none" transition above takes effect first

  const easing = `transform ${GPA_BADGE_TRANSITION_MS}ms ease, opacity ${GPA_BADGE_TRANSITION_MS}ms ease`;
  newContent.style.transition = easing;
  newContent.style.opacity = "1";
  newContent.style.transform = "translateY(0)";

  if (oldContent) {
    oldContent.style.transition = easing;
    oldContent.style.opacity = "0";
    oldContent.style.transform = `translateY(${exitY})`;
  }

  btn._gpaBadgeCleanup = setTimeout(() => {
    if (oldContent) oldContent.remove();
    newContent.style.position = "";
    newContent.style.inset = "";
    newContent.style.transition = "";
    newContent.style.transform = "";
    newContent.style.opacity = "";
    btn._gpaBadgeCleanup = null;
  }, GPA_BADGE_TRANSITION_MS + 30);
}

// The grade picker only shows A+ through B at a time; a "⋯" button toggles
// to B- through F (and back), rather than listing all 12 tiers at once.
const GPA_DROPDOWN_UPPER_TIERS = GRADE_SCALE.slice(0, 5); // A+, A, A-, B+, B
const GPA_DROPDOWN_LOWER_TIERS = GRADE_SCALE.slice(5); // B-, C+, C, C-, D+, D, F

function renderGpaDropdownOptions(dropdown, showLowerTiers, onSelect, onToggle) {
  dropdown.innerHTML = "";

  (showLowerTiers ? GPA_DROPDOWN_LOWER_TIERS : GPA_DROPDOWN_UPPER_TIERS).forEach((tier) => {
    const optionItem = document.createElement("li");
    const optionBtn = document.createElement("button");
    optionBtn.type = "button";
    optionBtn.className = "gpa-grade-option";

    const img = document.createElement("img");
    img.src = gradeIconPath(tier.slug);
    img.alt = tier.label;
    optionBtn.appendChild(img);

    optionBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(tier);
    });

    optionItem.appendChild(optionBtn);
    dropdown.appendChild(optionItem);
  });

  const moreItem = document.createElement("li");
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "gpa-grade-more";
  moreBtn.textContent = "⋯";
  moreBtn.setAttribute("aria-label", showLowerTiers ? "Show A+ through B" : "Show B- through F");
  moreBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    onToggle();
  });
  moreItem.appendChild(moreBtn);
  dropdown.appendChild(moreItem);
}

function persistGpaClasses() {
  const list = document.querySelector(".gpa-class-list");
  if (!list) return;
  const classes = Array.from(list.querySelectorAll(".gpa-class-row")).map((row) => ({
    name: row.querySelector(".gpa-class-name").textContent,
    slug: row.dataset.slug || null,
    label: row.querySelector(".gpa-grade-badge-btn img")?.alt || null,
  }));
  appData.gpaClasses = classes;
  pushDataToCloud();
}

// False until the class list's own first build finishes — see
// renderGpaClassList. Kept "instant" (no animation at all) up to that
// point, since it's a page-load restore, not a live change; "blur" after,
// for a summary number turning from blank to real live.
let gpaSettled = false;

function recalculateGpa() {
  const list = document.querySelector(".gpa-class-list");
  if (!list) return;

  let unweightedSum = 0;
  let weightedSum = 0;
  let creditTotal = 0;
  let hasAp = false;

  list.querySelectorAll(".gpa-class-row").forEach((row) => {
    const name = row.querySelector(".gpa-class-name").textContent;
    const course = findCourseCatalogEntry(name);
    const isAp = course ? course.ap : false;
    // Whether the student is taking an AP course decides the display mode,
    // regardless of whether that course has a grade entered yet.
    if (isAp) hasAp = true;

    const points = GPA_SCALE[row.dataset.slug];
    if (points === undefined) return;

    // Most courses are full (1.0) credit; catalog weight can lower that
    // (e.g. 0.5 for each half of a combo course) or zero it out (Lunch).
    const credit = course ? course.weight : 1;
    if (credit === 0) return;

    unweightedSum += points * credit;
    weightedSum += (points + (isAp ? 1.0 : 0)) * credit;
    creditTotal += credit;
  });

  const unweightedText = creditTotal > 0 ? roundToFourDecimals(unweightedSum / creditTotal) : "-";
  const weightedText = creditTotal > 0 ? roundToFourDecimals(weightedSum / creditTotal) : "-";

  // At least one AP course -> show Unweighted and Weighted side by side.
  const splitItems = document.querySelectorAll(".gpa-summary-item:not(.gpa-summary-item--combined)");
  const combinedItem = document.querySelector(".gpa-summary-item--combined");

  splitItems.forEach((el) => {
    el.hidden = !hasAp;
  });
  if (combinedItem) combinedItem.hidden = hasAp;

  const revealStyle = gpaSettled ? "blur" : "instant";
  if (hasAp) {
    const unweightedEl = document.querySelector(".gpa-unweighted");
    const weightedEl = document.querySelector(".gpa-weighted");
    if (unweightedEl) animateNumberChange(unweightedEl, unweightedText, revealStyle);
    if (weightedEl) animateNumberChange(weightedEl, weightedText, revealStyle);
  } else {
    const combinedEl = document.querySelector(".gpa-combined");
    if (combinedEl) animateNumberChange(combinedEl, unweightedText, revealStyle);
  }
}

// Rebuilds the GPA class list from `classes` ([{ name, slug, label }]) —
// each row's badge opens a row of grade icons to click-select.
function renderGpaClassList(classes) {
  const list = document.querySelector(".gpa-class-list");
  if (!list) return;
  list.innerHTML = "";

  classes.forEach(({ name, slug, label }) => {
    const row = document.createElement("li");
    row.className = "gpa-class-row";

    const nameEl = document.createElement("span");
    nameEl.className = "gpa-class-name";
    nameEl.textContent = name;

    const badgeBtn = document.createElement("button");
    badgeBtn.type = "button";
    badgeBtn.className = "gpa-grade-badge-btn";

    const dropdown = document.createElement("ul");
    dropdown.className = "gpa-grade-dropdown";

    // Only shown (via CSS, hover + a non-empty data-slug on the row) while
    // hovering a row that currently has a grade set.
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "gpa-clear-btn";
    clearBtn.textContent = "×";
    clearBtn.setAttribute("aria-label", "Remove grade");
    clearBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      setGpaRowGrade(row, null, null);
      closeAllGpaDropdowns();
      persistGpaClasses();
      recalculateGpa();
      // cleared: true — doesn't count toward hiding the "click or scroll"
      // instructions (see initGpaPage), unlike actually setting a grade.
      list.dispatchEvent(new CustomEvent("gpa-grade-changed", { bubbles: true, detail: { cleared: true } }));
    });

    row.appendChild(nameEl);
    row.appendChild(badgeBtn);
    row.appendChild(clearBtn);
    row.appendChild(dropdown);
    list.appendChild(row);

    setGpaRowGrade(row, slug, label);

    badgeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const wasOpen = dropdown.children.length > 0;
      closeAllGpaDropdowns();
      if (wasOpen) return;

      let showLowerTiers = false;
      const onSelect = (tier) => {
        setGpaRowGrade(row, tier.slug, tier.label);
        closeAllGpaDropdowns();
        persistGpaClasses();
        recalculateGpa();
        list.dispatchEvent(new CustomEvent("gpa-grade-changed", { bubbles: true }));
      };
      const onToggle = () => {
        showLowerTiers = !showLowerTiers;
        renderGpaDropdownOptions(dropdown, showLowerTiers, onSelect, onToggle);
      };
      renderGpaDropdownOptions(dropdown, showLowerTiers, onSelect, onToggle);
    });

    // Scroll on the badge to step through tiers one at a time. Trackpads
    // fire many tiny wheel events per gesture — accumulate deltaY and only
    // step once it crosses a threshold, then a short cooldown, so one
    // flick moves one tier instead of several.
    let wheelAccum = 0;
    let wheelCooldownUntil = 0;
    const WHEEL_STEP_THRESHOLD = 40;
    const WHEEL_COOLDOWN_MS = 120;

    badgeBtn.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        closeAllGpaDropdowns();

        const now = performance.now();
        wheelAccum += event.deltaY;
        if (now < wheelCooldownUntil || Math.abs(wheelAccum) < WHEEL_STEP_THRESHOLD) return;

        const direction = wheelAccum > 0 ? 1 : -1;
        wheelAccum = 0;
        wheelCooldownUntil = now + WHEEL_COOLDOWN_MS;

        // No current grade: land on A+ regardless of direction.
        const currentIndex = row.dataset.slug ? GRADE_SCALE.findIndex((tier) => tier.slug === row.dataset.slug) : -1;
        const nextIndex =
          currentIndex === -1 ? 0 : Math.min(Math.max(currentIndex + direction, 0), GRADE_SCALE.length - 1);
        if (nextIndex === currentIndex) return;

        const tier = GRADE_SCALE[nextIndex];
        animateGpaBadgeChange(row, tier.slug, tier.label, direction);
        persistGpaClasses();
        recalculateGpa();
        list.dispatchEvent(new CustomEvent("gpa-grade-changed", { bubbles: true }));
      },
      { passive: false }
    );
  });

  recalculateGpa();
  gpaSettled = true;
}

// Same names/order as My Courses, except a combo course (e.g. "Korean")
// expands into its parts (e.g. "Korean Lang", "Korean SS").
function currentClassNames() {
  const names = loadPeriods()
    .map((name) => (name || "").trim())
    .filter((name) => name !== "");
  return expandCourseNames(names);
}

// Each class's grade comes from whatever's already saved for it (so a
// manual override survives a reload), falling back to the Domain
// snapshot, falling back to ungraded.
function buildGpaClasses() {
  const domainSnapshot = loadDomainSnapshot();
  const existing = loadGpaClasses();

  return currentClassNames().map((name) => {
    const remembered = existing.find((c) => c.name === name);
    if (remembered) return remembered;

    const fromDomain = domainSnapshot.find((c) => c.name === name);
    return fromDomain || { name, slug: null, label: null };
  });
}

// Collapses the "Click or scroll..." instructions line down to nothing
// before actually hiding it.
function hideGpaClassesDescription(el) {
  if (!window.animationsEnabled()) {
    el.hidden = true;
    return;
  }

  const startHeight = el.getBoundingClientRect().height;
  el.style.height = `${startHeight}px`;
  void el.offsetHeight; // force reflow so the height above takes effect before transitioning
  el.style.transition = "height 0.25s ease, margin-bottom 0.25s ease, opacity 0.25s ease";
  el.style.height = "0px";
  el.style.marginBottom = "0px";
  el.style.opacity = "0";
  el.addEventListener("transitionend", () => { el.hidden = true; }, { once: true });
}

// GPA page: build the class list from appData and wire up the paste
// button. A no-op on any other page (no .gpa-class-list there).
function initGpaPage() {
  const gpaClassList = document.querySelector(".gpa-class-list");
  if (!gpaClassList) return;

  renderGpaClassList(buildGpaClasses());
  persistGpaClasses();

  document.addEventListener("click", closeAllGpaDropdowns);

  // "Click or scroll on the circle to set the letter grade" — hidden for
  // good the first time a grade actually gets set (not cleared). In-memory
  // only, so it's back next page load.
  const gpaDescription = document.querySelector(".gpa-classes-description");
  if (gpaDescription) {
    const onGpaGradeChanged = (event) => {
      if (event.detail && event.detail.cleared) return;
      document.removeEventListener("gpa-grade-changed", onGpaGradeChanged);
      hideGpaClassesDescription(gpaDescription);
    };
    document.addEventListener("gpa-grade-changed", onGpaGradeChanged);
  }

  // "Paste from Domain Tab" re-syncs every class's grade to whatever
  // Domain currently shows. appData.domainSnapshot could be stale (edited
  // in another tab since), so this fetches Firestore directly at click
  // time to guarantee the actual latest scores.
  const gpaPasteBtn = document.querySelector(".gpa-paste-btn");
  if (gpaPasteBtn) {
    const pasteBtnDefaultLabel = gpaPasteBtn.textContent;
    const MIN_PASTE_LOADING_MS = 1000; // so it doesn't just flash by, even on a fast fetch

    const setPasteLoading = (loading) => {
      gpaPasteBtn.disabled = loading;
      if (!loading) return;
      gpaPasteBtn.innerHTML = "";
      const spinner = document.createElement("span");
      spinner.className = "paste-spinner";
      gpaPasteBtn.appendChild(spinner);
      gpaPasteBtn.appendChild(document.createTextNode("Pasting letter grades..."));
    };

    // "Successfully pasted" replaces the button label once a paste
    // finishes, and stays until a grade actually changes.
    const resetPasteLabel = () => {
      gpaPasteBtn.textContent = pasteBtnDefaultLabel;
      gpaPasteBtn.disabled = false;
    };
    document.addEventListener("gpa-grade-changed", resetPasteLabel);

    const applyDomainSnapshotPaste = (domainSnapshot) => {
      const refreshed = currentClassNames().map((name) => {
        const fromDomain = domainSnapshot.find((c) => c.name === name);
        return fromDomain || { name, slug: null, label: null };
      });
      renderGpaClassList(refreshed);
      persistGpaClasses();
    };

    // Whichever takes longer wins, so the spinner shows for at least
    // MIN_PASTE_LOADING_MS but no longer once the real work is done.
    const finishPaste = (startedAt, domainSnapshot) => {
      const remaining = MIN_PASTE_LOADING_MS - (Date.now() - startedAt);
      setTimeout(
        () => {
          applyDomainSnapshotPaste(domainSnapshot);
          setPasteLoading(false);
          gpaPasteBtn.textContent = "Successfully Pasted!";
          // Stays disabled until a grade actually changes (resetPasteLabel).
          gpaPasteBtn.disabled = true;
        },
        Math.max(0, remaining)
      );
    };

    gpaPasteBtn.addEventListener("click", () => {
      const startedAt = Date.now();
      setPasteLoading(true);

      if (!currentUid || typeof firebase === "undefined" || !firebase.firestore) {
        finishPaste(startedAt, loadDomainSnapshot());
        return;
      }

      firebase
        .firestore()
        .collection("users")
        .doc(currentUid)
        // source: "server" — meant to guarantee the actual latest scores,
        // so it can't settle for Firestore's local cache.
        .get({ source: "server" })
        .then((snapshot) => {
          const cloud = snapshot.exists ? snapshot.data() : {};
          const fetchedLastModified = cloud.lastModified || 0;

          // This read can race a write already in flight from another
          // tab — only adopt it if not older than what's already known.
          if (fetchedLastModified < (appData.lastModified || 0)) {
            finishPaste(startedAt, appData.domainSnapshot);
            return;
          }

          // cloud.domainSnapshot is ciphertext — this is a direct
          // Firestore fetch, not the boot.js path that normally decrypts it.
          return getDeviceKey(currentUid)
            .then((key) => decryptValue(key, cloud.domainSnapshot, []))
            .then((domainSnapshot) => {
              appData.domainSnapshot = domainSnapshot;
              appData.lastModified = fetchedLastModified;
              finishPaste(startedAt, appData.domainSnapshot);
            });
        })
        .catch((error) => {
          console.error("Failed to fetch the latest Domain scores:", error);
          finishPaste(startedAt, loadDomainSnapshot());
        });
    });
  }
}
