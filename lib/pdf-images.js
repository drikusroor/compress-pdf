// Recompress the images embedded in a PDF, in the browser.
//
// Decoding strategy, in order of preference:
//
//   1. Plain baseline/progressive JPEG in a grey or RGB colour space goes
//      straight to `createImageBitmap` — the fastest path, and the common case.
//   2. Everything else is handed to PDF.js. We wrap the single image XObject in
//      a throwaway one-page PDF and render that page to a canvas, which makes
//      PDF.js do all the hard work: JPEG 2000, JBIG2, CCITT fax, LZW,
//      run-length, flate-with-predictors, indexed palettes, CMYK, ICC-based,
//      Lab, Separation and DeviceN colour, /Decode arrays, odd bit depths.
//
// Whatever comes back is a plain RGB canvas, which we re-encode as a JPEG
// (`DCTDecode` — the only widely supported lossy filter the PDF spec defines)
// and write back into the object graph.

import { openPdf, createWorker } from './pdfjs.js';
import { encodeCanvas } from './encode.js';
import { yieldToUI, clampToPixelBudget, CancelledError } from './util.js';

const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFRawStream, PDFStream, PDFBool } =
  window.PDFLib;

// Below this, re-encoding is a waste of time and usually makes things bigger.
const MIN_STREAM_BYTES = 1024;
const MIN_PIXELS = 32 * 32;

// PDF user space maxes out at 14400 units; keep the scratch page inside that.
const MAX_PAGE_UNITS = 14000;

// Soft masks turn into visible halos long before photos do, so never push them
// as hard as the user's quality setting allows.
const MIN_MASK_QUALITY = 60;

const K = {
  Width: PDFName.of('Width'),
  Height: PDFName.of('Height'),
  Subtype: PDFName.of('Subtype'),
  Filter: PDFName.of('Filter'),
  ColorSpace: PDFName.of('ColorSpace'),
  BitsPerComponent: PDFName.of('BitsPerComponent'),
  ImageMask: PDFName.of('ImageMask'),
  SMask: PDFName.of('SMask'),
  Mask: PDFName.of('Mask'),
  Matte: PDFName.of('Matte'),
  Decode: PDFName.of('Decode'),
  SMaskInData: PDFName.of('SMaskInData'),
  Contents: PDFName.of('Contents'),
};

// Entries that stay meaningful once the pixels have been re-encoded as a plain
// RGB/grey JPEG, so they are carried over to the replacement dictionary.
const CARRY_OVER = ['Interpolate', 'Intent', 'OC', 'StructParent'].map((key) => PDFName.of(key));

const asNumber = (obj) => (obj && typeof obj.asNumber === 'function' ? obj.asNumber() : null);
const asName = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);

function filterNames(dict) {
  const filter = dict.lookup(K.Filter);
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) return filter.asArray().map(asName).filter(Boolean);
  return [];
}

const SIMPLE_COLOR_SPACES = {
  DeviceGray: 1,
  CalGray: 1,
  G: 1,
  DeviceRGB: 3,
  CalRGB: 3,
  RGB: 3,
  Lab: 3,
  DeviceCMYK: 4,
  CMYK: 4,
};

/** `{ name, components }` for an image's colour space; components is null when unknown. */
function describeColorSpace(dict) {
  const cs = dict.lookup(K.ColorSpace);
  if (cs instanceof PDFName) {
    const name = cs.decodeText();
    return { name, components: SIMPLE_COLOR_SPACES[name] ?? null };
  }
  if (cs instanceof PDFArray) {
    const family = asName(cs.lookup(0)) || 'Array';
    if (family === 'ICCBased') {
      const profile = cs.lookup(1);
      const n = profile instanceof PDFStream ? asNumber(profile.dict.lookup(PDFName.of('N'))) : null;
      return { name: `ICCBased/${n ?? '?'}`, components: n };
    }
    if (family === 'Indexed' || family === 'I') return { name: 'Indexed', components: null };
    if (family === 'Separation') return { name: 'Separation', components: null };
    if (family === 'DeviceN') return { name: 'DeviceN', components: null };
    return { name: family, components: SIMPLE_COLOR_SPACES[family] ?? null };
  }
  return { name: cs ? 'Other' : 'None', components: null };
}

function isTrue(obj) {
  return obj instanceof PDFBool ? obj.asBoolean() : false;
}

