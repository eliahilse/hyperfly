import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import vectors from "../../../spec/vectors/columnar.json" with { type: "json" };
import { compileIR, defaultPackHooks, HyperflyError, type IRNode } from "../src/index.js";
import { DecodeError } from "../src/errors.js";
import { inflateRaw } from "../src/inflate.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const WORDS = "the of and to in is that for it as with was on be by at this from or which an are have not but".split(" ");

function text(rng: () => number, size: number): Uint8Array {
  const parts: string[] = [];
  let length = 0;
  while (length < size) {
    const word = WORDS[Math.floor(rng() * WORDS.length)]!;
    const piece = rng() < 0.08 ? `${word}. ` : rng() < 0.02 ? `${word} ${Math.floor(rng() * 1e6)} ` : `${word} `;
    parts.push(piece);
    length += piece.length;
  }
  return new TextEncoder().encode(parts.join("")).subarray(0, size);
}

function random(rng: () => number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function repetitive(rng: () => number, size: number): Uint8Array {
  const unit = random(rng, 1 + Math.floor(rng() * 7));
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = rng() < 0.001 ? 0x7f : unit[i % unit.length]!;
  return out;
}

/** zlib's verdict on "exactly one stream, at most `cap` bytes out": the bytes, or null. */
function zlibInflate(data: Uint8Array, cap: number): Uint8Array | null {
  try {
    const { buffer, engine } = zlib.inflateRawSync(data, { maxOutputLength: cap + 1, info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (engine.bytesWritten !== data.length || buffer.length > cap) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

function oursInflate(data: Uint8Array, cap: number): Uint8Array | null {
  try {
    return inflateRaw(data, cap);
  } catch (err) {
    if (!(err instanceof DecodeError) || err.code !== "packed") throw err;
    return null;
  }
}

function expectAgree(data: Uint8Array, cap: number, context = ""): Uint8Array | null {
  const theirs = zlibInflate(data, cap);
  const ours = oursInflate(data, cap);
  if ((theirs === null) !== (ours === null) || (theirs && ours && !Buffer.from(theirs).equals(Buffer.from(ours)))) {
    throw new Error(
      `${context} cap ${cap}: zlib ${theirs ? `accepts ${theirs.length}` : "rejects"}, ours ${ours ? `accepts ${ours.length}` : "rejects"}: ${hex(data).slice(0, 400)}`,
    );
  }
  return ours;
}

class Bits {
  private readonly bytes: number[] = [];
  private acc = 0;
  private count = 0;

  put(value: number, n: number): this {
    for (let i = 0; i < n; i++) {
      this.acc |= ((value >>> i) & 1) << this.count;
      if (++this.count === 8) this.flushByte();
    }
    return this;
  }

  /** Huffman codes go most significant bit first. */
  code(code: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.put((code >>> i) & 1, 1);
    return this;
  }

  align(): this {
    if (this.count > 0) this.flushByte();
    return this;
  }

  raw(bytes: ArrayLike<number>): this {
    this.align();
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]!);
    return this;
  }

  finish(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }

  private flushByte(): void {
    this.bytes.push(this.acc);
    this.acc = 0;
    this.count = 0;
  }
}

/** Canonical codes for a list of code lengths (RFC 1951 §3.2.2). */
function canonical(lengths: readonly number[]): number[] {
  const count = new Array<number>(16).fill(0);
  for (const len of lengths) if (len) count[len]!++;
  const next = new Array<number>(16).fill(0);
  let code = 0;
  for (let len = 1; len < 16; len++) {
    code = (code + count[len - 1]!) << 1;
    next[len] = code;
  }
  return lengths.map((len) => (len ? next[len]!++ : -1));
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

function lengthCode(len: number): { sym: number; extra: number; bits: number } {
  let i = LEN_BASE.length - 1;
  while (LEN_BASE[i]! > len) i--;
  return { sym: 257 + i, extra: len - LEN_BASE[i]!, bits: LEN_EXTRA[i]! };
}

function fixedLit(w: Bits, sym: number): Bits {
  if (sym < 144) return w.code(0x30 + sym, 8);
  if (sym < 256) return w.code(0x190 + sym - 144, 9);
  if (sym < 280) return w.code(sym - 256, 7);
  return w.code(0xc0 + sym - 280, 8);
}

function fixedMatch(w: Bits, len: number, distSym: number, distExtra = 0, distBits = 0): Bits {
  const { sym, extra, bits } = lengthCode(len);
  fixedLit(w, sym).put(extra, bits);
  return w.code(distSym, 5).put(distExtra, distBits);
}

interface Dynamic {
  final?: boolean;
  lit: number[];
  dist: number[];
  /** raw HLIT/HDIST field values, defaulting to the array lengths */
  hlit?: number;
  hdist?: number;
  /** code-length symbols with their extra bits, replacing the plain listing of `lit` and `dist` */
  sequence?: [number, number?][];
  /** code-length code lengths by symbol (0…18) */
  clen?: number[];
}

/** A dynamic block header; returns the literal/length and distance codes for the body. */
function dynamicHeader(w: Bits, d: Dynamic): { lit: number[]; dist: number[] } {
  const clen = d.clen ?? [...new Array<number>(16).fill(4), 0, 0, 0];
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  w.put(d.final === false ? 0 : 1, 1).put(2, 2);
  w.put((d.hlit ?? d.lit.length) - 257, 5).put((d.hdist ?? d.dist.length) - 1, 5).put(19 - 4, 4);
  for (const sym of order) w.put(clen[sym]!, 3);
  const ccodes = canonical(clen);
  const sequence = d.sequence ?? [...d.lit, ...d.dist].map((len): [number, number?] => [len]);
  for (const [sym, extra] of sequence) {
    w.code(ccodes[sym]!, clen[sym]!);
    if (sym === 16) w.put(extra ?? 0, 2);
    if (sym === 17) w.put(extra ?? 0, 3);
    if (sym === 18) w.put(extra ?? 0, 7);
  }
  return { lit: canonical(d.lit), dist: canonical(d.dist) };
}

function lengths(n: number, set: Record<number, number>): number[] {
  const out = new Array<number>(n).fill(0);
  for (const [sym, len] of Object.entries(set)) out[Number(sym)] = len;
  return out;
}

const deflate = (data: Uint8Array, options: zlib.ZlibOptions = {}): Uint8Array =>
  new Uint8Array(zlib.deflateRawSync(data, options));

describe("inflateRaw: valid streams match node:zlib", () => {
  const { Z_DEFAULT_STRATEGY, Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_SYNC_FLUSH } = zlib.constants;
  const strategies = [Z_DEFAULT_STRATEGY, Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED];

  test("levels and strategies over varied inputs", () => {
    const rng = mulberry32(0x1f1a7e);
    const inputs: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ["one byte", Uint8Array.of(0x41)],
      ["zero byte", Uint8Array.of(0)],
    ];
    for (const size of [100, 5000, 70_000]) {
      inputs.push([`text ${size}`, text(rng, size)]);
      inputs.push([`random ${size}`, random(rng, size)]);
      inputs.push([`repetitive ${size}`, repetitive(rng, size)]);
    }
    inputs.push(["text 300k", text(rng, 300_000)], ["repetitive 300k", repetitive(rng, 300_000)]);
    let streams = 0;
    for (const [name, input] of inputs) {
      for (const level of [0, 1, 6, 9]) {
        for (const strategy of strategies) {
          if (input.length > 100_000 && level !== 6 && strategy !== Z_DEFAULT_STRATEGY) continue;
          const stream = deflate(input, { level, strategy });
          const out = expectAgree(stream, input.length, `${name} level ${level} strategy ${strategy}`);
          expect(out).not.toBeNull();
          expect(Buffer.from(out!).equals(Buffer.from(input))).toBe(true);
          streams++;
        }
      }
    }
    expect(streams).toBeGreaterThan(200);
  });

  test("random bytes 300k", () => {
    const input = random(mulberry32(7), 300_000);
    for (const level of [0, 6]) {
      const out = inflateRaw(deflate(input, { level }), input.length);
      expect(Buffer.from(out).equals(Buffer.from(input))).toBe(true);
    }
  });

  test("multi-block streams", () => {
    const rng = mulberry32(0xb10c);
    for (let i = 0; i < 40; i++) {
      const parts = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => {
        const size = Math.floor(rng() * 3000);
        return rng() < 0.5 ? text(rng, size) : repetitive(rng, size);
      });
      const chunks: Uint8Array[] = [];
      for (const [k, part] of parts.entries()) {
        const lastPart = k === parts.length - 1;
        const level = Math.floor(rng() * 10);
        const strategy = strategies[Math.floor(rng() * strategies.length)]!;
        if (!lastPart && rng() < 0.3 && part.length < 65536) {
          // a non-final stored block, byte aligned
          chunks.push(Uint8Array.of(0, part.length & 0xff, part.length >>> 8, ~part.length & 0xff, (~part.length >>> 8) & 0xff), part);
        } else {
          chunks.push(deflate(part, lastPart ? { level, strategy } : { level, strategy, finishFlush: Z_SYNC_FLUSH }));
        }
      }
      const stream = Buffer.concat(chunks);
      const expected = Buffer.concat(parts);
      const out = expectAgree(stream, expected.length, `multi-block ${i}`);
      expect(out && Buffer.from(out).equals(expected)).toBe(true);
    }
  });

  test("the cap is exact: equal passes, one short fails", () => {
    const input = text(mulberry32(3), 4000);
    const stream = deflate(input);
    expect(inflateRaw(stream, input.length).length).toBe(input.length);
    expect(inflateRaw(stream, input.length + 1000).length).toBe(input.length);
    expect(() => inflateRaw(stream, input.length - 1)).toThrow(DecodeError);
    expect(inflateRaw(Uint8Array.of(3, 0), 0).length).toBe(0);
  });

  test("a nonsensical cap is a DecodeError", () => {
    for (const cap of [-1, Number.NaN, 1.5, Infinity]) {
      expect(() => inflateRaw(Uint8Array.of(3, 0), cap)).toThrow(DecodeError);
    }
  });

  test("output grows across buffer boundaries without losing bytes", () => {
    const rng = mulberry32(11);
    for (const size of [4095, 4096, 4097, 8193, 100_003, 1_000_000]) {
      const input = new Uint8Array(size).map((_, i) => (i % 7 === 0 ? Math.floor(rng() * 256) : 0x61));
      const stream = deflate(input);
      for (const cap of [size, size + 12_345]) {
        expect(Buffer.from(inflateRaw(stream, cap)).equals(Buffer.from(input))).toBe(true);
      }
      expect(() => inflateRaw(stream, size - 1)).toThrow(DecodeError);
    }
  });
});

describe("inflateRaw: hostile streams get zlib's verdict", () => {
  test("mutations of valid streams", () => {
    for (const seed of [1, 2, 3]) {
      const rng = mulberry32(0x5eed0000 + seed);
      const bases: Uint8Array[] = [];
      const inputs: Uint8Array[] = [];
      for (let i = 0; i < 12; i++) {
        const size = Math.floor(rng() * 600);
        const input = i % 3 === 0 ? text(rng, size) : i % 3 === 1 ? repetitive(rng, size) : random(rng, size);
        const level = [0, 1, 6, 9][i % 4]!;
        const strategy = [0, 1, 2, 3, 4][Math.floor(rng() * 5)]!;
        inputs.push(input);
        bases.push(deflate(input, { level, strategy }));
      }
      for (let i = 0; i < 3000; i++) {
        const k = Math.floor(rng() * bases.length);
        const base = bases[k]!;
        let bytes = new Uint8Array(base);
        const kind = Math.floor(rng() * 5);
        if (kind === 0 && bytes.length > 0) {
          for (let m = 1 + Math.floor(rng() * 3); m > 0; m--) bytes[Math.floor(rng() * bytes.length)] = Math.floor(rng() * 256);
        } else if (kind === 1 && bytes.length > 0) {
          for (let m = 1 + Math.floor(rng() * 2); m > 0; m--) bytes[Math.floor(rng() * bytes.length)]! ^= 1 << Math.floor(rng() * 8);
        } else if (kind === 2) {
          bytes = bytes.subarray(0, Math.floor(rng() * bytes.length));
        } else if (kind === 3) {
          bytes = Buffer.concat([bytes, random(rng, 1 + Math.floor(rng() * 4))]);
        } else if (bytes.length > 0) {
          bytes[Math.floor(rng() * Math.min(4, bytes.length))]! ^= 1 << Math.floor(rng() * 8);
        }
        const exact = inputs[k]!.length;
        const cap = rng() < 0.8 ? exact : Math.floor(rng() * (exact + 50));
        expectAgree(bytes, cap, `seed ${seed} mutation ${i}`);
      }
    }
  });

  test("random byte strings", () => {
    const rng = mulberry32(0xacce55);
    for (let i = 0; i < 4000; i++) {
      const bytes = random(rng, Math.floor(rng() * 24));
      // a fixed final block header makes some of them decode
      if (i % 2 === 0 && bytes.length > 0) bytes[0] = (bytes[0]! & 0xf8) | 0x03;
      expectAgree(bytes, 1 << 16, `random ${i}`);
    }
  });

  test("every truncation of a multi-block stream", () => {
    const input = text(mulberry32(11), 20_000);
    const stream = deflate(input, { level: 9 });
    for (let cut = 0; cut < stream.length; cut++) {
      expect(expectAgree(stream.subarray(0, cut), input.length, `cut ${cut}`)).toBeNull();
    }
  });

  const cases: [string, Uint8Array, number, boolean][] = [];
  const add = (name: string, data: Uint8Array, accepted: boolean, cap = 1 << 16): void => {
    cases.push([name, data, cap, accepted]);
  };

  add("empty input", new Uint8Array(0), false);
  add("empty fixed block", fixedLit(new Bits().put(1, 1).put(1, 2), 256).finish(), true);
  add("empty stored block", Uint8Array.of(1, 0, 0, 0xff, 0xff), true);
  add("invalid block type 3", new Bits().put(1, 1).put(3, 2).finish(), false);
  add("invalid block type 3 after a stored block", Uint8Array.of(0, 0, 0, 0xff, 0xff, 0x07), false);
  add("stored LEN/NLEN mismatch", Uint8Array.of(1, 2, 0, 0xfd, 0xfe, 0x61, 0x62), false);
  add("stored block truncated", Uint8Array.of(1, 3, 0, 0xfc, 0xff, 0x61, 0x62), false);
  add("stored header truncated", Uint8Array.of(1, 3, 0, 0xfc), false);
  add("stored with nonzero padding bits", Uint8Array.of(0xf9, 1, 0, 0xfe, 0xff, 0x61), true);
  add("non-final block only", Uint8Array.of(0, 0, 0, 0xff, 0xff), false);
  add("trailing byte", Uint8Array.of(3, 0, 0), false);
  add("trailing empty stored block", Uint8Array.of(3, 0, 1, 0, 0, 0xff, 0xff), false);
  add("trailing byte after zlib stream", Buffer.concat([deflate(new TextEncoder().encode("hello hello")), Uint8Array.of(0)]), false);
  add("missing end-of-block (fixed)", fixedLit(fixedLit(new Bits().put(1, 1).put(1, 2), 0x61), 0x62).finish(), false);
  add("literal/length symbol 286", fixedLit(fixedLit(new Bits().put(1, 1).put(1, 2), 0x61), 286).finish(), false);
  add("literal/length symbol 287", fixedLit(fixedLit(new Bits().put(1, 1).put(1, 2), 0x61), 287).finish(), false);
  for (const ds of [30, 31]) {
    const w = fixedLit(new Bits().put(1, 1).put(1, 2), 0x61);
    add(`distance symbol ${ds}`, fixedLit(fixedMatch(w, 3, ds), 256).finish(), false);
  }
  {
    const w = fixedLit(fixedLit(new Bits().put(1, 1).put(1, 2), 0x61), 0x62);
    add("distance past window start", fixedLit(fixedMatch(w, 3, 2, 0, 0), 256).finish(), false);
  }
  {
    const w = fixedLit(fixedLit(new Bits().put(1, 1).put(1, 2), 0x61), 0x62);
    add("distance to window start", fixedLit(fixedMatch(w, 3, 1, 0, 0), 256).finish(), true);
  }
  {
    const w = fixedLit(new Bits().put(1, 1).put(1, 2), 0x61);
    for (let i = 0; i < 4; i++) fixedMatch(w, 258, 0);
    const stream = fixedLit(w, 256).finish();
    add("cap hit mid-match", stream, false, 300);
    add("cap one short of a run", stream, false, 1 + 4 * 258 - 1);
    add("cap exactly a run", stream, true, 1 + 4 * 258);
  }
  {
    const w = fixedLit(new Bits().put(1, 1).put(1, 2), 0x61);
    add("length 258 via code 284 extra 31", fixedLit(fixedLit(w, 284).put(31, 5).code(0, 5), 256).finish(), true);
  }

  // dynamic blocks; literal/length lengths are listed for symbols 0…hlit-1
  const litAEob = lengths(257, { 0x61: 1, 256: 1 });
  {
    const w = new Bits();
    const { lit } = dynamicHeader(w, { lit: litAEob, dist: [0] });
    add("dynamic, no distance codes", w.code(lit[0x61]!, 1).code(lit[256]!, 1).finish(), true);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: lengths(257, { 256: 1 }), dist: [0] });
    add("lone 1-bit end-of-block code (incomplete, accepted)", w.code(0, 1).finish(), true);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: lengths(257, { 256: 1 }), dist: [0] });
    add("lone end-of-block code, unused code read", w.code(1, 1).finish(), false);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: lengths(257, { 256: 2 }), dist: [0] });
    add("lone 2-bit end-of-block code (incomplete)", w.code(0, 2).finish(), false);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: lengths(257, { 0x61: 2, 256: 2 }), dist: [0] });
    add("incomplete literal/length set", w.code(0, 2).code(1, 2).finish(), false);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: lengths(257, { 0x61: 1, 0x62: 1, 256: 1 }), dist: [0] });
    add("over-subscribed literal/length set", w.code(0, 1).code(1, 1).finish(), false);
  }
  const litMatch = lengths(258, { 0x61: 2, 256: 2, 257: 1 });
  for (const [name, dist, accepted, distCode] of [
    ["single 1-bit distance code (accepted)", [1], true, 0],
    ["single 1-bit distance code, unused code read", [1], false, 1],
    ["single 1-bit distance code at symbol 3", [0, 0, 0, 1], true, 0],
    ["single 2-bit distance code", [2], false, 0],
    ["incomplete distance set", [1, 2], false, 0],
    ["over-subscribed distance set", [1, 1, 1], false, 0],
    ["all-zero distance set used", [0], false, 0],
  ] as const) {
    const w = new Bits();
    const { lit } = dynamicHeader(w, { lit: litMatch, dist: [...dist] });
    for (let i = 0; i < 4; i++) w.code(lit[0x61]!, 2);
    w.code(lit[257]!, 1).code(distCode, dist.find((len) => len > 0) ?? 1);
    add(name, w.code(lit[256]!, 2).finish(), accepted);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: litAEob, dist: [0], hlit: 287 });
    add("HLIT 287", w.finish(), false);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: litAEob, dist: [0], hlit: 286 });
    add("HLIT 286 (truncated body)", w.finish(), false);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: litAEob, dist: new Array<number>(31).fill(0) });
    add("HDIST 31", w.code(0, 1).code(1, 1).finish(), false);
  }
  {
    const w = new Bits();
    const { lit } = dynamicHeader(w, { lit: litAEob, dist: new Array<number>(30).fill(0) });
    add("HDIST 30", w.code(lit[0x61]!, 1).code(lit[256]!, 1).finish(), true);
  }
  // a complete code-length code over 0, 1, 2 and the three run codes
  const clen = new Array<number>(19).fill(0);
  clen[0] = 2;
  clen[16] = 2;
  clen[17] = 2;
  clen[18] = 3;
  clen[1] = 3;
  clen[2] = 4;
  clen[18] = 4;
  {
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 1, clen, sequence: [[16, 0], [18, 127]] });
    add("repeat 16 first", w.finish(), false);
  }
  {
    const seq: [number, number?][] = [[18, 0x61 - 11], [1], [18, 127], [18, 256 - 0x62 - 138 - 11], [1], [18, 127]];
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 1, clen, sequence: seq });
    add("repeat past the end", w.code(0, 1).code(1, 1).finish(), false);
  }
  {
    const seq: [number, number?][] = [[18, 0x61 - 11], [1], [18, 127], [18, 256 - 0x62 - 138 - 11], [1], [0]];
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 1, clen, sequence: seq });
    add("zero-run code lengths", w.code(0, 1).code(1, 1).finish(), true);
  }
  {
    const seq: [number, number?][] = [[18, 0x61 - 11], [1], [18, 127], [18, 256 - 0x62 - 138 - 11], [1], [16, 0]];
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 1, clen, sequence: seq });
    add("repeat 16 across the literal/distance boundary, past the end", w.finish(), false);
  }
  {
    const seq: [number, number?][] = [[18, 0x61 - 11], [1], [18, 127], [18, 254 - 236 - 11], [0], [2], [2], [16, 0], [2]];
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 4, clen, sequence: seq });
    add("repeat 16 across the literal/distance boundary", w.code(0, 1).code(3, 2).finish(), true);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: lengths(257, { 0x61: 1 }), dist: [0] });
    add("missing end-of-block code (dynamic)", w.code(0, 1).finish(), false);
  }
  {
    const bad = [...new Array<number>(16).fill(4), 0, 0, 1];
    const w = new Bits();
    dynamicHeader(w, { lit: litAEob, dist: [0], clen: bad });
    add("over-subscribed code-length code", w.finish(), false);
  }
  {
    const bad = [...new Array<number>(15).fill(4), 0, 0, 0, 0];
    const w = new Bits();
    dynamicHeader(w, { lit: litAEob, dist: [0], clen: bad });
    add("incomplete code-length code", w.finish(), false);
  }
  {
    const lone = new Array<number>(19).fill(0);
    lone[18] = 1;
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 1, clen: lone, sequence: [[18, 127], [18, 127]] });
    add("lone 1-bit code-length code", w.finish(), false);
  }
  {
    const w = new Bits();
    dynamicHeader(w, { lit: [], dist: [], hlit: 257, hdist: 1, clen: new Array<number>(19).fill(0), sequence: [] });
    add("all-zero code-length code", w.put(0, 64).finish(), false);
  }

  for (const [name, data, cap, accepted] of cases) {
    test(name, () => {
      const out = expectAgree(data, cap, name);
      expect(out !== null).toBe(accepted);
    });
  }
});

