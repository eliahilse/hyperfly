import { columnarEligible, flattenLeaves, intColumnEncodedLength, matchGrammar } from "./columnar.js";
import { hasLoneSurrogate, type IRNode } from "./ir.js";
import {
  MAX_DICT_ENTRIES,
  columnCount,
  enumerateColumns,
  type Derivation,
  type GrammarBase,
  type GrammarCase,
  type GrammarNum,
  type GrammarToken,
  type Profile,
  type ProfileColumn,
} from "./profile.js";

export interface TrainOptions {
  /** A value must appear at least this often across the samples to be considered. */
  minOccurrences?: number;
  maxEntries?: number;
}

const encoder = new TextEncoder();

function ulebLen(value: number): number {
  let len = 1;
  let remaining = value;
  while (remaining > 0x7f) {
    remaining = Math.floor(remaining / 0x80);
    len++;
  }
  return len;
}

function bitWidth(value: number): number {
  let width = 0;
  let remaining = value;
  while (remaining > 0) {
    remaining = Math.floor(remaining / 2);
    width++;
  }
  return width;
}

function packedBytes(count: number, width: number): number {
  return Math.ceil((count * width) / 8);
}

function stringWireLength(value: string): number {
  const bytes = encoder.encode(value).length;
  return ulebLen(bytes) + bytes;
}

/** UTF-8 byte order — JS string comparison is UTF-16 code-unit order and disagrees above the BMP. */
function compareUtf8(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

interface ArraySample {
  array: number;
  columns: Map<number, (string | undefined)[]>;
}

interface TrainingData {
  batches: Map<number, string[][]>;
  arrays: ArraySample[];
}

function leafValue(row: unknown, segs: readonly string[]): unknown {
  let value = row;
  for (const seg of segs) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, seg)) return undefined;
    value = (value as Record<string, unknown>)[seg];
  }
  return value;
}

/** Collect row-aligned samples once; grammar lanes and derivations need more than frequencies. */
function collect(
  node: IRNode,
  value: unknown,
  base: number,
  columns: ReturnType<typeof enumerateColumns>,
  data: TrainingData,
): void {
  if (value === undefined || value === null) return;
  switch (node.kind) {
    case "array": {
      if (!Array.isArray(value)) return;
      if (columnarEligible(node)) {
        const leaves = flattenLeaves(node.element as Extract<IRNode, { kind: "struct" }>);
        if (!leaves) return;
        const sampled: ArraySample = { array: columns[base]?.array ?? -1, columns: new Map() };
        leaves.forEach((leaf, i) => {
          if (leaf.field.type.kind !== "string") return;
          const ordinal = base + i;
          const aligned = value.map((row) => {
            const candidate = leafValue(row, leaf.segs);
            return typeof candidate === "string" && !hasLoneSurrogate(candidate) ? candidate : undefined;
          });
          sampled.columns.set(ordinal, aligned);
          let batches = data.batches.get(ordinal);
          if (!batches) data.batches.set(ordinal, (batches = []));
          batches.push(aligned.filter((entry): entry is string => entry !== undefined));
        });
        data.arrays.push(sampled);
        return;
      }
      for (const item of value) collect(node.element, item, base, columns, data);
      return;
    }
    case "nullable":
      collect(node.inner, value, base, columns, data);
      return;
    case "struct": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      let fieldColumn = base;
      for (const field of node.fields) {
        const fieldBase = fieldColumn;
        fieldColumn += columnCount(field.type);
        const fieldValue = Object.prototype.hasOwnProperty.call(value, field.name)
          ? (value as Record<string, unknown>)[field.name]
          : undefined;
        collect(field.type, fieldValue, fieldBase, columns, data);
      }
      return;
    }
    default:
      return;
  }
}

function plainModeCost(batches: readonly string[][]): number {
  let cost = 0;
  for (const batch of batches) {
    for (const value of batch) cost += stringWireLength(value);
  }
  return cost;
}

