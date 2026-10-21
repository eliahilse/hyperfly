import { columnarEligible, flattenLeaves } from "./columnar.js";
import { HyperflyError, isInstance } from "./errors.js";
import { describeValue, hasLoneSurrogate, validateIR, withinStack } from "./ir.js";
import type { IRNode } from "./ir.js";

/** Letter case of grammar digits; decimal tokens require `lower` (plan-columnar-v5 §6.3). */
export type GrammarCase = "lower" | "upper";
/** Radix of a fixed-width numeric grammar token (plan-columnar-v5 §6.3). */
export type GrammarBase = 10 | 16 | 36;

/** Fixed-width unsigned digit run in a string grammar (plan-columnar-v5 §6.3). */
export interface GrammarNum {
  /** Radix used to parse and reconstruct digits. */
  base: GrammarBase;
  /** Digit count: 1–15 for base 10, 1–13 for base 16, or 1–10 for base 36. */
  len: number;
  /** Case required for alphabetic digits; base 10 uses `lower`. */
  case: GrammarCase;
}

/** Non-empty literal text or a numeric run; adjacent literal tokens are invalid (plan-columnar-v5 §6.3). */
export type GrammarToken = { lit: string } | { num: GrammarNum };

/** String lookup driven by an earlier dictionary column in the same eligible array (plan-columnar-v5 §6.4). */
export interface Derivation {
  /** Global leaf ordinal of the earlier string column whose profile contains the source dictionary. */
  source: number;
  /** Reconstructed target strings in source-dictionary order, one per entry. */
  values: readonly string[];
}

/** Shared models for one string leaf; version 2 requires at least one model (plan-columnar-v5 §6.2). */
export interface ProfileColumn {
  /** Global leaf ordinal across eligible arrays in schema traversal order (plan-columnar-v5 §6.1). */
  leaf: number;
  /** Ordered, unique strings: 1–16383 entries, with one-based codes and zero reserved for escapes. */
  dict?: readonly string[];
  /** One to eight tokens with at least one numeric run; requires profile version 2. */
  grammar?: readonly GrammarToken[];
  /** Mapping from an earlier dictionary column; requires profile version 2. */
  derived?: Derivation;
}

/** Shared profile content embedded in the artifact and fingerprint (plan-columnar-v5 §6.5). */
export interface SharedProfile {
  /** Non-empty string-column models, sorted by ascending leaf ordinal with no duplicates. */
  columns: readonly ProfileColumn[];
}

/** Training document with fingerprinted shared models and optional advisory hints (plan-columnar-v5 §6.2). */
export interface Profile {
  /** Document shape: 1 requires dictionaries only; 2 also permits grammars and derivations. */
  version: 1 | 2;
  /** Models needed to encode and decode shared column modes. */
  shared: SharedProfile;
  /** Advisory encoder guidance; never part of the artifact or the fingerprint. */
  hints?: Record<string, unknown>;
}

/** Maximum entries in one shared dictionary (plan-columnar-v5 §6.2). */
export const MAX_DICT_ENTRIES = 16383;

export interface ColumnRef {
  ordinal: number;
  kind: IRNode["kind"];
  /** Identity of the eligible array that owns this leaf, used for derivation scope. */
  array: number;
}

/**
 * Spec §6.1: one total enumeration of every columnar leaf in the schema.
 * Ordinals, not textual paths — field names may contain dots and brackets, so a
 * dotted path can bind two different leaves to the same key.
 */
export function enumerateColumns(ir: IRNode): ColumnRef[] {
  const out: ColumnRef[] = [];
  let nextArray = 0;
  const walk = (node: IRNode): void => {
    switch (node.kind) {
      case "array": {
        if (columnarEligible(node)) {
          const leaves = flattenLeaves(node.element as Extract<IRNode, { kind: "struct" }>);
          if (leaves) {
            const array = nextArray++;
            for (const leaf of leaves) {
              out.push({ ordinal: out.length, kind: leaf.field.type.kind, array });
            }
            return;
          }
        }
        walk(node.element);
        return;
      }
      case "nullable":
        walk(node.inner);
        return;
      case "struct":
        for (const f of node.fields) walk(f.type);
        return;
      default:
        return;
    }
  };
  walk(ir);
  return out;
}

