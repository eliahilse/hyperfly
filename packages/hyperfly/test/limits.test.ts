import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/limits.json" with { type: "json" };
import { compileIR, type DecodeLimits, type IRNode } from "../src/index.js";
import { toHex } from "../src/canonical.js";
import { HyperflyError } from "../src/errors.js";

interface LimitVector {
  name: string;
  plan: string;
  ir: unknown;
  limits?: Partial<DecodeLimits>;
  value?: unknown;
  hex?: string;
  error?: string;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    if ("$bytes" in value) return fromHex((value as { $bytes: string }).$bytes);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

function codecFor(v: LimitVector) {
  return compileIR(v.ir as IRNode, {
    plan: v.plan === "columnar" ? "columnar" : "row",
    ...(v.limits ? { limits: v.limits } : {}),
  });
}

function expectCode(run: () => unknown, code: string | undefined): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(HyperflyError);
    expect((err as HyperflyError).code as string).toBe(code!);
    return;
  }
  throw new Error(`expected a ${code} error`);
}

const sections = vectors as unknown as Record<"valid" | "invalidDecode" | "invalidEncode" | "decodeOnly", LimitVector[]>;

describe("limit vectors: valid", () => {
  for (const v of sections.valid) {
    test(v.name, () => {
      const codec = codecFor(v);
      expect(toHex(codec.encodeBody(revive(v.value)))).toBe(v.hex!);
      expect(codec.decodeBody(fromHex(v.hex!))).toEqual(revive(v.value) as never);
    });
  }
});

describe("limit vectors: invalid decode", () => {
  for (const v of sections.invalidDecode) {
    test(v.name, () => expectCode(() => codecFor(v).decodeBody(fromHex(v.hex!)), v.error));
  }
});

describe("limit vectors: invalid encode", () => {
  for (const v of sections.invalidEncode) {
    test(v.name, () => expectCode(() => codecFor(v).encodeBody(revive(v.value)), v.error));
  }
});

describe("limit vectors: decode only", () => {
  for (const v of sections.decodeOnly) {
    test(v.name, () => {
      const codec = codecFor(v);
      expect(codec.decodeBody(fromHex(v.hex!))).toEqual(revive(v.value) as never);
      expectCode(() => codec.encodeBody(revive(v.value)), "limit");
    });
  }
});

describe("the encoder's one-bit floor counts only the array's own bytes", () => {
  test("a body whose floor a later sibling pays decodes, and its value is refused on encode", () => {
    const ir: IRNode = {
      kind: "struct",
      fields: [
        {
          name: "a",
          type: {
            kind: "array",
            element: {
              kind: "array",
              length: 2,
              element: { kind: "struct", fields: [{ name: "e", type: { kind: "enum", members: ["a"] } }] },
            },
          },
        },
        { name: "b", type: { kind: "bytes" } },
      ],
    };
    const codec = compileIR(ir, { plan: "columnar" });
    const value = codec.decodeBody(fromHex(`0a64${"00".repeat(100)}`));
    expect(value).toEqual({
      a: Array.from({ length: 10 }, () => [{ e: "a" }, { e: "a" }]),
      b: new Uint8Array(100),
    });
    expectCode(() => codec.encodeBody(value), "limit");
  });
});
