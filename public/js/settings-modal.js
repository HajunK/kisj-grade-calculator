// Settings & Login Keys popups — opened from the account-menu dropdown
// (see auth.js), now that Settings is no longer its own tab/page (the old
// standalone settings.html + settings.js have been deleted; this file is
// that same preferences/segmented-control/toggle/danger-zone logic,
// rebuilt to construct its markup fresh inside an overlay each time one
// opens instead of assuming it's the whole page). Every helper here is
// prefixed "sm" (Settings Modal) mostly out of habit from when this had
// to stay visually distinct from settings.js's near-identical names.

// Swapped in on #copy-encryption-code-btn — the copy icon at rest, a
// checkmark for 1.5s right after a successful copy.
const SM_COPY_ICON = `
  <svg class="settings-copy-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" />
    <path d="M6 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;
const SM_CHECK_ICON = `
  <svg class="settings-copy-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

function smInitSegmentedControl(container) {
  const thumb = document.createElement("span");
  thumb.className = "segmented-thumb";
  container.insertBefore(thumb, container.firstChild);

  container.querySelectorAll(".segmented-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("segmented-option--active")) return;
      window.setPreference(container.dataset.pref, btn.dataset.value);
      smSyncSegmentedControl(container, true);
    });
  });

  // No animation on open — the thumb should just already be there, not
  // slide in from the left edge.
  smSyncSegmentedControl(container, false);
}

function smSyncSegmentedControl(container, animate) {
  const prefs = window.getPreferences();
  const thumb = container.querySelector(".segmented-thumb");
  let activeOption = null;

  container.querySelectorAll(".segmented-option").forEach((btn) => {
    const isActive = btn.dataset.value === prefs[container.dataset.pref];
    btn.classList.toggle("segmented-option--active", isActive);
    if (isActive) activeOption = btn;
  });
  if (!activeOption) return;

  if (!animate) thumb.style.transition = "none";
  thumb.style.left = `${activeOption.offsetLeft}px`;
  thumb.style.width = `${activeOption.offsetWidth}px`;
  if (!animate) {
    void thumb.offsetWidth; // force reflow so the "none" transition above takes effect first
    thumb.style.transition = "";
  }
}

function smInitToggle(input) {
  smSyncToggle(input, false);
  input.addEventListener("change", () => {
    window.setPreference(input.dataset.pref, input.checked);
  });
}

function smSyncToggle(input, animate) {
  const wrapper = input.closest(".toggle-switch");
  if (!animate && wrapper) wrapper.classList.add("toggle-switch--instant");
  input.checked = window.getPreferences()[input.dataset.pref] !== false;
  if (!animate && wrapper) {
    void wrapper.offsetWidth; // force the instant state to commit before re-enabling the transition
    wrapper.classList.remove("toggle-switch--instant");
  }
}

// Keeps an open popup's own controls in sync if preferences change from
// somewhere else (another tab/device) while it's open — a no-op the rest
// of the time, since these selectors then match nothing.
window.addEventListener("app:preferences-changed", () => {
  document
    .querySelectorAll(".settings-modal-overlay .segmented-control")
    .forEach((el) => smSyncSegmentedControl(el, true));
  document.querySelectorAll(".settings-modal-overlay .settings-toggle").forEach((el) => smSyncToggle(el, true));
});

// Reuses shared.js's own showToast where it's already loaded (My Courses/
// Domain/GPA); falls back to the same .signin-toast singleton pattern for
// a page that doesn't load shared.js (Assessments, Suggestions).
let smToastEl = null;
let smToastHideTimer = null;
const SM_TOAST_VISIBLE_MS = 4000;

function smShowToast(message) {
  if (typeof window.showToast === "function") {
    window.showToast(message);
    return;
  }
  if (!smToastEl) {
    smToastEl = document.createElement("div");
    smToastEl.className = "signin-toast";
    document.body.appendChild(smToastEl);
    void smToastEl.offsetWidth; // force reflow so the entrance below actually transitions
  }
  smToastEl.textContent = message;
  smToastEl.classList.add("signin-toast--visible");
  clearTimeout(smToastHideTimer);
  smToastHideTimer = setTimeout(() => {
    smToastEl.classList.remove("signin-toast--visible");
  }, SM_TOAST_VISIBLE_MS);
}

