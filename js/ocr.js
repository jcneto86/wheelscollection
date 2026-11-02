/**
 * Local OCR for Hot Wheels blister cards.
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
 */

/* -------------------------------------------------------------------------- */
/* Tesseract.js configuration                                                 */
/* -------------------------------------------------------------------------- */

const TESSERACT_VERSION = '7.0.0';
const TESSERACT_ESM_URL =
  `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;
const TESSERACT_WORKER_URL =
  `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`;
const TESSERACT_CORE_URL =
  `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`;
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

/** Fallback bands used only when the full pass does not reveal a region. */
const FALLBACK_REGIONS = Object.freeze({
  bottom: { x: 0.02, y: 0.58, w: 0.86, h: 0.4 },
  side: { x: 0.7, y: 0.28, w: 0.29, h: 0.7 },
  number: { x: 0.58, y: 0, w: 0.4, h: 0.45 },
});

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
/* Worker lifecycle                                                           */
/* -------------------------------------------------------------------------- */

let workerPromise = null;
let workerInstance = null;
let progressSink = null;
let activePhase = null;

/**
 * Loads and caches one Tesseract worker. The language data is cached by
 * Tesseract.js in IndexedDB, so the second scan starts much faster.
 */
async function getWorker() {
  if (workerPromise) return workerPromise;

  activePhase = {
    stage: 'library',
    start: PHASE_RANGES.library[0],
    end: PHASE_RANGES.library[1],
  };
  emitProgress('library', activePhase.start, 'loading tesseract');

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
  progressSink = null;
  activePhase = null;

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

function handleTesseractLog(message = {}) {
  if (!progressSink || !activePhase) return;

  const phase = PHASE_RANGES[activePhase.stage] || PHASE_RANGES.library;
  const localProgress = clamp(Number(message.progress) || 0, 0, 1);
  const overall =
    phase[0] + (phase[1] - phase[0]) * localProgress;

  emitProgress(activePhase.stage, overall, message.status || '');
}

function emitProgress(stage, progress, detail = '') {
  if (typeof progressSink !== 'function') return;
  progressSink({
    stage,
    progress: clamp(progress, 0, 1),
    detail,
  });
}

/* -------------------------------------------------------------------------- */
/* Main scanner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Scans a Hot Wheels blister card encoded as a base64 string.
 *
 * @param {string} imageBase64 Base64 JPEG/PNG (with or without the data: prefix).
 * @param {{ onProgress?: (event: { stage: string, progress: number, detail: string }) => void }} [options]
 * @returns {Promise<{ name: string, description: string, collectionName: string,
 *   collectionNumber: string, rawText: string, lines: Array<object> }>}
 */
export async function scanHotWheelsCard(imageBase64, options = {}) {
  progressSink =
    typeof options.onProgress === 'function' ? options.onProgress : null;

  emitProgress('preparing', PHASE_RANGES.preparing[0], 'decoding image');

  let image;
  try {
    image = await loadImage(imageBase64);
  } catch (error) {
    throw new Error('ocr-image-decode', { cause: error });
  }

  activePhase = {
    stage: 'preparing',
    start: PHASE_RANGES.preparing[0],
    end: PHASE_RANGES.preparing[1],
  };
  emitProgress('preparing', PHASE_RANGES.preparing[1], 'image ready');

  activePhase = {
    stage: 'analyzing',
    start: PHASE_RANGES.analyzing[0],
    end: PHASE_RANGES.analyzing[1],
  };
  emitProgress('analyzing', PHASE_RANGES.analyzing[0], 'analysing layout');

  let worker;
  try {
    worker = await getWorker();
  } catch (error) {
    throw new Error('ocr-unavailable', { cause: error });
  }

  const collected = [];
  const rawParts = [];

  const runPass = async ({
    stage,
    canvas,
    psm,
    source,
    region,
    rotate = 0,
    whitelist = '',
  }) => {
    const range = PHASE_RANGES[stage] || PHASE_RANGES.parsing;
    activePhase = { stage, start: range[0], end: range[1] };
    emitProgress(stage, range[0], 'recognising');

    const parameters = {
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    };
    if (whitelist) {
      parameters.tessedit_char_whitelist = whitelist;
    }

    try {
      await worker.setParameters(parameters);
      const result = await worker.recognize(
        canvas,
        {},
        { text: true, blocks: true },
      );
      const data = result?.data || {};
      const lines = collectLines(data, { source, canvas, region, rotate });

      collected.push(...lines);
      if (data.text) rawParts.push(String(data.text));

      emitProgress(stage, range[1], 'done');
      return lines;
    } finally {
      if (whitelist) {
        try {
          await worker.setParameters({ tessedit_char_whitelist: '' });
        } catch {
          /* The next pass will overwrite the parameter anyway. */
        }
      }
    }
  };

  /* 1. Full card: finds every reasonably sized word and its coordinates. */
  const fullCanvas = renderRegion(
    image,
    { x: 0, y: 0, w: 1, h: 1 },
    { targetWidth: 1500 },
  );
  const fullLines = await runPass({
    stage: 'full',
    canvas: fullCanvas,
    psm: '11',
    source: 'full',
    region: { x: 0, y: 0, w: 1, h: 1 },
  });

  /* 2. Use the detected boxes to decide where to look next. */
  const layout = refineLayout(fullLines);

  /* 3. Bottom band: hot-wheels model name lives below the blister. */
  const bottomCanvas = renderRegion(image, layout.bottom, {
    targetWidth: 1400,
  });
  await runPass({
    stage: 'bottom',
    canvas: bottomCanvas,
    psm: '6',
    source: 'bottom',
    region: layout.bottom,
  });

  /* 4. Right-side band, rotated. Collection names are usually vertical. */
  const sideClockwise = renderRegion(image, layout.side, {
    targetWidth: 1400,
    rotate: 90,
  });
  await runPass({
    stage: 'side',
    canvas: sideClockwise,
    psm: '6',
    source: 'side',
    region: layout.side,
    rotate: 90,
  });

  let mergedLines = dedupeLines(collected);
  let collectionName = extractCollectionName(mergedLines, {
    exclude: [extractCarName(mergedLines)],
  });

  /* Some cards print the strip in the opposite direction. */
  if (!collectionName) {
    const sideCounterClockwise = renderRegion(image, layout.side, {
      targetWidth: 1400,
      rotate: -90,
    });
    await runPass({
      stage: 'side',
      canvas: sideCounterClockwise,
      psm: '6',
      source: 'side',
      region: layout.side,
      rotate: -90,
    });
    mergedLines = dedupeLines(collected);
    collectionName = extractCollectionName(mergedLines, {
      exclude: [extractCarName(mergedLines)],
    });
  }

  /* 5. Number-only pass when the collection number was missed. */
  if (!extractCollectionNumber(mergedLines)) {
    const numberCanvas = renderRegion(image, layout.number, {
      targetWidth: 1200,
    });
    await runPass({
      stage: 'numbers',
      canvas: numberCanvas,
      psm: '11',
      source: 'number',
      region: layout.number,
      whitelist: '0123456789/|:.-',
    });
    mergedLines = dedupeLines(collected);
  }

  /* 6. Parse everything once more with the focused passes included. */
  activePhase = {
    stage: 'parsing',
    start: PHASE_RANGES.parsing[0],
    end: PHASE_RANGES.parsing[1],
  };
  emitProgress('parsing', PHASE_RANGES.parsing[0], 'parsing');

  const name = extractCarName(mergedLines);
  const collectionNumber = extractCollectionNumber(mergedLines);
  const description = buildDescription({
    collectionName,
    collectionNumber,
  });
  const rawText = dedupeRawText(rawParts);

  emitProgress('parsing', PHASE_RANGES.parsing[1], 'done');

  return {
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
  const entries = toLines(lines);
  if (!entries.length) return '';

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

  if (best && best.score >= 4) return best.text;
  return fallback;
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

          if (!isValidCollectionPair(current, total, line.text)) continue;

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

function isValidCollectionPair(current, total, lineText) {
  if (!Number.isFinite(current) || !Number.isFinite(total)) return false;
  if (current < 1 || current > 500) return false;
  if (total < 2 || total > 500) return false;
  if (current > total) return false;

  const text = String(lineText || '').toUpperCase();

  /* 1/64, 1/43 and 1/87 are scales, not collection numbers. */
  if (current === 1 && [43, 64, 87].includes(total)) {
    if (!/\b(?:COLLECTION|COLE[CÇ][AÃ]O|S[EÉ]RIE|SERIES)\b/.test(text)) {
      return false;
    }
  }

  if (/\b(?:SCALE|ÉCHELLE|ESCALA)\b/.test(text)) return false;

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
  if (/^['’]?(?:19|20)?\d{2}\b/.test(text)) score += 4;
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
  if (/\b(?:'|’)?\d{2}S\b/i.test(text)) score += 5;
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
    /^['’]?(?:19|20)?\d{2}\b/.test(value) &&
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

function containsCollectionSignal(text) {
  const value = normalizeLine(text).toUpperCase();
  if (!value) return false;

  if (/\bHW\b/.test(value)) return true;
  if (/\bTHE\b/.test(value) && /\b(?:'|’)?\d{2}S\b/.test(value)) return true;
  if (/\b(?:'|’)?\d{2}S\b/.test(value)) return true;

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

  value = value
    .replace(/^([0-9]{1,2})[OQ]\b/, (_, digits) => `${digits}0`)
    .replace(/^([0-9]{2})[Il]\b/, (_, digits) => `${digits}1`)
    .replace(/^[OQ]([0-9]{1,3})\b/, (_, digits) => `0${digits}`)
    .replace(/^[Il]([0-9]{1,3})\b/, (_, digits) => `1${digits}`)
    .replace(/[‘’]/g, "'");

  return value.slice(0, 120);
}

function cleanCollectionName(text) {
  const value = normalizeLine(text)
    .replace(/^[\s\-–—:;,.•*#]+/, '')
    .replace(/[\s\-–—:;,.•*#]+$/, '')
    .replace(/^\s*HOT\s*WHEELS?\s*/i, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!value || value.length < 3) return '';
  if (isNoiseLine(value)) return '';

  return value.slice(0, 80);
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
    const text = normalizeLine(
      isObject ? entry.text ?? entry.raw ?? '' : entry,
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
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’`´]/g, "'")
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
  const lines = [];

  const mapPoint = (x, y) => {
    if (rotate) {
      /* Rotated strip: the rotated x-axis maps back to the original y-axis. */
      const along = rotate > 0 ? x / width : 1 - x / width;
      return {
        x: region.x + (y / height) * region.w,
        y: region.y + along * region.h,
      };
    }

    return {
      x: region.x + (x / width) * region.w,
      y: region.y + (y / height) * region.h,
    };
  };

  const pushLine = (rawText, confidence, bbox) => {
    const text = normalizeLine(rawText);
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

  if (!lines.length && data?.text) {
    const textLines = String(data.text)
      .split(/\r?\n/)
      .map((text) => normalizeLine(text))
      .filter(Boolean);

    textLines.forEach((text, index) => {
      const y0 = (index / Math.max(1, textLines.length)) * height;
      const y1 = ((index + 1) / Math.max(1, textLines.length)) * height;
      pushLine(text, data.confidence, {
        x0: 0,
        y0,
        x1: width,
        y1,
      });
    });
  }

  return lines;
}

