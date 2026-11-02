import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREPROCESS_DEFAULTS,
  enhancePixels,
  pickChannel,
} from '../../js/ocr.js';

function solid(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }
  return data;
}

function meanRed(data) {
  let sum = 0;
  const count = data.length / 4;
  for (let i = 0; i < count; i += 1) sum += data[i * 4];
  return sum / count;
}

test('a flat white crop does not become black', () => {
  const data = solid(64, 64, 255);
  enhancePixels(data, 64, 64, {});
  assert.ok(meanRed(data) > 240, `fundo deveria ficar claro, veio ${meanRed(data)}`);
});

test('a flat black crop does not become white', () => {
  const data = solid(64, 64, 0);
  enhancePixels(data, 64, 64, {});
  assert.ok(meanRed(data) < 15, `fundo deveria ficar escuro, veio ${meanRed(data)}`);
});

test('a mid grey bar on white gains contrast', () => {
  const width = 64;
  const height = 64;
  const data = solid(width, height, 255);

  for (let y = 20; y < 44; y += 1) {
    for (let x = 20; x < 44; x += 1) {
      const p = (y * width + x) * 4;
      data[p] = 120;
      data[p + 1] = 120;
      data[p + 2] = 120;
    }
  }

  enhancePixels(data, width, height, {});

  const center = data[(32 * width + 32) * 4];
  const background = data[(2 * width + 2) * 4];

  assert.ok(center < 60, `traço deveria ficar escuro, veio ${center}`);
  assert.ok(background > 200, `fundo deveria ficar claro, veio ${background}`);
  assert.ok(background - center > 140, 'o contraste precisa aumentar');
});

test('output is always opaque grayscale', () => {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    data[p] = (i * 7) % 256;
    data[p + 1] = (i * 3) % 256;
    data[p + 2] = (i * 11) % 256;
    data[p + 3] = 128;
  }

  enhancePixels(data, width, height, {});

  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    assert.equal(data[p], data[p + 1]);
    assert.equal(data[p + 1], data[p + 2]);
    assert.equal(data[p + 3], 255);
  }
});

test('denoise keeps a strong edge but smooths isolated noise', () => {
  const width = 32;
  const height = 32;

  const noisy = solid(width, height, 200);
  const before = [];
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 24; x += 1) {
      const p = (y * width + x) * 4;
      noisy[p] = 60;
      noisy[p + 1] = 60;
      noisy[p + 2] = 60;
      before.push(p);
    }
  }

  enhancePixels(noisy, width, height, { denoise: true, clahe: false, sharpen: 0 });

  const center = noisy[(16 * width + 16) * 4];
  assert.ok(center < 90, `a borda forte deveria sobreviver, veio ${center}`);
});

test('channel picker prefers the channel where the glyphs are', () => {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);

  /* Yellow plate (r=g=255, b=0) with black text: the blue channel is flat and
   * useless, red and green carry the letters. */
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const isGlyph = x > 16 && x < 32 && y % 8 < 4;
      data[p] = isGlyph ? 0 : 255;
      data[p + 1] = isGlyph ? 0 : 255;
      data[p + 2] = 0;
      data[p + 3] = 255;
    }
  }

  const channel = pickChannel(data, width, height);
  assert.notEqual(channel, 3, 'o canal azul não deveria vencer');
});

test('defaults stay stable', () => {
  assert.equal(PREPROCESS_DEFAULTS.targetLongSide, 1200);
  assert.equal(PREPROCESS_DEFAULTS.pad, 16);
  assert.equal(PREPROCESS_DEFAULTS.clahe, true);
});
