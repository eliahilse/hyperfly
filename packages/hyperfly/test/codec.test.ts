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

describe("compile options", () => {
  test.each([null, false, true, 0, "row", [], () => {}].map((value) => [value] as const))("rejects non-object options %p", (options) => {
    expect(() => compileIR(STRUCT, options as never)).toThrow(HyperflyError);
    expect(() => compileIR(STRUCT, options as never)).toThrow(expect.objectContaining({
      code: "options", message: "options: must be an object",
    }));
  });

  test.each([
    [{ limits: null }, "limits"],
    [{ limits: [] }, "limits"],
    [{ limits: false }, "limits"],
    [{ limits: 1 }, "limits"],
    [{ limits: "default" }, "limits"],
    [{ limits: { maxDeph: 1 } }, "limits.maxDeph: unknown limit"],
    [{ limits: { maxDeph: undefined } }, "limits.maxDeph: unknown limit"],
    [{ limits: JSON.parse('{"__proto__":0}') }, "limits.__proto__: unknown limit"],
    [{ limits: { constructor: 0 } }, "limits.constructor: unknown limit"],
    [{ limits: { [Symbol("maxDepth")]: 0 } }, "limits.Symbol(maxDepth): unknown limit"],
    ...[null, false, 1, "rows", {}, []].map((plan) => [{ plan }, "plan"]),
    ...[null, true, 1, "default", () => {}].map((pack) => [{ pack }, "pack"]),
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
    expect(() => compileIR(null as never, { plan: "bad" } as never)).toThrow(expect.objectContaining({ code: "options" }));
  });

  test("accepts safe integer limits including zero", () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, value]));
      expect(() => compileIR(STRUCT, { limits })).not.toThrow();
    }
  });

  test("undefined limits preserve defaults and inherited limits are ignored", () => {
    const limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, undefined]));
    const codec = compileIR(STRUCT, { limits });
    const value = { a: 1, b: "hello" };
    expect(codec.decode(codec.encode(value))).toEqual(value);
    const inherited = Object.create({ maxByteLength: 0, unknown: 0 }) as object;
    expect(compileIR(STRUCT, { limits: inherited }).encode(value)).toEqual(codec.encode(value));
    const hidden = Object.defineProperty({}, "unknown", { value: -1 });
    expect(compileIR(STRUCT, { limits: hidden }).encode(value)).toEqual(codec.encode(value));
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
