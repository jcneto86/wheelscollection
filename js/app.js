/**
 * Local OCR for Hot Wheels blister cards - OPTIMIZED VERSION
 *
 * Everything in this module runs in the browser. The image never leaves the
 * device: Tesseract.js is loaded from a CDN and the recognition happens in a
 * Web Worker.
 *
 * The scanner is intentionally not tied to one card layout:
 *   1. a full-card pass collects all visible text and its position;
 *   2. the detected text boxes are used to derive a bottom band (model name)
 *      and a right-side band (collection name) with safe fallbacks;
 *   3. focused passes read those bands at a higher resolution, including a
 *      90-degree rotation for vertical collection strips;
 *   4. `extractCarName`, `extractDescription` and `extractCollectionNumber`
 *      parse the combined lines with noise filters and scores.
 *
 * Pixel work is delegated to `prepareRegion` (./ocr.js), which owns the
 * grayscale/channel/CLAHE pipeline, the isotropic scale and the padding.
 */

import { prepareRegion } from './ocr.js';
import { loadOcrAuto, saveOcrAuto } from './preferences.js';
import { runPpOcr, terminateOcrWorker, preloadOcrModels } from './ocr-onnx.js';

/* -------------------------------------------------------------------------- */
/* Tesseract.js configuration                                                 */
/* -------------------------------------------------------------------------- */

