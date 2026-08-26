import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/columnar.json" with { type: "json" };
import { z } from "zod";
import { compileIR, FingerprintMismatchError, toHex, train, type IRNode } from "../src/index.js";
import { HyperflyError } from "../src/errors.js";
import { compile } from "../src/zod.js";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("columnar golden vectors: valid", () => {
  for (const v of vectors.valid) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar" });
      expect(toHex(codec.encodeBody(v.value))).toBe(v.hex);
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(v.value);
    });
  }
});

describe("columnar golden vectors: invalid decode", () => {
  for (const v of vectors.invalidDecode) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar" });
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

describe("columnar golden vectors: invalid encode", () => {
  for (const v of vectors.invalidEncode) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar" });
      try {
        codec.encodeBody(v.value);
        throw new Error("expected encode to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HyperflyError);
        expect((err as HyperflyError).code as string).toBe(v.error);
      }
    });
  }
});

describe("columnar packed vectors: decode-only", () => {
  for (const v of vectors.packedDecode) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar" });
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(v.value);
    });
  }

  test("packed input without an inflate hook fails closed", () => {
    const v = vectors.packedDecode[0]!;
    const codec = compileIR(v.ir as IRNode, { plan: "columnar", pack: false });
    try {
      codec.decodeBody(fromHex(v.hex));
      throw new Error("expected failure");
    } catch (err) {
      expect((err as HyperflyError).code).toBe("unsupported");
    }
  });
});

describe("packed string columns", () => {
  const IR: IRNode = {
    kind: "array",
    element: { kind: "struct", fields: [{ name: "body", type: { kind: "string" } }] },
  };
  const prose = Array.from({ length: 40 }, (_, i) => ({
    body: `the quick brown fox jumps over the lazy dog and files report number ${i} about the same fox again`,
  }));

  test("prose columns pack, shrink, and round-trip", () => {
    const packedCodec = compileIR(IR, { plan: "columnar" });
    const plainCodec = compileIR(IR, { plan: "columnar", pack: false });
    const packed = packedCodec.encodeBody(prose);
    const plain = plainCodec.encodeBody(prose);
    expect(packed.length).toBeLessThan(plain.length * 0.5);
    expect(packedCodec.decodeBody(packed)).toEqual(prose);
    expect(plainCodec.decodeBody(plain)).toEqual(prose);
    const again = packedCodec.encodeBody(packedCodec.decodeBody(packed));
    expect(Buffer.from(again).equals(Buffer.from(packed))).toBe(true);
  });

  test("tiny strings stay plain even with hooks available", () => {
    const codec = compileIR(IR, { plan: "columnar" });
    const value = [{ body: "a" }, { body: "b" }];
    const plain = compileIR(IR, { plan: "columnar", pack: false }).encodeBody(value);
    expect(Buffer.from(codec.encodeBody(value)).equals(Buffer.from(plain))).toBe(true);
  });
});

describe("plan separation", () => {
  const IR: IRNode = {
    kind: "array",
    element: { kind: "struct", fields: [{ name: "a", type: { kind: "int" } }] },
  };

  test("row and columnar fingerprints differ", () => {
    const row = compileIR(IR);
    const col = compileIR(IR, { plan: "columnar" });
    expect(row.fingerprint).not.toBe(col.fingerprint);
    expect(row.plan).toBe("row");
    expect(col.plan).toBe("columnar");
  });

  test("cross-plan decode is a fingerprint mismatch, not garbage", () => {
    const row = compileIR(IR);
    const col = compileIR(IR, { plan: "columnar" });
    const bytes = col.encode([{ a: 1 }]);
    expect(() => row.decode(bytes)).toThrow(FingerprintMismatchError);
  });
});

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

const PRIMITIVES: ((rng: () => number) => IRNode)[] = [
  () => ({ kind: "bool" }),
  (rng) => {
    if (rng() < 0.4) return { kind: "int" };
    const min = Math.floor(rng() * 2000) - 1000;
    return { kind: "int", min, max: min + Math.floor(rng() * 100000) };
  },
  () => ({ kind: "float64" }),
  () => ({ kind: "string" }),
  () => ({ kind: "bytes" }),
  (rng) => ({ kind: "enum", members: ["a", "b", "c", "d"].slice(0, 1 + Math.floor(rng() * 4)) }),
  (rng) => ({ kind: "literal", value: ["ok", 7, true, null][Math.floor(rng() * 4)] as never }),
];

