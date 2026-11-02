/**
 * Compiles `css/tailwind.css` from `index.html` + `js/**\/*.js`.
 *
 * Why a wrapper instead of calling the CLI directly in package.json:
 *
 *   1. the Tailwind CLI skips the write when the generated CSS is identical,
 *      so the file timestamp would not reflect "just compiled" — and
 *      `npm run check` uses that timestamp to warn about a stale stylesheet;
 *   2. removing the output first guarantees the build always produces a fresh
 *      file (and fails loudly if the CLI did not run).
 *
 * Usage:
 *   node tools/lib/tailwind.mjs           # one shot, minified
 *   node tools/lib/tailwind.mjs --watch   # rebuild while editing
 *
 * Requires network only on the first run (npx downloads tailwindcss@3).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const OUTPUT = path.join(APP_ROOT, 'css', 'tailwind.css');
const TAILWIND_VERSION = '3.4.17';
const watch = process.argv.includes('--watch');

async function run() {
  if (!watch) {
    await fs.rm(OUTPUT, { force: true });
  }

  const args = [
    '--yes',
    `tailwindcss@${TAILWIND_VERSION}`,
    '-c',
    'tailwind.config.cjs',
    '-i',
    'tailwind.src.css',
    '-o',
    'css/tailwind.css',
  ];

  if (!watch) args.push('--minify');

  const child = spawn('npx', args, {
    cwd: APP_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (error) => {
      console.error('[tailwind] não foi possível executar o npx:', error.message);
      resolve(1);
    });
  });

  if (code !== 0) {
    process.exit(code || 1);
  }

  if (!watch) {
    const stat = await fs.stat(OUTPUT).catch(() => null);
    if (!stat) {
      console.error('[tailwind] css/tailwind.css não foi gerado.');
      process.exit(1);
    }
    console.log(`[tailwind] css/tailwind.css: ${(stat.size / 1024).toFixed(1)} KB.`);
  }
}

run().catch((error) => {
  console.error('[tailwind] falhou:', error);
  process.exit(1);
});
