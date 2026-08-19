import { describe, expect, test } from "bun:test";
import { compileIR, type IRNode } from "../src/index.js";

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

const WORDS = ["alpha", "béta", "γάμμα", "delta", "🚀", "", 'quote"backslash\\', "line\nbreak"];

function randomValue(rng: () => number, node: IRNode, depth: number): unknown {
  switch (node.kind) {
    case "bool":
      return rng() < 0.5;
    case "int": {
      const min = node.min ?? -(2 ** 53 - 1);
      const max = node.max ?? 2 ** 53 - 1;
      if (rng() < 0.15) return min;
      if (rng() < 0.15) return max;
      const span = Math.min(max - min, 2 ** 32);
      return min + Math.floor(rng() * (span + 1));
    }
    case "float64": {
      const r = rng();
      if (r < 0.1) return 0;
      if (r < 0.2) return rng() * 2 - 1;
      return (rng() * 2 - 1) * 2 ** (Math.floor(rng() * 120) - 60);
    }
    case "string":
      return Array.from({ length: Math.floor(rng() * 4) }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(" ");
    case "bytes": {
      const out = new Uint8Array(Math.floor(rng() * 16));
      for (let i = 0; i < out.length; i++) out[i] = Math.floor(rng() * 256);
      return out;
    }
    case "literal":
      return node.value;
    case "enum":
      return node.members[Math.floor(rng() * node.members.length)];
    case "nullable":
      return rng() < 0.3 ? null : randomValue(rng, node.inner, depth + 1);
    case "array": {
      const count = node.length ?? Math.floor(rng() * (depth > 2 ? 3 : 6));
      return Array.from({ length: count }, () => randomValue(rng, node.element, depth + 1));
    }
    case "struct": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) {
        if (f.optional && rng() < 0.35) continue;
        if (f.nullable && rng() < 0.25) out[f.name] = null;
        else out[f.name] = randomValue(rng, f.type, depth + 1);
      }
      return out;
    }
  }
}

const KINDS: ((rng: () => number) => IRNode)[] = [
  () => ({ kind: "bool" }),
  (rng) => {
    if (rng() < 0.5) return { kind: "int" };
    const min = Math.floor(rng() * 2000) - 1000;
    return { kind: "int", min, max: min + Math.floor(rng() * 100000) };
  },
  () => ({ kind: "float64" }),
  () => ({ kind: "string" }),
  () => ({ kind: "bytes" }),
  (rng) => ({ kind: "enum", members: ["a", "b", "c", "d", "e"].slice(0, 1 + Math.floor(rng() * 5)) }),
  (rng) => ({ kind: "literal", value: ["ok", 7, true, null][Math.floor(rng() * 4)] as never }),
];

function randomIR(rng: () => number, depth: number): IRNode {
  const r = rng();
  if (depth < 3 && r < 0.22) {
    const fields = Array.from({ length: 1 + Math.floor(rng() * 5) }, (_, i) => {
      const type = randomIR(rng, depth + 1);
      return {
        name: `f${i}`,
        type,
        ...(rng() < 0.3 ? { optional: true } : {}),
        ...(rng() < 0.3 && type.kind !== "nullable" && !(type.kind === "literal" && type.value === null)
          ? { nullable: true }
          : {}),
      };
    });
    return { kind: "struct", fields };
  }
  if (depth < 3 && r < 0.38) {
    return {
      kind: "array",
      element: randomIR(rng, depth + 1),
      ...(rng() < 0.2 ? { length: Math.floor(rng() * 4) } : {}),
    };
  }
  if (depth < 3 && r < 0.46) {
    let inner = randomIR(rng, depth + 1);
    while (inner.kind === "nullable" || (inner.kind === "literal" && inner.value === null)) {
      inner = randomIR(rng, depth + 1);
    }
    return { kind: "nullable", inner };
  }
  return KINDS[Math.floor(rng() * KINDS.length)]!(rng);
}

describe("seeded round-trip property", () => {
  test("500 random schemas × values, body and envelope", () => {
    const rng = mulberry32(0x48460001);
    for (let i = 0; i < 500; i++) {
      const ir = randomIR(rng, 0);
      const codec = compileIR(ir);
      for (let j = 0; j < 4; j++) {
        const value = randomValue(rng, ir, 0);
        expect(codec.decodeBody(codec.encodeBody(value))).toEqual(value as never);
        expect(codec.decode(codec.encode(value))).toEqual(value as never);
      }
    }
  });

  test("byte-identical re-encode (canonical wire)", () => {
    const rng = mulberry32(0xbeef);
    for (let i = 0; i < 100; i++) {
      const ir = randomIR(rng, 0);
      const codec = compileIR(ir);
      const value = randomValue(rng, ir, 0);
      const once = codec.encode(value);
      const twice = codec.encode(codec.decode(once));
      expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
    }
  });
});
