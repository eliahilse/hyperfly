import { describe, expect, test } from "bun:test";
import {
  compileIR,
  DEFAULT_LIMITS,
  FingerprintMismatchError,
  serializeArtifact,
  type IRNode,
} from "../src/index.js";
import { MAX_ARTIFACT_NESTING } from "../src/nesting.js";
import { HEADER_SIZE } from "../src/codec.js";
import { DecodeError, HyperflyError } from "../src/errors.js";

const STRUCT: IRNode = {
  kind: "struct",
  fields: [
    { name: "a", type: { kind: "int" } },
    { name: "b", type: { kind: "string" }, optional: true },
  ],
};

describe("envelope", () => {
  test("header layout", () => {
    const codec = compileIR(STRUCT);
    const bytes = codec.encode({ a: 1 });
    expect(bytes[0]).toBe(0x68);
    expect(bytes[1]).toBe(0x66);
    expect(bytes[2]).toBe(0x01);
    expect(bytes.length).toBeGreaterThanOrEqual(HEADER_SIZE);
  });

  test("fingerprint mismatch is a typed error for JSON fallback", () => {
    const codec = compileIR(STRUCT);
    const other = compileIR({ kind: "struct", fields: [{ name: "a", type: { kind: "int" } }] });
    const bytes = other.encode({ a: 1 });
    try {
      codec.decode(bytes);
      throw new Error("expected mismatch");
    } catch (err) {
      expect(err).toBeInstanceOf(FingerprintMismatchError);
      expect((err as FingerprintMismatchError).actual).toBe(other.fingerprint);
    }
  });

  test("bad magic and short input", () => {
    const codec = compileIR(STRUCT);
    expect(() => codec.decode(new Uint8Array([1, 2, 3]))).toThrow(DecodeError);
    const bytes = codec.encode({ a: 1 });
    bytes[0] = 0x00;
    expect(() => codec.decode(bytes)).toThrow("bad magic");
  });
});

describe("canonical artifact", () => {
  test("exact text for a representative schema", () => {
    expect(serializeArtifact(STRUCT)).toBe(
      '{"wire":1,"plan":{"layout":"row","version":1},"ir":{"kind":"struct","fields":[' +
        '{"name":"a","type":{"kind":"int"}},' +
        '{"name":"b","type":{"kind":"string"},"optional":true}]}}',
    );
  });

  test("fingerprint is stable and order-sensitive", () => {
    const a = compileIR(STRUCT).fingerprint;
    expect(a).toBe(compileIR(STRUCT).fingerprint);
    expect(a).toHaveLength(32);
    const reordered: IRNode = {
      kind: "struct",
      fields: [
        { name: "b", type: { kind: "string" }, optional: true },
        { name: "a", type: { kind: "int" } },
      ],
    };
    expect(compileIR(reordered).fingerprint).not.toBe(a);
  });

  test("string escaping in canonical form", () => {
    const ir: IRNode = { kind: "literal", value: 'a"b\\c\nd' };
    expect(serializeArtifact(ir)).toContain('"value":"a\\"b\\\\c\\u000ad"');
  });
});

describe("limits", () => {
  test("defaults are frozen and custom limits stay local to a codec", () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    const ir: IRNode = { kind: "array", element: { kind: "bool" } };
    const limited = compileIR(ir, { limits: { maxItems: 1 } });
    const bytes = new Uint8Array([2, 1, 0]);
    expect(() => limited.decodeBody(bytes)).toThrow("limit");
    expect(compileIR(ir).decodeBody(bytes)).toEqual([true, false]);
    expect(DEFAULT_LIMITS.maxItems).toBe(2 ** 24);
  });

  test("depth limit", () => {
    let ir: IRNode = { kind: "int" };
    for (let i = 0; i < 70; i++) ir = { kind: "array", element: ir };
    const codec = compileIR(ir);
    let value: unknown = 1;
    for (let i = 0; i < 70; i++) value = [value];
    expect(() => codec.encodeBody(value)).toThrow(HyperflyError);
  });

  test("custom item limit", () => {
    const codec = compileIR({ kind: "array", element: { kind: "bool" } }, { limits: { maxItems: 2 } });
    expect(() => codec.decodeBody(new Uint8Array([3, 1, 1, 1]))).toThrow("limit");
  });
});

