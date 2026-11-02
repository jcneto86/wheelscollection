/**
 * Utilitarios compartilhados pelo CLI do Wheels Collection.
 * Sem dependencias externas: funciona em Windows, macOS e Linux com Node.js 18+.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_ROOT = path.resolve(LIB_DIR, '..');
export const APP_ROOT = path.resolve(TOOLS_ROOT, '..');

export const INDEX_FILE = path.join(APP_ROOT, 'index.html');
export const CSS_DIR = path.join(APP_ROOT, 'css');
export const JS_DIR = path.join(APP_ROOT, 'js');
export const LANG_DIR = path.join(APP_ROOT, 'lang');
export const ASSETS_DIR = path.join(APP_ROOT, 'assets');
export const CONFIG_FILE = path.join(JS_DIR, 'firebase-config.js');
export const BUILD_DIR = path.join(APP_ROOT, 'build');
export const WORK_DIR = path.join(APP_ROOT, '.wheels');

export const LOCALES = ['en-CA', 'fr-CA', 'pt-BR'];
export const PALETTES = ['crimson', 'ocean', 'emerald', 'violet', 'amber'];
export const DEFAULT_COLLECTION = 'hotwheels_items';

export const RUNTIME_FILES = ['index.html', 'manifest.webmanifest', 'robots.txt', '.htaccess'];
export const RUNTIME_DIRS = ['css', 'js', 'lang', 'assets'];

export const REQUIRED_FILES = [
  ...RUNTIME_FILES,
  ...RUNTIME_DIRS.flatMap((dir) => {
    if (dir === 'css') return ['css/styles.css'];
    if (dir === 'js') {
      return [
        'js/app.js',
        'js/firebase.js',
        'js/firebase-config.js',
        'js/i18n.js',
        'js/image-crop.js',
        'js/ocr.js',
        'js/preferences.js',
        'js/router.js',
      ];
    }
    if (dir === 'lang') return LOCALES.map((locale) => `lang/${locale}.json`);
    return ['assets/app_icon.png'];
  }),
  'firebase.json',
  'firestore.rules',
  'firestore.indexes.json',
];

export const FIREBASE_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
  'measurementId',
];
export const REQUIRED_FIREBASE_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

/* -------------------------------------------------------------------------- */
/* Saida no terminal                                                          */
/* -------------------------------------------------------------------------- */

const useColor =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR === '1' || Boolean(process.stdout.isTTY));

const wrap = (code) => (text) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text);

export const paint = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export const log = {
  blank() {
    console.log('');
  },
  title(text) {
    console.log(`\n${paint.bold(paint.cyan(`== ${text} ==`))}`);
  },
  step(text) {
    console.log(`${paint.cyan('>')} ${text}`);
  },
  ok(text) {
    console.log(`${paint.green('[OK]')} ${text}`);
  },
  warn(text) {
    console.log(`${paint.yellow('[!]')} ${text}`);
  },
  error(text) {
    console.log(`${paint.red('[X]')} ${text}`);
  },
  info(text) {
    console.log(`${paint.gray('-')} ${text}`);
  },
  plain(text = '') {
    console.log(text);
  },
};

/* -------------------------------------------------------------------------- */
/* Entrada do usuario                                                         */
/* -------------------------------------------------------------------------- */

let rl = null;

function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => {
      console.log('');
      rl.close();
      process.exit(130);
    });
  }
  return rl;
}

export function closePrompts() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

export async function ask(question, { defaultValue = '', allowEmpty = false } = {}) {
  if (!process.stdin.isTTY) {
    if (defaultValue !== '' || allowEmpty) return defaultValue;
    throw new Error('Entrada interativa indisponivel. Use as opcoes da linha de comando.');
  }
  const suffix = defaultValue !== '' ? paint.gray(` [${defaultValue}]`) : '';
  const answer = (await getRl().question(`${question}${suffix}: `)).trim();
  if (answer) return answer;
  if (defaultValue !== '') return defaultValue;
  if (allowEmpty) return '';
  log.warn('Valor obrigatorio. Tente novamente.');
  return ask(question, { defaultValue, allowEmpty });
}

export async function confirm(question, defaultValue = true) {
  const hint = defaultValue ? 'S/n' : 's/N';
  const answer = (await ask(`${question} (${hint})`, { allowEmpty: true })).toLowerCase();
  if (!answer) return defaultValue;
  return ['s', 'sim', 'y', 'yes'].includes(answer);
}

export async function pause(message = 'Pressione Enter para continuar...') {
  if (!process.stdin.isTTY) return;
  await ask(message, { allowEmpty: true });
}

/* -------------------------------------------------------------------------- */
/* Arquivos                                                                   */
/* -------------------------------------------------------------------------- */

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readText(file) {
  return fs.readFile(file, 'utf8');
}

export async function readJson(file) {
  return JSON.parse(await readText(file));
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export function relativeToApp(target) {
  return path.relative(APP_ROOT, target).split(path.sep).join('/');
}

export async function walkFiles(root, options = {}) {
  const skip = new Set(options.skip || ['build', 'node_modules', '.git', '.wheels', 'tools']);
  const output = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(full);
    }
  }
  await visit(root);
  return output.sort();
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function totalSize(files) {
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += (await fs.stat(file)).size;
    } catch {
      /* arquivo removido durante a leitura */
    }
  }
  return bytes;
}

export function openTarget(target) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', target];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const item of values || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Firebase                                                                   */
/* -------------------------------------------------------------------------- */

