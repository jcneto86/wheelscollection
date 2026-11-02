import test from 'node:test';
import assert from 'node:assert/strict';

import { attachOcrPanel, getOcrPanelSession } from '../../js/app.js';

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

/** Minimal stand-in for the Alpine component the panel attaches to. */
function createComponent(overrides = {}) {
  const toasts = [];
  const component = {
    form: { name: '', description: '', imageBase64: 'BASE64' },
    formErrors: {},
    ocr: {
      scanning: false,
      auto: false,
      progress: 0,
      stage: 'library',
      result: null,
      error: '',
      autoEnabled: true,
    },
    t: (key) => `t:${key}`,
    showToast: (message) => toasts.push(message),
    ...overrides,
  };

  return { component, toasts };
}

function attach(overrides = {}, options = {}) {
  const timers = options.timers || fakeTimers();
  const { component, toasts } = createComponent(overrides);
  const scans = [];

  const session = attachOcrPanel(component, {
    timers,
    delay: 10,
    isMetered: () => false,
    readAuto: () => true,
    writeAuto: () => {},
    scan: async (image, scanOptions) => {
      scans.push({ image, sourceImage: scanOptions.sourceImage });
      return { name: 'ACURA NSX', description: "HW THE '90S · 2/10" };
    },
    ...options,
  });

  return { component, toasts, session, timers, scans };
}

test('attachOcrPanel exposes the panel methods and one session', () => {
  const { component, session } = attach();

  assert.ok(session);
  for (const method of [
    'scanPackaging',
    'cancelOcrScan',
    'setOcrAuto',
    'ocrOnCropApplied',
    'ocrCleanup',
  ]) {
    assert.equal(typeof component[method], 'function', `${method} ausente`);
  }

  assert.equal(getOcrPanelSession(component), session);
  assert.equal(component.ocr.autoEnabled, true);
});

test('attaching twice does not create a second session', () => {
  const { component, session } = attach();
  const again = attachOcrPanel(component, {});

  assert.equal(again, session);
  assert.equal(getOcrPanelSession(component), session);
});

test('manual scan fills both fields and toasts success', async () => {
  const { component, toasts, scans } = attach();

  await component.scanPackaging();

  assert.equal(scans.length, 1);
  assert.equal(component.form.name, 'ACURA NSX');
  assert.equal(component.form.description, "HW THE '90S · 2/10");
  assert.deepEqual(toasts, ['t:ocrSuccess']);
  assert.ok(component.ocr.result);
  assert.equal(component.ocr.scanning, false);
});

test('automatic scan fills empty fields without overwriting typed text', async () => {
  const { component, toasts, timers } = attach({
    form: { name: 'Meu nome', description: '', imageBase64: 'BASE64' },
  });

  component.ocrOnCropApplied('CANVAS');
  timers.flush();
  await getOcrPanelSession(component).whenIdle();

  assert.equal(component.form.name, 'Meu nome', 'não deve sobrescrever');
  assert.equal(component.form.description, "HW THE '90S · 2/10");
  assert.deepEqual(toasts, ['t:ocrPartial']);
});

test('the high resolution canvas reaches the scanner', async () => {
  const { component, timers, scans } = attach();

  component.ocrOnCropApplied('CANVAS');
  timers.flush();
  await getOcrPanelSession(component).whenIdle();

  assert.equal(scans[0].sourceImage, 'CANVAS');
});

test('cleanup cancels the scheduled automatic scan', async () => {
  const { component, scans, timers } = attach();

  component.ocrOnCropApplied('CANVAS');
  component.ocrCleanup();
  timers.flush();
  await Promise.resolve();

  assert.equal(scans.length, 0);
});

test('a result without fields reports ocrEmpty and closes the spinner', async () => {
  const { component, toasts } = attach(
    {},
    { scan: async () => ({ name: '', description: '' }) },
  );

  await component.scanPackaging();

  assert.deepEqual(toasts, []);
  assert.equal(component.ocr.error, 't:ocrEmpty');
  assert.equal(component.ocr.scanning, false);
});

test('a failing scan reports ocrFailed', async () => {
  const { component } = attach(
    {},
    { scan: async () => { throw new Error('boom'); } },
  );

  await component.scanPackaging();

  assert.equal(component.ocr.error, 't:ocrFailed');
  assert.equal(component.ocr.scanning, false);
});

test('progress is mirrored into the panel as a percentage', async () => {
  let release;
  const { component } = attach(
    {},
    {
      scan: (_image, options) => new Promise((resolve) => {
        options.onProgress({ stage: 'bottom', progress: 0.5 });
        release = () => resolve({ name: '', description: '' });
      }),
    },
  );

  component.scanPackaging();

  assert.equal(component.ocr.scanning, true);
  assert.equal(component.ocr.stage, 'bottom');
  assert.equal(component.ocr.progress, 50);

  release();
  await getOcrPanelSession(component).whenIdle();

  assert.equal(component.ocr.scanning, false);
  assert.equal(component.ocr.progress, 0, 'zera ao terminar');
});

test('setOcrAuto persists and refreshes the panel flag', () => {
  const writes = [];
  const { component } = attach({}, { writeAuto: (value) => writes.push(value) });

  component.setOcrAuto(false);

  assert.deepEqual(writes, [false]);
  assert.equal(component.ocr.autoEnabled, false);
});

test('formErrors of the filled fields are cleared', async () => {
  const { component } = attach({
    form: { name: '', description: '', imageBase64: 'BASE64' },
    formErrors: { name: 'obrigatório', description: 'obrigatório' },
  });

  await component.scanPackaging();

  assert.equal('name' in component.formErrors, false);
  assert.equal('description' in component.formErrors, false);
});
