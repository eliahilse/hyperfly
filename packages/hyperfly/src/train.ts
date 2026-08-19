import { MAX_DICT_ENTRIES, columnCount, enumerateColumns, type Profile, type ProfileColumn } from "./profile.js";
import { columnarEligible, flattenLeaves } from "./columnar.js";
import { hasLoneSurrogate, type IRNode } from "./ir.js";

export interface TrainOptions {
  /** A value must appear at least this often across the samples to be considered. */
  minOccurrences?: number;
  maxEntries?: number;
}

const encoder = new TextEncoder();

function ulebLen(value: number): number {
  let n = 1;
  let v = value;
  while (v > 0x7f) {
    v >>= 7;
    n++;
  }
  return n;
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

function collect(node: IRNode, value: unknown, base: number, counts: Map<number, Map<string, number>>): void {
  if (value === undefined || value === null) return;
  switch (node.kind) {
    case "array": {
      if (!Array.isArray(value)) return;
      if (columnarEligible(node)) {
        const leaves = flattenLeaves(node.element as Extract<IRNode, { kind: "struct" }>);
        if (!leaves) return;
        leaves.forEach((leaf, i) => {
          if (leaf.field.type.kind !== "string") return;
          const ordinal = base + i;
          let bucket = counts.get(ordinal);
          if (!bucket) counts.set(ordinal, (bucket = new Map()));
          for (const row of value) {
            let holder: unknown = row;
            for (const seg of leaf.segs.slice(0, -1)) {
              if (typeof holder !== "object" || holder === null) return;
              holder = (holder as Record<string, unknown>)[seg];
            }
            if (typeof holder !== "object" || holder === null) continue;
            const v = (holder as Record<string, unknown>)[leaf.segs[leaf.segs.length - 1]!];
            if (typeof v === "string") bucket.set(v, (bucket.get(v) ?? 0) + 1);
          }
        });
        return;
      }
      for (const item of value) collect(node.element, item, base, counts);
      return;
    }
    case "nullable":
      collect(node.inner, value, base, counts);
      return;
    case "struct": {
      if (typeof value !== "object" || value === null) return;
      let fieldColumn = base;
      for (const f of node.fields) {
        const fieldBase = fieldColumn;
        fieldColumn += columnCount(f.type);
        collect(f.type, (value as Record<string, unknown>)[f.name], fieldBase, counts);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Reference trainer. Explicitly non-normative (spec §6.5): any document meeting
 * §6.2 is a valid profile, and the artifact pins the exact bytes, so
 * implementations need not agree on how one is produced.
 *
 * A dictionary hit costs one byte and saves `len(uvarint) + len(utf8)`; a miss
 * costs one byte. Entries are capped at 127 so every code is a single byte,
 * which keeps the objective linear instead of self-referential.
 */
export function train(ir: IRNode, samples: readonly unknown[], options: TrainOptions = {}): Profile | undefined {
  const minOccurrences = options.minOccurrences ?? 2;
  const maxEntries = Math.min(options.maxEntries ?? MAX_DICT_ENTRIES, MAX_DICT_ENTRIES);
  const counts = new Map<number, Map<string, number>>();
  for (const sample of samples) collect(ir, sample, 0, counts);

  const kinds = enumerateColumns(ir);
  const columns: ProfileColumn[] = [];

  for (const [ordinal, bucket] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (kinds[ordinal]?.kind !== "string") continue;
    // Frequency order first, so the shortest codes land on the most frequent values.
    // Code length then depends only on position, which keeps the objective linear
    // instead of self-referential, and lets a trailing entry be dropped safely.
    const ranked = [...bucket.entries()]
      .filter(([value, n]) => n >= minOccurrences && !hasLoneSurrogate(value))
      .sort((a, b) => b[1] - a[1] || compareUtf8(a[0], b[0]))
      .slice(0, maxEntries);

    const kept: string[] = [];
    for (const [value, n] of ranked) {
      const bytes = encoder.encode(value).length;
      const plain = bytes + ulebLen(bytes);
      const code = ulebLen(kept.length + 1);
      if (n * (plain - code) <= 0) break;
      kept.push(value);
    }

    if (kept.length > 0) columns.push({ leaf: ordinal, dict: kept });
  }

  return columns.length > 0 ? { version: 1, shared: { columns } } : undefined;
}