describe("compile options", () => {
  test.each([null, false, true, 0, "row", [], () => {}, new Date(), new (class Options {})(), Object.create({})].map((value) => [value] as const))("rejects non-object options %p", (options) => {
    expect(() => compileIR(STRUCT, options as never)).toThrow(HyperflyError);
    expect(() => compileIR(STRUCT, options as never)).toThrow(expect.objectContaining({
      code: "options", message: "options: must be an object",
    }));
  });

  test.each([
    [{ limits: null }, "limits"],
    [{ limits: [] }, "limits"],
    ...[new Date(), new (class Limits {})(), Object.create({ maxItems: 1 })].map((limits) => [{ limits }, "limits"]),
    [{ limits: false }, "limits"],
    [{ limits: 1 }, "limits"],
    [{ limits: "default" }, "limits"],
    [{ limits: { maxDeph: 1 } }, "limits.maxDeph: unknown limit"],
    [{ limits: { maxDeph: undefined } }, "limits.maxDeph: unknown limit"],
    [{ limits: JSON.parse('{"__proto__":0}') }, "limits.__proto__: unknown limit"],
    [{ limits: { constructor: 0 } }, "limits.constructor: unknown limit"],
    [{ limits: { [Symbol("maxDepth")]: 0 } }, "limits.Symbol(maxDepth): unknown limit"],
    ...[null, false, 1, "rows", {}, []].map((plan) => [{ plan }, "plan"]),
    ...[null, true, 1, "default", () => {}, [], new Date(), new (class Pack {})(), Object.create({})].map((pack) => [{ pack }, "pack"]),
    ...["deflate", "inflate"].flatMap((key) =>
      [null, false, 1, "function", {}].map((value) => [{ pack: { [key]: value } }, `pack.${key}`]),
    ),
  ] as [unknown, string][])("rejects invalid options %p", (options, path) => {
    expect(() => compileIR(STRUCT, options as never)).toThrow(HyperflyError);
    expect(() => compileIR(STRUCT, options as never)).toThrow(expect.objectContaining({
      code: "options", message: expect.stringContaining(path),
    }));
  });

  for (const key of Object.keys(DEFAULT_LIMITS)) {
    test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, true, "1", {}, []].map((value) => [value] as const))(
      `rejects invalid limits.${key} %p`, (value) => {
        const run = () => compileIR(STRUCT, { limits: { [key]: value } } as never);
        expect(run).toThrow(HyperflyError);
        expect(run).toThrow(expect.objectContaining({
          code: "options", message: `limits.${key}: must be a non-negative safe integer`,
        }));
      },
    );
  }

  test("checks options before the IR", () => {
    expect(() => compileIR(null as never, { plan: "bad" } as never)).toThrow(HyperflyError);
    expect(() => compileIR(null as never, { plan: "bad" } as never)).toThrow(expect.objectContaining({ code: "options" }));
  });

  test("reads each option once and uses its validated value", () => {
    const reads = { limits: 0, plan: 0, pack: 0, profile: 0 };
    const codec = compileIR(STRUCT, {
      get limits() { reads.limits++; return undefined; },
      get plan(): "row" { return ++reads.plan <= 2 ? "row" : "bogus" as never; },
      get pack(): false { return ++reads.pack === 1 ? false : 42 as never; },
      get profile() { reads.profile++; return undefined; },
    });
    expect(reads).toEqual({ limits: 1, plan: 1, pack: 1, profile: 1 });
    expect(codec.plan).toBe("row");
    expect(codec.decode(codec.encode({ a: 1 }))).toEqual({ a: 1 });
  });

  test("snapshots alternating limits objects and each limit getter once", () => {
    let reads = 0;
    let limitReads = 0;
    let keyReads = 0;
    const limits = new Proxy({
      get maxItems() { return ++limitReads === 1 ? 1 : 100; },
    }, {
      ownKeys(target) { keyReads++; return Reflect.ownKeys(target); },
    });
    const codec = compileIR({ kind: "array", element: { kind: "bool" } }, {
      get limits() { return ++reads % 2 === 1 ? limits : {}; },
    });
    expect(reads).toBe(1);
    expect(limitReads).toBe(1);
    expect(keyReads).toBe(1);
    expect(() => codec.decodeBody(new Uint8Array([2, 1, 0]))).toThrow(DecodeError);
    expect(() => codec.decodeBody(new Uint8Array([2, 1, 0]))).toThrow(expect.objectContaining({ code: "limit" }));
    expect(() => codec.encodeBody([true, false])).toThrow(expect.objectContaining({ code: "limit" }));
  });

  test.each(["limits", "plan", "pack", "profile"] as const)("wraps a throwing %s getter", (key) => {
    for (const cause of [new TypeError("cannot read option"), new HyperflyError("options", "getter failed")]) {
      const options = Object.defineProperty({}, key, { get() { throw cause; } });
      const run = () => compileIR(null as never, options);
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "options", cause }));
    }
  });

  test("wraps throwing limit and pack hook getters", () => {
    const cause = new Error("cannot read nested option");
    for (const options of [
      { limits: { get maxItems(): never { throw cause; } } },
      { pack: { get deflate(): never { throw cause; } } },
    ]) {
      const run = () => compileIR(STRUCT, options);
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "options", cause }));
    }
  });

  test("applies and checks non-enumerable limits", () => {
    const ir: IRNode = { kind: "array", element: { kind: "bool" } };
    const limits = Object.defineProperty({}, "maxItems", { value: 1 });
    expect(() => compileIR(ir, { limits }).encodeBody([true, false])).toThrow(expect.objectContaining({ code: "limit" }));
    const run = () => compileIR(ir, { limits: Object.defineProperty({}, "maxItems", { value: -1 }) });
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "options" }));
  });

  test("snapshots pack hook getters", () => {
    let reads = 0;
    const codec = compileIR(STRUCT, { pack: {
      get inflate() { return ++reads === 1 ? undefined : 42 as never; },
    } });
    expect(reads).toBe(1);
    expect(codec.decode(codec.encode({ a: 1 }))).toEqual({ a: 1 });
  });

  test("accepts null-prototype options, limits, and pack", () => {
    const options = Object.assign(Object.create(null), {
      limits: Object.assign(Object.create(null), { maxItems: 1 }),
      pack: Object.create(null),
    });
    const codec = compileIR(STRUCT, options);
    expect(codec.decode(codec.encode({ a: 1 }))).toEqual({ a: 1 });
  });

  test("accepts safe integer limits including zero", () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, value]));
      expect(() => compileIR(STRUCT, { limits })).not.toThrow();
    }
  });

  test("undefined limits preserve defaults, inherited limits are ignored and hidden ones checked", () => {
    const limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, undefined]));
    const codec = compileIR(STRUCT, { limits });
    const value = { a: 1, b: "hello" };
    expect(codec.decode(codec.encode(value))).toEqual(value);
    const inherited = Object.create(Object.prototype) as object;
    expect(compileIR(STRUCT, { limits: inherited }).encode(value)).toEqual(codec.encode(value));
    const hidden = Object.defineProperty({}, "unknown", { value: -1 });
    expect(() => compileIR(STRUCT, { limits: hidden })).toThrow(expect.objectContaining({ code: "options" }));
    let ir: IRNode = { kind: "bool" };
    let nested: unknown = true;
    for (let i = 0; i <= DEFAULT_LIMITS.maxDepth; i++) {
      ir = { kind: "array", element: ir };
      nested = [nested];
    }
    expect(() => compileIR(ir, { limits }).encodeBody(nested)).toThrow(expect.objectContaining({ code: "depth" }));
  });

  test("accepts optional pack hooks and undefined options", () => {
    for (const pack of [undefined, false, {}, { deflate: undefined, inflate: undefined }, {
      deflate: (bytes: Uint8Array) => bytes,
      inflate: (bytes: Uint8Array) => bytes,
    }] as const) {
      expect(() => compileIR(STRUCT, { plan: undefined, limits: undefined, pack })).not.toThrow();
    }
    expect(() => compileIR(STRUCT, undefined)).not.toThrow();
  });

  test.each([null, false, 0, "", { version: { toString: null }, shared: { columns: [] } }].map((profile) => [profile] as const))(
    "rejects malformed profiles with an ir error: %p", (profile) => {
      const ir: IRNode = {
        kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
      };
      const run = () => compileIR(ir, { plan: "columnar", profile: profile as never });
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "ir" }));
    },
  );
});

