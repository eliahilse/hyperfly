import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CodecRegistry, compileIR, type IRNode } from "../src/index.js";
import { decodeResponse, encodeFor, negotiate, readBody, respond } from "../src/http.js";

const url = "https://example.test/value";
const bytes = compileIR({ kind: "bytes" });
const text = compileIR({ kind: "string" });

async function decodeBoth(ir: IRNode, json: string, expected: unknown) {
  const registry = new CodecRegistry([compileIR(ir)]);
  expect(decodeResponse("application/json", json, registry)).toEqual({ kind: "json", value: expected });
  const request = new Request(url, { method: "POST", body: json });
  expect(await readBody(request, registry)).toEqual({ ok: true, value: expected });
}

test("JSON always uses the first codec, independently of the offer and codec header", async () => {
  for (const [codecs, expected] of [[ [bytes, text], new Uint8Array([0]) ], [ [text, bytes], "AA==" ]] as const) {
    const registry = new CodecRegistry(codecs);
    expect(decodeResponse("application/json", '"AA=="', registry)).toEqual({ kind: "json", value: expected });
    expect(await readBody(new Request(url, {
      method: "POST", body: '"AA=="', headers: { "Hyperfly-Codec": codecs[1].fingerprint },
    }), registry)).toEqual({ ok: true, value: expected });
  }
  const registry = new CodecRegistry([bytes, text]);
  for (const options of [{ offer: text.fingerprint }, { offer: "" }, { enabled: false }]) {
    expect(encodeFor(negotiate(null, registry, options), new Uint8Array([0])).body).toBe('"AA=="');
  }
  registry.remove(bytes.fingerprint);
  expect(decodeResponse("application/json", '"AA=="', registry)).toEqual({ kind: "json", value: "AA==" });
  registry.remove(text.fingerprint);
  expect(decodeResponse("application/json", '"AB=="', registry)).toEqual({ kind: "json", value: "AB==" });
});

test.each(["row", "columnar"] as const)("bytes survive JSON fallback after a %s encoder limit", async (plan) => {
  const codec = compileIR({ kind: "array", element: { kind: "bytes" } }, { plan, limits: { maxByteLength: 1 } });
  const registry = new CodecRegistry([codec]);
  const value = [new Uint8Array([0, 1])];
  const errors: string[] = [];
  const response = respond(new Request(url, { headers: { "Hyperfly-Accept": codec.fingerprint } }), value, registry, {
    onFallback: (error, reason) => errors.push(error.code, reason),
  });
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(await response.text()).toBe('["AAE="]');
  expect(errors).toEqual(["limit", "encoder-limit"]);
  await decodeBoth(codec.ir, '["AAE="]', value);
});

test("bytes fallback preserves JSON.stringify behavior elsewhere, including toJSON and repeated references", () => {
  const child: IRNode = { kind: "struct", fields: [{ name: "data", type: { kind: "bytes" } }] };
  const ir: IRNode = { kind: "struct", fields: [
    { name: "child", type: child }, { name: "number", type: { kind: "float64" } },
  ] };
  const shared = { data: new Uint8Array([0]), toJSON() { return { data: this.data, extra: "kept" }; } };
  const value = { child: shared, number: Infinity, omitted: undefined, extra: shared };
  const registry = new CodecRegistry([compileIR(ir)]);
  const encoded = encodeFor(negotiate(null, registry), value);
  expect(JSON.parse(encoded.body as string)).toEqual({
    child: { data: "AA==", extra: "kept" }, number: null, extra: { data: "AA==", extra: "kept" },
  });
  expect(encodeFor(negotiate(null, new CodecRegistry([bytes])), Buffer.from([255])).body).toBe('"/w=="');
});

test("non-bytes schemas validate, drop unknown fields and handle all field flags", async () => {
  const ir: IRNode = { kind: "struct", fields: [
    { name: "required", type: { kind: "int" } },
    { name: "optional", type: { kind: "bool" }, optional: true },
    { name: "nullable", type: { kind: "string" }, nullable: true },
  ] };
  await decodeBoth(ir, '{"required":3e0,"nullable":null,"ignored":{"data":"AB=="}}', { required: 3, nullable: null });
  await decodeBoth({ kind: "array", element: { kind: "bool" }, length: 1 }, "[true]", [true]);
});

