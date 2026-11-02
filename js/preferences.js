import { detectLocale, isSupportedLocale } from './i18n.js';

/**
 * Local preferences persisted in localStorage.
 * Keep these keys in sync with the small inline theme script in index.html.
 */
export const STORAGE_KEYS = Object.freeze({
  theme: 'wheels.themeMode',
  palette: 'wheels.palette',
  locale: 'wheels.locale',
  /** '0' disables the automatic packaging scan. Absent means enabled. */
  ocrAuto: 'wheels.ocrAuto',
});

export const THEME_MODES = Object.freeze(['light', 'dark', 'system']);

export const PALETTES = Object.freeze([
  { id: 'crimson', labelKey: 'paletteCrimson', swatch: '#e10600' },
  { id: 'ocean', labelKey: 'paletteOcean', swatch: '#0b63ce' },
  { id: 'emerald', labelKey: 'paletteEmerald', swatch: '#00875a' },
  { id: 'violet', labelKey: 'paletteViolet', swatch: '#7b1fa2' },
  { id: 'amber', labelKey: 'paletteAmber', swatch: '#f59e0b' },
]);

const DEFAULT_THEME = 'system';
const DEFAULT_PALETTE = 'crimson';

export function loadPreferences() {
  return {
    themeMode: readValidated(
      STORAGE_KEYS.theme,
      (value) => THEME_MODES.includes(value),
      DEFAULT_THEME,
    ),
    palette: readValidated(
      STORAGE_KEYS.palette,
      isValidPalette,
      DEFAULT_PALETTE,
    ),
    locale: readValidated(
      STORAGE_KEYS.locale,
      isSupportedLocale,
      detectLocale(),
    ),
  };
}

export function savePreference(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (error) {
    console.warn('[preferences] Could not save preference:', error);
  }
}

/**
 * Automatic packaging scan. Enabled by default; only an explicit '0' turns it
 * off. `localStorage` may be blocked (private mode), so failures fall back to
 * the default instead of throwing.
 */
export function loadOcrAuto() {
  try {
    return localStorage.getItem(STORAGE_KEYS.ocrAuto) !== '0';
  } catch {
    return true;
  }
}

export function saveOcrAuto(enabled) {
  savePreference(STORAGE_KEYS.ocrAuto, enabled ? '1' : '0');
}

export function isValidPalette(value) {
  return PALETTES.some((palette) => palette.id === value);
}

export function getSystemDark() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function isDarkMode(mode, systemDark = getSystemDark()) {
  return mode === 'dark' || (mode === 'system' && systemDark);
}

/** Applies the light/dark/system preference to <html>. */
export function applyTheme(mode, systemDark = getSystemDark()) {
  const dark = isDarkMode(mode, systemDark);
  const root = document.documentElement;

  root.classList.toggle('dark', dark);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute('content', dark ? '#020617' : '#f8fafc');
  }
}

/** Applies one of the five colour palettes through CSS variables. */
export function applyPalette(paletteId) {
  const root = document.documentElement;
  root.dataset.palette = isValidPalette(paletteId)
    ? paletteId
    : DEFAULT_PALETTE;
}

function readValidated(key, isValid, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value && isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
