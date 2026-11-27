// ============================================================================
// png-squeeze-01 — lossless screenshot compressor.
// pipeline: decode PNG -> pick cheapest color form (truecolor / grey /
// grey+alpha / palette) -> pick per-row filter (zlib trial sizes + msad
// heuristic) -> try a handful of global filters -> zopfli on small palette
// index streams -> emit the smallest valid PNG.
// Pure Node, no deps, deterministic output.
// ============================================================================
import ZopfliModule from "./zopfli5.mjs";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDTH = 1280;
const HEIGHT = 720;
const ZOPFLI_MAX_BYTES = 1048576; // 1 MiB cap: wasm zopfli only on small streams
const ZOPFLI_ITERS = 3;

// --- zopfli (wasm) -----------------------------------------------------------
// Lazy single-init wrapper around the compiled module. The export signature
// is _zdeflate(inPtr, len, iterations, outSizePtr); the output length comes
// back as a u64 at outSizePtr.

type Zopfli = { zdeflate: (b: Uint8Array, iters?: number) => Uint8Array };
let _zopfli: Zopfli | null = null;

async function zdeflateBest(data: Uint8Array): Promise<Uint8Array> {
  if (!_zopfli) {
    const m = await ZopfliModule();
    const { _zdeflate, _malloc, _free } = m as any;
    const heap = () => new Uint8Array((m as any).wasmMemory.buffer);
    _zopfli = { zdeflate: (b: Uint8Array, iters = 15) => {
      const inPtr = _malloc(b.length);
      heap().set(b, inPtr);
      const outSizePtr = _malloc(8);
      const outPtr = _zdeflate(inPtr, b.length, iters, outSizePtr);
      const dv = new DataView((m as any).wasmMemory.buffer);
      const outLen = Number(dv.getBigUint64(outSizePtr, true));
      const out = heap().slice(outPtr, outPtr + outLen);
      _free(inPtr); _free(outSizePtr); _free(outPtr);
      return out;
    } };
  }
  return _zopfli.zdeflate(data, ZOPFLI_ITERS);
}

// --- PNG decoding (RGBA only, 8-bit, all standard filters) -------------------

function readPngRGBA(path: string): Uint8Array {
  const d = readFileSync(path);
  let o = 8;
  const idat: Buffer[] = [];
  let colorType = 6;
  while (o < d.length) {
    const len = d.readUInt32BE(o);
    const type = d.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') colorType = d[o + 17];
    if (type === 'IDAT') idat.push(d.subarray(o + 8, o + 8 + len));
    o += 12 + len;
    if (type === 'IEND') break;
  }
  // inputs are 1280x720 RGBA by contract; we decode ct6 only
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const BPP = 4, STRIDE = WIDTH * BPP;
  const out = new Uint8Array(HEIGHT * STRIDE);
  for (let y = 0; y < HEIGHT; y++) {
    const filter = raw[y * (STRIDE + 1)];
    for (let x = 0; x < STRIDE; x++) {
      const i = y * (STRIDE + 1) + 1 + x;
      const A = x >= BPP ? out[y * STRIDE + x - BPP] : 0;
      const B = y > 0 ? out[(y - 1) * STRIDE + x] : 0;
      const C = x >= BPP && y > 0 ? out[(y - 1) * STRIDE + x - BPP] : 0;
      let v = raw[i];
      if (filter === 1) v = (v + A) & 255;
      else if (filter === 2) v = (v + B) & 255;
      else if (filter === 3) v = (v + ((A + B) >> 1)) & 255;
      else if (filter === 4) v = (v + paeth(A, B, C)) & 255;
      out[y * STRIDE + x] = v;
    }
  }
  return out;
}

// --- PNG encoding primitives -------------------------------------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([head, tb, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(colorType: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(WIDTH, 0); b.writeUInt32BE(HEIGHT, 4);
  b[8] = 8; b[9] = colorType;
  return b;
}

// --- filtering ---------------------------------------------------------------

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
};

// Apply one filter type to a single row given the previous (unfiltered) row.
// Nothing fancy — this is the inner loop every strategy below shares.
function filterRow(
  row: Uint8Array, prev: Uint8Array, bpp: number, mode: number
): Buffer {
  const cur = Buffer.alloc(row.length);
  for (let x = 0; x < row.length; x++) {
    const A = x >= bpp ? cur[x - bpp] : 0;
    const B = prev[x];
    const C = x >= bpp ? prev[x - bpp] : 0;
    let v = row[x];
    if (mode === 1) v = (v + A) & 255;
    else if (mode === 2) v = (v + B) & 255;
    else if (mode === 3) v = (v + ((A + B) >> 1)) & 255;
    else if (mode === 4) v = (v + paeth(A, B, C)) & 255;
    cur[x] = v;
  }
  return cur;
}

