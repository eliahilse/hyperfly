import { compileIR, type Codec, type CompileOptions } from "./codec.js";
import { UnsupportedSchemaError } from "./errors.js";
import type { IRField, IRNode, LiteralValue } from "./ir.js";
import { INT_MAX, INT_MIN } from "./varint.js";

interface ZodDef {
  type: string;
}

type DefRecord = ZodDef & Record<string, unknown>;

interface ZodInternals {
  def: ZodDef;
  bag?: Record<string, unknown>;
  output?: unknown;
}

export interface ZodSchemaLike {
  _zod: ZodInternals;
  parse?: (value: unknown) => unknown;
}

export type InferOutput<S> = S extends { _zod: { output: infer O } } ? O : unknown;

export interface ZodCompileOptions extends CompileOptions {
  validate?: boolean;
}

function unsupported(path: string, message: string): never {
  throw new UnsupportedSchemaError(path, message);
}

function internals(schema: unknown, path: string): ZodInternals {
  const z = (schema as ZodSchemaLike | undefined)?._zod;
  if (!z || typeof z.def?.type !== "string") {
    unsupported(path, "not a zod 4 schema (no _zod internals)");
  }
  return z;
}

function boundValue(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw;
}

/** Intersect inclusive and exclusive bounds into one integer minimum, or undefined if only the domain default. */
function intMin(bag: Record<string, unknown>, path: string): number | undefined {
  let bound: number | undefined;
  const inclusive = boundValue(bag.minimum);
  if (inclusive !== undefined) bound = Math.ceil(inclusive);
  const exclusive = boundValue(bag.exclusiveMinimum);
  if (exclusive !== undefined) {
    const fromExcl = Math.floor(exclusive) + 1;
    bound = bound === undefined ? fromExcl : Math.max(bound, fromExcl);
  }
  if (bound === undefined) return undefined;
  if (bound < INT_MIN || bound > INT_MAX) unsupported(path, `int min ${bound} outside the v0 integer domain`);
  return bound === INT_MIN ? undefined : bound;
}

function intMax(bag: Record<string, unknown>, path: string): number | undefined {
  let bound: number | undefined;
  const inclusive = boundValue(bag.maximum);
  if (inclusive !== undefined) bound = Math.floor(inclusive);
  const exclusive = boundValue(bag.exclusiveMaximum);
  if (exclusive !== undefined) {
    const fromExcl = Math.ceil(exclusive) - 1;
    bound = bound === undefined ? fromExcl : Math.min(bound, fromExcl);
  }
  if (bound === undefined) return undefined;
  if (bound < INT_MIN || bound > INT_MAX) unsupported(path, `int max ${bound} outside the v0 integer domain`);
  return bound === INT_MAX ? undefined : bound;
}

interface Unwrapped {
  inner: ZodInternals;
  optional: boolean;
  nullable: boolean;
}

function unwrap(z: ZodInternals, path: string): Unwrapped {
  let current = z;
  let optional = false;
  let nullable = false;
  for (;;) {
    const def = current.def as DefRecord;
    if (def.type === "optional") {
      optional = true;
      current = internals(def.innerType, path);
    } else if (def.type === "nullable") {
      nullable = true;
      current = internals(def.innerType, path);
    } else {
      return { inner: current, optional, nullable };
    }
  }
}

function nodeOf(z: ZodInternals, path: string): IRNode {
  const def = z.def as DefRecord;
  const bag = z.bag ?? {};

  switch (def.type) {
    case "boolean":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "number": {
      const format = (bag.format ?? def.format) as string | undefined;
      if (format === "safeint") {
        const min = intMin(bag, path);
        const max = intMax(bag, path);
        return {
          kind: "int",
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        };
      }
      if (format !== undefined && format !== "float64" && format !== "double") {
        unsupported(path, `number format "${format}" has no v0 encoding`);
      }
      return { kind: "float64" };
    }
    case "enum": {
      const entries = def.entries as Record<string, unknown> | undefined;
      if (!entries) unsupported(path, "enum without entries");
      const members = Object.values(entries);
      if (members.length === 0) unsupported(path, "empty enum");
      if (!members.every((m): m is string => typeof m === "string")) {
        unsupported(path, "only string enums are supported in v0");
      }
      return { kind: "enum", members };
    }
    case "literal": {
      const values = def.values as readonly unknown[] | undefined;
      if (!values || values.length !== 1) {
        unsupported(path, "multi-value literals have no v0 encoding");
      }
      const v = values[0];
      const ok =
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isSafeInteger(v));
      if (!ok) unsupported(path, "literal must be string, boolean, null, or a safe integer");
      return { kind: "literal", value: v as LiteralValue };
    }
    case "array": {
      const { inner, optional, nullable } = unwrap(internals(def.element, `${path}[]`), `${path}[]`);
      if (optional) unsupported(`${path}[]`, "optional array elements have no v0 encoding");
      let element = nodeOf(inner, `${path}[]`);
      if (nullable) element = { kind: "nullable", inner: element };
      return { kind: "array", element };
    }
    case "object": {
      if (def.catchall !== undefined) {
        unsupported(path, "catchall/loose objects have no v0 encoding");
      }
      const shape = def.shape as Record<string, unknown> | undefined;
      if (!shape) unsupported(path, "object without shape");
      const fields: IRField[] = [];
      for (const [name, fieldSchema] of Object.entries(shape)) {
        const fieldPath = `${path}.${name}`;
        const { inner, optional, nullable } = unwrap(internals(fieldSchema, fieldPath), fieldPath);
        const field: IRField = { name, type: nodeOf(inner, fieldPath) };
        if (optional) field.optional = true;
        if (nullable) field.nullable = true;
        fields.push(field);
      }
      return { kind: "struct", fields };
    }
    default:
      unsupported(path, `zod type "${def.type}" has no v0 encoding — declare it out of the schema or wait for a plan that supports it`);
  }
}

export function toIR(schema: ZodSchemaLike): IRNode {
  const { inner, optional, nullable } = unwrap(internals(schema, "$"), "$");
  if (optional) unsupported("$", "top-level optional has no v0 encoding");
  const node = nodeOf(inner, "$");
  return nullable ? { kind: "nullable", inner: node } : node;
}

export function compile<S extends ZodSchemaLike>(
  schema: S,
  options: ZodCompileOptions = {},
): Codec<InferOutput<S>> {
  const codec = compileIR<InferOutput<S>>(toIR(schema), options);
  if (!options.validate) return codec;

  if (typeof schema.parse !== "function") {
    unsupported("$", "validate: true requires a schema with .parse()");
  }
  const parse = (value: unknown) => schema.parse!(value) as InferOutput<S>;
  return {
    ...codec,
    encode: (value) => codec.encode(parse(value)),
    decode: (bytes) => parse(codec.decode(bytes)),
    encodeBody: (value) => codec.encodeBody(parse(value)),
    decodeBody: (bytes) => parse(codec.decodeBody(bytes)),
  };
}
