import { describe, expect, test } from "bun:test";
import {
  compileIR,
  FingerprintMismatchError,
  HEADER_SIZE,
  serializeArtifact,
  type IRNode,
} from "../src/index.js";
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
