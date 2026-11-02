/**
 * Test environment shim.
 *
 * Node 22+ exposes a `localStorage` global that is only usable with
 * `--localstorage-file`; without it the value is `undefined` and every
 * preference write raises a caught TypeError and prints a warning. The app
 * code is already defensive, but a tiny in-memory store keeps the suite quiet
 * and lets the preference tests exercise the real code path.
 *
 * Must be imported before the test files.
 */
const store = new Map();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
});
