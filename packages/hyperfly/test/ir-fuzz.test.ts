import { describe, expect, test } from "bun:test";
import { compileIR, HyperflyError, train, validateIR, validateProfile, type IRNode, type Profile } from "../src/index.js";

/**
 * compileIR takes IR and profiles that may arrive as untyped JSON, so for ANY JSON
 * value it must either compile or throw a HyperflyError with code "ir". Never a
 * TypeError or RangeError. Mirrors python/tests/test_ir_fuzz.py.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ["bool", "int", "float64", "string", "bytes", "enum", "literal", "nullable", "array", "struct", "junk"];
const IR_KEYS = ["element", "inner", "fields", "members", "value", "min", "max", "length", "name", "type", "optional", "nullable"];
const NUMBERS = [0, -0, 1, 1.0, 1.5, -1, 3, 2 ** 53 - 1, 2 ** 53, -(2 ** 53), 1e300, 0.1];
const STRINGS = ["", "x", "lower", "upper", "lit", "num", "__proto__", "0", "\ud800", ...KINDS];

function generator(rand: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

  const scalar = (): unknown => {
    const r = rand();
    if (r < 0.15) return null;
    if (r < 0.3) return rand() < 0.5;
    if (r < 0.65) return rand() < 0.7 ? pick(NUMBERS) : Math.floor((rand() - 0.5) * 2 ** 40);
    return pick(STRINGS);
  };

  const json = (depth: number): unknown => {
    const r = rand();
    if (depth <= 0 || r < 0.4) return scalar();
    if (r < 0.55) return Array.from({ length: Math.floor(rand() * 4) }, () => json(depth - 1));
    if (r < 0.7) return ir(depth - 1);
    const out: Record<string, unknown> = {};
    for (let i = Math.floor(rand() * 4); i > 0; i--) out[rand() < 0.5 ? pick(IR_KEYS) : pick(STRINGS)] = json(depth - 1);
    return out;
  };

  /** Near-valid IR: a known kind with plausible keys, each sometimes wrong. */
  const ir = (depth: number): unknown => {
    const kind = pick(KINDS);
    const node: Record<string, unknown> = { kind };
    const near = (): unknown => (rand() < 0.75 ? undefined : json(depth - 1));
    const set = (key: string, value: unknown): void => {
      const wrong = near();
      if (rand() < 0.85) node[key] = wrong === undefined ? value : wrong;
    };
    if (kind === "int") {
      set("min", pick(NUMBERS));
      set("max", pick(NUMBERS));
    } else if (kind === "literal") {
      set("value", scalar());
    } else if (kind === "enum") {
      set("members", Array.from({ length: Math.floor(rand() * 3) }, () => pick(STRINGS)));
    } else if (kind === "nullable") {
      set("inner", depth > 0 ? ir(depth - 1) : { kind: "bool" });
    } else if (kind === "array") {
      set("element", depth > 0 ? ir(depth - 1) : { kind: "bool" });
      if (rand() < 0.4) set("length", pick(NUMBERS));
    } else if (kind === "struct") {
      set(
        "fields",
        Array.from({ length: Math.floor(rand() * 3) }, (_, i) => {
          const field: Record<string, unknown> = { name: rand() < 0.8 ? `f${i}` : scalar(), type: depth > 0 ? ir(depth - 1) : { kind: "bool" } };
          if (rand() < 0.3) field.optional = rand() < 0.8 ? rand() < 0.5 : scalar();
          if (rand() < 0.3) field.nullable = rand() < 0.8 ? rand() < 0.5 : scalar();
          if (rand() < 0.1) field[pick(STRINGS)] = scalar();
          return field;
        }),
      );
    }
    if (rand() < 0.1) node[rand() < 0.5 ? pick(IR_KEYS) : "extra"] = json(depth - 1);
    return node;
  };

  const column = (depth: number): unknown => {
    const out: Record<string, unknown> = { leaf: rand() < 0.8 ? 0 : pick(NUMBERS) };
    if (rand() < 0.6) out.dict = rand() < 0.8 ? ["a", "b"].slice(0, 1 + Math.floor(rand() * 2)) : json(depth);
    if (rand() < 0.4) {
      out.grammar =
        rand() < 0.7
          ? [{ lit: "id_" }, { num: { base: pick([10, 16, 36, 8, 10.5]), len: pick([1, 2, 0, 1.5, 16]), case: pick(["lower", "upper", "x"]) } }]
          : json(depth);
    }
    if (rand() < 0.2) out.derived = rand() < 0.5 ? { source: pick(NUMBERS), values: ["v"] } : json(depth);
    if (rand() < 0.1) out[pick(STRINGS)] = scalar();
    return out;
  };

  /** Near-valid profiles for the fixed IR below, each part sometimes wrong. */
  const profile = (): unknown => {
    if (rand() < 0.2) return json(3);
    const out: Record<string, unknown> = {
      version: rand() < 0.8 ? pick([1, 2]) : scalar(),
      shared: rand() < 0.9 ? { columns: Array.from({ length: Math.floor(rand() * 3) }, () => column(2)) } : json(2),
    };
    if (rand() < 0.2) out.hints = json(2);
    if (rand() < 0.05) out.extra = scalar();
    return out;
  };

  return { json, ir, profile };
}

