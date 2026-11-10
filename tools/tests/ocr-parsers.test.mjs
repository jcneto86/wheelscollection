import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_SCAN_DELAY,
  createScanSession,
  extractCarName,
  extractCollectionName,
  extractCollectionNumber,
  improveWordSpacing,
  mergeScanResult,
  parseHotWheelsText,
} from '../../js/app.js';

/* -------------------------------------------------------------------------- */
/* Parsers                                                                    */
/* -------------------------------------------------------------------------- */

test('car name survives packaging noise', () => {
  const name = extractCarName(['HOT WHEELS', '90 ACURA NSX', 'AGE 3+', 'MATTEL']);
  assert.match(name, /ACURA NSX/);
});

test('glued OCR words get their spaces back', () => {
  assert.equal(improveWordSpacing('90ACURANSX'), '90 ACURA NSX');
  assert.equal(improveWordSpacing('HOTWHEELS2024'), 'HOT WHEELS 2024');
  assert.equal(improveWordSpacing('ALFAROMEOGIULIA'), 'ALFA ROMEO GIULIA');
  assert.equal(improveWordSpacing('COLLECTOR1/64'), 'COLLECTOR 1/64');
  assert.equal(improveWordSpacing('HWTHE 90S'), 'HW THE 90S');
  assert.equal(improveWordSpacing('V8 ENGINE'), 'V8 ENGINE');
});

test('box-edge glyphs are removed from the car name', () => {
  assert.equal(extractCarName(['T 90 ACURA NSX T']), '90 ACURA NSX');
  assert.equal(extractCarName(['I90 ACURA NSX']), '90 ACURA NSX');
  assert.equal(extractCarName(['Tesla Model S']), 'Tesla Model S');
});

test('car name is recovered from glued OCR output', () => {
  const name = extractCarName(['90ACURANSX', '2/10']);
  assert.match(name, /ACURA NSX/);
});

test('collection number is read from a plausible line', () => {
  assert.equal(extractCollectionNumber(['HW THE \'90S', '2/10']), '2/10');
  assert.equal(extractCollectionNumber(['2 OF 10']), '2/10');
  assert.equal(extractCollectionNumber(['125/250']), '125/250');
});

test('scale is never a collection number', () => {
  assert.equal(extractCollectionNumber(['SCALE 1/64']), '');
  assert.equal(extractCollectionNumber(['1/64']), '');
  assert.equal(extractCollectionNumber(['1/24']), '');
  assert.equal(extractCollectionNumber(['1/18']), '');
  assert.equal(extractCollectionNumber(['1/12']), '');
});

test('SCALE on another line also invalidates the fraction', () => {
  assert.equal(extractCollectionNumber(['SCALE', '1/18']), '');
  assert.equal(extractCollectionNumber(['ESCALA', '1/24']), '');
});

test('an explicit collection keeps the number even next to a scale', () => {
  assert.equal(extractCollectionNumber(['COLLECTION 1/24']), '1/24');
});

test('year ranges are rejected', () => {
  assert.equal(extractCollectionNumber(['2023/2024']), '');
});

test('description combines collection and number', () => {
  const result = parseHotWheelsText("HW THE '90S\n2/10");
  assert.equal(result.collectionNumber, '2/10');
  assert.equal(result.collectionName, "HW THE '90S");
  assert.equal(result.description, "HW THE '90S · 2/10");
});

test('a car brand alone is not a collection name', () => {
  assert.equal(extractCollectionName(['90 ACURA NSX'], {}), '');
});

/* -------------------------------------------------------------------------- */
/* Merge rules                                                                */
/* -------------------------------------------------------------------------- */

test('automatic merge never overwrites what the user typed', () => {
  const current = { name: 'Meu nome', description: '' };
  const result = { name: 'ACURA NSX', description: "HW THE '90S · 2/10" };

  const soft = mergeScanResult(current, result);

  assert.equal(soft.name, 'Meu nome');
  assert.equal(soft.description, "HW THE '90S · 2/10");
  assert.equal(soft.filledName, false);
  assert.equal(soft.filledDescription, true);
  assert.equal(soft.complete, false);
});

test('explicit merge overwrites both fields', () => {
  const current = { name: 'Meu nome', description: 'Minha descrição' };
  const result = { name: 'ACURA NSX', description: "HW THE '90S · 2/10" };

  const hard = mergeScanResult(current, result, { overwrite: true });

  assert.equal(hard.name, 'ACURA NSX');
  assert.equal(hard.description, "HW THE '90S · 2/10");
  assert.equal(hard.complete, true);
});

test('empty scan values never clear anything', () => {
  const merged = mergeScanResult(
    { name: 'A', description: 'B' },
    { name: '', description: '   ' },
    { overwrite: true },
  );

  assert.equal(merged.name, 'A');
  assert.equal(merged.description, 'B');
  assert.equal(merged.filled, false);
});

/* -------------------------------------------------------------------------- */
/* Scan session                                                               */
/* -------------------------------------------------------------------------- */

