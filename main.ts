import ZopfliModule from "./zopfli5.mjs";

// png-squeeze-01 entry: color-form reduction + filter trial + zlib9. Pure Node, deterministic.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const W = 1280, H = 720;


let _dumped = false;
let _z: { zdeflate: (b: Uint8Array, iters?: number) => Uint8Array } | null = null;
async function zdeflateBest(data: Uint8Array): Promise<Uint8Array> {
  if (!_z) {
    const m = await ZopfliModule();
    const { _zdeflate, _malloc, _free } = m as any;
    const mem = () => new Uint8Array((m as any).wasmMemory.buffer);
    _z = { zdeflate: (b: Uint8Array, iters = 15) => {
      const inPtr = _malloc(b.length);
      mem().set(b, inPtr);
      const outSizePtr = _malloc(8);
      const outPtr = _zdeflate(inPtr, b.length, iters, outSizePtr);
      const dv = new DataView((m as any).wasmMemory.buffer);
      const sz = Number(dv.getBigUint64(outSizePtr, true));
      const out = mem().slice(outPtr, outPtr + sz);
      _free(inPtr); _free(outSizePtr); _free(outPtr);
      return out;
    } };
  }
  return _z.zdeflate(data, 3);
}

function readPngRGBA(path: string): Uint8Array {
  const d = readFileSync(path);
  let o = 8; const idat: Buffer[] = []; let ct = 6;
  while (o < d.length) {
    const len = d.readUInt32BE(o); const t = d.toString('ascii', o + 4, o + 8);
    if (t === 'IHDR') ct = d[o + 17];
    if (t === 'IDAT') idat.push(d.subarray(o + 8, o + 8 + len));
    o += 12 + len;
    if (t === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const BPP = 4, STRIDE = W * BPP;
  const out = new Uint8Array(H * STRIDE);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < H; y++) {
    const f = raw[y * (STRIDE + 1)];
    for (let x = 0; x < STRIDE; x++) {
      const i = y * (STRIDE + 1) + 1 + x;
      const A = x >= BPP ? out[y * STRIDE + x - BPP] : 0;
      const B = y > 0 ? out[(y - 1) * STRIDE + x] : 0;
      const C = x >= BPP && y > 0 ? out[(y - 1) * STRIDE + x - BPP] : 0;
      let v = raw[i];
      if (f === 1) v = (v + A) & 255;
      else if (f === 2) v = (v + B) & 255;
      else if (f === 3) v = (v + ((A + B) >> 1)) & 255;
      else if (f === 4) v = (v + paeth(A, B, C)) & 255;
      out[y * STRIDE + x] = v;
    }
  }
  return out;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(t: string, d: Buffer): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(d.length);
  const tb = Buffer.from(t, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, d])));
  return Buffer.concat([head, tb, d, crc]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
};

/** filter src (rows of bpp bytes) with per-row entropy-chosen filter, return filtered stream */
function filterStream(src: Uint8Array, bpp: number, w: number, h: number): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  const probes = [1, 2, 4, 8];
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    let bestF = 0, bestScore = Infinity, bestRow: Buffer | null = null;
    for (let f = 0; f < 5; f++) {
      const cur = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const A = x >= bpp ? cur[x - bpp] : 0;
        const B = prev[x];
        const C = x >= bpp ? prev[x - bpp] : 0;
        let v = row[x];
        if (f === 1) v = (v + A) & 255;
        else if (f === 2) v = (v + B) & 255;
        else if (f === 3) v = (v + ((A + B) >> 1)) & 255;
        else if (f === 4) v = (v + paeth(A, B, C)) & 255;
        cur[x] = v;
      }
      // entropy proxy: sum of |signed low nibble high nibble| like msad
      let msad = 0;
      for (let x = 0; x < stride; x++) { const v = cur[x]; msad += v < 128 ? v : 256 - v; }
      let score = msad;
      if (bestScore > score) { bestScore = score; bestF = f; bestRow = cur; }
    }
    out[y * (stride + 1)] = bestF;
    Buffer.from(bestRow!).copy(out, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  return out;
}

/** encode RGBA to smallest PNG among candidate color forms */

/** per-row filter chosen by real zlib trial size */
function filterStreamZ(src: Uint8Array, bpp: number, w: number, h: number): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    let bestF = 0, bestLen = Infinity, bestRow: Buffer | null = null;
    for (let f = 0; f < 5; f++) {
      const cur = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const A = x >= bpp ? cur[x - bpp] : 0;
        const B = prev[x];
        const C = x >= bpp ? prev[x - bpp] : 0;
        let v = row[x];
        if (f === 1) v = (v + A) & 255;
        else if (f === 2) v = (v + B) & 255;
        else if (f === 3) v = (v + ((A + B) >> 1)) & 255;
        else if (f === 4) v = (v + paeth(A, B, C)) & 255;
        cur[x] = v;
      }
      const trial = zlib.deflateRawSync(Buffer.concat([Buffer.from([f]), cur]), { level: 3 }).length;
      if (trial < bestLen) { bestLen = trial; bestF = f; bestRow = cur; }
    }
    out[y * (stride + 1)] = bestF;
    Buffer.from(bestRow!).copy(out, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  return out;
}


