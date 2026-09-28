// Google sign-in, shown top-right of the tab bar on every page.
// signInWithPopup opens Google's own account chooser for whatever Google
// accounts are already signed into the browser — no typing an email or
// password.
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

// Purely cosmetic — reveals the Assessments nav tab for these accounts.
// The actual write access is enforced server-side in firestore.rules
const ADMIN_EMAILS = ["hajunk105@gmail.com", "hjkim29@kis.ac"];

const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();

// Lets the admin tab show up immediately from the last known state instead
// of waiting on Firebase's async onAuthStateChanged; corrected as soon as
// that resolves (see updateAdminTabVisibility below).
const ADMIN_TAB_CACHE_KEY = "isAdminGuess";

function setAdminTabDisplay(isAdmin) {
  document.querySelectorAll(".tab--admin-only").forEach((tab) => {
    // Clearing the inline style (display: "") would just fall back to the
    // CSS class rule below (.tab--admin-only { display: none }), which is
    // still in effect — needs an explicit non-none value to actually show.
    // "inline" matches the other <a class="tab"> elements' own default
    // display (they're flex items of .tab-bar regardless of this value).
    tab.style.display = isAdmin ? "inline" : "none";
  });
}

try {
  setAdminTabDisplay(localStorage.getItem(ADMIN_TAB_CACHE_KEY) === "true");
} catch (error) {
  // ignore — private browsing / storage disabled
}

// Hidden by default (see .tab--admin-only in nav.css) so a first-ever
// visit — nothing cached yet — never shows it flash before auth resolves.
function updateAdminTabVisibility(user) {
  const isAdmin = Boolean(user && ADMIN_EMAILS.includes(user.email));
  try {
    localStorage.setItem(ADMIN_TAB_CACHE_KEY, isAdmin ? "true" : "false");
  } catch (error) {
    // ignore
  }
  setAdminTabDisplay(isAdmin);
}