function randomColumnValue(rng: () => number, node: IRNode): unknown {
  switch (node.kind) {
    case "bool":
      return rng() < 0.5;
    case "int": {
      const min = node.min ?? -(2 ** 53 - 1);
      const max = node.max ?? 2 ** 53 - 1;
      if (rng() < 0.1) return min;
      if (rng() < 0.1) return max;
      const span = Math.min(max - min, 2 ** 40);
      return min + Math.floor(rng() * (span + 1));
    }
    case "float64": {
      const r = rng();
      if (r < 0.15) return 0;
      if (r < 0.5) return Math.round(rng() * 20000) / 100;
      return (rng() * 2 - 1) * 2 ** (Math.floor(rng() * 80) - 40);
    }
    case "string":
      return rng() < 0.2 ? "" : `s${Math.floor(rng() * 1000)}`;
    case "bytes": {
      const out = new Uint8Array(Math.floor(rng() * 8));
      for (let i = 0; i < out.length; i++) out[i] = Math.floor(rng() * 256);
      return out;
    }
    case "enum":
      return node.members[Math.floor(rng() * node.members.length)];
    case "literal":
      return node.value;
    default:
      throw new Error(`not a column primitive: ${node.kind}`);
  }
}

describe("columnar seeded properties", () => {
  test("300 random eligible schemas: round-trip, plan equivalence, canonical re-encode", () => {
    const rng = mulberry32(0xc01c01);
    for (let i = 0; i < 300; i++) {
      const fieldCount = 1 + Math.floor(rng() * 6);
      const fields = Array.from({ length: fieldCount }, (_, f) => {
        const type = PRIMITIVES[Math.floor(rng() * PRIMITIVES.length)]!(rng);
        const nullableOk = !(type.kind === "literal" && type.value === null);
        return {
          name: `f${f}`,
          type,
          ...(rng() < 0.25 ? { optional: true } : {}),
          ...(rng() < 0.25 && nullableOk ? { nullable: true } : {}),
        };
      });
      const ir: IRNode = { kind: "array", element: { kind: "struct", fields } };
      const col = compileIR(ir, { plan: "columnar" });
      const row = compileIR(ir);

      const rowCount = Math.floor(rng() * 40);
      const value = Array.from({ length: rowCount }, () => {
        const out: Record<string, unknown> = {};
        for (const f of fields) {
          if (f.optional && rng() < 0.3) continue;
          if (f.nullable && rng() < 0.2) out[f.name] = null;
          else out[f.name] = randomColumnValue(rng, f.type);
        }
        return out;
      });

      const colBytes = col.encodeBody(value);
      const decoded = col.decodeBody(colBytes);
      expect(decoded).toEqual(value as never);
      expect(row.decodeBody(row.encodeBody(value))).toEqual(value as never);
      expect(toHex(col.encodeBody(decoded))).toBe(toHex(colBytes));
    }
  });

  test("monotonic int columns shrink under columnar", () => {
    const ir: IRNode = {
      kind: "array",
      element: { kind: "struct", fields: [{ name: "t", type: { kind: "int", min: 0 } }] },
    };
    const value = Array.from({ length: 500 }, (_, i) => ({ t: 1735689600000 + i * 300000 }));
    const row = compileIR(ir).encodeBody(value);
    const col = compileIR(ir, { plan: "columnar" }).encodeBody(value);
    expect(col.length).toBeLessThan(row.length * 0.55);
  });
});

describe("zod integration", () => {
  test("plan option flows through hyperfly/zod", () => {
    const schema = z.object({
      rows: z.array(z.object({ t: z.number().int().min(0), v: z.number() })),
    });
    const codec = compile(schema, { plan: "columnar" });
    expect(codec.plan).toBe("columnar");
    const payload = { rows: [{ t: 1, v: 1.5 }, { t: 2, v: 1.5 }] };
    expect(codec.decode(codec.encode(payload))).toEqual(payload);
  });
});