const TESSERACT_VERSION = '7.0.0';
const TESSERACT_ESM_URL =
  `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;
const TESSERACT_WORKER_URL =
  `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`;
/*
 * The core package has its own version line: `tesseract.js@7` depends on
 * `tesseract.js-core@^7`. Bumping TESSERACT_VERSION without bumping
 * TESSERACT_CORE_VERSION makes createWorker fail with a generic
 * `ocr-unavailable`, so both live side by side on purpose.
 */
const TESSERACT_CORE_VERSION = '7.0.0';
const TESSERACT_CORE_URL =
  `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE_VERSION}`;
const TESSERACT_LANG_URL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int';

/** Overall progress ranges for each stage. */
const PHASE_RANGES = Object.freeze({
  library: [0, 0.12],
  preparing: [0.12, 0.18],
  analyzing: [0.18, 0.22],
  full: [0.22, 0.44],
  bottom: [0.44, 0.64],
  side: [0.64, 0.82],
  numbers: [0.82, 0.9],
  parsing: [0.9, 1],
});

/*
 * Candidate regions, in normalised card coordinates. They are tried in order
 * and the first one that satisfies the parser wins, so a layout the full pass
 * failed to detect still gets read. Coordinates come from measurements on a
 * 2023+ card (number above the blister, strip on the right edge of the
 * blister) plus the older layout.
 */
const PRIORS = Object.freeze({
  bottom: [
    { x: 0.03, y: 0.74, w: 0.72, h: 0.16 }, // just below the blister
    { x: 0.02, y: 0.62, w: 0.86, h: 0.3 }, // wide fallback
  ],
  side: [
    { x: 0.5, y: 0.3, w: 0.14, h: 0.66 }, // 2023+ card
    { x: 0.62, y: 0.25, w: 0.16, h: 0.7 },
    { x: 0.78, y: 0.18, w: 0.2, h: 0.78 }, // older card
  ],
  number: [
    { x: 0.51, y: 0.45, w: 0.12, h: 0.1 }, // above the blister
    { x: 0.55, y: 0.02, w: 0.42, h: 0.2 }, // top-right corner
  ],
});

const FULL_REGION = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/**
 * Per-pass preprocessing. `targetLongSide` is expressed in output pixels and
 * `maxScale` caps the upscale, so a 60 px crop is no longer blown up 20x into
 * a 1200 px canvas (pure interpolation, no extra information).
 */
const PREP = Object.freeze({
  full: { targetLongSide: 1200, maxScale: 1.5, pad: 0, enhance: false },
  bottom: { targetLongSide: 1200, maxScale: 4, pad: 16, enhance: true },
  side: { targetLongSide: 1400, maxScale: 4, pad: 16, enhance: true },
  number: { targetLongSide: 800, maxScale: 6, pad: 16, enhance: true },
});

/** Scale denominators printed on packaging ("SCALE 1:64"), never collection. */
const SCALE_TOTALS = new Set([12, 16, 18, 24, 32, 43, 50, 64, 72, 87, 100]);
const SCALE_WORDS = /\b(?:SCALE|ÉCHELLE|ESCALA)\b/i;
const COLLECTION_WORDS = /\b(?:COLLECTION|COLE[CÇ][AÃ]O|S[EÉ]RIE|SERIES)\b/i;

/** Delay before the automatic scan so the crop modal can close and paint. */
export const AUTO_SCAN_DELAY = 350;

/**
 * Diagnostics. Enable with `localStorage.setItem('wheels.ocrDebug', '1')` and
 * inspect `window.__wheelsOcrDebug` — each entry holds the exact canvas that
 * was sent to Tesseract plus the raw text and the pass duration.
 *
 * Read lazily: importing this module must not touch `localStorage` (it throws
 * in Node and is blocked in some private-browsing modes).
 */
function isOcrDebugEnabled() {
  try {
    return localStorage.getItem('wheels.ocrDebug') === '1';
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary used by the parsers                                             */
/* -------------------------------------------------------------------------- */

const CAR_BRANDS = [
  'ACURA',
  'ALFA ROMEO',
  'ASTON MARTIN',
  'AUDI',
  'BENTLEY',
  'BMW',
  'BUGATTI',
  'BUICK',
  'CADILLAC',
  'CHEVROLET',
  'CHEVY',
  'CHRYSLER',
  'CITROEN',
  'DATSUN',
  'DODGE',
  'FERRARI',
  'FIAT',
  'FORD',
  'HONDA',
  'HYUNDAI',
  'JAGUAR',
  'JEEP',
  'KOENIGSEGG',
  'LAMBORGHINI',
  'LANCIA',
  'LAND ROVER',
  'LEXUS',
  'LOTUS',
  'MASERATI',
  'MAZDA',
  'MCLAREN',
  'MERCEDES',
  'MERCURY',
  'MINI',
  'MITSUBISHI',
  'NISSAN',
  'OPEL',
  'PAGANI',
  'PEUGEOT',
  'PLYMOUTH',
  'PONTIAC',
  'PORSCHE',
  'RENAULT',
  'ROLLS ROYCE',
  'SAAB',
  'SHELBY',
  'SKODA',
  'SUBARU',
  'SUZUKI',
  'TESLA',
  'TOYOTA',
  'TRIUMPH',
  'VOLKSWAGEN',
  'VOLVO',
  'VW',
];

const CAR_MODEL_WORDS = [
  'NSX',
  'SKYLINE',
  'GT-R',
  'GTR',
  'SUPRA',
  'CORVETTE',
  'CAMARO',
  'MUSTANG',
  'CHARGER',
  'CHALLENGER',
  'WRANGLER',
  'BRONCO',
  'CIVIC',
  'ACCORD',
  'MIATA',
  'RX-7',
  'RX7',
  'AE86',
  'SILVIA',
  'EVO',
  'WRX',
  'STI',
  'GTO',
  'F-150',
  'RAPTOR',
  'HILUX',
  'BEETLE',
  'DEFENDER',
  'DISCOVERY',
  'RANGE ROVER',
  'TWIN MILL',
  'DEORA',
  'BEACH BOMB',
  'BONE SHAKER',
  'ROADSTER',
  'COUPE',
  'PICKUP',
  'DRIFT',
  'TURBO',
];

const COLLECTION_KEYWORDS = [
  'COLLECTION',
  'COLLECTIONS',
  'COLEÇÃO',
  'COLEÇÃO',
  'SERIES',
  'SERIE',
  'SÉRIE',
  'SET',
  'WAVE',
  'ASSORTMENT',
  'THEME',
  'CAR CULTURE',
  'BOULEVARD',
  'FAST',
  'FURIOUS',
  'JAPAN HISTORICS',
  'MUSCLE MANIA',
  'NEON SPEED',
  'NIGHT BURNERZ',
  'TRUCKIN',
  'OFF ROAD',
  'OFF-ROAD',
  'STREET TUNERS',
  'JDM',
  'CLASSICS',
  'RETRO',
  'RACING',
  'RACE',
  'CITY',
  'WORKS',
  'STARS',
  'HEROES',
  'MARVEL',
  'DISNEY',
  'PIXAR',
  'MONSTER',
  'TRACK',
];

const NOISE_PATTERNS = [
  /^HOT\s*WHEELS?$/i,
  /^HOTWHEELS$/i,
  /\bMATTEL\b/i,
  /\bCOPYRIGHT\b/i,
  /\bALL\s+RIGHTS\s+RESERVED\b/i,
  /\bMADE\s+IN\b/i,
  /\bFABRIQU[ÉE]\s+EN\b/i,
  /\bFABRICADO\s+EM\b/i,
  /\b(?:CHINA|VIETNAM|MALAYSIA|THAILAND|INDONESIA|MEXICO|TAIWAN)\b/i,
  /\bAGE[S]?\b/i,
  /\bÂGE[S]?\b/i,
  /^\s*(?:NEW\s+)?FOR\s+(?:AGE[S]?\s+)?\d+/i,
  /^\s*\d+\s*(?:\+|ANS|ANOS|YEARS?)\s*$/i,
  /^\s*\d+\s*\+/,
  /\b(?:ASST|ASSORTMENT|SKU|UPC|ITEM|BATCH|CODE)\b/i,
  /\b(?:SCALE|ÉCHELLE|ESCALA)\b/i,
  /\b1\s*[:/]\s*(?:64|43|32|24|18|16|12|87)\b/,
  /https?:\/\/|www\.|\.com\b/i,
  /^[^A-Za-z]+$/,
  /^[A-Z]{1,2}\d{2,5}[A-Z]?$/i,
  /^\d{5,}$/,
  /^[A-Z0-9]{1,2}$/,
];

/** Short lines that only appear around packaging codes. */
const PACKAGING_WORDS = new Set([
  'NEW',
  'FOR',
  'AGE',
  'AGES',
  'ANS',
  'ANOS',
  'YEARS',
  'YEAR',
  'COLOR',
  'COLOUR',
  'SERIES',
  'COLLECTION',
  'COLEÇÃO',
  'SÉRIE',
  'SERIE',
  'SET',
  'WAVE',
  'ASST',
  'MATTEL',
  'CHINA',
  'VIETNAM',
  'MALAYSIA',
  'THAILAND',
  'INDONESIA',
  'MEXICO',
]);

/* -------------------------------------------------------------------------- */
/* Hot Wheels specific corrections and patterns                               */
/* -------------------------------------------------------------------------- */

const HW_COMMON_MISPELLINGS = {
  'ACURA NSK': 'ACURA NSX',
  'HONDA NSK': 'HONDA NSX',
  'NSK': 'NSX',
  'CORVETE': 'CORVETTE',
  'LAMBOURGHINI': 'LAMBORGHINI',
  'PORCHE': 'PORSCHE',
  'MITSUBISHI': 'MITSUBISHI',
  'CHEVY': 'CHEVROLET',
  'MERCEDES BENZ': 'MERCEDES',
  'LANDROVER': 'LAND ROVER',
  'ALFAROMEO': 'ALFA ROMEO',
  'ROLLSROYCE': 'ROLLS ROYCE',
};

const HW_COLLECTION_PATTERNS = [
  /HW\s+(?:THE\s+)?['']?(\d{2})S/i,
  /CAR\s+CULTURE/i,
  /BOULEVARD/i,
  /MUSCLE\s+MANIA/i,
  /NEON\s+SPEED/i,
  /NIGHT\s+BURNERZ/i,
  /JAPAN\s+HISTORICS/i,
  /STREET\s+TUNERS/i,
  /FAST\s+&\s+FURIOUS/i,
  /OFF\s*[-]*\s*ROAD/i,
];

const VALID_COLLECTION_TOTALS = [5, 10, 250];

/* -------------------------------------------------------------------------- */
/* Cache and optimization                                                     */
/* -------------------------------------------------------------------------- */

const ocrCache = new Map();
const MAX_CACHE_SIZE = 50;

/**
 * Cheap content hash used as the cache key. The first 1 000 characters of a
 * JPEG base64 are basically its header, so the payload length is mixed in to
 * keep two different photos from colliding on the same key.
 */
function hashImage(imageBase64) {
  const str = String(imageBase64 || '');
  const sample = str.slice(0, 1000);
  let hash = 0;
  for (let i = 0; i < sample.length; i += 1) {
    hash = ((hash << 5) - hash) + sample.charCodeAt(i);
    hash |= 0;
  }
  return `${(hash >>> 0).toString(36)}-${str.length}`;
}

function cacheGet(hash) {
  if (ocrCache.has(hash)) {
    const item = ocrCache.get(hash);
    if (Date.now() - item.timestamp < 3600000) { // 1 hour cache
      return item.data;
    }
    ocrCache.delete(hash);
  }
  return null;
}

function cacheSet(hash, data) {
  if (ocrCache.size >= MAX_CACHE_SIZE) {
    const firstKey = ocrCache.keys().next().value;
    ocrCache.delete(firstKey);
  }
  ocrCache.set(hash, { data, timestamp: Date.now() });
}

/* -------------------------------------------------------------------------- */
/* Worker lifecycle                                                           */
/* -------------------------------------------------------------------------- */

let workerPromise = null;
let workerInstance = null;
/** Context of the scan that is currently talking to the worker. */
let activeRun = null;

/**
 * Loads and caches one Tesseract worker. The language data is cached by
 * Tesseract.js in IndexedDB, so the second scan starts much faster.
 */
async function getWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const module = await import(TESSERACT_ESM_URL);
    const createWorker = module.createWorker || module.default?.createWorker;
    if (typeof createWorker !== 'function') {
      throw new Error('ocr-library-unavailable');
    }

    const worker = await createWorker('eng', 1, {
      workerPath: TESSERACT_WORKER_URL,
      corePath: TESSERACT_CORE_URL,
      langPath: TESSERACT_LANG_URL,
      logger: handleTesseractLog,
      errorHandler: (error) => {
        console.error('[OCR] Tesseract worker error:', error);
      },
    });

    workerInstance = worker;
    return worker;
  })();

  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    workerInstance = null;
    throw error;
  }
}

/** Frees the worker and all language data held in memory. */
export async function terminateOcr() {
  await terminateOcrWorker();
  activeRun = null;

  const worker = workerInstance;
  workerInstance = null;
  workerPromise = null;

  if (!worker) return;

  try {
    await worker.terminate();
  } catch (error) {
    console.warn('[OCR] Could not terminate the worker cleanly:', error);
  }
}

/**
 * Warms up the neural OCR worker without blocking the UI.
 * Safe to call repeatedly; the underlying preload is shared.
 */
export function preloadOcr(onProgress) {
  return preloadOcrModels(onProgress).catch((error) => {
    // A failed warm-up is harmless: the next scan retries and falls back.
    console.info('[OCR] Neural warm-up skipped:', error?.message || error);
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/* Progress context                                                           */
/* -------------------------------------------------------------------------- */

function createRun(options = {}) {
  return {
    worker: null,
    sink: typeof options.onProgress === 'function' ? options.onProgress : null,
    signal: options.signal || null,
    lastProgress: 0,
    stage: null,
    collected: [],
    raw: [],
  };
}

function setStage(run, stage) {
  run.stage = stage;
}

/**
 * Monotonic progress. The worker logger and the explicit stage boundaries used
 * to fight over the same value, so the bar went backwards on the first run.
 */
function emitProgress(run, stage, progress, detail = '') {
  const next = clamp(Number(progress) || 0, 0, 1);
  run.lastProgress = Math.max(run.lastProgress, next);
  if (typeof run.sink !== 'function') return;
  run.sink({ stage, progress: run.lastProgress, detail });
}

function handleTesseractLog(message = {}) {
  const run = activeRun;
  if (!run || !run.stage) return;

  const range = PHASE_RANGES[run.stage] || PHASE_RANGES.library;
  const local = clamp(Number(message.progress) || 0, 0, 1);
  const overall = range[0] + (range[1] - range[0]) * local;

  emitProgress(run, run.stage, overall, message.status || '');
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.message === 'ocr-aborted';
}

function assertNotAborted(run) {
  if (!run.signal?.aborted) return;
  const error = new Error('ocr-aborted');
  error.name = 'AbortError';
  throw error;
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Keeps the last few crops in memory for diagnosis (opt-in via localStorage). */
function rememberPass(entry) {
  if (typeof window === 'undefined') return;
  const bucket = window.__wheelsOcrDebug || (window.__wheelsOcrDebug = []);
  bucket.push({
    stage: entry.stage,
    region: entry.region,
    rotate: entry.rotate,
    ms: Math.round(entry.ms),
    text: String(entry.text || ''),
    canvas: entry.canvas,
    toPng: () => entry.canvas.toDataURL('image/png'),
  });
  while (bucket.length > 6) bucket.shift();
}

/* -------------------------------------------------------------------------- */
/* Main scanner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Queue of scans. A single worker means a single recognition at a time, and
 * serialising also keeps progress events from two cards from interleaving.
 */
let scanQueue = Promise.resolve();

/**
 * Scans a Hot Wheels blister card.
 *
 * The base64 payload is still the identity of the scan (cache key and the
 * fallback source), but callers that just cropped a photo should pass
 * `sourceImage` so recognition runs on the original pixels instead of the
 * 500 x 500 derivative that gets stored.
 *
 * @param {string} imageBase64 Base64 JPEG/PNG (with or without the data: prefix).
 * @param {{
 *   onProgress?: (event: { stage: string, progress: number, detail: string }) => void,
 *   sourceImage?: HTMLCanvasElement|HTMLImageElement|ImageBitmap,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ name: string, description: string, collectionName: string,
 *   collectionNumber: string, rawText: string, lines: Array<object> }>}
 */
export function scanHotWheelsCard(imageBase64, options = {}) {
  const job = scanQueue.then(() => runScan(imageBase64, options));
  scanQueue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

async function runScan(imageBase64, options) {
  const run = createRun(options);

  /*
   * 1. Source pixels. Prefer the in-memory crop with the original resolution;
   *    fall back to the stored base64 when editing an item without a new photo.
   */
  let source = normalizeSource(options.sourceImage);
  if (!source) {
    try {
      source = await loadImage(imageBase64);
    } catch (error) {
      throw new Error('ocr-image-decode', { cause: error });
    }
  }

  const cacheKey = `${hashImage(imageBase64)}:${options.sourceImage ? 'hi' : 'lo'}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    emitProgress(run, 'parsing', 1, 'from cache');
    return cached;
  }

  // Attempt primary neural OCR (PP-OCRv4 via ONNX Web in Dedicated Worker)
  if (typeof Worker !== 'undefined') {
    try {
      emitProgress(run, 'library', 0.1, 'loading neural OCR');
      const onnxResult = await runPpOcr(source, {
        signal: run.signal,
        onProgress: (p) => {
          emitProgress(run, p.stage || 'full', p.progress || 0.5, p.detail || '');
        },
      });

      if (onnxResult && onnxResult.lines && onnxResult.lines.length > 0) {
        emitProgress(run, 'parsing', 0.9, 'organising text');
        const sourceWidth = source.naturalWidth || source.width || 1;
        const sourceHeight = source.naturalHeight || source.height || 1;

        const lines = onnxResult.lines.map((l) => ({
          text: improveWordSpacing(l.text),
          source: 'onnx',
          confidence: Math.round((l.confidence || 0.8) * 100),
          relativeX: l.box ? l.box.x / sourceWidth : 0,
          relativeY: l.box ? l.box.y / sourceHeight : 0,
        }));

        const name = extractCarName(lines);
        const collectionName = extractCollectionName(lines, {
          exclude: name ? [name] : [],
        });
        const collectionNumber = extractCollectionNumber(lines);
        const description = buildDescription({ collectionName, collectionNumber });
        const rawText = lines.map((l) => l.text).join('\n');

        emitProgress(run, 'parsing', 1, 'done');

        const result = {
          name,
          description,
          collectionName,
          collectionNumber,
          rawText,
          lines,
          provider: onnxResult.provider || 'onnx',
        };

        cacheSet(cacheKey, result);
        return result;
      }
    } catch (onnxErr) {
      if (isAbortError(onnxErr)) throw onnxErr;
      console.warn('[OCR] Neural PP-OCRv4 fallback to Tesseract:', onnxErr);
    }
  }

  setStage(run, 'library');
  emitProgress(run, 'library', 0, 'loading tesseract');

  activeRun = run;

  try {
    try {
      run.worker = await getWorker();
    } catch (error) {
      throw new Error('ocr-unavailable', { cause: error });
    }

    emitProgress(run, 'preparing', PHASE_RANGES.preparing[1], 'image ready');
    setStage(run, 'analyzing');
    emitProgress(run, 'analyzing', PHASE_RANGES.analyzing[0], 'analysing layout');

    const sourceLongSide = Math.max(
      source.naturalWidth || source.width || 1,
      source.naturalHeight || source.height || 1,
    );

    const runPass = async ({
      stage,
      canvas,
      psm,
      origin,
      region,
      rotate = 0,
      whitelist = '',
    }) => {
      assertNotAborted(run);
      setStage(run, stage);

      const range = PHASE_RANGES[stage] || PHASE_RANGES.parsing;
      emitProgress(run, stage, range[0], 'recognising');

      const parameters = {
        tessedit_pageseg_mode: String(psm),
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      };
      if (whitelist) {
        parameters.tessedit_char_whitelist = whitelist;
      }

      const passStarted = now();

      try {
        await run.worker.setParameters(parameters);
        const result = await run.worker.recognize(
          canvas,
          {},
          { text: true, blocks: true },
        );
        const data = result?.data || {};
        const lines = collectLines(data, { source: origin, canvas, region, rotate });

        run.collected.push(...lines);
        if (data.text) run.raw.push(String(data.text));

        emitProgress(run, stage, range[1], 'done');

        if (isOcrDebugEnabled()) {
          rememberPass({
            stage,
            region,
            rotate,
            canvas,
            text: data.text,
            ms: now() - passStarted,
          });
        }

        return lines;
      } catch (error) {
        if (isAbortError(error)) throw error;
        /* One failed pass must not throw away what the others already found. */
        console.warn(`[OCR] pass "${stage}" failed:`, error);
        emitProgress(run, stage, range[1], 'failed');
        return [];
      } finally {
        if (whitelist) {
          try {
            await run.worker.setParameters({ tessedit_char_whitelist: '' });
          } catch {
            /* The next pass overwrites the parameter anyway. */
          }
        }
      }
    };

    /* 2. Full card: geometry, not accuracy. No upscale, no enhancement. */
    const fullCanvas = prepareRegion(source, FULL_REGION, {
      ...PREP.full,
      targetLongSide: Math.min(PREP.full.targetLongSide, sourceLongSide),
    });
    const fullLines = await runPass({
      stage: 'full',
      canvas: fullCanvas,
      psm: '11',
      origin: 'full',
      region: FULL_REGION,
    });

    const candidates = layoutCandidates(fullLines);

    assertNotAborted(run);

    /* 3. Model name: below the blister. Tight prior first, wide fallback after. */
    for (let index = 0; index < candidates.bottom.length; index += 1) {
      const region = candidates.bottom[index];
      await runPass({
        stage: 'bottom',
        canvas: prepareRegion(source, region, PREP.bottom),
        psm: index === 0 ? '7' : '6',
        origin: 'bottom',
        region,
      });
      if (hasStrongCarName(run.collected)) break;
    }

    /* 4. Collection strip: vertical, always rotated. */
    let collectionFound = false;
    for (const rotation of [90, 270]) {
      if (collectionFound) break;

      for (let index = 0; index < candidates.side.length; index += 1) {
        const region = candidates.side[index];
        await runPass({
          stage: 'side',
          canvas: prepareRegion(source, region, { ...PREP.side, rotate: rotation }),
          psm: index < 2 ? '7' : '11',
          origin: 'side',
          region,
          rotate: rotation,
        });

        if (hasCollectionName(run.collected)) {
          collectionFound = true;
          break;
        }
      }
    }

    /* 5. Collection number: only when the previous passes missed it. */
    if (!extractCollectionNumber(toLines(dedupeLines(run.collected)))) {
      for (const region of candidates.number) {
        await runPass({
          stage: 'numbers',
          canvas: prepareRegion(source, region, PREP.number),
          psm: '7',
          origin: 'number',
          region,
          whitelist: '0123456789/|:.-',
        });
        if (extractCollectionNumber(toLines(dedupeLines(run.collected)))) break;
      }
    }

    /* 6. Parse everything once, with the focused passes included. */
    setStage(run, 'parsing');
    emitProgress(run, 'parsing', PHASE_RANGES.parsing[0], 'parsing');

    const mergedLines = dedupeLines(run.collected);
    const name = extractCarName(mergedLines);
    const collectionName = extractCollectionName(mergedLines, {
      exclude: name ? [name] : [],
    });
    const collectionNumber = extractCollectionNumber(mergedLines);
    const description = buildDescription({ collectionName, collectionNumber });
    const rawText = dedupeRawText(run.raw);

    emitProgress(run, 'parsing', 1, 'done');

    const result = {
      name,
      description,
      collectionName,
      collectionNumber,
      rawText,
      lines: mergedLines.map((line) => ({
        text: line.text,
        source: line.source,
        confidence: line.confidence,
        relativeX: line.relativeX,
        relativeY: line.relativeY,
      })),
    };

    cacheSet(cacheKey, result);
    return result;
  } finally {
    if (activeRun === run) activeRun = null;
    run.worker = null;
  }
}