describe("profile JSON data", () => {
  const ir: IRNode = {
    kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
  };
  const shared = { columns: [{ leaf: 0, dict: ["hello"] }] };
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  let deep: unknown = {};
  for (let i = 0; i < 10000; i++) deep = { nested: deep };

  test.each([
    cyclic, cyclicArray, () => {}, Symbol("hint"), new Date(), new Map(), new Set(),
    new Uint8Array([1]), new (class Hint {})(), undefined, 1n, NaN, Infinity, -Infinity, deep,
  ].map((value) => [value] as const))("rejects non-JSON hints %p with an ir error", (value) => {
    const run = () => compileIR(ir, { plan: "columnar", profile: { version: 1, shared, hints: { value } } });
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "ir" }));
  });

  test("checks every part of a profile for JSON data", () => {
    const cycle = { version: 1, shared: {} };
    cycle.shared = cycle;
    for (const profile of [
      cycle,
      { version: 1, shared: { columns: [{ leaf: 0, dict: [() => {}] }] } },
      { version: 1, shared: new (class Shared { columns = shared.columns; })() },
      { version: 1, shared, hints: { [Symbol("hint")]: true } },
      { version: 1, shared, hints: { value: Object.assign([], { extra: () => {} }) } },
      { version: 1, shared, hints: { value: Object.assign([], { [Symbol("hint")]: true }) } },
      { version: 1, shared, hints: { value: Object.assign([], { 4294967295: () => {} }) } },
    ]) {
      const run = () => compileIR(ir, { plan: "columnar", profile: profile as never });
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "ir" }));
    }
  });

  test("wraps throwing profile getters with an ir error", () => {
    const cause = new TypeError("cannot read hint");
    const hints = { get value() { throw cause; } };
    const run = () => compileIR(ir, { plan: "columnar", profile: { version: 1, shared, hints } });
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "ir", cause }));
  });

  test("accepts JSON hints at the nesting bound and freezes a snapshot", () => {
    let value: unknown = { data: ["hello", 1.5, true, false, null, Object.create(null)] };
    for (let i = 0; i < MAX_ARTIFACT_NESTING - 5; i++) value = { nested: value };
    const hints = { value };
    const codec = compileIR(ir, { plan: "columnar", profile: { version: 1, shared, hints } });
    expect(codec.decode(codec.encode([{ s: "hello" }]))).toEqual([{ s: "hello" }]);
    expect(Object.isFrozen(codec.profile?.hints)).toBe(true);
    expect(codec.profile?.hints).not.toBe(hints);
    expect(Object.isFrozen(hints)).toBe(false);
    expect(Object.getPrototypeOf(codec.profile?.hints)).toBe(Object.prototype);
  });
});