describe("empty column canonicality", () => {
  test("nonzero mode with no rows is rejected for every column type", () => {
    const cases: [IRNode, string][] = [
      [{ kind: "int" }, "01 00 01"],
      [{ kind: "float64" }, "01 00 01"],
      [{ kind: "string" }, "01 00 01"],
    ];
    for (const [type, hex] of cases) {
      const codec = compileIR(
        { kind: "array", element: { kind: "struct", fields: [{ name: "x", type, optional: true }] } },
        { plan: "columnar" },
      );
      expect(() => codec.decodeBody(fromHex(hex.replace(/ /g, "")))).toThrow("mode 0x00");
    }
  });
});

describe("profiles: dictionary columns", () => {
  const IR: IRNode = {
    kind: "array",
    element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
  };
  const profile = {
    version: 1 as const,
    shared: { columns: [{ leaf: 0, dict: ["online", "offline"] }] },
  };

  test("hits become codes, misses escape, and it round-trips", () => {
    const codec = compileIR(IR, { plan: "columnar", profile, pack: false });
    const value = [{ s: "online" }, { s: "novel" }, { s: "offline" }];
    const body = codec.encodeBody(value);
    expect(toHex(body)).toBe("03010221056e6f76656c");
    expect(codec.decodeBody(body)).toEqual(value);
  });

  test("a profile changes the fingerprint and the artifact", () => {
    const bare = compileIR(IR, { plan: "columnar" });
    const withProfile = compileIR(IR, { plan: "columnar", profile });
    expect(withProfile.fingerprint).not.toBe(bare.fingerprint);
    expect(withProfile.artifact).toContain('"profile":{"columns":[{"leaf":0,"dict":["online","offline"]}]}');
    expect(() => bare.decode(withProfile.encode([{ s: "online" }]))).toThrow();
  });

  test("a decoder without the profile refuses dictionary columns", () => {
    const codec = compileIR(IR, { plan: "columnar", profile, pack: false });
    const body = codec.encodeBody([{ s: "online" }]);
    const bare = compileIR(IR, { plan: "columnar", pack: false });
    expect(() => bare.decodeBody(body)).toThrow("dictionary column requires a profile");
  });

  test("an out-of-range code is rejected", () => {
    const codec = compileIR(IR, { plan: "columnar", profile, pack: false });
    expect(() => codec.decodeBody(fromHex("01010203"))).toThrow("out of range");
  });

  test("invalid profiles are rejected at compile", () => {
    const bad = (columns: unknown) =>
      compileIR(IR, { plan: "columnar", profile: { version: 1, shared: { columns } } as never });
    expect(() => bad([{ leaf: 9, dict: ["a"] }])).toThrow("not a column");
    expect(() => bad([{ leaf: 0, dict: ["a", "a"] }])).toThrow("duplicate entry");
    expect(() => bad([{ leaf: 0, dict: [] }])).toThrow("1 to");
    expect(() =>
      compileIR(IR, { plan: "row", profile: { version: 1, shared: { columns: [] } } }),
    ).toThrow("columnar plan only");
  });
});

describe("profiled golden vectors", () => {
  for (const v of vectors.profiled.valid) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar", profile: v.profile as never, pack: false });
      expect(toHex(codec.encodeBody(v.value))).toBe(v.hex);
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(v.value);
    });
  }

  for (const v of vectors.profiled.invalidDecode) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar", profile: v.profile as never, pack: false });
      try {
        codec.decodeBody(fromHex(v.hex));
        throw new Error("expected failure");
      } catch (err) {
        expect((err as HyperflyError).code as string).toBe(v.error);
      }
    });
  }

  for (const v of vectors.profiled.requiresProfile) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar", pack: false });
      try {
        codec.decodeBody(fromHex(v.hex));
        throw new Error("expected failure");
      } catch (err) {
        expect((err as HyperflyError).code as string).toBe(v.error);
      }
    });
  }

  // decode-only: valid input a canonical encoder would never produce (E = k)
  for (const v of vectors.profiled.decodeOnly) {
    test(v.name, () => {
      const codec = compileIR(v.ir as IRNode, { plan: "columnar", profile: v.profile as never, pack: false });
      expect(codec.decodeBody(fromHex(v.hex))).toEqual(v.value);
    });
  }

  // the accepted profile domain is closed: these documents must fail compilation
  const reviveDeep = (value: unknown): unknown => {
    if (value && typeof value === "object" && "$surrogate" in (value as object)) {
      return String.fromCharCode(parseInt((value as { $surrogate: string }).$surrogate, 16));
    }
    if (Array.isArray(value)) return value.map(reviveDeep);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, val]) => [k, reviveDeep(val)]));
    }
    return value;
  };
  for (const v of vectors.profiled.invalidProfile) {
    test(v.name, () => {
      try {
        compileIR(v.ir as IRNode, { plan: "columnar", profile: reviveDeep(v.profile) as never, pack: false });
        throw new Error("expected failure");
      } catch (err) {
        expect(err).toBeInstanceOf(HyperflyError);
        expect((err as HyperflyError).code as string).toBe(v.error);
      }
    });
  }
});