function dictionaryModeCost(dict: readonly string[], batches: readonly string[][]): number {
  const codes = new Map(dict.map((value, i) => [value, i + 1]));
  let cost = 0;
  for (const batch of batches) {
    if (batch.length === 0) continue;
    let highest = 0;
    let escaped = 0;
    for (const value of batch) {
      const code = codes.get(value) ?? 0;
      if (code > highest) highest = code;
      if (code === 0) escaped += stringWireLength(value);
    }
    cost += 1 + packedBytes(batch.length, bitWidth(highest)) + escaped;
  }
  return cost;
}

/**
 * Non-normative dictionary induction. Frequency order is fixed first, then every
 * prefix is costed with the real message-local packed width. This remains linear:
 * adding code p only changes batches that contain that value.
 */
function induceDictionary(
  batches: readonly string[][],
  minOccurrences: number,
  maxEntries: number,
): readonly string[] | undefined {
  const counts = new Map<string, number>();
  const batchesByValue = new Map<string, number[]>();
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const seen = new Set<string>();
    for (const value of batches[batchIndex]!) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (!seen.has(value)) {
        let indices = batchesByValue.get(value);
        if (!indices) batchesByValue.set(value, (indices = []));
        indices.push(batchIndex);
        seen.add(value);
      }
    }
  }

  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= minOccurrences)
    .sort((a, b) => b[1] - a[1] || compareUtf8(a[0], b[0]))
    .slice(0, maxEntries)
    .map(([value]) => value);
  if (ranked.length === 0) return undefined;

  const states = batches.map((batch) => ({ count: batch.length, highest: 0, width: 0 }));
  const active = states.reduce((n, state) => n + (state.count > 0 ? 1 : 0), 0);
  let escapedCost = plainModeCost(batches);
  let packedCost = 0;
  let bestCost = escapedCost;
  let bestLength = 0;

  for (let index = 0; index < ranked.length; index++) {
    const value = ranked[index]!;
    const code = index + 1;
    escapedCost -= (counts.get(value) ?? 0) * stringWireLength(value);
    for (const batchIndex of batchesByValue.get(value) ?? []) {
      const state = states[batchIndex]!;
      const oldBytes = packedBytes(state.count, state.width);
      state.highest = code;
      state.width = bitWidth(state.highest);
      packedCost += packedBytes(state.count, state.width) - oldBytes;
    }
    const cost = active + packedCost + escapedCost;
    if (cost < bestCost) {
      bestCost = cost;
      bestLength = code;
    }
  }
  return bestLength > 0 ? ranked.slice(0, bestLength) : undefined;
}

interface RawToken {
  kind: "alnum" | "delim";
  text: string;
}

function asciiAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/**
 * Non-normative grammar tokenizer: maximal ASCII alphanumeric runs against
 * everything else. Whether an alphanumeric run is a literal or a numeric lane
 * is decided per aligned slot across the whole sample, not per value — a
 * classifier that looks at one value at a time misclassifies the occasional
 * all-letter hex segment and loses the grammar for the entire column.
 */
function tokenize(value: string): RawToken[] {
  const out: RawToken[] = [];
  let offset = 0;
  while (offset < value.length) {
    const alnum = asciiAlphanumeric(value[offset]!);
    let end = offset + 1;
    while (end < value.length && asciiAlphanumeric(value[end]!) === alnum) end++;
    out.push({ kind: alnum ? "alnum" : "delim", text: value.slice(offset, end) });
    offset = end;
  }
  return out;
}

function digitValue(char: string, grammarCase: GrammarCase): number {
  const code = char.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (grammarCase === "lower" && code >= 0x61 && code <= 0x7a) return code - 0x61 + 10;
  if (grammarCase === "upper" && code >= 0x41 && code <= 0x5a) return code - 0x41 + 10;
  return -1;
}