/** Why we are leaving this image alone, or null if we should try to compress it. */
function skipReason(dict, byteLength, width, height, colorSpace, filters) {
  if (!width || !height) return 'missing width/height';
  if (isTrue(dict.lookup(K.ImageMask))) return 'stencil mask (1-bit)';
  if (dict.lookup(K.Mask) instanceof PDFArray) return 'colour-key masked';
  if (dict.get(K.Matte)) return 'pre-blended soft mask';
  // JPEG 2000 can carry its alpha channel inside the codestream; DCTDecode
  // cannot, so re-encoding would silently throw the transparency away.
  if ((asNumber(dict.lookup(K.SMaskInData)) || 0) > 0) return 'alpha inside a JPEG 2000 stream';
  if (filters.includes('Crypt')) return 'encrypted stream';
  // A bare name that is not a device space only means something relative to a
  // resource dictionary, which an image XObject has no claim on. Renderers
  // disagree about what to do with those, so decoding one is a guess — and a
  // wrong guess would replace real pixels with garbage.
  if (dict.lookup(K.ColorSpace) instanceof PDFName && colorSpace.components === null) {
    return `unrecognised colour space (${colorSpace.name})`;
  }
  // Only JPEG 2000 is allowed to carry its colour space inside the codestream.
  if (colorSpace.name === 'None' && !filters.includes('JPXDecode')) {
    return 'no colour space';
  }
  if (byteLength < MIN_STREAM_BYTES || width * height < MIN_PIXELS) return 'already tiny';
  return null;
}

// ---------- copying an object subgraph into a scratch document ----------

/**
 * Deep-copy a PDF object from one context into another, following indirect
 * references. pdf-lib's own PDFObjectCopier only chases refs that sit directly
 * in a dictionary, so it drops the ones nested inside, say, an
 * `/ColorSpace [/Indexed /DeviceRGB 255 7 0 R]` array — exactly the images we
 * care most about here.
 */
function deepCopy(object, src, dest, seen) {
  if (object instanceof PDFRef) {
    const key = object.tag;
    if (seen.has(key)) return seen.get(key);
    const ref = dest.nextRef();
    seen.set(key, ref);
    const value = src.lookup(object);
    if (value) dest.assign(ref, deepCopy(value, src, dest, seen));
    return ref;
  }
  if (object instanceof PDFStream) {
    const dict = deepCopy(object.dict, src, dest, seen);
    return PDFRawStream.of(dict, object.getContents());
  }
  if (object instanceof PDFDict) {
    const copy = PDFDict.withContext(dest);
    for (const [key, value] of object.entries()) {
      copy.set(key, deepCopy(value, src, dest, seen));
    }
    return copy;
  }
  if (object instanceof PDFArray) {
    const copy = PDFArray.withContext(dest);
    for (const value of object.asArray()) copy.push(deepCopy(value, src, dest, seen));
    return copy;
  }
  // Names, numbers, strings and booleans are immutable values; share them.
  return object;
}

/**
 * Build a one-page PDF whose only content is `stream`, drawn to fill the page.
 * Soft masks are dropped so we get the untouched base image rather than one
 * composited onto white.
 */