/**
 * Columnar leaves under this node. A pure function of the subtree, so two schema
 * positions sharing one node object still count the same — which is why column
 * bases are threaded positionally rather than looked up by node identity.
 */
export function columnCount(node: IRNode): number {
  switch (node.kind) {
    case "array": {
      if (columnarEligible(node)) {
        const leaves = flattenLeaves(node.element as Extract<IRNode, { kind: "struct" }>);
        if (leaves) return leaves.length;
      }
      return columnCount(node.element);
    }
    case "nullable":
      return columnCount(node.inner);
    case "struct":
      return node.fields.reduce((n, f) => n + columnCount(f.type), 0);
    default:
      return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function snapshotProfile(profile: Profile): Profile {
  const active = new WeakSet<object>();
  const stack: {
    source: Record<string, unknown> | unknown[];
    copy: object;
    keys: string[] | undefined;
    length: number;
    next: number;
  }[] = [];
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null) {
      throw new HyperflyError("ir", "profile: must contain only JSON data");
    }
    if (active.has(value)) throw new HyperflyError("ir", "profile: must not contain cycles");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new HyperflyError("ir", "profile: must contain only plain objects and arrays");
    }
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (array) {
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new HyperflyError("ir", "profile: arrays must contain only indexed JSON data");
        }
      } else {
        if (typeof key !== "string") throw new HyperflyError("ir", "profile: JSON keys must be strings");
        keys.push(key);
      }
    }
    const copy = array ? new Array<unknown>(value.length) : {};
    active.add(value);
    stack.push({ source: value as Record<string, unknown> | unknown[], copy, keys: array ? undefined : keys, length: array ? value.length : keys.length, next: 0 });
    return copy;
  };
  try {
    const result = visit(profile) as Profile;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next === frame.length) {
        active.delete(frame.source);
        stack.pop();
        continue;
      }
      const key = frame.keys ? frame.keys[frame.next++]! : String(frame.next++);
      const value = visit((frame.source as Record<string, unknown>)[key]);
      Object.defineProperty(frame.copy, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } catch (cause) {
    if (isInstance(cause, HyperflyError) && cause.code === "ir") throw cause;
    throw new HyperflyError("ir", "profile: could not read JSON data", { cause });
  }
}

/** Validates IR and profile structure, ordinals and model constraints; throws code `ir` (wire-v0 §9, plan-columnar-v5 §6). */
export function validateProfile(ir: IRNode, profile: Profile): void {
  checkedProfile(ir, profile);
}

export function checkedProfile(ir: IRNode, profile: Profile): Profile {
  // Canonical shared profiles have depth at most 7; advisory hints are excluded.
  validateIR(ir);
  return withinStack(() => checkProfile(ir, snapshotProfile(profile)));
}