test.each([
  [{ kind: "bool" }, "0"],
  [{ kind: "float64" }, "1e400"],
  [{ kind: "string" }, "1"],
  [{ kind: "literal", value: true }, "1"],
  [{ kind: "array", element: { kind: "bool" }, length: 1 }, "[]"],
  [{ kind: "struct", fields: [] }, "[]"],
  [{ kind: "nullable", inner: { kind: "int" } }, '"3"'],
] as [IRNode, string][])("conversion failures in %j are JSON failures in both directions", async (ir, body) => {
  const registry = new CodecRegistry([compileIR(ir)]);
  expect(() => decodeResponse("application/json", body, registry)).toThrow(expect.objectContaining({ code: "json" }));
  const result = await readBody(new Request(url, { method: "POST", body }), registry);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(400);
    expect(result.reason).toBe("malformed-json");
  }
});

test("JSON conversion handles the deepest supported IR", async () => {
  let ir: IRNode = { kind: "bytes" };
  let expected: unknown = new Uint8Array([0]);
  for (let i = 0; i < 510; i++) {
    ir = { kind: "array", element: ir };
    expected = [expected];
  }
  await decodeBoth(ir, `${"[".repeat(510)}"AA=="${"]".repeat(510)}`, expected);
});

test.each(["2", " \t2\t ", `${"0".repeat(5000)}2`, "9".repeat(5000)])("Content-Length rejects %j before acquiring a reader", async (length) => {
  let acquired = false;
  const body = new ReadableStream<Uint8Array>();
  body.getReader = () => { acquired = true; throw new Error("must not read"); };
  const request = {
    headers: { get: (name: string) => name === "content-type" ? "application/json" : length }, body,
  } as unknown as Request;
  const result = await readBody(request, new CodecRegistry(), { maxBytes: 1 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(413);
  expect(acquired).toBe(false);
});

test("JSON decisions encode bytes without a codec or decision identity at every position", () => {
  const registry = new CodecRegistry([text]);
  const decisions = [
    { ...negotiate(null, registry) },
    { kind: "json", headers: { "Content-Type": "application/json" }, reason: "disabled" } as const,
    negotiate(null, new CodecRegistry()),
  ];
  const foreign = runInNewContext("new Uint8Array([255])") as Uint8Array;
  const value = {
    nested: [new Uint8Array([255]), { buffer: Buffer.from([255]), foreign }],
    empty: new Uint8Array(),
    subarray: new Uint8Array([0, 255, 0]).subarray(1, 2),
  };
  for (const decision of decisions) {
    expect(JSON.parse(encodeFor(decision, value).body as string)).toEqual({
      nested: ["/w==", { buffer: "/w==", foreign: "/w==" }], empty: "", subarray: "/w==",
    });
  }
});

test.each([{ kind: "int" }, { kind: "literal", value: 0 }] satisfies IRNode[])("JSON -0 normalizes to 0 under %j", async (ir) => {
  await decodeBoth(ir, "-0", 0);
  const decoded = decodeResponse("application/json", "-0", new CodecRegistry([compileIR(ir)]));
  if (decoded.kind === "json") expect(Object.is(decoded.value, -0)).toBe(false);
  await decodeBoth({ kind: "struct", fields: [{ name: "values", type: { kind: "array", element: ir } }] },
    '{"values":[-0]}', { values: [0] });
});

test("JSON float64 keeps negative zero", async () => {
  await decodeBoth({ kind: "float64" }, "-0", -0);
});

test("JSON validation preserves parsed identities and copies only changed paths", () => {
  const ir: IRNode = { kind: "struct", fields: [
    { name: "rows", type: { kind: "array", element: { kind: "struct", fields: [
      { name: "id", type: { kind: "int" } },
      { name: "data", type: { kind: "bytes" }, optional: true },
    ] } } },
    { name: "unchanged", type: { kind: "struct", fields: [{ name: "active", type: { kind: "bool" } }] } },
  ] };
  const registry = new CodecRegistry([compileIR(ir)]);
  const parse = JSON.parse;
  const parsed = { rows: [{ id: 1 }], unchanged: { active: true } };
  const changed = { rows: [{ id: 1 }, { id: -0, data: "/w==", unknown: true }], unchanged: parsed.unchanged };
  try {
    JSON.parse = () => parsed;
    const same = decodeResponse("application/json", "{}", registry);
    expect(same.kind).toBe("json");
    if (same.kind === "json") expect(same.value).toBe(parsed);
    JSON.parse = () => changed;
    const decoded = decodeResponse("application/json", "{}", registry);
    expect(decoded.kind).toBe("json");
    if (decoded.kind === "json") {
      const result = decoded.value as { rows: { id: number; data?: unknown }[]; unchanged: { active: boolean } };
      expect(result).not.toBe(changed);
      expect(result.rows).not.toBe(changed.rows);
      expect(result.rows[0]).toBe(changed.rows[0]);
      expect(result.rows[1]).not.toBe(changed.rows[1]);
      expect(result.unchanged).toBe(changed.unchanged);
      expect(result.rows[1]).toEqual({ id: 0, data: new Uint8Array([255]) });
    }
    expect(changed.rows[1]).toEqual({ id: -0, data: "/w==", unknown: true });
  } finally {
    JSON.parse = parse;
  }
});

test("JSON conversion failures retain nested paths", () => {
  const registry = new CodecRegistry([compileIR({ kind: "struct", fields: [
    { name: "rows", type: { kind: "array", element: { kind: "struct", fields: [{ name: "data", type: { kind: "bytes" } }] } } },
  ] })]);
  expect(() => decodeResponse("application/json", '{"rows":[{"data":"AB=="}]}', registry))
    .toThrow(expect.objectContaining({ code: "json", message: "$.rows[0].data: expected canonical padded base64" }));
});

test.each([
  new ArrayBuffer(1), new SharedArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Int8Array([1]), new Uint8ClampedArray([1]),
  runInNewContext("new ArrayBuffer(1)") as ArrayBuffer,
  runInNewContext("new DataView(new ArrayBuffer(1))") as DataView,
  runInNewContext("new Uint16Array([1])") as Uint16Array,
])("JSON rejects unsupported byte storage and views with their path: %p", (value) => {
  const decision = negotiate(null, new CodecRegistry());
  expect(() => encodeFor(decision, { rows: [{ data: value }] }))
    .toThrow(expect.objectContaining({ code: "json", message: "$.rows[0].data: unsupported byte storage or view; use Uint8Array" }));
  expect(() => encodeFor(decision, value))
    .toThrow(expect.objectContaining({ code: "json", message: "$: unsupported byte storage or view; use Uint8Array" }));
});

test("JSON rejects shared storage beside bytes on the replacer path", () => {
  expect(() => encodeFor(negotiate(null, new CodecRegistry()), { s: new SharedArrayBuffer(2), b: new Uint8Array([255]) }))
    .toThrow(expect.objectContaining({ code: "json", message: "$.s: unsupported byte storage or view; use Uint8Array" }));
});

test("JSON preflight ignores inherited enumerable getters like JSON.stringify", () => {
  const prototype = Object.defineProperty({}, "ignored", { enumerable: true, get() { throw new Error("must not read"); } });
  const value: unknown = Object.assign(Object.create(prototype) as object, { id: 1 });
  expect(encodeFor(negotiate(null, new CodecRegistry()), value).body).toBe('{"id":1}');
});

test("JSON bytes conversion handles toJSON on byte subclasses and on surrounding values", () => {
  class Bytes extends Uint8Array {
    toJSON() { return "custom"; }
  }
  const value = { bytes: new Bytes([255]), nested: { toJSON: () => ({ data: new Uint8Array([255]) }) }, numeric: { 0: 255 } };
  expect(encodeFor(negotiate(null, new CodecRegistry()), value).body)
    .toBe('{"bytes":"/w==","nested":{"data":"/w=="},"numeric":{"0":255}}');
});
