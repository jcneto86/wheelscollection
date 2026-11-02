/**
 * Verificacoes estaticas do projeto: arquivos, HTML, CSS, JS, traducoes,
 * Firebase, regras do Firestore e acesso aos CDNs.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APP_ROOT,
  INDEX_FILE,
  CSS_DIR,
  JS_DIR,
  LANG_DIR,
  REQUIRED_FILES,
  LOCALES,
  PALETTES,
  CONFIG_FILE,
  DEFAULT_COLLECTION,
  REQUIRED_FIREBASE_KEYS,
  exists,
  readText,
  readJson,
  walkFiles,
  parseFirebaseConfig,
  validateFirebaseConfig,
  probeFirebaseAuth,
  isPlaceholder,
  formatBytes,
  totalSize,
  paint,
  log,
} from './core.mjs';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

class Reporter {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.passed = 0;
  }
  ok(message) {
    this.passed += 1;
    log.ok(message);
  }
  warn(message) {
    this.warnings.push(message);
    log.warn(message);
  }
  error(message) {
    this.errors.push(message);
    log.error(message);
  }
  info(message) {
    log.info(message);
  }
  section(title) {
    log.blank();
    log.plain(paint.bold(title));
  }
}

function shortList(items, limit = 8) {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown} (+${items.length - limit})` : shown;
}

function placeholdersOf(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
}

function checkTagBalance(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
  const stack = [];
  const issues = [];
  const regex = /<(\/?)([A-Za-z][\w:-]*)(?:\s[^<>]*?)?(\/?)>/g;
  let match;
  while ((match = regex.exec(cleaned))) {
    const [, closing, rawName, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (VOID_TAGS.has(name) || selfClosing) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    if (stack.length === 0) {
      issues.push(`</${name}> sem abertura correspondente`);
      continue;
    }
    const top = stack.pop();
    if (top !== name) issues.push(`</${name}> fecha <${top}>`);
  }
  if (stack.length) issues.push(`tags nao fechadas: ${stack.slice(-6).join(', ')}`);
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Verificacoes                                                               */
/* -------------------------------------------------------------------------- */

async function checkFiles(reporter) {
  reporter.section('Arquivos obrigatorios');
  const missing = [];
  for (const rel of REQUIRED_FILES) {
    if (!(await exists(path.join(APP_ROOT, rel)))) missing.push(rel);
  }
  if (missing.length) {
    for (const rel of missing) reporter.error(`Arquivo ausente: ${rel}`);
  } else {
    reporter.ok(`${REQUIRED_FILES.length} arquivos obrigatorios encontrados.`);
  }
}

