import { HyperflyError } from "./errors.js";
import { checkIRNesting } from "./nesting.js";
import { INT_MAX, INT_MIN } from "./varint.js";

export type LiteralValue = string | number | boolean | null;

export type IRNode =
  | { kind: "bool" }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "float64" }
  | { kind: "string" }
  | { kind: "bytes" }
  | { kind: "literal"; value: LiteralValue }
  | { kind: "enum"; members: readonly string[] }
  | { kind: "nullable"; inner: IRNode }
  | { kind: "array"; element: IRNode; length?: number }
  | { kind: "struct"; fields: readonly IRField[] };

export interface IRField {
  name: string;
  type: IRNode;
  optional?: boolean;
  nullable?: boolean;
}

function fail(path: string, message: string): never {
  throw new HyperflyError("ir", `${path}: ${message}`);
}

/** Message text for an untrusted JSON value, without calling any method it may carry. */
export function describeValue(v: unknown): string {
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object" && v !== null) return "an object";
  return String(v);
}

/** Runs fn, reporting a call-stack overflow on deeply nested untrusted input as invalid IR. */
export function withinStack<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    // untrusted JSON can nest deeper than the host stack; that is invalid IR, not a crash
    if (e instanceof RangeError) throw new HyperflyError("ir", "IR or profile nesting exceeds the call stack");
    throw e;
  }
}

function isObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function checkString(v: string, path: string, what: string): void {
  if (hasLoneSurrogate(v)) fail(path, `${what} contains a lone surrogate and has no portable encoding`);
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/** Field names must survive as insertion-ordered object keys in every host language. */
function checkFieldName(name: string, path: string): void {
  if (name === "__proto__") fail(path, 'field name "__proto__" is not portable');
  if (ARRAY_INDEX.test(name) && Number(name) < 0xffffffff) {
    fail(path, `field name "${name}" is an array index and would reorder as an object key`);
  }
}

const NODE_KEYS: Record<IRNode["kind"], readonly string[]> = {
  bool: ["kind"],
  int: ["kind", "min", "max"],
  float64: ["kind"],
  string: ["kind"],
  bytes: ["kind"],
  literal: ["kind", "value"],
  enum: ["kind", "members"],
  nullable: ["kind", "inner"],
  array: ["kind", "element", "length"],
  struct: ["kind", "fields"],
};

const FIELD_KEYS: readonly string[] = ["name", "type", "optional", "nullable"];

function checkKeys(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `unknown key ${key}`);
  }
}

export function validateIR(node: IRNode, path = "$"): void {
  checkIRNesting(node);
  withinStack(() => checkNode(node, path));
}

