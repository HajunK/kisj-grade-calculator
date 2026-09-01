// Client-side encryption for the grade data (domainScores, gpaClasses,
// domainSnapshot) — Firestore only ever stores these as ciphertext.
// periods/preferences/email stay plaintext.
//
// The key is a random 256-bit AES-GCM key, generated once per (device,
// account) and kept only in this browser's localStorage — never sent
// anywhere else. A brand new account gets a key generated silently.
// Signing in on a device that doesn't already have the key, where
// Firestore already holds encrypted data, blocks on a mandatory prompt
// (promptForDecryptionCode, invoked from boot.js) for the code shown in
// Settings on the original device. If that code is lost, the data is
// permanently unreadable.

const ENCRYPTED_FIELDS = ["domainScores", "gpaClasses", "domainSnapshot"];

function encKeyStorageKey(uid) {
  return `encKey_${uid}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// One CryptoKey per uid, cached in memory as a Promise so concurrent
// callers share the same import instead of racing separate ones.
const deviceKeyCache = {};

function getDeviceKey(uid) {
  if (deviceKeyCache[uid]) return deviceKeyCache[uid];

  const storageKey = encKeyStorageKey(uid);
  let rawBase64 = localStorage.getItem(storageKey);
  if (!rawBase64) {
    rawBase64 = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(storageKey, rawBase64);
  }

  const promise = crypto.subtle.importKey("raw", base64ToBytes(rawBase64), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  deviceKeyCache[uid] = promise;
  return promise;
}

// Encrypts one JSON-serializable value into a single opaque string: a
// fresh random 12-byte IV followed by the ciphertext, both base64'd
// together so it fits in one Firestore string field.
function encryptValue(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext).then((ciphertext) => {
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return bytesToBase64(combined);
  });
}

// Reverses encryptValue. Two other shapes are returned as-is rather than
// treated as errors: undefined/null (field doesn't exist yet), and a real
// object/array (a pre-encryption document, still plaintext — the next
// save re-writes it encrypted). Anything that fails to decrypt falls back
// to fallbackValue instead of throwing.
function decryptValue(key, stored, fallbackValue) {
  if (stored === undefined || stored === null) return Promise.resolve(fallbackValue);
  if (typeof stored !== "string") return Promise.resolve(stored);

  let combined;
  try {
    combined = base64ToBytes(stored);
  } catch {
    return Promise.resolve(fallbackValue);
  }

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  return crypto.subtle
    .decrypt({ name: "AES-GCM", iv }, key, ciphertext)
    .then((plaintext) => JSON.parse(new TextDecoder().decode(plaintext)))
    .catch(() => fallbackValue);
}

// Shallow copy of appData with the grade fields swapped for their
// encrypted strings — everything else passes through untouched.
function encryptAppDataForCloud(data, key) {
  return Promise.all(ENCRYPTED_FIELDS.map((field) => encryptValue(key, data[field]))).then((encryptedValues) => {
    const encrypted = { ...data };
    ENCRYPTED_FIELDS.forEach((field, i) => {
      encrypted[field] = encryptedValues[i];
    });
    return encrypted;
  });
}

function hasStoredDeviceKey(uid) {
  return !!localStorage.getItem(encKeyStorageKey(uid));
}

// jsQR is ~257KB unminified — loaded on demand rather than on every page
// load, only once promptForDecryptionCode actually runs.
let jsQrLoadPromise = null;
function ensureJsQrLoaded() {
  if (typeof jsQR === "function") return Promise.resolve();
  if (jsQrLoadPromise) return jsQrLoadPromise;

  jsQrLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "js/vendor/jsQR.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load jsQR"));
    document.head.appendChild(script);
  });
  return jsQrLoadPromise;
}

// Like decryptValue, but rejects instead of falling back to a default —
// used to test whether a candidate key is actually the right one, so a
// wrong code can be reported back to the person typing it.
function decryptValueOrThrow(key, stored) {
  const combined = base64ToBytes(stored);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  return crypto.subtle
    .decrypt({ name: "AES-GCM", iv }, key, ciphertext)
    .then((plaintext) => JSON.parse(new TextDecoder().decode(plaintext)));
}

// Turns a user-typed decryption code into a CryptoKey. Doesn't store or
// cache anything — the caller persists it via storeDeviceKey once
// confirmed.
function importKeyFromCode(code) {
  const trimmed = (code || "").replace(/\s+/g, "");
  let bytes;
  try {
    bytes = base64ToBytes(trimmed);
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 32) {
    return Promise.reject(new Error("That doesn't look like a valid decryption code."));
  }

  const normalizedBase64 = bytesToBase64(bytes);
  return crypto.subtle
    .importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
    .then((key) => ({ key, rawBase64: normalizedBase64 }));
}

// Persists a confirmed-working key for uid, and updates the in-memory
// cache getDeviceKey() reads from.
function storeDeviceKey(uid, key, rawBase64) {
  localStorage.setItem(encKeyStorageKey(uid), rawBase64);
  deviceKeyCache[uid] = Promise.resolve(key);
}

// Puts up a full-page, un-dismissable prompt for this account's decryption
// code and resolves with a working CryptoKey once one is entered —
// deliberately no cancel/skip, since continuing with the wrong key would
// overwrite the real encrypted data with near-empty data. cloud is the
// raw Firestore document, used only to verify a typed code opens it.
//
// Two mutually exclusive views: camera scanning (the default) and typing
// the code manually.
function promptForDecryptionCode(uid, cloud) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "decryption-prompt-overlay";
    overlay.innerHTML = `
      <div class="decryption-prompt">
        <h2 class="decryption-prompt-title">Enter your decryption code</h2>
        <p class="decryption-prompt-text">
          Your grades can only be accessed on a device with the decryption code. Find it under Login Keys in Settings on the device you first signed in on.
        </p>

        <div class="decryption-prompt-camera">
          <video class="decryption-prompt-video" playsinline webkit-playsinline muted autoplay></video>
          <button type="button" class="decryption-prompt-use-code-btn">Use decryption code instead</button>
        </div>

        <div class="decryption-prompt-manual" hidden>
          <input
            type="text"
            class="decryption-prompt-input"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Decryption code"
          />
          <p class="decryption-prompt-error" hidden></p>
          <button type="button" class="decryption-prompt-submit">Continue</button>
          <button type="button" class="decryption-prompt-scan-btn">Scan QR code instead</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector(".decryption-prompt");
    const animate = window.animationsEnabled();
    if (!animate) {
      dialog.classList.add("decryption-prompt--instant");
      overlay.classList.add("decryption-prompt-overlay--instant");
    }
    void dialog.offsetWidth; // force reflow so the entrance transition below actually plays
    dialog.classList.add("decryption-prompt--visible");
    overlay.classList.add("decryption-prompt-overlay--visible");
    if (!animate) {
      void dialog.offsetWidth; // commit the instant state before re-enabling the transition
      dialog.classList.remove("decryption-prompt--instant");
      overlay.classList.remove("decryption-prompt-overlay--instant");
    }

    const cameraBox = overlay.querySelector(".decryption-prompt-camera");
    const video = overlay.querySelector(".decryption-prompt-video");
    const useCodeBtn = overlay.querySelector(".decryption-prompt-use-code-btn");

    const manualBox = overlay.querySelector(".decryption-prompt-manual");
    const input = overlay.querySelector(".decryption-prompt-input");
    const errorEl = overlay.querySelector(".decryption-prompt-error");
    const submitBtn = overlay.querySelector(".decryption-prompt-submit");
    const scanBtn = overlay.querySelector(".decryption-prompt-scan-btn");

    const encryptedFieldsPresent = ENCRYPTED_FIELDS.filter((field) => typeof cloud[field] === "string");

    function attempt() {
      errorEl.hidden = true;
      submitBtn.disabled = true;

      importKeyFromCode(input.value)
        .then(({ key, rawBase64 }) =>
          Promise.all(encryptedFieldsPresent.map((field) => decryptValueOrThrow(key, cloud[field]))).then(() => ({
            key,
            rawBase64,
          }))
        )
        .then(({ key, rawBase64 }) => {
          stopScanning();
          storeDeviceKey(uid, key, rawBase64);
          overlay.remove();
          resolve(key);
        })
        .catch(() => {
          errorEl.textContent = "That code doesn't match this account. Check it and try again.";
          errorEl.hidden = false;
          submitBtn.disabled = false;
          input.focus();
          input.select();
        });
    }

    submitBtn.addEventListener("click", attempt);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") attempt();
    });

    // QR scanning: reads camera frames onto an offscreen canvas and hands
    // each to jsQR. A scanned code just fills the input and runs through
    // the same attempt() path as a typed one, so a misread frame fails to
    // decrypt and prompts a retry rather than accepting bad data.
    let scanStream = null;
    let scanFrameHandle = null;
    const scanCanvas = document.createElement("canvas");
    const scanCtx = scanCanvas.getContext("2d");

    function stopScanning() {
      if (scanFrameHandle) cancelAnimationFrame(scanFrameHandle);
      scanFrameHandle = null;
      if (scanStream) scanStream.getTracks().forEach((track) => track.stop());
      scanStream = null;
      cameraBox.hidden = true;
    }

    function scanFrame() {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        scanCanvas.width = video.videoWidth;
        scanCanvas.height = video.videoHeight;
        scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
        const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          input.value = code.data;
          stopScanning();
          attempt();
          return;
        }
      }
      scanFrameHandle = requestAnimationFrame(scanFrame);
    }

    // Switches to the manual-entry view — used by "Cancel scanning", "Use
    // decryption code instead", and as the fallback when scanning isn't
    // available at all.
    function showManualEntry() {
      stopScanning();
      manualBox.hidden = false;
      input.focus();
    }

    function showCameraScanning() {
      errorEl.hidden = true;
      manualBox.hidden = true;
      cameraBox.hidden = false;

      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        showManualEntry();
        return;
      }

      ensureJsQrLoaded()
        .then(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }))
        .then((stream) => {
          scanStream = stream;
          video.srcObject = stream;
          scanFrameHandle = requestAnimationFrame(scanFrame);
        })
        .catch(() => {
          // Scanner failed to load, or camera access denied/unavailable.
          showManualEntry();
        });
    }

    useCodeBtn.addEventListener("click", showManualEntry);
    scanBtn.addEventListener("click", showCameraScanning);

    // Scanning is the default view this prompt opens on.
    showCameraScanning();
  });
}

// Decides how boot.js should get this device's key: silently, if this
// device already has a key or the account has no encrypted data yet —
// otherwise blocks on promptForDecryptionCode.
function resolveDeviceKeyForBoot(uid, cloud) {
  if (hasStoredDeviceKey(uid)) return getDeviceKey(uid);

  const hasExistingEncryptedData = ENCRYPTED_FIELDS.some((field) => typeof cloud[field] === "string");
  if (!hasExistingEncryptedData) return getDeviceKey(uid);

  return promptForDecryptionCode(uid, cloud);
}