function runPerRow(
  src: Uint8Array, bpp: number, w: number, h: number,
  pick: (mode: number, filtered: Buffer) => number // lower = better
): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    let bestMode = 0, bestScore = Infinity, bestRow: Buffer | null = null;
    for (let mode = 0; mode < 5; mode++) {
      const filtered = filterRow(row, prev, bpp, mode);
      const score = pick(mode, filtered);
      if (score < bestScore) { bestScore = score; bestMode = mode; bestRow = filtered; }
    }
    out[y * (stride + 1)] = bestMode;
    Buffer.from(bestRow!).copy(out, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  return out;
}

// msad-style heuristic: sum of distance of each filtered byte from 128.
// Cheap proxy for entropy — no zlib calls, good for tiny index streams.
function filterStreamMsad(src: Uint8Array, bpp: number, w: number, h: number): Buffer {
  return runPerRow(src, bpp, w, h, (_mode, filtered) => {
    let msad = 0;
    for (let x = 0; x < filtered.length; x++) {
      const v = filtered[x];
      msad += v < 128 ? v : 256 - v;
    }
    return msad;
  });
}

// Real trial compression at zlib level 3 — fast and usually on target.
function filterStreamZ3(src: Uint8Array, bpp: number, w: number, h: number): Buffer {
  return runPerRow(src, bpp, w, h, (mode, filtered) =>
    zlib.deflateRawSync(Buffer.concat([Buffer.from([mode]), filtered]), { level: 3 }).length
  );
}

// Real trial compression at zlib level 9 — slower, tighter.
function filterStreamZ9(src: Uint8Array, bpp: number, w: number, h: number): Buffer {
  return runPerRow(src, bpp, w, h, (mode, filtered) =>
    zlib.deflateRawSync(Buffer.concat([Buffer.from([mode]), filtered]), { level: 9, memLevel: 9 }).length
  );
}

// One fixed filter type for the whole image.
function globalFilter(src: Uint8Array, bpp: number, w: number, h: number, mode: number): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    const filtered = filterRow(row, prev, bpp, mode);
    out[y * (stride + 1)] = mode;
    filtered.copy(out, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  return out;
}

// --- deflate strategies ------------------------------------------------------

// ct0/ct4/ct6 streams are big — zopfli would blow the 60s budget, zlib9 only.
async function encodeStandard(filtered: Uint8Array): Promise<Buffer> {
  return zlib.deflateRawSync(filtered, { level: 9, memLevel: 9 });
}

// Small (palette index) streams get a zopfli shot; keep whichever is smaller.
async function encodeSmall(filtered: Uint8Array): Promise<Buffer> {
  const zlibIdat = zlib.deflateRawSync(filtered, { level: 9, memLevel: 9 });
  if (filtered.length <= ZOPFLI_MAX_BYTES) {
    try {
      const z = await zdeflateBest(filtered);
      if (z.length < zlibIdat.length) return z;
    } catch { /* wasm hiccup: zlib result stands */ }
  }
  return zlibIdat;
}

// --- color form candidates ---------------------------------------------------

