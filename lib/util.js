// Small shared helpers.

export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function yieldToUI() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** Largest scale factor that fits w x h inside maxW x maxH, capped by `allowUpscale`. */
export function fitScale(w, h, maxW, maxH, allowUpscale = false) {
  const limits = [];
  if (maxW > 0) limits.push(maxW / w);
  if (maxH > 0) limits.push(maxH / h);
  const scale = limits.length ? Math.min(...limits) : 1;
  return allowUpscale ? scale : Math.min(1, scale);
}

/** Floating point scaling lands on 499.99999999999994 often enough to matter. */
function snap(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 ? rounded : value;
}

/** Keep a canvas within what browsers will actually allocate. */
export function clampToPixelBudget(width, height, maxPixels = 40e6, maxSide = 16384) {
  let scale = 1;
  if (width * height > maxPixels) scale = Math.sqrt(maxPixels / (width * height));
  const longest = Math.max(width, height) * scale;
  if (longest > maxSide) scale *= maxSide / longest;
  return {
    width: Math.max(1, Math.floor(snap(width * scale))),
    height: Math.max(1, Math.floor(snap(height * scale))),
    clamped: scale < 1,
  };
}

/** "1-3, 7, 12-" -> [1,2,3,7,12,...]. Empty/"all" means every page. */
export function parsePageRange(text, pageCount) {
  const trimmed = (text || '').trim().toLowerCase();
  if (!trimmed || trimmed === 'all') {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const picked = new Set();
  for (const part of trimmed.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;
    const match = chunk.match(/^(\d*)\s*-\s*(\d*)$/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 1;
      const end = match[2] ? parseInt(match[2], 10) : pageCount;
      for (let p = Math.max(1, start); p <= Math.min(pageCount, end); p += 1) picked.add(p);
    } else if (/^\d+$/.test(chunk)) {
      const p = parseInt(chunk, 10);
      if (p >= 1 && p <= pageCount) picked.add(p);
    } else {
      throw new Error(`Could not understand the page range "${chunk}".`);
    }
  }
  if (!picked.size) throw new Error('That page range does not match any pages in this PDF.');
  return [...picked].sort((a, b) => a - b);
}

export function padNumber(value, width) {
  return String(value).padStart(width, '0');
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
