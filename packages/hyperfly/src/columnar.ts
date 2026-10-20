import { decodeNode, enterArray, type Inflate } from "./decode.js";
import { chargeBytes, checkAmplification, chargeItems, encodeNode, typeAcceptsNull, utf8Bytes, writeBitmap, type EncodeCtx } from "./encode.js";
import { DecodeError, EncodeError } from "./errors.js";
import { literalBytes, utf8Length, utf8Lengths, type IRField, type IRNode } from "./ir.js";
import type { GrammarToken, ProfileIndex } from "./profile.js";
import type { Reader } from "./reader.js";
import { INT_MAX, INT_MIN, readUleb, ulebLen, unzigzag, writeUleb, zigzag } from "./varint.js";
import { Writer } from "./writer.js";

type ArrayNode = Extract<IRNode, { kind: "array" }>;
type StructNode = Extract<IRNode, { kind: "struct" }>;
type IntNode = Extract<IRNode, { kind: "int" }>;

const COLUMN_KINDS = new Set(["bool", "int", "float64", "string", "bytes", "enum", "literal"]);

export interface Leaf {
  segs: readonly string[];
  field: IRField;
}

/**
 * Depth-first leaf columns in declared order. Nested structs flatten only when
 * required and non-nullable, so every leaf inherits its row's participation.
 */