function fakeTimers() {
  const pending = [];
  return {
    set(callback) {
      pending.push(callback);
      return pending.length;
    },
    clear() {
      pending.length = 0;
    },
    flush() {
      for (const callback of pending.splice(0)) callback();
    },
  };
}

function createSession(overrides = {}) {
  const timers = overrides.timers || fakeTimers();
  const calls = [];
  const results = [];

  const session = createScanSession({
    timers,
    delay: 10,
    getImage: () => 'BASE64',
    getSource: () => 'CANVAS',
    isMetered: () => false,
    readAuto: () => true,
    writeAuto: () => {},
    scan: async (image, options) => {
      calls.push({ image, sourceImage: options.sourceImage, signal: options.signal });
      return { name: 'ACURA NSX', description: "HW THE '90S · 2/10" };
    },
    onResult: (result, meta) => results.push({ result, meta }),
    ...overrides,
  });

  return { session, timers, calls, results };
}

test('automatic scan runs once, after the delay, with the high resolution source', async () => {
  const { session, timers, calls, results } = createSession();

  session.auto();
  assert.equal(calls.length, 0, 'não deve rodar antes do delay');

  timers.flush();
  await session.whenIdle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].image, 'BASE64');
  assert.equal(calls[0].sourceImage, 'CANVAS');
  assert.equal(results.length, 1);
  assert.equal(results[0].meta.overwrite, false, 'automático não sobrescreve');
});

test('manual scan overwrites and cancels the pending schedule', async () => {
  const { session, timers, calls, results } = createSession();

  session.auto();
  await session.manual();

  assert.equal(calls.length, 1);
  assert.equal(results[0].meta.overwrite, true);

  timers.flush();
  await session.whenIdle();
  assert.equal(calls.length, 1, 'o agendamento automático foi cancelado');
});

test('double scheduling only runs once', async () => {
  const { session, timers, calls } = createSession();

  session.auto();
  session.auto();
  timers.flush();
  await session.whenIdle();

  assert.equal(calls.length, 1);
});

test('cancelled scan never delivers its result', async () => {
  let release;
  const results = [];
  const timers = fakeTimers();

  const session = createScanSession({
    timers,
    delay: 10,
    getImage: () => 'BASE64',
    getSource: () => null,
    isMetered: () => false,
    readAuto: () => true,
    writeAuto: () => {},
    scan: () => new Promise((resolve) => {
      release = resolve;
    }),
    onResult: (result, meta) => results.push({ result, meta }),
  });

  session.auto();
  timers.flush();
  const idle = session.whenIdle();
  session.cancel();
  release({ name: 'ACURA NSX', description: 'X' });
  await idle;

  assert.deepEqual(results, []);
});

test('preference and metered connection block the automatic scan', () => {
  const timers = fakeTimers();
  let scans = 0;
  const scan = async () => {
    scans += 1;
    return {};
  };

  const disabled = createScanSession({
    timers,
    getImage: () => 'BASE64',
    readAuto: () => false,
    writeAuto: () => {},
    isMetered: () => false,
    scan,
  });
  disabled.auto();
  timers.flush();
  assert.equal(scans, 0, 'preferência desligada');

  const metered = createScanSession({
    timers,
    getImage: () => 'BASE64',
    readAuto: () => true,
    writeAuto: () => {},
    isMetered: () => true,
    scan,
  });
  metered.auto();
  timers.flush();
  assert.equal(scans, 0, 'rede medida');
});

test('no image means no scan', () => {
  const timers = fakeTimers();
  let scans = 0;

  const session = createScanSession({
    timers,
    getImage: () => '',
    readAuto: () => true,
    writeAuto: () => {},
    isMetered: () => false,
    scan: async () => {
      scans += 1;
      return {};
    },
  });

  session.auto();
  timers.flush();
  assert.equal(scans, 0);
});

test('setEnabled persists the preference and exposes it', () => {
  const writes = [];
  const { session } = createSession({ writeAuto: (value) => writes.push(value) });

  assert.equal(session.isEnabled(), true);
  session.setEnabled(false);
  assert.equal(session.isEnabled(), false);
  assert.deepEqual(writes, [false]);
});

test('progress is reported as an integer percentage', async () => {
  const progress = [];
  const timers = fakeTimers();

  const session = createScanSession({
    timers,
    delay: 10,
    getImage: () => 'BASE64',
    readAuto: () => true,
    writeAuto: () => {},
    isMetered: () => false,
    scan: async (_image, options) => {
      options.onProgress({ stage: 'bottom', progress: 0.456 });
      return { name: '', description: '' };
    },
    onProgress: (event) => progress.push(event.progress),
  });

  session.auto();
  timers.flush();
  await session.whenIdle();

  assert.deepEqual(progress, [0.456]);
  assert.equal(session.getState().progress, 0);
});

test('the delay is a positive number', () => {
  assert.ok(AUTO_SCAN_DELAY > 0);
});
