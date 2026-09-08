#!/usr/bin/env node
/**
 * Generates the LifeMentor icon set (no image tooling required):
 *   assets/app-icon-1024.png        — the master icon
 *   Android mipmap launcher icons (ic_launcher and ic_launcher_round, all densities)
 *
 * The Tauri Windows icon (icons/icon.ico + icon.png) is generated from the same
 * master with `npx tauri icon` (see apps/desktop).
 *
 * Design: rounded square, diagonal deep-green gradient (theme #1e5f4e), white
 * "growth path" mark (rising polyline + dot) — progress, not decoration.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── minimal PNG encoder (RGBA, 8-bit) ───────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── drawing (SDF, antialiased) ──────────────────────────────────────── */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1e-9;
  const t = clamp01((wx * vx + wy * vy) / len2);
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

/** The growth path: rising polyline with a dot at the end (normalized 0..1). */
const PATH = [
  [0.24, 0.72],
  [0.42, 0.52],
  [0.56, 0.615],
  [0.75, 0.33],
];
const DOT = [0.75, 0.33];
const STROKE = 0.052; // half-width of the path
const DOT_R = 0.075;

function coverage(x, y, S) {
  // AA width in pixels (sharp edges, ~1–2 px band)
  const aa = Math.max(1, S / 512) * 1.25;

  // rounded-square background (fills the canvas; launchers may mask it)
  const r = 0.22 * S;
  const hw = S / 2;
  const qx = Math.abs(x - S / 2) - (hw - r);
  const qy = Math.abs(y - S / 2) - (hw - r);
  const dSquare = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  const bg = smooth(0.5 - dSquare / aa);

  // growth path stroke + dot
  let dPath = Infinity;
  for (let i = 0; i < PATH.length - 1; i++) {
    dPath = Math.min(dPath, segDist(x, y, PATH[i][0] * S, PATH[i][1] * S, PATH[i + 1][0] * S, PATH[i + 1][1] * S));
  }
  const dDot = Math.hypot(x - DOT[0] * S, y - DOT[1] * S) - DOT_R * S;
  const d = Math.min(dPath - STROKE * S, dDot);
  const mark = smooth(0.5 - d / aa);
  return { bg, mark };
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  // gradient stops (diagonal)
  const top = [0x2f, 0x8a, 0x72];   // #2f8a72 light
  const bottom = [0x15, 0x3f, 0x34]; // #153f34 deep
  const white = [0xf6, 0xf8, 0xf5];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = clamp01((x + y) / (2 * size));
      const r = top[0] + (bottom[0] - top[0]) * t;
      const g = top[1] + (bottom[1] - top[1]) * t;
      const b = top[2] + (bottom[2] - top[2]) * t;
      const { bg, mark } = coverage(x + 0.5, y + 0.5, size);
      buf[i] = Math.round(r + (white[0] - r) * mark);
      buf[i + 1] = Math.round(g + (white[1] - g) * mark);
      buf[i + 2] = Math.round(b + (white[2] - b) * mark);
      buf[i + 3] = Math.round(255 * bg);
    }
  }
  return encodePng(size, buf);
}

function save(path, png) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  console.log('  wrote', path.replace(ROOT + '/', ''), `(${png.length} B)`);
}

const t0 = Date.now();
console.log('Rendering LifeMentor icons…');
save(join(ROOT, 'assets/app-icon-1024.png'), render(1024));

// Android launcher icons (mipmap densities)
const MIPMAP = join(ROOT, 'apps/mobile/android/app/src/main/res');
for (const [dir, size] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
  save(join(MIPMAP, dir, 'ic_launcher.png'), render(size));
  save(join(MIPMAP, dir, 'ic_launcher_round.png'), render(size));
}
console.log(`done in ${Date.now() - t0} ms`);
