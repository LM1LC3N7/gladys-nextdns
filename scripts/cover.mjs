// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-teal gradient, a
// shield, and query dots flowing to it, some stopped (blocked) in red.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
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

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [8, 20, 34];
const TEAL = [12, 96, 118];
const WHITE = [236, 246, 250];
const BLUE = [40, 150, 230];
const GREEN = [70, 210, 140];
const RED = [235, 80, 70];

const CX = 520;
const CY = 260;

/** Signed distance to the shield: a rounded top and a pointed bottom. */
function shield(x, y, scale) {
  const dx = Math.abs(x - CX) / scale;
  const dy = (y - CY) / scale;
  if (dy < 0) {
    // The upper part: a box with rounded corners.
    const qx = dx - 120 + 30;
    const qy = -dy - 130 + 30;
    return (
      (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 30) * scale
    );
  }
  // The lower part: narrows to a point at dy = 170.
  const half = 120 * (1 - (dy / 170) ** 1.6);
  return dy > 170 ? Math.hypot(dx, dy - 170) * scale : (dx - half) * scale * 0.8;
}

// Query dots on three lanes: [y, x positions, blocked index].
const LANES = [
  [180, [70, 150, 230, 310], 2],
  [260, [90, 170, 250, 330], -1],
  [340, [60, 140, 220, 300], 1],
];

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // The shield: a white rim, a blue body, a check mark.
  const outer = shield(x, y, 1);
  color = mix(color, WHITE, smooth(0, Math.abs(outer) - 3) * 0.95);
  color = mix(color, BLUE, smooth(0, outer + 4));
  // The check mark: two segments.
  for (const [x0, y0, x1, y1] of [
    [CX - 55, CY + 5, CX - 15, CY + 50],
    [CX - 15, CY + 50, CX + 60, CY - 45],
  ]) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
    color = mix(color, WHITE, smooth(12, d));
  }
  // The lanes and their queries.
  for (const [ly, dots, blocked] of LANES) {
    if (x < 380) color = mix(color, WHITE, smooth(1.2, Math.abs(y - ly)) * 0.18);
    dots.forEach((dx, i) => {
      const d = Math.hypot(x - dx, y - ly);
      color = mix(color, i === blocked ? RED : GREEN, smooth(14, d));
    });
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
