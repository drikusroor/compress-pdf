(() => {
  'use strict';

  const {
    PDFDocument,
    PDFName,
    PDFArray,
    PDFRawStream,
    PDFStream,
  } = PDFLib;

  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const optionsPanel = document.getElementById('options');
  const resultPanel = document.getElementById('result');
  const errorPanel = document.getElementById('error');
  const errorText = document.getElementById('error-text');
  const errorDismiss = document.getElementById('error-dismiss');

  const fileNameEl = document.getElementById('file-name');
  const fileSizeEl = document.getElementById('file-size');
  const changeFileBtn = document.getElementById('change-file');

  const qualityInput = document.getElementById('quality');
  const qualityValue = document.getElementById('quality-value');
  const maxDimInput = document.getElementById('max-dim');
  const maxDimValue = document.getElementById('max-dim-value');
  const grayscaleInput = document.getElementById('grayscale');

  const compressBtn = document.getElementById('compress-btn');
  const progressEl = document.getElementById('progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  const statOriginal = document.getElementById('stat-original');
  const statCompressed = document.getElementById('stat-compressed');
  const statSavings = document.getElementById('stat-savings');
  const downloadLink = document.getElementById('download-link');
  const startOverBtn = document.getElementById('start-over');
  const resultNote = document.getElementById('result-note');

  let currentFile = null;

  // ---------- UI helpers ----------

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function showPanel(panel) {
    [dropZone, optionsPanel, resultPanel, errorPanel].forEach((p) => p.classList.add('hidden'));
    panel.classList.remove('hidden');
  }

  function showError(message) {
    errorText.textContent = message;
    showPanel(errorPanel);
  }

  function setProgress(fraction, text) {
    progressEl.classList.remove('hidden');
    progressFill.style.width = `${Math.round(fraction * 100)}%`;
    progressText.textContent = text;
  }

  function resetProgress() {
    progressEl.classList.add('hidden');
    progressFill.style.width = '0%';
  }

  function yieldToUI() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  // ---------- File selection ----------

  function handleFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showError('That does not look like a PDF file. Please choose a .pdf file.');
      return;
    }
    currentFile = file;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatBytes(file.size);
    compressBtn.disabled = false;
    resetProgress();
    showPanel(optionsPanel);
  }

  fileInput.addEventListener('change', (e) => {
    handleFile(e.target.files[0]);
  });

  dropZone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drop-zone--active');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drop-zone--active');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  changeFileBtn.addEventListener('click', () => {
    currentFile = null;
    fileInput.value = '';
    showPanel(dropZone);
  });

  startOverBtn.addEventListener('click', () => {
    currentFile = null;
    fileInput.value = '';
    resetProgress();
    showPanel(dropZone);
  });

  errorDismiss.addEventListener('click', () => {
    showPanel(currentFile ? optionsPanel : dropZone);
  });

  // ---------- Option displays ----------

  qualityInput.addEventListener('input', () => {
    qualityValue.textContent = `${qualityInput.value}%`;
  });

  function formatMaxDim(value) {
    return Number(value) >= Number(maxDimInput.max) ? 'No limit' : `${value} px`;
  }

  maxDimInput.addEventListener('input', () => {
    maxDimValue.textContent = formatMaxDim(maxDimInput.value);
  });

  // ---------- JPEG encoding (MozJPEG via WebAssembly, falling back to the
  // browser's built-in canvas encoder if anything goes wrong loading it) ----------

  let mozjpegEncodePromise = null;

  function loadMozjpegEncoder() {
    if (!mozjpegEncodePromise) {
      mozjpegEncodePromise = import('./vendor/mozjpeg/encode.js')
        .then((mod) => mod.default)
        .catch((err) => {
          console.warn('MozJPEG WASM encoder unavailable, falling back to canvas JPEG encoder:', err);
          return null;
        });
    }
    return mozjpegEncodePromise;
  }

  async function encodeJpeg(canvas, ctx, quality) {
    const mozjpegEncode = await loadMozjpegEncoder();
    if (mozjpegEncode) {
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const buffer = await mozjpegEncode(imageData, { quality });
        return new Uint8Array(buffer);
      } catch (err) {
        console.warn('MozJPEG encode failed, falling back to canvas JPEG encoder:', err);
      }
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality / 100));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---------- Image extraction / recompression ----------

  const SUPPORTED_COLOR_SPACES = new Set(['DeviceRGB', 'DeviceGray', 'CalRGB', 'CalGray']);

  function resolveColorSpaceName(dict) {
    let cs = dict.lookup(PDFName.of('ColorSpace'));
    if (cs instanceof PDFArray) {
      // e.g. ICCBased streams or Indexed color spaces are not handled.
      const first = cs.get(0);
      if (first instanceof PDFName) return first.decodeText();
      return null;
    }
    if (cs instanceof PDFName) return cs.decodeText();
    return null;
  }

  function getSingleFilterName(dict) {
    const filter = dict.get(PDFName.of('Filter'));
    if (filter instanceof PDFName) return filter.decodeText();
    if (filter instanceof PDFArray) {
      if (filter.size() !== 1) return null;
      const only = filter.get(0);
      return only instanceof PDFName ? only.decodeText() : null;
    }
    return null;
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream unsupported');
    }
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function decodeImageObject(dict, contents) {
    const filterName = getSingleFilterName(dict);
    const width = dict.lookup(PDFName.of('Width'))?.asNumber();
    const height = dict.lookup(PDFName.of('Height'))?.asNumber();
    if (!width || !height) return null;

    if (filterName === 'DCTDecode') {
      const blob = new Blob([contents], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      return bitmap;
    }

    if (filterName === 'FlateDecode') {
      const bpc = dict.lookup(PDFName.of('BitsPerComponent'))?.asNumber();
      const csName = resolveColorSpaceName(dict);
      if (bpc !== 8 || !SUPPORTED_COLOR_SPACES.has(csName)) return null;

      const raw = await inflate(contents);
      const channels = csName === 'DeviceGray' || csName === 'CalGray' ? 1 : 3;
      const expectedLength = width * height * channels;
      if (raw.length < expectedLength) return null;

      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0, p = 0; i < expectedLength; i += channels, p += 4) {
        if (channels === 1) {
          rgba[p] = rgba[p + 1] = rgba[p + 2] = raw[i];
        } else {
          rgba[p] = raw[i];
          rgba[p + 1] = raw[i + 1];
          rgba[p + 2] = raw[i + 2];
        }
        rgba[p + 3] = 255;
      }
      const imageData = new ImageData(rgba, width, height);
      const bitmap = await createImageBitmap(imageData);
      return bitmap;
    }

    return null;
  }

  function isSkippable(dict) {
    const imageMask = dict.lookup(PDFName.of('ImageMask'));
    if (imageMask && imageMask.asBoolean?.()) return true;
    if (dict.get(PDFName.of('SMask'))) return true;
    if (dict.get(PDFName.of('Mask'))) return true;
    if (dict.get(PDFName.of('Decode'))) return true;
    return false;
  }

  async function recompressImage(bitmap, options) {
    const { maxDim, quality, grayscale } = options;
    let { width, height } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (grayscale) ctx.filter = 'grayscale(1)';
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const bytes = await encodeJpeg(canvas, ctx, quality);
    if (!bytes) return null;
    return { bytes, width: targetW, height: targetH };
  }

  async function compressPdfImages(pdfBytes, options, onProgress) {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const context = pdfDoc.context;
    const entries = context.enumerateIndirectObjects();

    const imageEntries = entries.filter(([, obj]) => {
      if (!(obj instanceof PDFStream)) return false;
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      return subtype instanceof PDFName && subtype.decodeText() === 'Image';
    });

    let processed = 0;
    let replaced = 0;

    for (const [ref, obj] of imageEntries) {
      processed += 1;
      onProgress(processed / Math.max(1, imageEntries.length), `Compressing image ${processed} of ${imageEntries.length}…`);

      try {
        const dict = obj.dict;
        if (isSkippable(dict)) continue;

        const contents = obj.getContents ? obj.getContents() : null;
        if (!contents) continue;

        const bitmap = await decodeImageObject(dict, contents);
        if (!bitmap) continue;

        const result = await recompressImage(bitmap, options);
        bitmap.close?.();
        if (!result) continue;

        if (result.bytes.length >= contents.length) continue;

        const newDict = context.obj({
          Type: 'XObject',
          Subtype: 'Image',
          Width: result.width,
          Height: result.height,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'DCTDecode',
        });
        const newStream = PDFRawStream.of(newDict, result.bytes);
        context.assign(ref, newStream);
        replaced += 1;
      } catch (err) {
        console.warn('Skipping image due to error:', err);
      }

      if (processed % 3 === 0) await yieldToUI();
    }

    onProgress(0.98, 'Saving PDF…');
    const outBytes = await pdfDoc.save({ useObjectStreams: true });
    return { bytes: outBytes, imagesFound: imageEntries.length, imagesReplaced: replaced };
  }

  // ---------- Main compress flow ----------

  compressBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    compressBtn.disabled = true;
    setProgress(0.02, 'Reading file…');

    try {
      const originalBytes = new Uint8Array(await currentFile.arrayBuffer());
      const options = {
        quality: Number(qualityInput.value),
        maxDim: Number(maxDimInput.value),
        grayscale: grayscaleInput.checked,
      };

      const { bytes: outBytes, imagesFound, imagesReplaced } = await compressPdfImages(
        originalBytes,
        options,
        (fraction, text) => setProgress(0.05 + fraction * 0.9, text)
      );

      setProgress(1, 'Done!');

      const originalSize = originalBytes.length;
      const compressedSize = outBytes.length;
      const saved = originalSize - compressedSize;
      const savedPct = originalSize > 0 ? (saved / originalSize) * 100 : 0;

      statOriginal.textContent = formatBytes(originalSize);
      statCompressed.textContent = formatBytes(Math.max(compressedSize, 0));
      statSavings.textContent = saved > 0 ? `${formatBytes(saved)} (${savedPct.toFixed(0)}%)` : 'None';

      const blob = new Blob([outBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const baseName = currentFile.name.replace(/\.pdf$/i, '');
      downloadLink.href = url;
      downloadLink.download = `${baseName}-compressed.pdf`;

      resultNote.classList.add('hidden');
      if (imagesFound === 0) {
        resultNote.textContent = 'No embedded images were found in this PDF — nothing to compress.';
        resultNote.classList.remove('hidden');
      } else if (imagesReplaced === 0) {
        resultNote.textContent = `Found ${imagesFound} image(s), but none could be compressed further (unsupported format or already optimal).`;
        resultNote.classList.remove('hidden');
      } else if (imagesReplaced < imagesFound) {
        resultNote.textContent = `Compressed ${imagesReplaced} of ${imagesFound} image(s); the rest were left unchanged (unsupported format).`;
        resultNote.classList.remove('hidden');
      }

      resetProgress();
      showPanel(resultPanel);
    } catch (err) {
      console.error(err);
      resetProgress();
      showError(`Something went wrong while compressing this PDF: ${err.message || err}`);
    } finally {
      compressBtn.disabled = false;
    }
  });
})();