// Merged into the user's Firestore doc so it never touches the rest of
// their data. Also updates the local appData cache's email/lastModified,
// otherwise a later non-merge pushDataToCloud() save could overwrite this
// with a stale cached email.
function saveEmailToFirestore(user) {
  if (typeof firebase === "undefined" || !firebase.firestore) return;
  const timestamp = Date.now();

  try {
    const key = `cachedAppData_${user.uid}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      const cached = JSON.parse(raw);
      cached.email = user.email;
      cached.lastModified = timestamp;
      localStorage.setItem(key, JSON.stringify(cached));
    }
  } catch (error) {
    // ignore — shouldn't block sign-in
  }

  firebase
    .firestore()
    .collection("users")
    .doc(user.uid)
    .set({ email: user.email, lastModified: timestamp }, { merge: true })
    .catch((error) => console.error("Failed to save email:", error));
}

// The one open account-menu dropdown, if any — { avatarBtn, menu }.
// Appended straight to <body> as a position: fixed element rather than
// nested under the avatar (see openAuthMenu) — .tab-bar itself clips
// overflow-y for its own sideways-scroll, which would otherwise cut the
// dropdown off before it ever got to hang below the bar.
let currentAuthMenu = null;

function positionAuthMenu(avatarBtn, menu) {
  const rect = avatarBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 8}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
}

// label -> what clicking it does. My Courses/Settings/Login Keys each open
// their own popup (see my-courses.js/settings-modal.js) — guarded with
// typeof defensively, since not every page loads the script that defines
// one (e.g. the admin-only pages never load my-courses.js).
function buildAuthMenuItem(label, onClick) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "popup-menu-item";
  item.textContent = label;
  item.addEventListener("click", () => {
    closeAuthMenu();
    onClick();
  });
  return item;
}

function openAuthMenu(avatarBtn) {
  closeAuthMenu();

  const menu = document.createElement("div");
  menu.className = "popup-menu";

  if (typeof openMyCoursesModal === "function") {
    menu.appendChild(buildAuthMenuItem("My Courses", openMyCoursesModal));
  }
  if (typeof openSettingsModal === "function") {
    menu.appendChild(buildAuthMenuItem("Settings", openSettingsModal));
  }
  if (typeof openLoginKeysModal === "function") {
    menu.appendChild(buildAuthMenuItem("Login Keys", openLoginKeysModal));
  }
  if (menu.children.length > 0) {
    const divider = document.createElement("div");
    divider.className = "popup-menu-divider";
    menu.appendChild(divider);
  }
  menu.appendChild(buildAuthMenuItem("Sign out", () => auth.signOut()));

  document.body.appendChild(menu);
  positionAuthMenu(avatarBtn, menu);
  currentAuthMenu = { avatarBtn, menu };
  avatarBtn.classList.add("auth-avatar-btn--open");

  void menu.offsetWidth; // force reflow so the entrance transition below actually plays
  menu.classList.add("popup-menu--visible");
}

function closeAuthMenu() {
  if (!currentAuthMenu) return;
  const { avatarBtn, menu } = currentAuthMenu;
  currentAuthMenu = null;
  avatarBtn.classList.remove("auth-avatar-btn--open");
  // Reverses the entrance transition above.
  menu.classList.remove("popup-menu--visible");
  setTimeout(() => menu.remove(), 150);
}

document.addEventListener("click", (event) => {
  if (!currentAuthMenu) return;
  if (currentAuthMenu.avatarBtn.contains(event.target) || currentAuthMenu.menu.contains(event.target)) return;
  closeAuthMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && currentAuthMenu) closeAuthMenu();
});

function renderAuthUI(user) {
  updateAdminTabVisibility(user);

  const container = document.querySelector(".auth-container");
  if (!container) return;
  container.innerHTML = "";
  // The avatar button about to be destroyed above can't stay associated
  // with an open menu.
  closeAuthMenu();

  if (user) {
    saveEmailToFirestore(user);

    const avatar = document.createElement("img");
    avatar.className = "auth-avatar";
    // Google's image host is known to refuse requests carrying some
    // referrers (localhost included) — none sent, none to refuse. Set before
    // src so the very first request already goes out without one.
    avatar.referrerPolicy = "no-referrer";
    avatar.src = user.photoURL || TRANSPARENT_GIF;
    avatar.alt = user.displayName || user.email || "";

    const avatarBtn = document.createElement("button");
    avatarBtn.type = "button";
    avatarBtn.className = "auth-avatar-btn";
    avatarBtn.setAttribute("aria-label", "Account menu");
    avatarBtn.appendChild(avatar);
    // Not stopping the click here, so other open menus (like the Calendar's +
    // menu) see it and close; the document handler below skips this button.
    avatarBtn.addEventListener("click", () => {
      if (currentAuthMenu && currentAuthMenu.avatarBtn === avatarBtn) closeAuthMenu();
      else openAuthMenu(avatarBtn);
    });

    container.appendChild(avatarBtn);
  } else {
    const signInBtn = document.createElement("button");
    signInBtn.type = "button";
    signInBtn.className = "auth-signin-btn";
    // The standard 4-color "G" mark — same in both themes, so no
    // light/dark icon swap needed like the rest of the app's icons.
    signInBtn.innerHTML =
      '<svg class="auth-signin-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path fill="#4285F4" d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.8741 2.6836-6.615z"/>' +
      '<path fill="#34A853" d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"/>' +
      '<path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.964 10.71z"/>' +
      '<path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"/>' +
      "</svg>" +
      "<span>Sign in with Google</span>";
    signInBtn.addEventListener("click", () => {
      auth.signInWithPopup(googleProvider).catch((error) => {
        console.error("Google sign-in failed:", error);
      });
    });

    container.appendChild(signInBtn);
  }
}

auth.onAuthStateChanged(renderAuthUI);
