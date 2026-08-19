import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { UnsupportedSchemaError } from "../src/errors.js";
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
