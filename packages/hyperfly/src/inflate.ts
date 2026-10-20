import { DecodeError } from "./errors.js";

const LEN_BASE = Uint16Array.of(
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
);
const LEN_EXTRA = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0);
const DIST_BASE = Uint16Array.of(
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
);
const DIST_EXTRA = Uint8Array.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13);
const CLEN_ORDER = Uint8Array.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);

const LIT_ROOT = 10;
const DIST_ROOT = 8;
const CLEN_ROOT = 7;
// bit positions stay below 2^32 so unsigned shifts can index bytes
const MAX_INPUT = 2 ** 29 - 64;
const PAD = 16;

const CODES = 0;
const LENS = 1;
const DISTS = 2;

/**
 * Canonical Huffman code: a root-bits lookup table of `symbol << 4 | length`
 * (0 = no code of at most root bits starts here), plus the counts and sorted
 * symbols that decode longer codes canonically.
 */
interface Huffman {
  fast: Uint16Array;
  mask: number;
  count: Uint16Array;
  symbols: Uint16Array;
}

function huffman(root: number): Huffman {
  return { fast: new Uint16Array(1 << root), mask: 0, count: new Uint16Array(16), symbols: new Uint16Array(288) };
}

const REV8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) r |= ((i >>> b) & 1) << (7 - b);
  REV8[i] = r;
}

const offsets = new Uint16Array(16);

function fail(message: string): never {
  throw new DecodeError("packed", `deflate: ${message}`);
}

function overflow(max: number): never {
  fail(`output exceeds ${max} bytes`);
}

/** zlib's inftrees rules: no over-subscription; incomplete only for a lone 1-bit literal/length or distance code. */
function build(h: Huffman, lengths: Uint8Array, start: number, n: number, root: number, kind: number): void {
  const { count, symbols, fast } = h;
  count.fill(0);
  for (let i = 0; i < n; i++) count[lengths[start + i]!]!++;
  count[0] = 0;
  let max = 15;
  while (max > 0 && count[max] === 0) max--;
  if (max === 0) {
    // zlib accepts an empty distance set and fails only if a distance is decoded
    if (kind !== DISTS) fail(kind === CODES ? "empty code lengths set" : "empty literal/length set");
    fast.fill(0, 0, 2);
    h.mask = 1;
    return;
  }
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - count[len]!;
    if (left < 0) fail("over-subscribed code set");
  }
  if (left > 0 && (kind === CODES || max !== 1)) fail("incomplete code set");
  offsets[1] = 0;
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len]! + count[len]!;
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[start + sym]!;
    if (len !== 0) symbols[offsets[len]!++] = sym;
  }
  const bits = Math.min(root, max);
  const size = 1 << bits;
  fast.fill(0, 0, size);
  h.mask = size - 1;
  let code = 0;
  let index = 0;
  for (let len = 1; len <= bits; len++) {
    for (let k = count[len]!; k > 0; k--) {
      const rev = ((REV8[code & 0xff]! << 8) | REV8[code >>> 8]!) >>> (16 - len);
      const entry = (symbols[index++]! << 4) | len;
      for (let j = rev; j < size; j += 1 << len) fast[j] = entry;
      code++;
    }
    code <<= 1;
  }
}

function peek(buf: Uint8Array, pos: number): number {
  const p = pos >>> 3;
  return (buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16) | (buf[p + 3]! << 24)) >>> (pos & 7);
}

/** Canonical bit-by-bit decode for codes longer than the root table; -1 when no code matches. */
function slow(h: Huffman, buf: Uint8Array, pos: number): number {
  const { count, symbols } = h;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++, pos++) {
    code |= (buf[pos >>> 3]! >>> (pos & 7)) & 1;
    const c = count[len]!;
    if (code - c < first) return (symbols[index + code - first]! << 4) | len;
    index += c;
    first = (first + c) << 1;
    code <<= 1;
  }
  return -1;
}

let fixed: { lit: Huffman; dist: Huffman } | undefined;

function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixed) {
    const lens = new Uint8Array(320);
    lens.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288).fill(5, 288, 320);
    const lit = huffman(LIT_ROOT);
    const dist = huffman(DIST_ROOT);
    build(lit, lens, 0, 288, LIT_ROOT, LENS);
    build(dist, lens, 288, 32, DIST_ROOT, DISTS);
    fixed = { lit, dist };
  }
  return fixed;
}

const dynLit = huffman(LIT_ROOT);
const dynDist = huffman(DIST_ROOT);
const dynCodes = huffman(CLEN_ROOT);
const codeLengths = new Uint8Array(19);
const symbolLengths = new Uint8Array(286 + 30);

/**
 * Raw DEFLATE (RFC 1951) inflater for runtimes without node:zlib. Accepts exactly
 * the streams zlib accepts as one complete stream (same code-set rules, nothing
 * after the final block) and fails as soon as output would pass `maxOutputLength`.
 */
