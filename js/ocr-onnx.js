/**
 * ONNX Runtime Web Client Controller for PP-OCRv4.
 *
 * Coordinates message passing with `js/ocr-worker.js`, handles transferable
 * pixel buffers from Canvas/ImageBitmap, and reports progressive status to the UI.
 */

import { prepareRegion } from './ocr.js';

let workerInstance = null;
let currentRequestId = 0;
let preloadPromise = null;
const pendingRequests = new Map();

/** Stages the rest of the app already understands (shared with Tesseract). */
const KNOWN_STAGES = new Set([
  'library',
  'preparing',
  'analyzing',
  'full',
  'bottom',
  'side',
  'numbers',
  'parsing',
]);

/**
 * Resolves the worker script URL robustly regardless of base path (Hostinger subfolder, GitHub Pages, etc.).
 * @returns {string}
 */
function resolveWorkerUrl() {
  try {
    // Prefer import.meta.url (available in ES modules) to compute an absolute URL
    return new URL('./ocr-worker.js', import.meta.url).href;
  } catch {
    // Fallback: absolute path from origin (works when served from domain root or known subfolder)
    return '/js/ocr-worker.js';
  }
}

/**
 * Lazily creates or returns the active Web Worker instance.
 * @returns {Worker}
 */
export function getOcrWorker() {
  if (workerInstance) return workerInstance;

  const workerUrl = resolveWorkerUrl();
  workerInstance = new Worker(workerUrl);

  workerInstance.onmessage = (event) => {
    const { type, id, stage, progress, detail, result, reason, error } = event.data || {};
    const handlers = pendingRequests.get(id);

    if (!handlers) return;

    if (type === 'progress') {
      handlers.onProgress?.({
        // Keep the UI vocabulary identical to the Tesseract pipeline.
        stage: KNOWN_STAGES.has(stage) ? stage : 'full',
        progress: typeof progress === 'number' ? progress : 0,
        detail: detail || '',
      });
      return;
    }

    if (type === 'ready') {
      pendingRequests.delete(id);
      handlers.resolve({ provider: event.data.provider || 'onnx' });
      return;
    }

    if (type === 'result') {
      pendingRequests.delete(id);
      handlers.resolve(result);
      return;
    }

    if (type === 'fallback') {
      pendingRequests.delete(id);
      const fallbackErr = new Error(`ONNX_FALLBACK: ${reason || 'Inference failed'}`);
      fallbackErr.isFallback = true;
      handlers.reject(fallbackErr);
      return;
    }

    if (type === 'error') {
      pendingRequests.delete(id);
      handlers.reject(new Error(error || 'Worker error'));
      return;
    }
  };

  workerInstance.onerror = (err) => {
    console.warn('[OCR Client] Worker global error:', err);
    for (const [id, handlers] of pendingRequests.entries()) {
      pendingRequests.delete(id);
      const fallbackErr = new Error('ONNX_WORKER_ERROR: ' + (err.message || 'Worker crash'));
      fallbackErr.isFallback = true;
      handlers.reject(fallbackErr);
    }
  };

  return workerInstance;
}

/**
 * Warms up the OCR worker in the background.
 *
 * Creates the worker and asks it to load ONNX Runtime, the dictionary and both
 * models, so the first real scan starts with sessions already compiled.
 *
 * @param {(event: { stage: string, progress: number, detail: string }) => void} [onProgress]
 * @returns {Promise<{ provider: string }>}
 */
export function preloadOcrModels(onProgress) {
  if (preloadPromise) return preloadPromise;

  const worker = getOcrWorker();
  const requestId = ++currentRequestId;

  preloadPromise = new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve,
      reject: (err) => {
        preloadPromise = null;
        reject(err);
      },
      onProgress,
    });

    try {
      worker.postMessage({ type: 'init', id: requestId });
    } catch (err) {
      pendingRequests.delete(requestId);
      preloadPromise = null;
      reject(err);
    }
  });

  return preloadPromise;
}

/**
 * Terminates the OCR Web Worker and frees all allocated session memory.
 * Waits for the worker to confirm sessions are released before hard-terminating.
 */
export function terminateOcrWorker() {
  if (!workerInstance) return;

  return new Promise((resolve) => {
    const timeoutMs = 2000;
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      workerInstance = null;
      preloadPromise = null;
      for (const [, handlers] of pendingRequests.entries()) {
        handlers.reject(new Error('OCR_TERMINATED'));
      }
      pendingRequests.clear();
      resolve();
    };

    // Listen for graceful termination confirmation
    const onTerminated = (event) => {
      if (event.data?.type === 'terminated') {
        workerInstance.removeEventListener('message', onTerminated);
        clearTimeout(timeoutId);
        workerInstance.terminate();
        cleanup();
      }
    };
    workerInstance.addEventListener('message', onTerminated);

    // Fallback: hard terminate after timeout
    const timeoutId = setTimeout(() => {
      workerInstance.removeEventListener('message', onTerminated);
      try { workerInstance.terminate(); } catch {}
      cleanup();
    }, timeoutMs);

    try {
      workerInstance.postMessage({ type: 'terminate' });
    } catch {
      clearTimeout(timeoutId);
      workerInstance.removeEventListener('message', onTerminated);
      try { workerInstance.terminate(); } catch {}
      cleanup();
    }
  });
}

/**
 * Extracts pixels from an HTMLCanvasElement, HTMLImageElement, ImageBitmap or OffscreenCanvas.
 * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap|OffscreenCanvas} source
 * @returns {{ pixels: Uint8ClampedArray, width: number, height: number }}
 */
