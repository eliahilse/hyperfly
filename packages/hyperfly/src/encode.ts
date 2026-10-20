import { columnarEligible, encodeColumnarArray } from "./columnar.js";
import { columnCount, type ProfileIndex } from "./profile.js";
import { EncodeError, type ErrorCode } from "./errors.js";
import { hasPayload, literalBytes, utf8Lengths, type IRNode } from "./ir.js";
import { isUint8Array } from "./typed-array.js";
import { INT_MAX, INT_MIN, writeUleb, zigzag } from "./varint.js";
import { Writer } from "./writer.js";

const encoder = new TextEncoder();

function fail(code: ErrorCode, path: string, message: string): never {
  throw new EncodeError(code, `${path}: ${message}`);
}

/** A struct value is an object tagged "[object Object]": typed arrays, Map, Set, Date and boxed primitives are not. */
export function isStructValue(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return Object.prototype.toString.call(value) === "[object Object]";
  } catch {
    return false;
  }
}

function checkSurrogates(s: string, path: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("utf8", path, "lone high surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail("utf8", path, "lone low surrogate");
    }
  }
}

export interface EncodeCtx {
  maxDepth: number;
  maxItems: number;
  maxByteLength: number;
  maxAmplification: number;
  maxTotalItems: number;
  maxTotalBytes: number;
  maxByteAmplification: number;
  /** array counts charged so far in this body, columnar arrays once with their row count */
  items: number;
  /** decoded string and bytes bytes charged so far in this body, as a decoder charges them */
  bytes: number;
  columnar: boolean;
  deflate?: (data: Uint8Array) => Uint8Array;
  /** packing is only canonical when the same codec can also inflate what it wrote */
  canInflate: boolean;
  profile: ProfileIndex;
}

/**
 * Wire-v0 §6 from the encoder's side: the array's own bytes after its count are
 * a lower bound of what the decoder will see remaining, so the encoder is the
 * stricter side and what it accepts, its decoder accepts. The one-bit floor
 * the decoder holds a row-encoded array of non-zero-bit elements to is
 * enforced here too, for the rare element (a fixed columnar array of
 * single-member enums) that is not zero-bit yet packs to nothing.
 */
export function checkAmplification(count: number, payloadBytes: number, floor: boolean, ctx: EncodeCtx, path: string): void {
  if (count > (payloadBytes + 1) * ctx.maxAmplification) {
    fail("limit", path, `${count} rows in ${payloadBytes} payload byte(s) exceeds the amplification limit`);
  }
  if (floor && count > payloadBytes * 8) {
    fail("limit", path, `${count} items in ${payloadBytes} payload byte(s) fall below the one-bit floor`);
  }
}

/** Charge an array's count on entry; a sum past maxTotalItems can be refused before the body is complete. */
export function chargeItems(count: number, ctx: EncodeCtx, path: string): void {
  ctx.items += count;
  if (ctx.items > ctx.maxTotalItems) {
    fail("limit", path, `${ctx.items} items in this body exceed maxTotalItems ${ctx.maxTotalItems}`);
  }
}

/** The item budget against the final body length, once the body is complete. */
export function checkItemBudget(ctx: EncodeCtx, bodyLength: number): void {
  const cap = Math.min(ctx.maxTotalItems, ctx.maxAmplification * (bodyLength + 1));
  if (ctx.items > cap) fail("limit", "$", `${ctx.items} items in a ${bodyLength}-byte body exceed the item budget of ${cap}`);
}

/** Charge a string or bytes value's decoded length; a sum past maxTotalBytes can be refused before the body is complete. */
export function chargeBytes(n: number, ctx: EncodeCtx, path: string, index?: number): void {
  ctx.bytes += n;
  if (ctx.bytes > ctx.maxTotalBytes) {
    const at = index === undefined ? path : `${path}[${index}]`;
    fail("limit", at, `${ctx.bytes} decoded bytes in this body exceed maxTotalBytes ${ctx.maxTotalBytes}`);
  }
}

/** The byte budget against the final body length, once the body is complete. */
export function checkByteBudget(ctx: EncodeCtx, bodyLength: number): void {
  const cap = Math.min(ctx.maxTotalBytes, ctx.maxByteAmplification * (bodyLength + 1));
  if (ctx.bytes > cap) {
    fail("limit", "$", `${ctx.bytes} decoded bytes in a ${bodyLength}-byte body exceed the byte budget of ${cap}`);
  }
}

export function typeAcceptsNull(node: IRNode): boolean {
  return node.kind === "nullable" || (node.kind === "literal" && node.value === null);
}

export function utf8Bytes(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string") fail("type", path, "expected string");
  checkSurrogates(value, path);
  return encoder.encode(value);
}

function encodeInt(w: Writer, node: Extract<IRNode, { kind: "int" }>, value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("type", path, `expected a safe integer, got ${typeof value === "number" ? value : typeof value}`);
  }
  if (value < INT_MIN || value > INT_MAX) fail("type", path, "outside the v0 integer domain");
  if (node.min !== undefined && value < node.min) fail("range", path, `${value} below declared min ${node.min}`);
  if (node.max !== undefined && value > node.max) fail("range", path, `${value} above declared max ${node.max}`);
  if (node.min !== undefined) writeUleb(w, BigInt(value) - BigInt(node.min));
  else writeUleb(w, zigzag(BigInt(value)));
}

