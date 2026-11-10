// @ts-nocheck -- Firebase is imported from gstatic URLs that TypeScript cannot resolve offline.
import { initializeApp, getApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import {
  COLLECTION_NAME,
  firebaseConfig,
  isFirebaseConfigured,
} from './firebase-config.js';

export const isConfigured = isFirebaseConfigured();

let app = null;
let auth = null;
let db = null;

if (isConfigured) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  // Keep the session in the browser across reloads. This is the default,
  // but setting it explicitly also documents the intended behaviour.
  setPersistence(auth, browserLocalPersistence).catch((error) => {
    console.warn('[firebase] Could not set auth persistence:', error);
  });
}

function requireAuth() {
  if (!auth) {
    throw new Error('firebase/not-configured');
  }
  return auth;
}

function requireDb() {
  if (!db) {
    throw new Error('firebase/not-configured');
  }
  return db;
}

/**
 * Subscribes to the Firebase Auth state.
 * Returns an unsubscribe function.
 */
export function observeAuth(onUser, onError) {
  if (!auth) {
    // Defer so the caller can finish its setup before receiving the state.
    queueMicrotask(() => onUser(null));
    return () => {};
  }

  return onAuthStateChanged(
    auth,
    (user) => onUser(user),
    (error) => {
      console.error('[firebase] Auth state error:', error);
      if (typeof onError === 'function') {
        onError(error);
      }
      onUser(null);
    },
  );
}

export async function signInUser(email, password) {
  const credential = await signInWithEmailAndPassword(
    requireAuth(),
    email,
    password,
  );
  return credential.user;
}

export async function registerUser(name, email, password) {
  const credential = await createUserWithEmailAndPassword(
    requireAuth(),
    email,
    password,
  );

  const cleanName = String(name || '').trim();
  if (cleanName) {
    await updateProfile(credential.user, { displayName: cleanName });
  }

  return credential.user;
}

export async function sendResetEmail(email) {
  await sendPasswordResetEmail(requireAuth(), email);
}

export async function signOutUser() {
  await signOut(requireAuth());
}

/**
 * Real-time collection subscription for one user.
 *
 * The query only filters by `userId` so no composite index is required.
 * Ordering is done client-side by creation date (newest first).
 */
export function subscribeToItems(userId, onItems, onError) {
  const database = requireDb();
  const itemsQuery = query(
    collection(database, COLLECTION_NAME),
    where('userId', '==', userId),
  );

  return onSnapshot(
    itemsQuery,
    (snapshot) => {
      const items = snapshot.docs.map(mapDocument);

      items.sort((a, b) => {
        const aTime = a.createdAtMs ?? 0;
        const bTime = b.createdAtMs ?? 0;
        return bTime - aTime;
      });

      onItems(items);
    },
    (error) => {
      console.error('[firestore] Collection subscription error:', error);
      if (typeof onError === 'function') {
        onError(error);
      }
    },
  );
}

export async function createItem({
  userId,
  name,
  description,
  imageBase64,
}) {
  const database = requireDb();
  const reference = await addDoc(collection(database, COLLECTION_NAME), {
    userId,
    name,
    description,
    imageBase64,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return reference.id;
}

export async function updateItem(
  itemId,
  { name, description, imageBase64 },
) {
  const database = requireDb();
  const changes = {
    name,
    description,
    updatedAt: serverTimestamp(),
  };

  if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
    changes.imageBase64 = imageBase64;
  }

  await updateDoc(doc(database, COLLECTION_NAME, itemId), changes);
}

export async function deleteItem(itemId) {
  const database = requireDb();
  await deleteDoc(doc(database, COLLECTION_NAME, itemId));
}

function mapDocument(snapshot) {
  const data = snapshot.data() || {};
  const created = toDate(data.createdAt);
  const updated = toDate(data.updatedAt);

  return {
    id: snapshot.id,
    userId: String(data.userId || ''),
    name: String(data.name || ''),
    description: String(data.description || ''),
    imageBase64: String(data.imageBase64 || ''),
    createdAt: created,
    createdAtMs: created ? created.getTime() : null,
    updatedAt: updated,
    updatedAtMs: updated ? updated.getTime() : null,
  };
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
