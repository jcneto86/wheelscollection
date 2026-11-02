/**
 * Internationalisation (i18n) for en-CA, fr-CA and pt-BR.
 *
 * Dictionaries live in /lang as plain JSON files, so translators can edit
 * them without touching the application code.
 */
export const LOCALES = Object.freeze([
  { id: 'en-CA', label: 'English (Canada)', shortLabel: 'EN' },
  { id: 'fr-CA', label: 'Français (Canada)', shortLabel: 'FR' },
  { id: 'pt-BR', label: 'Português (Brasil)', shortLabel: 'PT' },
]);

const DEFAULT_LOCALE = 'pt-BR';
const FALLBACK_LOCALE = 'en-CA';
const dictionaries = new Map();

export function isSupportedLocale(locale) {
  return LOCALES.some((entry) => entry.id === locale);
}

/** Picks a sensible initial language from the browser. */
export function detectLocale() {
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const language = String(candidate).toLowerCase();
    if (language.startsWith('pt')) return 'pt-BR';
    if (language.startsWith('fr')) return 'fr-CA';
    if (language.startsWith('en')) return 'en-CA';
  }

  return DEFAULT_LOCALE;
}

/** Loads every dictionary once. Missing files are reported but non-fatal. */
export async function initI18n() {
  const results = await Promise.allSettled(
    LOCALES.map(async ({ id }) => {
      const url = new URL(`../lang/${id}.json`, import.meta.url);
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`Could not load ${id}.json (HTTP ${response.status})`);
      }
      const data = await response.json();
      dictionaries.set(id, data);
    }),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `[i18n] Failed to load ${LOCALES[index].id}:`,
        result.reason,
      );
    }
  });

  if (!dictionaries.has(DEFAULT_LOCALE) && dictionaries.size === 0) {
    console.error('[i18n] No translation dictionary could be loaded.');
  }
}

/**
 * Translates a key. Unknown keys fall back to en-CA and finally to the key
 * itself, which makes missing translations easy to spot during development.
 */
export function translate(locale, key, params = {}) {
  const dictionariesToTry = [
    locale,
    DEFAULT_LOCALE,
    FALLBACK_LOCALE,
  ].filter((id) => dictionaries.has(id));

  for (const id of dictionariesToTry) {
    const value = dictionaries.get(id)?.[key];
    if (typeof value === 'string') {
      return interpolate(value, params);
    }
  }

  return key;
}

export function getLoadedLocales() {
  return [...dictionaries.keys()];
}

function interpolate(template, params) {
  if (!params || typeof params !== 'object') {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      return match;
    }
    const value = params[name];
    return value === null || value === undefined ? '' : String(value);
  });
}
