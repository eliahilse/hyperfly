import { columnarEligible, flattenLeaves } from "./columnar.js";
import { HyperflyError } from "./errors.js";
import { hasLoneSurrogate } from "./ir.js";
import type { IRNode } from "./ir.js";

export interface ProfileColumn {
  leaf: number;
  dict: readonly string[];
}

export interface SharedProfile {
  columns: readonly ProfileColumn[];
}

export interface Profile {
  version: 1;
  shared: SharedProfile;
  /** Advisory encoder guidance; never part of the artifact or the fingerprint. */
  hints?: Record<string, unknown>;
}

export const MAX_DICT_ENTRIES = 16383;

export interface ColumnRef {
  ordinal: number;
  kind: IRNode["kind"];
}

/**
 * Spec §6.1: one total enumeration of every columnar leaf in the schema.
 * Ordinals, not textual paths — field names may contain dots and brackets, so a
 * dotted path can bind two different leaves to the same key.
 */
export function enumerateColumns(ir: IRNode): ColumnRef[] {
  const out: ColumnRef[] = [];
  const walk = (node: IRNode): void => {
    switch (node.kind) {
      case "array": {
        if (columnarEligible(node)) {
          const leaves = flattenLeaves(node.element as Extract<IRNode, { kind: "struct" }>);
          if (leaves) {
            for (const leaf of leaves) out.push({ ordinal: out.length, kind: leaf.field.type.kind });
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

export function validateProfile(ir: IRNode, profile: Profile): void {
  const fail = (message: string): never => {
    throw new HyperflyError("ir", `profile: ${message}`);
  };

  if (profile.version !== 1) fail(`unsupported profile version ${profile.version}`);
  const columns = enumerateColumns(ir);
  let previous = -1;

  for (const column of profile.shared.columns) {
    if (!Number.isSafeInteger(column.leaf) || column.leaf < 0 || column.leaf >= columns.length) {
      fail(`leaf ${column.leaf} is not a column in this schema`);
    }
    if (column.leaf <= previous) fail("columns must be sorted by ascending leaf and unique");
    previous = column.leaf;
    if (columns[column.leaf]!.kind !== "string") fail(`leaf ${column.leaf} is not a string column`);
    if (column.dict.length === 0 || column.dict.length > MAX_DICT_ENTRIES) {
      fail(`leaf ${column.leaf}: a dictionary holds 1 to ${MAX_DICT_ENTRIES} entries`);
    }
    const seen = new Set<string>();
    for (const entry of column.dict) {
      if (typeof entry !== "string") fail(`leaf ${column.leaf}: entries must be strings`);
      if (hasLoneSurrogate(entry)) {
        fail(`leaf ${column.leaf}: entry contains a lone surrogate and has no portable encoding`);
      }
      if (seen.has(entry)) fail(`leaf ${column.leaf}: duplicate entry gives one value two codes`);
      seen.add(entry);
    }
  }
}

/** Maps a leaf ordinal to its dictionary, plus the reverse index used at encode. */
export interface ProfileIndex {
  dictOf(ordinal: number): readonly string[] | undefined;
  codeOf(ordinal: number, value: string): number | undefined;
}

export function indexProfile(profile: Profile | undefined): ProfileIndex {
  if (!profile) {
    return { dictOf: () => undefined, codeOf: () => undefined };
  }
  const dicts = new Map<number, readonly string[]>();
  const codes = new Map<number, Map<string, number>>();
  for (const column of profile.shared.columns) {
    dicts.set(column.leaf, column.dict);
    const lookup = new Map<string, number>();
    column.dict.forEach((entry, i) => lookup.set(entry, i + 1));
    codes.set(column.leaf, lookup);
  }
  return {
    dictOf: (ordinal) => dicts.get(ordinal),
    codeOf: (ordinal, value) => codes.get(ordinal)?.get(value),
  };
}
