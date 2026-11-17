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
  deleteUser,
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

// Deletes the account that is currently signed in. Used right after
// registration if it turns out a profile already exists for that Player ID,
// so nobody can hijack an existing profile (e.g. the admin's) by registering
// the same Player ID first.
export async function authDeleteCurrentUser() {
  if (auth.currentUser) await deleteUser(auth.currentUser);
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
// Firestore security rules
// -----------------------------------------------------------------------
// The rules live in firestore.rules (next to this file). Paste its contents
// into Firebase console > Firestore Database > Rules and click Publish.
//
// Also required: enable the "Email/Password" provider under
// Build > Authentication > Sign-in method.
//
// Known limits of rules-only protection (single-doc "users" design):
//   - Any signed-in player can read the whole users doc (including other
//     players' mobile numbers and UIDs).
//   - A player can still edit their own wallet balance. Fully trusted
//     balances need server-side code (Cloud Functions).
