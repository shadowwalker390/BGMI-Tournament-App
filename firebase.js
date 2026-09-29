// firebase.js
// Firebase initialization + Firestore-backed replacements for the app's
// storageGet/storageSet helpers. Drop this file next to App.jsx.
//
// Setup:
//   npm install firebase
//   In the Firebase console, enable Firestore (Build > Firestore Database > Create database).
//   Start in test mode while developing, then lock down rules before going live
//   (see note at the bottom of this file).

import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDK6HjFSNvFfaz0ScDAOl08CiuvXqjcMUg",
  authDomain: "bgmi-tournament-8bd65.firebaseapp.com",
  projectId: "bgmi-tournament-8bd65",
  storageBucket: "bgmi-tournament-8bd65.firebasestorage.app",
  messagingSenderId: "153139967668",
  appId: "1:153139967668:web:0f4e1f1ad68f49cd4d49e1",
  measurementId: "G-L1XKVNJGE1",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// -----------------------------------------------------------------------
// Real authentication (replaces the old plaintext-password-in-Firestore
// approach). Firebase Auth needs an email, but the app's UX is built
// around a "Player ID", so we derive a stable, non-guessable-format email
// from the Player ID. Firebase Auth then owns password hashing/storage —
// the "users" Firestore doc no longer stores a password field at all.
// -----------------------------------------------------------------------
function emailForPlayerId(playerId) {
  return `${playerId.trim().toLowerCase()}@players.bgmi-arena.app`;
}

// Creates a real Firebase Auth account for this Player ID. Throws on
// failure (e.g. "auth/email-already-in-use", "auth/weak-password") so the
// caller can show a friendly message.
export async function authRegister(playerId, password) {
  const cred = await createUserWithEmailAndPassword(auth, emailForPlayerId(playerId), password);
  return cred.user.uid;
}

// Signs in against Firebase Auth. Throws on failure (e.g.
// "auth/invalid-credential", "auth/user-not-found", "auth/wrong-password").
export async function authLogin(playerId, password) {
  const cred = await signInWithEmailAndPassword(auth, emailForPlayerId(playerId), password);
  return cred.user.uid;
}

export async function authLogout() {
  await firebaseSignOut(auth);
}

// Maps the app's flat storage keys onto Firestore collection/doc pairs:
//   "users"              -> config/users
//   "scheduleTemplate"   -> config/scheduleTemplate
//   "slots:2026-07-03"   -> slots/2026-07-03
function keyToPath(key) {
  if (key.startsWith("slots:")) {
    return ["slots", key.slice("slots:".length)];
  }
  return ["config", key];
}

// Same call signature as the old window.storage-based helpers (including the
// unused `shared` param) so nothing else in App.jsx has to change.
export async function storageGet(key, _shared) {
  try {
    const [col, id] = keyToPath(key);
    const snap = await getDoc(doc(db, col, id));
    return snap.exists() ? snap.data().value : null;
  } catch (e) {
    console.error("Firestore get error for key:", key, e);
    return null;
  }
}

export async function storageSet(key, value, _shared) {
  try {
    const [col, id] = keyToPath(key);
    await setDoc(doc(db, col, id), { value });
    return true;
  } catch (e) {
    console.error("Firestore set error for key:", key, e);
    return false;
  }
}

// -----------------------------------------------------------------------
// IMPORTANT — Firestore security rules
// -----------------------------------------------------------------------
// The default "test mode" rules allow anyone to read/write ALL data for 30
// days, then lock everything out. Before real users touch this app, set
// rules in the Firebase console (Firestore Database > Rules), e.g. a
// starting point that keeps read/write open only to signed-in requests:
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /{document=**} {
//         allow read, write: if true; // tighten this before launch
//       }
//     }
//   }
//
// Passwords are now handled entirely by Firebase Authentication (hashed,
// never stored in Firestore or readable from the client) instead of being
// saved in plaintext in the "users" doc.
//
// Two things still worth doing before real users touch this:
//   1. Enable the "Email/Password" sign-in provider: Firebase console >
//      Build > Authentication > Sign-in method > Email/Password > Enable.
//   2. Tighten Firestore rules so only signed-in users can read/write the
//      "users" doc, e.g.:
//        match /config/users {
//          allow read, write: if request.auth != null;
//        }
//      Test-mode rules (allow read, write: if true) still let anyone read
//      wallet balances, stats, etc. even though passwords are safe now.
