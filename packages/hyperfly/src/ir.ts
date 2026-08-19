import { HyperflyError } from "./errors.js";
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

function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function hasLoneSurrogate(s: string): boolean {
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

export function validateIR(node: IRNode, path = "$"): void {
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
      const ok =
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        (isSafeInt(v) && !Object.is(v, -0));
      if (!ok) fail(path, "literal must be string, boolean, null, or a safe integer");
      if (typeof v === "string") checkString(v, path, "literal string");
      return;
    }
    case "enum": {
      if (node.members.length === 0) fail(path, "enum needs at least one member");
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
      if (node.inner.kind === "nullable") fail(path, "nullable(nullable) is invalid");
      if (node.inner.kind === "literal" && node.inner.value === null) {
        fail(path, "nullable(literal null) has two encodings for null");
      }
      validateIR(node.inner, `${path}?`);
      return;
    }
    case "array": {
      if (node.length !== undefined && (!isSafeInt(node.length) || node.length < 0)) {
        fail(path, "fixed array length must be a non-negative safe integer");
      }
      validateIR(node.element, `${path}[]`);
      return;
    }
    case "struct": {
      const seen = new Set<string>();
      for (const f of node.fields) {
        if (typeof f.name !== "string" || f.name.length === 0) fail(path, "field names must be non-empty strings");
        checkString(f.name, path, "field name");
        checkFieldName(f.name, path);
        if (seen.has(f.name)) fail(path, `duplicate field "${f.name}"`);
        seen.add(f.name);
        if (f.nullable && f.type.kind === "nullable") {
          fail(`${path}.${f.name}`, "nullable flag on a nullable type is ambiguous");
        }
        if (f.nullable && f.type.kind === "literal" && f.type.value === null) {
          fail(`${path}.${f.name}`, "nullable flag on a null literal has two encodings for null");
        }
        validateIR(f.type, `${path}.${f.name}`);
      }
      return;
    }
    default:
      fail(path, `unknown IR kind ${(node as { kind: string }).kind}`);
  }
}

/** Whether one element of this type always consumes at least one bit on the wire. */
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
