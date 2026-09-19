// Suggestions admin page: lists the school-wide "suggested" collection
// (see my-courses.js's logSuggestedAssessment/unlogSuggestedAssessment) so
// an admin can promote one into the real assessments collection, or
// dismiss it. Read is public in firestore.rules; the page-level gating
// below is only cosmetic — accepting writes to `assessments` (admin-email
// only) and deleting from `suggested` is separately allowed for the admin
// regardless of how many people suggested it.
//
// Doesn't load shared.js/boot.js, so it duplicates the small ISO-date
// helpers rather than depending on assessments-shared.js — same reasoning
// as assessments-admin.js.

function suggestionsFromISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Settings > Date format's own formatter (see preferences.js) — already
// year-less in every one of its formats ("Aug 16", "8/16", "16 Aug", "16/8").
function formatSuggestionDate(iso) {
  return window.formatPreferredDate(suggestionsFromISODate(iso));
}

let suggestionsInitialized = false;
let allSuggestions = [];

function fetchSuggestions(callback) {
  firebase
    .firestore()
    .collection("suggested")
    .get()
    .then((snapshot) => {
      allSuggestions = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (callback) callback();
    })
    .catch((error) => console.error("Failed to load suggestions:", error));
}

// Promotes a suggestion into the real assessments collection, then removes
// it from "suggested" — in that order, so a failure part-way through never
// loses the suggestion without it actually having been added. Optimistic —
// removed from the list and re-rendered before either write completes,
// same as deleteAssessment on the Assessments page.
function acceptSuggestion(suggestion) {
  const index = allSuggestions.findIndex((entry) => entry.id === suggestion.id);
  if (index !== -1) {
    allSuggestions.splice(index, 1);
    renderSuggestions();
  }

  firebase
    .firestore()
    .collection("assessments")
    .add({
      type: suggestion.type,
      date: suggestion.date,
      courseName: suggestion.courseName,
      createdAt: Date.now(),
    })
    .then(() => firebase.firestore().collection("suggested").doc(suggestion.id).delete())
    .catch((error) => {
      console.error("Failed to accept suggestion:", error);
      alert("Something went wrong accepting that suggestion. Please try again.");
      // Put it back — the accept didn't actually go through.
      if (index !== -1) {
        allSuggestions.splice(index, 0, suggestion);
        renderSuggestions();
      }
    });
}

function declineSuggestion(suggestion) {
  const index = allSuggestions.findIndex((entry) => entry.id === suggestion.id);
  if (index !== -1) {
    allSuggestions.splice(index, 1);
    renderSuggestions();
  }

  firebase
    .firestore()
    .collection("suggested")
    .doc(suggestion.id)
    .delete()
    .catch((error) => {
      console.error("Failed to decline suggestion:", error);
      alert("Something went wrong declining that suggestion. Please try again.");
      if (index !== -1) {
        allSuggestions.splice(index, 0, suggestion);
        renderSuggestions();
      }
    });
}

function buildSuggestionRow(suggestion) {
  const row = document.createElement("div");
  row.className = "suggestions-row";

  const dateEl = document.createElement("span");
  dateEl.className = "suggestions-cell suggestions-cell--date";
  dateEl.textContent = formatSuggestionDate(suggestion.date);

  const courseEl = document.createElement("span");
  courseEl.className = "suggestions-cell suggestions-cell--course";
  courseEl.textContent = suggestion.courseName;

  const typeEl = document.createElement("span");
  typeEl.className = "suggestions-cell suggestions-cell--type";
  typeEl.textContent = suggestion.type;

  const emails = suggestion.emails || [];

  const countEl = document.createElement("span");
  countEl.className = "suggestions-cell suggestions-cell--count";
  countEl.textContent = String(emails.length);

  const emailsEl = document.createElement("span");
  emailsEl.className = "suggestions-cell suggestions-cell--emails";
  // Just the username — the domain's the same for everyone at the school
  // and only adds noise here.
  emailsEl.textContent = emails.map((email) => email.split("@")[0]).join(", ");

  const actions = document.createElement("div");
  actions.className = "suggestions-cell suggestions-cell--actions";

  const acceptBtn = document.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.className = "suggestions-accept-btn";
  acceptBtn.textContent = "Accept";
  acceptBtn.addEventListener("click", () => acceptSuggestion(suggestion));

  const declineBtn = document.createElement("button");
  declineBtn.type = "button";
  declineBtn.className = "suggestions-decline-btn";
  declineBtn.textContent = "Decline";
  declineBtn.addEventListener("click", () => declineSuggestion(suggestion));

  actions.append(acceptBtn, declineBtn);
  row.append(dateEl, courseEl, typeEl, countEl, emailsEl, actions);
  return row;
}

function renderSuggestions() {
  const loading = document.getElementById("suggestions-loading");
  const empty = document.getElementById("suggestions-empty");
  const list = document.getElementById("suggestions-list");
  const rows = document.getElementById("suggestions-rows");

  loading.hidden = true;
  rows.innerHTML = "";

  if (allSuggestions.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    return;
  }

  empty.hidden = true;
  list.hidden = false;

  // Earliest date first — the ones coming up soonest matter most.
  allSuggestions
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((suggestion) => rows.appendChild(buildSuggestionRow(suggestion)));
}

function initSuggestionsPage() {
  fetchSuggestions(renderSuggestions);
}

// Date labels are only ever formatted at render time (see
// formatSuggestionDate) — re-render on a Settings > Date format change so
// an already-visible list reflects it immediately instead of on next load.
window.addEventListener("app:preferences-changed", () => {
  if (suggestionsInitialized) renderSuggestions();
});

// Purely cosmetic — the real gate is firestore.rules, checking the same
// email server-side for the accept/decline writes themselves.
function handleSuggestionsAuthState(user) {
  const isAdmin = Boolean(user && ADMIN_EMAILS.includes(user.email));
  document.getElementById("admin-not-authorized").hidden = isAdmin;
  document.getElementById("suggestions-layout").hidden = !isAdmin;

  if (isAdmin && !suggestionsInitialized) {
    suggestionsInitialized = true;
    initSuggestionsPage();
  }
}

auth.onAuthStateChanged(handleSuggestionsAuthState);