async function checkHtml(reporter) {
  reporter.section('HTML');
  const html = await readText(INDEX_FILE);
  const basics = [
    [/<!doctype html>/i, 'declaracao <!DOCTYPE html>'],
    [/<html[^>]+lang=/i, 'atributo lang no <html>'],
    [/<meta[^>]+name=["']viewport["']/i, 'meta viewport'],
    [/rel=["']manifest["']/i, 'link para o manifest'],
    [/<script[^>]+type=["']module["']/i, 'script principal com type="module"'],
    [/x-data=/i, 'inicializacao do Alpine.js'],
  ];
  let basicsOk = true;
  for (const [regex, label] of basics) {
    if (!regex.test(html)) {
      basicsOk = false;
      reporter.error(`index.html: falta ${label}.`);
    }
  }
  if (basicsOk) reporter.ok('Estrutura basica e inicializacao do app presentes.');

  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((value) => value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(value))
    .filter((value) => !value.includes('(') && !value.includes('{') && !value.includes('$'));
  const missingRefs = new Set();
  for (const reference of references) {
    const clean = reference.split('?')[0].split('#')[0].replace(/^\.\//, '');
    if (!clean) continue;
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* mantem o valor original */
    }
    if (!(await exists(path.join(APP_ROOT, decoded)))) missingRefs.add(reference);
  }
  if (missingRefs.size) reporter.error(`Referencias locais inexistentes: ${[...missingRefs].join(', ')}.`);
  else reporter.ok(`${new Set(references).size} referencias locais resolvidas.`);

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) reporter.warn(`IDs duplicados: ${shortList(duplicates)}.`);
  else reporter.ok(`${ids.length} IDs unicos.`);

  const tagIssues = checkTagBalance(html);
  if (tagIssues.length) reporter.warn(`Possivel desbalanceamento de tags: ${shortList(tagIssues)}.`);
  else reporter.ok('Tags HTML balanceadas.');

  if (/http:\/\/localhost|127\.0\.0\.1:\d+/.test(html)) {
    reporter.warn('index.html contem referencias a localhost.');
  }
}

async function checkCss(reporter) {
  reporter.section('CSS');
  const file = path.join(CSS_DIR, 'styles.css');
  const css = await readText(file);
  const cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  const open = (cleaned.match(/\{/g) || []).length;
  const close = (cleaned.match(/\}/g) || []).length;
  if (open !== close) reporter.error(`Chaves desbalanceadas no CSS (${open} aberturas, ${close} fechamentos).`);
  else reporter.ok('Blocos CSS balanceados.');

  const missingPalettes = PALETTES.filter(
    (palette) => !new RegExp(`data-palette=["']${palette}["']`).test(css),
  );
  if (missingPalettes.length) reporter.error(`Paletas ausentes no CSS: ${missingPalettes.join(', ')}.`);
  else reporter.ok(`${PALETTES.length} paletas de cores definidas.`);

  const required = [
    [/--brand-600\s*:/, 'variavel --brand-600'],
    [/\.dark\b/, 'modo escuro'],
    [/\.field-error\b/, 'estilo de erro de formulario'],
  ];
  const missing = required.filter(([regex]) => !regex.test(css)).map(([, label]) => label);
  if (missing.length) reporter.warn(`CSS sem ${missing.join(', ')}.`);
  else reporter.ok('Variaveis de marca, modo escuro e componentes presentes.');

  const bytes = Buffer.byteLength(css);
  reporter.info(`css/styles.css: ${formatBytes(bytes)}.`);

  await checkTailwindOutput(reporter);
}

/**
 * `css/tailwind.css` is generated from index.html and js/*.js. If either of
 * those is newer than the stylesheet, a class added recently is probably
 * missing from the build — warn instead of failing, since a checkout can
 * reorder timestamps.
 */
async function checkTailwindOutput(reporter) {
  const output = path.join(CSS_DIR, 'tailwind.css');

  if (!(await exists(output))) {
    reporter.error('css/tailwind.css ausente. Rode "npm run css".');
    return;
  }

  const sources = [INDEX_FILE];
  for (const name of await fs.readdir(JS_DIR)) {
    if (name.endsWith('.js')) sources.push(path.join(JS_DIR, name));
  }

  const outputStat = await fs.stat(output);
  const newer = [];

  for (const source of sources) {
    const stat = await fs.stat(source);
    if (stat.mtimeMs > outputStat.mtimeMs) newer.push(path.basename(source));
  }

  if (newer.length) {
    reporter.warn(
      `css/tailwind.css pode estar desatualizado (mais antigo que ${shortList(newer)}). Rode "npm run css".`,
    );
  } else {
    reporter.ok(`css/tailwind.css compilado e atualizado (${formatBytes(outputStat.size)}).`);
  }
}

const exportCache = new Map();

/** Resolves a relative import to an existing file, or null. */
async function resolveLocalFile(fromFile, specifier) {
  const target = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return null;
}

/** Names a module exports: declarations, `export { ... }` and default. */
async function namedExports(file) {
  if (exportCache.has(file)) return exportCache.get(file);

  const source = await readText(file);
  const names = new Set();

  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of match[1].split(',')) {
      const exported = raw.trim().split(/\s+as\s+/).pop();
      if (exported) names.add(exported.trim());
    }
  }

  if (/export\s+default\b/.test(source)) names.add('default');

  exportCache.set(file, names);
  return names;
}

async function checkJavaScript(reporter) {
  reporter.section('JavaScript');
  const files = (await fs.readdir(JS_DIR))
    .filter((name) => name.endsWith('.js'))
    .sort();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wheels-check-'));
  const invalid = [];
  const unresolved = [];
  const missingExports = [];
  try {
    for (const name of files) {
      const file = path.join(JS_DIR, name);
      const source = await readText(file);
      const tempFile = path.join(temp, `${name.replace(/\.js$/, '')}.mjs`);
      await fs.writeFile(tempFile, source, 'utf8');
      const result = spawnSync(process.execPath, ['--check', tempFile], { encoding: 'utf8' });
      if (result.status !== 0) {
        const message = String(result.stderr || result.stdout || '').trim().split('\n')[0];
        invalid.push(`js/${name}: ${message}`);
      }
      for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const specifier = match[1];
        const target = path.resolve(path.dirname(file), specifier);
        const candidates = [target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')];
        let found = false;
        for (const candidate of candidates) {
          if (await exists(candidate)) {
            found = true;
            break;
          }
        }
        if (!found) unresolved.push(`js/${name} -> ${specifier}`);
      }

      /*
       * Named imports must exist in the target module. A browser reports this
       * as "The requested module './x.js' does not provide an export named
       * ...", which is indistinguishable from a stale cached file — catching
       * it here keeps that class of bug out of production.
       */
      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = await resolveLocalFile(file, match[2]);
        if (!target) continue;
        const available = await namedExports(target);
        for (const raw of match[1].split(',')) {
          const imported = raw.trim().split(/\s+as\s+/)[0].trim();
          if (!imported) continue;
          if (!available.has(imported)) {
            missingExports.push(`js/${name} importa "${imported}" de ${match[2]}, que nao exporta esse nome`);
          }
        }
      }
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  if (invalid.length) {
    for (const item of invalid) reporter.error(`Erro de sintaxe: ${item}`);
  } else {
    reporter.ok(`${files.length} arquivos JS com sintaxe valida.`);
  }
  if (unresolved.length) reporter.error(`Imports locais nao encontrados: ${shortList(unresolved)}.`);
  else reporter.ok('Todos os imports locais foram encontrados.');
  if (missingExports.length) reporter.error(`Export nomeado ausente: ${shortList(missingExports)}.`);
  else reporter.ok('Todos os imports nomeados existem nos modulos de destino.');

  const config = await readText(CONFIG_FILE);
  if (/export\s+function\s+isFirebaseConfigured\s*\(/.test(config)) {
    reporter.ok('Funcao isFirebaseConfigured exportada.');
  } else {
    reporter.error('js/firebase-config.js nao exporta isFirebaseConfigured().');
  }
}

async function checkTranslations(reporter) {
  reporter.section('Traducoes');
  const dictionaries = {};
  for (const locale of LOCALES) {
    try {
      dictionaries[locale] = await readJson(path.join(LANG_DIR, `${locale}.json`));
      reporter.ok(`lang/${locale}.json valido.`);
    } catch (error) {
      reporter.error(`lang/${locale}.json invalido: ${error.message}`);
    }
  }
  const base = dictionaries['en-CA'];
  if (!base) {
    reporter.error('Dicionario base en-CA indisponivel.');
    return;
  }
  const baseKeys = Object.keys(base);
  for (const locale of LOCALES) {
    const dictionary = dictionaries[locale];
    if (!dictionary) continue;
    const keys = Object.keys(dictionary);
    if (locale !== 'en-CA') {
      const missing = baseKeys.filter((key) => !(key in dictionary));
      const extra = keys.filter((key) => !(key in base));
      if (missing.length) reporter.error(`${locale}: ${missing.length} chaves ausentes (${shortList(missing)}).`);
      if (extra.length) reporter.warn(`${locale}: ${extra.length} chaves extras (${shortList(extra)}).`);
      const mismatched = Object.keys(dictionary).filter(
        (key) => key in base && placeholdersOf(base[key]) !== placeholdersOf(dictionary[key]),
      );
      if (mismatched.length) {
        reporter.error(`${locale}: placeholders diferentes em ${shortList(mismatched)}.`);
      }
    }
  }
  const invalidValues = [];
  for (const locale of LOCALES) {
    const dictionary = dictionaries[locale];
    if (!dictionary) continue;
    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value !== 'string' || value.trim() === '') invalidValues.push(`${locale}:${key}`);
    }
  }
  if (invalidValues.length) reporter.warn(`Valores vazios ou nao textuais: ${shortList(invalidValues)}.`);

  const sources = [await readText(INDEX_FILE)];
  for (const name of await fs.readdir(JS_DIR)) {
    if (name.endsWith('.js')) sources.push(await readText(path.join(JS_DIR, name)));
  }
  const used = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g)) used.add(match[1]);
  }
  const missingKeys = [...used].filter((key) => !(key in base));
  if (missingKeys.length) reporter.error(`Chaves usadas no codigo e ausentes em en-CA: ${shortList(missingKeys)}.`);
  else reporter.ok(`${used.size} chaves usadas no HTML/JS existem no dicionario.`);
  reporter.info(`en-CA tem ${baseKeys.length} chaves.`);
}

