/**
 * Schema inference and measurement for the playground. Everything here runs in
 * the visitor's browser; payloads never leave the page.
 *
 * Inference is deliberately the schema a developer would plausibly declare —
 * ints get a zero floor when every observed value is non-negative, strings
 * upgrade to enums only under clear repetition — and the inferred schema is
 * shown verbatim, so nothing is hidden in the numbers. Everything is measured
 * in-sample and the UI says so.
 */
import { gzipSync, deflateSync, inflateSync } from "fflate";
import { compileIR, train, type IRNode } from "hyperfly";

export interface InferError {
  path: string;
  message: string;
}

const enc = new TextEncoder();
const MAX_DEPTH = 64;

export const packHooks = {
  deflate: (data: Uint8Array) => deflateSync(data, { level: 6 }),
  // spec §4: exactly one complete stream — fflate ignores trailing bytes, so
  // probe: a tight stream breaks when its last byte is dropped, a padded one does not
  inflate: (data: Uint8Array, maxOutputLength: number) => {
    const out = inflateSync(data);
    if (out.length > maxOutputLength) throw new Error("inflated beyond the declared size");
    if (data.length > 0) {
      let tight = false;
      try {
        inflateSync(data.subarray(0, data.length - 1));
      } catch {
        tight = true;
      }
      if (!tight) throw new Error("trailing bytes after the deflate stream");
    }
    return out;
  },
};

class Unsupported extends Error {
  constructor(public readonly detail: InferError) {
    super(detail.message);
  }
}

type Kind = "number" | "string" | "boolean" | "object" | "array";

function kindOf(value: unknown, path: string): Kind {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Unsupported({ path, message: "JSON cannot carry a non-finite number" });
    return "number";
  }
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "object";
  throw new Unsupported({ path, message: `cannot infer a schema for ${String(value)}` });
}

interface InferCtx {
  /** paths where no value was ever observed, so the type is an assumption */
  assumptions: string[];
}

/** Infer one node from every non-null observation of a position. */
function inferNode(values: unknown[], path: string, depth: number, ctx: InferCtx): IRNode {
  if (depth > MAX_DEPTH) {
    throw new Unsupported({ path, message: `nesting deeper than the codec's limit of ${MAX_DEPTH}` });
  }
  if (values.length === 0) {
    ctx.assumptions.push(path);
    return { kind: "string" };
  }
  const kinds = new Set(values.map((v) => kindOf(v, path)));
  if (kinds.size > 1) {
    throw new Unsupported({
      path,
      message: `sometimes ${[...kinds].join(", sometimes ")} — hyperfly needs one type per field`,
    });
  }
  const kind = [...kinds][0]!;

  if (kind === "boolean") return { kind: "bool" };

  if (kind === "number") {
    const nums = values as number[];
    if (nums.every((n) => Number.isSafeInteger(n))) {
      return nums.every((n) => n >= 0) ? { kind: "int", min: 0 } : { kind: "int" };
    }
    return { kind: "float64" };
  }

  if (kind === "string") {
    const strs = values as string[];
    const distinct = new Set(strs);
    if (strs.length >= 6 && !distinct.has("") && distinct.size <= 8 && distinct.size * 2 <= strs.length) {
      return { kind: "enum", members: [...distinct] };
    }
    return { kind: "string" };
  }

  if (kind === "array") {
    const elements = (values as unknown[][]).flat();
    const nonNull = elements.filter((e) => e !== null);
    // a nullable wrapper is its own node on the wire, so it costs a depth level too
    const wrapped = nonNull.length < elements.length;
    const element = inferNode(nonNull, `${path}[]`, depth + (wrapped ? 2 : 1), ctx);
    return {
      kind: "array",
      element: nonNull.length < elements.length ? { kind: "nullable", inner: element } : element,
    };
  }

  // object → struct: union of keys, optional when absent somewhere, nullable when null somewhere
  const objects = values as Record<string, unknown>[];
  const names: string[] = [];
  for (const obj of objects) {
    for (const name of Object.keys(obj)) if (!names.includes(name)) names.push(name);
  }
  const fields = names.map((name) => {
    const present = objects.filter((o) => Object.prototype.hasOwnProperty.call(o, name));
    const observed = present.map((o) => o[name]);
    const nonNull = observed.filter((v) => v !== null);
    const label = /[.[\]]/.test(name) ? JSON.stringify(name) : name;
    const type = inferNode(nonNull, `${path}.${label}`, depth + 1, ctx);
    const field: { name: string; type: IRNode; optional?: boolean; nullable?: boolean } = { name, type };
    if (present.length < objects.length) field.optional = true;
    if (nonNull.length < observed.length) field.nullable = true;
    return field;
  });
  if (fields.length === 0) throw new Unsupported({ path, message: "an empty object has nothing to encode" });
  return { kind: "struct", fields };
}

export function inferIR(messages: unknown[]): { ir: IRNode; assumptions: string[] } | { error: InferError } {
  try {
    const nonNull = messages.filter((m) => m !== null);
    if (nonNull.length !== messages.length) {
      return { error: { path: "$", message: "a whole response cannot be null" } };
    }
    const ctx: InferCtx = { assumptions: [] };
    return { ir: inferNode(messages, "$", 0, ctx), assumptions: ctx.assumptions };
  } catch (err) {
    if (err instanceof Unsupported) return { error: err.detail };
    throw err;
  }
}

/**
 * Ordinal → dotted path, mirroring spec §6.1: depth-first, nullable into its
 * inner node, ineligible arrays into their element, eligible arrays emit their
 * flattened leaves and stop. Used only to label what the profile learned.
 */
