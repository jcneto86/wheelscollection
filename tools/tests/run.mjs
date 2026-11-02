/**
 * Runs every `*.test.mjs` of this folder in a single process.
 *
 * `node --test tools/tests/` does the same thing, but it spawns one child
 * process per file with piped stdio, which some sandboxed environments block.
 * This runner has no such dependency and still exits non-zero on failure
 * because `node:test` sets `process.exitCode`.
 *
 * `setup.mjs` comes first on purpose: ES modules are evaluated in import order,
 * so the localStorage shim exists before any test module is loaded.
 */
import './setup.mjs';
import './ocr-parsers.test.mjs';
import './ocr-panel.test.mjs';
import './controller.test.mjs';
import './preprocess.test.mjs';
