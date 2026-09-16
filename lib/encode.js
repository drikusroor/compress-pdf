// Canvas -> encoded image bytes.
//
// JPEG goes through a WebAssembly build of MozJPEG (better ratios than the
// browser encoder at the same visual quality); PNG and WebP use the browser's
// own encoders. Everything falls back to canvas.toBlob if WASM is unavailable.

const MOZJPEG_URL = new URL('../vendor/mozjpeg/encode.js', import.meta.url).href;

// MozJpegColorSpace, from the jSquash/Squoosh codec bindings.
const MOZJPEG_GRAYSCALE = 1;
const MOZJPEG_YCBCR = 3;

export const FORMATS = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG', lossy: true },
  png: { mime: 'image/png', extension: 'png', label: 'PNG', lossy: false },
  webp: { mime: 'image/webp', extension: 'webp', label: 'WebP', lossy: true },
};

let mozjpegPromise = null;

function loadMozjpeg() {
  if (!mozjpegPromise) {
    mozjpegPromise = import(MOZJPEG_URL)
      .then((mod) => mod.default)
      .catch((err) => {
        console.warn('MozJPEG WASM encoder unavailable, falling back to the canvas encoder:', err);
        return null;
      });
  }
  return mozjpegPromise;
}

function context2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Desaturate a canvas in place. */
export function applyGrayscale(canvas) {
  const ctx = context2d(canvas);
  ctx.save();
  ctx.filter = 'grayscale(1)';
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

async function encodeWithCanvas(canvas, spec, quality) {
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, spec.mime, spec.lossy ? quality / 100 : undefined);
  });
  if (!blob) return null;
  return { blob, mime: blob.type || spec.mime };
}

/**
 * Encode a canvas.
 *
 * Returns `{ bytes, mime, extension, grayscale }`, where `grayscale` reports
 * whether the encoder actually produced a single-channel image — the PDF
 * writer needs to know, because a /DeviceGray image dictionary must not wrap a
 * three-channel JPEG.
 */
export async function encodeCanvas(canvas, { format = 'jpeg', quality = 75, grayscale = false } = {}) {
  const spec = FORMATS[format] || FORMATS.jpeg;

  if (grayscale) applyGrayscale(canvas);

  if (spec === FORMATS.jpeg) {
    const encode = await loadMozjpeg();
    if (encode) {
      try {
        const ctx = context2d(canvas);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const buffer = await encode(imageData, {
          quality,
          color_space: grayscale ? MOZJPEG_GRAYSCALE : MOZJPEG_YCBCR,
        });
        return {
          bytes: new Uint8Array(buffer),
          mime: spec.mime,
          extension: spec.extension,
          grayscale,
        };
      } catch (err) {
        console.warn('MozJPEG encode failed, falling back to the canvas encoder:', err);
      }
    }
  }

  const encoded = await encodeWithCanvas(canvas, spec, quality);
  if (!encoded) return null;
  const actual = Object.values(FORMATS).find((f) => f.mime === encoded.mime) || spec;
  return {
    bytes: new Uint8Array(await encoded.blob.arrayBuffer()),
    mime: encoded.mime,
    extension: actual.extension,
    // The canvas JPEG encoder always writes three channels, even from grey
    // pixels; PNG/WebP likewise. Only MozJPEG can promise a grey file.
    grayscale: false,
  };
}

/** Does this browser's canvas actually encode the given format? */
export async function isFormatSupported(format) {
  const spec = FORMATS[format];
  if (!spec) return false;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const encoded = await encodeWithCanvas(canvas, spec, 80);
  return !!encoded && encoded.mime === spec.mime;
}
