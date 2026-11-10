const DEFAULTS = Object.freeze({
  /** Lado maior do recorte, em px, antes de arredondar. */
  targetLongSide: 1200,
  minScale: 0.25,
  maxScale: 5,
  /** Trava de seguranca para nao criar canvas gigante em foto 4K. */
  maxPixels: 4_000_000,
  /** Margem branca em px do canvas final. */
  pad: 16,
  /** 0, 90, 180, 270 (positivo = horario). */
  rotate: 0,
  /** false = devolve o recorte cru (usado na passada de layout). */
  enhance: true,
  /** 'auto' liga o filtro sigma quando o recorte original e pequeno (foto ruim). */
  denoise: 'auto',
  clahe: true,
  claheTiles: 8,
  claheClip: 4,
  channelSelect: true,
  /** 'auto' inverte se o fundo for escuro. O Tesseract ja tenta as duas
   *  polaridades, entao o padrao e nao inverter. */
  invert: false,
  /** 0 desliga. 0.8 e um bom ponto para texto de 30-50 px. */
  sharpen: 0.6,
  /** Devolve um OffscreenCanvas (transferivel para um Worker) quando suportado. */
  offscreen: false,
});

const CHANNELS = ['luma', 'red', 'green', 'blue', 'max', 'min'];
const CH_LUMA = 0;
const CH_MIN = 5;

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value));

/* -------------------------------------------------------------------------- */
/* API principal                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Recorta `region` (coordenadas normalizadas 0..1) da imagem, aplica escala,
 * margem, rotacao e realce, e devolve um canvas pronto para o Tesseract.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|OffscreenCanvas} image
 * @param {{x:number,y:number,w:number,h:number}} region
 * @param {object} [options]
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
export function prepareRegion(image, region, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const imageWidth = /** @type {any} */ (image).naturalWidth || image.width || 1;
  const imageHeight = /** @type {any} */ (image).naturalHeight || image.height || 1;

  const rx = clamp(Number(region?.x) || 0, 0, 1);
  const ry = clamp(Number(region?.y) || 0, 0, 1);
  const rw = clamp(Number(region?.w) || 0.01, 0.005, 1 - rx);
  const rh = clamp(Number(region?.h) || 0.01, 0.005, 1 - ry);

  const sx = Math.round(rx * imageWidth);
  const sy = Math.round(ry * imageHeight);
  const sw = Math.max(1, Math.round(rw * imageWidth));
  const sh = Math.max(1, Math.round(rh * imageHeight));

  const rotate = normalizeRotation(opts.rotate);
  const swap = rotate === 90 || rotate === 270;

  const longSide = Math.max(sw, sh);
  let scale = clamp(opts.targetLongSide / longSide, opts.minScale, opts.maxScale);
  scale = Math.min(scale, Math.sqrt(opts.maxPixels / (sw * sh)));
  scale = Math.max(0.05, scale);

  const drawWidth = Math.max(1, Math.round(sw * scale));
  const drawHeight = Math.max(1, Math.round(sh * scale));
  const pad = Math.max(0, Math.round(opts.pad));

  /*
   * Realce acontece no recorte SEM margem: a margem branca, se entrasse nas
   * estatisticas, viraria o "fundo dominante" do histograma e achataria o
   * contraste do texto (foi assim que o fundo ficou cinza na primeira versao).
   */
  const cropCanvas = makeCanvas(drawWidth, drawHeight, opts.offscreen);
  const cropContext = /** @type {CanvasRenderingContext2D} */ (
    cropCanvas.getContext('2d', { willReadFrequently: true })
  );
  cropContext.imageSmoothingEnabled = true;
  cropContext.imageSmoothingQuality = 'high';
  cropContext.drawImage(image, sx, sy, sw, sh, 0, 0, drawWidth, drawHeight);

  if (opts.enhance) {
    /* O denoise depende da resolucao *de origem*, nao do canvas final. */
    const denoise =
      opts.denoise === 'auto' ? longSide < 700 : Boolean(opts.denoise);

    enhanceCanvas(cropCanvas, { ...opts, denoise });
  }

  if (!rotate && !pad) return cropCanvas;

  const canvas = makeCanvas(
    (swap ? drawHeight : drawWidth) + pad * 2,
    (swap ? drawWidth : drawHeight) + pad * 2,
    opts.offscreen,
  );
  const context = /** @type {CanvasRenderingContext2D} */ (
    canvas.getContext('2d', { willReadFrequently: true })
  );
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  /* Multiplos de 90 graus nao precisam de reamostragem. */
  context.imageSmoothingEnabled = false;

  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  if (rotate) context.rotate((rotate * Math.PI) / 180);
  context.drawImage(cropCanvas, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();

  return canvas;
}