export function flattenLeaves(element: StructNode): Leaf[] | null {
  const out: Leaf[] = [];
  const walk = (node: StructNode, segs: string[]): boolean => {
    if (node.fields.length === 0) return false;
    for (const f of node.fields) {
      if (f.type.kind === "struct") {
        if (f.optional || f.nullable) return false;
        if (!walk(f.type, [...segs, f.name])) return false;
      } else if (COLUMN_KINDS.has(f.type.kind)) {
        out.push({ segs: [...segs, f.name], field: f });
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(element, []) ? out : null;
}

export function columnarEligible(node: ArrayNode): boolean {
  return node.element.kind === "struct" && flattenLeaves(node.element) !== null;
}

const scratch = new DataView(new ArrayBuffer(8));

function floatBits(value: number): bigint {
  scratch.setFloat64(0, value, true);
  return scratch.getBigUint64(0, true);
}

function bitsToFloat(bits: bigint): number {
  scratch.setBigUint64(0, bits, true);
  return scratch.getFloat64(0, true);
}

const NEG_ZERO_BITS = 0x8000000000000000n;

const MAX_WIDTH = 56;

/** Bits needed for an unsigned value; zero for zero, so a constant column packs to nothing. */
function bitWidth(max: bigint): number {
  let w = 0;
  let v = max;
  while (v > 0n) {
    v >>= 1n;
    w++;
  }
  return w;
}

function packedBytes(count: number, width: number): number {
  return Math.ceil((count * width) / 8);
}

/** Spec §3.1: little-endian bit stream, value i at bits [i*w, (i+1)*w). */
function packBits(w: Writer, values: readonly bigint[], width: number): void {
  if (width === 0) return;
  let acc = 0n;
  let bits = 0;
  for (const value of values) {
    acc |= value << BigInt(bits);
    bits += width;
    while (bits >= 8) {
      w.u8(Number(acc & 0xffn));
      acc >>= 8n;
      bits -= 8;
    }
  }
  if (bits > 0) w.u8(Number(acc & 0xffn));
}

/**
 * Spec §3.1 reader: consumes the packed bytes and checks the padding up front,
 * then hands values out one at a time, so a column is never expanded into an
 * intermediate array of bigints.
 */
function unpackBits(r: Reader, count: number, width: number, path: string): () => bigint {
  if (width > MAX_WIDTH) {
    throw new DecodeError("marker", `${path}: bit width ${width} exceeds ${MAX_WIDTH}`);
  }
  if (width === 0) return () => 0n;
  const bytes = r.bytes(packedBytes(count, width));
  // leftover bits are padding and must be zero, or one value would have two encodings
  const used = (count * width) % 8;
  if (used !== 0 && bytes[bytes.length - 1]! >> used !== 0) {
    throw new DecodeError("bitmap", `${path}: nonzero bit-packing padding`);
  }
  const mask = (1n << BigInt(width)) - 1n;
  const shift = BigInt(width);
  let acc = 0n;
  let bits = 0;
  let index = 0;
  return () => {
    while (bits < width) {
      acc |= BigInt(bytes[index++] ?? 0) << BigInt(bits);
      bits += 8;
    }
    const value = acc & mask;
    acc >>= shift;
    bits -= width;
    return value;
  };
}

/** A bitmap of `count` flags kept as its wire bytes, padding checked (wire-v0 §3.5). */
function readPackedBitmap(r: Reader, count: number, path: string): Uint8Array {
  const bytes = r.bytes(Math.ceil(count / 8));
  const used = count % 8;
  if (used !== 0 && bytes[bytes.length - 1]! >> used !== 0) {
    throw new DecodeError("bitmap", `${path}: nonzero bitmap padding`);
  }
  return bytes;
}

function bitAt(bytes: Uint8Array, i: number): boolean {
  return (bytes[i >> 3]! & (1 << (i & 7))) !== 0;
}

function popcount8(byte: number): number {
  const b = byte - ((byte >> 1) & 0x55);
  const c = (b & 0x33) + ((b >> 2) & 0x33);
  return (c + (c >> 4)) & 0x0f;
}

function popcount(bytes: Uint8Array): number {
  let n = 0;
  for (const byte of bytes) n += popcount8(byte);
  return n;
}

/** For each set flag, its index among the set flags; for each clear one, among the clear ones. */
function rankBits(bytes: Uint8Array, count: number): Int32Array {
  const rank = new Int32Array(count);
  let set = 0;
  let clear = 0;
  for (let i = 0; i < count; i++) rank[i] = bitAt(bytes, i) ? set++ : clear++;
  return rank;
}

export interface IntBounds {
  min?: bigint;
  max?: bigint;
}

function nodeBounds(node: IntNode): IntBounds {
  return {
    min: node.min === undefined ? undefined : BigInt(node.min),
    max: node.max === undefined ? undefined : BigInt(node.max),
  };
}

function intForm(bounds: IntBounds, value: bigint): bigint {
  return bounds.min !== undefined ? value - bounds.min : zigzag(value);
}

function checkInt(node: IntNode, value: unknown, path: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new EncodeError("type", `${path}: expected a safe integer`);
  }
  if (node.min !== undefined && value < node.min) {
    throw new EncodeError("range", `${path}: ${value} below declared min ${node.min}`);
  }
  if (node.max !== undefined && value > node.max) {
    throw new EncodeError("range", `${path}: ${value} above declared max ${node.max}`);
  }
  return BigInt(value);
}

interface PforCandidate {
  cost: number;
  lowWidth: number;
  highWidth: number;
  exceptions: boolean[];
  lows: bigint[];
  highs: bigint[];
}

function encodeIntColumn(w: Writer, bounds: IntBounds, values: readonly bigint[]): void {
  if (values.length === 0) {
    w.u8(0);
    return;
  }
  const exact = values;
  const forms = values.map((v) => intForm(bounds, v));
  const diffs: bigint[] = [];
  for (let i = 1; i < exact.length; i++) diffs.push(exact[i]! - exact[i - 1]!);

  const rawCost = forms.reduce((n, f) => n + ulebLen(f), 0);
  const deltaCost = ulebLen(forms[0]!) + diffs.reduce((n, d) => n + ulebLen(zigzag(d)), 0);

  // frame of reference: subtract the column minimum, then spend only the bits the
  // remaining span needs rather than a whole number of bytes per value
  const forBase = exact.reduce((m, v) => (v < m ? v : m), exact[0]!);
  const forWidth = bitWidth(exact.reduce((m, v) => (v - forBase > m ? v - forBase : m), 0n));
  const forCost =
    forWidth > MAX_WIDTH
      ? Infinity
      : ulebLen(zigzag(forBase)) + 1 + packedBytes(exact.length, forWidth);

  let deltaForCost = Infinity;
  let deltaBase = 0n;
  let deltaWidth = 0;
  if (diffs.length > 0) {
    deltaBase = diffs.reduce((m, d) => (d < m ? d : m), diffs[0]!);
    deltaWidth = bitWidth(diffs.reduce((m, d) => (d - deltaBase > m ? d - deltaBase : m), 0n));
    if (deltaWidth <= MAX_WIDTH) {
      deltaForCost =
        ulebLen(forms[0]!) + ulebLen(zigzag(deltaBase)) + 1 + packedBytes(diffs.length, deltaWidth);
    }
  }

  let pfor: PforCandidate | null = null;
  if (forWidth > 0 && forWidth <= MAX_WIDTH) {
    const offsets = exact.map((value) => value - forBase);
    for (let lowWidth = 0; lowWidth < forWidth; lowWidth++) {
      const lowMask = lowWidth === 0 ? 0n : (1n << BigInt(lowWidth)) - 1n;
      const lows = offsets.map((offset) => offset & lowMask);
      const highParts = offsets.map((offset) => offset >> BigInt(lowWidth));
      const exceptions = highParts.map((high) => high !== 0n);
      const highs = highParts.filter((high) => high !== 0n);
      const highWidth = bitWidth(highs.reduce((max, high) => (high > max ? high : max), 0n));
      const cost =
        ulebLen(zigzag(forBase)) +
        2 +
        packedBytes(exact.length, 1) +
        packedBytes(exact.length, lowWidth) +
        packedBytes(highs.length, highWidth);
      if (!pfor || cost < pfor.cost) {
        pfor = { cost, lowWidth, highWidth, exceptions, lows, highs };
      }
    }
  }

  const pforCost = pfor?.cost ?? Infinity;
  const best = Math.min(rawCost, deltaCost, forCost, deltaForCost, pforCost);
  if (best === rawCost) {
    w.u8(0x00);
    for (const f of forms) writeUleb(w, f);
    return;
  }
  if (best === deltaCost) {
    w.u8(0x01);
    writeUleb(w, forms[0]!);
    for (const d of diffs) writeUleb(w, zigzag(d));
    return;
  }
  if (best === forCost) {
    w.u8(0x02);
    writeUleb(w, zigzag(forBase));
    w.u8(forWidth);
    packBits(w, exact.map((v) => v - forBase), forWidth);
    return;
  }
  if (best === deltaForCost) {
    w.u8(0x03);
    writeUleb(w, forms[0]!);
    writeUleb(w, zigzag(deltaBase));
    w.u8(deltaWidth);
    packBits(w, diffs.map((d) => d - deltaBase), deltaWidth);
    return;
  }
  w.u8(0x04);
  writeUleb(w, zigzag(forBase));
  w.u8(pfor!.lowWidth);
  w.u8(pfor!.highWidth);
  writeBitmap(w, pfor!.exceptions);
  packBits(w, pfor!.lows, pfor!.lowWidth);
  packBits(w, pfor!.highs, pfor!.highWidth);
}

/** Exact encoded size used by the non-normative reference trainer's grammar estimate. */
export function intColumnEncodedLength(values: readonly bigint[], bounds: IntBounds): number {
  const writer = new Writer();
  encodeIntColumn(writer, bounds, values);
  return writer.finish().length;
}

/** Participating values of one column by participant index, held typed or packed until rows materialize. */
type Column<T = unknown> = (j: number) => T;

const noValues: Column<never> = () => undefined as never;

/** A grammar lane's first out-of-range value, held back so the column reports it in row order. */
interface DeferredRange {
  index: number;
  error: DecodeError | null;
}

function decodeIntColumn(r: Reader, bounds: IntBounds, count: number, path: string, deferred?: DeferredRange): Column<number> {
  const mode = r.u8();
  if (mode > 4) throw new DecodeError("marker", `${path}: invalid int column mode 0x${mode.toString(16)}`);
  if (count === 0) {
    if (mode !== 0) throw new DecodeError("marker", `${path}: empty column must use mode 0x00`);
    return noValues;
  }

  const fromForm = (form: bigint): bigint => bounds.min !== undefined ? form + bounds.min : unzigzag(form);

  const inRange = (v: bigint): boolean =>
    v >= BigInt(INT_MIN) &&
    v <= BigInt(INT_MAX) &&
    (bounds.min === undefined || v >= bounds.min) &&
    (bounds.max === undefined || v <= bounds.max);

  const outOfRange = (v: bigint, i: number): void => {
    const error =
      v < BigInt(INT_MIN) || v > BigInt(INT_MAX)
        ? new DecodeError("range", `${path}[${i}]: decoded integer outside the v0 domain`)
        : bounds.min !== undefined && v < bounds.min
          ? new DecodeError("range", `${path}[${i}]: below declared min`)
          : new DecodeError("range", `${path}[${i}]: above declared max`);
    if (!deferred) throw error;
    if (!deferred.error) {
      deferred.error = error;
      deferred.index = i;
    }
  };

  const check = (v: bigint, i: number): number => {
    if (!inRange(v)) outOfRange(v, i);
    return Number(v);
  };

  if (mode === 0x00 || mode === 0x01) {
    let prev = 0n;
    const next = (i: number): number => {
      const form = readUleb(r);
      prev = i === 0 || mode === 0x00 ? fromForm(form) : prev + unzigzag(form);
      return check(prev, i);
    };
    // every value, and in delta mode every difference, costs at least one byte: a body
    // too short for the column fails on its first bad value or its end, before allocating
    if (r.remaining() < count) {
      for (let i = 0; i < count; i++) next(i);
    }
    r.need(count);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = next(i);
    return (j) => out[j]!;
  }

  if (mode === 0x02) {
    const base = unzigzag(readUleb(r));
    const width = r.u8();
    const next = unpackBits(r, count, width, path);
    if (width === 0) {
      const value = check(base, 0);
      return () => value;
    }
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = check(base + next(), i);
    return (j) => out[j]!;
  }

  if (mode === 0x03) {
    if (count < 2) throw new DecodeError("marker", `${path}: delta frame requires at least two values`);
    const first = fromForm(readUleb(r));
    const base = unzigzag(readUleb(r));
    const width = r.u8();
    const next = unpackBits(r, count - 1, width, path);
    if (width === 0) {
      // a constant step: the values are monotone, so the ends bound every one between
      const head = check(first, 0);
      const last = first + base * BigInt(count - 1);
      if (!inRange(last)) {
        let running = first;
        for (let i = 1; i < count; i++) check((running += base), i);
      }
      const step = Number(base);
      const exact = Number.isSafeInteger(step);
      return (j) => {
        const offset = j * step;
        return exact && Number.isSafeInteger(offset) ? head + offset : Number(first + base * BigInt(j));
      };
    }
    const out = new Float64Array(count);
    let running = first;
    out[0] = check(running, 0);
    for (let i = 1; i < count; i++) {
      running = running + base + next();
      out[i] = check(running, i);
    }
    return (j) => out[j]!;
  }

  const base = unzigzag(readUleb(r));
  const lowWidth = r.u8();
  const highWidth = r.u8();
  if (lowWidth > 55) {
    throw new DecodeError("marker", `${path}: patched frame low width ${lowWidth} exceeds 55`);
  }
  if (highWidth < 1 || lowWidth + highWidth > MAX_WIDTH) {
    throw new DecodeError("marker", `${path}: invalid patched frame widths L=${lowWidth}, H=${highWidth}`);
  }
  const exceptions = readPackedBitmap(r, count, path);
  const lows = unpackBits(r, count, lowWidth, path);
  const highs = unpackBits(r, popcount(exceptions), highWidth, path);
  const shift = BigInt(lowWidth);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let high = 0n;
    const low = lows();
    if (bitAt(exceptions, i)) {
      high = highs();
      if (high === 0n) {
        throw new DecodeError("bitmap", `${path}[${i}]: patched frame exception has a zero high part`);
      }
    }
    out[i] = check(base + low + (high << shift), i);
  }
  return (j) => out[j]!;
}

function sigBytes(x: bigint): number {
  let len = 0;
  let v = x;
  while (v > 0n) {
    v >>= 8n;
    len++;
  }
  return len;
}

const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000];
const MAX_SCALE = POW10.length - 1;

