// Settings page — Appearance/Date format pickers, the three toggles, and
// the two destructive account actions. Depends on preferences.js (loaded
// before this file) for getPreferences/setPreference/formatPreferredDate,
// and on auth.js for the Firebase auth/googleProvider instances the
// delete-account reauthentication flow reuses.

function initSegmentedControl(container) {
  // A single pill that slides to the picked option — see .segmented-thumb
  // in style.css — rather than each option's own background snapping on
  // and off.
  const thumb = document.createElement("span");
  thumb.className = "segmented-thumb";
  container.insertBefore(thumb, container.firstChild);

  container.querySelectorAll(".segmented-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("segmented-option--active")) return;
      window.setPreference(container.dataset.pref, btn.dataset.value);
      syncSegmentedControl(container, window.animationsEnabled());
    });
  });

  // No animation on page load — the thumb should just already be there,
  // not slide in from the left edge.
  syncSegmentedControl(container, false);
}

// Updates a segmented control's active option + thumb position to match
// the current preferences. Also re-synced by the app:preferences-changed
// listener below when a preference changes outside this page's own clicks.
function syncSegmentedControl(container, animate) {
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

function initToggle(input) {
  syncToggle(input, false);
  input.addEventListener("change", () => {
    window.setPreference(input.dataset.pref, input.checked);
  });
}

// Updates a toggle's checked state to match the current preferences.
function syncToggle(input, animate) {
  const wrapper = input.closest(".toggle-switch");
  // Suppress the slider's own transition while setting its state below —
  // otherwise a switch that's already on visibly animates from off, same
  // as if it had just been clicked.
  if (!animate && wrapper) wrapper.classList.add("toggle-switch--instant");
  input.checked = window.getPreferences()[input.dataset.pref] !== false;
  if (!animate && wrapper) {
    void wrapper.offsetWidth; // force the instant state to commit before re-enabling the transition
    wrapper.classList.remove("toggle-switch--instant");
  }
}

// Fired by preferences.js when currentPrefs changes from signing in/out —
// re-syncs every control's visuals to match.
window.addEventListener("app:preferences-changed", () => {
  const animate = window.animationsEnabled();
  document.querySelectorAll(".segmented-control").forEach((el) => syncSegmentedControl(el, animate));
  document.querySelectorAll(".settings-toggle").forEach((el) => syncToggle(el, animate));
});

// The date-format options don't have fixed labels in the HTML — each
// button shows what *today's* date looks like in that format, so the
// choice is obvious rather than needing a legend.
function fillDateFormatExamples() {
  const today = new Date();
  document.querySelectorAll('.segmented-control[data-pref="dateFormat"] .segmented-option').forEach((btn) => {
    btn.textContent = window.formatPreferredDate(today, btn.dataset.value);
  });
}

function initSettingsControls() {
  fillDateFormatExamples();
  document.querySelectorAll(".segmented-control").forEach(initSegmentedControl);
  document.querySelectorAll(".settings-toggle").forEach(initToggle);

  // The thumb's pixel position is measured from the buttons' rendered text
  // width, but that's taken while the page is still showing the fallback
  // font (font-display: swap) — once Inter itself loads in, character
  // widths shift and the already-placed thumb no longer lines up. Re-sync
  // once the real font is actually ready.
  if (document.fonts) {
    document.fonts.ready.then(() => {
      document.querySelectorAll(".segmented-control").forEach((el) => syncSegmentedControl(el, false));
    });
  }
}

// Drives the "Login Keys" button and the code/QR card it toggles open —
// the card's content is fetched and filled in once sign-in resolves.
function initLoginKeys() {
  const toggleBtn = document.getElementById("login-keys-btn");
  const card = document.getElementById("login-keys-card");
  const codeInput = document.getElementById("encryption-code");
  const copyBtn = document.getElementById("copy-encryption-code-btn");
  if (!toggleBtn || !card || !codeInput || !copyBtn) return;

  copyBtn.addEventListener("click", () => {
    if (!codeInput.value) return;
    navigator.clipboard.writeText(codeInput.value).then(() => {
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1500);
    });
  });

  toggleBtn.addEventListener("click", () => {
    card.hidden = !card.hidden;
  });

  if (typeof firebase === "undefined" || !firebase.auth) return;

  firebase.auth().onAuthStateChanged((user) => {
    if (!user) {
      card.hidden = true;
      codeInput.value = "";
      renderEncryptionQr("");
      return;
    }

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
        // resolveDeviceKeyForBoot always ends with a working key already
        // stored on this device — reading it back is simpler than
        // plumbing the raw base64 through every branch that produced it.
        codeInput.value = localStorage.getItem(encKeyStorageKey(user.uid)) || "";
        renderEncryptionQr(codeInput.value);
      })
      .catch((error) => console.error("Failed to load decryption code:", error));
  });
}

