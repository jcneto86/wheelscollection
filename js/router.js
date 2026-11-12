/**
 * Tiny hash-based router.
 *
 * Hash routing was chosen deliberately: the app can be deployed in any
 * subfolder of a shared host (for example /public_html/app/) without
 * requiring mod_rewrite or server-side fallbacks.
 *
 * Routes:
 *   #/                       dashboard
 *   #/login                  authentication
 *   #/settings               preferences
 *   #/collections            managed collections (name + year)
 *   #/collection/new         new item form
 *   #/collection/:id         item details
 *   #/collection/:id/edit    edit item form
 */

export function createRouter(onNavigate) {
  if (!window.location.hash) {
    window.history.replaceState(null, '', '#/');
  }

  let current = resolve(window.location.hash);

  function notify() {
    const next = resolve(window.location.hash);
    if (next.path === current.path) {
      return;
    }
    current = next;
    onNavigate(next);
  }

  window.addEventListener('hashchange', notify);
  window.addEventListener('popstate', notify);

  function navigate(path, { replace = false } = {}) {
    const normalized = normalizePath(path);
    const hash = `#${normalized}`;
    const sameHash = window.location.hash === hash;

    if (!sameHash) {
      if (replace) {
        window.history.replaceState(null, '', hash);
      } else {
        window.history.pushState(null, '', hash);
      }
    }

    const next = resolve(hash);
    const changed = next.path !== current.path;
    current = next;
    onNavigate(next, { force: sameHash || !changed });
  }

  function link(path) {
    return `#${normalizePath(path)}`;
  }

  // Let the caller render the initial route synchronously.
  onNavigate(current, { initial: true });

  return {
    navigate,
    link,
    resolve,
    get current() {
      return current;
    },
  };
}

export function normalizePath(value) {
  let path = String(value || '/').trim();

  if (path.startsWith('#')) {
    path = path.slice(1);
  }

  const queryIndex = path.indexOf('?');
  if (queryIndex >= 0) {
    path = path.slice(0, queryIndex);
  }

  path = path.replace(/\/{2,}/g, '/');

  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path || '/';
}

export function resolve(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const queryIndex = raw.indexOf('?');
  const rawPath = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const query = new URLSearchParams(
    queryIndex >= 0 ? raw.slice(queryIndex + 1) : '',
  );
  const path = normalizePath(safeDecode(rawPath));

  if (path === '/') {
    return route('home', path, {}, query);
  }

  if (path === '/login') {
    return route('login', path, {}, query);
  }

  if (path === '/settings') {
    return route('settings', path, {}, query);
  }

  if (path === '/collections') {
    return route('collections', path, {}, query);
  }

  if (path === '/collection/new') {
    return route('form', path, { id: null }, query);
  }

  const editMatch = path.match(/^\/collection\/([^/]+)\/edit$/);
  if (editMatch) {
    return route('form', path, { id: editMatch[1] }, query);
  }

  const detailsMatch = path.match(/^\/collection\/([^/]+)$/);
  if (detailsMatch) {
    return route('details', path, { id: detailsMatch[1] }, query);
  }

  return route('notfound', path, {}, query);
}

function route(name, path, params, query) {
  return { name, path, params, query };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
