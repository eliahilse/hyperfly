import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
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

function hostileValues(): [string, unknown][] {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const trapping = new Proxy({}, { getPrototypeOf() { throw new Error("no prototype"); } });
  return [["a revoked proxy", revocable.proxy], ["a proxy whose getPrototypeOf throws", trapping]];
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

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

describe("serializeArtifact input checks", () => {
  const STRINGS: IRNode = {
    kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
  };
  const shared = { columns: [{ leaf: 0, dict: ["hello"] }] };

  test.each([
    { kind: "int", min: NaN },
    { kind: "int", max: Infinity },
    { kind: "nope" },
    { kind: "struct", fields: [{ name: "a" }] },
  ].map((ir) => [ir] as const))("rejects %p with the code compileIR uses", (ir) => {
    const run = () => serializeArtifact(ir as never);
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "ir" }));
    expect(() => compileIR(ir as never)).toThrow(expect.objectContaining({ code: "ir" }));
  });

  test("rejects an unknown layout as options", () => {
    expect(() => serializeArtifact(STRUCT, "table" as never)).toThrow(expect.objectContaining({ code: "options" }));
  });

  test("rejects a profile on the row plan and malformed profiles as ir", () => {
    expect(() => serializeArtifact(STRINGS, "row", { shared })).toThrow(expect.objectContaining({ code: "ir" }));
    for (const profile of [false, 0, "", { shared: { columns: [{ leaf: 9, dict: ["x"] }] } }]) {
      expect(() => serializeArtifact(STRINGS, "columnar", profile as never)).toThrow(expect.objectContaining({ code: "ir" }));
    }
  });

  test("reports a throwing profile getter as ir with the cause, as compileIR does", () => {
    const cause = new Error("cannot read hints");
    const profile = { version: 1 as const, shared, get hints(): never { throw cause; } };
    for (const run of [
      () => serializeArtifact(STRINGS, "columnar", profile),
      () => compileIR(STRINGS, { plan: "columnar", profile }),
    ]) {
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "ir", cause }));
    }
  });

  test("matches the compiled artifact, with and without a profile", () => {
    expect(serializeArtifact(STRUCT)).toBe(compileIR(STRUCT).artifact);
    const profiled = compileIR(STRINGS, { plan: "columnar", profile: { version: 1, shared } });
    expect(serializeArtifact(STRINGS, "columnar", { shared })).toBe(profiled.artifact);
    expect(serializeArtifact(STRINGS, "columnar", profiled.profile)).toBe(profiled.artifact);
    expect(serializeArtifact(STRINGS, "columnar", null as never)).toBe(compileIR(STRINGS, { plan: "columnar" }).artifact);
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

  test.each(hostileValues())("wraps %s thrown while checking the options object", (_, cause) => {
    for (const options of [
      new Proxy({}, { getPrototypeOf() { throw cause; } }),
      { limits: new Proxy({}, { ownKeys() { throw cause; } }) },
    ]) {
      const error = thrown(() => compileIR(STRUCT, options));
      expect(error).toBeInstanceOf(HyperflyError);
      expect((error as HyperflyError).code).toBe("options");
      expect((error as HyperflyError).cause).toBe(cause);
    }
  });

  test.each(hostileValues())("rethrows %s thrown while reading the IR unchanged", (_, cause) => {
    const ir = Object.defineProperty({}, "kind", { get() { throw cause; } });
    expect(thrown(() => compileIR(ir as never))).toBe(cause);
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

  test("a null profile means none", () => {
    const ir: IRNode = {
      kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
    };
    const codec = compileIR(ir, { plan: "columnar", profile: null as never });
    expect(codec.profile).toBeUndefined();
    expect(codec.fingerprint).toBe(compileIR(ir, { plan: "columnar" }).fingerprint);
  });

  test.each([false, 0, "", { version: { toString: null }, shared: { columns: [] } }].map((profile) => [profile] as const))(
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
  let deep: unknown = { value: undefined };
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

  test.each(hostileValues())("wraps %s thrown by a profile getter with an ir error", (_, cause) => {
    const hints = { get value() { throw cause; } };
    const error = thrown(() => compileIR(ir, { plan: "columnar", profile: { version: 1, shared, hints } }));
    expect(error).toBeInstanceOf(HyperflyError);
    expect((error as HyperflyError).code).toBe("ir");
    expect((error as HyperflyError).cause).toBe(cause);
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

  test("a row array of columnar elements that pack to nothing still meets the one-bit floor", () => {
    // a single-member enum column packs to width zero, yet the element is not zero-bit
    const inner: IRNode = {
      kind: "array",
      element: { kind: "struct", fields: [{ name: "e", type: { kind: "enum", members: ["a"] } }] },
      length: 2,
    };
    const codec = compileIR({ kind: "array", element: inner }, { plan: "columnar" });
    const value = Array.from({ length: 10 }, () => [{ e: "a" }, { e: "a" }]);
    expect(() => codec.decodeBody(new Uint8Array([10]))).toThrow("remain");
    expect(() => codec.encodeBody(value)).toThrow("one-bit floor");
  });

  test("a malformed later column fails before a width-zero column expands", () => {
    const ir: IRNode = {
      kind: "array",
      element: { kind: "struct", fields: [{ name: "a", type: { kind: "int" } }, { name: "b", type: { kind: "int" } }] },
    };
    const codec = compileIR(ir, { plan: "columnar", limits: { maxAmplification: 4096 } });
    // 8 million rows: a is a constant frame, b claims raw values it does not carry
    const rows = 4096 * 1990;
    const body = new Uint8Array(2000);
    body.set([0x80 | (rows & 0x7f), 0x80 | ((rows >> 7) & 0x7f), 0x80 | ((rows >> 14) & 0x7f), rows >> 21, 0x02, 0x00, 0x00, 0x00]);
    const start = performance.now();
    expect(() => codec.decodeBody(body)).toThrow("unexpected end of input");
    expect(performance.now() - start).toBeLessThan(100);
  });

  test("a codec that cannot inflate does not emit packed columns", () => {
    const ir: IRNode = { kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] } };
    const rows = Array.from({ length: 20 }, () => ({ s: "a".repeat(24) }));
    const codec = compileIR(ir, { plan: "columnar", pack: { deflate: (d) => d } });
    expect(codec.decodeBody(codec.encodeBody(rows))).toEqual(rows);
  });
});

describe("IR acceptance", () => {
  test("zero is the integer 0 whatever its sign", () => {
    const negative = compileIR({ kind: "literal", value: -0 });
    const zero = compileIR({ kind: "literal", value: 0 });
    expect(negative.fingerprint).toBe(zero.fingerprint);
    expect(Object.is((negative.ir as { value: number }).value, 0)).toBe(true);
    expect(Object.is(negative.decodeBody(new Uint8Array()), 0)).toBe(true);
    expect(zero.encodeBody(-0)).toEqual(new Uint8Array());
    const bounded = compileIR({ kind: "int", min: -0 });
    expect(Object.is((bounded.ir as { min: number }).min, 0)).toBe(true);
  });

  test("float64 -0 is canonicalized to +0 as before", () => {
    const codec = compileIR({ kind: "float64" });
    const body = codec.encodeBody(-0);
    expect(body).toEqual(new Uint8Array(8));
    expect(Object.is(codec.decodeBody(body), 0)).toBe(true);
  });

  test("unknown keys are rejected", () => {
    expect(() => compileIR({ kind: "bool", extra: 1 } as never)).toThrow("unknown key extra");
    expect(() => compileIR({ kind: "struct", fields: [{ name: "x", type: { kind: "bool" }, extra: 1 }] } as never)).toThrow(
      "unknown key extra",
    );
  });

  test("any JSON value is rejected with code ir, never a host exception", () => {
    let deep: unknown = { kind: "bool" };
    for (let i = 0; i < 200_000; i++) deep = { kind: "array", element: deep };
    const inputs: unknown[] = [
      null,
      [],
      1,
      "bool",
      { kind: null },
      { kind: "struct", fields: [null] },
      { kind: "struct", fields: [{ name: "x", type: null }] },
      { kind: "nullable", inner: [] },
      { kind: "enum", members: [{}] },
      deep,
    ];
    const ir: IRNode = { kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] } };
    const profiles: unknown[] = [0, "x", [], { version: 2, shared: null }, { version: 2, shared: { columns: [null] } }];
    const attempts = [
      ...inputs.map((input) => () => compileIR(input as IRNode)),
      ...profiles.map((profile) => () => compileIR(ir, { plan: "columnar", profile: profile as never })),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (e) {
        expect(e).toBeInstanceOf(HyperflyError);
        expect((e as HyperflyError).code).toBe("ir");
        continue;
      }
      throw new Error("compiled invalid input");
    }
  });
});

describe("struct values", () => {
  const ROW: IRNode = { kind: "struct", fields: [{ name: "a", type: { kind: "int" }, optional: true }] };
  const NESTED: IRNode = {
    kind: "array",
    element: { kind: "struct", fields: [{ name: "s", type: ROW }] },
  };
  const rejected: [string, () => unknown][] = [
    ["Uint8Array", () => new Uint8Array(1)],
    ["ArrayBuffer", () => new ArrayBuffer(1)],
    ["Map", () => new Map([["a", 1]])],
    ["Set", () => new Set([1])],
    ["Date", () => new Date(0)],
    ["boxed String", () => new String("a")],
    ["boxed Number", () => new Number(1)],
    ["boxed Boolean", () => new Boolean(true)],
    ["DataView", () => new DataView(new ArrayBuffer(1))],
    ["null-prototype Date", () => Object.setPrototypeOf(new Date(0), null) as unknown],
    ["plain object with an own Map tag", () => ({ a: 1, [Symbol.toStringTag]: "Map" })],
    ["array with Object.prototype", () => Object.setPrototypeOf([], Object.prototype) as unknown],
    ["Date with Object.prototype", () => Object.setPrototypeOf(new Date(0), Object.prototype) as unknown],
    ["Error with Object.prototype", () => Object.setPrototypeOf(new Error("e"), Object.prototype) as unknown],
  ];

  function typeErrorAt(run: () => unknown, path: string): void {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(HyperflyError);
      expect((error as HyperflyError).code).toBe("type");
      expect((error as HyperflyError).message).toBe(`${path}: expected object`);
      return;
    }
    throw new Error("expected encode to fail");
  }

  test.each(rejected)("rejects a %s with type at its path", (_, make) => {
    typeErrorAt(() => compileIR(ROW).encode(make() as never), "$");
    typeErrorAt(() => compileIR(NESTED).encodeBody([{ s: make() }]), "$[0].s");
    typeErrorAt(() => compileIR(NESTED, { plan: "columnar" }).encodeBody([make()]), "$[0]");
    typeErrorAt(() => compileIR(NESTED, { plan: "columnar" }).encodeBody([{ s: make() }]), "$[0].s");
  });

  class Point {
    a = 1;
  }
  const accepted: [string, () => unknown][] = [
    ["plain object", () => ({ a: 1 })],
    ["null-prototype object", () => Object.assign(Object.create(null) as object, { a: 1 })],
    ["class instance", () => new Point()],
    ["object from another realm", () => runInNewContext("({ a: 1 })")],
  ];

  test.each(accepted)("encodes a %s", (_, make) => {
    const row = compileIR(ROW);
    expect(row.decode(row.encode(make() as never))).toEqual({ a: 1 });
    for (const plan of ["row", "columnar"] as const) {
      const codec = compileIR(NESTED, { plan });
      expect(codec.decodeBody(codec.encodeBody([{ s: make() }, { s: make() }]))).toEqual([{ s: { a: 1 } }, { s: { a: 1 } }]);
    }
  });

  test("an own Symbol.toStringTag decides, per the tag rule", () => {
    const tagged = Object.defineProperty(Object.assign(new Map(), { a: 1 }), Symbol.toStringTag, { value: "Object" });
    const row = compileIR(ROW);
    expect(row.decode(row.encode(tagged as never))).toEqual({ a: 1 });
    typeErrorAt(() => row.encode({ a: 1, [Symbol.toStringTag]: "Map" } as never), "$");
  });

  test("nested columnar containers report required, type and depth at their path", () => {
    const DEEP: IRNode = {
      kind: "array",
      element: {
        kind: "struct",
        fields: [{ name: "s", type: { kind: "struct", fields: [{ name: "t", type: ROW }] } }],
      },
    };
    const codec = compileIR(DEEP, { plan: "columnar" });
    const codeAt = (value: unknown): [string, string] => {
      try {
        codec.encodeBody(value as never);
      } catch (error) {
        return [(error as HyperflyError).code, (error as HyperflyError).message];
      }
      throw new Error("expected encode to fail");
    };
    expect(codeAt([{ s: undefined }])).toEqual(["required", "$[0].s: expected object"]);
    expect(codeAt([{}])).toEqual(["required", "$[0].s: expected object"]);
    expect(codeAt([{ s: null }])).toEqual(["type", "$[0].s: expected object"]);
    expect(codeAt([{ s: { t: new Map() } }])).toEqual(["type", "$[0].s.t: expected object"]);
  });

  test("a field named with a dot does not share a container with the nested path it spells", () => {
    const DOTTED: IRNode = {
      kind: "array",
      element: {
        kind: "struct",
        fields: [
          { name: "a.b", type: { kind: "struct", fields: [{ name: "x", type: { kind: "int" } }, { name: "y", type: { kind: "int" }, optional: true }] } },
          { name: "a", type: { kind: "struct", fields: [{ name: "b", type: { kind: "struct", fields: [{ name: "y", type: { kind: "int" } }] } }] } },
        ],
      },
    };
    const codec = compileIR(DOTTED, { plan: "columnar" });
    expect(codec.decodeBody(codec.encodeBody([{ "a.b": { x: 1 }, a: { b: { y: 2 } } }]))).toEqual([
      { "a.b": { x: 1 }, a: { b: { y: 2 } } },
    ]);
    expect(codec.decodeBody(codec.encodeBody([{ "a.b": { x: 1, y: 99 }, a: { b: { y: 2 } } }]))).toEqual([{ "a.b": { x: 1, y: 99 }, a: { b: { y: 2 } } }]);
    expect(() => codec.encodeBody([{ "a.b": { x: 1, y: 99 }, a: { b: null } }])).toThrow(
      expect.objectContaining({ code: "type", message: "$[0].a.b: expected object" }),
    );
  });

  test("dotted field names at two depths keep their own containers", () => {
    const leaf: IRNode = { kind: "struct", fields: [{ name: "v", type: { kind: "int" } }] };
    const DOTTED: IRNode = {
      kind: "array",
      element: {
        kind: "struct",
        fields: [
          { name: "a.b", type: { kind: "struct", fields: [{ name: "c", type: leaf }] } },
          { name: "a", type: { kind: "struct", fields: [{ name: "b.c", type: leaf }] } },
        ],
      },
    };
    const codec = compileIR(DOTTED, { plan: "columnar" });
    const value = [{ "a.b": { c: { v: 1 } }, a: { "b.c": { v: 2 } } }];
    expect(codec.decodeBody(codec.encodeBody(value))).toEqual(value);
  });

  test("the first failure is reported in leaf order, then row order", () => {
    const TWO: IRNode = {
      kind: "array",
      element: {
        kind: "struct",
        fields: [
          { name: "a", type: { kind: "int" } },
          { name: "s", type: { kind: "struct", fields: [
            { name: "x", type: { kind: "int" } },
            { name: "t", type: ROW },
          ] } },
        ],
      },
    };
    const codec = compileIR(TWO, { plan: "columnar" });
    const first = (value: unknown): string => {
      try {
        codec.encodeBody(value as never);
      } catch (error) {
        return `${(error as HyperflyError).code} ${(error as HyperflyError).message}`;
      }
      throw new Error("expected encode to fail");
    };
    expect(first([{ a: 1, s: new Map() }, { s: { x: 1, t: {} } }])).toBe("required $[1].a: required field missing");
    expect(first([{ a: 1, s: { x: 1, t: new Map() } }, { a: 1, s: new Set() }])).toBe("type $[1].s: expected object");
    expect(first([{ a: 1, s: { t: {} } }, { a: 1, s: { x: 1, t: null } }])).toBe("required $[0].s.x: required field missing");
  });

  test.each([
    ["a revoked proxy", () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }],
    ["a proxy around a Uint8Array", () => new Proxy(new Uint8Array([1]), {})],
  ])("a bytes value that is %s fails with type", (_, make) => {
    const bytes = compileIR({ kind: "bytes" });
    expect(() => bytes.encode(make() as never)).toThrow(expect.objectContaining({ code: "type", message: "$: expected Uint8Array" }));
  });

  test.todo("a bytes subclass with an overridden length is measured by its real length (deferred: PR #85 Deferred)", () => {
    class Lying extends Uint8Array {
      override get length(): number { return 0; }
    }
    const bytes = compileIR({ kind: "bytes" });
    expect(bytes.decode(bytes.encode(new Lying([1, 2])))).toEqual(new Uint8Array([1, 2]));
  });

  test("encodes a bytes value from another realm", () => {
    const foreign = runInNewContext("new Uint8Array([1, 2])") as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    const bytes = compileIR({ kind: "bytes" });
    expect(bytes.decode(bytes.encode(foreign))).toEqual(new Uint8Array([1, 2]));
    const rows = compileIR({
      kind: "array",
      element: { kind: "struct", fields: [{ name: "b", type: { kind: "bytes" } }] },
    }, { plan: "columnar" });
    expect(rows.decodeBody(rows.encodeBody([{ b: foreign }]))).toEqual([{ b: new Uint8Array([1, 2]) }]);
  });
});