function extractImageData(source) {
  const width = /** @type {any} */ (source).naturalWidth || source.width || 0;
  const height = /** @type {any} */ (source).naturalHeight || source.height || 0;

  if (!width || !height) {
    throw new Error('INVALID_SOURCE_IMAGE');
  }

  let canvas;
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    canvas = source;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
    const ctx = /** @type {CanvasRenderingContext2D} */ (
      /** @type {unknown} */ (canvas.getContext('2d'))
    );
    ctx.drawImage(source, 0, 0);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = /** @type {CanvasRenderingContext2D} */ (
      /** @type {unknown} */ (canvas.getContext('2d'))
    );
    ctx.drawImage(source, 0, 0);
  } else {
    throw new Error('CANVAS_UNAVAILABLE');
  }

  const ctx = /** @type {CanvasRenderingContext2D} */ (
    canvas.getContext('2d', { willReadFrequently: true })
  );
  const imageData = ctx.getImageData(0, 0, width, height);

  return {
    pixels: imageData.data,
    width,
    height,
  };
}

/**
 * Executes PP-OCRv4 neural inference on the given image via the Web Worker.
 *
 * Applies the same enhancement pipeline as Tesseract (prepareRegion) before
 * sending to the worker, so the neural models receive cleaned-up input.
 *
 * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap} sourceImage
 * @param {object} [options]
 * @param {(event: { stage: string, progress: number, detail: string }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ lines: Array<{ text: string, confidence: number, box: object }>, rawText: string, provider: string }>}
 */
export async function runPpOcr(sourceImage, options = {}) {
  const { onProgress, signal } = options;

  if (signal?.aborted) {
    throw new DOMException('OCR aborted by user', 'AbortError');
  }

  const worker = getOcrWorker();
  const requestId = ++currentRequestId;

  onProgress?.({ stage: 'preparing', progress: 0.1, detail: 'enhancing image' });

  // Get original dimensions for coordinate mapping later
  const origWidth = /** @type {any} */ (sourceImage).naturalWidth || sourceImage.width || 0;
  const origHeight = /** @type {any} */ (sourceImage).naturalHeight || sourceImage.height || 0;
  if (!origWidth || !origHeight) {
    throw new Error('INVALID_SOURCE_IMAGE');
  }

  // Apply enhancement pipeline (same as Tesseract path) to improve neural OCR accuracy
  // targetLongSide: 960 matches worker's DET_MAX_SIDE so worker skips its own resize
  // maxScale: 2 limits upscale to avoid pure interpolation
  // pad: 0, rotate: 0 for full-card enhancement
  const prepareOptions = {
    enhance: true,
    targetLongSide: 960,
    maxScale: 2,
    pad: 0,
    rotate: 0,
    denoise: 'auto',
    clahe: true,
    sharpen: 0.6,
  };

  // OffscreenCanvas can be transferred to the worker without a pixel readback.
  const supportsOffscreen = typeof OffscreenCanvas === 'function';
  let enhancedCanvas;
  try {
    enhancedCanvas = prepareRegion(sourceImage, { x: 0, y: 0, w: 1, h: 1 }, {
      ...prepareOptions,
      offscreen: supportsOffscreen,
    });
  } catch (offscreenErr) {
    if (!supportsOffscreen) throw offscreenErr;
    // Some engines expose OffscreenCanvas but not 2D in this context.
    enhancedCanvas = prepareRegion(sourceImage, { x: 0, y: 0, w: 1, h: 1 }, prepareOptions);
  }

  // Compute scale from original -> enhanced for inverse mapping of boxes
  const scaleX = enhancedCanvas.width / origWidth;
  const scaleY = enhancedCanvas.height / origHeight;

  const transferCanvas = supportsOffscreen && enhancedCanvas instanceof OffscreenCanvas;
  onProgress?.({
    stage: 'preparing',
    progress: 0.2,
    detail: transferCanvas ? 'transferring canvas' : 'reading pixels',
  });

  return new Promise((resolve, reject) => {
    let abortHandler = null;

    if (signal) {
      abortHandler = () => {
        pendingRequests.delete(requestId);
        reject(new DOMException('OCR aborted by user', 'AbortError'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    pendingRequests.set(requestId, {
      resolve: (data) => {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        // Map boxes from enhanced canvas coordinates back to original image coordinates
        if (data?.lines?.length) {
          for (const line of data.lines) {
            if (line.box) {
              line.box = {
                x: Math.round(line.box.x / scaleX),
                y: Math.round(line.box.y / scaleY),
                w: Math.round(line.box.w / scaleX),
                h: Math.round(line.box.h / scaleY),
                score: line.box.score,
              };
            }
          }
        }
        resolve(data);
      },
      reject: (err) => {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        reject(err);
      },
      onProgress,
    });

    try {
      if (transferCanvas) {
        try {
          worker.postMessage(
            {
              type: 'scan',
              id: requestId,
              data: {
                canvas: enhancedCanvas,
                width: enhancedCanvas.width,
                height: enhancedCanvas.height,
              },
            },
            [enhancedCanvas]
          );
          return;
        } catch (transferErr) {
          // Fall through to the pixel path if the canvas cannot be transferred.
          console.info('[OCR Client] OffscreenCanvas transfer failed, using pixels:', transferErr);
        }
      }

      const { pixels, width, height } = extractImageData(enhancedCanvas);
      const pixelBuffer = pixels.buffer;

      worker.postMessage(
        {
          type: 'scan',
          id: requestId,
          data: { pixels: pixelBuffer, width, height },
        },
        [pixelBuffer]
      );
    } catch (postErr) {
      pendingRequests.delete(requestId);
      reject(postErr);
    }
  });
}

