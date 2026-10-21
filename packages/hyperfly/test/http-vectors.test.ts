import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { CodecRegistry, compileIR, HyperflyError, type IRNode } from "../src/index.js";
import { decodeResponse, encodeFor, negotiate, readBody, respond } from "../src/http.js";
import { fromHex, revive } from "./vector-values.js";

interface JsonRow {
  name: string;
  ir: IRNode;
  value?: unknown;
  json: string;
  error?: "json";
}
interface BodyRow {
  name: string;
  ir?: IRNode;
  contentType: string;
  contentLength?: string;
  maxBytes?: number;
  hex: string;
  expected: { kind: "json"; value: unknown } | { error: "json" } | { status: number };
}
interface HttpVectors {
  jsonFallback: { valid: JsonRow[]; invalid: JsonRow[] };
  responses: BodyRow[];
  requests: BodyRow[];
}

const path = new URL("../../../spec/vectors/http.json", import.meta.url);
const vectors = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as HttpVectors : undefined;
const url = "https://example.test/value";
const registryFor = (ir?: IRNode) => new CodecRegistry(ir ? [compileIR(ir)] : []);

// Compare parsed binary64 numbers with -0 equal to 0, ignoring unknown struct keys.
function comparable(value: unknown, ir?: IRNode): unknown {
  if (value === 0) return 0;
  if (ir?.kind === "nullable") return comparable(value, ir.inner);
  if (Array.isArray(value)) return value.map((item) => comparable(item, ir?.kind === "array" ? ir.element : undefined));
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (ir?.kind !== "struct") return [[key, comparable(item)]];
      const field = ir.fields.find((field) => field.name === key);
      return field ? [[key, comparable(item, field.type)]] : [];
    }));
  }
  return value;
}

function request(body: BodyInit, contentType: string, contentLength?: string): Request {
  const req = new Request(url, { method: "POST", body, headers: { "Content-Type": contentType } });
  // Headers trims platform whitespace. Vectors require the original string verbatim.
  const get = req.headers.get.bind(req.headers);
  req.headers.get = (name) => name.toLowerCase() === "content-length" ? contentLength ?? null : get(name);
  return req;
}

if (!vectors) {
  test.skip("HTTP vectors not available: spec/vectors/http.json", () => {});
} else {
  describe("HTTP JSON fallback vectors: valid", () => {
    for (const row of vectors.jsonFallback.valid) {
      test(`${row.name}: encode`, async () => {
        const registry = registryFor(row.ir);
        const value = revive(row.value);
        const encoded = encodeFor(negotiate(null, registry), value);
        expect(encoded.headers["Content-Type"]).toBe("application/json");
        expect(comparable(JSON.parse(encoded.body as string), row.ir)).toEqual(comparable(JSON.parse(row.json), row.ir));
        const response = respond(new Request(url), value, registry);
        expect(comparable(await response.json(), row.ir)).toEqual(comparable(JSON.parse(row.json), row.ir));
      });
      test(`${row.name}: response`, () => {
        const result = decodeResponse("application/json", row.json, registryFor(row.ir));
        expect(result.kind).toBe("json");
        if (result.kind === "json") expect(comparable(result.value, row.ir)).toEqual(comparable(revive(row.value), row.ir));
      });
      test(`${row.name}: request`, async () => {
        const result = await readBody(request(row.json, "application/json"), registryFor(row.ir));
        expect(result.ok).toBe(true);
        if (result.ok) expect(comparable(result.value, row.ir)).toEqual(comparable(revive(row.value), row.ir));
      });
    }
  });
  describe("HTTP JSON fallback vectors: invalid", () => {
    for (const row of vectors.jsonFallback.invalid) {
      test(`${row.name}: response`, () => {
        const run = () => decodeResponse("application/json", row.json, registryFor(row.ir));
        expect(run).toThrow(HyperflyError);
        expect(run).toThrow(expect.objectContaining({ code: row.error }));
      });
      test(`${row.name}: request`, async () => {
        const result = await readBody(request(row.json, "application/json"), registryFor(row.ir));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(400);
          expect(result.reason).toBe("malformed-json");
        }
      });
    }
  });
  describe("HTTP response vectors", () => {
    for (const row of vectors.responses) {
      test(row.name, () => {
        const run = () => decodeResponse(row.contentType, fromHex(row.hex), registryFor(row.ir));
        if ("error" in row.expected) {
          expect(run).toThrow(HyperflyError);
          expect(run).toThrow(expect.objectContaining({ code: row.expected.error }));
        } else if ("kind" in row.expected) {
          const result = run();
          expect(result.kind).toBe(row.expected.kind);
          if (result.kind === "json") expect(comparable(result.value, row.ir)).toEqual(comparable(revive(row.expected.value), row.ir));
        }
      });
    }
  });
  describe("HTTP request vectors", () => {
    for (const row of vectors.requests) {
      test(row.name, async () => {
        const req = request(fromHex(row.hex) as BodyInit, row.contentType, row.contentLength);
        const result = await readBody(req, registryFor(row.ir), { maxBytes: row.maxBytes });
        if ("status" in row.expected) {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.response.status).toBe(row.expected.status);
          if (row.expected.status === 413 && row.hex.length / 2 <= (row.maxBytes ?? 1048576)) expect(req.bodyUsed).toBe(false);
        } else if ("kind" in row.expected) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(comparable(result.value, row.ir)).toEqual(comparable(revive(row.expected.value), row.ir));
        }
      });
    }
  });
}