export function writeBitmap(w: Writer, bits: boolean[]): void {
  for (let base = 0; base < bits.length; base += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8 && base + bit < bits.length; bit++) {
      if (bits[base + bit]) byte |= 1 << bit;
    }
    w.u8(byte);
  }
}

export function encodeNode(
  w: Writer,
  node: IRNode,
  value: unknown,
  path: string,
  depth: number,
  ctx: EncodeCtx,
  column = 0,
): void {
  if (depth > ctx.maxDepth) fail("depth", path, `nesting deeper than ${ctx.maxDepth}`);

  switch (node.kind) {
    case "bool": {
      if (typeof value !== "boolean") fail("type", path, "expected boolean");
      w.u8(value ? 1 : 0);
      return;
    }
    case "int":
      encodeInt(w, node, value, path);
      return;
    case "float64": {
      if (typeof value !== "number") fail("type", path, "expected number");
      if (!Number.isFinite(value)) fail("float", path, "float64 must be finite");
      w.f64le(Object.is(value, -0) ? 0 : value);
      return;
    }
    case "string": {
      const bytes = utf8Bytes(value, path);
      if (bytes.length > ctx.maxByteLength) fail("limit", path, `string of ${bytes.length} bytes exceeds the codec limit`);
      chargeBytes(bytes.length, ctx, path);
      writeUleb(w, BigInt(bytes.length));
      w.bytes(bytes);
      return;
    }
    case "bytes": {
      if (!(value instanceof Uint8Array) && !isUint8Array(value)) fail("type", path, "expected Uint8Array");
      if (value.length > ctx.maxByteLength) fail("limit", path, `bytes of ${value.length} exceeds the codec limit`);
      chargeBytes(value.length, ctx, path);
      writeUleb(w, BigInt(value.length));
      w.bytes(value);
      return;
    }
    case "literal": {
      const matches = node.value === null ? value === null : value === node.value;
      if (!matches) fail("type", path, `expected literal ${JSON.stringify(node.value)}`);
      chargeBytes(literalBytes(node), ctx, path);
      return;
    }
    case "enum": {
      if (typeof value !== "string") fail("type", path, "expected enum member string");
      const index = node.members.indexOf(value);
      if (index < 0) fail("type", path, `"${value}" is not an enum member`);
      chargeBytes(utf8Lengths(node.members)[index]!, ctx, path);
      writeUleb(w, BigInt(index));
      return;
    }
    case "nullable": {
      if (value === null) {
        w.u8(0);
        return;
      }
      w.u8(1);
      encodeNode(w, node.inner, value, path, depth + 1, ctx, column);
      return;
    }
    case "array": {
      if (ctx.columnar && columnarEligible(node)) {
        encodeColumnarArray(w, node, value, path, depth, ctx, column);
        return;
      }
      if (!Array.isArray(value)) fail("type", path, "expected array");
      if (value.length > ctx.maxItems) fail("limit", path, `array of ${value.length} items exceeds the codec limit`);
      if (node.length !== undefined) {
        if (value.length !== node.length) fail("type", path, `fixed array expects ${node.length} items, got ${value.length}`);
      } else {
        writeUleb(w, BigInt(value.length));
      }
      chargeItems(value.length, ctx, path);
      const payloadStart = w.size;
      for (let i = 0; i < value.length; i++) {
        encodeNode(w, node.element, value[i], `${path}[${i}]`, depth + 1, ctx, column);
      }
      checkAmplification(value.length, w.size - payloadStart, hasPayload(node.element), ctx, path);
      return;
    }
    case "struct": {
      if (!isStructValue(value)) fail("type", path, "expected object");
      const record = value;
      // own properties only, snapshotted once: inherited Object.prototype members are not data,
      // and accessor properties must not desync the bitmap from the payload
      const snapshot = node.fields.map((field) =>
        Object.prototype.hasOwnProperty.call(record, field.name) ? record[field.name] : undefined,
      );
      const presence: boolean[] = [];
      const nulls: boolean[] = [];
      node.fields.forEach((field, i) => {
        const v = snapshot[i];
        const absent = v === undefined;
        if (absent && !field.optional) fail("required", `${path}.${field.name}`, "required field missing");
        if (v === null && !field.nullable && !typeAcceptsNull(field.type)) {
          fail("type", `${path}.${field.name}`, "null for non-nullable field");
        }
        if (field.optional) presence.push(!absent);
        if (field.nullable) nulls.push(!absent && v === null);
      });
      writeBitmap(w, presence);
      writeBitmap(w, nulls);
      // columns advance in declared field order, matching the §6.1 walk exactly
      let fieldColumn = column;
      node.fields.forEach((field, i) => {
        const v = snapshot[i];
        const base = fieldColumn;
        fieldColumn += columnCount(field.type);
        if (v === undefined) return;
        if (v === null && field.nullable) return;
        encodeNode(w, field.type, v, `${path}.${field.name}`, depth + 1, ctx, base);
      });
      return;
    }
  }
}