async function squeeze(rgba: Uint8Array): Promise<Buffer> {
  // build palette + scan for structural shortcuts
  const pal = new Map<number, number>();
  for (let j = 0; j < rgba.length; j += 4) {
    const px = (rgba[j] << 24 | rgba[j + 1] << 16 | rgba[j + 2] << 8 | rgba[j + 3]) >>> 0;
    if (!pal.has(px)) pal.set(px, pal.size);
  }
  let alphaAll255 = true, allGrey = true;
  for (let j = 0; j < rgba.length; j += 4) {
    if (rgba[j + 3] !== 255) alphaAll255 = false;
    if (rgba[j] !== rgba[j + 1] || rgba[j] !== rgba[j + 2]) allGrey = false;
  }

  const candidates: Buffer[] = [];

  // (a) truecolor RGBA: per-row level-9 trials, plus a few global filters
  {
    let best: Buffer | null = null;
    const streams = [
      filterStreamZ9(rgba, 4, WIDTH, HEIGHT),
      globalFilter(rgba, 4, WIDTH, HEIGHT, 4),
      globalFilter(rgba, 4, WIDTH, HEIGHT, 2),
      globalFilter(rgba, 4, WIDTH, HEIGHT, 1),
      globalFilter(rgba, 4, WIDTH, HEIGHT, 0),
    ];
    for (const s of streams) {
      const idat = await encodeStandard(s);
      if (!best || idat.length < best.length) best = idat;
    }
    candidates.push(Buffer.concat([PNG_SIG, chunk('IHDR', ihdr(6)), chunk('IDAT', best!), chunk('IEND', Buffer.alloc(0))]));
  }

  // (b) opaque greyscale -> colour type 0
  if (allGrey && alphaAll255) {
    const grey = new Uint8Array(WIDTH * HEIGHT);
    for (let j = 0; j < WIDTH * HEIGHT; j++) grey[j] = rgba[j * 4];
    candidates.push(Buffer.concat([
      PNG_SIG, chunk('IHDR', ihdr(0)),
      chunk('IDAT', await encodeStandard(filterStreamZ9(grey, 1, WIDTH, HEIGHT))),
      chunk('IEND', Buffer.alloc(0)),
    ]));
  }

  // (c) greyscale (alpha allowed) -> colour type 4
  if (allGrey) {
    const ga = new Uint8Array(WIDTH * HEIGHT * 2);
    for (let j = 0; j < WIDTH * HEIGHT; j++) { ga[j * 2] = rgba[j * 4]; ga[j * 2 + 1] = rgba[j * 4 + 3]; }
    candidates.push(Buffer.concat([
      PNG_SIG, chunk('IHDR', ihdr(4)),
      chunk('IDAT', await encodeStandard(filterStreamZ9(ga, 2, WIDTH, HEIGHT))),
      chunk('IEND', Buffer.alloc(0)),
    ]));
  }

  // (d) <=256 distinct colours -> palette + tRNS, most-used entry first
  if (pal.size <= 256) {
    const counts = new Map<number, number>();
    for (let j = 0; j < rgba.length; j += 4) {
      const px = (rgba[j] << 24 | rgba[j + 1] << 16 | rgba[j + 2] << 8 | rgba[j + 3]) >>> 0;
      counts.set(px, (counts.get(px) ?? 0) + 1);
    }
    const order = [...pal.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
    const remap = new Map<number, number>();
    order.forEach((k, i) => remap.set(k, i));
    const idx = Buffer.alloc(WIDTH * HEIGHT);
    for (let j = 0; j < WIDTH * HEIGHT; j++) {
      const px = (rgba[j * 4] << 24 | rgba[j * 4 + 1] << 16 | rgba[j * 4 + 2] << 8 | rgba[j * 4 + 3]) >>> 0;
      idx[j] = remap.get(px)!;
    }
    const plte = Buffer.alloc(order.length * 3);
    const trns = Buffer.alloc(order.length);
    order.forEach((k, i) => {
      plte[i * 3] = (k >>> 16) & 255;
      plte[i * 3 + 1] = (k >>> 8) & 255;
      plte[i * 3 + 2] = k & 255;
      trns[i] = (k >>> 24) & 255;
    });
    // index stream is tiny: try msad heuristic, level-9 trials, raw — and
    // zopfli the raw stream (it compresses index data absurdly well).
    let bestIdat: Buffer | null = null;
    for (const f of [filterStreamMsad(idx, 1, WIDTH, HEIGHT), filterStreamZ9(idx, 1, WIDTH, HEIGHT), idx]) {
      let idat = zlib.deflateRawSync(f, { level: 9, memLevel: 9 });
      if (f === idx && idx.length <= ZOPFLI_MAX_BYTES) {
        try {
          const z = await zdeflateBest(idx);
          if (z.length < idat.length) idat = z;
        } catch { /* ignore */ }
      }
      if (!bestIdat || idat.length < bestIdat.length) bestIdat = idat;
    }
    candidates.push(Buffer.concat([
      PNG_SIG, chunk('IHDR', ihdr(3)), chunk('PLTE', plte), chunk('tRNS', trns),
      chunk('IDAT', bestIdat!), chunk('IEND', Buffer.alloc(0)),
    ]));
  }

  return candidates.reduce((a, b) => (b.length < a.length ? b : a));
}

// --- main loop ---------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
for (const id of readdirSync(IN_DIR).sort()) {
  const rgba = readPngRGBA(join(IN_DIR, id, 'image.png'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'image.png'), await squeeze(rgba));
}
