import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DecodeError, EncodeError, HyperflyError, UnsupportedSchemaError } from "../src/errors.js";
import { serializeArtifact } from "../src/index.js";
import { compile, toIR } from "../src/zod.js";

const Candle = z.object({
  t: z.number().int().min(0),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().min(0),
});

const Response = z.object({
  route: z.literal("candles"),
  interval: z.enum(["1m", "5m", "1h", "1d"]),
  candles: z.array(Candle),
  cursor: z.string().optional(),
  note: z.string().nullable(),
});

describe("toIR", () => {
  test("maps the candles response", () => {
    expect(toIR(Response)).toEqual({
      kind: "struct",
      fields: [
        { name: "route", type: { kind: "literal", value: "candles" } },
        { name: "interval", type: { kind: "enum", members: ["1m", "5m", "1h", "1d"] } },
        {
          name: "candles",
          type: {
            kind: "array",
            element: {
              kind: "struct",
              fields: [
                { name: "t", type: { kind: "int", min: 0 } },
                { name: "o", type: { kind: "float64" } },
                { name: "h", type: { kind: "float64" } },
                { name: "l", type: { kind: "float64" } },
                { name: "c", type: { kind: "float64" } },
                { name: "v", type: { kind: "float64" } },
              ],
            },
          },
        },
        { name: "cursor", type: { kind: "string" }, optional: true },
        { name: "note", type: { kind: "string" }, nullable: true },
      ],
    });
  });

  test("bounded int from min/max", () => {
    expect(toIR(z.object({ pct: z.number().int().min(0).max(100) }))).toEqual({
      kind: "struct",
      fields: [{ name: "pct", type: { kind: "int", min: 0, max: 100 } }],
    });
  });

  test("nullable array elements", () => {
    expect(toIR(z.array(z.number().nullable()))).toEqual({
      kind: "array",
      element: { kind: "nullable", inner: { kind: "float64" } },
    });
  });
});

describe("unsupported nodes fail loudly with a path", () => {
  test("union", () => {
    const schema = z.object({ u: z.union([z.string(), z.number()]) });
    try {
      toIR(schema);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedSchemaError);
      expect((err as UnsupportedSchemaError).path).toBe("$.u");
      expect((err as Error).message).toContain("union");
    }
  });

  test("record", () => {
    expect(() => toIR(z.record(z.string(), z.number()))).toThrow(UnsupportedSchemaError);
  });

  test("non-integer number literal", () => {
    expect(() => toIR(z.literal(1.5))).toThrow(UnsupportedSchemaError);
  });

  test("plain non-zod value", () => {
    expect(() => toIR({} as never)).toThrow(UnsupportedSchemaError);
  });
});

describe("compile round-trip", () => {
  const payload = {
    route: "candles" as const,
    interval: "5m" as const,
    candles: [
      { t: 1700000000000, o: 1.1, h: 2.2, l: 0.9, c: 1.7, v: 1234.5 },
      { t: 1700000300000, o: 1.7, h: 1.9, l: 1.2, c: 1.4, v: 987.6 },
    ],
    note: null,
  };

  test("trusted path", () => {
    const codec = compile(Response);
    expect(codec.decode(codec.encode(payload))).toEqual(payload);
  });

  test("validated path rejects junk and accepts good values", () => {
    const codec = compile(Response, { validate: true });
    expect(codec.decode(codec.encode(payload))).toEqual(payload);
    expect(() => codec.encode({ ...payload, interval: "2m" } as never)).toThrow();
  });

  test("smaller than JSON for this shape", () => {
    const codec = compile(Response);
    const wire = codec.encode(payload).length;
    const json = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(wire).toBeLessThan(json);
  });
});