export function columnPaths(ir: IRNode): string[] {
  const out: string[] = [];
  const COLUMN_KINDS = new Set(["bool", "int", "float64", "string", "bytes", "enum", "literal"]);
  const seg = (name: string) => (/[.[\]]/.test(name) ? JSON.stringify(name) : name);

  const flatten = (node: IRNode, prefix: string): string[] | null => {
    if (node.kind !== "struct" || node.fields.length === 0) return null;
    const leaves: string[] = [];
    for (const f of node.fields) {
      const at = prefix ? `${prefix}.${seg(f.name)}` : seg(f.name);
      if (f.type.kind === "struct") {
        if (f.optional || f.nullable) return null;
        const inner = flatten(f.type, at);
        if (!inner) return null;
        leaves.push(...inner);
      } else if (COLUMN_KINDS.has(f.type.kind)) {
        leaves.push(at);
      } else {
        return null;
      }
    }
    return leaves;
  };

  const walk = (node: IRNode, prefix: string): void => {
    switch (node.kind) {
      case "array": {
        const leaves = flatten(node.element, prefix ? `${prefix}[]` : "[]");
        if (leaves) {
          out.push(...leaves);
          return;
        }
        walk(node.element, `${prefix}[]`);
        return;
      }
      case "nullable":
        walk(node.inner, prefix);
        return;
      case "struct":
        for (const f of node.fields) walk(f.type, prefix ? `${prefix}.${seg(f.name)}` : seg(f.name));
        return;
      default:
        return;
    }
  };
  walk(ir, "");
  return out;
}

/** Structural equality with JSON semantics, indifferent to object key order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") return a === b; // 0 vs -0 both fine on the wire
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

export interface LearnedColumn {
  path: string;
  what: string;
}

export interface Measurement {
  messages: number;
  json: number;
  gzip: number;
  hyperfly: number;
  profiled?: number;
  /** corpus mode ran training but nothing was worth learning */
  trainedNothing?: boolean;
  fingerprint: string;
  /** full serialized codec artifacts a peer fetches once, uncompressed */
  artifactBytes: number;
  profiledArtifactBytes?: number;
  breakEven?: number;
  learned: LearnedColumn[];
  roundTripOk: boolean;
}

function renderGrammar(tokens: readonly unknown[]): string {
  return (tokens as ({ lit: string } | { num: { base: number; len: number } })[])
    .map((t) => ("lit" in t ? t.lit : `{base${t.num.base}×${t.num.len}}`))
    .join("");
}

export function measure(ir: IRNode, messages: unknown[]): Measurement | { error: InferError } {
  try {
    let json = 0;
    let gzip = 0;
    for (const m of messages) {
      const bytes = enc.encode(JSON.stringify(m));
      json += bytes.length;
      gzip += gzipSync(bytes, { level: 6 }).length;
    }

    const plain = compileIR(ir, { plan: "columnar", pack: packHooks });
    let hyperfly = 0;
    let roundTripOk = true;
    for (const m of messages) {
      const wire = plain.encode(m as never);
      hyperfly += wire.length;
      if (!deepEqual(plain.decode(wire), m)) roundTripOk = false;
    }

    const base: Measurement = {
      messages: messages.length,
      json,
      gzip,
      hyperfly,
      fingerprint: plain.fingerprint,
      artifactBytes: enc.encode(plain.artifact).length,
      learned: [],
      roundTripOk,
    };
    if (messages.length < 2) return base;

    const profile = train(ir, messages as never[]);
    if (!profile) return { ...base, trainedNothing: true };
    const profiled = compileIR(ir, { plan: "columnar", profile, pack: packHooks });
    let profiledBytes = 0;
    for (const m of messages) {
      const wire = profiled.encode(m as never);
      profiledBytes += wire.length;
      if (!deepEqual(profiled.decode(wire), m)) roundTripOk = false;
    }

    const paths = columnPaths(ir);
    const learned: LearnedColumn[] = [];
    for (const column of profile.shared.columns) {
      const path = paths[column.leaf] ?? `column ${column.leaf}`;
      if (column.dict) learned.push({ path, what: `dictionary · ${column.dict.length} values` });
      if (column.grammar) learned.push({ path, what: `grammar ${renderGrammar(column.grammar)}` });
      if (column.derived) {
        learned.push({
          path,
          what: `derived from ${paths[column.derived.source] ?? `column ${column.derived.source}`}`,
        });
      }
    }

    const profiledArtifactBytes = enc.encode(profiled.artifact).length;
    const savedPerMessage = (hyperfly - profiledBytes) / messages.length;
    return {
      ...base,
      profiled: profiledBytes,
      profiledArtifactBytes,
      breakEven:
        savedPerMessage > 0
          ? Math.ceil((profiledArtifactBytes - base.artifactBytes) / savedPerMessage)
          : undefined,
      learned,
      roundTripOk,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: { path: "$", message } };
  }
}

/** Pretty, compact rendering of the inferred IR for the transparency panel. */
export function renderIR(node: IRNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  switch (node.kind) {
    case "struct": {
      const fields = node.fields
        .map((f) => {
          const name = `${f.name}${f.optional ? "?" : ""}`;
          const type = `${renderIR(f.type, indent + 1).trimStart()}${f.nullable ? " | null" : ""}`;
          return `${pad}  ${name}: ${type}`;
        })
        .join("\n");
      return `${pad}{\n${fields}\n${pad}}`;
    }
    case "array":
      return `${pad}array of ${renderIR(node.element, indent).trimStart()}`;
    case "nullable":
      return `${pad}${renderIR(node.inner, indent).trimStart()} | null`;
    case "enum":
      return `${pad}enum(${node.members.join(" | ")})`;
    case "int":
      return `${pad}int${node.min !== undefined ? ` ≥ ${node.min}` : ""}`;
    default:
      return `${pad}${node.kind}`;
  }
}
