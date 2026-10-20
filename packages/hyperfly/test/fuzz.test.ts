import { describe, expect, test } from "bun:test";
import { compileIR, HyperflyError, type IRNode } from "../src/index.js";

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
 * same value and encode to themselves.
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

const JSON_ATOMS = [null, false, true, 0, -1, 0.5, -0.5, Number.MAX_SAFE_INTEGER, 1e300, -1e300,
  "", "alpha", "__proto__", "constructor", "toString", "\ud800"];
const JSON_KEYS = ["version", "shared", "columns", "leaf", "dict", "grammar", "derived", "source", "values",
  "lit", "num", "base", "len", "case", "hints", "limits", "plan", "pack", "profile", "deflate", "inflate",
  "maxDepth", "maxItems", "maxByteLength", "maxAmplification", "maxDeph", "__proto__", "constructor", "toString"];

function arbitraryJSON(rng: () => number, depth = 4): unknown {
  if (depth === 0 || rng() < 0.55) return JSON_ATOMS[Math.floor(rng() * JSON_ATOMS.length)];
  const length = Math.floor(rng() * 5);
  if (rng() < 0.5) return Array.from({ length }, () => arbitraryJSON(rng, depth - 1));
  return Object.fromEntries(Array.from({ length }, () => [
    JSON_KEYS[Math.floor(rng() * JSON_KEYS.length)]!, arbitraryJSON(rng, depth - 1),
  ]));
}

function mutateJSON(value: object, rng: () => number): unknown {
  const clone = structuredClone(value);
  const objects: object[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    objects.push(node);
    for (const inner of Object.values(node)) walk(inner);
  };
  walk(clone);
  const target = objects[Math.floor(rng() * objects.length)]!;
  const keys = Object.keys(target);
  const key = keys.length > 0 && rng() < 0.8
    ? keys[Math.floor(rng() * keys.length)]!
    : Array.isArray(target) ? String(target.length) : JSON_KEYS[Math.floor(rng() * JSON_KEYS.length)]!;
  if (rng() < 0.2) {
    if (Array.isArray(target)) target.splice(Number(key), 1);
    else Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, { value: arbitraryJSON(rng), enumerable: true, writable: true, configurable: true });
  }
  return clone;
}

/**
 * Decode, re-encode, and require the result to be a fixed point: the normalized bytes
 * must decode to the same value and encode to themselves. That is the invariant that
 * survives non-canonical input, and a decoder that loses or invents information
 * breaks it.
 */
function normalizes(
  codec: { decodeBody(b: Uint8Array): unknown; encodeBody(v: never): Uint8Array },
  bytes: Uint8Array,
): void {
  const value = codec.decodeBody(bytes);
  const normalized = codec.encodeBody(value as never);
  expect(codec.decodeBody(normalized)).toEqual(value as never);
  expect(codec.encodeBody(codec.decodeBody(normalized) as never)).toEqual(normalized);
}

/** Any throw that is not a HyperflyError is a decoder bug, so report it usefully. */
function expectTypedFailure(run: () => unknown, context: string): void {
  try {
    run();
  } catch (err) {
    if (err instanceof HyperflyError) return;
    throw new Error(`${context}: expected HyperflyError, got ${(err as Error).name}: ${(err as Error).message}`);
  }
}

describe("compile fuzzing", () => {
  test("arbitrary JSON profiles compile or throw HyperflyError", () => {
    const rng = mulberry32(0xc0ded);
    const profiles = [
      PROFILE,
      { ...PROFILE, version: { toString: null, constructor: "__proto__" } },
      { ...PROFILE, version: 2, shared: { columns: [{
        leaf: 2, dict: ["alpha", "beta"],
        grammar: [{ lit: "id-" }, { num: { base: 10, len: 3, case: "lower" } }],
      }] } },
      { ...PROFILE, version: 2, shared: { columns: [{ leaf: 2, derived: { source: 0, values: ["alpha"] } }] } },
    ];
    const check = (profile: unknown): void => {
      try {
        compileIR(SCHEMAS[10]!, { plan: "columnar", profile: profile as never });
      } catch (error) {
        expect(error, JSON.stringify(profile)).toBeInstanceOf(HyperflyError);
        expect((error as HyperflyError).code).toBe("ir");
      }
    };
    for (const profile of [...JSON_ATOMS, ...profiles, [], {}]) check(profile);
    for (let i = 0; i < 2000; i++) {
      check(arbitraryJSON(rng));
      check(mutateJSON(profiles[i % profiles.length]!, rng));
    }
  });

  test("arbitrary options compile or throw coded HyperflyError", () => {
    const rng = mulberry32(0x0f7105);
    const options = [
      {},
      { plan: "row", limits: { maxDepth: 64, maxItems: 100, maxByteLength: 1000, maxAmplification: 4096 } },
      { plan: "columnar", profile: PROFILE, pack: false },
      { plan: "columnar", profile: PROFILE, pack: { deflate: undefined, inflate: undefined } },
    ];
    const check = (value: unknown): void => {
      try {
        compileIR(SCHEMAS[10]!, value as never);
      } catch (error) {
        expect(error, JSON.stringify(value)).toBeInstanceOf(HyperflyError);
        expect(["options", "ir"]).toContain((error as HyperflyError).code);
      }
    };
    for (const value of [...JSON_ATOMS, ...options, [], undefined]) check(value);
    for (let i = 0; i < 2000; i++) {
      const value = arbitraryJSON(rng);
      check(value);
      check(mutateJSON(options[i % options.length]!, rng));
      const key = ["limits", "plan", "pack", "profile"][i % 4]!;
      check({ plan: "columnar", [key]: value });
    }
  });
});