function grammarCaseAndMax(values: readonly string[]): { case: GrammarCase; max: number } | undefined {
  let lower = false;
  let upper = false;
  for (const value of values) {
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (code >= 0x61 && code <= 0x7a) lower = true;
      else if (code >= 0x41 && code <= 0x5a) upper = true;
    }
  }
  if (lower && upper) return undefined;
  const grammarCase: GrammarCase = upper ? "upper" : "lower";
  let max = 0;
  for (const value of values) {
    for (const char of value) {
      const digit = digitValue(char, grammarCase);
      if (digit < 0) return undefined;
      if (digit > max) max = digit;
    }
  }
  return { case: grammarCase, max };
}

function chooseBase(maxDigit: number, len: number): GrammarBase | undefined {
  for (const base of [10, 16, 36] as const) {
    const cap = base === 10 ? 15 : base === 16 ? 13 : 10;
    if (maxDigit < base && len <= cap) return base;
  }
  return undefined;
}


function grammarModeCost(grammar: readonly GrammarToken[], batches: readonly string[][]): number {
  const numeric = grammar.filter((token): token is Extract<GrammarToken, { num: unknown }> => "num" in token);
  let cost = 0;
  for (const batch of batches) {
    if (batch.length === 0) continue;
    cost += 1; // E = 0, so there is no conditional bitmap
    const lanes = numeric.map(() => [] as bigint[]);
    for (const value of batch) {
      const parsed = matchGrammar(value, grammar);
      if (!parsed) return Infinity; // induced from these values, so a miss means the grammar is wrong
      parsed.forEach((lane, i) => lanes[i]!.push(lane));
    }
    for (let lane = 0; lane < numeric.length; lane++) {
      const token = numeric[lane]!;
      const limit = BigInt(token.num.base) ** BigInt(token.num.len);
      cost += intColumnEncodedLength(lanes[lane]!, { min: 0n, max: limit - 1n });
    }
  }
  return cost;
}

/**
 * Induce one shared token sequence, then keep it only when its exact sample
 * cost wins. Alignment first: every value must split into the same run shape
 * (same kinds, identical delimiters, equal alphanumeric lengths). Each aligned
 * alphanumeric slot is then classified across the whole sample — identical
 * text everywhere is a literal, anything that varies is a numeric lane.
 */
function induceGrammar(
  batches: readonly string[][],
  dict: readonly string[] | undefined,
): readonly GrammarToken[] | undefined {
  const values = batches.flat();
  if (values.length === 0) return undefined;
  const tokenized = values.map(tokenize);
  const shape = tokenized[0]!;
  if (shape.length < 1) return undefined;
  for (const tokens of tokenized.slice(1)) {
    if (tokens.length !== shape.length) return undefined;
    for (let i = 0; i < shape.length; i++) {
      if (tokens[i]!.kind !== shape[i]!.kind) return undefined;
      if (shape[i]!.kind === "delim" && tokens[i]!.text !== shape[i]!.text) return undefined;
      if (shape[i]!.kind === "alnum" && tokens[i]!.text.length !== shape[i]!.text.length) return undefined;
    }
  }

  const raw: ({ lit: string } | { num: GrammarNum })[] = [];
  for (let tokenIndex = 0; tokenIndex < shape.length; tokenIndex++) {
    const token = shape[tokenIndex]!;
    if (token.kind === "delim") {
      raw.push({ lit: token.text });
      continue;
    }
    const observed = tokenized.map((tokens) => tokens[tokenIndex]!.text);
    if (observed.every((text) => text === observed[0])) {
      raw.push({ lit: observed[0]! });
      continue;
    }
    const digitClass = grammarCaseAndMax(observed);
    if (!digitClass) return undefined;
    const base = chooseBase(digitClass.max, token.text.length);
    if (!base) return undefined;
    raw.push({
      num: {
        base,
        len: token.text.length,
        case: base === 10 ? "lower" : digitClass.case,
      },
    });
  }

  // adjacent literals merge into one token, which §6.3 requires
  const grammar: GrammarToken[] = [];
  for (const token of raw) {
    const previous = grammar[grammar.length - 1];
    if ("lit" in token && previous && "lit" in previous) {
      grammar[grammar.length - 1] = { lit: previous.lit + token.lit };
    } else {
      grammar.push(token);
    }
  }
  if (grammar.length > 8 || !grammar.some((token) => "num" in token)) return undefined;

  const grammarCost = grammarModeCost(grammar, batches);
  const plainCost = plainModeCost(batches);
  const dictCost = dict ? dictionaryModeCost(dict, batches) : Infinity;
  return grammarCost < Math.min(plainCost, dictCost) ? grammar : undefined;
}