function checkProfile(ir: IRNode, profile: Profile): Profile {
  const fail = (message: string): never => {
    throw new HyperflyError("ir", `profile: ${message}`);
  };
  const record = (value: unknown, path: string): Record<string, unknown> => {
    if (!isRecord(value)) throw new HyperflyError("ir", `profile: ${path} must be an object`);
    return value as Record<string, unknown>;
  };
  const keys = (
    value: Record<string, unknown>,
    path: string,
    allowed: readonly string[],
    required: readonly string[],
  ): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`${path}: unknown key ${key}`);
    }
    for (const key of required) {
      if (!own(value, key)) fail(`${path}: missing key ${key}`);
    }
  };
  const portableString = (value: unknown, path: string): string => {
    if (typeof value !== "string") throw new HyperflyError("ir", `profile: ${path} must be a string`);
    if (hasLoneSurrogate(value)) fail(`${path} contains a lone surrogate and has no portable encoding`);
    return value as string;
  };

  const root = record(profile, "document");
  keys(root, "document", ["version", "shared", "hints"], ["version", "shared"]);
  if (root.version !== 1 && root.version !== 2) {
    fail(`unsupported profile version ${describeValue(root.version)}`);
  }
  const version = root.version;
  if (own(root, "hints") && !isRecord(root.hints)) fail("hints must be an object when present");

  const shared = record(root.shared, "shared");
  keys(shared, "shared", ["columns"], ["columns"]);
  if (!Array.isArray(shared.columns)) fail("shared.columns must be an array");
  const rawColumns = shared.columns as unknown[];
  if (rawColumns.length === 0) fail("shared.columns must be non-empty");

  const schemaColumns = enumerateColumns(ir);
  const parsed: ProfileColumn[] = [];
  let previous = -1;

  for (let ci = 0; ci < rawColumns.length; ci++) {
    const path = `shared.columns[${ci}]`;
    const raw = record(rawColumns[ci], path);
    if (version === 1) {
      keys(raw, path, ["leaf", "dict"], ["leaf", "dict"]);
    } else {
      keys(raw, path, ["leaf", "dict", "grammar", "derived"], ["leaf"]);
      if (!own(raw, "dict") && !own(raw, "grammar") && !own(raw, "derived")) {
        fail(`${path} must carry at least one of dict, grammar, or derived`);
      }
    }

    if (!Number.isSafeInteger(raw.leaf)) fail(`${path}.leaf must be an integer`);
    const leaf = raw.leaf as number;
    if (leaf < 0 || leaf >= schemaColumns.length) fail(`leaf ${leaf} is not a column in this schema`);
    if (leaf <= previous) fail("columns must be sorted by ascending leaf and unique");
    previous = leaf;
    if (schemaColumns[leaf]!.kind !== "string") fail(`leaf ${leaf} is not a string column`);

    const column: ProfileColumn = { leaf };
    if (own(raw, "dict")) {
      if (!Array.isArray(raw.dict)) fail(`leaf ${leaf}: dict must be an array`);
      const rawDict = raw.dict as unknown[];
      if (rawDict.length === 0 || rawDict.length > MAX_DICT_ENTRIES) {
        fail(`leaf ${leaf}: a dictionary holds 1 to ${MAX_DICT_ENTRIES} entries`);
      }
      const seen = new Set<string>();
      const dict = rawDict.map((entry, i) => portableString(entry, `${path}.dict[${i}]`));
      for (const entry of dict) {
        if (seen.has(entry)) fail(`leaf ${leaf}: duplicate entry gives one value two codes`);
        seen.add(entry);
      }
      column.dict = dict;
    }

    if (own(raw, "grammar")) {
      if (!Array.isArray(raw.grammar)) fail(`leaf ${leaf}: grammar must be an array`);
      const rawGrammar = raw.grammar as unknown[];
      if (rawGrammar.length < 1 || rawGrammar.length > 8) {
        fail(`leaf ${leaf}: grammar must hold 1 to 8 tokens`);
      }
      const grammar: GrammarToken[] = [];
      let numeric = 0;
      let previousLiteral = false;
      for (let ti = 0; ti < rawGrammar.length; ti++) {
        const tokenPath = `${path}.grammar[${ti}]`;
        const token = record(rawGrammar[ti], tokenPath);
        const tokenKeys = Object.keys(token);
        if (tokenKeys.length !== 1 || (tokenKeys[0] !== "lit" && tokenKeys[0] !== "num")) {
          fail(`${tokenPath} must hold exactly one of lit or num`);
        }
        if (own(token, "lit")) {
          const lit = portableString(token.lit, `${tokenPath}.lit`);
          if (lit.length === 0) fail(`${tokenPath}.lit must be non-empty`);
          if (previousLiteral) fail(`leaf ${leaf}: grammar cannot contain adjacent literal tokens`);
          grammar.push({ lit });
          previousLiteral = true;
          continue;
        }

        const numPath = `${tokenPath}.num`;
        const num = record(token.num, numPath);
        keys(num, numPath, ["base", "len", "case"], ["base", "len", "case"]);
        if (num.base !== 10 && num.base !== 16 && num.base !== 36) {
          fail(`${numPath}.base must be 10, 16, or 36`);
        }
        if (!Number.isSafeInteger(num.len)) fail(`${numPath}.len must be an integer`);
        const len = num.len as number;
        const base = num.base as GrammarBase;
        const cap = base === 10 ? 15 : base === 16 ? 13 : 10;
        if (len < 1 || len > cap) fail(`${numPath}.len must be between 1 and ${cap} for base ${base}`);
        if (num.case !== "lower" && num.case !== "upper") {
          fail(`${numPath}.case must be lower or upper`);
        }
        const grammarCase = num.case as GrammarCase;
        if (base === 10 && grammarCase !== "lower") fail(`${numPath}.case must be lower for base 10`);
        grammar.push({ num: { base, len, case: grammarCase } });
        numeric++;
        previousLiteral = false;
      }
      if (numeric === 0) fail(`leaf ${leaf}: grammar needs at least one numeric token`);
      column.grammar = grammar;
    }

    if (own(raw, "derived")) {
      const derivedPath = `${path}.derived`;
      const derived = record(raw.derived, derivedPath);
      keys(derived, derivedPath, ["source", "values"], ["source", "values"]);
      if (!Number.isSafeInteger(derived.source)) fail(`${derivedPath}.source must be an integer`);
      if (!Array.isArray(derived.values)) fail(`${derivedPath}.values must be an array`);
      const rawValues = derived.values as unknown[];
      column.derived = {
        source: derived.source as number,
        values: rawValues.map((value, i) => portableString(value, `${derivedPath}.values[${i}]`)),
      };
    }
    parsed.push(column);
  }

  const byLeaf = new Map(parsed.map((column) => [column.leaf, column]));
  for (const column of parsed) {
    const derived = column.derived;
    if (!derived) continue;
    const source = derived.source;
    if (source < 0 || source >= schemaColumns.length || schemaColumns[source]!.kind !== "string") {
      fail(`leaf ${column.leaf}: derived source ${source} is not a string column`);
    }
    if (source >= column.leaf) fail(`leaf ${column.leaf}: derived source must be earlier than the target`);
    if (schemaColumns[source]!.array !== schemaColumns[column.leaf]!.array) {
      fail(`leaf ${column.leaf}: derived source must belong to the same eligible array`);
    }
    const sourceDict = byLeaf.get(source)?.dict;
    if (!sourceDict) fail(`leaf ${column.leaf}: derived source ${source} must have a dictionary in the profile`);
    const sourceLength = sourceDict!.length;
    if (derived.values.length !== sourceLength) {
      fail(`leaf ${column.leaf}: derived values length must equal source dictionary length ${sourceLength}`);
    }
  }
  return profile;
}

