/**
 * Generates icons/logo-h.png — the Hilltoppers "H" mark: a deep green rounded
 * square, two white stems, and an orange capsule crossing them.
 *
 * The shapes are drawn with signed distance fields and 4x4 supersampling, so
 * the rounded stems and the diagonal bar come out smooth at icon sizes. Flat
 * colour means the result is tiny compared with a photograph, and the encoder
 * below writes the PNG directly so this needs no image dependencies.
 *
 *   node scripts/generate-logo-h.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 512;
const SS = 4; // supersamples per axis

const GREEN = [0x0b, 0x4a, 0x21];
const ORANGE = [0xf2, 0x6a, 0x21];

// --- signed distance helpers, all in 0..1 page coordinates -----------------

function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

function sdRoundedSquare(px, py, r) {
  // Rounded square filling the page: distance to the nearest edge, corners
  // pulled in by r.
  const qx = Math.abs(px - 0.5) - (0.5 - r);
  const qy = Math.abs(py - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// --- the mark ---------------------------------------------------------------

const STEM_TOP = 0.337;
const STEM_BOTTOM = 0.663;
const STEM_R = 0.067;
const BAR_R = 0.072;

/** Returns [r,g,b,a] for one sample, or null where fully transparent. */
function sample(x, y) {
  if (sdRoundedSquare(x, y, 0.23) > 0) return null;

  let colour = GREEN;
  if (
    sdCapsule(x, y, 0.365, STEM_TOP, 0.365, STEM_BOTTOM, STEM_R) < 0 ||
    sdCapsule(x, y, 0.635, STEM_TOP, 0.635, STEM_BOTTOM, STEM_R) < 0
  ) {
    colour = [0xff, 0xff, 0xff];
  }
  // The bar crosses over both stems, so it is painted last.
  if (sdCapsule(x, y, 0.245, 0.685, 0.755, 0.465, BAR_R) < 0) colour = ORANGE;

  return [...colour, 255];
}

// --- render with 4x4 supersampling -----------------------------------------

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) / SIZE;
        const py = (y + (sy + 0.5) / SS) / SIZE;
        const s = sample(px, py);
        if (s) {
          r += s[0];
          g += s[1];
          b += s[2];
          a += s[3];
        }
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    const coverage = a / (255 * n);
    if (coverage > 0) {
      // Straight alpha: average colour over the covered samples only.
      const covered = a / 255;
      pixels[i] = Math.round(r / covered);
      pixels[i + 1] = Math.round(g / covered);
      pixels[i + 2] = Math.round(b / covered);
    }
    pixels[i + 3] = Math.round(coverage * 255);
  }
}

// --- minimal PNG encoder ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Each scanline is prefixed with its filter type; 0 (none) is fine here.
const stride = SIZE * 4 + 1;
const raw = Buffer.alloc(SIZE * stride);
for (let y = 0; y < SIZE; y++) {
  pixels.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = process.argv[2]
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'icons', 'logo-h.png');
writeFileSync(target, png);
console.log(`wrote ${SIZE}x${SIZE} PNG to ${target} (${png.length} bytes)`);