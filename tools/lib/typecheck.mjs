/**
 * Type-checks the browser JavaScript with TypeScript's `checkJs`.
 *
 * Usage:
 *   node tools/lib/typecheck.mjs
 *
 * Requires network only on the first run (npx downloads typescript@5).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const TYPESCRIPT_VERSION = '5.7.3';

const args = [
  '--yes',
  '-p',
  `typescript@${TYPESCRIPT_VERSION}`,
  'tsc',
  '-p',
  'tsconfig.json',
];

const child = spawn('npx', args, {
  cwd: APP_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const code = await new Promise((resolve) => {
  child.on('close', resolve);
  child.on('error', (error) => {
    console.error('[typecheck] não foi possível executar o npx:', error.message);
    resolve(1);
  });
});

process.exit(Number(code) || 0);
