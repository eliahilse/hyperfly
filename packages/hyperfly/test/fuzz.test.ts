import { describe, expect, test } from "bun:test";
import { compileIR, HyperflyError, train, type Codec, type IRNode } from "../src/index.js";

/**
 * The decoder is the one component that eats bytes from the network, so the property
 * it must hold is narrow and absolute: for ANY input it either throws a typed
 * HyperflyError, or it returns a value. Never a TypeError, a RangeError, an
 * out-of-memory, or a hang.
 *
 * When it does return a value, the guarantee is normalization, not byte identity.
 * Plan §4 makes canonicality an ENCODER obligation and lets decoders accept any
 * valid mode, so a hand-made non-canonical input re-encodes to different bytes by
 * design — the first run of this fuzzer found exactly that and it is correct.
 * What must hold is that re-encoding is stable: the normalized bytes decode to the
 * same value and encode to themselves. The encoder may refuse a decoded value
 * outright, since wire-v0 §6 makes it the stricter side, but only with a typed error.
 *
 * HYPERFLY_FUZZ_SECONDS=<n> runs the mutation loop for n seconds instead of its fixed
 * iteration count, seeded by HYPERFLY_FUZZ_SEED or the clock; a failure prints the seed.
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

const SCHEMAS: IRNode[] = [
  { kind: "int" },
  { kind: "int", min: 0, max: 1000 },
  { kind: "float64" },
  { kind: "string" },
  { kind: "bytes" },
  { kind: "enum", members: ["a", "b", "c"] },
  { kind: "nullable", inner: { kind: "string" } },
  { kind: "array", element: { kind: "int" } },
  { kind: "array", element: { kind: "string" }, length: 3 },
  {
    kind: "struct",
    fields: [
      { name: "a", type: { kind: "int" } },
      { name: "b", type: { kind: "string" }, optional: true },
      { name: "c", type: { kind: "bool" }, nullable: true },
      { name: "d", type: { kind: "float64" }, optional: true, nullable: true },
    ],
  },
  {
    kind: "array",
    element: {
      kind: "struct",
      fields: [
        { name: "t", type: { kind: "int", min: 0 } },
        { name: "v", type: { kind: "float64" } },
        { name: "s", type: { kind: "string" }, optional: true },
        { name: "e", type: { kind: "enum", members: ["x", "y"] }, nullable: true },
        { name: "b", type: { kind: "bool" } },
      ],
    },
  },
  {
    kind: "array",
    element: {
      kind: "struct",
      fields: [
        { name: "n", type: { kind: "struct", fields: [{ name: "deep", type: { kind: "string" } }] } },
        { name: "k", type: { kind: "literal", value: "fixed" } },
      ],
    },
  },
];

const PROFILE = {
  version: 1 as const,
  shared: { columns: [{ leaf: 2, dict: ["alpha", "beta", "gamma"] }] },
};

const SLOW_DECODE_MS = 100;
let slowest = 0;

function timeDecode(codec: Pick<Codec, "decodeBody">, bytes: Uint8Array): number {
  const start = performance.now();
  try {
    codec.decodeBody(bytes);
  } catch {
    // the caller's own decode classifies the outcome
  }
  return performance.now() - start;
}

/**
 * Every decode in this file goes through here, so one pathological input cannot hide in an
 * aggregate. A decode over the bound is timed again before it fails: a pathology reproduces,
 * a collector pause does not.
 */