/** Validated profile lookup tables used by column encoders and decoders. */
export interface ProfileIndex {
  columnOf(ordinal: number): ProfileColumn | undefined;
  dictOf(ordinal: number): readonly string[] | undefined;
  grammarOf(ordinal: number): readonly GrammarToken[] | undefined;
  derivedOf(ordinal: number): Derivation | undefined;
  /** Dictionary codes are one-based; zero is reserved for a literal escape. */
  codeOf(ordinal: number, value: string): number | undefined;
}

export function indexProfile(profile: Profile | undefined): ProfileIndex {
  const columns = new Map<number, ProfileColumn>();
  const codes = new Map<number, Map<string, number>>();
  if (profile) {
    for (const column of profile.shared.columns) {
      columns.set(column.leaf, column);
      if (column.dict) {
        const lookup = new Map<string, number>();
        column.dict.forEach((entry, i) => lookup.set(entry, i + 1));
        codes.set(column.leaf, lookup);
      }
    }
  }
  return {
    columnOf: (ordinal) => columns.get(ordinal),
    dictOf: (ordinal) => columns.get(ordinal)?.dict,
    grammarOf: (ordinal) => columns.get(ordinal)?.grammar,
    derivedOf: (ordinal) => columns.get(ordinal)?.derived,
    codeOf: (ordinal, value) => codes.get(ordinal)?.get(value),
  };
}
