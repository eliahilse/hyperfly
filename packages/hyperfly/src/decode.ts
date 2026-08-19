import { columnarEligible, decodeColumnarArray } from "./columnar.js";
import { DecodeError } from "./errors.js";
import type { IRNode } from "./ir.js";
import type { Reader } from "./reader.js";
import { INT_MAX, INT_MIN, readUleb, unzigzag } from "./varint.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail(code: "type" | "range" | "utf8" | "float" | "marker" | "bitmap" | "depth" | "limit", path: string, message: string): never {
  throw new DecodeError(code, `${path}: ${message}`);
}

function readCount(r: Reader, limit: number, what: string, path: string): number {
  const raw = readUleb(r);
  if (raw > BigInt(limit)) fail("limit", path, `${what} ${raw} exceeds limit ${limit}`);
  return Number(raw);
}

function decodeInt(r: Reader, node: Extract<IRNode, { kind: "int" }>, path: string): number {
  let value: bigint;
  if (node.min !== undefined) {
    value = readUleb(r) + BigInt(node.min);
  } else {
    value = unzigzag(readUleb(r));
  }
  if (value < BigInt(INT_MIN) || value > BigInt(INT_MAX)) {
    fail("range", path, `decoded integer ${value} outside the v0 domain`);
  }
  const num = Number(value);
  if (node.min !== undefined && num < node.min) fail("range", path, `${num} below declared min ${node.min}`);
  if (node.max !== undefined && num > node.max) fail("range", path, `${num} above declared max ${node.max}`);
  return num;
}

export function readBitmap(r: Reader, count: number, path: string): boolean[] {
  const bits: boolean[] = new Array<boolean>(count);
  for (let base = 0; base < count; base += 8) {
    const byte = r.u8();
    const used = Math.min(8, count - base);
    if (used < 8 && byte >> used !== 0) fail("bitmap", path, "nonzero bitmap padding");
    for (let bit = 0; bit < used; bit++) bits[base + bit] = (byte & (1 << bit)) !== 0;
  }
  return bits;
}

export type Inflate = (data: Uint8Array, maxOutputLength: number) => Uint8Array;

export function decodeNode(
  r: Reader,
  node: IRNode,
  path: string,
  depth: number,
  columnar: boolean,
  inflate?: Inflate,
): unknown {
  if (depth > r.limits.maxDepth) fail("depth", path, `nesting deeper than ${r.limits.maxDepth}`);

  switch (node.kind) {
    case "bool": {
      const b = r.u8();
      if (b > 1) fail("marker", path, `invalid bool byte 0x${b.toString(16)}`);
      return b === 1;
    }
    case "int":
      return decodeInt(r, node, path);
    case "float64": {
      const value = r.f64le();
      if (!Number.isFinite(value)) fail("float", path, "non-finite float64");
      if (value === 0 && r.isNegativeZeroAt(8)) fail("float", path, "negative-zero bit pattern");
      return value;
    }
    case "string": {
      const len = readCount(r, r.limits.maxByteLength, "string length", path);
      const bytes = r.bytes(len);
      try {
        return utf8.decode(bytes);
      } catch {
        fail("utf8", path, "invalid UTF-8");
      }
      break;
    }
    case "bytes": {
      const len = readCount(r, r.limits.maxByteLength, "bytes length", path);
      return r.bytes(len).slice();
    }
    case "literal":
      return node.value;
    case "enum": {
      const index = readUleb(r);
      if (index >= BigInt(node.members.length)) {
        fail("range", path, `enum index ${index} out of range`);
      }
      return node.members[Number(index)]!;
    }
    case "nullable": {
      const marker = r.u8();
      if (marker === 0) return null;
      if (marker !== 1) fail("marker", path, `invalid nullable marker 0x${marker.toString(16)}`);
      return decodeNode(r, node.inner, path, depth + 1, columnar, inflate);
    }
    case "array": {
      if (columnar && columnarEligible(node)) {
        return decodeColumnarArray(r, node, path, depth, inflate);
      }
      const count = node.length ?? readCount(r, r.limits.maxItems, "array count", path);
      const out = new Array<unknown>(count);
      for (let i = 0; i < count; i++) out[i] = decodeNode(r, node.element, `${path}[${i}]`, depth + 1, columnar, inflate);
      return out;
    }
    case "struct": {
      const optionalCount = node.fields.reduce((n, f) => n + (f.optional ? 1 : 0), 0);
      const nullableCount = node.fields.reduce((n, f) => n + (f.nullable ? 1 : 0), 0);
      const presence = readBitmap(r, optionalCount, path);
      const nulls = readBitmap(r, nullableCount, path);
      let pi = 0;
      let ni = 0;
      const out: Record<string, unknown> = {};
      for (const field of node.fields) {
        const present = field.optional ? presence[pi++]! : true;
        const isNull = field.nullable ? nulls[ni++]! : false;
        if (!present) {
          if (isNull) fail("bitmap", `${path}.${field.name}`, "null bit set for absent field");
          continue;
        }
        if (isNull) {
          out[field.name] = null;
          continue;
        }
        out[field.name] = decodeNode(r, field.type, `${path}.${field.name}`, depth + 1, columnar, inflate);
      }
      return out;
    }
  }
}
