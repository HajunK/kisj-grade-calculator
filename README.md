# Grade Calculator

The KISJ grade calculator with per-user classes and assignments, stored in Firebase.

## Structure

```
public/
	index.html          Single-page app shell
	css/style.css        Styling
	js/firebase-config.js  Your Firebase project config (fill in your own keys)
	js/auth.js            Sign in / sign out with Google
	js/calculator.js       Pure grade math (weighted + simple average, letter grades)
	js/app.js              DOM <-> Firestore wiring
firebase.json           Hosting + Firestore config
firestore.rules         Security rules (users can only access their own data)
firestore.indexes.json  Firestore index config (empty for now)
.firebaserc              Firebase project alias
```

## Data model (Firestore)

```
users/{uid}/classes/{classId}
	name: string
	createdAt: timestamp

users/{uid}/classes/{classId}/assignments/{assignmentId}
	name: string
	score: number
	total: number
	weight: number | null   (percent weight, e.g. "Exams" = 40)
	createdAt: timestamp
```

## Setup

1. Create a project at https://console.firebase.google.com
2. Enable **Authentication** > Sign-in method > Google
3. Enable **Firestore Database** (start in production mode; rules are already provided)
4. In Project Settings > General > Your apps, add a Web app and copy the config
   into [public/js/firebase-config.js](public/js/firebase-config.js)
5. Replace `YOUR_PROJECT_ID` in [.firebaserc](.firebaserc)
6. Install the Firebase CLI if you don't have it: `npm install -g firebase-tools`
7. Log in: `firebase login`
8. Deploy rules: `firebase deploy --only firestore:rules`
9. Run locally: `firebase emulators:start --only hosting` (or just open `public/index.html`
   directly in a browser, though auth popups work best served over http/https)
10. Deploy: `firebase deploy`


## Run Commands

- npx serve -l 8000: run server on http://localhost:8000
- firebase deploy: deploy server to Firebase