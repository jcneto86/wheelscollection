import { LIMITS } from './firebase-config.js';

/**
 * Interactive square image cropper.
 *
 * The preview canvas uses a fixed logical size (400 x 400) and is scaled by
 * CSS, so panning works identically on desktop and mobile. The final image is
 * rendered at exactly 500 x 500 and encoded as JPEG. The Base64 string is
 * written to Firestore without the `data:` prefix.
 */
export class CropSession {
  constructor(canvas, image, viewSize = 400) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('crop-canvas-unavailable');
    }

    this.canvas = canvas;
    this.image = image;
    this.view = viewSize;
    this.zoom = 1;
    this.minZoom = 1;
    this.maxZoom = 3;
    this.rotation = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.ctx = canvas.getContext('2d');

    if (!this.ctx) {
      throw new Error('crop-canvas-unavailable');
    }

    const imageWidth = this.imageWidth;
    const imageHeight = this.imageHeight;
    if (!imageWidth || !imageHeight) {
      throw new Error('image-decode');
    }

    canvas.width = Math.round(this.view * this.dpr);
    canvas.height = Math.round(this.view * this.dpr);
    canvas.style.aspectRatio = '1 / 1';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    this.clampOffsets();
    this.draw();
  }

  static async fromFile(file, canvas, viewSize = 400) {
    const image = await loadImage(file);
    return new CropSession(canvas, image, viewSize);
  }

  get imageWidth() {
    return this.image.width || this.image.naturalWidth || 0;
  }

  get imageHeight() {
    return this.image.height || this.image.naturalHeight || 0;
  }

  get rotatedWidth() {
    return this.rotation % 180 === 0 ? this.imageWidth : this.imageHeight;
  }

  get rotatedHeight() {
    return this.rotation % 180 === 0 ? this.imageHeight : this.imageWidth;
  }

  get baseScale() {
    return Math.max(
      this.view / this.rotatedWidth,
      this.view / this.rotatedHeight,
    );
  }

  get scale() {
    return this.baseScale * this.zoom;
  }

  setZoom(value) {
    const next = Number(value);
    if (!Number.isFinite(next)) return;

    this.zoom = clamp(next, this.minZoom, this.maxZoom);
    this.clampOffsets();
    this.draw();
  }

  rotate(deltaDegrees) {
    this.rotation = (this.rotation + deltaDegrees + 360) % 360;
    this.clampOffsets();
    this.draw();
  }

  panBy(deltaX, deltaY) {
    this.offsetX += Number(deltaX) || 0;
    this.offsetY += Number(deltaY) || 0;
    this.clampOffsets();
    this.draw();
  }

  reset() {
    this.zoom = 1;
    this.rotation = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.clampOffsets();
    this.draw();
  }

  clampOffsets() {
    const drawnWidth = this.rotatedWidth * this.scale;
    const drawnHeight = this.rotatedHeight * this.scale;
    const maxX = Math.max(0, (drawnWidth - this.view) / 2);
    const maxY = Math.max(0, (drawnHeight - this.view) / 2);

    this.offsetX = clamp(this.offsetX, -maxX, maxX);
    this.offsetY = clamp(this.offsetY, -maxY, maxY);
  }

  draw() {
    const ctx = this.ctx;
    const width = this.imageWidth * this.scale;
    const height = this.imageHeight * this.scale;

    ctx.clearRect(0, 0, this.view, this.view);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, this.view, this.view);

    ctx.save();
    ctx.translate(
      this.view / 2 + this.offsetX,
      this.view / 2 + this.offsetY,
    );
    ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.drawImage(this.image, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  /**
   * Renders the crop at exactly 500 x 500. Tries decreasing JPEG qualities
   * until the Base64 payload fits comfortably inside the Firestore limit.
   */
  toBase64(maxLength = LIMITS.imageBase64) {
    const side = LIMITS.imageSide;
    const output = document.createElement('canvas');
    output.width = side;
    output.height = side;

    const ctx = output.getContext('2d');
    if (!ctx) {
      throw new Error('crop-canvas-unavailable');
    }

    const factor = side / this.view;
    const width = this.imageWidth * this.scale * factor;
    const height = this.imageHeight * this.scale * factor;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, side, side);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(side / 2 + this.offsetX * factor, side / 2 + this.offsetY * factor);
    ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.drawImage(this.image, -width / 2, -height / 2, width, height);

    for (const quality of [0.82, 0.72, 0.62, 0.5]) {
      const dataUrl = output.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.split(',')[1] || '';
      if (base64.length > 0 && base64.length <= maxLength) {
        return base64;
      }
    }

    throw new Error('image-too-large');
  }

  dispose() {
    if (this.image && typeof this.image.close === 'function') {
      this.image.close();
    }
    this.image = null;
  }
}

async function loadImage(file) {
  if (typeof window.createImageBitmap === 'function') {
    try {
      return await window.createImageBitmap(file, {
        imageOrientation: 'from-image',
      });
    } catch (error) {
      console.warn('[crop] createImageBitmap with orientation failed:', error);
    }

    try {
      return await window.createImageBitmap(file);
    } catch (error) {
      console.warn('[crop] createImageBitmap failed:', error);
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image-decode'));
    };

    image.src = url;
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