/** Accepts canvas, Image and ImageBitmap as long as it has a usable size. */
function normalizeSource(candidate) {
  if (!candidate) return null;
  const width = candidate.naturalWidth || candidate.width || 0;
  const height = candidate.naturalHeight || candidate.height || 0;
  return width > 0 && height > 0 ? candidate : null;
}

function hasStrongCarName(lines) {
  const { best } = rankCarNames(toLines(lines));
  return Boolean(best && best.score >= 4);
}

function hasCollectionName(lines) {
  const entries = toLines(lines);
  const carName = extractCarName(entries);
  return Boolean(
    extractCollectionName(entries, { exclude: carName ? [carName] : [] }),
  );
}

/* -------------------------------------------------------------------------- */
/* Text parsers (exported and easy to unit test)                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns the most likely model name.
 *
 * The scan is done from the bottom up because Hot Wheels model names are
 * normally printed below the plastic blister. Lines are scored so a brand or
 * model keyword wins over an isolated age range, a code or the collection
 * strip.
 *
 * @param {string|string[]|Array<object>} lines Raw OCR text or line objects.
 * @returns {string}
 */
export function extractCarName(lines) {
  const { best, fallback } = rankCarNames(toLines(lines));

  let result = '';
  if (best && best.score >= 4) {
    result = best.text;
  } else if (fallback) {
    result = fallback;
  }

  return applyHotWheelsCorrections(result);
}