export function inflateRaw(data: Uint8Array, maxOutputLength: number): Uint8Array {
  const n = data.length;
  if (n > MAX_INPUT) fail("input too large");
  const buf = new Uint8Array(n + PAD);
  buf.set(data);
  const tbits = n * 8;
  // a 258-byte match costs at least two bits, so no stream expands past 1032:1
  const out = new Uint8Array(Math.min(maxOutputLength, n * 1032));
  const cap = out.length;
  let o = 0;
  let pos = 0;
  let last = 0;
  while (last === 0) {
    const header = peek(buf, pos);
    last = header & 1;
    const type = (header >>> 1) & 3;
    pos += 3;
    if (pos > tbits) fail("truncated");
    if (type === 0) {
      let p = (pos + 7) >>> 3;
      if (p + 4 > n) fail("truncated stored block");
      const len = buf[p]! | (buf[p + 1]! << 8);
      if ((len ^ 0xffff) !== (buf[p + 2]! | (buf[p + 3]! << 8))) fail("invalid stored block lengths");
      p += 4;
      if (p + len > n) fail("truncated stored block");
      if (o + len > cap) overflow(maxOutputLength);
      out.set(data.subarray(p, p + len), o);
      o += len;
      pos = (p + len) * 8;
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      ({ lit, dist } = fixedTables());
    } else if (type === 2) {
      const w = peek(buf, pos);
      const nlen = (w & 31) + 257;
      const ndist = ((w >>> 5) & 31) + 1;
      const ncode = ((w >>> 10) & 15) + 4;
      pos += 14;
      if (nlen > 286 || ndist > 30) fail("too many length or distance symbols");
      codeLengths.fill(0);
      for (let i = 0; i < ncode; i++, pos += 3) codeLengths[CLEN_ORDER[i]!] = peek(buf, pos) & 7;
      if (pos > tbits) fail("truncated");
      build(dynCodes, codeLengths, 0, 19, CLEN_ROOT, CODES);
      const cfast = dynCodes.fast;
      const cmask = dynCodes.mask;
      const total = nlen + ndist;
      let i = 0;
      while (i < total) {
        if (pos > tbits) fail("truncated");
        let w2 = peek(buf, pos);
        const e = cfast[w2 & cmask]!;
        if (e === 0) fail("invalid code lengths code");
        pos += e & 15;
        w2 >>>= e & 15;
        const sym = e >>> 4;
        if (sym < 16) {
          symbolLengths[i++] = sym;
          continue;
        }
        let value = 0;
        let rep: number;
        if (sym === 16) {
          if (i === 0) fail("repeat with no previous length");
          value = symbolLengths[i - 1]!;
          rep = 3 + (w2 & 3);
          pos += 2;
        } else if (sym === 17) {
          rep = 3 + (w2 & 7);
          pos += 3;
        } else {
          rep = 11 + (w2 & 127);
          pos += 7;
        }
        if (i + rep > total) fail("repeat past the code lengths");
        symbolLengths.fill(value, i, i + rep);
        i += rep;
      }
      if (pos > tbits) fail("truncated");
      if (symbolLengths[256] === 0) fail("missing end-of-block code");
      build(dynLit, symbolLengths, 0, nlen, LIT_ROOT, LENS);
      build(dynDist, symbolLengths, nlen, ndist, DIST_ROOT, DISTS);
      lit = dynLit;
      dist = dynDist;
    } else {
      fail("invalid block type");
    }
    const lfast = lit.fast;
    const lmask = lit.mask;
    const dfast = dist.fast;
    const dmask = dist.mask;
    for (;;) {
      if (pos > tbits) fail("truncated");
      const w = peek(buf, pos);
      let e = lfast[w & lmask]!;
      if (e === 0) {
        e = slow(lit, buf, pos);
        if (e < 0) fail("invalid literal/length code");
      }
      const elen = e & 15;
      pos += elen;
      const sym = e >>> 4;
      if (sym < 256) {
        if (o === cap) overflow(maxOutputLength);
        out[o++] = sym;
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= 29) fail("invalid literal/length code");
      const lx = LEN_EXTRA[li]!;
      // a literal/length code and its extra bits fit the 25 bits peeked
      const len = LEN_BASE[li]! + ((w >>> elen) & ((1 << lx) - 1));
      pos += lx;
      let d = dfast[peek(buf, pos) & dmask]!;
      if (d === 0) {
        d = slow(dist, buf, pos);
        if (d < 0) fail("invalid distance code");
      }
      pos += d & 15;
      const ds = d >>> 4;
      if (ds >= 30) fail("invalid distance code");
      const dx = DIST_EXTRA[ds]!;
      const distance = DIST_BASE[ds]! + (peek(buf, pos) & ((1 << dx) - 1));
      pos += dx;
      if (distance > o) fail("distance too far back");
      const end = o + len;
      if (end > cap) overflow(maxOutputLength);
      let from = o - distance;
      if (len <= 32) {
        while (o < end) out[o++] = out[from++]!;
      } else if (distance === 1) {
        out.fill(out[from]!, o, end);
        o = end;
      } else {
        // an overlapping copy repeats its period, so each pass can copy all of it written so far
        while (o < end) {
          const span = Math.min(o - from, end - o);
          out.copyWithin(o, from, from + span);
          o += span;
        }
      }
    }
  }
  if (pos > tbits) fail("truncated");
  if ((pos + 7) >>> 3 !== n) fail("trailing bytes after the final block");
  return o === cap ? out : out.slice(0, o);
}