/** Spec-pinned mantissa recovery: sign(v) * floor(|v|*10^s + 0.5), pure IEEE ops. */
function decimalMantissa(v: number, pow: number): number {
  if (v > 0) return Math.floor(v * pow + 0.5);
  if (v < 0) return -Math.floor(-v * pow + 0.5);
  return 0;
}

/** Smallest s with every value exactly m/10^s for a safe integer m, or null. */
function decimalScale(values: number[]): number | null {
  for (let s = 0; s <= MAX_SCALE; s++) {
    const pow = POW10[s]!;
    let ok = true;
    for (const v of values) {
      const m = decimalMantissa(v, pow);
      if (!Number.isSafeInteger(m) || m / pow !== v) {
        ok = false;
        break;
      }
    }
    if (ok) return s;
  }
  return null;
}

function encodeFloatColumn(w: Writer, values: number[], path: string): void {
  if (values.length === 0) {
    w.u8(0);
    return;
  }
  const canon = values.map((v, i) => {
    if (typeof v !== "number") throw new EncodeError("type", `${path}[${i}]: expected number`);
    if (!Number.isFinite(v)) throw new EncodeError("float", `${path}[${i}]: float64 must be finite`);
    return Object.is(v, -0) ? 0 : v;
  });
  const bits = canon.map(floatBits);

  const xors: bigint[] = [];
  let xorCost = 8;
  for (let i = 1; i < bits.length; i++) {
    const x = bits[i]! ^ bits[i - 1]!;
    xors.push(x);
    xorCost += 1 + sigBytes(x);
  }
  const rawCost = 8 * bits.length;

  const scale = decimalScale(canon);
  let scaledDeltaCost = Infinity;
  let scaledRawCost = Infinity;
  let mantissas: bigint[] = [];
  if (scale !== null) {
    mantissas = canon.map((v) => BigInt(decimalMantissa(v, POW10[scale]!)));
    scaledRawCost = 1 + mantissas.reduce((n, m) => n + ulebLen(zigzag(m)), 0);
    scaledDeltaCost = 1 + ulebLen(zigzag(mantissas[0]!));
    for (let i = 1; i < mantissas.length; i++) {
      scaledDeltaCost += ulebLen(zigzag(mantissas[i]! - mantissas[i - 1]!));
    }
  }

  const best = Math.min(rawCost, xorCost, scaledDeltaCost, scaledRawCost);
  if (best === rawCost) {
    w.u8(0);
    for (const b of bits) w.u64le(b);
  } else if (best === xorCost) {
    w.u8(1);
    w.u64le(bits[0]!);
    for (const x of xors) {
      const len = sigBytes(x);
      w.u8(len);
      let v = x;
      for (let b = 0; b < len; b++) {
        w.u8(Number(v & 0xffn));
        v >>= 8n;
      }
    }
  } else if (best === scaledDeltaCost) {
    w.u8(2);
    w.u8(scale!);
    writeUleb(w, zigzag(mantissas[0]!));
    for (let i = 1; i < mantissas.length; i++) {
      writeUleb(w, zigzag(mantissas[i]! - mantissas[i - 1]!));
    }
  } else {
    w.u8(3);
    w.u8(scale!);
    for (const m of mantissas) writeUleb(w, zigzag(m));
  }
}