describe("retro hardening", () => {
  test("array-index and __proto__ field names are rejected", () => {
    expect(() => compileIR({ kind: "struct", fields: [{ name: "0", type: { kind: "int" } }] })).toThrow();
    expect(() => compileIR({ kind: "struct", fields: [{ name: "__proto__", type: { kind: "int" } }] })).toThrow();
  });

  test("nullable(literal null) is rejected as ambiguous", () => {
    expect(() => compileIR({ kind: "nullable", inner: { kind: "literal", value: null } })).toThrow();
  });

  test("lone surrogate in an IR string is rejected", () => {
    expect(() => compileIR({ kind: "enum", members: ["ok", "\ud800"] })).toThrow();
  });

  test("leading U+FEFF survives a string round trip", () => {
    const codec = compileIR({ kind: "string" });
    const value = "﻿hi";
    expect(codec.decodeBody(codec.encodeBody(value))).toBe(value);
  });

  test("fixed arrays honour maxItems", () => {
    const codec = compileIR({ kind: "array", element: { kind: "bool" }, length: 2 }, { limits: { maxItems: 1 } });
    expect(() => codec.decodeBody(new Uint8Array([1, 0]))).toThrow("limit");
  });

  test("mutating the caller's IR after compile does not change output", () => {
    const ir: IRNode = { kind: "int", min: 0 };
    const codec = compileIR(ir);
    (ir as { min: number }).min = 10;
    expect(codec.encodeBody(0)).toEqual(new Uint8Array([0]));
  });
});

describe("allocation and limit safety", () => {
  test("a declared count must be payable by the remaining input", () => {
    const ir: IRNode = { kind: "array", element: { kind: "struct", fields: [{ name: "x", type: { kind: "int" } }] } };
    const bomb = new Uint8Array([0x80, 0x80, 0x80, 0x08]);
    for (const plan of ["row", "columnar"] as const) {
      expect(() => compileIR(ir, { plan }).decodeBody(bomb)).toThrow("remain");
    }
  });

  test("encoders refuse output their own decoder would reject", () => {
    const codec = compileIR({ kind: "string" }, { limits: { maxByteLength: 1 } });
    expect(() => codec.encodeBody("ab")).toThrow("limit");
  });

  test("a codec that cannot inflate does not emit packed columns", () => {
    const ir: IRNode = { kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] } };
    const rows = Array.from({ length: 20 }, () => ({ s: "a".repeat(24) }));
    const codec = compileIR(ir, { plan: "columnar", pack: { deflate: (d) => d } });
    expect(codec.decodeBody(codec.encodeBody(rows))).toEqual(rows);
  });
});