async function checkFirebase(reporter) {
  reporter.section('Firebase e Firestore');
  const source = await readText(CONFIG_FILE);
  const { config, collection } = parseFirebaseConfig(source);
  const { errors, warnings } = validateFirebaseConfig(config, collection);
  for (const message of errors) reporter.error(message);
  for (const message of warnings) reporter.warn(message);
  if (errors.length === 0) {
    reporter.ok(`Configuracao do Firebase preenchida (projeto ${config.projectId}).`);
    reporter.info(`Colecao: ${collection || DEFAULT_COLLECTION}.`);
  }

  const rulesFile = path.join(APP_ROOT, 'firestore.rules');
  const rules = await readText(rulesFile);
  const ruleChecks = [
    [/service\s+cloud\.firestore/, 'servico cloud.firestore'],
    [/match\s+\/[A-Za-z0-9_]+\/\{/, 'match de colecao'],
    [/\brequest\.auth\b/, 'verificacao de autenticacao'],
    [/\buserId\b/, 'campo userId'],
    [/\ballow\s+create\b/, 'regra de criacao'],
    [/\ballow\s+update\b/, 'regra de atualizacao'],
    [/\ballow\s+delete\b/, 'regra de exclusao'],
  ];
  const missingRules = ruleChecks.filter(([regex]) => !regex.test(rules)).map(([, label]) => label);
  if (missingRules.length) reporter.error(`firestore.rules sem ${missingRules.join(', ')}.`);
  else reporter.ok('Regras do Firestore com autenticacao e CRUD por proprietario.');
  if (collection && !rules.includes(collection)) {
    reporter.error(`firestore.rules nao referencia a colecao "${collection}".`);
  }

  for (const name of ['firebase.json', 'firestore.indexes.json']) {
    try {
      await readJson(path.join(APP_ROOT, name));
      reporter.ok(`${name} e um JSON valido.`);
    } catch (error) {
      reporter.error(`${name} invalido: ${error.message}`);
    }
  }
}

async function checkDeployment(reporter) {
  reporter.section('Arquivos de publicacao');
  const htaccess = await readText(path.join(APP_ROOT, '.htaccess'));
  const checks = [
    [/Options\s+-Indexes/i, 'Options -Indexes'],
    [/DirectoryIndex\s+index\.html/i, 'DirectoryIndex index.html'],
    [/application\/manifest\+json/i, 'tipo .webmanifest'],
    [/firestore\\?\.rules/i, 'bloqueio de firestore.rules'],
    [/README\\?\.md/i, 'bloqueio de README.md'],
    [/package\\?\.json/i, 'bloqueio de package.json'],
    [/RewriteRule.*tools/i, 'bloqueio da pasta tools/'],
  ];
  const missing = checks.filter(([regex]) => !regex.test(htaccess)).map(([, label]) => label);
  if (missing.length) reporter.warn(`.htaccess sem ${missing.join(', ')}.`);
  else reporter.ok('.htaccess com protecoes e tipos corretos.');

  const buildFiles = await exists(path.join(APP_ROOT, 'build'))
    ? await walkFiles(path.join(APP_ROOT, 'build'), { skip: [] })
    : [];
  if (buildFiles.length) {
    const size = await totalSize(buildFiles);
    reporter.info(`build/ existente: ${buildFiles.length} arquivos, ${formatBytes(size)} (sera recriada no build).`);
  } else {
    reporter.info('build/ ainda nao foi gerada.');
  }
}

async function checkOnline(reporter, config, collection) {
  reporter.section('Acesso a rede (online)');
  const sources = [await readText(INDEX_FILE)];
  for (const name of await fs.readdir(JS_DIR)) {
    if (name.endsWith('.js')) sources.push(await readText(path.join(JS_DIR, name)));
  }
  const candidates = [...new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/https:\/\/[^"'\s<>()]+/g)].map((match) => match[0]),
    ),
  )].filter((url) => /(?:cdn\.jsdelivr\.net|gstatic\.com|tailwindcss\.com)/.test(url)).slice(0, 12);
  const withPath = new Set(
    candidates.filter((url) => new URL(url).pathname !== '/').map((url) => new URL(url).origin),
  );
  const urls = candidates.filter(
    (url) => !(new URL(url).pathname === '/' && withPath.has(new URL(url).origin)),
  );
  if (urls.length === 0) {
    reporter.warn('Nenhum CDN externo encontrado no HTML/JS.');
  }
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      if (response.ok || response.status === 405) reporter.ok(`CDN acessivel: ${url} (HTTP ${response.status}).`);
      else reporter.warn(`CDN respondeu HTTP ${response.status}: ${url}.`);
    } catch (error) {
      reporter.warn(`CDN inacessivel: ${url} (${error?.name === 'AbortError' ? 'tempo esgotado' : error.message}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (errorsBlockProbe(config)) {
    reporter.warn('Teste da chave do Firebase ignorado: configuracao incompleta.');
    return;
  }
  const probe = await probeFirebaseAuth(config.apiKey);
  if (probe.state === 'valid') {
    reporter.ok('Chave do Firebase valida e login por e-mail/senha habilitado.');
  } else if (probe.state === 'provider-disabled') {
    reporter.error('Login por e-mail/senha esta desabilitado no Firebase Authentication.');
  } else if (probe.state === 'invalid-key') {
    reporter.error('A apiKey do Firebase foi recusada. Copie novamente do console.');
  } else if (probe.state === 'invalid-project') {
    reporter.error('Projeto do Firebase nao encontrado para esta apiKey.');
  } else if (probe.state === 'network') {
    reporter.warn(`Nao foi possivel testar a chave do Firebase: ${probe.message}`);
  } else {
    reporter.warn(`Resposta inesperada do Firebase: ${probe.message}`);
  }
  reporter.info(`Teste realizado no projeto ${config.projectId}, colecao ${collection}.`);
}

function errorsBlockProbe(config) {
  return REQUIRED_FIREBASE_KEYS.some((key) => isPlaceholder(config[key]));
}

export async function runChecks({ online = false } = {}) {
  const reporter = new Reporter();
  log.title('Verificacao do projeto');
  const major = Number(process.versions.node.split('.')[0]);
  log.step(`Node.js ${process.version} em ${process.platform}/${process.arch}.`);
  if (major < 18) reporter.error('Node.js 18 ou superior e obrigatorio.');

  await checkFiles(reporter);
  await checkHtml(reporter);
  await checkCss(reporter);
  await checkJavaScript(reporter);
  await checkTranslations(reporter);
  await checkFirebase(reporter);
  await checkDeployment(reporter);

  const source = await readText(CONFIG_FILE);
  const { config, collection } = parseFirebaseConfig(source);
  if (online) {
    await checkOnline(reporter, config, collection);
  } else {
    reporter.section('Dicas');
    log.info('Use "check --online" para testar CDNs e a chave do Firebase.');
  }

  log.blank();
  if (reporter.errors.length) {
    log.error(`${reporter.errors.length} erro(s) encontrados. Corrija antes de publicar.`);
  } else {
    log.ok(`Verificacao concluida: ${reporter.passed} itens aprovados, ${reporter.warnings.length} aviso(s).`);
  }
  return {
    errors: reporter.errors,
    warnings: reporter.warnings,
    passed: reporter.passed,
    config,
    collection,
  };
}
