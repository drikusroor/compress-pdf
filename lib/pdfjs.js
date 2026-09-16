// Lazy loader for the vendored PDF.js build.
//
// PDF.js is what gives this app its wide format coverage: its worker knows how
// to decode every image filter the PDF spec defines (JPEG, JPEG 2000, JBIG2,
// CCITT fax, LZW, run-length, flate with predictors) and every colour space
// (indexed, CMYK, ICC-based, Lab, Separation, DeviceN), which the browser's own
// image codecs do not.

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;

export const PDFJS_ASSETS = {
  wasmUrl: `${BASE}wasm/`,
  iccUrl: `${BASE}iccs/`,
  standardFontDataUrl: `${BASE}standard_fonts/`,
  cMapUrl: `${BASE}cmaps/`,
  cMapPacked: true,
};

let pdfjsPromise = null;

export function loadPdfjs() {
  if (!pdfjsPromise) {
    // Upstream ships these as .mjs; they are renamed to .js here so that every
    // static host serves them with a JavaScript MIME type.
    pdfjsPromise = import(`${BASE}pdf.min.js`)
      .then((mod) => {
        const lib = mod && typeof mod.getDocument === 'function' ? mod : mod.default;
        lib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.js`;
        return lib;
      })
      .catch((err) => {
        pdfjsPromise = null;
        console.error('Failed to load PDF.js:', err);
        throw new Error(
          'Could not load the PDF rendering engine. Reload the page, or check that ' +
            'vendor/pdfjs/ is being served correctly.',
        );
      });
  }
  return pdfjsPromise;
}

/**
 * One worker shared by every document we open during a single run — spinning up
 * a worker per document is slow when a PDF holds hundreds of images.
 */
export async function createWorker() {
  const pdfjs = await loadPdfjs();
  return new pdfjs.PDFWorker({ name: `compress-pdf-${Date.now()}` });
}

/**
 * Open a document and return it alongside its teardown function — tearing a
 * document down goes through the loading task, not the document itself.
 *
 * PDF.js transfers the byte array to its worker, which detaches it. Callers
 * nearly always still need their copy, so clone by default.
 */
export async function openPdf(bytes, { worker = null, clone = true, ...rest } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: clone ? bytes.slice() : bytes,
    ...PDFJS_ASSETS,
    ...(worker ? { worker } : {}),
    isEvalSupported: false,
    ...rest,
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}