/**
 * Scores every plausible line and returns the best candidate plus the first
 * fallback. Shared with the scanner, which uses the score to decide whether
 * the name is already strong enough to skip the remaining bottom passes.
 */
function rankCarNames(entries) {
  if (!entries.length) return { best: null, fallback: '' };

  const ordered = entries
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      const ay = a.line.relativeY;
      const by = b.line.relativeY;
      if (ay != null && by != null && Math.abs(ay - by) > 0.015) {
        return by - ay;
      }
      return b.index - a.index;
    });

  let best = null;
  let fallback = '';

  for (const { line } of ordered) {
    if (!isPlausibleCarName(line.text)) continue;

    const cleaned = cleanCarName(line.text);
    if (!cleaned) continue;

    const score = scoreCarName(cleaned, line);
    if (!fallback) fallback = cleaned;

    if (!best || score > best.score) {
      best = { text: cleaned, score };
    }
  }

  return { best, fallback };
}

/**
 * Builds the suggested description: collection name plus collection number.
 * The field remains fully editable in the UI.
 *
 * @param {string|string[]|Array<object>} lines
 * @returns {string}
 */
export function extractDescription(lines) {
  const entries = toLines(lines);
  const carName = extractCarName(entries);
  const collectionName = extractCollectionName(entries, {
    exclude: carName ? [carName] : [],
  });
  const collectionNumber = extractCollectionNumber(entries);

  return buildDescription({ collectionName, collectionNumber });
}

/**
 * Finds a collection number such as `2/10`, `125/250` or `2 OF 10`.
 * Prints like `1/64` (scale) and year ranges are explicitly rejected.
 *
 * @param {string|string[]|Array<object>} lines
 * @returns {string} The normalized number (for example `2/10`) or an empty string.
 */
export function extractCollectionNumber(lines) {
  const detail = findCollectionNumberDetail(toLines(lines));
  return detail ? detail.value : '';
}

/** Parses a plain OCR string with all three public extraction helpers. */
export function parseHotWheelsText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const name = extractCarName(lines);
  const collectionName = extractCollectionName(lines, {
    exclude: name ? [name] : [],
  });
  const collectionNumber = extractCollectionNumber(lines);

  return {
    name,
    description: buildDescription({ collectionName, collectionNumber }),
    collectionName,
    collectionNumber,
  };
}

/**
 * Finds the most likely thematic collection name. A candidate must contain a
 * collection signal (SERIES, CAR CULTURE, HW THE '90S, etc.) or come from the
 * rotated side strip. That keeps model names and packaging noise out.
 *
 * @param {string|string[]|Array<object>} lines
 * @param {{ exclude?: string[] }} [options]
 * @returns {string}
 */