/** Aplica o pipeline de realce em um canvas existente (in place). */
export function enhanceCanvas(canvas, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const context = /** @type {CanvasRenderingContext2D} */ (
    canvas.getContext('2d', { willReadFrequently: true })
  );
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

  enhancePixels(imageData.data, canvas.width, canvas.height, opts);
  context.putImageData(imageData, 0, 0);

  return canvas;
}

/**
 * Pipeline de pixels puro (sem DOM) -- testavel em Node.
 * Muta `data` (RGBA, Uint8ClampedArray) no lugar.
 *
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 */
export function enhancePixels(data, width, height, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const total = width * height;
  if (!total) return data;

  const channel = opts.channelSelect
    ? pickChannel(data, width, height)
    : CH_LUMA;

  const gray = new Uint8ClampedArray(total);
  toGray(data, gray, width, height, channel);

  if (opts.denoise) denoiseGray(gray, width, height);

  /* Polaridade tem que ser normalizada ANTES do CLAHE: depois do contraste
   * local o fundo ja foi puxado para perto de 255 e nao da mais para saber. */
  const invert =
    opts.invert === 'auto' ? dominantTone(gray) < 110 : Boolean(opts.invert);
  if (invert) invertGray(gray, total);

  /* CLAHE so quando existe gradiente real de iluminacao (flash, sombra,
   * reflexo do blister). Em recorte ja uniforme ele so amplia ruido de sensor,
   * porque achata a CDF de blocos lisos e transforma textura em sal e pimenta. */
  if (
    opts.clahe &&
    width >= 96 &&
    height >= 96 &&
    illuminationGradient(gray, width, height) > 24
  ) {
    applyClahe(gray, width, height, opts.claheTiles, opts.claheClip);
  } else {
    stretchToBackground(gray);
  }

  const sharpen = Number(opts.sharpen) || 0;
  if (sharpen > 0) unsharp(gray, width, height, sharpen);

  for (let i = 0, p = 0; i < total; i += 1, p += 4) {
    const value = gray[i];
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }

  return data;
}

/**
 * Escolhe o canal de cor que tem mais *borda de letra*, e nao o de maior
 * contraste global.
 *
 * A metrica antiga (variancia entre classes de Otsu) falha no caso classico da
 * cartela: no rotulo amarelo, o canal azul separa perfeitamente "faixa escura"
 * de "plastico branco" (eta maximo) e mesmo assim nao enxerga uma letra --
 * amarelo e preto tem o mesmo azul (~0). Aqui cada canal recebe a energia de
 * gradiente acima da mediana, que e alta onde existe traco e baixa onde so
 * existe ruido.
 */
export function pickChannel(data, width, height) {
  const scores = new Array(CHANNELS.length).fill(-1);

  for (let channel = 0; channel < CHANNELS.length; channel += 1) {
    if (channel === CH_MIN) continue;
    scores[channel] = channelEdgeScore(data, width, height, channel);
  }

  let best = 0;
  for (let channel = 1; channel < CHANNELS.length; channel += 1) {
    if (scores[channel] > scores[best]) best = channel;
  }

  /* So troca a luminancia quando o ganho e claro (>15%). */
  if (best !== CH_LUMA && scores[best] > scores[CH_LUMA] * 1.15) return best;
  return CH_LUMA;
}

function channelEdgeScore(data, width, height, channel) {
  const step = 2;
  const smallWidth = Math.floor(width / step);
  const smallHeight = Math.floor(height / step);
  if (smallWidth < 8 || smallHeight < 8) return 0;

  const small = new Uint8Array(smallWidth * smallHeight);
  for (let y = 0; y < smallHeight; y += 1) {
    const sourceRow = y * step * width;
    for (let x = 0; x < smallWidth; x += 1) {
      small[y * smallWidth + x] = readChannel(
        data,
        (sourceRow + x * step) * 4,
        channel,
      );
    }
  }

  /*
   * Densidade de bordas fortes, e nao soma de energia: uma unica transicao
   * gigante (plastico branco x faixa amarela, ~220 niveis) domina a soma e
   * elegeria o canal azul, onde o texto tem contraste ~20 e desaparece.
   * Contando pixels de borda, quem ganha e o canal onde as letras existem.
   */
  const EDGE_THRESHOLD = 42;
  let strong = 0;
  let count = 0;

  for (let y = 0; y < smallHeight - 1; y += 1) {
    for (let x = 0; x < smallWidth - 1; x += 1) {
      const index = y * smallWidth + x;
      const gradient =
        Math.abs(small[index + 1] - small[index]) +
        Math.abs(small[index + smallWidth] - small[index]);
      if (gradient >= EDGE_THRESHOLD) strong += 1;
      count += 1;
    }
  }

  return count ? strong / count : 0;
}

