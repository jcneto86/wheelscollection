#!/usr/bin/env node
/**
 * Wheels Collection - CLI de desenvolvimento.
 *
 * Comandos: menu, dev, check, configure, build, help.
 * Requisitos: Node.js 18+. Sem dependencias externas.
 * Funciona em Windows, macOS e Linux.
 */

import {
  APP_ROOT,
  BUILD_DIR,
  CONFIG_FILE,
  readText,
  parseFirebaseConfig,
  exists,
  ask,
  confirm,
  pause,
  closePrompts,
  openTarget,
  paint,
  log,
} from './lib/core.mjs';
import { runDev } from './lib/server.mjs';
import { runChecks } from './lib/check.mjs';
import { runConfigure } from './lib/configure.mjs';
import { runBuild } from './lib/build.mjs';

const CLI_VERSION = '1.0.0';
const COMMANDS = new Map([
  ['menu', 'menu'],
  ['dev', 'dev'],
  ['serve', 'dev'],
  ['debug', 'dev'],
  ['start', 'dev'],
  ['check', 'check'],
  ['verify', 'check'],
  ['configure', 'configure'],
  ['config', 'configure'],
  ['setup', 'configure'],
  ['build', 'build'],
  ['dist', 'build'],
  ['help', 'help'],
  ['version', 'version'],
]);

const VALUE_FLAGS = new Map([
  ['port', 'port'],
  ['p', 'port'],
  ['host', 'host'],
  ['collection', 'collection'],
  ['api-key', 'apiKey'],
  ['auth-domain', 'authDomain'],
  ['project-id', 'projectId'],
  ['storage-bucket', 'storageBucket'],
  ['sender-id', 'messagingSenderId'],
  ['messaging-sender-id', 'messagingSenderId'],
  ['app-id', 'appId'],
  ['measurement-id', 'measurementId'],
]);

const BOOLEAN_FLAGS = new Set([
  'open', 'watch', 'online', 'yes', 'test', 'skip-check', 'allow-placeholder', 'help', 'version',
]);

function parseBoolean(value) {
  if (value === undefined) return true;
  return !['0', 'false', 'nao', 'não', 'no', 'off'].includes(String(value).toLowerCase());
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '-v') {
      options.version = true;
      continue;
    }
    if (arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const equal = body.indexOf('=');
      const rawKey = equal === -1 ? body : body.slice(0, equal);
      const inline = equal === -1 ? undefined : body.slice(equal + 1);
      const key = rawKey.toLowerCase();

      if (key.startsWith('no-')) {
        const base = key.slice(3);
        if (!BOOLEAN_FLAGS.has(base)) throw new Error(`Opcao desconhecida: --${rawKey}`);
        options[toCamel(base)] = false;
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        let value = inline;
        if (value === undefined) {
          index += 1;
          value = argv[index];
        }
        if (value === undefined || value === '') {
          throw new Error(`A opcao --${rawKey} exige um valor.`);
        }
        options[VALUE_FLAGS.get(key)] = value;
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        options[toCamel(key)] = parseBoolean(inline);
        continue;
      }
      throw new Error(`Opcao desconhecida: --${rawKey}. Use "help" para ver as opcoes.`);
    }
    if (arg.startsWith('-')) throw new Error(`Opcao desconhecida: ${arg}.`);
    options._.push(arg);
  }
  return options;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
}

function printHelp() {
  log.blank();
  log.plain(paint.bold(paint.cyan('Wheels Collection - CLI web')));
  log.info(`Versao ${CLI_VERSION} | Node.js 18+ | Windows, macOS e Linux`);
  log.blank();
  log.plain(paint.bold('Uso:'));
  log.plain('  node tools/wheels.mjs <comando> [opcoes]');
  log.plain('  ./tools/wheels.sh <comando>        (macOS/Linux)');
  log.plain('  tools\\wheels.cmd <comando>         (Windows)');
  log.plain('  npm run dev -- --port 3000          (atalhos do package.json)');
  log.blank();
  log.plain(paint.bold('Comandos:'));
  log.plain('  menu        Menu interativo (padrao quando nao ha argumentos)');
  log.plain('  dev         Servidor local de debug com live reload');
  log.plain('  check       Verifica arquivos, HTML, CSS, JS, traducoes e Firebase');
  log.plain('  configure   Configura as chaves do Firebase de forma guiada');
  log.plain('  build       Valida e gera build/ pronta para a Hostinger');
  log.plain('  help        Mostra esta ajuda');
  log.blank();
  log.plain(paint.bold('Opcoes:'));
  log.plain('  -p, --port <n>       Porta do servidor (padrao 8080)');
  log.plain('  --host <endereco>    Endereco do servidor (padrao 127.0.0.1)');
  log.plain('  --open / --no-open   Abre (ou nao) o navegador/pasta ao final');
  log.plain('  --watch / --no-watch Ativa ou desativa o live reload');
  log.plain('  --online             Testa CDNs e a chave do Firebase (check/build)');
  log.plain('  --skip-check         Build sem verificacoes (nao recomendado)');
  log.plain('  --allow-placeholder  Gera o build mesmo sem Firebase configurado');
  log.plain('  -y, --yes            Nao faz perguntas (configure)');
  log.plain('  --test / --no-test   Testa (ou nao) a chave do Firebase');
  log.blank();
  log.plain(paint.bold('Opcoes do configure:'));
  log.plain('  --api-key <valor> --auth-domain <valor> --project-id <valor>');
  log.plain('  --app-id <valor> --sender-id <valor> --measurement-id <valor>');
  log.plain('  --storage-bucket <valor> --collection <nome>');
  log.blank();
  log.plain(paint.bold('Exemplos:'));
  log.plain('  node tools/wheels.mjs dev --port 3000 --open');
  log.plain('  node tools/wheels.mjs check --online');
  log.plain('  node tools/wheels.mjs configure');
  log.plain('  node tools/wheels.mjs build');
  log.blank();
  log.info('Guia completo: README.md (secoes 6, 7 e 8).');
}