function dedupeLines(lines) {
  const best = new Map();

  for (const line of lines) {
    const key = normalizeKey(line.text);
    if (!key) continue;

    const score =
      line.confidence +
      (line.source === 'bottom' ? 15 : 0) +
      (line.source === 'side' ? 20 : 0) +
      (line.source === 'number' ? 10 : 0) +
      Math.min(8, line.text.length / 5);

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

function refineLayout(fullLines) {
  const bottomLines = fullLines.filter(
    (line) =>
      line.relativeY != null &&
      line.relativeY >= 0.42 &&
      (line.relativeX == null || line.relativeX < 0.74) &&
      isRegionText(line.text),
  );

  const sideLines = fullLines.filter(
    (line) =>
      line.relativeX != null &&
      line.relativeX >= 0.58 &&
      isRegionText(line.text),
  );

  return {
    bottom: unionRegion(bottomLines, FALLBACK_REGIONS.bottom, {
      minWidth: 0.5,
      minHeight: 0.08,
      margin: 0.04,
    }),
    side: unionRegion(sideLines, FALLBACK_REGIONS.side, {
      minWidth: 0.16,
      minHeight: 0.25,
      margin: 0.03,
    }),
    number: { ...FALLBACK_REGIONS.number },
  };
}

function unionRegion(lines, fallback, { minWidth, minHeight, margin }) {
  if (!lines.length) return { ...fallback };

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

  if (x1 - x0 < 0.08 || y1 - y0 < 0.04) return { ...fallback };

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
    image.src = source.startsWith('data:')
      ? source
      : `data:image/jpeg;base64,${source}`;
  });
}