/** Diferenca media entre metades opostas: detecta flash/sombra lateral. */
function illuminationGradient(gray, width, height) {
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  let leftCount = 0;
  let rightCount = 0;
  let topCount = 0;
  let bottomCount = 0;

  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      const value = gray[row + x];
      if (x < width / 2) {
        left += value;
        leftCount += 1;
      } else {
        right += value;
        rightCount += 1;
      }
      if (y < height / 2) {
        top += value;
        topCount += 1;
      } else {
        bottom += value;
        bottomCount += 1;
      }
    }
  }

  const leftMean = leftCount ? left / leftCount : 0;
  const rightMean = rightCount ? right / rightCount : 0;
  const topMean = topCount ? top / topCount : 0;
  const bottomMean = bottomCount ? bottom / bottomCount : 0;

  return Math.max(Math.abs(leftMean - rightMean), Math.abs(topMean - bottomMean));
}

/* -------------------------------------------------------------------------- */
/* Pixels                                                                     */
/* -------------------------------------------------------------------------- */

function readChannel(data, p, channel) {
  const r = data[p];
  const g = data[p + 1];
  const b = data[p + 2];

  switch (channel) {
    case 1:
      return r;
    case 2:
      return g;
    case 3:
      return b;
    case 4:
      return r > g ? (r > b ? r : b) : g > b ? g : b;
    case 5:
      return r < g ? (r < b ? r : b) : g < b ? g : b;
    default:
      return (r * 0.299 + g * 0.587 + b * 0.114) | 0;
  }
}

function toGray(data, gray, width, height, channel) {
  const total = width * height;
  for (let i = 0, p = 0; i < total; i += 1, p += 4) {
    gray[i] = readChannel(data, p, channel);
  }
}

/**
 * Filtro sigma 3x3 (denoise com preservacao de borda).
 *
 * Comparado com a mediana 3x3, preserva melhor tracos finos de 1-2 px -- que e
 * exatamente o caso de texto pequeno ampliado -- e custa ~40% menos. So soma
 * vizinhos cuja diferenca para o centro e menor que SIGMA_THRESHOLD, entao
 * ruido de sensor (alto ISO) e blocos de JPEG somem sem borrar a letra.
 */
const SIGMA_THRESHOLD = 22;

function denoiseGray(gray, width, height) {
  const source = gray.slice();

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const center = source[index];

      let sum = center * 2;
      let count = 2;

      for (let dy = -1; dy <= 1; dy += 1) {
        const row = index + dy * width;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const neighbour = source[row + dx];
          if (Math.abs(neighbour - center) < SIGMA_THRESHOLD) {
            sum += neighbour;
            count += 1;
          }
        }
      }

      gray[index] = sum / count;
    }
  }
}

/**
 * Normaliza o contraste ancorando o branco no tom dominante (o fundo).
 *
 * O stretch por percentil 2-98% falha quando existe um brilho especular no
 * recorte: 5% de pixels estourados empurram o percentil 98 para 255 e o fundo
 * real fica cinza, perdendo metade da faixa dinamica do texto. O tom dominante
 * e o fundo por definicao (o texto ocupa poucos por cento), entao ancorar nele
 * sempre entrega texto preto em fundo branco.
 */
function stretchToBackground(gray) {
  const total = gray.length;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < total; i += 1) histogram[gray[i]] += 1;

  const low = percentile(histogram, total, 0.02);
  const background = dominantTone(gray);

  /* Recorte sem contraste nenhum (branco, preto, plastico liso): nao ha o que
   * normalizar. Sem esta saida, um recorte todo branco vira todo preto. */
  if (background - low < 12) return;

  const range = Math.max(24, background - low);
  /* Ganho limitado: recorte quase chapado (fundo e texto com 10 niveis de
   * diferenca) nao pode virar um amplificador de ruido de 10x. */
  const gain = Math.min(6, 248 / range);
  const lut = new Uint8ClampedArray(256);

  for (let value = 0; value < 256; value += 1) {
    lut[value] = (value - low) * gain;
  }

  for (let i = 0; i < total; i += 1) gray[i] = lut[gray[i]];
}

/**
 * CLAHE simplificado: LUT por bloco, interpolacao bilinear entre blocos.
 * Remove gradiente de iluminacao (flash, sombra, blister refletivo) sem
 * "achatar" o contraste onde ja existe texto.
 */