/** per-row filter chosen by real zlib level-9 trial size */
function filterStreamZ9(src: Uint8Array, bpp: number, w: number, h: number): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    let bestF = 0, bestLen = Infinity, bestRow: Buffer | null = null;
    for (let f = 0; f < 5; f++) {
      const cur = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const A = x >= bpp ? cur[x - bpp] : 0;
        const B = prev[x];
        const C = x >= bpp ? prev[x - bpp] : 0;
        let v = row[x];
        if (f === 1) v = (v + A) & 255;
        else if (f === 2) v = (v + B) & 255;
        else if (f === 3) v = (v + ((A + B) >> 1)) & 255;
        else if (f === 4) v = (v + paeth(A, B, C)) & 255;
        cur[x] = v;
      }
      const trial = zlib.deflateRawSync(Buffer.concat([Buffer.from([f]), cur]), { level: 9, memLevel: 9 }).length;
      if (trial < bestLen) { bestLen = trial; bestF = f; bestRow = cur; }
    }
    out[y * (stride + 1)] = bestF;
    Buffer.from(bestRow!).copy(out, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  return out;
}


function globalFilter(src: Uint8Array, bpp: number, w: number, h: number, mode: number): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
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
    out[y * (stride + 1)] = mode;
    cur.copy(out, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  return out;
}

async function squeeze(rgba: Uint8Array): Promise<Buffer> {
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
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const enc = async (filtered: Uint8Array) => {
    const a = zlib.deflateRawSync(filtered, { level: 9, memLevel: 9 });
    return a; // ct6/ct0/ct4: zopfli too slow at 60s budget
  };
  const encSmall = async (filtered: Uint8Array) => {
    const a = zlib.deflateRawSync(filtered, { level: 9, memLevel: 9 });
    if (filtered.length <= 1048576) {
      try { const b = await zdeflateBest(filtered); if (b.length < a.length) return b; } catch { /* fallback */ }
    }
    return a;
  };
  const ihdr = (ct: number) => { const b = Buffer.alloc(13); b.writeUInt32BE(W, 0); b.writeUInt32BE(H, 4); b[8] = 8; b[9] = ct; return b; };
  // ct6
  {
    let best: Buffer | null = null;
    for (const s of [filterStreamZ9(rgba, 4, W, H), globalFilter(rgba, 4, W, H, 4), globalFilter(rgba, 4, W, H, 2), globalFilter(rgba, 4, W, H, 1), globalFilter(rgba, 4, W, H, 0)]) {
      const idat = await enc(s);
      if (!best || idat.length < best.length) best = idat;
    }
    candidates.push(Buffer.concat([PNG_SIG, chunk('IHDR', ihdr(6)), chunk('IDAT', best!), chunk('IEND', Buffer.alloc(0))]));
  }
  if (allGrey && alphaAll255) {
    const grey = new Uint8Array(W * H);
    for (let j = 0; j < W * H; j++) grey[j] = rgba[j * 4];
    candidates.push(Buffer.concat([PNG_SIG, chunk('IHDR', ihdr(0)), chunk('IDAT', await enc(filterStreamZ9(grey, 1, W, H))), chunk('IEND', Buffer.alloc(0))]));
  }
  if (allGrey) {
    const ga = new Uint8Array(W * H * 2);
    for (let j = 0; j < W * H; j++) { ga[j * 2] = rgba[j * 4]; ga[j * 2 + 1] = rgba[j * 4 + 3]; }
    candidates.push(Buffer.concat([PNG_SIG, chunk('IHDR', ihdr(4)), chunk('IDAT', await enc(filterStreamZ9(ga, 2, W, H))), chunk('IEND', Buffer.alloc(0))]));
  }
  if (pal.size <= 256) {
    const cnt = new Map<number, number>();
    for (let j = 0; j < rgba.length; j += 4) {
      const px = (rgba[j] << 24 | rgba[j + 1] << 16 | rgba[j + 2] << 8 | rgba[j + 3]) >>> 0;
      cnt.set(px, (cnt.get(px) ?? 0) + 1);
    }
    const order = [...pal.keys()].sort((a, b) => cnt.get(b)! - cnt.get(a)!);
    const remap = new Map<number, number>(); order.forEach((k, i) => remap.set(k, i));
    const idx = Buffer.alloc(W * H);
    for (let j = 0; j < W * H; j++) {
      const px = (rgba[j * 4] << 24 | rgba[j * 4 + 1] << 16 | rgba[j * 4 + 2] << 8 | rgba[j * 4 + 3]) >>> 0;
      idx[j] = remap.get(px)!;
    }
    const plte = Buffer.alloc(order.length * 3);
    const trns = Buffer.alloc(order.length);
    order.forEach((k, i) => { plte[i * 3] = (k >>> 16) & 255; plte[i * 3 + 1] = (k >>> 8) & 255; plte[i * 3 + 2] = k & 255; trns[i] = (k >>> 24) & 255; });
    let bestIdat: Buffer | null = null;
    for (const f of [filterStream(idx, 1, W, H), filterStreamZ9(idx, 1, W, H), idx]) {
      const zlibIdat = zlib.deflateRawSync(f, { level: 9, memLevel: 9 });
      let idat = zlibIdat;
      if (f === idx && idx.length <= 1048576) {
        try { const z = await zdeflateBest(idx); if (z.length < idat.length) idat = z; } catch { /* ignore */ }
      }
      if (!bestIdat || idat.length < bestIdat.length) bestIdat = idat;
    }
    candidates.push(Buffer.concat([PNG_SIG, chunk('IHDR', ihdr(3)), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', bestIdat!), chunk('IEND', Buffer.alloc(0))]));
  }
  return candidates.reduce((a, b) => (b.length < a.length ? b : a));
}

mkdirSync(O, { recursive: true });
for (const id of readdirSync(I).sort()) {
  const rgba = readPngRGBA(join(I, id, 'image.png'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), await squeeze(rgba));
}
