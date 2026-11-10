/**
 * Build estatico: valida o projeto e monta a pasta build/ pronta para a
 * Hostinger (public_html/app). Nao minifica nem reescreve os arquivos.
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import https from 'node:https';
import {
  APP_ROOT,
  BUILD_DIR,
  WORK_DIR,
  CONFIG_FILE,
  RUNTIME_FILES,
  RUNTIME_DIRS,
  DEFAULT_COLLECTION,
  exists,
  readText,
  parseFirebaseConfig,
  validateFirebaseConfig,
  walkFiles,
  totalSize,
  formatBytes,
  ensureDir,
  openTarget,
  paint,
  log,
} from './core.mjs';
import { runChecks } from './check.mjs';

/** ONNX Runtime Web version pinned for reproducible builds. */
const ORT_VERSION = '1.20.1';
const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const ORT_WASM_FILES = [
  // Wasm-only UMD bundle (loads `ort-wasm-simd-threaded.{mjs,wasm}`).
  'ort.wasm.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];
/**
 * Optional WebGPU/WebNN bundle (~21 MB). Off by default to keep the first
 * download small; pass `--webgpu` to `wheels build` to bundle it. The worker
 * only attempts WebGPU when these files are present beside `ort.all.min.js`.
 */
const ORT_WEBGPU_FILES = [
  'ort.all.min.js',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];
const ORT_ALL_FILES = [...ORT_WASM_FILES, ...ORT_WEBGPU_FILES];

/** Downloads ONNX Runtime Web assets to local assets/lib/ort for offline-first builds. */
async function downloadOrtAssets({ webgpu = false } = {}) {
  const destDir = path.join(APP_ROOT, 'assets', 'lib', 'ort');
  await ensureDir(destDir);

  log.step(`Baixando ONNX Runtime Web v${ORT_VERSION}...`);
  if (webgpu) log.info('  variante WebGPU/WebNN (jsep) habilitada.');

  const files = webgpu ? ORT_ALL_FILES : ORT_WASM_FILES;
  const keep = new Set(files);

  for (const file of files) {
    const dest = path.join(destDir, file);
    if (await exists(dest)) {
      log.info(`  ${file} ja existe, pulando.`);
      continue;
    }

    const url = ORT_CDN_BASE + file;
    try {
      log.info(`  baixando ${file}...`);
      await downloadFile(url, dest);
      log.ok(`  ${file} salvo.`);
    } catch (err) {
      log.warn(`  falha ao baixar ${file}: ${err.message}`);
      // Not fatal — CDN fallback will be used at runtime
    }
  }

  // Remove the variant that is not part of this build so the deployed folder
  // (and the worker's local probe) stays consistent with the chosen flag.
  for (const file of ORT_ALL_FILES) {
    if (keep.has(file)) continue;
    const dest = path.join(destDir, file);
    if (await exists(dest)) {
      await fs.rm(dest, { force: true });
      log.info(`  ${file} removido (nao usado neste build).`);
    }
  }
}

function downloadFile(url, dest) {  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => {
        fs.unlink(dest).catch(() => {});
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Writes `assets/models/integrity.json` with the SHA-384 of every model the
 * worker loads locally. The worker rejects a tampered/corrupted download.
 */
async function writeIntegrityManifest() {
  const entries = [
    ['ppocr_det.onnx', 'assets/models/ppocr_det.onnx'],
    ['ppocr_rec.onnx', 'assets/models/ppocr_rec.onnx'],
    ['ppocr_keys.txt', 'assets/models/ppocr_keys.txt'],
  ];

  const files = {};
  for (const [name, relative] of entries) {
    const absolute = path.join(APP_ROOT, relative);
    if (!(await exists(absolute))) continue;
    const buffer = await fs.readFile(absolute);
    files[name] = createHash('sha384').update(buffer).digest('base64');
  }

  const dest = path.join(BUILD_DIR, 'assets', 'models', 'integrity.json');
  await ensureDir(path.dirname(dest));
  await fs.writeFile(
    dest,
    `${JSON.stringify({ algorithm: 'sha384', files }, null, 2)}\n`,
    'utf8'
  );
  log.info(`  integridade: ${Object.keys(files).length} modelos com SHA-384.`);
}

/** Files/dirs that make up the app shell (models/ORT have their own cache). */
const SHELL_FILES = ['index.html', 'manifest.webmanifest', 'robots.txt'];
const SHELL_DIRS = ['css', 'js', 'lang', 'assets'];
const SHELL_EXCLUDED_PREFIXES = ['assets/models/', 'assets/lib/ort/'];

/**
 * Computes a short content hash of everything the static cache precaches.
 * Excludes the heavy OCR models and the ONNX Runtime bundle, which are
 * versioned separately in MODEL_CACHE.
 */
async function computeShellVersion() {
  const tracked = [];

  for (const name of SHELL_FILES) {
    const absolute = path.join(BUILD_DIR, name);
    if (await exists(absolute)) tracked.push(absolute);
  }
  for (const dir of SHELL_DIRS) {
    const absolute = path.join(BUILD_DIR, dir);
    if (!(await exists(absolute))) continue;
    tracked.push(...(await walkFiles(absolute, { skip: [] })));
  }

  tracked.sort();

  const hash = createHash('sha256');
  for (const file of tracked) {
    const relative = path.relative(BUILD_DIR, file).split(path.sep).join('/');
    if (SHELL_EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue;
    hash.update(relative);
    hash.update(await fs.readFile(file));
  }

  return hash.digest('hex').slice(0, 10);
}

/**
 * Stamps the built sw.js with content hashes and writes version.json:
 *
 *   - STATIC_CACHE gets the app-shell hash (HTML/CSS/JS/lang).
 *   - MODEL_CACHE gets the OCR asset hash (models + ORT bundle).
 *   - version.json lets clients/ops compare the deployed build.
 */
async function stampServiceWorkerCaches() {
  const modelFiles = [
    'assets/models/ppocr_det.onnx',
    'assets/models/ppocr_rec.onnx',
    'assets/models/ppocr_keys.txt',
    'assets/lib/ort/ort.wasm.min.js',
    'assets/lib/ort/ort.all.min.js',
    'assets/lib/ort/ort-wasm-simd-threaded.mjs',
    'assets/lib/ort/ort-wasm-simd-threaded.wasm',
    'assets/lib/ort/ort-wasm-simd-threaded.jsep.mjs',
    'assets/lib/ort/ort-wasm-simd-threaded.jsep.wasm',
  ];

  const modelHash = createHash('sha256');
  for (const relative of modelFiles) {
    const absolute = path.join(APP_ROOT, relative);
    if (await exists(absolute)) modelHash.update(await fs.readFile(absolute));
  }
  const modelVersion = modelHash.digest('hex').slice(0, 10);

  const shellVersion = await computeShellVersion();

  await fs.writeFile(
    path.join(BUILD_DIR, 'version.json'),
    `${JSON.stringify(
      { version: shellVersion, models: modelVersion, builtAt: new Date().toISOString() },
      null,
      2
    )}\n`,
    'utf8'
  );

  const swPath = path.join(BUILD_DIR, 'sw.js');
  if (!(await exists(swPath))) return;

  const source = await fs.readFile(swPath, 'utf8');
  const updated = source
    .replace(
      /const STATIC_CACHE = 'wheels-static-v1';/,
      `const STATIC_CACHE = 'wheels-static-v1-${shellVersion}';`
    )
    .replace(
      /const MODEL_CACHE = 'wheels-models-v1';/,
      `const MODEL_CACHE = 'wheels-models-v1-${modelVersion}';`
    );

  await fs.writeFile(swPath, updated, 'utf8');
  log.info(`  sw.js: shell ${shellVersion}, modelos ${modelVersion}.`);
  log.info(`  version.json: shell ${shellVersion}.`);
}

const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep']);
const FORBIDDEN_NAMES = new Set([
  'README.md',
  'README.pt-BR.md',
  'firebase.json',
  'firestore.rules',
  'firestore.indexes.json',
  'package.json',
  'package-lock.json',
]);
const FORBIDDEN_SEGMENTS = new Set(['tools', 'build', '.wheels', '.git', 'node_modules']);

async function copyDirectory(source, destination) {
  await ensureDir(destination);
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || JUNK.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

function relativeToBuild(file) {
  return path.relative(BUILD_DIR, file).split(path.sep).join('/');
}

function countByTopLevel(files) {
  const counts = new Map();
  for (const file of files) {
    const relative = relativeToBuild(file);
    const top = relative.includes('/') ? relative.split('/')[0] : relative;
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return counts;
}

export async function runBuild(options = {}) {
  log.title('Build para hospedagem');

  if (options.skipCheck) {
    log.warn('Verificacoes automaticas ignoradas por --skip-check.');
  } else {
    const result = await runChecks({ online: options.online === true });
    if (result.errors.length) {
      throw new Error(`Build cancelado: ${result.errors.length} erro(s) na verificacao.`);
    }
  }

  // Download ONNX Runtime Web assets for offline-first deployment
  await downloadOrtAssets({ webgpu: options.webgpu === true });

  const source = await readText(CONFIG_FILE);
  const { config, collection } = parseFirebaseConfig(source);
  const validation = validateFirebaseConfig(config, collection || DEFAULT_COLLECTION);
  const placeholderErrors = validation.errors.filter((message) =>
    /exemplo|vazio|YOUR_|SEU_/i.test(message),
  );
  if (placeholderErrors.length && !options.allowPlaceholder) {
    for (const message of placeholderErrors) log.error(message);
    throw new Error('Configure o Firebase antes do build (ou use --allow-placeholder para gerar a tela de setup).');
  }
  const fatalErrors = validation.errors.filter((message) => !placeholderErrors.includes(message));
  if (fatalErrors.length) {
    for (const message of fatalErrors) log.error(message);
    throw new Error('Configuracao do Firebase invalida. Build cancelado.');
  }
  for (const message of validation.warnings) log.warn(message);

  log.step(`Limpando ${paint.gray(BUILD_DIR)}...`);
  await fs.rm(BUILD_DIR, { recursive: true, force: true });
  await ensureDir(BUILD_DIR);

  for (const name of RUNTIME_FILES) {
    const from = path.join(APP_ROOT, name);
    if (!(await exists(from))) throw new Error(`Arquivo obrigatorio ausente: ${name}`);
    await fs.copyFile(from, path.join(BUILD_DIR, name));
  }
  for (const dir of RUNTIME_DIRS) {
    const from = path.join(APP_ROOT, dir);
    if (!(await exists(from))) throw new Error(`Diretorio obrigatorio ausente: ${dir}`);
    await copyDirectory(from, path.join(BUILD_DIR, dir));
  }

  await writeIntegrityManifest();
  await stampServiceWorkerCaches();

  const builtFiles = await walkFiles(BUILD_DIR, { skip: [] });
  const forbidden = builtFiles.filter((file) => {
    const relative = relativeToBuild(file);
    const segments = relative.split('/');
    return (
      FORBIDDEN_NAMES.has(segments.at(-1)) ||
      segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))
    );
  });
  if (forbidden.length) {
    throw new Error(`O build contem arquivos indevidos: ${forbidden.map(relativeToBuild).join(', ')}`);
  }

  const expected = new Set(RUNTIME_FILES);
  for (const dir of RUNTIME_DIRS) {
    for (const file of await walkFiles(path.join(APP_ROOT, dir), { skip: [] })) {
      const relative = path.relative(APP_ROOT, file).split(path.sep).join('/');
      const segments = relative.split('/');
      if (segments.some((segment) => segment.startsWith('.')) || JUNK.has(segments.at(-1))) continue;
      expected.add(relative);
    }
  }
  const builtSet = new Set(builtFiles.map(relativeToBuild));
  const missingFiles = [...expected].filter((file) => !builtSet.has(file));
  if (missingFiles.length) {
    throw new Error(`Copia incompleta. Faltando no build: ${missingFiles.join(', ')}`);
  }

  for (const name of RUNTIME_FILES) {
    if (!(await exists(path.join(BUILD_DIR, name)))) {
      throw new Error(`Copia incompleta: ${name} nao chegou ao build.`);
    }
  }
  const configInBuild = path.join(BUILD_DIR, 'js', 'firebase-config.js');
  if (!(await exists(configInBuild))) {
    throw new Error('Copia incompleta: js/firebase-config.js nao chegou ao build.');
  }

  const bytes = await totalSize(builtFiles);
  const counts = countByTopLevel(builtFiles);
  const info = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    projectId: config.projectId || null,
    authDomain: config.authDomain || null,
    collection: collection || null,
    files: builtFiles.length,
    bytes,
    checks: options.skipCheck ? 'skipped' : 'ok',
  };
  await ensureDir(WORK_DIR);
  const manifest = path.join(WORK_DIR, 'last-build.json');
  await fs.writeFile(manifest, `${JSON.stringify(info, null, 2)}\n`, 'utf8');

  log.blank();
  log.ok(`Build concluido: ${builtFiles.length} arquivos, ${formatBytes(bytes)}.`);
  log.plain(paint.bold('Conteudo de build/:'));
  const order = ['index.html', 'manifest.webmanifest', 'robots.txt', '.htaccess', 'sw.js', 'css', 'js', 'lang', 'assets'];
  for (const name of order) {
    if (!counts.has(name)) continue;
    log.info(`${name}${counts.get(name) > 1 ? ` (${counts.get(name)} arquivos)` : ''}`);
  }
  log.blank();
  log.plain(paint.bold('Publicacao na Hostinger:'));
  log.info('1. Envie o CONTEUDO de build/ para public_html/app (nao envie a pasta build).');
  log.info('2. Inclua o arquivo oculto .htaccess.');
  log.info('3. Pastas com permissao 755 e arquivos com 644.');
  log.info('4. Autorize o dominio em Firebase > Authentication > Settings > Authorized domains.');
  log.info(`Manifesto local: ${manifest}`);
  log.info(`${paint.gray('Dica:')} use "build --open" para abrir a pasta no gerenciador de arquivos.`);

  if (options.open) openTarget(BUILD_DIR);
  return info;
}