function detectDerivation(
  source: number,
  target: number,
  dict: readonly string[],
  array: number,
  samples: readonly ArraySample[],
): Derivation | undefined {
  const dictIndex = new Map(dict.map((value, i) => [value, i]));
  const values: (string | undefined)[] = new Array(dict.length).fill(undefined);
  for (const sample of samples) {
    if (sample.array !== array) continue;
    const sources = sample.columns.get(source) ?? [];
    const targets = sample.columns.get(target) ?? [];
    const rows = Math.max(sources.length, targets.length);
    for (let row = 0; row < rows; row++) {
      const sourceValue = sources[row];
      const targetValue = targets[row];
      if (sourceValue === undefined) continue;
      const index = dictIndex.get(sourceValue);
      if (index === undefined) return undefined;
      if (targetValue === undefined) continue;
      if (values[index] !== undefined && values[index] !== targetValue) return undefined;
      values[index] = targetValue;
    }
  }
  if (values.some((value) => value === undefined)) return undefined;
  return { source, values: values as string[] };
}

/**
 * Deterministic reference trainer. Explicitly non-normative (spec §6.7): the
 * artifact pins its output, but other trainers may make different valid choices.
 *
 * Dictionary prefix costing, grammar induction, and functional-dependency
 * detection are intentionally separated here so none is mistaken for wire logic.
 */
export function train(ir: IRNode, samples: readonly unknown[], options: TrainOptions = {}): Profile | undefined {
  const minOccurrences = Math.max(1, Math.floor(options.minOccurrences ?? 2));
  const maxEntries = Math.max(0, Math.min(Math.floor(options.maxEntries ?? MAX_DICT_ENTRIES), MAX_DICT_ENTRIES));
  const refs = enumerateColumns(ir);
  const data: TrainingData = { batches: new Map(), arrays: [] };
  for (const sample of samples) collect(ir, sample, 0, refs, data);

  const byLeaf = new Map<number, ProfileColumn>();
  for (const ref of refs) {
    if (ref.kind !== "string") continue;
    const batches = data.batches.get(ref.ordinal) ?? [];
    const dict = induceDictionary(batches, minOccurrences, maxEntries);
    const grammar = induceGrammar(batches, dict);
    if (dict || grammar) byLeaf.set(ref.ordinal, { leaf: ref.ordinal, ...(dict ? { dict } : {}), ...(grammar ? { grammar } : {}) });
  }

  // Non-normative derivation detection. If several earlier sources qualify, the
  // lowest source ordinal wins; a profile can carry only one derivation per target.
  for (const target of refs) {
    if (target.kind !== "string") continue;
    for (const source of refs) {
      if (source.ordinal >= target.ordinal) break;
      if (source.kind !== "string" || source.array !== target.array) continue;
      const dict = byLeaf.get(source.ordinal)?.dict;
      if (!dict) continue;
      const derived = detectDerivation(source.ordinal, target.ordinal, dict, target.array, data.arrays);
      if (!derived) continue;
      const column = byLeaf.get(target.ordinal) ?? { leaf: target.ordinal };
      column.derived = derived;
      byLeaf.set(target.ordinal, column);
      break;
    }
  }

  const columns = [...byLeaf.values()].sort((a, b) => a.leaf - b.leaf);
  if (columns.length === 0) return undefined;
  const version = columns.some((column) => column.grammar || column.derived) ? 2 : 1;
  return { version, shared: { columns } };
}
