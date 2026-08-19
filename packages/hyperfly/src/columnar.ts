import { decodeNode, type Inflate } from "./decode.js";
import { encodeNode, typeAcceptsNull, utf8Bytes, writeBitmap, type EncodeCtx } from "./encode.js";
import { DecodeError, EncodeError } from "./errors.js";
import type { IRField, IRNode } from "./ir.js";
import { readBitmap } from "./decode.js";
import type { Reader } from "./reader.js";
import { INT_MAX, INT_MIN, readUleb, ulebLen, unzigzag, writeUleb, zigzag } from "./varint.js";
import type { Writer } from "./writer.js";

type ArrayNode = Extract<IRNode, { kind: "array" }>;
type StructNode = Extract<IRNode, { kind: "struct" }>;
type IntNode = Extract<IRNode, { kind: "int" }>;

const COLUMN_KINDS = new Set(["bool", "int", "float64", "string", "bytes", "enum", "literal"]);

interface Leaf {
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

function intForm(node: IntNode, value: number): bigint {
  return node.min !== undefined ? BigInt(value) - BigInt(node.min) : zigzag(BigInt(value));
}

function checkInt(node: IntNode, value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new EncodeError("type", `${path}: expected a safe integer`);
  }
  if (node.min !== undefined && value < node.min) {
    throw new EncodeError("range", `${path}: ${value} below declared min ${node.min}`);
  }
  if (node.max !== undefined && value > node.max) {
    throw new EncodeError("range", `${path}: ${value} above declared max ${node.max}`);
  }
  return value;
}

function encodeIntColumn(w: Writer, node: IntNode, values: number[]): void {
  if (values.length === 0) {
    w.u8(0);
    return;
  }
  const forms = values.map((v) => intForm(node, v));
  const diffs: bigint[] = [];
  for (let i = 1; i < values.length; i++) {
    diffs.push(zigzag(BigInt(values[i]!) - BigInt(values[i - 1]!)));
  }
  const rawCost = forms.reduce((n, f) => n + ulebLen(f), 0);
  const deltaCost = ulebLen(forms[0]!) + diffs.reduce((n, d) => n + ulebLen(d), 0);
  if (deltaCost < rawCost) {
    w.u8(1);
    writeUleb(w, forms[0]!);
    for (const d of diffs) writeUleb(w, d);
  } else {
    w.u8(0);
    for (const f of forms) writeUleb(w, f);
  }
}

function decodeIntColumn(r: Reader, node: IntNode, count: number, path: string): number[] {
  const mode = r.u8();
  if (mode > 1) throw new DecodeError("marker", `${path}: invalid int column mode 0x${mode.toString(16)}`);
  const out: number[] = new Array<number>(count);
  if (count === 0) return out;

  const fromForm = (form: bigint): bigint =>
    node.min !== undefined ? form + BigInt(node.min) : unzigzag(form);

  const validate = (v: bigint, i: number): number => {
    if (v < BigInt(INT_MIN) || v > BigInt(INT_MAX)) {
      throw new DecodeError("range", `${path}[${i}]: decoded integer outside the v0 domain`);
    }
    const num = Number(v);
    if (node.min !== undefined && num < node.min) {
      throw new DecodeError("range", `${path}[${i}]: below declared min`);
    }
    if (node.max !== undefined && num > node.max) {
      throw new DecodeError("range", `${path}[${i}]: above declared max`);
    }
    return num;
  };

  if (mode === 0) {
    for (let i = 0; i < count; i++) out[i] = validate(fromForm(readUleb(r)), i);
    return out;
  }
  let prev = fromForm(readUleb(r));
  out[0] = validate(prev, 0);
  for (let i = 1; i < count; i++) {
    prev = prev + unzigzag(readUleb(r));
    out[i] = validate(prev, i);
  }
  return out;
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

function decodeFloatColumn(r: Reader, count: number, path: string): number[] {
  const mode = r.u8();
  if (mode > 3) throw new DecodeError("marker", `${path}: invalid float column mode 0x${mode.toString(16)}`);
  const out: number[] = new Array<number>(count);
  if (count === 0) return out;

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
    if (mode === 3) {
      for (let i = 0; i < count; i++) out[i] = mantissa(unzigzag(readUleb(r)), i);
      return out;
    }
    let prev = unzigzag(readUleb(r));
    out[0] = mantissa(prev, 0);
    for (let i = 1; i < count; i++) {
      prev = prev + unzigzag(readUleb(r));
      out[i] = mantissa(prev, i);
    }
    return out;
  }

  const validate = (bits: bigint, i: number): number => {
    if (bits === NEG_ZERO_BITS) throw new DecodeError("float", `${path}[${i}]: negative-zero bit pattern`);
    const value = bitsToFloat(bits);
    if (!Number.isFinite(value)) throw new DecodeError("float", `${path}[${i}]: non-finite float64`);
    return value;
  };

  if (mode === 0) {
    for (let i = 0; i < count; i++) out[i] = validate(r.u64le(), i);
    return out;
  }
  let prev = r.u64le();
  out[0] = validate(prev, 0);
  for (let i = 1; i < count; i++) {
    const len = r.u8();
    if (len > 8) throw new DecodeError("marker", `${path}[${i}]: xor length ${len} exceeds 8`);
    let x = 0n;
    for (let b = 0; b < len; b++) x |= BigInt(r.u8()) << BigInt(8 * b);
    if (len > 0 && x >> BigInt(8 * (len - 1)) === 0n) {
      throw new DecodeError("float", `${path}[${i}]: non-minimal xor encoding`);
    }
    prev ^= x;
    out[i] = validate(prev, i);
  }
  return out;
}

