/**
 * Firebase configuration for the web app.
 *
 * These values are public by design in any client-side Firebase app.
 * Data protection is enforced by Firestore Security Rules, never by
 * hiding the API key.
 *
 * You can copy the values from:
 * Firebase Console > Project settings > General > Your apps > Web app.
 *
 * The values below were pre-filled from the existing Flutter project
 * (app_config.env). Replace them if you use a different Firebase project.
 */
export const firebaseConfig = Object.freeze({
  apiKey: 'AIzaSyD54O56EuogLKgEAOkxuSSiYV1xGW-tIR8',
  authDomain: 'wheelscollection-ee9af.firebaseapp.com',
  projectId: 'wheelscollection-ee9af',
  messagingSenderId: '60678427374',
  appId: '1:60678427374:web:a3c2d51fc9efc4ff1a59ff',
  measurementId: 'G-7PHRBRXE1G',
});

/**
 * Firestore collection used by this app.
 * Each document belongs to the authenticated user through `userId`.
 */
export const COLLECTION_NAME = 'hotwheels_items';

/** Managed collections (name + year) owned by each user. */
export const COLLECTIONS_NAME = 'hotwheels_collections';

/** Hard limits shared by the UI and Firestore rules. */
export const LIMITS = Object.freeze({
  name: 120,
  description: 2000,
  imageBase64: 900000,
  imageSide: 500,
  minPassword: 6,
  maxSourceFileBytes: 20 * 1024 * 1024,
  collectionName: 80,
  collectionYearMin: 1968,
  /** Documents fetched per page on the home grid. */
  pageSize: 24,
});

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

/**
 * Returns true when the configuration still contains placeholder values.
 * The UI uses this to show a friendly setup screen instead of Firebase errors.
 */
export function isFirebaseConfigured() {
  return REQUIRED_KEYS.every((key) => {
    const value = String(firebaseConfig[key] || '').trim();
    return (
      value.length > 0 &&
      !value.startsWith('YOUR_') &&
      !value.startsWith('SEU_') &&
      !value.includes('YOUR_PROJECT')
    );
  });
}
