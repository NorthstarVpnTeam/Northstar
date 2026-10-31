'use strict';

/**
 * Generates build/icon.png (256x256) and build/icon.ico (PNG-in-ICO) with no
 * image dependencies: raw RGBA rasterization + zlib + hand-written chunks.
 *
 * Design: rounded blue tile (#0071e3) with a white Northstar star.
 * Run: node scripts/generate-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'build');

/* ------------------------------------------------------------- drawing */

function insideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const cx = x < r ? r : x >= w - r ? w - r - 1 : x;
  const cy = y < r ? r : y >= h - r ? h - r - 1 : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Point-in-polygon for the 5-point star.
function insideStar(px, py, cx, cy, outerR, innerR) {
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outerR : innerR;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function drawRgba() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 56;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const idx = (y * SIZE + x) * 4;
      if (!insideRoundedRect(x, y, SIZE, SIZE, radius)) {
        buf[idx + 3] = 0; // transparent
        continue;
      }
      const inStar = insideStar(x, y, SIZE / 2, SIZE / 2 + 6, 88, 36);
      // Subtle vertical shading on the blue tile.
      const shade = 1 - (y / SIZE) * 0.12;
      if (inStar) {
        buf[idx] = 255;
        buf[idx + 1] = 255;
        buf[idx + 2] = 255;
        buf[idx + 3] = 255;
      } else {
        buf[idx] = Math.round(0x00 * shade + 10);
        buf[idx + 1] = Math.round(0x71 * shade + 8);
        buf[idx + 2] = Math.round(0xe3 * shade + 12);
        buf[idx + 3] = 255;
      }
    }
  }
  return buf;
}

/* ------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline prefixed with filter type 0.
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- ICO */

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 (0 = 256)
  entry[1] = 0; // height 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset = header(6) + entry(16)
  return Buffer.concat([header, entry, png]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rgba = drawRgba();
  const png = encodePng(rgba);
  const ico = encodeIco(png);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`Wrote ${path.join('build', 'icon.png')} (${png.length} bytes)`);
  console.log(`Wrote ${path.join('build', 'icon.ico')} (${ico.length} bytes)`);
}

main();