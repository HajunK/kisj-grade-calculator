// Posts admin page: create/delete the admin-authored posts shown on
// Domain, below the class cards (see renderDomainPosts in domain.js).
// Read is public in firestore.rules; the page-level gating below is only
// cosmetic — the actual write restriction is server-side, admin-email
// only.
//
// Doesn't load shared.js/boot.js, so it duplicates nothing date-related
// (posts have no date of their own) — same reasoning as
// assessments-admin.js/suggestions-admin.js staying standalone.

let postsInitialized = false;
let allPosts = [];

function fetchPosts(callback) {
  firebase
    .firestore()
    .collection("posts")
    .get()
    .then((snapshot) => {
      allPosts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (callback) callback();
    })
    .catch((error) => {
      console.error("Failed to load posts:", error);
      // Otherwise the spinner just spins forever with no indication
      // anything went wrong (most likely cause: firestore.rules' posts
      // rule hasn't actually been deployed yet).
      const loading = document.getElementById("posts-loading");
      const empty = document.getElementById("posts-empty");
      if (loading) loading.hidden = true;
      if (empty) {
        empty.textContent = "Something went wrong loading posts. Please refresh the page.";
        empty.hidden = false;
      }
    });
}

// Optimistic — removed from the list and re-rendered before the delete
// actually completes, same convention as Assessments'/Suggestions' own
// admin delete actions.
function deletePost(post) {
  const index = allPosts.findIndex((entry) => entry.id === post.id);
  if (index !== -1) {
    allPosts.splice(index, 1);
    renderPosts();
  }

  firebase
    .firestore()
    .collection("posts")
    .doc(post.id)
    .delete()
    .catch((error) => {
      console.error("Failed to delete post:", error);
      alert("Something went wrong deleting that post. Please try again.");
      if (index !== -1) {
        allPosts.splice(index, 0, post);
        renderPosts();
      }
    });
}

function buildPostEntry(post) {
  const li = document.createElement("li");
  li.className = "posts-entry";

  const content = document.createElement("div");
  content.className = "posts-entry-content";

  const title = document.createElement("span");
  title.className = "posts-entry-title";
  title.textContent = post.title;
  content.appendChild(title);

  const body = document.createElement("p");
  body.className = "posts-entry-body";
  body.textContent = post.body;
  content.appendChild(body);

  if (post.linkUrl) {
    const link = document.createElement("a");
    link.className = "posts-entry-link";
    link.href = post.linkUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = post.linkUrl;
    content.appendChild(link);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "admin-day-entry-delete";
  deleteBtn.setAttribute("aria-label", "Delete post");
  deleteBtn.textContent = "×";
  deleteBtn.addEventListener("click", () => deletePost(post));

  li.append(content, deleteBtn);
  return li;
}

function renderPosts() {
  const loading = document.getElementById("posts-loading");
  const empty = document.getElementById("posts-empty");
  const list = document.getElementById("posts-entry-list");

  loading.hidden = true;
  list.innerHTML = "";

  if (allPosts.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    return;
  }

  empty.hidden = true;
  list.hidden = false;

  // Newest first — matches how they're shown on Domain.
  allPosts
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .forEach((post) => list.appendChild(buildPostEntry(post)));
}

function initPostsPage() {
  const form = document.getElementById("posts-add-form");
  const titleInput = document.getElementById("posts-title-input");
  const bodyInput = document.getElementById("posts-body-input");
  const linkInput = document.getElementById("posts-link-input");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    const linkUrl = linkInput.value.trim();
    if (!title || !body) {
      alert("A post needs both a title and a body.");
      return;
    }

    const post = { title, body, createdAt: Date.now() };
    if (linkUrl) post.linkUrl = linkUrl;

    firebase
      .firestore()
      .collection("posts")
      .add(post)
      .then((docRef) => {
        allPosts.push({ id: docRef.id, ...post });
        renderPosts();
        titleInput.value = "";
        bodyInput.value = "";
        linkInput.value = "";
        titleInput.focus();
      })
      .catch((error) => {
        console.error("Failed to add post:", error);
        alert("Something went wrong adding that post. Please try again.");
      });
  });

  fetchPosts(renderPosts);
}

// Purely cosmetic — the real gate is firestore.rules, checking the same
// email server-side for the add/delete writes themselves.
function handlePostsAuthState(user) {
  const isAdmin = Boolean(user && ADMIN_EMAILS.includes(user.email));
  document.getElementById("admin-not-authorized").hidden = isAdmin;
  document.getElementById("posts-layout").hidden = !isAdmin;

  if (isAdmin && !postsInitialized) {
    postsInitialized = true;
    initPostsPage();
  }
}

auth.onAuthStateChanged(handlePostsAuthState);
