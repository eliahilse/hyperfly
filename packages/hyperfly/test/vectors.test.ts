import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/vectors.json" with { type: "json" };
import ir from "../../../spec/vectors/ir.json" with { type: "json" };
import { compileIR, type IRNode } from "../src/index.js";
import { toHex } from "../src/canonical.js";
import { HyperflyError, type ErrorCode } from "../src/errors.js";

function revive(value: unknown): unknown {
  if (value && typeof value === "object" && "$surrogate" in value) {
    return String.fromCharCode(parseInt((value as { $surrogate: string }).$surrogate, 16));
  }
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, revive(inner)]));
  }
  return value;
}

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

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("golden vectors: valid", () => {
  for (const v of vectors.valid) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode);
      expect(toHex(codec.encodeBody(v.value))).toBe(v.hex);
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(Object.is(v.value, -0) ? 0 : v.value);
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

describe("golden vectors: invalid encode", () => {
  for (const v of vectors.invalidEncode) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode);
      try {
        codec.encodeBody(revive(v.value));
        throw new Error("expected encode to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HyperflyError);
        expect((err as HyperflyError).code as string).toBe(v.error);
      }
    });
  }
});
