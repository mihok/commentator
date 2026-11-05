'use strict';

/**
 * Cheap, local change detection so we only pay for a vision call when the
 * screen actually changed. A "fingerprint" is a tiny grayscale thumbnail.
 */

const FP_WIDTH = 64;
const FP_HEIGHT = 36;

/**
 * Convert a raw BGRA (or RGBA, the weights are close enough) bitmap of size
 * width x height into a grayscale fingerprint, blanking any masked rectangles.
 *
 * @param {Uint8Array|Buffer} bitmap 4 bytes per pixel
 * @param {number} width
 * @param {number} height
 * @param {Array<{x:number,y:number,width:number,height:number}>} masks
 *   rectangles in 0..1 fractional coordinates to ignore (e.g. our own overlay)
 * @returns {Uint8Array}
 */
function toFingerprint(bitmap, width, height, masks = []) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Luma from BGRA: 0.114 B + 0.587 G + 0.299 R
    out[i] = (bitmap[p] * 29 + bitmap[p + 1] * 150 + bitmap[p + 2] * 77) >> 8;
  }
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x * width));
    const y0 = Math.max(0, Math.floor(m.y * height));
    const x1 = Math.min(width, Math.ceil((m.x + m.width) * width));
    const y1 = Math.min(height, Math.ceil((m.y + m.height) * height));
    for (let y = y0; y < y1; y++) out.fill(0, y * width + x0, y * width + x1);
  }
  return out;
}

/**
 * Fraction of the screen that visibly changed, 0..1.
 * A pixel counts as changed if its luma moved by more than `pixelTolerance`,
 * which ignores cursor blink / antialiasing shimmer but catches new text.
 */
function frameDifference(a, b, pixelTolerance = 12) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > pixelTolerance) changed++;
  }
  return changed / a.length;
}

/** Convert an absolute rect into fractional coordinates relative to `bounds`. */
function relativeRect(rect, bounds) {
  return {
    x: (rect.x - bounds.x) / bounds.width,
    y: (rect.y - bounds.y) / bounds.height,
    width: rect.width / bounds.width,
    height: rect.height / bounds.height,
  };
}

module.exports = { FP_WIDTH, FP_HEIGHT, toFingerprint, frameDifference, relativeRect };
