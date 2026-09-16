// Render PDF pages to images, in the browser, using the vendored PDF.js build.

import { openPdf, createWorker } from './pdfjs.js';
import { encodeCanvas, FORMATS } from './encode.js';
import {
  CancelledError,
  clampToPixelBudget,
  fitScale,
  padNumber,
  parsePageRange,
  yieldToUI,
} from './util.js';

const POINTS_PER_INCH = 72;

/**
 * @param {Uint8Array} pdfBytes
 * @param {{dpi: number, maxWidth: number, maxHeight: number, format: string,
 *          quality: number, grayscale: boolean, pageRange: string, baseName: string}} options
 * @param {(fraction: number, text: string) => void} onProgress
 * @param {(page: object) => void} onPage called as each page finishes
 * @param {() => boolean} [isCancelled]
 */
export async function renderPdfToImages(pdfBytes, options, onProgress, onPage, isCancelled = () => false) {
  const {
    dpi = 150,
    maxWidth = 0,
    maxHeight = 0,
    format = 'jpeg',
    quality = 85,
    grayscale = false,
    pageRange = '',
    baseName = 'page',
  } = options;

  const spec = FORMATS[format] || FORMATS.jpeg;
  const worker = await createWorker();
  const pages = [];

  try {
    const { doc, close } = await openPdf(pdfBytes, { worker });
    try {
      const numbers = parsePageRange(pageRange, doc.numPages);
      const digits = String(doc.numPages).length;

      for (let i = 0; i < numbers.length; i += 1) {
        if (isCancelled()) throw new CancelledError();
        const pageNumber = numbers[i];
        onProgress(i / numbers.length, `Rendering page ${pageNumber} of ${doc.numPages}…`);

        const page = await doc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        let scale = dpi / POINTS_PER_INCH;
        scale *= fitScale(base.width * scale, base.height * scale, maxWidth, maxHeight);

        const wanted = page.getViewport({ scale });
        const budget = clampToPixelBudget(wanted.width, wanted.height);
        const viewport = page.getViewport({ scale: (scale * budget.width) / wanted.width });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        canvas.getContext('2d', { willReadFrequently: true });

        await page.render({ canvas, viewport, background: '#ffffff' }).promise;
        page.cleanup();

        const encoded = await encodeCanvas(canvas, { format, quality, grayscale });
        if (!encoded) throw new Error(`The browser could not encode a ${spec.label} image.`);

        const result = {
          pageNumber,
          name: `${baseName}-${padNumber(pageNumber, digits)}.${encoded.extension}`,
          bytes: encoded.bytes,
          mime: encoded.mime,
          width: canvas.width,
          height: canvas.height,
          url: URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mime })),
        };
        pages.push(result);
        onPage(result, i + 1, numbers.length);

        // Let the canvas be reclaimed before the next (possibly huge) page.
        canvas.width = 0;
        canvas.height = 0;
        await yieldToUI();
      }
    } finally {
      await close();
    }
  } finally {
    worker.destroy();
  }

  onProgress(1, 'Done');
  return pages;
}