function decodeFloatColumn(r: Reader, count: number, path: string): Column<number> {
  const mode = r.u8();
  if (mode > 3) throw new DecodeError("marker", `${path}: invalid float column mode 0x${mode.toString(16)}`);
  if (count === 0) {
    if (mode !== 0) throw new DecodeError("marker", `${path}: empty column must use mode 0x00`);
    return noValues;
  }

  if (mode >= 2) {
    const scale = r.u8();
    if (scale > MAX_SCALE) throw new DecodeError("marker", `${path}: decimal scale ${scale} exceeds ${MAX_SCALE}`);
    const pow = POW10[scale]!;
    const mantissa = (m: bigint, i: number): number => {
      if (m < BigInt(INT_MIN) || m > BigInt(INT_MAX)) {
        throw new DecodeError("range", `${path}[${i}]: decimal mantissa outside the v0 domain`);
      }
      return Number(m) / pow;
    };
    let prev = 0n;
    const next = (i: number): number => {
      const form = unzigzag(readUleb(r));
      prev = i === 0 || mode === 3 ? form : prev + form;
      return mantissa(prev, i);
    };
    // every mantissa, and in delta mode every difference, costs at least one byte: a body
    // too short for the column fails on its first bad value or its end, before allocating
    if (r.remaining() < count) {
      for (let i = 0; i < count; i++) next(i);
    }
    r.need(count);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = next(i);
    return (j) => out[j]!;
  }

  const validate = (bits: bigint, i: number): number => {
    if (bits === NEG_ZERO_BITS) throw new DecodeError("float", `${path}[${i}]: negative-zero bit pattern`);
    const value = bitsToFloat(bits);
    if (!Number.isFinite(value)) throw new DecodeError("float", `${path}[${i}]: non-finite float64`);
    return value;
  };

  if (mode === 0) {
    // a body too short for the column fails on its first bad value or its end, before allocating
    if (r.remaining() < 8 * count) {
      for (let i = 0; i < count; i++) validate(r.u64le(), i);
    }
    r.need(8 * count);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = validate(r.u64le(), i);
    return (j) => out[j]!;
  }
  let prev = 0n;
  const next = (i: number): number => {
    if (i === 0) {
      prev = r.u64le();
      return validate(prev, 0);
    }
    const len = r.u8();
    if (len > 8) throw new DecodeError("marker", `${path}[${i}]: xor length ${len} exceeds 8`);
    let x = 0n;
    for (let b = 0; b < len; b++) x |= BigInt(r.u8()) << BigInt(8 * b);
    if (len > 0 && x >> BigInt(8 * (len - 1)) === 0n) {
      throw new DecodeError("float", `${path}[${i}]: non-minimal xor encoding`);
    }
    prev ^= x;
    return validate(prev, i);
  };
  // the first value takes 8 bytes, every later one at least its length byte: a body too
  // short for the column fails on its first bad value or its end, before allocating
  if (r.remaining() < 8 + count - 1) {
    for (let i = 0; i < count; i++) next(i);
  }
  r.need(8 + count - 1);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = next(i);
  return (j) => out[j]!;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function grammarLimit(token: Extract<GrammarToken, { num: unknown }>): bigint {
  return BigInt(token.num.base) ** BigInt(token.num.len);
}

function grammarDigit(char: string, token: Extract<GrammarToken, { num: unknown }>): number {
  const code = char.charCodeAt(0);
  let digit = -1;
  if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
  else if (token.num.case === "lower" && code >= 0x61 && code <= 0x7a) digit = code - 0x61 + 10;
  else if (token.num.case === "upper" && code >= 0x41 && code <= 0x5a) digit = code - 0x41 + 10;
  return digit >= 0 && digit < token.num.base ? digit : -1;
}

/** Exact ASCII grammar match and lane parse; null means the row must escape. */
export function matchGrammar(value: string, grammar: readonly GrammarToken[]): bigint[] | null {
  let offset = 0;
  const lanes: bigint[] = [];
  for (const token of grammar) {
    if ("lit" in token) {
      if (!value.startsWith(token.lit, offset)) return null;
      offset += token.lit.length;
      continue;
    }
    if (offset + token.num.len > value.length) return null;
    let lane = 0n;
    for (let i = 0; i < token.num.len; i++) {
      const digit = grammarDigit(value[offset + i]!, token);
      if (digit < 0) return null;
      lane = lane * BigInt(token.num.base) + BigInt(digit);
    }
    lanes.push(lane);
    offset += token.num.len;
  }
  return offset === value.length ? lanes : null;
}

const renderedCache = new WeakMap<object, number>();

/** UTF-8 length of every value a frozen grammar renders: numeric tokens render exactly len ASCII digits. */
function renderedLength(grammar: readonly GrammarToken[]): number {
  let n = renderedCache.get(grammar);
  if (n === undefined) {
    n = grammar.reduce((sum, token) => sum + ("lit" in token ? utf8Length(token.lit) : token.num.len), 0);
    renderedCache.set(grammar, n);
  }
  return n;
}

function renderGrammar(grammar: readonly GrammarToken[], lanes: readonly number[]): string {
  let out = "";
  let lane = 0;
  for (const token of grammar) {
    if ("lit" in token) {
      out += token.lit;
      continue;
    }
    let digits = lanes[lane++]!.toString(token.num.base).padStart(token.num.len, "0");
    if (token.num.case === "upper") digits = digits.toUpperCase();
    out += digits;
  }
  return out;
}

function escapeCost(bytes: readonly Uint8Array[], escaped: readonly boolean[]): number {
  let cost = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (escaped[i]) cost += ulebLen(BigInt(bytes[i]!.length)) + bytes[i]!.length;
  }
  return cost;
}

function writeEscaped(w: Writer, bytes: readonly Uint8Array[], escaped: readonly boolean[]): void {
  for (let i = 0; i < bytes.length; i++) {
    if (!escaped[i]) continue;
    writeUleb(w, BigInt(bytes[i]!.length));
    w.bytes(bytes[i]!);
  }
}

function writeEscapeHeader(w: Writer, escaped: readonly boolean[], count: number): void {
  writeUleb(w, BigInt(count));
  if (count > 0 && count < escaped.length) writeBitmap(w, [...escaped]);
}

type SourceValue = (ordinal: number, row: number) => unknown;