function encodeStringColumn(w: Writer, values: unknown[], path: string, ctx: EncodeCtx): void {
  if (values.length === 0) {
    w.u8(0);
    return;
  }
  const bytes = values.map((v, i) => utf8Bytes(v, `${path}[${i}]`));
  const plainCost = bytes.reduce((n, b) => n + ulebLen(BigInt(b.length)) + b.length, 0);

  let packed: Uint8Array | null = null;
  let packedCost = Infinity;
  if (ctx.deflate) {
    const total = bytes.reduce((n, b) => n + b.length, 0);
    const concat = new Uint8Array(total);
    let offset = 0;
    for (const b of bytes) {
      concat.set(b, offset);
      offset += b.length;
    }
    packed = ctx.deflate(concat);
    packedCost =
      bytes.reduce((n, b) => n + ulebLen(BigInt(b.length)), 0) +
      ulebLen(BigInt(packed.length)) +
      packed.length;
  }

  if (packed && packedCost < plainCost) {
    w.u8(1);
    for (const b of bytes) writeUleb(w, BigInt(b.length));
    writeUleb(w, BigInt(packed.length));
    w.bytes(packed);
    return;
  }
  w.u8(0);
  for (const b of bytes) {
    writeUleb(w, BigInt(b.length));
    w.bytes(b);
  }
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function decodeStringColumn(r: Reader, count: number, path: string, inflate?: Inflate): string[] {
  const mode = r.u8();
  if (mode > 1) throw new DecodeError("marker", `${path}: invalid string column mode 0x${mode.toString(16)}`);
  const out: string[] = new Array<string>(count);
  if (count === 0) return out;

  const decodeSlice = (bytes: Uint8Array, i: number): string => {
    try {
      return utf8Strict.decode(bytes);
    } catch {
      throw new DecodeError("utf8", `${path}[${i}]: invalid UTF-8`);
    }
  };

  if (mode === 0) {
    for (let i = 0; i < count; i++) {
      const raw = readUleb(r);
      if (raw > BigInt(r.limits.maxByteLength)) {
        throw new DecodeError("limit", `${path}[${i}]: string length exceeds limit`);
      }
      out[i] = decodeSlice(r.bytes(Number(raw)), i);
    }
    return out;
  }

  const lengths: number[] = new Array<number>(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const raw = readUleb(r);
    if (raw > BigInt(r.limits.maxByteLength)) {
      throw new DecodeError("limit", `${path}[${i}]: string length exceeds limit`);
    }
    lengths[i] = Number(raw);
    total += lengths[i]!;
    if (total > r.limits.maxByteLength) {
      throw new DecodeError("limit", `${path}: packed column total exceeds limit`);
    }
  }
  const blobLenRaw = readUleb(r);
  if (blobLenRaw > BigInt(r.limits.maxByteLength)) {
    throw new DecodeError("limit", `${path}: packed blob exceeds limit`);
  }
  const blob = r.bytes(Number(blobLenRaw));
  if (!inflate) {
    throw new DecodeError("unsupported", `${path}: packed string column requires an inflate hook`);
  }
  let inflated: Uint8Array;
  try {
    inflated = inflate(blob, total);
  } catch {
    throw new DecodeError("packed", `${path}: packed blob failed to inflate`);
  }
  if (inflated.length !== total) {
    throw new DecodeError("packed", `${path}: packed blob inflates to ${inflated.length} bytes, expected ${total}`);
  }
  let offset = 0;
  for (let i = 0; i < count; i++) {
    out[i] = decodeSlice(inflated.subarray(offset, offset + lengths[i]!), i);
    offset += lengths[i]!;
  }
  return out;
}

function encodeBoolColumn(w: Writer, values: unknown[], path: string): void {
  const bits = values.map((v, i) => {
    if (typeof v !== "boolean") throw new EncodeError("type", `${path}[${i}]: expected boolean`);
    return v;
  });
  writeBitmap(w, bits);
}

interface RowState {
  present: boolean;
  isNull: boolean;
}

export function encodeColumnarArray(
  w: Writer,
  node: ArrayNode,
  value: unknown,
  path: string,
  depth: number,
  ctx: EncodeCtx,
): void {
  if (!Array.isArray(value)) throw new EncodeError("type", `${path}: expected array`);
  const element = node.element as StructNode;
  if (node.length !== undefined) {
    if (value.length !== node.length) {
      throw new EncodeError("type", `${path}: fixed array expects ${node.length} items, got ${value.length}`);
    }
  } else {
    writeUleb(w, BigInt(value.length));
  }

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
      const v = obj[segs[d]!];
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

  for (const leaf of leaves) {
    const field = leaf.field;
    const leafName = leaf.segs[leaf.segs.length - 1]!;
    const dotted = leaf.segs.join(".");
    const fieldPath = `${path}[].${dotted}`;
    const values: unknown[] = rows.map((row, i) => containerOf(row, leaf.segs, i)[leafName]);
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

    if (field.optional) writeBitmap(w, states.map((s) => s.present));
    if (field.nullable) writeBitmap(w, states.map((s) => s.present && s.isNull));

    const participating: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      const s = states[i]!;
      if (!s.present) continue;
      if (s.isNull && field.nullable) continue;
      participating.push(values[i]);
    }

    switch (field.type.kind) {
      case "int":
        encodeIntColumn(
          w,
          field.type as IntNode,
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
        encodeStringColumn(w, participating, fieldPath, ctx);
        break;
      default:
        for (let i = 0; i < participating.length; i++) {
          encodeNode(w, field.type, participating[i], `${fieldPath}[${i}]`, depth + 2, ctx);
        }
    }
  }
}

export function decodeColumnarArray(
  r: Reader,
  node: ArrayNode,
  path: string,
  depth: number,
  inflate?: Inflate,
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

  const out: Record<string, unknown>[] = Array.from({ length: count }, () => ({}));
  const leaves = flattenLeaves(element)!;

  const containerOf = (row: Record<string, unknown>, segs: readonly string[]): Record<string, unknown> => {
    let obj = row;
    for (let d = 0; d < segs.length - 1; d++) {
      const seg = segs[d]!;
      // guard against a schema field literally named __proto__ polluting the prototype
      let next = Object.prototype.hasOwnProperty.call(obj, seg) ? obj[seg] : undefined;
      if (typeof next !== "object" || next === null) {
        next = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(obj, seg, { value: next, enumerable: true, writable: true, configurable: true });
      }
      obj = next as Record<string, unknown>;
    }
    return obj;
  };

  for (const leaf of leaves) {
    const field = leaf.field;
    const leafName = leaf.segs[leaf.segs.length - 1]!;
    const fieldPath = `${path}[].${leaf.segs.join(".")}`;
    if (depth + 1 + leaf.segs.length > r.limits.maxDepth) {
      throw new DecodeError("depth", `${fieldPath}: nesting deeper than ${r.limits.maxDepth}`);
    }
    // nested structs are required and non-nullable: materialize the container chain at
    // this leaf's declared position for every row, so an all-absent nested struct still
    // round-trips and keys stay in declared order across implementations
    if (leaf.segs.length > 1) {
      for (let i = 0; i < count; i++) containerOf(out[i]!, leaf.segs);
    }
    const presence = field.optional ? readBitmap(r, count, fieldPath) : null;
    const nulls = field.nullable ? readBitmap(r, count, fieldPath) : null;

    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const present = presence ? presence[i]! : true;
      const isNull = nulls ? nulls[i]! : false;
      if (!present) {
        if (isNull) throw new DecodeError("bitmap", `${path}[${i}].${leafName}: null bit set for absent field`);
        continue;
      }
      if (isNull) {
        containerOf(out[i]!, leaf.segs)[leafName] = null;
        continue;
      }
      slots.push(i);
    }

    switch (field.type.kind) {
      case "int": {
        const values = decodeIntColumn(r, field.type as IntNode, slots.length, fieldPath);
        slots.forEach((row, j) => (containerOf(out[row]!, leaf.segs)[leafName] = values[j]!));
        break;
      }
      case "float64": {
        const values = decodeFloatColumn(r, slots.length, fieldPath);
        slots.forEach((row, j) => (containerOf(out[row]!, leaf.segs)[leafName] = values[j]!));
        break;
      }
      case "bool": {
        const values = readBitmap(r, slots.length, fieldPath);
        slots.forEach((row, j) => (containerOf(out[row]!, leaf.segs)[leafName] = values[j]!));
        break;
      }
      case "string": {
        const values = decodeStringColumn(r, slots.length, fieldPath, inflate);
        slots.forEach((row, j) => (containerOf(out[row]!, leaf.segs)[leafName] = values[j]!));
        break;
      }
      default: {
        for (const row of slots) {
          containerOf(out[row]!, leaf.segs)[leafName] = decodeNode(r, field.type, `${path}[${row}].${leafName}`, depth + 2, false);
        }
      }
    }
  }

  return out;
}
