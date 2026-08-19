import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/vectors.json" with { type: "json" };
import { compileIR, toHex, type IRNode } from "../src/index.js";
import { HyperflyError } from "../src/errors.js";

function revive(value: unknown): unknown {
  if (value && typeof value === "object" && "$surrogate" in value) {
    return String.fromCharCode(parseInt((value as { $surrogate: string }).$surrogate, 16));
  }
  return value;
}

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
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(v.value);
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
