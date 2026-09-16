// UI wiring. All of the actual work lives in ./lib.

import { analysePdf } from './lib/pdf-analyse.js';
import { compressPdfImages } from './lib/pdf-images.js';
import { renderPdfToImages } from './lib/pdf-render.js';
import { FORMATS, isFormatSupported } from './lib/encode.js';
import { createZip } from './lib/zip.js';
import { CancelledError, formatBytes, plural, yieldToUI } from './lib/util.js';

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

const inspectPanel = $('inspect');
const tabs = [
  { id: 'compress', tab: $('tab-compress'), panel: $('panel-compress') },
  { id: 'convert', tab: $('tab-convert'), panel: $('panel-convert') },
  { id: 'inspect', tab: $('tab-inspect'), panel: $('panel-inspect') },
];

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

const inspectBtn = $('inspect-btn');
const inspectFacts = $('inspect-facts');
const inspectBar = $('inspect-bar');
const inspectRows = $('inspect-rows');
const inspectTooltip = $('inspect-tooltip');
const inspectAdvice = $('inspect-advice');

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
  for (const p of [dropZone, optionsPanel, resultPanel, imagesPanel, inspectPanel, errorPanel]) {
    p.classList.toggle('hidden', p !== panel);
  }
}

function showError(message) {
  errorText.textContent = message;
  showPanel(errorPanel);
}