export function extractCollectionName(lines, options = {}) {
  const entries = toLines(lines);
  if (!entries.length) return '';

  const excluded = new Set(
    (options.exclude || [])
      .map((value) => normalizeKey(value))
      .filter(Boolean),
  );

  const candidates = [];

  const addCandidate = (text, line, bonus = 0) => {
    const cleaned = cleanCollectionName(text);
    if (!cleaned) return;

    const key = normalizeKey(cleaned);
    if (!key || excluded.has(key)) return;
    if (!isPlausibleCollectionName(cleaned, line)) return;

    const score = scoreCollectionName(cleaned, line) + bonus;
    if (score <= 0) return;

    candidates.push({ text: cleaned, score });
  };

  for (const line of entries) {
    addCandidate(line.text, line);
  }

  /*
   * Vertical strips are sometimes returned as several short words. Try
   * merging small neighbouring fragments from every OCR pass.
   */
  const fragments = entries.filter(
    (line) =>
      line.text.length <= 16 &&
      /[A-Za-z]/.test(line.text) &&
      !isNoiseLine(line.text) &&
      !isLikelyCarName(line.text),
  );

  for (const source of ['side', 'bottom', 'full']) {
    const group = fragments.filter((line) => line.source === source);
    if (group.length < 2) continue;

    for (let start = 0; start < group.length; start += 1) {
      for (let size = 2; size <= Math.min(4, group.length - start); size += 1) {
        const slice = group.slice(start, start + size);
        const joined = slice.map((line) => line.text).join(' ');
        addCandidate(joined, slice[slice.length - 1], 1);

        if (source === 'side') {
          const reversed = [...slice].reverse().map((line) => line.text).join(' ');
          addCandidate(reversed, slice[0], 0.5);
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.text || '';
}

/* -------------------------------------------------------------------------- */
/* Parsing implementation                                                     */
/* -------------------------------------------------------------------------- */

function findCollectionNumberDetail(entries) {
  if (!entries.length) return null;

  /* "SCALE" is often printed on a different line than "1/64", so the test has
   * to look at the whole page, not only at the matching line. */
  const scaleOnPage = entries.some((line) => SCALE_WORDS.test(line.text));

  const patterns = [
    {
      regex:
        /\b(?:COL(?:LECTION)?|COLE[CÇ][AÃ]O|S[EÉ]RIES?|NO|NUM(?:BER)?|#)\s*[.:#-]?\s*(\d{1,3})\s*[\/\\|]\s*(\d{1,3})\b/giu,
      weight: 8,
    },
    {
      regex: /\b(\d{1,3})\s*(?:DE|OF|OUT\s+OF)\s*(\d{1,3})\b/giu,
      weight: 4,
    },
    {
      regex: /\b(\d{1,3})\s*[\/\\|]\s*(\d{1,3})\b/g,
      weight: 2,
    },
  ];

  let best = null;

  for (const line of entries) {
    const variants = [line.text, fixDigitLookalikes(line.text)];

    for (const variant of variants) {
      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;

        for (const match of variant.matchAll(pattern.regex)) {
          const current = Number(match[1]);
          const total = Number(match[2]);
          const value = `${current}/${total}`;

          if (!isValidCollectionPair(current, total, line.text, scaleOnPage)) continue;

          let score = pattern.weight;
          score += (line.confidence / 100) * 2;
          if (line.source === 'side' || line.source === 'number') score += 2;
          if (line.relativeY != null && line.relativeY < 0.35) score += 1.5;
          if (line.text.length <= 14) score += 1;
          if (line.text.includes(value)) score += 1;

          if (!best || score > best.score) {
            best = {
              value,
              current,
              total,
              line: line.text,
              confidence: line.confidence,
              score,
            };
          }
        }
      }
    }
  }

  return best;
}

function isValidCollectionPair(current, total, lineText, scaleOnPage = false) {
  if (!Number.isFinite(current) || !Number.isFinite(total)) return false;
  if (current < 1 || current > 500) return false;
  if (total < 2 || total > 500) return false;
  if (current > total) return false;

  const text = String(lineText || '').toUpperCase();
  const mentionsCollection = COLLECTION_WORDS.test(text);

  /* 1/64, 1/43, 1/24, 1/18... are scales, not collection numbers. The list is
   * the only way to tell 1/24 (scale) from 1/24 (first of 24 cars), so the
   * pairing is rejected unless the line explicitly talks about a collection. */
  if (current === 1 && SCALE_TOTALS.has(total) && !mentionsCollection) {
    return false;
  }

  if (SCALE_WORDS.test(text)) return false;

  /* Same rejection, now with page context. */
  if (scaleOnPage && !mentionsCollection) return false;

  /* Reject year ranges such as 2023/2024. */
  if (current >= 1900 && total >= 1900) return false;

  return true;
}

function buildDescription({ collectionName, collectionNumber }) {
  const name = String(collectionName || '').trim();
  const number = String(collectionNumber || '').trim();

  if (name && number) {
    if (name.includes(number)) return name;
    return `${name} · ${number}`;
  }

  if (name) return name;
  if (number) return number;
  return '';
}

function scoreCarName(text, line) {
  let score = 0;

  if (line.source === 'bottom') score += 8;
  if (line.source === 'full') score += 2;
  if (line.source === 'side') score -= 10;
  if (line.source === 'number') score -= 20;

  if (line.relativeY != null) {
    if (line.relativeY >= 0.55) score += 6;
    else if (line.relativeY >= 0.35) score += 2;
    else score -= 3;
  }

  if (containsCarBrand(text)) score += 10;
  if (containsModelWord(text)) score += 4;
  if (/^['']?(?:19|20)?\d{2}\b/.test(text)) score += 4;
  if (/\b(?:19|20)\d{2}\b/.test(text)) score += 1;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 6) score += 3;
  if (text.length >= 5 && text.length <= 42) score += 1;
  if (line.confidence >= 75) score += 1;

  if (containsCollectionSignal(text)) score -= 14;
  if (isNoiseLine(text)) score -= 30;
  if (findCollectionNumberDetail([line])) score -= 20;
  if (/^HW\b/i.test(text) || /^HOT\s*WHEELS\b/i.test(text)) score -= 12;
  if (line.source === 'side' && !containsCarBrand(text)) score -= 4;

  return score;
}

function scoreCollectionName(text, line) {
  let score = 0;

  if (containsCollectionSignal(text)) score += 7;
  if (/\bHW\b/i.test(text)) score += 5;
  if (/\bTHE\b/i.test(text)) score += 1;
  if (/\b(?:'|')?\d{2}S\b/i.test(text)) score += 5;
  if (
    /\b(?:COLLECTION|COLE[CÇ][AÃ]O|S[EÉ]RIES?|SET|WAVE|ASSORTMENT|THEME)\b/i.test(
      text,
    )
  ) {
    score += 3;
  }
  if (line.source === 'side') score += 3;
  if (line.relativeX != null && line.relativeX >= 0.6) score += 1;
  if (line.relativeY != null && line.relativeY >= 0.35) score += 1;
  if (line.confidence >= 70) score += 1;

  if (isLikelyCarName(text)) score -= 14;
  if (containsCarBrand(text)) score -= 12;
  if (isNoiseLine(text)) score -= 20;
  if (/\d{1,3}\s*[\/\\|]\s*\d{1,3}/.test(text)) score -= 15;
  if (text.length > 42) score -= 4;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 1) score -= 2;
  if (words.length > 6) score -= 5;

  return score;
}

function isPlausibleCarName(text) {
  const value = normalizeLine(text);
  if (!value || value.length < 3 || value.length > 48) return false;
  if (!/[A-Za-z]{2}/.test(value)) return false;
  if (isNoiseLine(value)) return false;
  if (containsCollectionSignal(value) && !containsCarBrand(value)) return false;
  if (/^HW\b/i.test(value) || /^HOT\s*WHEELS\b/i.test(value)) return false;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;
  if (words.length === 1 && value.length < 4) return false;

  const letters = (value.match(/[A-Za-z]/g) || []).length;
  const digits = (value.match(/\d/g) || []).length;
  if (letters < 2 || digits > letters + 4) return false;

  return true;
}

function isPlausibleCollectionName(text, line) {
  const value = normalizeLine(text);
  if (!value || value.length < 3 || value.length > 48) return false;
  if (!/[A-Za-z]{2}/.test(value)) return false;
  if (isNoiseLine(value)) return false;
  if (findCollectionNumberDetail([line])) return false;
  if (isLikelyCarName(value) && !containsCollectionSignal(value)) return false;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 7) return false;

  return true;
}

function isNoiseLine(text) {
  const value = normalizeLine(text);
  if (!value) return true;
  if (value.length > 90) return true;

  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(value)) return true;
  }

  const upper = value.toUpperCase();
  if (upper.includes('©') || upper.includes('®') || upper.includes('™')) {
    return true;
  }

  const words = upper.split(/\s+/).filter(Boolean);
  if (words.length === 1 && PACKAGING_WORDS.has(words[0])) return true;
  if (words.every((word) => PACKAGING_WORDS.has(word))) return true;

  return false;
}

function isLikelyCarName(text) {
  const value = normalizeLine(text);
  if (!value) return false;
  if (containsCarBrand(value)) return true;
  if (containsModelWord(value)) return true;

  const words = value.split(/\s+/).filter(Boolean);
  return (
    words.length >= 2 &&
    words.length <= 6 &&
    /^['']?(?:19|20)?\d{2}\b/.test(value) &&
    /[A-Za-z]{3}/.test(value)
  );
}

function containsCarBrand(text) {
  const value = ` ${normalizeLine(text).toUpperCase()} `;
  return CAR_BRANDS.some((brand) => value.includes(` ${brand} `));
}

function containsModelWord(text) {
  const value = ` ${normalizeLine(text).toUpperCase()} `;
  return CAR_MODEL_WORDS.some((word) => value.includes(` ${word} `));
}

/** Words that may legitimately end in a single-letter suffix ("Model S"). */
const SINGLE_LETTER_SUFFIX_GUARD = new Set([
  'MODEL', 'CLASS', 'SERIES', 'TYPE', 'EDITION', 'TRIM',
]);

/**
 * Removes single glyphs that the detection boxes pick up at the edges of the
 * name, e.g. "T 90 ACURA NSX T" or "I90 ACURA NSX". Only applied when the line
 * actually names a known brand, and never when the letter follows a word such
 * as "Model" (Tesla Model S).
 */
function stripEdgeGlyphs(value) {
  if (!containsCarBrand(value) && !containsModelWord(value)) return value;

  let text = value
    // Glued lookalike before the leading number: "I90 ACURA NSX".
    .replace(/^[Il](?=\d{2})/, '')
    // Isolated glyph before the leading number: "T 90 ACURA NSX".
    .replace(/^(?:[A-Za-z]\s+)+(?=\d{2})/, '');

  // Isolated glyph after a number, brand or model word: "90 ACURA NSX T".
  const trailing = text.match(/^(.*?)(?:\s+([A-Za-z]))$/);
  if (trailing) {
    const anchor = trailing[1].split(/\s+/).pop() || '';
    const guarded = SINGLE_LETTER_SUFFIX_GUARD.has(anchor.toUpperCase());
    if (
      !guarded &&
      (/\d/.test(anchor) || containsCarBrand(anchor) || containsModelWord(anchor))
    ) {
      text = trailing[1];
    }
  }

  return text;
}

function containsCollectionSignal(text) {
  const value = normalizeLine(text).toUpperCase();
  if (!value) return false;

  if (/\bHW\b/.test(value)) return true;
  if (/\bTHE\b/.test(value) && /\b(?:'|')?\d{2}S\b/.test(value)) return true;
  if (/\b(?:'|')?\d{2}S\b/.test(value)) return true;

  return COLLECTION_KEYWORDS.some((keyword) => value.includes(keyword));
}