describe("coded validation errors", () => {
  test.each([null, 0, 1, "true", {}, []].map((value) => [value] as const))("rejects validate: %p before compiling", (validate) => {
    const run = () => compile({} as never, { validate } as never);
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "options", message: "validate: must be a boolean" }));
  });

  test.each(["encode", "encodeBody", "decode", "decodeBody"] as const)("wraps %s parse errors and preserves their cause", (method) => {
    const schema = z.string().min(3);
    const originalParse = schema.parse.bind(schema);
    let cause: unknown;
    schema.parse = (value) => {
      try {
        return originalParse(value);
      } catch (error) {
        cause = error;
        throw error;
      }
    };
    const codec = compile(schema, { validate: true });
    const trusted = compile(schema);
    const run = () => {
      if (method === "encode" || method === "encodeBody") return codec[method]("x");
      return codec[method](method === "decode" ? trusted.encode("x") : trusted.encodeBody("x"));
    };
    try {
      run();
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(method.startsWith("encode") ? EncodeError : DecodeError);
      expect(error).toBeInstanceOf(HyperflyError);
      expect((error as HyperflyError).code).toBe("validation");
      expect(cause).toBeInstanceOf(z.ZodError);
      expect((error as HyperflyError).cause).toBe(cause);
      expect((error as HyperflyError).message).toBe(`$: ${(cause as Error).message}`);
    }
  });

  test.each(["encode", "encodeBody", "decode", "decodeBody"] as const)("preserves %s codec errors", (method) => {
    const codec = compile(z.string(), { validate: true, limits: { maxByteLength: 1 } });
    const run = () => {
      if (method === "encode" || method === "encodeBody") return codec[method]("long");
      return codec[method](new Uint8Array());
    };
    const code = method.startsWith("encode") ? "limit" : method === "decode" ? "header" : "truncated";
    expect(run).toThrow(method.startsWith("encode") ? EncodeError : DecodeError);
    expect(run).toThrow(expect.objectContaining({ code }));
    try {
      run();
    } catch (error) {
      expect((error as HyperflyError).cause).toBeUndefined();
    }
  });

  test("preserves an error thrown by a custom parse", () => {
    const cause = new TypeError("custom validation failed");
    const schema = z.string();
    schema.parse = () => { throw cause; };
    const codec = compile(schema, { validate: true });
    expect(() => codec.encode("value")).toThrow(expect.objectContaining({ code: "validation", cause }));
  });

  test.each([null, "invalid", { toString: null }].map((cause) => [cause] as const))(
    "wraps non-Error parse failures: %p", (cause) => {
      const schema = z.string();
      schema.parse = () => { throw cause; };
      const codec = compile(schema, { validate: true });
      expect(() => codec.encodeBody("value")).toThrow(EncodeError);
      expect(() => codec.encodeBody("value")).toThrow(expect.objectContaining({ code: "validation", cause }));
    },
  );
});

describe("integer bound intersection (retro #7/#8)", () => {
  test("exclusive gt/lt convert to inclusive integer bounds", () => {
    expect(toIR(z.object({ n: z.number().int().gt(1).lt(10) }))).toEqual({
      kind: "struct",
      fields: [{ name: "n", type: { kind: "int", min: 2, max: 9 } }],
    });
  });

  test("tightest bound wins when several are declared", () => {
    expect(toIR(z.object({ n: z.number().int().min(0).gt(4) }))).toEqual({
      kind: "struct",
      fields: [{ name: "n", type: { kind: "int", min: 5 } }],
    });
  });
});

describe("IR rejects lone surrogates (retro #10)", () => {
  test("enum member with a lone surrogate", () => {
    expect(() => toIR(z.object({ e: z.enum(["ok", "\ud800"]) }))).toThrow();
  });
});

describe("cross-adapter parity (retro)", () => {
  test("artifact string is pinned to the pydantic adapter's output", () => {
    const Row = z.object({
      id: z.string(),
      kind: z.literal("a"),
      score: z.number().int().min(0).max(100),
      ratio: z.number(),
      note: z.string().nullable(),
      tag: z.string().nullable(),
    });
    // identical string is asserted in python/tests/test_cross_adapter.py
    expect(serializeArtifact(toIR(Row), "columnar")).toBe(
      '{"wire":1,"plan":{"layout":"columnar","version":5},"ir":' +
        '{"kind":"struct","fields":[' +
        '{"name":"id","type":{"kind":"string"}},' +
        '{"name":"kind","type":{"kind":"literal","value":"a"}},' +
        '{"name":"score","type":{"kind":"int","min":0,"max":100}},' +
        '{"name":"ratio","type":{"kind":"float64"}},' +
        '{"name":"note","type":{"kind":"string"},"nullable":true},' +
        '{"name":"tag","type":{"kind":"string"},"nullable":true}]}}',
    );
  });
});