function checkNode(node: IRNode, path: string): void {
  if (!isObject(node)) fail(path, "IR node must be an object");
  if (typeof node.kind === "string" && Object.prototype.hasOwnProperty.call(NODE_KEYS, node.kind)) {
    checkKeys(node, NODE_KEYS[node.kind], path);
  }
  switch (node.kind) {
    case "bool":
    case "float64":
    case "string":
    case "bytes":
      return;
    case "int": {
      if (node.min !== undefined && (!isSafeInt(node.min) || node.min < INT_MIN)) {
        fail(path, "int min must be a safe integer in the v0 domain");
      }
      if (node.max !== undefined && (!isSafeInt(node.max) || node.max > INT_MAX)) {
        fail(path, "int max must be a safe integer in the v0 domain");
      }
      if (node.min !== undefined && node.max !== undefined && node.min > node.max) {
        fail(path, "int min exceeds max");
      }
      return;
    }
    case "literal": {
      const v = node.value;
      const ok = v === null || typeof v === "string" || typeof v === "boolean" || isSafeInt(v);
      if (!ok) fail(path, "literal must be string, boolean, null, or a safe integer");
      if (typeof v === "string") checkString(v, path, "literal string");
      return;
    }
    case "enum": {
      if (!Array.isArray(node.members)) fail(path, "enum members must be an array");
      if (node.members.length === 0) fail(path, "enum needs at least one member");
      let width = 0;
      let highest = BigInt(node.members.length - 1);
      while (highest > 0n) {
        highest >>= 1n;
        width++;
      }
      if (width > 56) fail(path, "enum member count requires a column width above 56 bits");
      const seen = new Set<string>();
      for (const m of node.members) {
        if (typeof m !== "string" || m.length === 0) fail(path, "enum members must be non-empty strings");
        checkString(m, path, "enum member");
        if (seen.has(m)) fail(path, `duplicate enum member "${m}"`);
        seen.add(m);
      }
      return;
    }
    case "nullable": {
      if (!isObject(node.inner)) fail(path, "nullable inner must be an IR object");
      if (node.inner.kind === "nullable") fail(path, "nullable(nullable) is invalid");
      if (node.inner.kind === "literal" && node.inner.value === null) {
        fail(path, "nullable(literal null) has two encodings for null");
      }
      checkNode(node.inner, `${path}?`);
      return;
    }
    case "array": {
      if (node.length !== undefined && (!isSafeInt(node.length) || node.length < 0)) {
        fail(path, "fixed array length must be a non-negative safe integer");
      }
      checkNode(node.element, `${path}[]`);
      return;
    }
    case "struct": {
      if (!Array.isArray(node.fields)) fail(path, "struct fields must be an array");
      const seen = new Set<string>();
      for (const f of node.fields) {
        if (!isObject(f)) fail(path, "struct fields must be objects");
        checkKeys(f, FIELD_KEYS, path);
        if (typeof f.name !== "string" || f.name.length === 0) fail(path, "field names must be non-empty strings");
        checkString(f.name, path, "field name");
        checkFieldName(f.name, path);
        if (seen.has(f.name)) fail(path, `duplicate field "${f.name}"`);
        seen.add(f.name);
        for (const flag of ["optional", "nullable"] as const) {
          if (f[flag] !== undefined && typeof f[flag] !== "boolean") fail(`${path}.${f.name}`, `${flag} flag must be a boolean`);
        }
        if (!isObject(f.type)) fail(`${path}.${f.name}`, "field type must be an IR object");
        if (f.nullable && f.type.kind === "nullable") {
          fail(`${path}.${f.name}`, "nullable flag on a nullable type is ambiguous");
        }
        if (f.nullable && f.type.kind === "literal" && f.type.value === null) {
          fail(`${path}.${f.name}`, "nullable flag on a null literal has two encodings for null");
        }
        checkNode(f.type, `${path}.${f.name}`);
      }
      return;
    }
    default:
      fail(path, `unknown IR kind ${describeValue((node as { kind: unknown }).kind)}`);
  }
}

/** False exactly for the zero-bit types of wire-v0 §6, which the one-bit floor does not cover. */
export function hasPayload(node: IRNode): boolean {
  switch (node.kind) {
    case "literal":
      return false;
    case "struct":
      return node.fields.some((f) => f.optional || f.nullable || hasPayload(f.type));
    case "array":
      return node.length === undefined || (node.length > 0 && hasPayload(node.element));
    default:
      return true;
  }
}

/** UTF-8 byte length of a string without lone surrogates, computed without encoding it. */
export function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 2;
      i++;
    } else n += 2;
  }
  return n;
}

const lengthCache = new WeakMap<object, readonly number[]>();

/** UTF-8 byte lengths of a frozen schema or profile string list, computed once per list. */
export function utf8Lengths(strings: readonly string[]): readonly number[] {
  let lengths = lengthCache.get(strings);
  if (!lengths) {
    lengths = strings.map(utf8Length);
    lengthCache.set(strings, lengths);
  }
  return lengths;
}

const literalCache = new WeakMap<object, number>();

/** Decoded bytes a literal node charges to the byte budget: its UTF-8 length, or 0 when not a string. */
export function literalBytes(node: Extract<IRNode, { kind: "literal" }>): number {
  if (typeof node.value !== "string") return 0;
  let n = literalCache.get(node);
  if (n === undefined) {
    n = utf8Length(node.value);
    literalCache.set(node, n);
  }
  return n;
}