const PROFILE_IR: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
};

/** Whether the input compiled; any failure other than a HyperflyError of code ir is rethrown. */
function compilesOrRejects(attempt: () => unknown, input: unknown): boolean {
  try {
    attempt();
    return true;
  } catch (e) {
    if (e instanceof HyperflyError && e.code === "ir") return false;
    const shown = JSON.stringify(input)?.slice(0, 300);
    throw new Error(`uncoded ${(e as Error).name} for ${shown}: ${(e as Error).message}`);
  }
}

function deep(levels: number): unknown {
  let node: unknown = { kind: "bool" };
  for (let i = 0; i < levels; i++) node = { kind: "array", element: node };
  return node;
}

const PINNED_IR: unknown[] = [
  null,
  [],
  0,
  "bool",
  true,
  {},
  { kind: [] },
  { kind: null },
  { kind: { toString: null } },
  { kind: [{ toString: null }] },
  { kind: "array" },
  { kind: "nullable" },
  { kind: "literal" },
  { kind: "struct" },
  { kind: "struct", fields: "x" },
  { kind: "struct", fields: [null] },
  { kind: "struct", fields: [{ name: "x" }] },
  { kind: "struct", fields: [{ name: "x", type: [], nullable: true }] },
  { kind: "struct", fields: [{ name: "x", type: { kind: "bool" }, optional: [] }] },
  { kind: "struct", fields: [{ type: { kind: "bool" } }] },
  { kind: "enum", members: 1 },
  { kind: "enum", members: [1] },
  { kind: "enum", members: [{}] },
  { kind: "array", element: [] },
  { kind: "array", element: null },
  { kind: "nullable", inner: [] },
  { kind: "nullable", inner: null },
  { kind: "int", min: true },
  { kind: "int", min: -0, max: 1.0 },
  { kind: "literal", value: -0 },
  { kind: "literal", value: {} },
  { kind: "bool", extra: 1 },
  deep(200_000),
];

const PINNED_PROFILES: unknown[] = [
  null,
  0,
  "x",
  [],
  {},
  { version: 2 },
  { version: 2, shared: null },
  { version: 2, shared: { columns: null } },
  { version: 2, shared: { columns: [null] } },
  { version: 2, shared: { columns: [{ leaf: 0, grammar: [{ num: { base: [], len: 1, case: "lower" } }] }] } },
  { version: 2, shared: { columns: [{ leaf: 0, grammar: [null] }] } },
  { version: 2, shared: { columns: [{ leaf: 0, grammar: [{ num: null }] }] } },
  { version: 2, shared: { columns: [{ leaf: 0, derived: null }] } },
  { version: 2, shared: { columns: [{ leaf: 0, derived: { source: 0, values: null } }] } },
  { version: 2 ** 60, shared: { columns: [] } },
  { version: { toString: null }, shared: { columns: [] } },
  { version: 1, shared: { columns: [{ leaf: 2 ** 60, dict: ["a"] }] } },
  { version: 1, shared: { columns: [{ leaf: -0, dict: ["a"] }] }, hints: deep(200_000) },
];

describe("IR fuzzing", () => {
  test("pinned shapes compile or fail with code ir", () => {
    for (const input of PINNED_IR) {
      for (const plan of ["row", "columnar"] as const) {
        compilesOrRejects(() => compileIR(input as IRNode, { plan }), input);
      }
    }
    for (const profile of PINNED_PROFILES) {
      compilesOrRejects(() => compileIR(PROFILE_IR, { plan: "columnar", profile: profile as Profile }), profile);
      compilesOrRejects(() => validateProfile(PROFILE_IR, profile as Profile), profile);
    }
  });

  test("pinned shapes pass validateIR, train and validateProfile or fail with code ir", () => {
    const empty: Profile = { version: 1, shared: { columns: [] } };
    for (const input of PINNED_IR) {
      compilesOrRejects(() => train(input as IRNode, []), input);
      compilesOrRejects(() => validateIR(input as IRNode), input);
      compilesOrRejects(() => validateProfile(input as IRNode, empty), input);
    }
  });

  test("arbitrary JSON as IR compiles or fails with code ir", () => {
    const gen = generator(mulberry32(0x1f2e3d4c));
    let compiled = 0;
    for (let i = 0; i < 4000; i++) {
      const input = i % 4 === 0 ? gen.json(4) : gen.ir(4);
      const plan = i % 2 === 0 ? "row" : "columnar";
      if (compilesOrRejects(() => compileIR(input as IRNode, { plan }), input)) compiled++;
    }
    expect(compiled).toBeGreaterThan(100);
  });

  test("arbitrary JSON as a profile compiles or fails with code ir", () => {
    const gen = generator(mulberry32(0x5eed));
    let compiled = 0;
    for (let i = 0; i < 4000; i++) {
      const profile = gen.profile();
      const attempt = () => compileIR(PROFILE_IR, { plan: "columnar", profile: profile as Profile, pack: false });
      if (compilesOrRejects(attempt, profile)) compiled++;
    }
    expect(compiled).toBeGreaterThan(100);
  });
});