function setProgress(fraction, text, cancellable = true) {
  progressEl.classList.remove('hidden');
  cancelBtn.classList.toggle('hidden', !cancellable);
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
  inspectBtn.disabled = value;
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
$('inspect-start-over').addEventListener('click', startOver);
$('inspect-compress').addEventListener('click', () => {
  selectTab('compress');
  showPanel(optionsPanel);
});
$('error-dismiss').addEventListener('click', () => showPanel(currentFile ? optionsPanel : dropZone));

cancelBtn.addEventListener('click', () => {
  cancelled = true;
  progressText.textContent = 'Cancelling…';
});

// ---------- tabs ----------

function selectTab(which) {
  for (const entry of tabs) {
    const active = entry.id === which;
    entry.tab.classList.toggle('tab--active', active);
    entry.tab.setAttribute('aria-selected', String(active));
    entry.panel.classList.toggle('hidden', !active);
  }
}

for (const entry of tabs) {
  entry.tab.addEventListener('click', () => !busy && selectTab(entry.id));
}

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
    parts.push(`Found ${plural(stats.total, 'image')}, but none could be made smaller.`);
  } else {
    parts.push(`Recompressed ${stats.compressed} of ${plural(stats.total, 'image')}.`);
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
      `${plural(pages.length, 'image')}, ${formatBytes(totalBytes)} in total. ` +
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

// ---------- analyse ----------

// Eight categorical slots, assigned in fixed order by size and never cycled;
// anything past the seventh folds into a single "Other" segment.
const MAX_SEGMENTS = 8;

const ADVICE = {
  images:
    'Images are the bulk of this file, so recompressing them is exactly the right lever — ' +
    'head to the Compress tab. Lowering the resolution limit usually saves more than ' +
    'lowering quality.',
  fonts:
    'Most of the weight is <strong>embedded font programs</strong>. That happens when fonts are ' +
    'embedded in full rather than subset to the characters actually used — a CJK or icon ' +
    'face can be many megabytes on its own. This tool cannot subset fonts; re-exporting ' +
    'from the source application with font subsetting enabled is the fix.',
  content:
    'Most of the weight is <strong>page content</strong>: the vector drawing and text-placement ' +
    'operators that make up the pages. Maps, CAD exports and detailed charts land here. ' +
    'There is no lossy compression for vector data, so nothing this tool does will shrink ' +
    'it — simplifying the artwork at the source, or flattening pages to images, is what ' +
    'moves the needle.',
  unreferenced:
    'Most of the weight is in objects that <strong>nothing in the document refers to any more</strong> — ' +
    'leftovers from incremental saves, where every edit appended a new revision without ' +
    'removing the old one. A plain "Save as" in most PDF tools rewrites the file without them.',
  attachments:
    'Most of the weight is <strong>files attached to the PDF</strong> rather than the document itself. ' +
    'Removing or shrinking the attachments is the only thing that will help.',
  annotations:
    'Most of the weight is in <strong>annotations and form fields</strong> — comments, stamps, signature ' +
    'appearances or an XFA form definition. Flattening the form in a PDF editor usually ' +
    'collapses this.',
  thumbnails:
    'Most of the weight is <strong>pre-rendered page thumbnails</strong>, which every modern viewer ' +
    'regenerates on its own. Most PDF tools drop them on a "Save as".',
  metadata:
    'Most of the weight is <strong>metadata</strong> — usually an oversized XMP packet. Stripping ' +
    'metadata in a PDF editor removes it.',
  colour:
    'Most of the weight is <strong>embedded ICC colour profiles</strong>. They matter for print ' +
    'accuracy; for screen-only use they can be dropped at export time.',
  structureTree:
    'Most of the weight is <strong>tagged-PDF structure</strong> — the reading order and semantics that ' +
    'screen readers rely on. It compresses poorly, and removing it costs accessibility, ' +
    'so this is usually weight worth keeping.',
  structure:
    'Most of the weight is in the document\'s own <strong>structure</strong> rather than any of its content: ' +
    'a very large number of small objects, or cross-reference tables that were never ' +
    'compressed. Saving through a tool that writes object streams typically shrinks this.',
  other:
    'The bulk of this file is in streams that do not fall into any of the usual categories.',
};

function paletteColor(index) {
  return `var(--series-${index + 1})`;
}

/** Top rows keep their own colour; the tail becomes one "Other" segment. */
function toSegments(breakdown) {
  if (breakdown.length <= MAX_SEGMENTS) return breakdown.map((row, i) => ({ ...row, color: paletteColor(i) }));
  const head = breakdown.slice(0, MAX_SEGMENTS - 1).map((row, i) => ({ ...row, color: paletteColor(i) }));
  const tail = breakdown.slice(MAX_SEGMENTS - 1);
  return [
    ...head,
    {
      key: 'folded',
      label: `Other (${tail.map((row) => row.label).join(', ')})`,
      bytes: tail.reduce((sum, row) => sum + row.bytes, 0),
      count: tail.reduce((sum, row) => sum + row.count, 0),
      share: tail.reduce((sum, row) => sum + row.share, 0),
      color: paletteColor(MAX_SEGMENTS - 1),
    },
  ];
}

function highlight(key) {
  const segments = inspectBar.querySelectorAll('.viz__segment');
  const rows = inspectRows.querySelectorAll('tr');
  inspectBar.classList.toggle('is-hovering', key !== null);
  for (const node of [...segments, ...rows]) {
    node.classList.toggle('is-active', key !== null && node.dataset.key === key);
  }
}

function showTooltip(segment, data) {
  inspectTooltip.textContent = `${data.label} — ${formatBytes(data.bytes)} (${formatShare(data.share)})`;
  const barBox = inspectBar.getBoundingClientRect();
  const box = segment.getBoundingClientRect();
  const centre = box.left - barBox.left + box.width / 2;
  inspectTooltip.style.left = `${Math.min(Math.max(centre, 60), barBox.width - 60)}px`;
  inspectTooltip.classList.add('is-visible');
}

function formatShare(share) {
  const percent = share * 100;
  if (percent >= 1) return `${percent.toFixed(0)}%`;
  return percent >= 0.1 ? `${percent.toFixed(1)}%` : '<0.1%';
}

function renderBreakdown(analysis) {
  const segments = toSegments(analysis.breakdown);

  inspectBar.innerHTML = '';
  inspectRows.innerHTML = '';
  inspectTooltip.classList.remove('is-visible');

  for (const data of segments) {
    const segment = document.createElement('div');
    segment.className = 'viz__segment';
    segment.dataset.key = data.key;
    segment.style.setProperty('--segment-color', data.color);
    segment.style.flexGrow = String(Math.max(data.share, 0.002));
    segment.style.flexBasis = '0';
    segment.title = `${data.label} — ${formatBytes(data.bytes)} (${formatShare(data.share)})`;
    segment.addEventListener('pointerenter', () => {
      highlight(data.key);
      showTooltip(segment, data);
    });
    inspectBar.appendChild(segment);

    const row = document.createElement('tr');
    row.dataset.key = data.key;
    row.innerHTML =
      `<td><span class="swatch" style="--segment-color: ${data.color}"></span>${escapeHtml(data.label)}</td>` +
      `<td>${data.count.toLocaleString()}</td>` +
      `<td>${formatBytes(data.bytes)}</td>` +
      `<td>${formatShare(data.share)}</td>`;
    row.addEventListener('pointerenter', () => highlight(data.key));
    inspectRows.appendChild(row);
  }

  const clear = () => {
    highlight(null);
    inspectTooltip.classList.remove('is-visible');
  };
  inspectBar.addEventListener('pointerleave', clear);
  inspectRows.addEventListener('pointerleave', clear);

  const facts = [plural(analysis.pageCount, 'page'), plural(analysis.objectCount, 'object')];
  if (analysis.encrypted) facts.push('encrypted');
  if (analysis.producer) facts.push(`produced by ${analysis.producer}`);
  inspectFacts.textContent = `${formatBytes(analysis.fileSize)} · ${facts.join(' · ')}`;

  const largest = analysis.breakdown[0];
  const notes = [];
  if (largest) {
    notes.push(
      `The biggest item is <strong>${escapeHtml(largest.label)}</strong>, at ${formatShare(largest.share)} of the file. ` +
        (ADVICE[largest.key] || ''),
    );
  }
  if (analysis.uncompressed.bytes > analysis.fileSize * 0.05) {
    notes.push(
      `${formatBytes(analysis.uncompressed.bytes)} of it is stored <strong>without any compression</strong> ` +
        `(${plural(analysis.uncompressed.count, 'stream')}) — deflating those alone would shrink the file.`,
    );
  }
  inspectAdvice.innerHTML = notes.join('</p><p>');
}

inspectBtn.addEventListener('click', async () => {
  if (!currentFile || busy) return;
  setBusy(true);
  setProgress(0.3, 'Reading every object…');

  try {
    const bytes = new Uint8Array(await currentFile.arrayBuffer());
    await yieldToUI();
    const analysis = await analysePdf(bytes);
    renderBreakdown(analysis);
    resetProgress();
    showPanel(inspectPanel);
  } catch (err) {
    resetProgress();
    console.error(err);
    showError(`Could not read this PDF: ${err.message || err}`);
  } finally {
    setBusy(false);
  }
});

window.addEventListener('beforeunload', releaseUrls);