function cleanCarName(text) {
  let value = normalizeLine(text)
    .replace(/^[\s\-–—:;,.•*#]+/, '')
    .replace(/[\s\-–—:;,.•*#]+$/, '')
    .replace(/\s*(?:\bAGE[S]?\b[\s:]*)?\d+\s*\+.*$/i, '')
    .replace(/\s+\b(?:NEW\s+FOR|MADE\s+IN|MATTEL|HOT\s+WHEELS)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Strip stray box-edge glyphs before repairing digit lookalikes: otherwise
  // "I90 ACURA NSX" is turned into "190 ACURA NSX" before the noise is gone.
  value = stripEdgeGlyphs(value);

  value = value
    .replace(/^([0-9]{1,2})[OQ]\b/, (_, digits) => `${digits}0`)
    .replace(/^([0-9]{2})[Il]\b/, (_, digits) => `${digits}1`)
    .replace(/^[OQ]([0-9]{1,3})\b/, (_, digits) => `0${digits}`)
    .replace(/^[Il]([0-9]{1,3})\b/, (_, digits) => `1${digits}`)
    .replace(/[''']/g, "'");

  return value.slice(0, 48);
}

function cleanCollectionName(text) {
  const value = normalizeLine(text)
    .replace(/^[\s\-–—:;,.•*#]+/, '')
    .replace(/[\s\-–—:;,.•*#]+$/, '')
    .replace(/^\s*HOT\s*WHEELS?\s*/i, '')
    .replace(/[''']/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!value || value.length < 3) return '';
  if (isNoiseLine(value)) return '';

  return value.slice(0, 80);
}

/* -------------------------------------------------------------------------- */
/* Hot Wheels specific corrections                                            */
/* -------------------------------------------------------------------------- */

function applyHotWheelsCorrections(text) {
  if (!text) return text;

  const upper = text.toUpperCase();
  
  // Apply common misspelling corrections
  for (const [wrong, correct] of Object.entries(HW_COMMON_MISPELLINGS)) {
    if (upper.includes(wrong)) {
      // Case-insensitive replacement preserving original case pattern
      const regex = new RegExp(wrong, 'gi');
      return text.replace(regex, correct);
    }
  }

  // If text contains NSX but no brand, try to add it
  if (/\bNSX\b/i.test(upper) && !containsCarBrand(upper)) {
    if (!/\b(?:ACURA|HONDA)\b/i.test(upper)) {
      return 'ACURA ' + text;
    }
  }

  return text;
}

/* -------------------------------------------------------------------------- */
/* Text normalization helpers                                                 */
/* -------------------------------------------------------------------------- */

function toLines(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input ?? '').split(/\r?\n/);

  const result = [];

  raw.forEach((entry, index) => {
    const isObject = entry && typeof entry === 'object';
    const text = improveWordSpacing(
      normalizeLine(isObject ? entry.text ?? entry.raw ?? '' : entry),
    );

    if (!text) return;

    result.push({
      text,
      confidence: clamp(Number(isObject ? entry.confidence : 0) || 0, 0, 100),
      source: isObject ? entry.source || 'text' : 'text',
      bbox: isObject ? entry.bbox || null : null,
      relativeX: isObject && Number.isFinite(entry.relativeX)
        ? entry.relativeX
        : null,
      relativeY: isObject && Number.isFinite(entry.relativeY)
        ? entry.relativeY
        : null,
      relativeWidth: isObject && Number.isFinite(entry.relativeWidth)
        ? entry.relativeWidth
        : null,
      relativeHeight: isObject && Number.isFinite(entry.relativeHeight)
        ? entry.relativeHeight
        : null,
      vertical: Boolean(isObject && entry.vertical),
      order: index,
    });
  });

  return result;
}

function normalizeLine(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[""""«»]/g, '"')
    .replace(/[''`´]/g, "'")
    .replace(/[•●▪■◆★☆]/g, ' ')
    .replace(/[_~^]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,.•*]+/, '')
    .replace(/[\s\-–—:;,.•*]+$/, '')
    .trim()
    .slice(0, 180);
}

function normalizeKey(value) {
  return normalizeLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Re-inserts spaces the CTC head sometimes omits between words.
 *
 * PP-OCRv4 is trained with a space class, but on short packaging fonts the
 * blank frames between words are often too short for greedy decoding. These
 * two deterministic passes recover the common cases without touching the
 * original characters:
 *
 *   90ACURA       -> 90 ACURA
 *   HOTWHEELS2024 -> HOT WHEELS 2024
 *   ACURANSX      -> ACURA NSX
 *   ALFAROMEO     -> ALFA ROMEO
 *   HWTHE 90S     -> HW THE 90S
 */
const BRAND_SPACING = CAR_BRANDS
  .map((brand) => ({ brand, compact: brand.replace(/\s+/g, '') }))
  .sort((a, b) => b.compact.length - a.compact.length);

const COMPOUND_SPACING = [['HOTWHEELS', 'HOT WHEELS']];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function improveWordSpacing(value) {
  let text = String(value ?? '');
  if (!text) return text;

  // Separate letter and digit runs without splitting short tokens such as V8.
  text = text
    .replace(/([A-Za-z]{2,})(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z]{2,})/g, '$1 $2');

  // Expand glued multi-word brands: ALFAROMEO -> ALFA ROMEO.
  for (const { brand, compact } of BRAND_SPACING) {
    if (compact === brand) continue;
    // No trailing \b: the brand may be glued to the model (ALFAROMEOGIULIA).
    text = text.replace(new RegExp(`\\b${escapeRegExp(compact)}`, 'g'), brand);
  }

  // Split a brand glued to the model name: ACURANSX -> ACURA NSX.
  for (const { brand } of BRAND_SPACING) {
    text = text.replace(
      new RegExp(`\\b${escapeRegExp(brand)}(?=[A-Za-z])`, 'g'),
      `${brand} `,
    );
  }

  for (const [glued, spaced] of COMPOUND_SPACING) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(glued)}\\b`, 'gi'), spaced);
  }

  // "HW" is a two-letter prefix the packaging glues to the next word
  // (HWTHE 90S, HWCITY). Only split when at least two letters follow, so
  // tokens such as "HWT" or "HWY" stay untouched.
  text = text.replace(/\bHW(?=[A-Z]{2})/g, 'HW ');

  return text.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Fixes digit-like letters inside numeric tokens (`2/1O` -> `2/10`) without
 * destroying words such as `OF` or `THE`.
 */
function fixDigitLookalikes(text) {
  return normalizeLine(text).replace(/[0-9OQIlSsBbZzGg/|:.-]+/g, (token) => {
    if (!/\d/.test(token)) return token;

    return token
      .replace(/[OQ]/g, '0')
      .replace(/[Il!]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/[Zz]/g, '2')
      .replace(/[Gg]/g, '6');
  });
}

/* -------------------------------------------------------------------------- */
/* OCR result helpers                                                         */
/* -------------------------------------------------------------------------- */

function collectLines(data, { source, canvas, region, rotate = 0 }) {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const rotation = normalizeDegrees(rotate);
  const lines = [];

  /*
   * Maps a point of the canvas that went to Tesseract back to normalised card
   * coordinates. Turning the canvas clockwise by 90 degrees maps (u, v) to
   * (1 - v, u), so the inverse is u = y/H' and v = 1 - x/W'. The previous
   * version used x for both axes and dropped the sign, which put the strip
   * boxes on the wrong side of the card.
   */
  const mapPoint = (x, y) => {
    const nx = clamp(x / width, 0, 1);
    const ny = clamp(y / height, 0, 1);

    let ax = nx;
    let ay = ny;

    if (rotation === 90) {
      ax = ny;
      ay = 1 - nx;
    } else if (rotation === 180) {
      ax = 1 - nx;
      ay = 1 - ny;
    } else if (rotation === 270) {
      ax = 1 - ny;
      ay = nx;
    }

    return { x: region.x + ax * region.w, y: region.y + ay * region.h };
  };

  const pushLine = (rawText, confidence, bbox) => {
    const text = improveWordSpacing(normalizeLine(rawText));
    if (!text || text.length < 2) return;

    const x0 = Number(bbox?.x0) || 0;
    const y0 = Number(bbox?.y0) || 0;
    const x1 = Number(bbox?.x1) || width;
    const y1 = Number(bbox?.y1) || height;

    const start = mapPoint(x0, y0);
    const end = mapPoint(x1, y1);

    lines.push({
      text,
      confidence: clamp(Number(confidence) || 0, 0, 100),
      source,
      vertical: Boolean(rotate) || source === 'side',
      bbox: {
        x0: Math.min(start.x, end.x),
        y0: Math.min(start.y, end.y),
        x1: Math.max(start.x, end.x),
        y1: Math.max(start.y, end.y),
      },
      relativeX: Math.min(start.x, end.x),
      relativeY: Math.min(start.y, end.y),
      relativeWidth: Math.abs(end.x - start.x),
      relativeHeight: Math.abs(end.y - start.y),
    });
  };

  const blocks = Array.isArray(data?.blocks) ? data.blocks : [];

  for (const block of blocks) {
    const paragraphs = Array.isArray(block?.paragraphs) ? block.paragraphs : [];
    for (const paragraph of paragraphs) {
      const paragraphLines = Array.isArray(paragraph?.lines)
        ? paragraph.lines
        : [];
      for (const line of paragraphLines) {
        pushLine(line?.text, line?.confidence, line?.bbox);
      }
    }
  }

  /*
   * No blocks: keep the text but drop the geometry. Inventing evenly spaced
   * boxes poisoned the layout — a fake box in the middle of the card became a
   * "detected" band, and the focused pass then read plastic instead of text.
   */
  if (!lines.length && data?.text) {
    const textLines = String(data.text)
      .split(/\r?\n/)
      .map((text) => normalizeLine(text))
      .filter(Boolean);

    for (const text of textLines) {
      lines.push({
        text,
        confidence: clamp(Number(data.confidence) || 0, 0, 100),
        source,
        vertical: Boolean(rotation) || source === 'side',
        bbox: null,
        relativeX: null,
        relativeY: null,
        relativeWidth: null,
        relativeHeight: null,
      });
    }
  }

  return lines;
}

function dedupeLines(lines) {
  const best = new Map();

  for (const line of lines) {
    const normalized = normalizeKey(line.text);
    if (!normalized) continue;

    /*
     * Key by (source, text) instead of text alone. The same collection strip
     * can be read by the wide pass and by the focused pass, and keeping a
     * single copy used to decide the winner with a fixed source bonus before
     * any scoring. Now both survive and the parsers choose.
     */
    const key = `${line.source}|${normalized}`;
    const score = line.confidence + Math.min(8, line.text.length / 5);

    const existing = best.get(key);
    if (!existing || score > existing.score) {
      best.set(key, { line, score });
    }
  }

  return [...best.values()].map((entry) => entry.line);
}

function dedupeRawText(parts) {
  const seen = new Set();
  const result = [];

  for (const part of parts) {
    for (const rawLine of String(part || '').split(/\r?\n/)) {
      const line = normalizeLine(rawLine);
      if (!line) continue;

      const key = normalizeKey(line);
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Turns the boxes found by the full pass into candidate regions, always
 * followed by the layout priors. The detected box is a hint, never a
 * requirement: Tesseract with `eng` and PSM 11 usually does not return rotated
 * text, and a missing box used to mean "read the wrong band".
 */
function layoutCandidates(fullLines) {
  const detectedBottom = deriveRegion(
    fullLines.filter(
      (line) =>
        line.relativeY != null &&
        line.relativeY >= 0.42 &&
        (line.relativeX == null || line.relativeX < 0.74) &&
        isRegionText(line.text),
    ),
    { minWidth: 0.5, minHeight: 0.08, margin: 0.04 },
  );

  const detectedSide = deriveRegion(
    fullLines.filter(
      (line) =>
        line.relativeX != null &&
        line.relativeX >= 0.58 &&
        isRegionText(line.text),
    ),
    { minWidth: 0.16, minHeight: 0.25, margin: 0.03 },
  );

  return {
    bottom: uniqueRegions([detectedBottom, ...PRIORS.bottom]),
    side: uniqueRegions([detectedSide, ...PRIORS.side]),
    number: [...PRIORS.number],
  };
}

/** Union of the given lines as a normalised region, or null when empty. */
function deriveRegion(lines, { minWidth, minHeight, margin }) {
  if (!lines.length) return null;

  let x0 = Math.min(...lines.map((line) => line.relativeX));
  let y0 = Math.min(...lines.map((line) => line.relativeY));
  let x1 = Math.max(
    ...lines.map((line) => {
      const width =
        line.relativeWidth > 0.001
          ? line.relativeWidth
          : Math.max(0.05, line.text.length / 80);
      return line.relativeX + width;
    }),
  );
  let y1 = Math.max(
    ...lines.map((line) => {
      const height =
        line.relativeHeight > 0.001
          ? line.relativeHeight
          : Math.max(0.015, 18 / 500);
      return line.relativeY + height;
    }),
  );

  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;

  if (x1 - x0 < minWidth) {
    x0 = centerX - minWidth / 2;
    x1 = centerX + minWidth / 2;
  }
  if (y1 - y0 < minHeight) {
    y0 = centerY - minHeight / 2;
    y1 = centerY + minHeight / 2;
  }

  x0 -= margin;
  y0 -= margin;
  x1 += margin;
  y1 += margin;

  x0 = clamp(x0, 0, 0.98);
  y0 = clamp(y0, 0, 0.98);
  x1 = clamp(x1, 0.02, 1);
  y1 = clamp(y1, 0.02, 1);

  if (x1 - x0 < 0.08 || y1 - y0 < 0.04) return null;

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Drops nulls and regions that repeat a previous one (1 % tolerance). */
function uniqueRegions(regions) {
  const seen = new Set();
  const result = [];

  for (const region of regions) {
    if (!region) continue;

    const key = [region.x, region.y, region.w, region.h]
      .map((value) => Math.round(value * 100))
      .join(':');

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(region);
  }

  return result;
}

function isRegionText(text) {
  const value = normalizeLine(text);
  if (!value || value.length < 3) return false;
  if (isNoiseLine(value)) return false;
  return /[A-Za-z0-9]/.test(value);
}

/* -------------------------------------------------------------------------- */
/* Image preparation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Decodes a base64 payload into an image. The stored documents are always
 * JPEG, but the MIME label is sniffed from the payload header so a PNG or
 * WebP coming from another writer is not mislabelled as `image/jpeg`.
 */
function loadImage(imageBase64) {
  return new Promise((resolve, reject) => {
    const source = String(imageBase64 || '').trim();
    if (!source) {
      reject(new Error('ocr-image-required'));
      return;
    }

    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('ocr-image-decode'));
    image.src = /^data:image\//i.test(source)
      ? source
      : `data:${sniffMime(source)};base64,${source}`;
  });
}

/** Reads the magic prefix of a base64 payload. Falls back to JPEG. */
function sniffMime(base64) {
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

/** Unsharp mask is gone: `prepareRegion` owns the whole pixel pipeline. */

/** 0, 90, 180 or 270 — negatives and out-of-range values are normalised. */
function normalizeDegrees(value) {
  const degrees = Math.round((Number(value) || 0) / 90) * 90;
  return ((degrees % 360) + 360) % 360;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/* -------------------------------------------------------------------------- */
/* Automatic scan session (framework agnostic)                                */
/* -------------------------------------------------------------------------- */

const DEFAULT_TIMERS = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (id) => clearTimeout(id),
};

/**
 * True on metered or very slow connections. The first automatic scan downloads
 * a few megabytes, so on those connections the button stays the trigger.
 */
export function isMeteredConnection() {
  if (typeof navigator === 'undefined') return false;

  const connection =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};

  if (connection.saveData) return true;
  return /(^|-)2g$/.test(String(connection.effectiveType || ''));
}

/**
 * Merges a scan result into the current form values.
 *
 * Automatic scans never overwrite what the user already typed; the explicit
 * button does. The returned flags let the caller pick the right message.
 *
 * @param {{ name?: string, description?: string }} current
 * @param {{ name?: string, description?: string }} result
 * @param {{ overwrite?: boolean }} [options]
 * @returns {{ name: string, description: string, filledName: boolean,
 *   filledDescription: boolean, filled: boolean, complete: boolean }}
 */
export function mergeScanResult(current, result, { overwrite = false } = {}) {
  const name = String(result?.name || '').trim();
  const description = String(result?.description || '').trim();
  const currentName = String(current?.name || '');
  const currentDescription = String(current?.description || '');

  const fillName = Boolean(name) && (overwrite || !currentName.trim());
  const fillDescription =
    Boolean(description) && (overwrite || !currentDescription.trim());

  return {
    name: fillName ? name : currentName,
    description: fillDescription ? description : currentDescription,
    filledName: fillName,
    filledDescription: fillDescription,
    filled: fillName || fillDescription,
    complete: fillName && fillDescription,
  };
}

/**
 * Orchestrates the scans of one form: scheduling after the crop, cancellation
 * and the "one scan at a time" rule. It is deliberately framework agnostic so
 * it can be unit tested without Alpine or a DOM.
 *
 * @param {{
 *   scan?: Function,
 *   getImage?: () => string,
 *   getSource?: () => any,
 *   delay?: number,
 *   timers?: { set: Function, clear: Function },
 *   readAuto?: () => boolean,
 *   writeAuto?: (enabled: boolean) => void,
 *   isMetered?: () => boolean,
 *   onChange?: (state: object) => void,
 *   onProgress?: (event: object) => void,
 *   onResult?: (result: object, options: { overwrite: boolean }) => void,
 *   onError?: (error: Error) => void,
 * }} [options]
 */
export function createScanSession(options = {}) {
  const {
    scan = (image, scanOptions) => scanHotWheelsCard(image, scanOptions),
    getImage = () => '',
    getSource = () => null,
    delay = AUTO_SCAN_DELAY,
    timers = DEFAULT_TIMERS,
    readAuto = loadOcrAuto,
    writeAuto = saveOcrAuto,
    isMetered = isMeteredConnection,
    onChange = () => {},
    onProgress = () => {},
    onResult = () => {},
    onError = () => {},
  } = options;

  let token = 0;
  let timer = 0;
  let controller = null;
  let current = null;
  let state = {
    scanning: false,
    auto: false,
    progress: 0,
    stage: 'library',
    enabled: readAuto(),
  };

  const publish = (patch = {}) => {
    state = { ...state, ...patch };
    onChange({ ...state });
  };

  const canAutoScan = () =>
    state.enabled && Boolean(getImage()) && !isMetered();

  const cancel = () => {
    token += 1;
    timers.clear(timer);
    timer = 0;
    if (controller) {
      controller.abort();
      controller = null;
    }
    current = null;
    if (state.scanning) publish({ scanning: false, auto: false, progress: 0 });
  };

  const run = (auto) => {
    const image = getImage();
    if (!image) return Promise.resolve(null);

    const runToken = ++token;
    const abortController = new AbortController();
    controller = abortController;

    publish({ scanning: true, auto, progress: 0, stage: 'library' });

    const job = (async () => {
      try {
        const result = await scan(image, {
          sourceImage: getSource(),
          signal: abortController.signal,
          onProgress: (event) => {
            if (runToken !== token) return;
            publish({
              stage: event.stage,
              progress: Math.round(
                clamp(Number(event.progress) || 0, 0, 1) * 100,
              ),
            });
            onProgress(event);
          },
        });

        if (runToken !== token) return null;

        /* A stale result (route changed, field edited, item saved) is dropped
         * by the token check above; the caller only gets a live one. */
        onResult(result, { overwrite: !auto });
        return result;
      } catch (error) {
        if (runToken !== token || isAbortError(error)) return null;
        onError(error);
        return null;
      } finally {
        if (runToken === token) {
          controller = null;
          publish({ scanning: false, auto: false, progress: 0 });
        }
        if (current === job) current = null;
      }
    })();

    current = job;
    return job;
  };

  return {
    /** Schedules the automatic scan that follows "apply crop". */
    auto() {
      if (!canAutoScan()) return;

      timers.clear(timer);
      timer = timers.set(() => {
        timer = 0;
        if (!canAutoScan()) return;
        cancel();
        void run(true);
      }, delay);
    },

    /** Explicit "scan again": cancels whatever is pending and overwrites. */
    manual() {
      cancel();
      return run(false);
    },

    cancel,

    setEnabled(value) {
      const enabled = Boolean(value);
      writeAuto(enabled);
      publish({ enabled });
      if (!enabled) cancel();
    },

    isEnabled: () => state.enabled,
    canAutoScan,
    getState: () => ({ ...state }),
    whenIdle: () => current || Promise.resolve(null),
  };
}

/* -------------------------------------------------------------------------- */
/* Alpine adapter                                                             */
/* -------------------------------------------------------------------------- */

/** Per-component scratch space kept out of Alpine's reactive proxy. */
const OCR_PANELS = new WeakMap();

function translate(component, key) {
  return typeof component?.t === 'function' ? component.t(key) : key;
}

function applyScanResultToComponent(component, result, { overwrite = false } = {}) {
  const state = component.ocr || {};
  const form = component.form || {};
  const errors = component.formErrors || {};

  const merged = mergeScanResult(form, result, { overwrite });

  if (merged.filledName) {
    form.name = merged.name;
    delete errors.name;
  }

  if (merged.filledDescription) {
    form.description = merged.description;
    delete errors.description;
  }

  state.result = result;

  if (merged.filled) {
    const message = translate(component, merged.complete ? 'ocrSuccess' : 'ocrPartial');
    if (typeof component.showToast === 'function') component.showToast(message);
    return merged;
  }

  state.error = translate(component, 'ocrEmpty');
  return merged;
}

/**
 * Wires the OCR panel into an Alpine component with a single call.
 *
 * It expects the component to expose `form` (with `name`, `description` and
 * `imageBase64`), `ocr` (the panel state), `formErrors`, `t()` and, ideally,
 * `showToast()`. Everything else is internal:
 *
 * ```js
 * import { attachOcrPanel } from './app.js';
 *
 * init() {
 *   attachOcrPanel(this);          // cria a sessão e os métodos do painel
 * },
 * // ao aplicar o recorte (antes de dispose()):
 * this.ocrOnCropApplied(this.cropper.session.toOcrCanvas()),
 * // na saída do formulário:
 * this.ocrCleanup(),
 * ```
 *
 * Added methods: `scanPackaging()`, `cancelOcrScan()`, `setOcrAuto(value)`,
 * `ocrOnCropApplied(canvas)` and `ocrCleanup()`.
 *
 * @param {object} component Alpine component instance (`this`).
 * @param {{ scan?: Function, isMetered?: () => boolean, readAuto?: () => boolean,
 *   writeAuto?: (enabled: boolean) => void, delay?: number,
 *   timers?: { set: (callback: Function, ms: number) => any, clear: (id: any) => void }
 * }} [options]
 * @returns {object|null} The scan session, or null when already attached.
 */
export function attachOcrPanel(component, options = {}) {
  if (!component || typeof component !== 'object') return null;
  if (OCR_PANELS.has(component)) return OCR_PANELS.get(component).session;

  if (!component.ocr) {
    component.ocr = {
      open: false,
      scanning: false,
      auto: false,
      progress: 0,
      stage: 'library',
      result: null,
      error: '',
      autoEnabled: true,
    };
  } else if (component.ocr.open === undefined) {
    component.ocr.open = false;
  }

  const sources = { current: null };

  const session = createScanSession({
    scan: options.scan,
    isMetered: options.isMetered,
    readAuto: options.readAuto,
    writeAuto: options.writeAuto,
    delay: options.delay,
    timers: options.timers,
    getImage: () => component.form?.imageBase64 || '',
    getSource: () => sources.current,
    onChange: (state) => {
      const panel = component.ocr;
      panel.scanning = state.scanning;
      panel.auto = state.auto;
      panel.progress = state.progress;
      panel.stage = state.stage;
      panel.autoEnabled = state.enabled;
    },
    onResult: (result, meta) => applyScanResultToComponent(component, result, meta),
    onError: () => {
      component.ocr.scanning = false;
      component.ocr.error = translate(component, 'ocrFailed');
    },
  });

  component.scanPackaging = () => {
    component.ocr.error = '';
    component.ocr.result = null;
    void session.manual();
  };

  component.cancelOcrScan = () => session.cancel();

  component.setOcrAuto = (value) => session.setEnabled(value);

  /** Call right after "apply crop", with the `toOcrCanvas()` result. */
  component.ocrOnCropApplied = (canvas) => {
    sources.current = canvas || null;
    session.auto();
  };

  /** Call when leaving the form, saving, cancelling or removing the image. */
  component.ocrCleanup = () => {
    session.cancel();
    sources.current = null;
  };

  OCR_PANELS.set(component, { session, sources });
  return session;
}

/** Test/diagnostic hook: exposes the live session of an attached component. */
export function getOcrPanelSession(component) {
  return OCR_PANELS.get(component)?.session || null;
}