import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/vectors.json" with { type: "json" };
import ir from "../../../spec/vectors/ir.json" with { type: "json" };
import { compileIR, type IRNode } from "../src/index.js";
import { toHex } from "../src/canonical.js";
import { HyperflyError, type ErrorCode } from "../src/errors.js";
import { fromHex, revive } from "./vector-values.js";

function compileVector(v: { ir: unknown; profile?: unknown }): void {
  const options = "profile" in v ? { plan: "columnar" as const, profile: revive(v.profile) as never, pack: false as const } : {};
  compileIR(revive(v.ir) as IRNode, options);
}

describe("golden vectors: IR acceptance", () => {
  for (const v of ir.invalid) {
    test(v.name, () => {
      try {
        compileVector(v);
      } catch (e) {
        expect((e as HyperflyError).code).toBe(v.error as ErrorCode);
        return;
      }
      throw new Error("compiled invalid IR");
    });
  }
  for (const v of ir.valid) {
    test(v.name, () => expect(() => compileVector(v)).not.toThrow());
  }
});

describe("golden vectors: valid", () => {
  for (const v of vectors.valid) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode);
      const value = revive(v.value);
      expect(toHex(codec.encodeBody(value))).toBe(v.hex);
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(Object.is(value, -0) ? 0 : value);
    });
  }
});

describe("golden vectors: invalid decode", () => {
  for (const v of vectors.invalidDecode) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode);
      try {
        codec.decodeBody(fromHex(v.hex));
        throw new Error("expected decode to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HyperflyError);
        expect((err as HyperflyError).code as string).toBe(v.error);
      }
    });
  }
});

function expectEncodeError(v: { ir: unknown; value: unknown; error: string }): void {
  const codec = compileIR(v.ir as IRNode);
  try {
    codec.encodeBody(revive(v.value));
    throw new Error("expected encode to fail");
  } catch (err) {
    expect(err).toBeInstanceOf(HyperflyError);
    expect((err as HyperflyError).code as string).toBe(v.error);
  }
}

describe("golden vectors: invalid encode", () => {
  for (const v of vectors.invalidEncode) {
    test(v.name, () => expectEncodeError(v));
  }

  test("a $bytes marker revives to a Uint8Array, which is not a struct value", () => {
    expectEncodeError({
      ir: { kind: "struct", fields: [{ name: "a", type: { kind: "bool" } }] },
      value: { $bytes: "0001" },
      error: "type",
    });
    expect(revive({ s: { $bytes: "0001" }, t: [{ $bytes: "" }], u: { $bytes: "00", v: 1 } })).toEqual({
      s: new Uint8Array([0, 1]),
      t: [new Uint8Array()],
      u: { $bytes: "00", v: 1 },
    });
  });
});
