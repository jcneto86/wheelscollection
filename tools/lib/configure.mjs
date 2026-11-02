/**
 * Configuracao guiada do Firebase (js/firebase-config.js).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONFIG_FILE,
  WORK_DIR,
  DEFAULT_COLLECTION,
  FIREBASE_KEYS,
  readText,
  parseFirebaseConfig,
  validateFirebaseConfig,
  writeFirebaseConfig,
  probeFirebaseAuth,
  ask,
  confirm,
  ensureDir,
  paint,
  log,
} from './core.mjs';

const FIELDS = [
  {
    key: 'apiKey',
    flag: 'apiKey',
    label: 'API Key',
    hint: 'Firebase Console > Configuracoes do projeto > Geral > Seus apps > Web',
    required: true,
    validate: (value) => (/^AIza[0-9A-Za-z_-]{35}$/.test(value) ? null : 'deve comecar com AIza e ter 39 caracteres'),
  },
  {
    key: 'authDomain',
    flag: 'authDomain',
    label: 'Auth domain',
    hint: 'normalmente <project-id>.firebaseapp.com',
    required: true,
    validate: (value) => (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? null : 'informe um dominio valido'),
  },
  {
    key: 'projectId',
    flag: 'projectId',
    label: 'Project ID',
    hint: 'identificador do projeto, em minusculas',
    required: true,
    validate: (value) => (/^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/.test(value) ? null : 'use 6 a 30 caracteres: a-z, 0-9 e hifen'),
  },
  {
    key: 'storageBucket',
    flag: 'storageBucket',
    label: 'Storage bucket (opcional)',
    hint: 'nao e usado por este app; pressione Enter para manter vazio',
    required: false,
    validate: (value) => (value === '' || /^[a-z0-9.-]+$/.test(value) ? null : 'informe um bucket valido'),
  },
  {
    key: 'messagingSenderId',
    flag: 'messagingSenderId',
    label: 'Messaging sender ID (opcional)',
    hint: 'apenas numeros',
    required: false,
    validate: (value) => (value === '' || /^\d+$/.test(value) ? null : 'deve conter apenas numeros'),
  },
  {
    key: 'appId',
    flag: 'appId',
    label: 'App ID',
    hint: 'formato 1:123456789:web:abcdef',
    required: true,
    validate: (value) => (/^1:\d+:(web|android|ios):[0-9a-f]+$/.test(value) ? null : 'formato esperado 1:numeros:web:hexadecimal'),
  },
  {
    key: 'measurementId',
    flag: 'measurementId',
    label: 'Measurement ID (opcional)',
    hint: 'formato G-XXXXXXXXXX',
    required: false,
    validate: (value) => (value === '' || /^G-[A-Z0-9]+$/.test(value) ? null : 'formato esperado G-XXXXXXXXXX'),
  },
];

async function resolveValue(field, current, options) {
  const provided = options[field.flag];
  if (provided !== undefined) {
    const value = String(provided).trim();
    const error = field.validate(value);
    if (error && (value !== '' || field.required)) {
      throw new Error(`${field.label}: ${error}.`);
    }
    return value;
  }
  if (options.yes) return String(current[field.key] || '');

  let defaultValue = String(current[field.key] || '');
  for (;;) {
    const suffix = field.required ? '' : ' (Enter para vazio)';
    const answer = await ask(`${field.label}${suffix}`, {
      defaultValue,
      allowEmpty: !field.required,
    });
    const value = answer.trim();
    if (!value && !field.required) return '';
    const error = !value ? 'valor obrigatorio' : field.validate(value);
    if (!error) return value;
    log.warn(`${field.label}: ${error}.`);
    defaultValue = value;
  }
}

async function backupConfig() {
  const dir = path.join(WORK_DIR, 'backups');
  await ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `firebase-config-${stamp}.js`);
  await fs.copyFile(CONFIG_FILE, target);
  return target;
}

export async function runConfigure(options = {}) {
  log.title('Configuracao do Firebase');
  let source;
  try {
    source = await readText(CONFIG_FILE);
  } catch {
    throw new Error('js/firebase-config.js nao encontrado. Execute o comando a partir de appphp/.');
  }
  const { config: current, collection: currentCollection } = parseFirebaseConfig(source);
  log.info(`Projeto atual: ${current.projectId || '(nao configurado)'}`);
  log.info(`Colecao atual: ${currentCollection || '(nao definida)'}`);
  log.info('Os valores sao publicos por design. A protecao real vem das regras do Firestore.');
  log.blank();

  const next = {};
  for (const field of FIELDS) {
    next[field.key] = await resolveValue(field, current, options);
    if (next[field.key]) log.ok(`${field.label}: ${paint.gray(next[field.key])}`);
  }

  let collection = String(options.collection || currentCollection || DEFAULT_COLLECTION).trim();
  if (!options.collection && !options.yes) {
    collection = await ask('Colecao do Firestore', { defaultValue: collection });
  }
  if (!/^[A-Za-z0-9_]{1,100}$/.test(collection) || collection.startsWith('__')) {
    throw new Error('Nome de colecao invalido. Use letras, numeros e underscore.');
  }

  const validation = validateFirebaseConfig(next, collection);
  for (const message of validation.warnings) log.warn(message);
  if (validation.errors.length) {
    for (const message of validation.errors) log.error(message);
    throw new Error('Configuracao invalida. Nada foi salvo.');
  }

  const shouldTest =
    options.test === true ||
    (options.test !== false && !options.yes && (await confirm('Testar agora a chave e o login por e-mail/senha?', true)));

  let probe = null;
  if (shouldTest) {
    log.step('Consultando o Firebase Authentication...');
    probe = await probeFirebaseAuth(next.apiKey);
    if (probe.state === 'valid') {
      log.ok('Chave valida e login por e-mail/senha habilitado.');
    } else if (probe.state === 'provider-disabled') {
      log.warn('A chave existe, mas o login por e-mail/senha esta desabilitado.');
      log.info('Ative em Authentication > Sign-in method > Email/Password.');
    } else if (probe.state === 'invalid-key') {
      log.error('A apiKey foi recusada pelo Firebase.');
    } else if (probe.state === 'invalid-project') {
      log.error('Projeto nao encontrado para esta apiKey.');
    } else if (probe.state === 'network') {
      log.warn(`Sem conexao para testar: ${probe.message}`);
    } else {
      log.warn(`Resposta inesperada: ${probe.message}`);
    }
  }

  if (!options.yes && !(await confirm('Salvar a configuracao em js/firebase-config.js?', true))) {
    log.info('Nada foi alterado.');
    return { saved: false, config: next, collection };
  }

  const backup = await backupConfig();
  try {
    await writeFirebaseConfig(next, collection);
  } catch (error) {
    await fs.copyFile(backup, CONFIG_FILE);
    throw new Error(`Falha ao gravar a configuracao (backup restaurado): ${error.message}`);
  }

  const saved = parseFirebaseConfig(await readText(CONFIG_FILE));
  if (saved.config.apiKey !== next.apiKey || saved.config.projectId !== next.projectId) {
    throw new Error('A gravacao nao foi confirmada. Verifique js/firebase-config.js.');
  }

  log.blank();
  log.ok('Configuracao salva em js/firebase-config.js.');
  log.info(`Backup: ${backup}`);
  log.blank();
  log.plain(paint.bold('Proximos passos obrigatorios no Firebase Console:'));
  log.info('1. Authentication > Sign-in method: ative E-mail/senha.');
  log.info('2. Authentication > Settings > Authorized domains: adicione "localhost" e o dominio da Hostinger.');
  log.info('3. Firestore > Regras: cole o conteudo de firestore.rules e publique.');
  log.info('4. Rode "check" e depois "build" para gerar a pasta de publicacao.');
  log.info(`Dominio de autenticacao esperado: ${next.authDomain}`);
  return { saved: true, config: next, collection, probe, backup };
}