async function projectStatus() {
  let projectId = '(nao configurado)';
  try {
    const { config } = parseFirebaseConfig(await readText(CONFIG_FILE));
    if (config.projectId) projectId = config.projectId;
  } catch {
    /* configuracao ausente */
  }
  const build = (await exists(BUILD_DIR)) ? 'gerada' : 'pendente';
  return { projectId, build };
}

async function runMenu() {
  for (;;) {
    const status = await projectStatus();
    log.blank();
    log.plain(paint.bold(paint.cyan('+--------------------------------------------+')));
    log.plain(paint.bold(paint.cyan('|  Wheels Collection - ferramentas web        |')));
    log.plain(paint.bold(paint.cyan('+--------------------------------------------+')));
    log.info(`Node ${process.version} | Firebase: ${status.projectId} | Build: ${status.build}`);
    log.blank();
    log.plain('  1) Debug local (servidor com live reload)');
    log.plain('  2) Verificar projeto');
    log.plain('  3) Configurar Firebase');
    log.plain('  4) Gerar build para hospedagem');
    log.plain('  5) Abrir pasta build');
    log.plain('  6) Ajuda');
    log.plain('  0) Sair');

    let choice;
    try {
      choice = (await ask('Opcao', { allowEmpty: true })).trim() || '0';
    } catch {
      return;
    }
    log.blank();

    try {
      if (choice === '1') {
        const port = await ask('Porta', { defaultValue: '8080' });
        const open = await confirm('Abrir o navegador?', true);
        closePrompts();
        await runDev({ port, open, watch: true });
        await pause('Enter para voltar ao menu...');
      } else if (choice === '2') {
        const online = await confirm('Incluir teste de rede e Firebase?', false);
        const result = await runChecks({ online });
        log.info(`Resultado: ${result.errors.length} erro(s), ${result.warnings.length} aviso(s).`);
        await pause();
      } else if (choice === '3') {
        await runConfigure({});
        await pause();
      } else if (choice === '4') {
        const online = await confirm('Incluir teste de rede antes do build?', false);
        const open = await confirm('Abrir a pasta build ao final?', true);
        await runBuild({ online, open });
        await pause();
      } else if (choice === '5') {
        if (await exists(BUILD_DIR)) {
          if (openTarget(BUILD_DIR)) log.ok('Pasta build aberta.');
          else log.warn(`Nao foi possivel abrir. Caminho: ${BUILD_DIR}`);
        } else {
          log.warn('A pasta build ainda nao existe. Use a opcao 4.');
        }
        await pause();
      } else if (choice === '6') {
        printHelp();
        await pause();
      } else if (choice === '0' || choice.toLowerCase() === 'sair') {
        return;
      } else {
        log.warn(`Opcao invalida: ${choice}`);
      }
    } catch (error) {
      log.error(error.message);
      await pause();
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    log.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    console.log(CLI_VERSION);
    return;
  }

  const rawCommand = options._[0] || (process.stdin.isTTY ? 'menu' : 'help');
  const command = COMMANDS.get(String(rawCommand).toLowerCase());
  if (!command) {
    log.error(`Comando desconhecido: ${rawCommand}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  try {
    if (command === 'help') {
      printHelp();
    } else if (command === 'version') {
      console.log(CLI_VERSION);
    } else if (command === 'menu') {
      await runMenu();
    } else if (command === 'dev') {
      await runDev(options);
    } else if (command === 'check') {
      const result = await runChecks({ online: options.online === true });
      if (result.errors.length) process.exitCode = 1;
    } else if (command === 'configure') {
      await runConfigure(options);
    } else if (command === 'build') {
      await runBuild(options);
    }
  } catch (error) {
    log.error(error.message || String(error));
    process.exitCode = 1;
  } finally {
    closePrompts();
  }
}

main();