function encodeStringColumn(
  w: Writer,
  values: unknown[],
  slots: readonly number[],
  sourceValue: SourceValue,
  path: string,
  ctx: EncodeCtx,
  ordinal: number,
): void {
  if (values.length === 0) {
    w.u8(0);
    return;
  }
  const bytes = values.map((value, i) => {
    const encoded = utf8Bytes(value, `${path}[${i}]`);
    if (encoded.length > ctx.maxByteLength) {
      throw new EncodeError("limit", `${path}[${i}]: string of ${encoded.length} bytes exceeds the codec limit`);
    }
    chargeBytes(encoded.length, ctx, path, i);
    return encoded;
  });
  const strings = values as string[];
  const plainCost = bytes.reduce((cost, value) => cost + ulebLen(BigInt(value.length)) + value.length, 0);

  const dict = ctx.profile.dictOf(ordinal);
  let dictCost = Infinity;
  let dictWidth = 0;
  let codes: number[] | null = null;
  if (dict) {
    codes = strings.map((value) => ctx.profile.codeOf(ordinal, value) ?? 0);
    const highest = codes.reduce((max, code) => (code > max ? code : max), 0);
    dictWidth = bitWidth(BigInt(highest));
    const escaped = codes.map((code) => code === 0);
    dictCost = 1 + packedBytes(codes.length, dictWidth) + escapeCost(bytes, escaped);
  }

  let packed: Uint8Array | null = null;
  let packedCost = Infinity;
  const totalBytes = bytes.reduce((n, value) => n + value.length, 0);
  // §3: the deflate mode's total length obeys the decoder byte limits, so a
  // column beyond them is not a candidate — the decoder would refuse the stream
  if (ctx.deflate && ctx.canInflate && totalBytes <= ctx.maxByteLength) {
    const total = totalBytes;
    const concat = new Uint8Array(total);
    let offset = 0;
    for (const value of bytes) {
      concat.set(value, offset);
      offset += value.length;
    }
    packed = ctx.deflate(concat);
    packedCost =
      bytes.reduce((n, value) => n + ulebLen(BigInt(value.length)), 0) +
      ulebLen(BigInt(packed.length)) +
      packed.length;
  }

  const grammar = ctx.profile.grammarOf(ordinal);
  let grammarCost = Infinity;
  let grammarEscaped: boolean[] | null = null;
  let grammarLanes: bigint[][] | null = null;
  if (grammar) {
    const parsed = strings.map((value) => matchGrammar(value, grammar));
    grammarEscaped = parsed.map((value) => value === null);
    const escapeCount = grammarEscaped.reduce((n, escaped) => n + (escaped ? 1 : 0), 0);
    const numeric = grammar.filter((token): token is Extract<GrammarToken, { num: unknown }> => "num" in token);
    grammarLanes = numeric.map(() => []);
    for (const row of parsed) {
      if (!row) continue;
      row.forEach((value, lane) => grammarLanes![lane]!.push(value));
    }
    grammarCost = ulebLen(BigInt(escapeCount));
    if (escapeCount > 0 && escapeCount < strings.length) grammarCost += packedBytes(strings.length, 1);
    for (let lane = 0; lane < numeric.length; lane++) {
      grammarCost += intColumnEncodedLength(grammarLanes[lane]!, {
        min: 0n,
        max: grammarLimit(numeric[lane]!) - 1n,
      });
    }
    grammarCost += escapeCost(bytes, grammarEscaped);
  }

  const derivation = ctx.profile.derivedOf(ordinal);
  let derivedCost = Infinity;
  let derivedEscaped: boolean[] | null = null;
  if (derivation) {
    derivedEscaped = strings.map((value, i) => {
      const source = sourceValue(derivation.source, slots[i]!);
      const code = typeof source === "string" ? ctx.profile.codeOf(derivation.source, source) : undefined;
      return code === undefined || derivation.values[code - 1] !== value;
    });
    const escapeCount = derivedEscaped.reduce((n, escaped) => n + (escaped ? 1 : 0), 0);
    derivedCost = ulebLen(BigInt(escapeCount));
    if (escapeCount > 0 && escapeCount < strings.length) derivedCost += packedBytes(strings.length, 1);
    derivedCost += escapeCost(bytes, derivedEscaped);
  }

  // All costs exclude the common flags byte. Array order pins ties to the lowest mode.
  const costs = [plainCost, dictCost, packedCost, grammarCost, derivedCost];
  const best = Math.min(...costs);
  const mode = costs.indexOf(best);
  w.u8(mode);

  if (mode === 0x00) {
    writeEscaped(w, bytes, new Array<boolean>(bytes.length).fill(true));
    return;
  }
  if (mode === 0x01) {
    w.u8(dictWidth);
    packBits(w, codes!.map((code) => BigInt(code)), dictWidth);
    writeEscaped(w, bytes, codes!.map((code) => code === 0));
    return;
  }
  if (mode === 0x02) {
    for (const value of bytes) writeUleb(w, BigInt(value.length));
    writeUleb(w, BigInt(packed!.length));
    w.bytes(packed!);
    return;
  }
  if (mode === 0x03) {
    const escapeCount = grammarEscaped!.reduce((n, escaped) => n + (escaped ? 1 : 0), 0);
    writeEscapeHeader(w, grammarEscaped!, escapeCount);
    const numeric = grammar!.filter((token): token is Extract<GrammarToken, { num: unknown }> => "num" in token);
    for (let lane = 0; lane < numeric.length; lane++) {
      encodeIntColumn(w, { min: 0n, max: grammarLimit(numeric[lane]!) - 1n }, grammarLanes![lane]!);
    }
    writeEscaped(w, bytes, grammarEscaped!);
    return;
  }
  const escapeCount = derivedEscaped!.reduce((n, escaped) => n + (escaped ? 1 : 0), 0);
  writeEscapeHeader(w, derivedEscaped!, escapeCount);
  writeEscaped(w, bytes, derivedEscaped!);
}

/** Which rows of an eligible array a leaf participates in, as its wire bitmaps. */
interface Participation {
  presence: Uint8Array | null;
  nulls: Uint8Array | null;
  count: number;
}

function participates(part: Participation, row: number): boolean {
  return (part.presence === null || bitAt(part.presence, row)) && (part.nulls === null || !bitAt(part.nulls, row));
}

interface DecodedLeaf {
  part: Participation;
  values: Column;
}

