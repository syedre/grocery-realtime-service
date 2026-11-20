import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function firebaseReady() {
  return getApps().length > 0;
}

export function initializeFirebaseAdmin() {
  if (firebaseReady()) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn("Firebase Admin is not configured; admin push notifications are disabled.");
    return;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON.");
  }
  initializeApp({ credential: cert(serviceAccount) });
}

export function firestore() {
  if (!firebaseReady()) throw new Error("Firebase Admin is not configured.");
  return getFirestore();
}
