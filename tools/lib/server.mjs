/**
 * Servidor HTTP local para debug, com live reload via Server-Sent Events.
 * Nao requer dependencias e nao usa cache, para refletir cada alteracao.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  APP_ROOT,
  INDEX_FILE,
  exists,
  paint,
  log,
  lanAddress,
  openTarget,
} from './core.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const DENIED_DIRECTORIES = new Set(['build', 'tools', 'node_modules', '.git', '.wheels']);
const DENIED_FILES = new Set([
  'firebase.json',
  'firestore.rules',
  'firestore.indexes.json',
  'README.md',
  'README.pt-BR.md',
  'package.json',
  '.htaccess',
  '.htpasswd',
]);

const RELOAD_SCRIPT = `
<script data-wheels-reload>
  (() => {
    try {
      const source = new EventSource('/__wheels/events');
      source.addEventListener('reload', () => window.location.reload());
      source.onerror = () => {};
    } catch (error) {
      /* navegador sem EventSource */
    }
  })();
</script>`;

function notFound(response, message = 'Arquivo nao encontrado.') {
  const body = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>404 - Wheels Collection</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
main{text-align:center;padding:2rem}code{color:#f87171}a{color:#60a5fa}</style>
<main><h1>404</h1><p>${message}</p><p><a href="/">Voltar para o app</a></p></main></html>`;
  response.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function forbidden(response) {
  response.writeHead(403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end('Acesso negado no servidor de debug.');
}

function isDenied(relative) {
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return true;
  if (segments.some((segment) => DENIED_DIRECTORIES.has(segment))) return true;
  const last = segments.at(-1);
  return Boolean(last && DENIED_FILES.has(last));
}

function injectReload(html) {
  if (html.includes('data-wheels-reload')) return html;
  if (html.includes('</body>')) return html.replace('</body>', `${RELOAD_SCRIPT}\n</body>`);
  return `${html}\n${RELOAD_SCRIPT}`;
}

async function serveFile(request, response, file, { watch }) {
  let data;
  if (path.extname(file) === '.html' && watch) {
    data = Buffer.from(injectReload(await fsp.readFile(file, 'utf8')), 'utf8');
  } else {
    const stat = await fsp.stat(file);
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(file).pipe(response);
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : data);
}

function startWatcher(onChange) {
  const watchers = [];
  let timer = null;
  const fire = (filename) => {
    const name = String(filename || '');
    if (name.startsWith('.') || name === 'build' || name === 'tools' || name === '.wheels') return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 180);
  };
  const targets = [APP_ROOT, ...['css', 'js', 'lang', 'assets'].map((dir) => path.join(APP_ROOT, dir))];
  for (const target of targets) {
    try {
      const watcher = fs.watch(target, { persistent: true }, (_event, filename) => fire(filename));
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      /* diretorio inexistente ou watch indisponivel */
    }
  }
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* ja fechado */
      }
    }
  };
}

async function listenWithRetry(server, host, initialPort) {
  let port = initialPort;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port >= 65535) throw error;
      log.warn(`Porta ${port} ocupada. Tentando ${port + 1}...`);
      port += 1;
    }
  }
  throw new Error('Nenhuma porta livre encontrada.');
}

export async function runDev(options = {}) {
  if (!(await exists(INDEX_FILE))) {
    throw new Error('index.html nao encontrado. Execute o comando a partir de appphp/.');
  }
  const watch = options.watch !== false;
  const open = options.open !== false;
  const host = options.host || '127.0.0.1';
  const requestedPort = Number(options.port || 8080);
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    throw new Error(`Porta invalida: ${options.port}. Use um numero entre 1 e 65535.`);
  }

  const clients = new Set();
  let watcherStop = null;

  const server = http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end('Metodo nao permitido.');
        return;
      }
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/__wheels/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write('retry: 1000\n\n');
        clients.add(response);
        const ping = setInterval(() => {
          try {
            response.write(': ping\n\n');
          } catch {
            /* conexao encerrada */
          }
        }, 25000);
        request.on('close', () => {
          clearInterval(ping);
          clients.delete(response);
        });
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400);
        response.end('URL invalida.');
        return;
      }
      if (pathname.includes('\0')) {
        response.writeHead(400);
        response.end('URL invalida.');
        return;
      }

      let relative = pathname.replace(/^\/+/, '');
      if (!relative || relative.endsWith('/')) relative += 'index.html';
      relative = path.posix.normalize(relative);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        forbidden(response);
        return;
      }
      if (isDenied(relative)) {
        forbidden(response);
        return;
      }

      const file = path.join(APP_ROOT, relative);
      if (file !== APP_ROOT && !file.startsWith(`${APP_ROOT}${path.sep}`)) {
        forbidden(response);
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        notFound(response);
        return;
      }
      if (stat.isDirectory()) {
        const index = path.join(file, 'index.html');
        if (await exists(index)) {
          await serveFile(request, response, index, { watch });
        } else {
          notFound(response, 'Diretorio sem index.html.');
        }
        return;
      }
      await serveFile(request, response, file, { watch });
    } catch (error) {
      log.error(`Falha ao atender ${request.url}: ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Erro interno do servidor de debug.');
    }
  });

  const port = await listenWithRetry(server, host, requestedPort);
  const localUrl = `http://localhost:${port}/`;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const lan = loopback ? null : (host === '0.0.0.0' || host === '::' ? lanAddress() : host);
  const lanUrl = lan ? `http://${lan}:${port}/` : null;

  if (watch) {
    watcherStop = startWatcher(() => {
      if (clients.size === 0) return;
      for (const client of clients) {
        try {
          client.write('event: reload\ndata: atualizar\n\n');
        } catch {
          clients.delete(client);
        }
      }
      log.info('Alteracao detectada: navegador recarregado.');
    });
  }

  log.title('Servidor de debug');
  log.ok(`App disponivel em ${paint.bold(localUrl)}`);
  if (lanUrl) log.info(`Na mesma rede (celular): ${lanUrl}`);
  log.info(`Live reload: ${watch ? 'ativo' : 'desativado'} | Ctrl+C para encerrar.`);
  log.info('O Firebase exige "localhost" entre os dominios autorizados (ja e padrao).');

  if (open) {
    setTimeout(() => {
      if (!openTarget(localUrl)) log.warn(`Nao foi possivel abrir o navegador. Acesse ${localUrl}`);
    }, 350);
  }

  return new Promise((resolve) => {
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      log.blank();
      log.info('Encerrando servidor de debug...');
      if (watcherStop) watcherStop();
      for (const client of clients) {
        try {
          client.end();
        } catch {
          /* ja encerrado */
        }
      }
      clients.clear();
      server.close(() => resolve({ port, stopped: true }));
      setTimeout(() => resolve({ port, stopped: true }), 1000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.once('close', () => {
      if (!closed) {
        closed = true;
        if (watcherStop) watcherStop();
        resolve({ port, stopped: true });
      }
    });
  });
}