describe("profile reconstructions respect the decoder byte limit", () => {
  const IR: IRNode = {
    kind: "array",
    element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
  };
  const limits = { maxByteLength: 8 } as never;

  test("a dictionary entry beyond maxByteLength is rejected at decode", () => {
    const profile = {
      version: 1 as const,
      shared: { columns: [{ leaf: 0, dict: ["a-value-well-beyond-eight-bytes"] }] },
    };
    const codec = compileIR(IR, { plan: "columnar", profile, pack: false });
    const body = codec.encodeBody([{ s: "a-value-well-beyond-eight-bytes" }]);
    const tight = compileIR(IR, { plan: "columnar", profile, pack: false, limits });
    expect(() => tight.decodeBody(body)).toThrow("limit");
  });

  test("a grammar rendering beyond maxByteLength is rejected at decode", () => {
    const profile = {
      version: 2 as const,
      shared: {
        columns: [
          { leaf: 0, grammar: [{ lit: "quite-a-long-prefix-" }, { num: { base: 10 as const, len: 2, case: "lower" as const } }] },
        ],
      },
    };
    const codec = compileIR(IR, { plan: "columnar", profile, pack: false });
    const body = codec.encodeBody([{ s: "quite-a-long-prefix-07" }]);
    const tight = compileIR(IR, { plan: "columnar", profile, pack: false, limits });
    expect(() => tight.decodeBody(body)).toThrow("limit");
  });
});

describe("profiles: aliased schema nodes", () => {
  // A golden vector cannot express this: loading IR from JSON always yields distinct
  // objects, so only an in-memory schema that reuses one node reaches the hazard.
  const arr: IRNode = {
    kind: "array",
    element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
  };
  const IR: IRNode = {
    kind: "struct",
    fields: [
      { name: "a", type: arr },
      { name: "b", type: arr },
    ],
  };
  const profile = {
    version: 1 as const,
    shared: {
      columns: [
        { leaf: 0, dict: ["red", "green"] },
        { leaf: 1, dict: ["green", "red"] },
      ],
    },
  };

  test("one node object at two positions still gets distinct ordinals", () => {
    const codec = compileIR(IR, { plan: "columnar", profile, pack: false });
    const value = { a: [{ s: "red" }], b: [{ s: "red" }] };
    // "red" is code 1 under leaf 0 and code 2 under leaf 1
    expect(toHex(codec.encodeBody(value))).toBe("0101010101010202");
    expect(codec.decodeBody(codec.encodeBody(value))).toEqual(value);
  });

  test("the trainer assigns the same ordinals the codec reads", () => {
    const samples = [
      { a: [{ s: "aa" }, { s: "aa" }], b: [{ s: "bb" }, { s: "bb" }] },
      { a: [{ s: "aa" }], b: [{ s: "bb" }] },
    ];
    const trained = train(IR, samples);
    expect(trained?.shared.columns).toEqual([
      { leaf: 0, dict: ["aa"] },
      { leaf: 1, dict: ["bb"] },
    ]);
    const codec = compileIR(IR, { plan: "columnar", profile: trained, pack: false });
    expect(codec.decodeBody(codec.encodeBody(samples[0]!))).toEqual(samples[0]!);
  });
});