export function isPlaceholder(value) {
  const text = String(value || '').trim();
  return (
    text.length === 0 ||
    /^(YOUR_|SEU_|COLE_)/i.test(text) ||
    /YOUR_PROJECT/i.test(text)
  );
}

export function parseFirebaseConfig(source) {
  const config = {};
  for (const key of FIREBASE_KEYS) {
    const match = source.match(new RegExp(`${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`));
    if (match) config[key] = match[1];
  }
  const collectionMatch = source.match(/COLLECTION_NAME\s*=\s*['"]([^'"]+)['"]/);
  return { config, collection: collectionMatch ? collectionMatch[1] : '' };
}

export function validateFirebaseConfig(config, collection = DEFAULT_COLLECTION) {
  const errors = [];
  const warnings = [];

  for (const key of REQUIRED_FIREBASE_KEYS) {
    if (isPlaceholder(config[key])) {
      errors.push(`Firebase: "${key}" esta vazio ou ainda e um valor de exemplo.`);
    }
  }
  if (config.apiKey && !isPlaceholder(config.apiKey) && !/^AIza[0-9A-Za-z_-]{35}$/.test(config.apiKey)) {
    errors.push('Firebase: "apiKey" nao parece uma chave Web valida (deve comecar com AIza).');
  }
  if (config.appId && !isPlaceholder(config.appId) && !/^1:\d+:(web|android|ios):[0-9a-f]+$/.test(config.appId)) {
    errors.push('Firebase: "appId" nao parece um App ID valido (1:...:web:...).');
  }
  if (config.authDomain && !isPlaceholder(config.authDomain) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(config.authDomain)) {
    errors.push('Firebase: "authDomain" nao parece um dominio valido.');
  }
  if (config.projectId && !isPlaceholder(config.projectId) && !/^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)) {
    warnings.push('Firebase: "projectId" fora do padrao habitual (minusculas, numeros e hifens).');
  }
  if (!config.authDomain?.endsWith('firebaseapp.com')) {
    warnings.push('Firebase: "authDomain" nao termina em .firebaseapp.com. Confirme se e o dominio correto.');
  }
  if (config.messagingSenderId && !/^\d+$/.test(config.messagingSenderId)) {
    warnings.push('Firebase: "messagingSenderId" normalmente contem apenas numeros.');
  }
  if (config.measurementId && !/^G-[A-Z0-9]+$/.test(config.measurementId)) {
    warnings.push('Firebase: "measurementId" normalmente segue o formato G-XXXXXXX.');
  }
  if (!collection || !/^[A-Za-z0-9_]{1,100}$/.test(collection)) {
    errors.push('Firestore: nome da colecao invalido.');
  } else if (collection.startsWith('__')) {
    errors.push('Firestore: nomes de colecao nao podem comecar com "__".');
  } else if (collection !== DEFAULT_COLLECTION) {
    warnings.push(
      `Firestore: a colecao configurada e "${collection}", mas as regras usam "${DEFAULT_COLLECTION}".`,
    );
  }
  return { errors, warnings };
}

export function escapeJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function writeFirebaseConfig(config, collection) {
  const source = await readText(CONFIG_FILE);
  const entries = FIREBASE_KEYS.filter(
    (key) => config[key] !== undefined && String(config[key]).trim() !== '',
  );
  const block = [
    'export const firebaseConfig = Object.freeze({',
    ...entries.map((key) => `  ${key}: '${escapeJs(config[key])}',`),
    '});',
  ].join('\n');

  const blockPattern = /export const firebaseConfig = Object\.freeze\(\{[\s\S]*?\}\);/;
  if (!blockPattern.test(source)) {
    throw new Error('Nao foi possivel localizar o bloco firebaseConfig em js/firebase-config.js.');
  }
  const next = source.replace(blockPattern, block);

  const collectionPattern = /export const COLLECTION_NAME\s*=\s*['"][^'"]*['"];/;
  if (!collectionPattern.test(next)) {
    throw new Error('Nao foi possivel localizar COLLECTION_NAME em js/firebase-config.js.');
  }
  const updated = next.replace(
    collectionPattern,
    `export const COLLECTION_NAME = '${escapeJs(collection)}';`,
  );
  await fs.writeFile(CONFIG_FILE, updated, 'utf8');
}

/** Confirma se a chave existe e se o login por e-mail/senha esta habilitado. */
export async function probeFirebaseAuth(apiKey, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'wheels-cli-check@example.com',
          password: 'wheels-cli-check-123',
          returnSecureToken: false,
        }),
        signal: controller.signal,
      },
    );
    const data = await response.json().catch(() => ({}));
    const message = data?.error?.message || `HTTP ${response.status}`;
    if (/API_KEY_INVALID|API key not valid|invalid api key/i.test(message)) {
      return { state: 'invalid-key', message };
    }
    if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/i.test(message)) {
      return { state: 'provider-disabled', message };
    }
    if (/EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|INVALID_EMAIL/i.test(message)) {
      return { state: 'valid', message };
    }
    if (/CONFIGURATION_NOT_FOUND|PROJECT_NOT_FOUND/i.test(message)) {
      return { state: 'invalid-project', message };
    }
    return response.ok
      ? { state: 'valid', message: 'Requisicao aceita.' }
      : { state: 'unknown', message };
  } catch (error) {
    return {
      state: 'network',
      message: error?.name === 'AbortError' ? 'Tempo esgotado.' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}