describe("decoder fuzzing", () => {
  test("random bytes never escape the error type", () => {
    const rng = mulberry32(0xf0000d);
    for (const plan of ["row", "columnar"] as const) {
      for (const ir of SCHEMAS) {
        const codec = compileIR(ir, { plan });
        for (let i = 0; i < 400; i++) {
          const bytes = new Uint8Array(Math.floor(rng() * 48));
          for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(rng() * 256);
          expectTypedFailure(
            () => normalizes(codec, bytes),
            `${plan} ${ir.kind} ${Buffer.from(bytes).toString("hex")}`,
          );
        }
      }
    }
  });

  test("mutating valid output never escapes the error type", () => {
    const rng = mulberry32(0xbadf00d);
    const value = [
      { t: 1, v: 1.5, s: "alpha", e: "x", b: true },
      { t: 2, v: 2.5, e: null, b: false },
      { t: 3, v: 0, s: "gamma", e: "y", b: true },
    ];
    const ir = SCHEMAS[10]!;

    for (const plan of ["row", "columnar"] as const) {
      const codec = compileIR(ir, { plan });
      const valid = codec.encodeBody(value);
      for (let i = 0; i < 3000; i++) {
        const bytes = new Uint8Array(valid);
        const mutations = 1 + Math.floor(rng() * 3);
        for (let m = 0; m < mutations; m++) {
          bytes[Math.floor(rng() * bytes.length)] = Math.floor(rng() * 256);
        }
        expectTypedFailure(
          () => normalizes(codec, bytes),
          `${plan} mutated ${Buffer.from(bytes).toString("hex")}`,
        );
      }
    }
  });

  test("truncation at every offset is handled", () => {
    const value = { a: -5, b: "hello", c: null, d: 1.25 };
    for (const plan of ["row", "columnar"] as const) {
      const codec = compileIR(SCHEMAS[9]!, { plan });
      const valid = codec.encodeBody(value);
      for (let cut = 0; cut < valid.length; cut++) {
        expectTypedFailure(() => normalizes(codec, valid.subarray(0, cut)), `${plan} truncated to ${cut}`);
      }
      // and trailing garbage must be refused rather than ignored
      expectTypedFailure(
        () => codec.decodeBody(new Uint8Array([...valid, 0x00])),
        `${plan} trailing`,
      );
    }
  });

  test("a profiled decoder survives arbitrary dictionary codes", () => {
    const rng = mulberry32(0x1c7);
    const codec = compileIR(SCHEMAS[10]!, { plan: "columnar", profile: PROFILE, pack: false });
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(Math.floor(rng() * 32));
      for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(rng() * 256);
      expectTypedFailure(() => codec.decodeBody(bytes), `profiled ${Buffer.from(bytes).toString("hex")}`);
    }
  });

  test("hostile envelopes are refused, not misread", () => {
    const rng = mulberry32(0xe14e);
    const codec = compileIR(SCHEMAS[9]!);
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(Math.floor(rng() * 40));
      for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(rng() * 256);
      expectTypedFailure(() => codec.decode(bytes), `envelope ${Buffer.from(bytes).toString("hex")}`);
    }
  });

  test("a declared count cannot outrun the input", () => {
    const codec = compileIR({ kind: "array", element: { kind: "struct", fields: [{ name: "x", type: { kind: "int" } }] } });
    // every varint length that fits the limit, with no body behind it
    for (const declared of [0x7f, 0x8001, 0x808001, 0x80808008]) {
      const bytes: number[] = [];
      let v = declared;
      while (v > 0) {
        bytes.push(v & 0xff);
        v >>>= 8;
      }
      expectTypedFailure(() => codec.decodeBody(new Uint8Array(bytes.reverse())), `count ${declared}`);
    }
  });
});