// Rises from the bottom of the screen in place of window.confirm, for the
// two destructive actions below. requireEmail additionally requires typing
// the signed-in account's own email before the confirm button enables.
function smShowConfirmDialog({ title, message, confirmLabel, requireEmail }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-dialog-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h2 class="confirm-dialog-title"></h2>
        <p class="confirm-dialog-text"></p>
        ${
          requireEmail
            ? `<input type="text" class="confirm-dialog-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type your email to confirm" />`
            : ""
        }
        <div class="confirm-dialog-actions">
          <button type="button" class="confirm-dialog-cancel-btn">Cancel</button>
          <button type="button" class="confirm-dialog-confirm-btn"></button>
        </div>
      </div>
    `;
    overlay.querySelector(".confirm-dialog-title").textContent = title;
    overlay.querySelector(".confirm-dialog-text").textContent = message;
    const confirmBtn = overlay.querySelector(".confirm-dialog-confirm-btn");
    confirmBtn.textContent = confirmLabel;
    const cancelBtn = overlay.querySelector(".confirm-dialog-cancel-btn");
    const input = overlay.querySelector(".confirm-dialog-input");

    document.body.appendChild(overlay);
    const dialog = overlay.querySelector(".confirm-dialog");
    void dialog.offsetWidth; // force reflow so the entrance transition below actually plays
    dialog.classList.add("confirm-dialog--visible");
    overlay.classList.add("confirm-dialog-overlay--visible");

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", handleKeydown);
      resolve(result);
      dialog.classList.remove("confirm-dialog--visible");
      overlay.classList.remove("confirm-dialog-overlay--visible");
      setTimeout(() => overlay.remove(), 250);
    }

    function handleKeydown(event) {
      if (event.key === "Escape") close(false);
    }
    document.addEventListener("keydown", handleKeydown);

    if (requireEmail) {
      const targetEmail = ((auth.currentUser && auth.currentUser.email) || "").toLowerCase();
      confirmBtn.disabled = true;
      input.addEventListener("input", () => {
        confirmBtn.disabled = input.value.trim().toLowerCase() !== targetEmail;
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !confirmBtn.disabled) close(true);
      });
      input.focus();
    }

    confirmBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
  });
}

function smCurrentUserOrWarn() {
  const user = auth.currentUser;
  if (!user) {
    smShowToast("Sign in to the account you want to delete.");
    return null;
  }
  return user;
}

// Wipes everything except the doc's identity and email. A plain (non-merge)
// .set() — merge:true would deep-merge nested map fields instead of
// clearing them, leaving the old content untouched.
function smDeleteAllData() {
  const user = smCurrentUserOrWarn();
  if (!user) return;

  firebase
    .firestore()
    .collection("users")
    .doc(user.uid)
    .set({ email: user.email || "", lastModified: Date.now() })
    .then(() => {
      localStorage.removeItem(APP_DATA_CACHE_PREFIX + user.uid);
      localStorage.removeItem(prefsCacheKeyFor(user.uid));
      alert("All your data has been deleted.");
      location.reload();
    })
    .catch((error) => {
      console.error("Failed to delete data:", error);
      alert("Something went wrong deleting your data. Please try again.");
    });
}

// Deletes the Firestore document first, then the Firebase Auth account
// itself. Auth deletion needs a recent sign-in — if not, re-prompt via
// Google sign-in and retry just that last step.
function smDeleteAccount() {
  const user = smCurrentUserOrWarn();
  if (!user) return;

  const uid = user.uid;
  firebase
    .firestore()
    .collection("users")
    .doc(uid)
    .delete()
    .then(() => user.delete())
    .catch((error) => {
      if (error.code === "auth/requires-recent-login") {
        return user.reauthenticateWithPopup(googleProvider).then(() => user.delete());
      }
      throw error;
    })
    .then(() => {
      localStorage.removeItem(APP_DATA_CACHE_PREFIX + uid);
      localStorage.removeItem(prefsCacheKeyFor(uid));
      localStorage.removeItem(encKeyStorageKey(uid));
      window.location.href = "/domain";
    })
    .catch((error) => {
      console.error("Failed to delete account:", error);
      alert("Something went wrong deleting your account. Please try again.");
    });
}

function smInitDangerActions() {
  const deleteDataBtn = document.getElementById("delete-all-data-btn");
  const deleteAccountBtn = document.getElementById("delete-account-btn");

  deleteDataBtn.addEventListener("click", () => {
    smShowConfirmDialog({
      title: "Delete all data?",
      message: "Delete all your grades, courses, and GPA data? This can't be undone. You'll stay signed in.",
      confirmLabel: "Delete all data",
    }).then((confirmed) => {
      if (confirmed) smDeleteAllData();
    });
  });

  deleteAccountBtn.addEventListener("click", () => {
    if (!smCurrentUserOrWarn()) return;
    smShowConfirmDialog({
      title: "Delete account?",
      message:
        "Permanently delete your account and all of its data? This can't be undone—you'll need to create a new account.",
      confirmLabel: "Delete account",
      requireEmail: true,
    }).then((confirmed) => {
      if (confirmed) smDeleteAccount();
    });
  });
}

// --- Shared overlay plumbing — one popup open at a time, same
// entrance/exit animation convention as every other popup in the app. ---

let settingsModalOverlay = null;

function smBuildOverlay(cardHTML) {
  const overlay = document.createElement("div");
  overlay.className = "settings-modal-overlay";
  overlay.innerHTML = cardHTML;
  document.body.appendChild(overlay);
  return overlay;
}

function smRevealOverlay(overlay) {
  settingsModalOverlay = overlay;
  const card = overlay.querySelector(".settings-modal-card");

  overlay.querySelector(".settings-modal-close-btn").addEventListener("click", closeSettingsModal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSettingsModal();
  });

  void card.offsetWidth; // force reflow so the entrance transition below actually plays
  card.classList.add("settings-modal-card--visible");
  overlay.classList.add("settings-modal-overlay--visible");
}

function closeSettingsModal() {
  if (!settingsModalOverlay) return;
  const closingOverlay = settingsModalOverlay;
  const card = closingOverlay.querySelector(".settings-modal-card");
  settingsModalOverlay = null;
  // Reverses the entrance transition above.
  card.classList.remove("settings-modal-card--visible");
  closingOverlay.classList.remove("settings-modal-overlay--visible");
  setTimeout(() => closingOverlay.remove(), 250);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsModalOverlay) closeSettingsModal();
});

// --- The two popups themselves ---

function openSettingsModal() {
  closeSettingsModal();
  // Only relevant on a page that also loaded my-courses.js (see auth.js).
  if (typeof closeMyCoursesModal === "function") closeMyCoursesModal();

  const overlay = smBuildOverlay(`
    <div class="settings-card settings-modal-card">
      <button type="button" class="settings-modal-close-btn" aria-label="Close"><span class="close-icon" aria-hidden="true"></span></button>
      <h2 class="settings-title">Settings</h2>

      <div class="settings-row">
        <span class="settings-label">Appearance</span>
        <div class="segmented-control" data-pref="appearance">
          <button type="button" class="segmented-option" data-value="light">Light</button>
          <button type="button" class="segmented-option" data-value="dark">Dark</button>
          <button type="button" class="segmented-option" data-value="system">System</button>
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-label">Date format</span>
        <div class="segmented-control" data-pref="dateFormat">
          <button type="button" class="segmented-option" data-value="monthDay"></button>
          <button type="button" class="segmented-option" data-value="numeric"></button>
          <button type="button" class="segmented-option" data-value="dayMonth"></button>
          <button type="button" class="segmented-option" data-value="numericEU"></button>
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-label">Privacy Blur</span>
        <div class="segmented-control" data-pref="privacyBlurMode">
          <button type="button" class="segmented-option" data-value="never">Never</button>
          <button type="button" class="segmented-option" data-value="school">During School</button>
          <button type="button" class="segmented-option" data-value="always">Always</button>
        </div>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-row">
        <span class="settings-label">Display grade breakdown</span>
        <label class="toggle-switch">
          <input type="checkbox" class="settings-toggle" data-pref="showBreakdown" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="settings-row">
        <span class="settings-label">Display upcoming assessments</span>
        <label class="toggle-switch">
          <input type="checkbox" class="settings-toggle" data-pref="showUpcomingAssessments" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="settings-row">
        <span class="settings-label">Replace formatives by default</span>
        <label class="toggle-switch">
          <input type="checkbox" class="settings-toggle" data-pref="replaceFormativesByDefault" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-danger-row">
        <button type="button" class="settings-danger-btn" id="delete-all-data-btn">Delete all data</button>
        <button type="button" class="settings-danger-btn" id="delete-account-btn">Delete account</button>
      </div>
    </div>
  `);

  // The date-format options don't have fixed labels in the HTML — each
  // button shows what *today's* date looks like in that format.
  const today = new Date();
  overlay.querySelectorAll('.segmented-control[data-pref="dateFormat"] .segmented-option').forEach((btn) => {
    btn.textContent = window.formatPreferredDate(today, btn.dataset.value);
  });

  overlay.querySelectorAll(".segmented-control").forEach(smInitSegmentedControl);
  overlay.querySelectorAll(".settings-toggle").forEach(smInitToggle);

  // The thumb's pixel position is measured against the fallback font
  // (font-display: swap) — once Inter itself loads, character widths
  // shift and the already-placed thumb no longer lines up.
  if (document.fonts) {
    document.fonts.ready.then(() => {
      overlay.querySelectorAll(".segmented-control").forEach((el) => smSyncSegmentedControl(el, false));
    });
  }

  smInitDangerActions();
  smRevealOverlay(overlay);
}

function smRenderEncryptionQr(overlay, code) {
  const container = overlay.querySelector("#encryption-code-qr");
  if (!container) return;
  if (!code || typeof qrcode !== "function") {
    container.innerHTML = "";
    return;
  }
  const qr = qrcode(0, "M");
  qr.addData(code);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
}

function openLoginKeysModal() {
  closeSettingsModal();
  if (typeof closeMyCoursesModal === "function") closeMyCoursesModal();

  const overlay = smBuildOverlay(`
    <div class="settings-card login-keys-card settings-modal-card">
      <button type="button" class="settings-modal-close-btn" aria-label="Close"><span class="close-icon" aria-hidden="true"></span></button>
      <h2 class="settings-title">Login Keys</h2>
      <!-- An easier way to get the code onto another device than typing
           it: scan this with that device's camera. -->
      <div class="settings-encryption-qr" id="encryption-code-qr"></div>
      <div class="settings-encryption-code-row">
        <input type="text" class="settings-encryption-code" id="encryption-code" readonly />
        <button type="button" class="settings-copy-btn" id="copy-encryption-code-btn" aria-label="Copy">
          ${SM_COPY_ICON}
        </button>
      </div>
      <p class="settings-encryption-hint">
        Save this key somewhere safe. It is necessary when logging in with another device.
      </p>
    </div>
  `);

  const codeInput = overlay.querySelector("#encryption-code");
  const copyBtn = overlay.querySelector("#copy-encryption-code-btn");

  copyBtn.addEventListener("click", () => {
    if (!codeInput.value) return;
    navigator.clipboard.writeText(codeInput.value).then(() => {
      copyBtn.innerHTML = SM_CHECK_ICON;
      copyBtn.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        copyBtn.innerHTML = SM_COPY_ICON;
        copyBtn.setAttribute("aria-label", "Copy");
      }, 1500);
    });
  });

  const user = typeof auth !== "undefined" ? auth.currentUser : null;
  if (user && typeof firebase !== "undefined" && firebase.firestore) {
    firebase
      .firestore()
      .collection("users")
      .doc(user.uid)
      // source: "server" — a plain .get() right after sign-in can be
      // satisfied from Firestore's local cache before the encrypted
      // fields have synced down, wrongly skipping the decryption prompt.
      .get({ source: "server" })
      .then((snapshot) => resolveDeviceKeyForBoot(user.uid, snapshot.exists ? snapshot.data() : {}))
      .then(() => {
        codeInput.value = localStorage.getItem(encKeyStorageKey(user.uid)) || "";
        smRenderEncryptionQr(overlay, codeInput.value);
      })
      .catch((error) => console.error("Failed to load decryption code:", error));
  }

  smRevealOverlay(overlay);
}