function decodeStringColumn(
  r: Reader,
  part: Participation,
  rows: number,
  sourceOf: (ordinal: number) => DecodedLeaf | undefined,
  path: string,
  inflate: Inflate | undefined,
  profile: ProfileIndex,
  ordinal: number,
): Column<string> {
  const count = part.count;
  const mode = r.u8();
  if (mode > 4) throw new DecodeError("marker", `${path}: invalid string column flags 0x${mode.toString(16)}`);
  if (count === 0 && mode !== 0) throw new DecodeError("marker", `${path}: empty column must use mode 0x00`);
  if (count === 0) return noValues;

  const decodeSlice = (bytes: Uint8Array, i: number): string => {
    try {
      return utf8Strict.decode(bytes);
    } catch {
      throw new DecodeError("utf8", `${path}[${i}]: invalid UTF-8`);
    }
  };
  const readLiteral = (i: number): string => {
    const raw = readUleb(r);
    if (raw > BigInt(r.limits.maxByteLength)) {
      throw new DecodeError("limit", `${path}[${i}]: string length exceeds limit`);
    }
    const len = Number(raw);
    r.chargeBytes(len, path, i);
    return decodeSlice(r.bytes(len), i);
  };
  const chargeReconstructed = (len: number, i: number): void => {
    if (len > r.limits.maxByteLength) {
      throw new DecodeError("limit", `${path}[${i}]: reconstructed string length exceeds limit`);
    }
    r.chargeBytes(len, path, i);
  };
  interface Escapes {
    escaped: Column<boolean>;
    bits: Uint8Array | null;
    count: number;
    values: string[];
  }
  const readEscapes = (): Escapes => {
    const raw = readUleb(r);
    if (raw > BigInt(count)) {
      throw new DecodeError("range", `${path}: escape count ${raw} exceeds participating row count ${count}`);
    }
    const escapeCount = Number(raw);
    let bits: Uint8Array | null = null;
    if (escapeCount > 0 && escapeCount < count) {
      bits = readPackedBitmap(r, count, path);
      const set = popcount(bits);
      if (set !== escapeCount) {
        throw new DecodeError("bitmap", `${path}: escape bitmap popcount ${set} does not equal ${escapeCount}`);
      }
    }
    return {
      escaped: bits ? (j) => bitAt(bits, j) : escapeCount === 0 ? () => false : () => true,
      bits,
      count: escapeCount,
      values: [],
    };
  };

  if (mode === 0x00) {
    // each literal costs at least its length byte: a body too short for the column fails
    // on its first bad row or its end, before allocating
    if (r.remaining() < count) {
      for (let i = 0; i < count; i++) readLiteral(i);
    }
    r.need(count);
    const out = new Array<string>(count);
    for (let i = 0; i < count; i++) out[i] = readLiteral(i);
    return (j) => out[j]!;
  }

  if (mode === 0x01) {
    const dict = profile.dictOf(ordinal);
    if (!dict) {
      throw new DecodeError("unsupported", `${path}: dictionary column requires a profile for this leaf`);
    }
    const width = r.u8();
    if (width > 14) throw new DecodeError("marker", `${path}: dictionary width ${width} exceeds 14`);
    const next = unpackBits(r, count, width, path);
    // width zero codes every row as an escape; codes are held only once their bytes are read
    const codes = width === 0 ? null : new Uint16Array(count);
    let escapeCount = codes ? 0 : count;
    if (codes) {
      for (let i = 0; i < count; i++) {
        codes[i] = Number(next());
        if (codes[i] === 0) escapeCount++;
      }
    }
    const lengths = utf8Lengths(dict);
    const value = (i: number): string => {
      const code = codes ? codes[i]! : 0;
      if (code === 0) return readLiteral(i);
      if (code > dict.length) {
        throw new DecodeError("range", `${path}[${i}]: dictionary code ${code} out of range`);
      }
      chargeReconstructed(lengths[code - 1]!, i);
      return dict[code - 1]!;
    };
    // each escape costs at least its length byte: a body too short for them fails on its
    // first bad row or its end, before allocating
    if (r.remaining() < escapeCount) {
      for (let i = 0; i < count; i++) value(i);
    }
    r.need(escapeCount);
    const out = new Array<string>(count);
    for (let i = 0; i < count; i++) out[i] = value(i);
    return (j) => out[j]!;
  }

  if (mode === 0x03) {
    const grammar = profile.grammarOf(ordinal);
    if (!grammar) throw new DecodeError("unsupported", `${path}: grammar column requires a profile for this leaf`);
    const escapes = readEscapes();
    const matchedCount = count - escapes.count;
    const numeric = grammar.filter((token): token is Extract<GrammarToken, { num: unknown }> => "num" in token);
    // lane padding is structure; lane ranges are each matched row's own checks, made in row order
    const ranges = numeric.map((): DeferredRange => ({ index: -1, error: null }));
    const lanes = numeric.map((token, lane) =>
      decodeIntColumn(r, { min: 0n, max: grammarLimit(token) - 1n }, matchedCount, `${path}.lane[${lane}]`, ranges[lane]),
    );
    let badRow = -1;
    let badRange: DecodeError | null = null;
    for (const range of ranges) {
      if (range.error && (badRange === null || range.index < badRow)) {
        badRow = range.index;
        badRange = range.error;
      }
    }
    const rendered = renderedLength(grammar);
    const resolve = (values: string[] | null): void => {
      let matched = 0;
      for (let i = 0; i < count; i++) {
        if (escapes.escaped(i)) {
          const value = readLiteral(i);
          if (values) values.push(value);
        } else {
          if (matched++ === badRow) throw badRange!;
          chargeReconstructed(rendered, i);
        }
      }
    };
    // escaped values follow in row order, each at least its length byte: a body too short
    // for them fails on its first bad row or its end, before allocating
    if (r.remaining() < escapes.count) resolve(null);
    r.need(escapes.count);
    resolve(escapes.values);
    const rank = escapes.bits ? rankBits(escapes.bits, count) : null;
    return (j) => {
      const index = rank ? rank[j]! : j;
      if (escapes.escaped(j)) return escapes.values[index]!;
      return renderGrammar(grammar, lanes.map((lane) => lane(index)));
    };
  }

  if (mode === 0x04) {
    const derived = profile.derivedOf(ordinal);
    if (!derived) throw new DecodeError("unsupported", `${path}: derived column requires a profile for this leaf`);
    const escapes = readEscapes();
    const source = sourceOf(derived.source);
    const lengths = utf8Lengths(derived.values);
    // per participant: its escape index when escaped, else the source's dictionary code
    const resolve = (slot: Int32Array | null): void => {
      let j = 0;
      let s = 0;
      for (let row = 0; row < rows && j < count; row++) {
        const sourceRow = source !== undefined && participates(source.part, row);
        if (participates(part, row)) {
          if (escapes.escaped(j)) {
            if (slot) slot[j] = escapes.values.length;
            escapes.values.push(readLiteral(j));
          } else {
            if (!sourceRow) {
              throw new DecodeError("range", `${path}[${j}]: derived source does not participate in this array row`);
            }
            const value = source.values(s);
            const code = typeof value === "string" ? profile.codeOf(derived.source, value) : undefined;
            if (code === undefined) {
              throw new DecodeError("range", `${path}[${j}]: derived source value is outside its dictionary`);
            }
            chargeReconstructed(lengths[code - 1]!, j);
            if (slot) slot[j] = code;
          }
          j++;
        }
        if (sourceRow) s++;
      }
    };
    // escaped values follow in row order, each at least its length byte: a body too short
    // for them fails on its first bad row or its end, before allocating
    if (r.remaining() < escapes.count) resolve(null);
    r.need(escapes.count);
    const slot = new Int32Array(count);
    resolve(slot);
    return (k) => (escapes.escaped(k) ? escapes.values[slot[k]!]! : derived.values[slot[k]! - 1]!);
  }

  // each length costs at least one byte, so the lengths grow with the bytes read, not the count
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const raw = readUleb(r);
    if (raw > BigInt(r.limits.maxByteLength)) {
      throw new DecodeError("limit", `${path}[${i}]: string length exceeds limit`);
    }
    lengths.push(Number(raw));
    total += lengths[i]!;
    if (total > r.limits.maxByteLength) {
      throw new DecodeError("limit", `${path}: packed column total exceeds limit`);
    }
  }
  r.chargeBytes(total, path);
  if (!inflate) {
    throw new DecodeError("unsupported", `${path}: packed string column requires an inflate hook`);
  }
  const blobLenRaw = readUleb(r);
  if (blobLenRaw > BigInt(r.limits.maxByteLength)) {
    throw new DecodeError("limit", `${path}: packed blob exceeds limit`);
  }
  const blob = r.bytes(Number(blobLenRaw));
  let inflated: Uint8Array;
  try {
    inflated = inflate(blob, total);
  } catch (err) {
    throw new DecodeError("packed", `${path}: packed blob failed to inflate`, { cause: err });
  }
  if (inflated.length !== total) {
    throw new DecodeError("packed", `${path}: packed blob inflates to ${inflated.length} bytes, expected ${total}`);
  }
  const out = new Array<string>(count);
  let offset = 0;
  for (let i = 0; i < count; i++) {
    out[i] = decodeSlice(inflated.subarray(offset, offset + lengths[i]!), i);
    offset += lengths[i]!;
  }
  return (j) => out[j]!;
}

