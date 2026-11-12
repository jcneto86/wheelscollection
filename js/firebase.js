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
  getCountFromServer,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import {
  COLLECTIONS_NAME,
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
 * Real-time subscription for one user, ordered newest first.
 *
 * `pageSize` limits how many documents are fetched (smart/paginated loading).
 * Pass `0` to fetch everything — that is the "hybrid" mode used while a search
 * or filter is active.
 *
 * The callback receives `(items, meta)` where `meta.hasMore` tells the caller
 * whether the page came back full (so another page may exist).
 *
 * Requires the composite index `userId ASC, createdAt DESC`.
 */
export function subscribeToItems(userId, onItems, onError, { pageSize = 0 } = {}) {
  const database = requireDb();
  const size = Number(pageSize) > 0 ? Number(pageSize) : 0;

  const constraints = [
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
  ];
  if (size > 0) constraints.push(limit(size));

  const itemsQuery = query(
    collection(database, COLLECTION_NAME),
    ...constraints,
  );

  return onSnapshot(
    itemsQuery,
    (snapshot) => {
      const items = snapshot.docs.map(mapDocument);
      onItems(items, {
        limit: size,
        hasMore: size > 0 && snapshot.size === size,
      });
    },
    (error) => {
      console.error('[firestore] Collection subscription error:', error);
      if (typeof onError === 'function') {
        onError(error);
      }
    },
  );
}

/**
 * One-shot read used when a detail/edit deep link points at a car that is not
 * in the paginated window. Costs a single document read.
 */
export async function getItemById(userId, itemId) {
  const database = requireDb();
  const snapshot = await getDoc(doc(database, COLLECTION_NAME, itemId));

  if (!snapshot.exists()) return null;

  const item = mapDocument(snapshot);
  if (item.userId !== userId) return null;

  return item;
}

/**
 * Total number of cars owned by the user.
 * Aggregation queries bill ~1 read per 1,000 documents scanned.
 */
export async function countItems(userId) {
  const database = requireDb();
  const snapshot = await getCountFromServer(
    query(
      collection(database, COLLECTION_NAME),
      where('userId', '==', userId),
    ),
  );

  return snapshot.data().count;
}

/**
 * Per-collection counters for the filter dropdown.
 * The "no collection" bucket is derived from the total, which also covers
 * legacy documents that have no `collectionId` field at all.
 */
export async function countItemsByCollection(userId, collectionIds) {
  const database = requireDb();
  const ids = [...new Set(collectionIds)].filter(Boolean);

  const [total, ...counts] = await Promise.all([
    countItems(userId),
    ...ids.map(async (collectionId) => {
      const snapshot = await getCountFromServer(
        query(
          collection(database, COLLECTION_NAME),
          where('userId', '==', userId),
          where('collectionId', '==', collectionId),
        ),
      );
      return [collectionId, snapshot.data().count];
    }),
  ]);

  const byId = Object.fromEntries(counts);
  const linked = counts.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  byId[''] = Math.max(0, total - linked);

  return { counts: byId, total };
}

export async function createItem({
  userId,
  name,
  description,
  imageBase64,
  collectionId = '',
  specialEdition = false,
}) {
  const database = requireDb();
  const reference = await addDoc(collection(database, COLLECTION_NAME), {
    userId,
    name,
    description,
    imageBase64,
    collectionId,
    specialEdition: Boolean(specialEdition),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return reference.id;
}

export async function updateItem(
  itemId,
  { name, description, imageBase64, collectionId = '', specialEdition = false },
) {
  const database = requireDb();
  const changes = {
    name,
    description,
    collectionId,
    specialEdition: Boolean(specialEdition),
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

/* -------------------------------------------------------------------------- */
/* Managed collections (name + year)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Real-time subscription to the signed-in user's collections.
 * Ordering is done client-side (newest year first, then name).
 */
export function subscribeToCollections(userId, onCollections, onError) {
  const database = requireDb();
  const collectionsQuery = query(
    collection(database, COLLECTIONS_NAME),
    where('userId', '==', userId),
  );

  return onSnapshot(
    collectionsQuery,
    (snapshot) => {
      const collections = snapshot.docs.map(mapCollectionDocument);

      collections.sort((a, b) => {
        if (b.year !== a.year) return b.year - a.year;
        return a.name.localeCompare(b.name);
      });

      onCollections(collections);
    },
    (error) => {
      console.error('[firestore] Collections subscription error:', error);
      if (typeof onError === 'function') {
        onError(error);
      }
    },
  );
}

export async function createCollection({ userId, name, year }) {
  const database = requireDb();
  const reference = await addDoc(collection(database, COLLECTIONS_NAME), {
    userId,
    name,
    year,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return reference.id;
}

export async function updateCollection(collectionId, { name, year }) {
  const database = requireDb();
  await updateDoc(doc(database, COLLECTIONS_NAME, collectionId), {
    name,
    year,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCollection(collectionId) {
  const database = requireDb();
  await deleteDoc(doc(database, COLLECTIONS_NAME, collectionId));
}

/**
 * Removes the collection link from the given cars without deleting them.
 * Batched to stay within Firestore's 500-operation limit.
 */
export async function unlinkCollectionFromItems(itemIds) {
  const database = requireDb();
  const ids = [...new Set(itemIds)].filter(Boolean);
  const chunkSize = 400;

  for (let start = 0; start < ids.length; start += chunkSize) {
    const batch = writeBatch(database);
    ids.slice(start, start + chunkSize).forEach((itemId) => {
      batch.update(doc(database, COLLECTION_NAME, itemId), { collectionId: '' });
    });
    await batch.commit();
  }
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
    collectionId: String(data.collectionId || ''),
    specialEdition: Boolean(data.specialEdition),
    createdAt: created,
    createdAtMs: created ? created.getTime() : null,
    updatedAt: updated,
    updatedAtMs: updated ? updated.getTime() : null,
  };
}

function mapCollectionDocument(snapshot) {
  const data = snapshot.data() || {};
  const created = toDate(data.createdAt);
  const updated = toDate(data.updatedAt);

  return {
    id: snapshot.id,
    userId: String(data.userId || ''),
    name: String(data.name || ''),
    year: Number(data.year) || 0,
    createdAt: created,
    updatedAt: updated,
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
