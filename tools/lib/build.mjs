/**
 * Build estatico: valida o projeto e monta a pasta build/ pronta para a
 * Hostinger (public_html/app). Nao minifica nem reescreve os arquivos.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
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
  const order = ['index.html', 'manifest.webmanifest', 'robots.txt', '.htaccess', 'css', 'js', 'lang', 'assets'];
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