function encodeBoolColumn(w: Writer, values: unknown[], path: string): void {
  const bits = values.map((v, i) => {
    if (typeof v !== "boolean") throw new EncodeError("type", `${path}[${i}]: expected boolean`);
    return v;
  });
  writeBitmap(w, bits);
}

function enumWidth(node: Extract<IRNode, { kind: "enum" }>): number {
  return bitWidth(BigInt(node.members.length - 1));
}

function encodeEnumColumn(
  w: Writer,
  node: Extract<IRNode, { kind: "enum" }>,
  values: readonly unknown[],
  path: string,
  ctx: EncodeCtx,
): void {
  const lengths = utf8Lengths(node.members);
  const indices = values.map((value, i) => {
    if (typeof value !== "string") throw new EncodeError("type", `${path}[${i}]: expected enum member string`);
    const index = node.members.indexOf(value);
    if (index < 0) throw new EncodeError("type", `${path}[${i}]: "${value}" is not an enum member`);
    chargeBytes(lengths[index]!, ctx, path, i);
    return BigInt(index);
  });
  packBits(w, indices, enumWidth(node));
}

function decodeEnumColumn(
  r: Reader,
  node: Extract<IRNode, { kind: "enum" }>,
  count: number,
  path: string,
): Column<string> {
  const width = enumWidth(node);
  const next = unpackBits(r, count, width, path);
  const lengths = utf8Lengths(node.members);
  if (width === 0) {
    r.chargeBytes(count * lengths[0]!, path);
    return () => node.members[0]!;
  }
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const index = next();
    if (index >= BigInt(node.members.length)) {
      throw new DecodeError("range", `${path}[${i}]: enum index ${index} out of range`);
    }
    indices[i] = Number(index);
    r.chargeBytes(lengths[indices[i]!]!, path, i);
  }
  return (j) => node.members[indices[j]!]!;
}

interface RowState {
  present: boolean;
  isNull: boolean;
}

interface ColumnInput {
  values: unknown[];
  states: RowState[];
  slots: number[];
  participating: unknown[];
}

export function encodeColumnarArray(
  w: Writer,
  node: ArrayNode,
  value: unknown,
  path: string,
  depth: number,
  ctx: EncodeCtx,
  ordinalBase: number,
): void {
  if (!Array.isArray(value)) throw new EncodeError("type", `${path}: expected array`);
  if (value.length > ctx.maxItems) {
    throw new EncodeError("limit", `${path}: array of ${value.length} items exceeds the codec limit`);
  }
  const element = node.element as StructNode;
  if (node.length !== undefined) {
    if (value.length !== node.length) {
      throw new EncodeError("type", `${path}: fixed array expects ${node.length} items, got ${value.length}`);
    }
  } else {
    writeUleb(w, BigInt(value.length));
  }
  chargeItems(value.length, ctx, path);
  const payloadStart = w.size;

  const rows = value.map((row, i) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new EncodeError("type", `${path}[${i}]: expected object`);
    }
    return row as Record<string, unknown>;
  });

  const leaves = flattenLeaves(element)!;

  const containerOf = (row: Record<string, unknown>, segs: readonly string[], i: number): Record<string, unknown> => {
    let obj: Record<string, unknown> = row;
    for (let d = 0; d < segs.length - 1; d++) {
      const key = segs[d]!;
      const v = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new EncodeError(
          v === undefined ? "required" : "type",
          `${path}[${i}].${segs.slice(0, d + 1).join(".")}: expected object`,
        );
      }
      obj = v as Record<string, unknown>;
    }
    return obj;
  };

  const inputs: ColumnInput[] = leaves.map((leaf) => {
    const field = leaf.field;
    const leafName = leaf.segs[leaf.segs.length - 1]!;
    const dotted = leaf.segs.join(".");
    const values: unknown[] = rows.map((row, i) => {
      const holder = containerOf(row, leaf.segs, i);
      return Object.prototype.hasOwnProperty.call(holder, leafName) ? holder[leafName] : undefined;
    });
    const states: RowState[] = values.map((v, i) => {
      const absent = v === undefined;
      if (absent && !field.optional) {
        throw new EncodeError("required", `${path}[${i}].${dotted}: required field missing`);
      }
      if (v === null && !field.nullable && !typeAcceptsNull(field.type)) {
        throw new EncodeError("type", `${path}[${i}].${dotted}: null for non-nullable field`);
      }
      return { present: !absent, isNull: !absent && v === null };
    });
    const slots: number[] = [];
    const participating: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      const s = states[i]!;
      if (!s.present) continue;
      if (s.isNull && field.nullable) continue;
      slots.push(i);
      participating.push(values[i]);
    }
    return { values, states, slots, participating };
  });

  const sourceValue: SourceValue = (ordinal, row) => {
    const local = ordinal - ordinalBase;
    const input = inputs[local];
    const leaf = leaves[local];
    if (!input || !leaf) return undefined;
    const state = input.states[row];
    if (!state?.present || (state.isNull && leaf.field.nullable)) return undefined;
    return input.values[row];
  };

  for (const [leafIndex, leaf] of leaves.entries()) {
    const field = leaf.field;
    const dotted = leaf.segs.join(".");
    const fieldPath = `${path}[].${dotted}`;
    const input = inputs[leafIndex]!;
    const { states, slots, participating } = input;

    if (field.optional) writeBitmap(w, states.map((s) => s.present));
    if (field.nullable) writeBitmap(w, states.map((s) => s.present && s.isNull));

    // row-equivalent depths: a nested container at chain position j sits at depth+2+j,
    // the leaf value at depth+1+segs.length. Containers always exist; the leaf only when present.
    if (rows.length > 0 && depth + leaf.segs.length > ctx.maxDepth) {
      throw new EncodeError("depth", `${fieldPath}: nesting deeper than ${ctx.maxDepth}`);
    }
    if (participating.length > 0 && depth + 1 + leaf.segs.length > ctx.maxDepth) {
      throw new EncodeError("depth", `${fieldPath}: nesting deeper than ${ctx.maxDepth}`);
    }

    switch (field.type.kind) {
      case "int":
        encodeIntColumn(
          w,
          nodeBounds(field.type as IntNode),
          participating.map((v, i) => checkInt(field.type as IntNode, v, `${fieldPath}[${i}]`)),
        );
        break;
      case "float64":
        encodeFloatColumn(w, participating as number[], fieldPath);
        break;
      case "bool":
        encodeBoolColumn(w, participating, fieldPath);
        break;
      case "string":
        encodeStringColumn(w, participating, slots, sourceValue, fieldPath, ctx, ordinalBase + leafIndex);
        break;
      case "enum":
        encodeEnumColumn(w, field.type, participating, fieldPath, ctx);
        break;
      default:
        for (let i = 0; i < participating.length; i++) {
          encodeNode(w, field.type, participating[i], `${fieldPath}[${i}]`, depth + 2, ctx, ordinalBase + leafIndex);
        }
    }
  }

  checkAmplification(rows.length, w.size - payloadStart, false, ctx, path);
}

