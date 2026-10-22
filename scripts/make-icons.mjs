// Writes public/icon-180.png and public/icon-512.png: a dark tile with a 2x2 shelf of
// printers (blue = Control column, orange = Maintenance column). No dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#1a1a19');
const SHELF = hex('#383835');
const C = hex('#3987e5');
const M = hex('#eb6834');

function icon(size) {
  const px = (x, y) => {
    const u = x / size;
    const v = y / size;
    const inBox = (x0, y0, x1, y1) => u >= x0 && u < x1 && v >= y0 && v < y1;
    if (inBox(0.18, 0.2, 0.47, 0.46) || inBox(0.18, 0.52, 0.47, 0.78)) return C;
    if (inBox(0.53, 0.2, 0.82, 0.46) || inBox(0.53, 0.52, 0.82, 0.78)) return M;
    if (inBox(0.12, 0.46, 0.88, 0.5) || inBox(0.12, 0.78, 0.88, 0.82)) return SHELF;
    return BG;
  };
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public', { recursive: true });
for (const s of [180, 512]) writeFileSync(`public/icon-${s}.png`, icon(s));
console.log('Wrote public/icon-180.png and public/icon-512.png');