function applyClahe(gray, width, height, requestedTiles, clipFactor) {
  /* Bloco pequeno + clip baixo = amplificador de ruido. O tamanho do bloco tem
   * que ser maior que a altura da letra, senao cada bloco normaliza o proprio
   * texto e o resultado vira uma mancha de alto contraste. */
  const tilesX = Math.max(2, Math.min(requestedTiles, Math.floor(width / 140)));
  const tilesY = Math.max(2, Math.min(requestedTiles, Math.floor(height / 80)));
  const tileWidth = width / tilesX;
  const tileHeight = height / tilesY;
  const luts = new Array(tilesX * tilesY);

  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const x0 = Math.floor(tx * tileWidth);
      const x1 = Math.min(width, Math.ceil((tx + 1) * tileWidth));
      const y0 = Math.floor(ty * tileHeight);
      const y1 = Math.min(height, Math.ceil((ty + 1) * tileHeight));

      const histogram = new Float64Array(256);
      let count = 0;

      for (let y = y0; y < y1; y += 1) {
        const row = y * width;
        for (let x = x0; x < x1; x += 1) {
          histogram[gray[row + x]] += 1;
          count += 1;
        }
      }

      if (!count) {
        luts[ty * tilesX + tx] = identityLut();
        continue;
      }

      /* Clip limit: impede que blocos lisos (plastico) explodam em ruido. */
      const limit = Math.max(1, (count / 256) * clipFactor);
      let excess = 0;
      for (let value = 0; value < 256; value += 1) {
        if (histogram[value] > limit) {
          excess += histogram[value] - limit;
          histogram[value] = limit;
        }
      }

      const redistribute = excess / 256;
      const cumulative = new Float64Array(256);
      let accumulated = 0;
      let cumulativeMinimum = 0;
      let foundFirst = false;

      for (let value = 0; value < 256; value += 1) {
        const bin = histogram[value] + redistribute;
        if (!foundFirst && bin > 0) {
          cumulativeMinimum = accumulated;
          foundFirst = true;
        }
        accumulated += bin;
        cumulative[value] = accumulated;
      }

      const denominator = Math.max(1, count - cumulativeMinimum);
      const lut = new Uint8ClampedArray(256);
      for (let value = 0; value < 256; value += 1) {
        lut[value] = ((cumulative[value] - cumulativeMinimum) / denominator) * 255;
      }

      luts[ty * tilesX + tx] = lut;
    }
  }

  const gridX = width / tilesX;
  const gridY = height / tilesY;

  for (let y = 0; y < height; y += 1) {
    const fy = clamp((y + 0.5) / gridY - 0.5, 0, tilesY - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(tilesY - 1, y0 + 1);
    const wy = fy - y0;

    for (let x = 0; x < width; x += 1) {
      const fx = clamp((x + 0.5) / gridX - 0.5, 0, tilesX - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(tilesX - 1, x0 + 1);
      const wx = fx - x0;

      const value = gray[y * width + x];
      const topLeft = luts[y0 * tilesX + x0][value];
      const topRight = luts[y0 * tilesX + x1][value];
      const bottomLeft = luts[y1 * tilesX + x0][value];
      const bottomRight = luts[y1 * tilesX + x1][value];

      const top = topLeft + (topRight - topLeft) * wx;
      const bottom = bottomLeft + (bottomRight - bottomLeft) * wx;

      gray[y * width + x] = top + (bottom - top) * wy;
    }
  }
}

function identityLut() {
  const lut = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) lut[value] = value;
  return lut;
}

/** Tom dominante = cor de fundo (o fundo ocupa a maior parte do recorte). */
function dominantTone(gray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1;

  let best = 0;
  let bestCount = -1;
  for (let value = 0; value < 256; value += 1) {
    if (histogram[value] > bestCount) {
      bestCount = histogram[value];
      best = value;
    }
  }

  return best;
}

function invertGray(gray, total) {
  for (let i = 0; i < total; i += 1) gray[i] = 255 - gray[i];
}

/** Unsharp com blur gaussiano separavel [1,2,1]. */
function unsharp(gray, width, height, amount) {
  const total = width * height;
  const horizontal = new Uint8ClampedArray(total);
  const blurred = new Uint8ClampedArray(total);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const left = x > 0 ? gray[index - 1] : gray[index];
      const right = x < width - 1 ? gray[index + 1] : gray[index];
      horizontal[index] = (left + gray[index] * 2 + right) / 4;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const up = y > 0 ? horizontal[index - width] : horizontal[index];
      const down =
        y < height - 1 ? horizontal[index + width] : horizontal[index];
      blurred[index] = (up + horizontal[index] * 2 + down) / 4;
    }
  }

  for (let i = 0; i < total; i += 1) {
    gray[i] = clamp(gray[i] + amount * (gray[i] - blurred[i]), 0, 255);
  }
}

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                 */
/* -------------------------------------------------------------------------- */

function percentile(histogram, total, fraction) {
  const target = Math.max(0, total * fraction);
  let seen = 0;

  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }

  return 255;
}

function normalizeRotation(value) {
  const degrees = Number(value) || 0;
  return ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
}

function makeCanvas(width, height, offscreen = false) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  if (offscreen && typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(w, h);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export const PREPROCESS_DEFAULTS = DEFAULTS;