export function decodeColumnarArray(
  r: Reader,
  node: ArrayNode,
  path: string,
  depth: number,
  inflate: Inflate | undefined,
  profile: ProfileIndex,
  ordinalBase: number,
): Record<string, unknown>[] {
  const element = node.element as StructNode;
  let count: number;
  if (node.length !== undefined) {
    count = node.length;
  } else {
    const raw = readUleb(r);
    if (raw > BigInt(r.limits.maxItems)) {
      throw new DecodeError("limit", `${path}: array count ${raw} exceeds limit ${r.limits.maxItems}`);
    }
    count = Number(raw);
  }
  // A width-zero column legitimately encodes any number of rows in a handful of
  // bytes, so input length cannot bound the count the way the row plan's one-bit
  // floor does: the amplification bound and the item budget cap it instead. Columns
  // stay in packed or typed form and rows materialize only after every column
  // payload has decoded, so a truncated or malformed body fails before any per-row
  // values exist.
  enterArray(r, count, false, path);

  const leaves = flattenLeaves(element)!;
  const decoded: DecodedLeaf[] = [];
  const sourceOf = (ordinal: number): DecodedLeaf | undefined => decoded[ordinal - ordinalBase];

  for (const [leafIndex, leaf] of leaves.entries()) {
    const field = leaf.field;
    const leafName = leaf.segs[leaf.segs.length - 1]!;
    const fieldPath = `${path}[].${leaf.segs.join(".")}`;
    const presence = field.optional ? readPackedBitmap(r, count, fieldPath) : null;
    const nulls = field.nullable ? readPackedBitmap(r, count, fieldPath) : null;

    let participating = count;
    if (presence || nulls) {
      participating = 0;
      for (let b = 0; b < Math.ceil(count / 8); b++) {
        const p = presence ? presence[b]! : 0xff;
        const n = nulls ? nulls[b]! : 0;
        const orphan = n & ~p;
        if (orphan !== 0) {
          const row = b * 8 + 31 - Math.clz32(orphan & -orphan);
          throw new DecodeError("bitmap", `${path}[${row}].${leafName}: null bit set for absent field`);
        }
        participating += popcount8(p & ~n & (b * 8 + 8 > count ? (1 << (count % 8)) - 1 : 0xff));
      }
    }
    const part: Participation = { presence, nulls, count: participating };

    if (count > 0 && depth + leaf.segs.length > r.limits.maxDepth) {
      throw new DecodeError("depth", `${fieldPath}: nesting deeper than ${r.limits.maxDepth}`);
    }
    if (participating > 0 && depth + 1 + leaf.segs.length > r.limits.maxDepth) {
      throw new DecodeError("depth", `${fieldPath}: nesting deeper than ${r.limits.maxDepth}`);
    }

    let values: Column;
    switch (field.type.kind) {
      case "int":
        values = decodeIntColumn(r, nodeBounds(field.type as IntNode), participating, fieldPath);
        break;
      case "float64":
        values = decodeFloatColumn(r, participating, fieldPath);
        break;
      case "bool": {
        const bits = readPackedBitmap(r, participating, fieldPath);
        values = (j) => bitAt(bits, j);
        break;
      }
      case "string":
        values = decodeStringColumn(r, part, count, sourceOf, fieldPath, inflate, profile, ordinalBase + leafIndex);
        break;
      case "enum":
        values = decodeEnumColumn(r, field.type, participating, fieldPath);
        break;
      case "literal": {
        const value = field.type.value;
        r.chargeBytes(participating * literalBytes(field.type), fieldPath);
        values = () => value;
        break;
      }
      default: {
        const each = (out: unknown[] | null): void => {
          for (let row = 0, j = 0; j < participating; row++) {
            if (!participates(part, row)) continue;
            const value = decodeNode(r, field.type, `${path}[${row}].${leafName}`, depth + 2, false, inflate, profile, ordinalBase + leafIndex);
            if (out) out[j] = value;
            j++;
          }
        };
        // bytes: each value costs at least its length byte, so a body too short for the
        // column fails on its first bad value or its end, before allocating
        if (r.remaining() < participating) each(null);
        r.need(participating);
        const out = new Array<unknown>(participating);
        each(out);
        values = (j) => out[j];
      }
    }
    decoded[leafIndex] = { part, values };
  }

  const out: Record<string, unknown>[] = new Array<Record<string, unknown>>(count);
  for (let i = 0; i < count; i++) out[i] = {};

  const containerOf = (row: Record<string, unknown>, segs: readonly string[]): Record<string, unknown> => {
    let obj = row;
    for (let d = 0; d < segs.length - 1; d++) {
      const seg = segs[d]!;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) obj[seg] = {};
      obj = obj[seg] as Record<string, unknown>;
    }
    return obj;
  };

  for (const [leafIndex, leaf] of leaves.entries()) {
    const leafName = leaf.segs[leaf.segs.length - 1]!;
    const { part, values } = decoded[leafIndex]!;
    const { presence, nulls } = part;
    // nested structs are required and non-nullable: materialize the container chain at
    // this leaf's declared position for every row, so an all-absent nested struct still
    // round-trips and keys stay in declared order across implementations
    const nested = leaf.segs.length > 1;
    let j = 0;
    for (let i = 0; i < count; i++) {
      const holder = nested ? containerOf(out[i]!, leaf.segs) : out[i]!;
      if (presence && !bitAt(presence, i)) continue;
      holder[leafName] = nulls && bitAt(nulls, i) ? null : values(j++);
    }
  }

  return out;
}