function renderRegion(image, region, options = {}) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;

  const sx = clamp(region.x, 0, 1) * imageWidth;
  const sy = clamp(region.y, 0, 1) * imageHeight;
  const sw = clamp(region.w, 0.01, 1) * imageWidth;
  const sh = clamp(region.h, 0.01, 1) * imageHeight;

  const targetWidth = clamp(Number(options.targetWidth) || 1400, 300, 2000);
  const rotate = Number(options.rotate) || 0;

  if (rotate) {
    /*
     * The rotated width is the most useful dimension for Tesseract, so the
     * pre-rotation height is targetWidth and the pre-rotation width follows
     * the original aspect ratio.
     */
    const preHeight = targetWidth;
    const preWidth = clamp(
      Math.round(targetWidth * (sw / sh)),
      240,
      2400,
    );

    const temp = makeCanvas(preWidth, preHeight);
    const tempCtx = temp.getContext('2d', { willReadFrequently: true });
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = 'high';
    tempCtx.drawImage(image, sx, sy, sw, sh, 0, 0, preWidth, preHeight);

    enhanceCanvas(temp);
    return rotateCanvas(temp, rotate);
  }

  const outputWidth = targetWidth;
  const outputHeight = clamp(
    Math.round(targetWidth * (sh / sw)),
    80,
    3200,
  );

  const canvas = makeCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);

  enhanceCanvas(canvas);
  return canvas;
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function rotateCanvas(source, degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return source;

  const swap = normalized === 90 || normalized === 270;
  const canvas = makeCanvas(
    swap ? source.height : source.width,
    swap ? source.width : source.height,
  );
  const context = canvas.getContext('2d');

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((normalized * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);

  return canvas;
}

/**
 * Grayscale + contrast stretch + light unsharp mask. Tesseract does its own
 * binarization, so keeping a clean grayscale image is safer than hard
 * thresholding coloured packaging.
 */
function enhanceCanvas(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const width = canvas.width;
  const height = canvas.height;
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  const pixelCount = width * height;

  const luma = new Uint8ClampedArray(pixelCount);
  const histogram = new Uint32Array(256);

  for (let i = 0, p = 0; i < pixelCount; i += 1, p += 4) {
    const value = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
    luma[i] = value;
    histogram[value] += 1;
  }

  const low = percentile(histogram, pixelCount, 0.02);
  const high = percentile(histogram, pixelCount, 0.98);
  const range = Math.max(1, high - low);

  const lut = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) {
    let normalized = clamp((value - low) / range, 0, 1);
    normalized =
      normalized < 0.5
        ? 0.5 * Math.pow(2 * normalized, 1.1)
        : 1 - 0.5 * Math.pow(2 * (1 - normalized), 1.1);
    lut[value] = Math.round(normalized * 255);
  }

  const sharpened = new Uint8ClampedArray(pixelCount);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = lut[luma[index]];

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        sharpened[index] = value;
        continue;
      }

      const blur =
        (lut[luma[index - 1]] +
          lut[luma[index + 1]] +
          lut[luma[index - width]] +
          lut[luma[index + width]]) /
        4;

      sharpened[index] = clamp(value + 0.55 * (value - blur), 0, 255);
    }
  }

  for (let i = 0, p = 0; i < pixelCount; i += 1, p += 4) {
    const value = sharpened[i];
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
}

function percentile(histogram, total, fraction) {
  const target = Math.max(0, total * fraction);
  let seen = 0;

  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }

  return 255;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