async function wrapImageInPdf(stream, srcContext, width, height) {
  const scratch = await PDFDocument.create();
  const dest = scratch.context;

  const copied = deepCopy(stream, srcContext, dest, new Map());
  copied.dict.delete(K.SMask);
  copied.dict.delete(K.Mask);
  const imageRef = dest.register(copied);

  const scale = Math.min(1, MAX_PAGE_UNITS / Math.max(width, height));
  const pageWidth = Math.max(1, width * scale);
  const pageHeight = Math.max(1, height * scale);

  const page = scratch.addPage([pageWidth, pageHeight]);
  page.node.setXObject(PDFName.of('Im0'), imageRef);
  const contents = dest.flateStream(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`);
  page.node.set(K.Contents, dest.register(contents));

  return { bytes: await scratch.save({ useObjectStreams: false }), pageWidth, pageHeight };
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  // Claim the context up front so PDF.js reuses one tuned for getImageData.
  canvas.getContext('2d', { willReadFrequently: true });
  return canvas;
}

async function decodeWithPdfjs(stream, srcContext, width, height, target, worker) {
  const { bytes, pageWidth } = await wrapImageInPdf(stream, srcContext, width, height);
  const { doc, close } = await openPdf(bytes, { worker, clone: false });
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: target.width / pageWidth });
    const canvas = makeCanvas(viewport.width, viewport.height);
    await page.render({ canvas, viewport, background: '#ffffff' }).promise;
    return canvas;
  } finally {
    await close();
  }
}

async function decodeWithBrowser(contents, target) {
  const blob = new Blob([contents], { type: 'image/jpeg' });
  // A PDF viewer ignores EXIF orientation, so the decoder must too.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
  try {
    const canvas = makeCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close?.();
  }
}

// ---------- the main pass ----------

function bump(map, key, bytes = 0) {
  const entry = map.get(key) || { count: 0, bytes: 0 };
  entry.count += 1;
  entry.bytes += bytes;
  map.set(key, entry);
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {{quality: number, maxDim: number, grayscale: boolean}} options
 * @param {(fraction: number, text: string) => void} onProgress
 * @param {() => boolean} [isCancelled]
 */
export async function compressPdfImages(pdfBytes, options, onProgress, isCancelled = () => false) {
  const { quality, maxDim, grayscale } = options;

  const pdfDoc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  if (pdfDoc.isEncrypted) {
    throw new Error(
      'This PDF is encrypted (password-protected). Its image data cannot be read, ' +
        'so there is nothing to recompress — remove the protection first.',
    );
  }

  const context = pdfDoc.context;
  const images = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    if (asName(object.dict.get(K.Subtype)) !== 'Image') continue;
    images.push({ ref, stream: object });
  }

  // Images pointed at by /SMask (and by a stencil /Mask) have to stay
  // single-channel, so they need a grey JPEG rather than an RGB one.
  const maskRefs = new Set();
  for (const { stream } of images) {
    for (const key of [K.SMask, K.Mask]) {
      const value = stream.dict.get(key);
      if (value instanceof PDFRef) maskRefs.add(value.tag);
    }
  }

  const stats = {
    total: images.length,
    compressed: 0,
    skipped: 0,
    failed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    downscaled: 0,
    reasons: new Map(),
    kinds: new Map(),
  };

  let worker = null;
  try {
    for (let i = 0; i < images.length; i += 1) {
      if (isCancelled()) throw new CancelledError();
      const { ref, stream } = images[i];
      onProgress(i / Math.max(1, images.length), `Image ${i + 1} of ${images.length}…`);

      const dict = stream.dict;
      let contents;
      try {
        contents = stream.getContents();
      } catch {
        contents = null;
      }
      if (!contents) {
        stats.failed += 1;
        bump(stats.reasons, 'stream could not be read');
        continue;
      }

      stats.bytesBefore += contents.length;
      const width = asNumber(dict.lookup(K.Width));
      const height = asNumber(dict.lookup(K.Height));
      const filters = filterNames(dict);
      const colorSpace = describeColorSpace(dict);
      bump(stats.kinds, `${filters.join(' + ') || 'Uncompressed'} · ${colorSpace.name}`, contents.length);

      const skip = skipReason(dict, contents.length, width, height, colorSpace, filters);
      if (skip) {
        stats.skipped += 1;
        stats.bytesAfter += contents.length;
        bump(stats.reasons, skip);
        continue;
      }

      const isMask = maskRefs.has(ref.tag);
      const wantGray = grayscale || isMask;
      const effectiveQuality = isMask ? Math.max(quality, MIN_MASK_QUALITY) : quality;

      const fit = Math.min(1, maxDim / Math.max(width, height));
      const target = clampToPixelBudget(
        Math.max(1, Math.round(width * fit)),
        Math.max(1, Math.round(height * fit)),
      );

      let canvas = null;
      const plainJpeg =
        filters.length === 1 &&
        filters[0] === 'DCTDecode' &&
        (colorSpace.components === 1 || colorSpace.components === 3) &&
        !dict.get(K.Decode);

      try {
        if (plainJpeg) {
          try {
            canvas = await decodeWithBrowser(contents, target);
          } catch {
            canvas = null; // e.g. an exotic JPEG the browser refuses; PDF.js can cope.
          }
        }
        if (!canvas) {
          if (!worker) worker = await createWorker();
          canvas = await decodeWithPdfjs(stream, context, width, height, target, worker);
        }
      } catch (err) {
        console.warn('Could not decode image', ref.tag, err);
        stats.failed += 1;
        stats.bytesAfter += contents.length;
        bump(stats.reasons, `decode failed (${filters.join(' + ') || 'uncompressed'})`);
        continue;
      }

      const encoded = await encodeCanvas(canvas, {
        format: 'jpeg',
        quality: effectiveQuality,
        grayscale: wantGray,
      });

      if (!encoded) {
        stats.failed += 1;
        stats.bytesAfter += contents.length;
        bump(stats.reasons, 'JPEG encoder unavailable');
        continue;
      }
      if (isMask && !encoded.grayscale) {
        // Writing a 3-channel JPEG under /DeviceGray would corrupt the mask.
        stats.skipped += 1;
        stats.bytesAfter += contents.length;
        bump(stats.reasons, 'no grayscale JPEG encoder for soft mask');
        continue;
      }
      if (encoded.bytes.length >= contents.length) {
        stats.skipped += 1;
        stats.bytesAfter += contents.length;
        bump(stats.reasons, 'recompressing made it bigger');
        continue;
      }

      const replacement = {
        Type: 'XObject',
        Subtype: 'Image',
        Width: canvas.width,
        Height: canvas.height,
        ColorSpace: encoded.grayscale ? 'DeviceGray' : 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
      };
      // The alpha channel and any stencil mask still apply to the new pixels.
      const smask = dict.get(K.SMask);
      if (smask instanceof PDFRef) replacement.SMask = smask;
      const mask = dict.get(K.Mask);
      if (mask instanceof PDFRef) replacement.Mask = mask;
      for (const key of CARRY_OVER) {
        const value = dict.get(key);
        if (value) replacement[key.decodeText()] = value;
      }

      context.assign(ref, PDFRawStream.of(context.obj(replacement), encoded.bytes));
      stats.compressed += 1;
      stats.bytesAfter += encoded.bytes.length;
      if (canvas.width < width) stats.downscaled += 1;

      if (i % 2 === 1) await yieldToUI();
    }
  } finally {
    if (worker) worker.destroy();
  }

  onProgress(0.99, 'Writing the PDF…');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  return { bytes, stats };
}