// Draws the code as a QR, scannable back in on another device (see
// encryption.js's promptForDecryptionCode). Does nothing if the
// qrcode-generator script didn't load, leaving just the text code.
function renderEncryptionQr(code) {
  const container = document.getElementById("encryption-code-qr");
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

// Rises from the bottom of the screen in place of window.confirm, for the
// two destructive actions below. requireEmail additionally requires typing
// the signed-in account's own email before the confirm button enables.
function showConfirmDialog({ title, message, confirmLabel, requireEmail }) {
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
    const animate = window.animationsEnabled();
    if (!animate) {
      dialog.classList.add("confirm-dialog--instant");
      overlay.classList.add("confirm-dialog-overlay--instant");
    }
    void dialog.offsetWidth; // force reflow so the entrance transition below actually plays
    dialog.classList.add("confirm-dialog--visible");
    overlay.classList.add("confirm-dialog-overlay--visible");
    if (!animate) {
      void dialog.offsetWidth; // commit the instant state before re-enabling the transition
      dialog.classList.remove("confirm-dialog--instant");
      overlay.classList.remove("confirm-dialog-overlay--instant");
    }

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!window.animationsEnabled()) {
        overlay.remove();
        return;
      }
      // Reverses the entrance transition above (same pattern as the
      // other modals' own closeModal).
      dialog.classList.remove("confirm-dialog--visible");
      overlay.classList.remove("confirm-dialog-overlay--visible");
      setTimeout(() => overlay.remove(), 250);
    }

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

// Same bottom-center toast as shared.js's showSignInToast — this page
// doesn't load shared.js, so it's its own copy of the same function.
let sharedToastEl = null;
let sharedToastHideTimer = null;
const SHARED_TOAST_VISIBLE_MS = 4000;

function showToast(message) {
  if (!sharedToastEl) {
    sharedToastEl = document.createElement("div");
    sharedToastEl.className = "signin-toast";
    document.body.appendChild(sharedToastEl);
    void sharedToastEl.offsetWidth; // force reflow so the entrance below actually transitions
  }

  sharedToastEl.textContent = message;
  sharedToastEl.classList.add("signin-toast--visible");
  clearTimeout(sharedToastHideTimer);
  sharedToastHideTimer = setTimeout(() => {
    sharedToastEl.classList.remove("signin-toast--visible");
  }, SHARED_TOAST_VISIBLE_MS);
}

function currentUserOrWarn() {
  const user = auth.currentUser;
  if (!user) {
    showToast("Sign in to the account you want to delete.");
    return null;
  }
  return user;
}

// Wipes everything except the doc's identity and email. A plain (non-merge)
// .set() — merge:true would deep-merge nested map fields instead of
// clearing them, leaving the old content untouched.
function deleteAllData() {
  const user = currentUserOrWarn();
  if (!user) return;

  firebase
    .firestore()
    .collection("users")
    .doc(user.uid)
    .set({ email: user.email || "", lastModified: Date.now() })
    .then(() => {
      // The local appData/preferences caches still hold the old data —
      // clear them so the optimistic instant-render elsewhere doesn't
      // show it again.
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
function deleteAccount() {
  const user = currentUserOrWarn();
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
      // Clears both caches immediately so the redirect below doesn't
      // briefly show this now-deleted account's stale data.
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

function initDangerActions() {
  const deleteDataBtn = document.getElementById("delete-all-data-btn");
  const deleteAccountBtn = document.getElementById("delete-account-btn");

  if (deleteDataBtn) {
    deleteDataBtn.addEventListener("click", () => {
      showConfirmDialog({
        title: "Delete all data?",
        message: "Delete all your grades, courses, and GPA data? This can't be undone. You'll stay signed in.",
        confirmLabel: "Delete all data",
      }).then((confirmed) => {
        if (confirmed) deleteAllData();
      });
    });
  }

  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener("click", () => {
      if (!currentUserOrWarn()) return;
      showConfirmDialog({
        title: "Delete account?",
        message:
          "Permanently delete your account and all of its data? This can't be undone—you'll need to create a new account.",
        confirmLabel: "Delete account",
        requireEmail: true,
      }).then((confirmed) => {
        if (confirmed) deleteAccount();
      });
    });
  }
}

initSettingsControls();
initLoginKeys();
initDangerActions();
