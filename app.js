// UI wiring. All of the actual work lives in ./lib.

import { compressPdfImages } from './lib/pdf-images.js';
import { renderPdfToImages } from './lib/pdf-render.js';
import { FORMATS, isFormatSupported } from './lib/encode.js';
import { createZip } from './lib/zip.js';
import { CancelledError, formatBytes } from './lib/util.js';

const $ = (id) => document.getElementById(id);

const fileInput = $('file-input');
const dropZone = $('drop-zone');
const optionsPanel = $('options');
const resultPanel = $('result');
const imagesPanel = $('images');
const errorPanel = $('error');
const errorText = $('error-text');

const fileNameEl = $('file-name');
const fileSizeEl = $('file-size');

const tabCompress = $('tab-compress');
const tabConvert = $('tab-convert');
const panelCompress = $('panel-compress');
const panelConvert = $('panel-convert');

const qualityInput = $('quality');
const qualityValue = $('quality-value');
const maxDimInput = $('max-dim');
const maxDimValue = $('max-dim-value');
const grayscaleInput = $('grayscale');
const compressBtn = $('compress-btn');

const convertFormat = $('convert-format');
const convertDpi = $('convert-dpi');
const convertQuality = $('convert-quality');
const convertQualityValue = $('convert-quality-value');
const convertQualityControl = $('convert-quality-control');
const convertMaxWidth = $('convert-max-width');
const convertMaxHeight = $('convert-max-height');
const convertPages = $('convert-pages');
const convertGrayscale = $('convert-grayscale');
const convertBtn = $('convert-btn');

const progressEl = $('progress');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const cancelBtn = $('cancel-btn');

const statOriginal = $('stat-original');
const statCompressed = $('stat-compressed');
const statSavings = $('stat-savings');
const downloadLink = $('download-link');
const resultNote = $('result-note');
const resultDetails = $('result-details');
const resultDetailsBody = $('result-details-body');

const imagesSummary = $('images-summary');
const imagesGrid = $('images-grid');
const downloadZipBtn = $('download-zip');

let currentFile = null;
let cancelled = false;
let busy = false;
let renderedPages = [];
const objectUrls = new Set();

// ---------- small UI helpers ----------

function trackUrl(url) {
  objectUrls.add(url);
  return url;
}

function releaseUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

function showPanel(panel) {
  for (const p of [dropZone, optionsPanel, resultPanel, imagesPanel, errorPanel]) {
    p.classList.toggle('hidden', p !== panel);
  }
}

function showError(message) {
  errorText.textContent = message;
  showPanel(errorPanel);
}

function setProgress(fraction, text) {
  progressEl.classList.remove('hidden');
  progressFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  progressText.textContent = text;
}

function resetProgress() {
  progressEl.classList.add('hidden');
  progressFill.style.width = '0%';
}

function setBusy(value) {
  busy = value;
  compressBtn.disabled = value;
  convertBtn.disabled = value;
}

// ---------- file selection ----------

function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showError('That does not look like a PDF file. Please choose a .pdf file.');
    return;
  }
  currentFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  setBusy(false);
  resetProgress();
  showPanel(optionsPanel);
}

fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
dropZone.addEventListener('click', () => fileInput.click());

for (const evt of ['dragenter', 'dragover']) {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drop-zone--active');
  });
}
for (const evt of ['dragleave', 'drop']) {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drop-zone--active');
  });
}
dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files && e.dataTransfer.files[0]));

function startOver() {
  currentFile = null;
  fileInput.value = '';
  renderedPages = [];
  releaseUrls();
  resetProgress();
  showPanel(dropZone);
}

$('change-file').addEventListener('click', startOver);
$('start-over').addEventListener('click', startOver);
$('images-start-over').addEventListener('click', startOver);
$('error-dismiss').addEventListener('click', () => showPanel(currentFile ? optionsPanel : dropZone));

cancelBtn.addEventListener('click', () => {
  cancelled = true;
  progressText.textContent = 'Cancelling…';
});

// ---------- tabs ----------

function selectTab(which) {
  const compress = which === 'compress';
  tabCompress.classList.toggle('tab--active', compress);
  tabConvert.classList.toggle('tab--active', !compress);
  tabCompress.setAttribute('aria-selected', String(compress));
  tabConvert.setAttribute('aria-selected', String(!compress));
  panelCompress.classList.toggle('hidden', !compress);
  panelConvert.classList.toggle('hidden', compress);
}

