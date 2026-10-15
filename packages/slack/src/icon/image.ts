import { CommsError } from '@agentcomms/core';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * The few things the agent emoji needs done to a picture, in plain JavaScript: read a PNG or a JPEG, cut it square,
 * shrink it, draw the badge over it, and write a PNG.
 *
 * `pngjs` and `jpeg-js` do the reading and writing. Both are pure JavaScript with no native build and no dependencies
 * of their own, so the package still installs and runs from its own files on every platform; everything else here is
 * a loop over pixels.
 *
 * The bytes come from a host, not from this package, so each format is checked before it is decoded: by its first
 * bytes rather than by any type a header claims, and by the size its header declares — a few hundred bytes can declare
 * a picture that would take gigabytes to hold, and that is refused before any of it is decoded.
 */

/** Pixels as 8-bit RGBA, row by row, not premultiplied. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The longest side a photo may have. Slack's are 512; this is eight times that. */
export const MAX_SIDE = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type ImageKind = 'png' | 'jpeg';

/** Which of the two formats the bytes are, by their first bytes, or null for anything else. */
export function imageKindOf(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function notAPicture(message: string): CommsError {
  return new CommsError('BAD_DATA', message, {
    hint: 'Slack’s photos are PNG or JPEG. Upload a photo of either kind in Slack, then try again. Nothing was saved.',
  });
}

function tooLarge(width: number, height: number): CommsError {
  return notAPicture(`the profile photo says it is ${width} × ${height} pixels, more than ${MAX_SIDE} on a side`);
}

function checkSides(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw notAPicture('the profile photo has no size');
  }
  if (width > MAX_SIDE || height > MAX_SIDE) throw tooLarge(width, height);
}

/**
 * The size a PNG's header declares, read before anything is inflated: the signature, then `IHDR` first, as the format
 * requires, with its width and height.
 */
function pngSides(bytes: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 24 || view.toString('latin1', 12, 16) !== 'IHDR')
    throw notAPicture('the profile photo is not a PNG');
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

/** Reads a PNG or a JPEG into RGBA, or refuses it. */
export function decodeImage(bytes: Uint8Array): Bitmap {
  const kind = imageKindOf(bytes);
  if (kind === null) throw notAPicture('the profile photo is neither a PNG nor a JPEG');
  if (kind === 'png') {
    const sides = pngSides(bytes);
    checkSides(sides.width, sides.height);
    let png: { width: number; height: number; data: Buffer };
    try {
      png = PNG.sync.read(Buffer.from(bytes));
    } catch {
      throw notAPicture('the profile photo is a PNG that could not be read');
    }
    checkSides(png.width, png.height);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  let jpeg: { width: number; height: number; data: Uint8Array };
  try {
    jpeg = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      // Its own limits, beside ours: a JPEG's size is in a marker that can come anywhere before the pixels.
      maxResolutionInMP: (MAX_SIDE * MAX_SIDE) / 1_000_000,
      maxMemoryUsageInMB: 256,
    });
  } catch {
    throw notAPicture('the profile photo is a JPEG that could not be read');
  }
  checkSides(jpeg.width, jpeg.height);
  if (jpeg.data.length !== jpeg.width * jpeg.height * 4) throw notAPicture('the profile photo could not be read');
  return { width: jpeg.width, height: jpeg.height, data: jpeg.data };
}

/**
 * The middle square of `source`, shrunk (or, for a small photo, grown) to `size` × `size`.
 *
 * Each pixel of the result is the average of the pixels of the source it covers — the whole box, so a 512-pixel photo
 * shrunk to 128 averages each 4 × 4 block rather than picking one pixel of it — weighted by their opacity, so a
 * transparent pixel's colour does not bleed into its neighbours.
 */
export function squareThumbnail(source: Bitmap, size: number): Bitmap {
  const side = Math.min(source.width, source.height);
  const left = Math.floor((source.width - side) / 2);
  const top = Math.floor((source.height - side) / 2);
  const scale = side / size;
  const out = new Uint8Array(size * size * 4);
  const from = source.data;
  for (let y = 0; y < size; y += 1) {
    const y0 = top + Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, top + Math.min(side, Math.ceil((y + 1) * scale)));
    for (let x = 0; x < size; x += 1) {
      const x0 = left + Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, left + Math.min(side, Math.ceil((x + 1) * scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * source.width + sx) * 4;
          const alpha = from[at + 3] ?? 0;
          r += (from[at] ?? 0) * alpha;
          g += (from[at + 1] ?? 0) * alpha;
          b += (from[at + 2] ?? 0) * alpha;
          a += alpha;
          count += 1;
        }
      }
      const to = (y * size + x) * 4;
      if (a > 0) {
        out[to] = Math.round(r / a);
        out[to + 1] = Math.round(g / a);
        out[to + 2] = Math.round(b / a);
      }
      out[to + 3] = Math.round(a / count);
    }
  }
  return { width: size, height: size, data: out };
}

/** Draws `overlay` over `base` with its top-left corner at `left`, `top`: ordinary "over", by the overlay's opacity. */
export function drawOver(base: Bitmap, overlay: Bitmap, left: number, top: number): void {
  const to = base.data;
  const from = overlay.data;
  for (let y = 0; y < overlay.height; y += 1) {
    const by = top + y;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < overlay.width; x += 1) {
      const bx = left + x;
      if (bx < 0 || bx >= base.width) continue;
      const o = (y * overlay.width + x) * 4;
      const b = (by * base.width + bx) * 4;
      const alpha = (from[o + 3] ?? 0) / 255;
      if (alpha === 0) continue;
      const under = ((to[b + 3] ?? 0) / 255) * (1 - alpha);
      const together = alpha + under;
      for (let c = 0; c < 3; c += 1) {
        to[b + c] = Math.round(((from[o + c] ?? 0) * alpha + (to[b + c] ?? 0) * under) / together);
      }
      to[b + 3] = Math.round(together * 255);
    }
  }
}

/** The bitmap as a PNG: 8-bit RGBA, compressed as hard as zlib will. */
export function encodePng(bitmap: Bitmap): Buffer {
  const png = new PNG({ width: bitmap.width, height: bitmap.height });
  png.data = Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength);
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
}