function timedDecode(codec: Pick<Codec, "decodeBody">, bytes: Uint8Array, context: string): unknown {
  const start = performance.now();
  let outcome: { value: unknown } | { error: unknown };
  try {
    outcome = { value: codec.decodeBody(bytes) };
  } catch (error) {
    outcome = { error };
  }
  let elapsed = performance.now() - start;
  if (elapsed > SLOW_DECODE_MS) elapsed = Math.min(elapsed, timeDecode(codec, bytes), timeDecode(codec, bytes));
  if (elapsed > slowest) slowest = elapsed;
  if (elapsed > SLOW_DECODE_MS) {
    throw new Error(`${context}: one decode took ${elapsed.toFixed(1)} ms ${Buffer.from(bytes).toString("hex")}`);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

function untyped(err: unknown, context: string, side: string): Error {
  return new Error(`${context}: expected HyperflyError from ${side}, got ${(err as Error).name}: ${(err as Error).message}`);
}

/** Input that must not decode: any value back, or any throw but a HyperflyError, fails. */
function expectRejected(run: () => unknown, context: string): void {
  try {
    run();
  } catch (err) {
    if (err instanceof HyperflyError) return;
    throw untyped(err, context, "decode");
  }
  throw new Error(`${context}: expected a HyperflyError, but the input decoded`);
}

/**
 * Input that may decode. If it does, the value must re-encode, or the encoder must refuse
 * it with a HyperflyError, and the normalized bytes must be a fixed point.
 */
function expectTypedOrNormal(codec: Codec, bytes: Uint8Array, context: string): void {
  let value: unknown;
  try {
    value = timedDecode(codec, bytes, context);
  } catch (err) {
    if (err instanceof HyperflyError) return;
    throw err instanceof Error && err.message.startsWith(context) ? err : untyped(err, context, "decode");
  }
  let normalized: Uint8Array;
  try {
    normalized = codec.encodeBody(value);
  } catch (err) {
    if (err instanceof HyperflyError) return;
    throw untyped(err, context, "re-encode");
  }
  const again = timedDecode(codec, normalized, `${context} normalized`);
  expect(again).toEqual(value as never);
  expect(codec.encodeBody(again)).toEqual(normalized);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

const EVENTS: IRNode = {
  kind: "array",
  element: {
    kind: "struct",
    fields: [
      { name: "id", type: { kind: "string" } },
      { name: "user", type: { kind: "string" } },
      { name: "email", type: { kind: "string" }, optional: true },
      { name: "note", type: { kind: "string" } },
      { name: "n", type: { kind: "int", min: 0 } },
    ],
  },
};

const USERS = ["ana", "bo", "cy", "dee", "eli"];
const WORDS = ["checkout", "completed", "for", "order", "shipped", "warehouse", "north", "delayed"];

function eventsMessage(rng: () => number, base: number): Record<string, unknown>[] {
  return Array.from({ length: 6 + Math.floor(rng() * 6) }, (_, i) => {
    const user = USERS[Math.floor(rng() * USERS.length)]!;
    const row: Record<string, unknown> = {
      id: `evt_${(base + i).toString(16).padStart(8, "0")}`,
      user,
      note: Array.from({ length: 8 }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(" "),
      n: base + i,
    };
    if (rng() < 0.8) row.email = `${user}@example.com`;
    return row;
  });
}

const NESTED: IRNode = {
  kind: "array",
  element: {
    kind: "struct",
    fields: [
      { name: "id", type: { kind: "int" } },
      {
        name: "tags",
        type: {
          kind: "array",
          element: {
            kind: "struct",
            fields: [
              { name: "k", type: { kind: "enum", members: ["a", "b", "c"] } },
              { name: "v", type: { kind: "int", min: 0 } },
              { name: "note", type: { kind: "string" }, optional: true },
            ],
          },
        },
      },
    ],
  },
};

const NESTED_VALUE = [
  { id: 1, tags: [{ k: "a", v: 1 }, { k: "b", v: 2, note: "x" }] },
  { id: -4, tags: [] },
  { id: 9, tags: [{ k: "c", v: 300 }, { k: "c", v: 300 }, { k: "a", v: 0, note: "" }] },
];

const X = { kind: "literal", value: "x" } as const;

/** Sibling and nested arrays of literals: every count lands on the item budget, never on the wire. */
const BUDGET: IRNode = {
  kind: "struct",
  fields: [
    { name: "a", type: { kind: "array", element: { kind: "array", element: X } } },
    { name: "b", type: { kind: "array", element: X } },
  ],
};

/**
 * Body bytes `03 c1 c2 c3 nb` hold 5 bytes, so the budget is 32 x 6 = 192 items. Each count
 * stays inside its own amplification bound, so only the budget can refuse the sum.
 */
function budgetBody(inner: [number, number, number], nb: number): Uint8Array {
  return new Uint8Array([3, ...inner, nb]);
}

const COLUMN_BUDGET: IRNode = {
  kind: "struct",
  fields: [
    { name: "rows", type: { kind: "array", element: { kind: "struct", fields: [{ name: "t", type: { kind: "int" } }] } } },
    { name: "tail", type: { kind: "array", element: X } },
  ],
};

/** `n`, a width-zero int column at 7, then the sibling count: charged n + nb, once each. */
function columnBudgetBody(n: number, nb: number): Uint8Array {
  return new Uint8Array([n, 0x02, 0x0e, 0x00, nb]);
}

interface Target {
  name: string;
  codec: Codec;
  bodies: Uint8Array[];
  iterations: number;
}

function targets(): Target[] {
  const rng = mulberry32(0x7a9e7);
  const corpus = Array.from({ length: 40 }, (_, i) => eventsMessage(rng, i * 20));
  const profile = train(EVENTS, corpus);
  const out: Target[] = [];
  const value = [
    { t: 1, v: 1.5, s: "alpha", e: "x", b: true },
    { t: 2, v: 2.5, e: null, b: false },
    { t: 3, v: 0, s: "gamma", e: "y", b: true },
  ];
  for (const plan of ["row", "columnar"] as const) {
    const codec = compileIR(SCHEMAS[10]!, { plan });
    out.push({ name: `${plan} rows`, codec, bodies: [codec.encodeBody(value)], iterations: 3000 });
    const nested = compileIR(NESTED, { plan });
    out.push({ name: `${plan} nested`, codec: nested, bodies: [nested.encodeBody(NESTED_VALUE)], iterations: 1000 });
  }
  const trained = compileIR(EVENTS, { plan: "columnar", profile });
  out.push({
    name: "trained",
    codec: trained,
    bodies: [5000, 9000].map((base) => trained.encodeBody(eventsMessage(rng, base))),
    iterations: 1500,
  });
  out.push({
    name: "budget",
    codec: compileIR(BUDGET),
    bodies: [budgetBody([0, 93, 64], 32), budgetBody([100, 31, 0], 30)],
    iterations: 500,
  });
  out.push({
    name: "column budget",
    codec: compileIR(COLUMN_BUDGET, { plan: "columnar", limits: { maxTotalItems: 150 } }),
    bodies: [columnBudgetBody(118, 32)],
    iterations: 500,
  });
  return out;
}

/** One random edit: overwrite, flip, insert, delete, or truncate. */
function mutate(rng: () => number, src: Uint8Array): Uint8Array {
  const at = () => Math.floor(rng() * Math.max(1, src.length));
  const op = rng();
  if (op < 0.5) {
    const bytes = new Uint8Array(src);
    const edits = 1 + Math.floor(rng() * 3);
    for (let m = 0; m < edits && bytes.length > 0; m++) {
      const p = at();
      bytes[p] = rng() < 0.5 ? Math.floor(rng() * 256) : bytes[p]! ^ (1 << Math.floor(rng() * 8));
    }
    return bytes;
  }
  if (op < 0.7) {
    const p = at();
    const insert = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => (rng() < 0.5 ? 0xff : Math.floor(rng() * 256)));
    return new Uint8Array([...src.subarray(0, p), ...insert, ...src.subarray(p)]);
  }
  if (op < 0.85) {
    const p = at();
    return new Uint8Array([...src.subarray(0, p), ...src.subarray(p + 1 + Math.floor(rng() * 4))]);
  }
  return src.subarray(0, at());
}

describe("decoder fuzzing", () => {
  test("random bytes never escape the error type", () => {
    const rng = mulberry32(0xf0000d);
    for (const plan of ["row", "columnar"] as const) {
      for (const ir of SCHEMAS) {
        const codec = compileIR(ir, { plan });
        for (let i = 0; i < 400; i++) {
          const bytes = new Uint8Array(Math.floor(rng() * 48));
          for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(rng() * 256);
          expectTypedOrNormal(codec, bytes, `${plan} ${ir.kind} ${hex(bytes)}`);
        }
      }
    }
  });

  test("the trained fixture exercises grammar, dictionary, derived and deflate columns", () => {
    const rng = mulberry32(0x7a9e7);
    const profile = train(EVENTS, Array.from({ length: 40 }, (_, i) => eventsMessage(rng, i * 20)));
    const columns = profile?.shared.columns ?? [];
    expect(columns.some((c) => c.grammar)).toBe(true);
    expect(columns.some((c) => c.dict)).toBe(true);
    expect(columns.some((c) => c.derived)).toBe(true);
    const packed = compileIR(EVENTS, { plan: "columnar", profile });
    const plain = compileIR(EVENTS, { plan: "columnar", profile, pack: false });
    const message = eventsMessage(rng, 7000);
    expect(packed.encodeBody(message).length).toBeLessThan(plain.encodeBody(message).length);
  });

  const seconds = Number(process.env.HYPERFLY_FUZZ_SECONDS ?? 0);

  test("mutating valid output never escapes the error type", () => {
    const seed = seconds > 0 ? Number(process.env.HYPERFLY_FUZZ_SEED ?? Date.now() % 2 ** 31) : 0xbadf00d;
    const rng = mulberry32(seed);
    const all = targets();
    let iterations = 0;
    const run = (target: Target): void => {
      const src = target.bodies[Math.floor(rng() * target.bodies.length)]!;
      const bytes = mutate(rng, src);
      expectTypedOrNormal(target.codec, bytes, `seed ${seed}: ${target.name} mutated ${hex(bytes)}`);
      iterations++;
    };
    try {
      if (seconds > 0) {
        const end = Date.now() + seconds * 1000;
        while (Date.now() < end) run(all[Math.floor(rng() * all.length)]!);
        console.log(`fuzz seed ${seed}: ${iterations} mutations, slowest decode ${slowest.toFixed(2)} ms`);
      } else {
        for (const target of all) for (let i = 0; i < target.iterations; i++) run(target);
      }
    } catch (err) {
      console.error(`fuzz seed ${seed} failed after ${iterations} mutations`);
      throw err;
    }
  }, seconds * 1000 + 10_000);

  test("truncation at every strict prefix is rejected", () => {
    const value = { a: -5, b: "hello", c: null, d: 1.25 };
    const bodies: [string, Codec, Uint8Array][] = [];
    for (const plan of ["row", "columnar"] as const) {
      const codec = compileIR(SCHEMAS[9]!, { plan });
      bodies.push([`${plan} struct`, codec, codec.encodeBody(value)]);
    }
    for (const target of targets()) {
      for (const body of target.bodies) bodies.push([target.name, target.codec, body]);
    }
    for (const [name, codec, valid] of bodies) {
      for (let cut = 0; cut < valid.length; cut++) {
        expectRejected(() => timedDecode(codec, valid.subarray(0, cut), name), `${name} truncated to ${cut}`);
      }
      // and trailing garbage must be refused rather than ignored
      expectRejected(() => timedDecode(codec, new Uint8Array([...valid, 0x00]), name), `${name} trailing`);
    }
  });

  test("the item budget holds at its cap, across nested and sibling arrays", () => {
    const codec = compileIR(BUDGET);
    // 3 + (0 + 93 + 64) + 32 = 192: exactly at the cap, one item over refuses
    const atCap = timedDecode(codec, budgetBody([0, 93, 64], 32), "budget at cap") as { a: unknown[][]; b: unknown[] };
    expect(atCap.a.map((inner) => inner.length)).toEqual([0, 93, 64]);
    expect(atCap.b.length).toBe(32);
    expect(() => codec.decodeBody(budgetBody([0, 94, 64], 32))).toThrow("item budget");
    expect(() => codec.decodeBody(budgetBody([1, 93, 64], 32))).toThrow("item budget");
    expect(() => codec.decodeBody(budgetBody([0, 93, 65], 32))).toThrow("amplification");
    expect(timedDecode(codec, budgetBody([100, 31, 0], 30), "budget under")).toBeDefined();

    const columns = compileIR(COLUMN_BUDGET, { plan: "columnar", limits: { maxTotalItems: 150 } });
    expect((timedDecode(columns, columnBudgetBody(118, 32), "column budget") as { rows: unknown[] }).rows.length).toBe(118);
    expect(() => columns.decodeBody(columnBudgetBody(119, 32))).toThrow("item budget");
    expect((timedDecode(columns, columnBudgetBody(119, 31), "column budget") as { tail: unknown[] }).tail.length).toBe(31);
    expect(() => columns.decodeBody(columnBudgetBody(119, 32))).toThrow("item budget");
  });

  test("a profiled decoder survives arbitrary dictionary codes", () => {
    const rng = mulberry32(0x1c7);
    const codec = compileIR(SCHEMAS[10]!, { plan: "columnar", profile: PROFILE, pack: false });
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(Math.floor(rng() * 32));
      for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(rng() * 256);
      expectTypedOrNormal(codec, bytes, `profiled ${hex(bytes)}`);
    }
  });

  test("hostile envelopes are refused, not misread", () => {
    const rng = mulberry32(0xe14e);
    const codec = compileIR(SCHEMAS[9]!);
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(Math.floor(rng() * 40));
      for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(rng() * 256);
      expectRejected(() => codec.decode(bytes), `envelope ${hex(bytes)}`);
    }
  });

  test("a declared count cannot outrun the input", () => {
    const element: IRNode = { kind: "struct", fields: [{ name: "x", type: { kind: "int" } }] };
    const cases: [string, Codec][] = [
      ["row", compileIR({ kind: "array", element })],
      ["columnar", compileIR({ kind: "array", element }, { plan: "columnar" })],
      ["nested row", compileIR(NESTED)],
      ["nested columnar", compileIR(NESTED, { plan: "columnar" })],
      ["literals", compileIR({ kind: "array", element: X })],
    ];
    for (const [name, codec] of cases) {
      // every varint length that fits the limit, with no body behind it
      for (const declared of [0x7f, 0x8001, 0x808001, 0x80808008]) {
        const bytes: number[] = [];
        let v = declared;
        while (v > 0) {
          bytes.push(v & 0xff);
          v >>>= 8;
        }
        expectRejected(() => timedDecode(codec, new Uint8Array(bytes.reverse()), name), `${name} count ${declared}`);
      }
    }
  });
});