tabCompress.addEventListener('click', () => !busy && selectTab('compress'));
tabConvert.addEventListener('click', () => !busy && selectTab('convert'));

// ---------- option displays ----------

qualityInput.addEventListener('input', () => {
  qualityValue.textContent = `${qualityInput.value}%`;
});

maxDimInput.addEventListener('input', () => {
  const value = Number(maxDimInput.value);
  maxDimValue.textContent = value >= Number(maxDimInput.max) ? 'No limit' : `${value} px`;
});

convertQuality.addEventListener('input', () => {
  convertQualityValue.textContent = `${convertQuality.value}%`;
});

function syncFormatControls() {
  const spec = FORMATS[convertFormat.value] || FORMATS.jpeg;
  convertQualityControl.classList.toggle('control--disabled', !spec.lossy);
  convertQuality.disabled = !spec.lossy;
}

convertFormat.addEventListener('change', syncFormatControls);
syncFormatControls();

isFormatSupported('webp').then((supported) => {
  if (supported) return;
  const option = convertFormat.querySelector('option[value="webp"]');
  if (option) {
    option.disabled = true;
    option.textContent = 'WebP (not supported by this browser)';
  }
});

// ---------- compress ----------

function describeStats(stats) {
  const lines = [];
  lines.push(
    `<p>Images in this PDF: <strong>${stats.total}</strong> — ` +
      `${stats.compressed} recompressed, ${stats.skipped} left as-is, ${stats.failed} could not be decoded.</p>`,
  );
  lines.push(
    `<p>Image data: <strong>${formatBytes(stats.bytesBefore)}</strong> → ` +
      `<strong>${formatBytes(stats.bytesAfter)}</strong>` +
      `${stats.downscaled ? `, with ${stats.downscaled} downscaled to fit the resolution limit` : ''}.</p>`,
  );

  if (stats.kinds.size) {
    const rows = [...stats.kinds.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(
        ([kind, info]) =>
          `<tr><td>${escapeHtml(kind)}</td><td>${info.count}</td><td>${formatBytes(info.bytes)}</td></tr>`,
      )
      .join('');
    lines.push(
      `<table class="detail-table"><thead><tr><th>Filter · colour space</th><th>Count</th><th>Original size</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  }

  if (stats.reasons.size) {
    const rows = [...stats.reasons.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([reason, info]) => `<tr><td>${escapeHtml(reason)}</td><td>${info.count}</td></tr>`)
      .join('');
    lines.push(
      `<table class="detail-table"><thead><tr><th>Left unchanged because</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  }

  return lines.join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function summarise(stats, originalSize, compressedSize) {
  if (stats.total === 0) {
    return 'No embedded images were found in this PDF, so there was nothing to recompress. ' +
      'Text, fonts and vector graphics are already compressed and are left untouched.';
  }

  const parts = [];
  if (stats.compressed === 0) {
    parts.push(`Found ${stats.total} image(s), but none could be made smaller.`);
  } else {
    parts.push(`Recompressed ${stats.compressed} of ${stats.total} image(s).`);
  }

  const imageShare = originalSize > 0 ? (stats.bytesBefore / originalSize) * 100 : 0;
  if (stats.total > 0 && imageShare < 50) {
    parts.push(
      `Images only account for ${imageShare.toFixed(0)}% of this file ` +
        `(${formatBytes(stats.bytesBefore)} of ${formatBytes(originalSize)}) — the rest is text, ` +
        'fonts, vector art or metadata, which this tool never touches.',
    );
  } else if (compressedSize >= originalSize) {
    parts.push('The result is not smaller, so the original is probably already well optimised.');
  }

  return parts.join(' ');
}

compressBtn.addEventListener('click', async () => {
  if (!currentFile || busy) return;
  cancelled = false;
  setBusy(true);
  setProgress(0.02, 'Reading file…');

  try {
    const originalBytes = new Uint8Array(await currentFile.arrayBuffer());
    const { bytes: outBytes, stats } = await compressPdfImages(
      originalBytes,
      {
        quality: Number(qualityInput.value),
        maxDim: Number(maxDimInput.value) >= Number(maxDimInput.max) ? Infinity : Number(maxDimInput.value),
        grayscale: grayscaleInput.checked,
      },
      (fraction, text) => setProgress(0.05 + fraction * 0.9, text),
      () => cancelled,
    );

    setProgress(1, 'Done!');

    const originalSize = originalBytes.length;
    const compressedSize = outBytes.length;
    const saved = originalSize - compressedSize;
    const savedPct = originalSize > 0 ? (saved / originalSize) * 100 : 0;

    statOriginal.textContent = formatBytes(originalSize);
    statCompressed.textContent = formatBytes(Math.max(compressedSize, 0));
    statSavings.textContent = saved > 0 ? `${formatBytes(saved)} (${savedPct.toFixed(0)}%)` : 'None';

    releaseUrls();
    downloadLink.href = trackUrl(URL.createObjectURL(new Blob([outBytes], { type: 'application/pdf' })));
    downloadLink.download = `${currentFile.name.replace(/\.pdf$/i, '')}-compressed.pdf`;

    resultNote.textContent = summarise(stats, originalSize, compressedSize);
    resultNote.classList.remove('hidden');
    resultDetailsBody.innerHTML = describeStats(stats);
    resultDetails.classList.toggle('hidden', stats.total === 0);
    resultDetails.open = false;

    resetProgress();
    showPanel(resultPanel);
  } catch (err) {
    resetProgress();
    if (err instanceof CancelledError) {
      showPanel(optionsPanel);
    } else {
      console.error(err);
      showError(`Something went wrong while compressing this PDF: ${err.message || err}`);
    }
  } finally {
    setBusy(false);
  }
});

// ---------- convert ----------

function addPageCard(page) {
  const card = document.createElement('figure');
  card.className = 'image-card';
  const link = document.createElement('a');
  link.href = trackUrl(page.url);
  link.download = page.name;
  const img = document.createElement('img');
  img.src = page.url;
  img.alt = `Page ${page.pageNumber}`;
  img.loading = 'lazy';
  link.appendChild(img);
  const caption = document.createElement('figcaption');
  caption.innerHTML =
    `<span class="image-card__name">${escapeHtml(page.name)}</span>` +
    `<span class="image-card__meta">${page.width}×${page.height} · ${formatBytes(page.bytes.length)}</span>`;
  card.append(link, caption);
  imagesGrid.appendChild(card);
}

convertBtn.addEventListener('click', async () => {
  if (!currentFile || busy) return;
  cancelled = false;
  setBusy(true);
  setProgress(0.02, 'Reading file…');
  releaseUrls();
  renderedPages = [];
  imagesGrid.innerHTML = '';

  const baseName = currentFile.name.replace(/\.pdf$/i, '') || 'page';

  try {
    const pdfBytes = new Uint8Array(await currentFile.arrayBuffer());
    const pages = await renderPdfToImages(
      pdfBytes,
      {
        dpi: Number(convertDpi.value),
        maxWidth: Number(convertMaxWidth.value) || 0,
        maxHeight: Number(convertMaxHeight.value) || 0,
        format: convertFormat.value,
        quality: Number(convertQuality.value),
        grayscale: convertGrayscale.checked,
        pageRange: convertPages.value,
        baseName,
      },
      (fraction, text) => setProgress(0.05 + fraction * 0.9, text),
      (page) => addPageCard(page),
      () => cancelled,
    );

    renderedPages = pages;
    const totalBytes = pages.reduce((sum, page) => sum + page.bytes.length, 0);
    imagesSummary.textContent =
      `${pages.length} image(s), ${formatBytes(totalBytes)} in total. ` +
      'Click any page to save it on its own.';
    downloadZipBtn.disabled = pages.length === 0;

    resetProgress();
    showPanel(imagesPanel);
  } catch (err) {
    resetProgress();
    if (err instanceof CancelledError) {
      if (renderedPages.length === 0) imagesGrid.innerHTML = '';
      showPanel(optionsPanel);
    } else {
      console.error(err);
      showError(`Something went wrong while converting this PDF: ${err.message || err}`);
    }
  } finally {
    setBusy(false);
  }
});

downloadZipBtn.addEventListener('click', () => {
  if (!renderedPages.length) return;
  const zip = createZip(renderedPages.map((page) => ({ name: page.name, data: page.bytes })));
  const link = document.createElement('a');
  link.href = trackUrl(URL.createObjectURL(zip));
  link.download = `${(currentFile?.name || 'pages').replace(/\.pdf$/i, '')}-images.zip`;
  link.click();
});

window.addEventListener('beforeunload', releaseUrls);