describe("inflateRaw: bombs stop at the cap", () => {
  const bomb = (size: number): Uint8Array => deflate(new Uint8Array(size), { level: 9 });

  test("1000x and 10000x bombs reject in constant time", () => {
    for (const size of [1_000_000, 10_000_000]) {
      const stream = bomb(size);
      expect(stream.length).toBeLessThan(size / 900);
      inflateRaw(stream, size);
      const start = performance.now();
      expect(() => inflateRaw(stream, 1024)).toThrow(DecodeError);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  test("a run of long matches is cut off mid-match", () => {
    const w = fixedLit(new Bits().put(1, 1).put(1, 2), 0x61);
    for (let i = 0; i < 100_000; i++) fixedMatch(w, 258, 0);
    const stream = fixedLit(w, 256).finish();
    const start = performance.now();
    expect(() => inflateRaw(stream, 1000)).toThrow(DecodeError);
    expect(performance.now() - start).toBeLessThan(50);
    expect(inflateRaw(stream, 1 + 258 * 100_000).length).toBe(1 + 258 * 100_000);
  });
});

describe("pack hooks", () => {
  const IR: IRNode = { kind: "array", element: { kind: "struct", fields: [{ name: "body", type: { kind: "string" } }] } };
  const prose = Array.from({ length: 60 }, (_, i) => ({
    body: `report ${i}: the quick brown fox jumps over the lazy dog, and the dog files a complaint about the fox`,
  }));

  test("packed golden vectors decode identically through node:zlib and inflateRaw", () => {
    for (const v of vectors.packedDecode) {
      const node = compileIR(v.ir as IRNode, { plan: "columnar" });
      const pure = compileIR(v.ir as IRNode, { plan: "columnar", pack: { inflate: inflateRaw } });
      expect(pure.decodeBody(fromHex(v.hex))).toEqual(node.decodeBody(fromHex(v.hex)));
      expect(pure.decodeBody(fromHex(v.hex))).toEqual(v.value);
    }
    for (const v of vectors.invalidDecode.filter((x) => x.error === "packed")) {
      const pure = compileIR(v.ir as IRNode, { plan: "columnar", pack: { inflate: inflateRaw } });
      expect(() => pure.decodeBody(fromHex(v.hex))).toThrow(DecodeError);
      try {
        pure.decodeBody(fromHex(v.hex));
      } catch (err) {
        expect((err as DecodeError).code).toBe("packed");
      }
    }
  });

  test("node-packed payloads decode through inflateRaw", () => {
    const node = compileIR(IR, { plan: "columnar" });
    const pure = compileIR(IR, { plan: "columnar", pack: { inflate: inflateRaw } });
    const bytes = node.encode(prose);
    expect(bytes.length).toBeLessThan(compileIR(IR, { plan: "columnar", pack: false }).encode(prose).length);
    expect(pure.decode(bytes)).toEqual(prose);
  });

  test("mutated packed payloads never escape HyperflyError and agree across hooks", () => {
    const rng = mulberry32(0xdeadbea7);
    const node = compileIR(IR, { plan: "columnar" });
    const pure = compileIR(IR, { plan: "columnar", pack: { inflate: inflateRaw } });
    const valid = node.encodeBody(prose);
    const run = (codec: typeof pure, bytes: Uint8Array): unknown => {
      try {
        return codec.decodeBody(bytes);
      } catch (err) {
        if (err instanceof HyperflyError) return err.code;
        throw err;
      }
    };
    for (let i = 0; i < 3000; i++) {
      const bytes = new Uint8Array(valid);
      for (let m = 1 + Math.floor(rng() * 3); m > 0; m--) {
        const at = rng() < 0.7 ? valid.length - 1 - Math.floor(rng() * 400) : Math.floor(rng() * valid.length);
        bytes[Math.max(0, at)] = Math.floor(rng() * 256);
      }
      const cut = rng() < 0.1 ? bytes.subarray(0, Math.floor(rng() * bytes.length)) : bytes;
      expect(run(pure, cut)).toEqual(run(node, cut) as never);
    }
  });

  test("default hooks throw DecodeError('packed') with the zlib error as cause", () => {
    const { inflate } = defaultPackHooks();
    const stream = deflate(new TextEncoder().encode("hello hello hello"));
    expect(inflate!(stream, 17)).toEqual(new TextEncoder().encode("hello hello hello"));
    const failures: [Uint8Array, number][] = [
      [stream.subarray(0, stream.length - 1), 17],
      [Buffer.concat([stream, Uint8Array.of(0)]), 17],
      [stream, 16],
      [Uint8Array.of(0xff), 10],
    ];
    for (const [data, cap] of failures) {
      let caught: unknown;
      try {
        inflate!(data, cap);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DecodeError);
      expect((caught as DecodeError).code).toBe("packed");
      if (data.length === 1) expect((caught as Error).cause).toBeInstanceOf(Error);
    }
  });

  test("without node:zlib the hooks fall back to inflateRaw and still decode packed payloads", () => {
    const packed = compileIR(IR, { plan: "columnar" }).encode(prose);
    const proc = process as unknown as { getBuiltinModule?: unknown };
    const original = proc.getBuiltinModule;
    let edge: ReturnType<typeof compileIR>;
    let hooks: ReturnType<typeof defaultPackHooks>;
    try {
      proc.getBuiltinModule = undefined;
      hooks = defaultPackHooks();
      edge = compileIR(IR, { plan: "columnar" });
    } finally {
      proc.getBuiltinModule = original;
    }
    expect(hooks.deflate).toBeUndefined();
    expect(hooks.inflate).toBe(inflateRaw);
    expect(edge.decode(packed)).toEqual(prose);
    const plain = edge.encode(prose);
    expect(edge.decode(plain)).toEqual(prose);
    expect(plain).toEqual(compileIR(IR, { plan: "columnar", pack: false }).encode(prose));
    expect(compileIR(IR, { plan: "columnar" }).decode(plain)).toEqual(prose);
    expect(plain.length).toBeGreaterThan(packed.length);
  });

  test("the inflater imports nothing from the host runtime", () => {
    for (const file of ["inflate.ts", "errors.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of specifiers) expect(spec).toMatch(/^\.\/[a-z]+\.js$/);
      expect(source).not.toMatch(/\b(process|require|Buffer)\b/);
    }
  });
});
