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
      return;
    }
    case "enum": {
      if (node.members.length === 0) fail(path, "enum needs at least one member");
      const seen = new Set<string>();
      for (const m of node.members) {
        if (typeof m !== "string" || m.length === 0) fail(path, "enum members must be non-empty strings");
        if (seen.has(m)) fail(path, `duplicate enum member "${m}"`);
        seen.add(m);
      }
      return;
    }
    case "nullable": {
      if (node.inner.kind === "nullable") fail(path, "nullable(nullable) is invalid");
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
        if (seen.has(f.name)) fail(path, `duplicate field "${f.name}"`);
        seen.add(f.name);
        if (f.nullable && f.type.kind === "nullable") {
          fail(`${path}.${f.name}`, "nullable flag on a nullable type is ambiguous");
        }
        validateIR(f.type, `${path}.${f.name}`);
      }
      return;
    }
    default:
      fail(path, `unknown IR kind ${(node as { kind: string }).kind}`);
  }
}
