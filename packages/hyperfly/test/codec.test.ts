import { describe, expect, test } from "bun:test";
import {
  compileIR,
  DEFAULT_LIMITS,
  FingerprintMismatchError,
  serializeArtifact,
  type IRNode,
} from "../src/index.js";
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
